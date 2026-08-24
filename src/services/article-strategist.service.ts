/**
 * article-strategist.service.ts
 *
 * The per-article "thinking" the system was missing. Before writing, this asks a
 * GPT-5 mini to look at the LIVE SERP, the business's
 * approach profile (how to target THIS business), its real substance, location
 * policy, and GSC standing — and decide: the content type, the true search
 * intent, a SPECIFIC differentiating angle, which rank-modules to require, the
 * outline, and how the research should lean for this business type. This
 * replaces the regex archetype + templated "skyscraper angle".
 *
 * Business-type-agnostic by construction: the model is handed the business model
 * + approach profile and reasons accordingly (local service vs e-commerce vs
 * B2B/SaaS), so the strategy adapts per business with no per-vertical code.
 *
 * Non-fatal: any failure returns null and the caller falls back to the existing
 * archetype service. The parse/derive helpers are pure and unit-tested.
 */

import { createStrategistModel } from "../config/llm.config";
import type {
  ModuleContext,
  ModuleId,
  SearchIntent,
} from "../llm/blogTools/blog-modules";
import { BLOG_MODULES } from "../llm/blogTools/blog-modules";
import type { BusinessModelType } from "../utils/blog-substance.utils";
import type { LocationPolicy } from "../utils/location-policy.utils";
import type { BusinessFacts } from "../utils/business-facts.utils";
import { hasAnyFact } from "../utils/business-facts.utils";

export type ArticleContentType =
  | "complete-guide"
  | "how-to"
  | "listicle"
  | "comparison"
  | "service-page";

export interface ArticleStrategy {
  contentType: ArticleContentType;
  searchIntent: SearchIntent;
  /** The specific differentiator vs the ranking results — the point of view. */
  angle: string;
  /** Modules the writer must include (informs, never under-cuts, the gate). */
  requiredModules: ModuleId[];
  /** H2-level outline. */
  outline: string[];
  /** Optional local-specific angle for location-dependent businesses. */
  localAngle?: string;
  targetWordCount: number;
  /** How research should lean for this business (per-business approach). */
  research?: string;
}

export interface ArticleStrategistInput {
  keyword: string;
  businessModel: BusinessModelType;
  /** Free-text approach profile: who to target + how to research this business. */
  approachProfile?: string;
  /** Condensed SERP picture (top titles, gaps, dominant format, avg words). */
  serpSummary?: string;
  /** Condensed real substance (offerings + competitors). */
  substanceSummary?: string;
  locationPolicy: LocationPolicy;
  /** GSC standing for the target keyword, e.g. "improve (pos 14)". */
  gscBand?: string;
  facts: BusinessFacts;
  hasReviews: boolean;
}

const VALID_TYPES: ArticleContentType[] = [
  "complete-guide",
  "how-to",
  "listicle",
  "comparison",
  "service-page",
];
const VALID_INTENTS: SearchIntent[] = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
];
const VALID_MODULE_IDS = new Set<string>(BLOG_MODULES.map((m) => m.id));

function clampWordCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1300;
  return Math.min(2400, Math.max(700, Math.round(n)));
}

export function buildStrategistBrief(input: ArticleStrategistInput): string {
  return [
    "You are a senior SEO content strategist. Decide how to make ONE article OUTRANK the current results —",
    "by being more useful and more specific, not longer. Think about THIS business and what only it can say.",
    "",
    `Target keyword: ${input.keyword}`,
    `Business model: ${input.businessModel}`,
    `Location policy: tier=${input.locationPolicy.tier}, localSection=${input.locationPolicy.useLocalSection}`,
    input.gscBand ? `GSC standing: ${input.gscBand}` : "",
    "",
    "How to target & research THIS business (approach profile):",
    input.approachProfile || "(none provided — infer from the business model)",
    "",
    "What is currently ranking (SERP):",
    input.serpSummary || "(no SERP data)",
    "",
    "The business's REAL substance (offerings + competitors — never invent beyond this):",
    input.substanceSummary || "(none)",
    "",
    "Real verified facts available (use only these for any numbers):",
    hasAnyFact(input.facts) ? JSON.stringify(input.facts) : "(none)",
    `Real customer reviews available: ${input.hasReviews ? "yes" : "no"}`,
    "",
    "DECIDE — do NOT pile on every section. Choose contentType + requiredModules to MATCH what actually ranks (the SERP's dominant format) and the intent. Fewer, well-chosen sections beat a bloated post:",
    "  • roundup / 'best/top X' SERP → contentType comparison or listicle; include comparison-table + methodology, and build the table from the REAL ranking businesses listed above.",
    "  • how-to / tutorial SERP → contentType how-to; include howto-steps; do NOT add a comparison-table or methodology.",
    "  • simple local-service / transactional query → include at-a-glance + local-tip; skip roundup modules.",
    "  • informational guide → keep it lean; add only the sections the ranking pages actually use.",
    "  Always keep quick-answer, faq, and author-eeat. Backend code owns schema. Only list another module in requiredModules if it genuinely fits THIS article.",
    "",
    "Decide and return ONLY minified JSON (no prose, no code fences):",
    '{"contentType":"complete-guide|how-to|listicle|comparison|service-page",',
    '"searchIntent":"informational|commercial|transactional|navigational",',
    '"angle":"the ONE specific differentiator vs the ranking results, grounded in this business",',
    `"requiredModules":[${[...VALID_MODULE_IDS].map((m) => `"${m}"`).join(",")}] (subset that fits this article),`,
    '"outline":["H2","H2",...6-9 sections],',
    '"localAngle":"local-specific angle or empty",',
    '"targetWordCount": 900-1600 (match SERP depth, never pad),',
    '"research":"one line: how research/positioning should lean for this business"}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Robustly parse the strategist's JSON. Pure. Returns null on unusable output. */
export function parseArticleStrategy(raw: string): ArticleStrategy | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const contentType = VALID_TYPES.includes(parsed.contentType as ArticleContentType)
    ? (parsed.contentType as ArticleContentType)
    : "complete-guide";
  const searchIntent = VALID_INTENTS.includes(parsed.searchIntent as SearchIntent)
    ? (parsed.searchIntent as SearchIntent)
    : "informational";
  const angle = typeof parsed.angle === "string" ? parsed.angle.trim() : "";
  const requiredModules = Array.isArray(parsed.requiredModules)
    ? (parsed.requiredModules.filter(
        (m) => typeof m === "string" && VALID_MODULE_IDS.has(m),
      ) as ModuleId[])
    : [];
  const outline = Array.isArray(parsed.outline)
    ? parsed.outline
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => s.length > 0)
        .slice(0, 12)
    : [];
  const localAngle =
    typeof parsed.localAngle === "string" && parsed.localAngle.trim().length > 0
      ? parsed.localAngle.trim()
      : undefined;
  const research =
    typeof parsed.research === "string" && parsed.research.trim().length > 0
      ? parsed.research.trim()
      : undefined;

  if (!angle && outline.length === 0) return null; // nothing usable

  return {
    contentType,
    searchIntent,
    angle,
    requiredModules,
    outline,
    localAngle,
    targetWordCount: clampWordCount(parsed.targetWordCount),
    research,
  };
}

/**
 * Pure: derive the deterministic ModuleContext (for the gate) from the strategy +
 * business signals. The gate enforces every module that APPLIES — the strategist
 * can add, but cannot drop a baseline module that fits.
 */
export function deriveModuleContext(
  strategy: Pick<ArticleStrategy, "contentType" | "searchIntent" | "requiredModules">,
  signals: {
    businessModel: BusinessModelType;
    locationPolicy: LocationPolicy;
    facts: BusinessFacts;
    hasReviews: boolean;
  },
): ModuleContext {
  return {
    businessModel: signals.businessModel,
    locationTier: signals.locationPolicy.tier,
    useLocalSection: signals.locationPolicy.useLocalSection,
    intent: strategy.searchIntent,
    isComparative:
      strategy.contentType === "comparison" || strategy.contentType === "listicle",
    isHowTo: strategy.contentType === "how-to",
    hasFacts: hasAnyFact(signals.facts),
    hasReviews: signals.hasReviews,
    // The strategist's per-article DECISION drives which modules are required
    // (the gate enforces these, not every applicable module).
    chosenModules: strategy.requiredModules,
  };
}

/** Render the strategy as a prompt brief for the writer. */
export function buildStrategyPromptBlock(strategy: ArticleStrategy): string {
  return [
    "        **ARTICLE STRATEGY (decided from the live SERP + this business — follow it):**",
    `        - Content type: ${strategy.contentType}; search intent: ${strategy.searchIntent}`,
    `        - WINNING ANGLE (lead with this; it is how we out-rank the incumbents): ${strategy.angle}`,
    strategy.localAngle ? `        - Local angle: ${strategy.localAngle}` : "",
    `        - Target length: ~${strategy.targetWordCount} words (match SERP depth; never pad).`,
    strategy.outline.length
      ? `        - Suggested H2 outline: ${strategy.outline.join(" | ")}`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Run the strategist (GPT-5.4-mini by default; BLOG_STRATEGIST_MODEL overrides,
 * provider-routed). Non-fatal: returns null on any failure so the caller falls
 * back to the regex archetype service.
 */
export async function runArticleStrategist(
  input: ArticleStrategistInput,
): Promise<ArticleStrategy | null> {
  try {
    const model = createStrategistModel(0.2);
    const response = await model.invoke([
      { role: "user", content: buildStrategistBrief(input) },
    ]);
    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    return parseArticleStrategy(raw);
  } catch (err) {
    console.error(
      "⚠️ Article strategist failed non-fatally (falling back to archetype):",
      (err as Error).message,
    );
    return null;
  }
}
