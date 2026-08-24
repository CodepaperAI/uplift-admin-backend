/**
 * offpage-engine.ts
 *
 * The routing layer. Given a business profile and a set of levers, it runs the
 * applicable levers and merges their opportunities into one ranked queue. Pure
 * (no I/O) — levers are pure too in v1, so the whole engine is unit-testable.
 *
 * Adding a new lever (reviews, citations, ...) means registering it here; the
 * engine never changes.
 */

import type {
  BusinessOffPageProfile,
  BusinessResearchBrief,
  Lever,
  Opportunity,
  OffPageResearchStrategy,
} from "./offpage-types";

/** Stable, deterministic opportunity key from lever + a seed (name/keyword). */
export function makeOpportunityKey(leverKey: string, seed: string): string {
  const slug = String(seed ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${leverKey}:${slug}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Shared priority formula so opportunities from different levers rank
 * consistently in one queue: 100 * relevance(0-1) * (authority(0-100)/100).
 */
export function computePriority(relevance: number, authority: number): number {
  const r = clamp01(relevance);
  const a = Math.max(0, Math.min(100, Number.isFinite(authority) ? authority : 0));
  return Math.round(100 * r * (a / 100));
}

export interface OffPageQueueResult {
  opportunities: Opportunity[];
  appliedLevers: string[];
  /** Set when the queue is empty, explaining why (for the honest empty state). */
  emptyReason?: "no_applicable_levers" | "no_opportunities";
}

/**
 * Run every applicable lever, merge + rank opportunities (highest priority
 * first; stable on ties). Returns an explicit empty reason when nothing applies
 * or nothing is found, so the UI shows an honest empty state, never a blank.
 */
export function runOffPageEngine(
  profile: BusinessOffPageProfile,
  levers: Lever[],
): OffPageQueueResult {
  const applicable = levers.filter((l) => {
    try {
      return l.appliesTo(profile);
    } catch {
      return false;
    }
  });

  if (applicable.length === 0) {
    return { opportunities: [], appliedLevers: [], emptyReason: "no_applicable_levers" };
  }

  const opportunities: Opportunity[] = [];
  for (const lever of applicable) {
    try {
      opportunities.push(...lever.findOpportunities(profile));
    } catch {
      // A broken lever must not take down the whole queue.
    }
  }

  return finalizeQueue(opportunities, applicable.map((l) => l.key));
}

/** Stable sort by priority desc, default missing source to "baseline", build result. */
function finalizeQueue(
  opportunities: Opportunity[],
  appliedLevers: string[],
): OffPageQueueResult {
  const ranked = opportunities
    .map((o, i) => ({ o: o.source ? o : { ...o, source: "baseline" as const }, i }))
    .sort((a, b) => b.o.priority - a.o.priority || a.i - b.i)
    .map((x) => x.o);

  return {
    opportunities: ranked,
    appliedLevers,
    emptyReason: ranked.length === 0 ? "no_opportunities" : undefined,
  };
}

function strategyAllowsLever(
  lever: Lever,
  strategy?: OffPageResearchStrategy,
): boolean {
  if (!strategy) return true;
  if (lever.key === "reddit") return strategy.reddit.enabled;
  if (lever.key === "directory") return strategy.directory.enabled;
  return true;
}

/**
 * Async variant: for each applicable lever, prefer LLM-researched, business-
 * specific opportunities (lever.researchOpportunities) and fall back to the
 * deterministic baseline (findOpportunities) on error or empty — per lever, so
 * one lever's LLM failure never blanks the others. The whole queue is never
 * empty when a baseline exists. Levers run concurrently.
 */
export async function runOffPageEngineAsync(
  profile: BusinessOffPageProfile,
  levers: Lever[],
  brief: BusinessResearchBrief,
  strategy?: OffPageResearchStrategy,
): Promise<OffPageQueueResult> {
  const applicable = levers.filter((l) => {
    try {
      return strategyAllowsLever(l, strategy) && l.appliesTo(profile);
    } catch {
      return false;
    }
  });

  if (applicable.length === 0) {
    return { opportunities: [], appliedLevers: [], emptyReason: "no_applicable_levers" };
  }

  const perLever = await Promise.all(
    applicable.map(async (lever): Promise<Opportunity[]> => {
      if (typeof lever.researchOpportunities === "function") {
        try {
          const researched = await lever.researchOpportunities(
            profile,
            brief,
            strategy,
          );
          if (Array.isArray(researched) && researched.length > 0) return researched;
        } catch {
          // fall through to deterministic baseline
        }
      }
      try {
        return lever.findOpportunities(profile);
      } catch {
        return [];
      }
    }),
  );

  return finalizeQueue(perLever.flat(), applicable.map((l) => l.key));
}
