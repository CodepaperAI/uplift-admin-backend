/**
 * blog-module-gate.utils.ts
 *
 * Deterministic enforcement of the rank-module library (`blog-modules.ts`).
 * After a draft is produced, this checks that every module APPLICABLE to the
 * article actually rendered in the HTML (by its `requiredMarkers`). Anything
 * missing is handed back to the model as a precise rewrite instruction.
 *
 * This is the "enforce, don't hope" backstop: the prompt asks for these modules,
 * but an LLM drops them probabilistically. A regex check never does. Same pattern
 * and spirit as `blog-phrase-gate.utils.ts`.
 *
 * Markers are matched against the RAW HTML (not stripped) because the things we
 * verify — CSS classes and JSON-LD `@type`s — live in markup/script, not prose.
 *
 * Total and defensive: malformed input yields "nothing missing" rather than
 * throwing, so the gate can never crash publishing. Pure, unit-testable.
 */

import type { BlogModule, ModuleContext } from "../llm/blogTools/blog-modules";
import { selectModules } from "../llm/blogTools/blog-modules";

export interface MissingModule {
  id: string;
  label: string;
}

/** Does the HTML satisfy a single module's marker requirement? */
function modulePresent(html: string, module: BlogModule): boolean {
  const markers = module.requiredMarkers;
  if (!markers || markers.length === 0) return true;
  const requireAll = module.requireAll !== false; // default: all markers required
  const test = (re: RegExp) => new RegExp(re.source, re.flags.replace("g", "")).test(html);
  return requireAll ? markers.every(test) : markers.some(test);
}

/**
 * Given the draft HTML and the article's module context, return the applicable
 * modules that did NOT render. Empty array == all required modules present.
 */
export function findMissingModules(
  content: unknown,
  ctx: ModuleContext | null | undefined,
): MissingModule[] {
  if (!ctx) return [];
  const html = typeof content === "string" ? content : "";
  if (!html) return [];

  const missing: MissingModule[] = [];
  for (const module of selectModules(ctx)) {
    if (!modulePresent(html, module)) {
      missing.push({ id: module.id, label: module.label });
    }
  }
  return missing;
}

/**
 * Rewrite instruction listing the missing modules with their exact specs, for
 * the critique loop to hand back to the model when the module gate trips.
 */
export function buildMissingModuleRevisionMessage(
  missing: MissingModule[],
  ctx: ModuleContext | null | undefined,
): string {
  const byId = new Map(selectModules(ctx ?? undefinedCtx()).map((m) => [m.id, m]));
  const lines = [
    "DRAFT REJECTED BY THE MODULE GATE. The draft was NOT saved.",
    "These REQUIRED ranking modules are missing. Keep the ENTIRE existing article",
    "unchanged and ONLY ADD each missing module below exactly as specified (ground every",
    "value in real data; omit any value you don't have rather than inventing it), then call",
    "save-blog-info again with the same article plus the added modules:",
  ];
  for (const m of missing) {
    const spec = byId.get(m.id as BlogModule["id"]);
    lines.push(`  • ${m.label}`);
    if (spec) {
      for (const l of spec.promptSpec().split("\n")) lines.push(`      ${l}`);
    }
  }
  return lines.join("\n");
}

/** A neutral context so buildMissingModuleRevisionMessage is total if ctx is null. */
function undefinedCtx(): ModuleContext {
  return {
    businessModel: "service",
    locationTier: "none",
    useLocalSection: false,
    intent: "informational",
    isComparative: false,
    isHowTo: false,
    hasFacts: false,
    hasReviews: false,
  };
}
