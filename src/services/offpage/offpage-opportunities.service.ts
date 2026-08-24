/**
 * offpage-opportunities.service.ts
 *
 * READ-ONLY entry point: assemble a business's off-page profile from the DB and
 * run the engine to produce the ranked opportunity queue. Only prisma.findUnique
 * — no writes. Status persistence (marking opportunities done) is a follow-up
 * that needs the additive `OffPageOpportunity` table + migration.
 */

import { prisma } from "../../config/db.config";
import { detectBusinessModelType } from "../../utils/blog-substance.utils";
import {
  runOffPageEngine,
  runOffPageEngineAsync,
  type OffPageQueueResult,
} from "./offpage-engine";
import type {
  BusinessOffPageProfile,
  GeographicScope,
  Lever,
  OffPageQualitySummary,
  Opportunity,
} from "./offpage-types";
import { buildBusinessResearchBrief } from "./offpage-research.service";
import {
  computeInputHash,
  readResearchCacheRow,
  writeResearchCache,
} from "./offpage-cache.service";
import { enrichOpportunities } from "./offpage-enrich.service";
import { summarizeOffPageQuality } from "./offpage-analytics.service";
import { shouldShowOpportunity } from "./offpage-quality.service";
import { validateOpportunitiesLLM } from "../../llm/offpage/offpage-validator.llm";
import { generateOffPageResearchStrategy } from "../../llm/offpage/research-strategy.llm";
import { directoryLever } from "./levers/directory-lever";
import { redditLever } from "./levers/reddit-lever";
import { pickBusinessCity } from "./offpage-location";
import {
  applyDismissalFeedback,
  getDismissedOpportunityFeedback,
} from "./offpage-status.service";

/** Registered levers. Add new ones here; the engine never changes. */
export const OFFPAGE_LEVERS: Lever[] = [directoryLever, redditLever];

/**
 * Build the off-page profile from a business record. Pure (no I/O) so it's
 * testable. Derives reach cheaply (no LLM call) — businessModel from the
 * existing string heuristic, location-dependence + scope from serviceArea/city.
 */
export function buildOffPageProfile(business: {
  id?: string;
  businessName?: string | null;
  businessType?: string | null;
  serviceArea?: string | null;
  businessCity?: string | null;
  businessCountry?: string | null;
  GeoProfile?: { locality?: string | null } | null;
  keywords?: Array<{ keyword?: string | null }> | null;
  [k: string]: unknown;
}): BusinessOffPageProfile {
  const businessModelType = detectBusinessModelType(business);
  const serviceArea = (business.serviceArea ?? null) as string | null;
  const sa = (serviceArea ?? "").toLowerCase();
  const city = pickBusinessCity(business.businessCity, business.GeoProfile?.locality);

  let scope: GeographicScope = "unknown";
  if (sa === "local" || sa === "regional" || sa === "national" || sa === "international") {
    scope = sa as GeographicScope;
  }

  let isLocationDependent: boolean;
  if (businessModelType === "product") {
    isLocationDependent = false;
  } else if (scope === "local" || scope === "regional") {
    isLocationDependent = true;
  } else if (scope === "national" || scope === "international") {
    isLocationDependent = false;
  } else {
    // Unknown scope: infer from whether a city is set (service biz with a city ≈ local).
    isLocationDependent = Boolean(city);
  }
  if (scope === "unknown") scope = isLocationDependent ? "local" : "national";

  const keywords = Array.isArray(business.keywords)
    ? business.keywords
        .map((k) => (typeof k?.keyword === "string" ? k.keyword.trim() : ""))
        .filter((k): k is string => k.length > 0)
    : [];

  return {
    businessId: business.id ?? "",
    businessName: business.businessName ?? "",
    businessModelType,
    isLocationDependent,
    scope,
    serviceArea,
    country: business.businessCountry ?? null,
    city,
    category: business.businessType ?? null,
    keywords,
  };
}

export interface OffPageOpportunitiesResult extends OffPageQueueResult {
  profile: BusinessOffPageProfile | null;
  /** True when a background generation is in progress; the client should poll. */
  generating?: boolean;
  /** ISO timestamp of the cached result, so the client can detect a fresh regen. */
  generatedAt?: string | null;
  /** Quality analytics for the most recent cached generation. */
  qualitySummary?: OffPageQualitySummary | null;
}

export function finalizeOffPageGenerationCandidates(
  enrichedCandidates: Opportunity[],
  rejectedOpportunities: Array<{ reason?: string | null }>,
): {
  opportunities: Opportunity[];
  qualitySummary: OffPageQualitySummary;
} {
  const opportunities = enrichedCandidates.filter(shouldShowOpportunity);
  return {
    opportunities,
    qualitySummary: summarizeOffPageQuality(
      enrichedCandidates,
      opportunities,
      rejectedOpportunities,
    ),
  };
}

/** Inngest event that runs the heavy generation in the background. */
export const OFFPAGE_GENERATE_EVENT = "off-page/generate";

/**
 * The heavy off-page pipeline (research → validate → live-enrich → cache). Runs
 * inside the Inngest background job so the HTTP request / page never blocks.
 * Logs each stage so progress is visible in the backend/Inngest logs. Every
 * stage fails soft; always writes the cache at the end (so the page's poll
 * terminates even on a degraded run).
 */
export async function runOffPageGeneration(
  userId: string,
  businessId: string,
): Promise<void> {
  const startedAt = Date.now();
  const business = await prisma.business.findUnique({
    where: { id: businessId, userId },
    include: {
      keywords: true,
      competitiors: true,
      websiteAnalysis: {
        include: {
          businessInfo: true,
          coreServices: true,
          recognition: true,
          brandIdentity: true,
        },
      },
      GeoProfile: true,
      CompetitorIntelligences: true,
      // Content plan: what the business is deliberately building content around.
      // Deterministic order (by id) so the brief/inputHash is stable across the
      // heavy + lightweight loads (a mismatch would cause a regen loop).
      Plan: {
        where: { deletedAt: null },
        select: { keyword: true, keywordIntent: true },
        orderBy: { id: "asc" },
        take: 60,
      },
      Blog: {
        select: { title: true },
        orderBy: { id: "asc" },
        take: 40,
      },
    },
  });
  if (!business) {
    console.warn(`[off-page] generation skipped — business ${businessId} not found`);
    return;
  }
  const profile = buildOffPageProfile(business);
  const brief = buildBusinessResearchBrief(business, profile);
  const inputHash = computeInputHash(brief);
  console.log(`[off-page] ${businessId}: generation started`);

  const strategy = await generateOffPageResearchStrategy(brief, profile);
  console.log(
    `[off-page] ${businessId}: strategy → ${strategy.archetype}; reddit=${strategy.reddit.enabled}; directory=${strategy.directory.enabled}`,
  );

  // Research: the dedicated Reddit + directory researchers (the strategist /
  // "Other plays" layer is intentionally off for now).
  let researched: OffPageQueueResult;
  try {
    researched = await runOffPageEngineAsync(
      profile,
      OFFPAGE_LEVERS,
      brief,
      strategy,
    );
  } catch (err) {
    console.warn(
      "⚠️ Off-page research failed; using deterministic baseline:",
      (err as Error).message,
    );
    researched = runOffPageEngine(profile, OFFPAGE_LEVERS);
  }
  console.log(
    `[off-page] ${businessId}: research → ${researched.opportunities.length} opportunities`,
  );

  // Validate (skeptic agent) before spending live calls.
  let kept = researched.opportunities;
  const rejectedOpportunities: Array<{
    key: string;
    leverKey: string;
    title: string;
    reason: string;
    score: number;
  }> = [];
  try {
    const dismissalFeedback = await getDismissedOpportunityFeedback(businessId);
    const dismissalFiltered = applyDismissalFeedback(
      kept,
      dismissalFeedback,
    );
    kept = dismissalFiltered.opportunities;
    rejectedOpportunities.push(
      ...dismissalFiltered.rejectedOpportunities,
    );
  } catch (err) {
    console.warn(
      "⚠️ Off-page dismissal feedback read failed:",
      (err as Error).message,
    );
  }
  try {
    const verdicts = await validateOpportunitiesLLM(brief, kept);
    if (verdicts.size > 0) {
      kept = kept
        .map((o) => {
          const verdict = verdicts.get(o.key);
          if (!verdict) return o;
          if (verdict.keep === false) {
            rejectedOpportunities.push({
              key: o.key,
              leverKey: o.leverKey,
              title: o.title,
              reason: verdict.reason,
              score: verdict.score,
            });
          }
          return {
            ...o,
            validatorScore: verdict.score,
            validatorReason: verdict.reason,
          };
        })
        .filter((o) => verdicts.get(o.key)?.keep !== false);
    } else if (kept.length > 0) {
      kept = kept.map((o) => ({
        ...o,
        qualityWarnings: [
          ...(o.qualityWarnings ?? []),
          "Strict reviewer unavailable",
        ],
      }));
    }
  } catch (err) {
    console.warn("⚠️ Off-page validation failed:", (err as Error).message);
    kept = kept.map((o) => ({
      ...o,
      qualityWarnings: [
        ...(o.qualityWarnings ?? []),
        "Strict reviewer unavailable",
      ],
    }));
  }
  console.log(
    `[off-page] ${businessId}: validated → kept ${kept.length}/${researched.opportunities.length}`,
  );

  // Live-enrich survivors (real Reddit threads + replies, directory checks).
  let enrichedCandidates = kept;
  try {
    enrichedCandidates = await enrichOpportunities(kept, brief, strategy);
  } catch (err) {
    console.warn("⚠️ Off-page enrichment failed:", (err as Error).message);
  }
  const { opportunities: shownOpportunities, qualitySummary } =
    finalizeOffPageGenerationCandidates(
      enrichedCandidates,
      rejectedOpportunities,
    );

  await writeResearchCache(businessId, inputHash, {
    opportunities: shownOpportunities,
    appliedLevers: researched.appliedLevers,
    generatedAt: new Date().toISOString(),
    strategy,
    qualitySummary,
    rejectedOpportunities,
  });
  console.log(
    `[off-page] ${businessId}: done — ${shownOpportunities.length}/${enrichedCandidates.length} opportunities cached; hiddenLow=${qualitySummary.hiddenLowConfidence}; rejected=${qualitySummary.rejected}; avgConfidence=${qualitySummary.averageConfidence ?? "n/a"} in ${Date.now() - startedAt}ms`,
  );
}

/**
 * Lightweight read used by the HTTP GET. Never runs the heavy pipeline inline:
 * serves fresh cache, otherwise enqueues a background Inngest generation (the
 * job's singleton dedupes concurrent runs) and reports `generating` so the page
 * can poll. Returns any stale cached results to show meanwhile.
 */
export async function getOffPageOpportunities(
  userId: string,
  businessId: string,
  options?: { refresh?: boolean },
): Promise<OffPageOpportunitiesResult> {
  const business = await prisma.business.findUnique({
    where: { id: businessId, userId },
    include: {
      keywords: true,
      competitiors: true,
      websiteAnalysis: {
        include: {
          businessInfo: true,
          coreServices: true,
          recognition: true,
          brandIdentity: true,
        },
      },
      GeoProfile: true,
      CompetitorIntelligences: true,
      // Content plan: what the business is deliberately building content around.
      // Deterministic order (by id) so the brief/inputHash is stable across the
      // heavy + lightweight loads (a mismatch would cause a regen loop).
      Plan: {
        where: { deletedAt: null },
        select: { keyword: true, keywordIntent: true },
        orderBy: { id: "asc" },
        take: 60,
      },
      Blog: {
        select: { title: true },
        orderBy: { id: "asc" },
        take: 40,
      },
    },
  });
  if (!business) {
    return {
      profile: null,
      opportunities: [],
      appliedLevers: [],
      emptyReason: "no_applicable_levers",
    };
  }
  const profile = buildOffPageProfile(business);
  const brief = buildBusinessResearchBrief(business, profile);
  const inputHash = computeInputHash(brief);

  // Serve fresh cache; otherwise enqueue a background generation (the Inngest
  // job's singleton dedupes concurrent runs) and report `generating` so the page
  // polls instead of blocking. Stale cached results are shown meanwhile.
  const row = await readResearchCacheRow(businessId);
  const fresh =
    row !== null &&
    row.inputHash === inputHash &&
    row.expiresAt.getTime() > Date.now();

  if (fresh && !options?.refresh) {
    return {
      profile,
      opportunities: row.payload.opportunities,
      appliedLevers: row.payload.appliedLevers,
      emptyReason: row.payload.opportunities.length
        ? undefined
        : "no_opportunities",
      generating: false,
      generatedAt: row.payload.generatedAt ?? null,
      qualitySummary: row.payload.qualitySummary ?? null,
    };
  }

  try {
    const { inngest } = await import("../../inngest/client");
    await inngest.send({
      name: OFFPAGE_GENERATE_EVENT,
      data: { userId, businessId },
    });
  } catch (err) {
    console.warn(
      "⚠️ Failed to enqueue off-page generation:",
      (err as Error).message,
    );
  }

  return {
    profile,
    opportunities: row?.payload.opportunities ?? [],
    appliedLevers: row?.payload.appliedLevers ?? [],
    emptyReason: undefined,
    generating: true,
    generatedAt: row?.payload.generatedAt ?? null,
    qualitySummary: row?.payload.qualitySummary ?? null,
  };
}
