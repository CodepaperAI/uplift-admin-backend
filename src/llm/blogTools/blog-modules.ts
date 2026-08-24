/**
 * blog-modules.ts
 *
 * The rank-module library — the single source of truth for the proven,
 * ranking-helping content blocks a blog can contain (Quick Answer, At-a-Glance
 * table, Local Tip, FAQ, comparison table, How-To steps, Reviews, Author E-E-A-T,
 * structured-data-ready semantic HTML). It is BUSINESS-TYPE-AGNOSTIC: which modules apply to a given article
 * is decided purely by `appliesTo(ctx)` from the business model, location policy,
 * search intent, and which real data exists — never by a hardcoded vertical. So
 * onboarding any new business type yields the right module set with no new code.
 *
 * Two consumers read this one definition so they can't drift apart:
 *   - the GENERATOR prompt: `buildModulePlanPromptBlock(modules)` injects the
 *     exact HTML/markup + grounding instruction for each applicable module.
 *   - the deterministic GATE (`blog-module-gate.utils.ts`): `requiredMarkers`
 *     verify each applicable module actually rendered before the draft is saved.
 *
 * Grounding rule (enforced by the prompt text here): every module is filled ONLY
 * from the business's real data; if the data for a row/quote isn't present, that
 * piece is omitted — never fabricated.
 *
 * Pure + dependency-light: no I/O, fully unit-testable.
 */

import type { BusinessModelType } from "../../utils/blog-substance.utils";
import type { LocationTier } from "../../utils/location-policy.utils";

export type SearchIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";

export type ModuleId =
  | "quick-answer"
  | "toc"
  | "at-a-glance"
  | "key-takeaways"
  | "methodology"
  | "local-tip"
  | "comparison-table"
  | "howto-steps"
  | "faq"
  | "reviews"
  | "author-eeat"
  | "schema";

/** Everything the applicability rules need — derived per article, per business. */
export interface ModuleContext {
  businessModel: BusinessModelType; // service | product | mixed
  locationTier: LocationTier; // none | country | region | city
  /** From LocationPolicy: true only for genuinely location-dependent articles. */
  useLocalSection: boolean;
  intent: SearchIntent;
  /** Topic is comparative ("best/vs/compare/alternatives") per strategist/intent. */
  isComparative: boolean;
  /** Topic is a how-to / tutorial per strategist/intent. */
  isHowTo: boolean;
  /** Any real scraped/structured facts available (price-from, capacity, founded…). */
  hasFacts: boolean;
  /** Real GMB reviews / rating available to quote. */
  hasReviews: boolean;
  /**
   * The STRATEGIST'S DECISION: which modules genuinely fit this article (from the
   * live SERP's dominant format + intent). When present, the gate enforces only
   * these (plus the always-on baseline below) — so the system DECIDES per article
   * instead of piling every applicable module onto every post. Undefined → no
   * decision available → fall back to "all applicable" (safe default).
   */
  chosenModules?: ModuleId[];
}

/**
 * The non-negotiable AEO/SEO floor every post needs regardless of the strategist's
 * choice: an answer-first box and a semantic FAQ. Structured data is generated
 * deterministically by the rendering/publishing layer from verified fields.
 * Everything else is the strategist's decision.
 */
export const BASELINE_MODULE_IDS = new Set<ModuleId>([
  "quick-answer",
  "faq",
  "author-eeat",
]);

export interface BlogModule {
  id: ModuleId;
  label: string;
  /** True when this module both fits the article AND can be truthfully grounded. */
  appliesTo(ctx: ModuleContext): boolean;
  /** Instruction (exact markup + grounding) injected into the prompt when applied. */
  promptSpec(): string;
  /** Regex(es) the gate matches against the raw HTML to confirm the module rendered. */
  requiredMarkers: RegExp[];
  /** When true the gate requires ALL markers; otherwise ANY one suffices. Default: all. */
  requireAll?: boolean;
}

/**
 * The library. `appliesTo` is the deterministic floor: if a module applies to
 * this business + intent + available data, the gate will REQUIRE it. The
 * strategist informs the context (intent, isComparative, isHowTo) so the right
 * set is selected — it does not get to silently drop a baseline module.
 */
export const BLOG_MODULES: BlogModule[] = [
  {
    id: "quick-answer",
    label: "Quick Answer box (answer-first, Speakable target)",
    appliesTo: () => true,
    promptSpec: () =>
      [
        "QUICK ANSWER BOX (mandatory, very top of the article, before the first H2):",
        '  <div class="quick-answer"><strong>Quick answer:</strong> …a 40–60 word, complete, direct answer to the exact query…</div>',
        "  This is what Google's featured snippet and AI Overviews extract. Lead with one useful recommendation, no preamble. Mention no more than three options and only options present in the locked evidence-backed outline; never turn it into a service inventory.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']quick-answer["']/i],
  },
  {
    id: "at-a-glance",
    label: "At-a-Glance facts table",
    // Product businesses (real catalog prices) OR any business with at least one
    // groundable fact source: scraped facts, a real location, or reviews/rating.
    appliesTo: (c) =>
      c.businessModel === "product" ||
      c.businessModel === "mixed" ||
      c.hasFacts ||
      c.hasReviews ||
      c.locationTier === "city" ||
      c.locationTier === "region",
    promptSpec: () =>
      [
        'AT-A-GLANCE TABLE (HTML <table class="at-a-glance">) near the top — tables are an under-used ranking win in 2026:',
        "  One row per REAL fact only — include exactly the rows you have real data for and OMIT the rest (never invent a value):",
        "  e.g. Price from · Group size / capacity · Lead time · Service area · Hours · Rating · Dietary/options · Key services.",
        "  Use scraped business facts, the real product catalog, verified location, and GMB data. If you have no real facts at all, omit this table entirely.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']at-a-glance["']/i],
  },
  {
    id: "toc",
    label: "Table of Contents (jump links)",
    appliesTo: () => true,
    promptSpec: () =>
      [
        'TABLE OF CONTENTS (mandatory, immediately after the opening/overview): <nav class="toc"> with a bulleted list of in-page anchor links (<a href="#section-slug">) to the main H2 sections, and give EACH of those H2s a matching id attribute.',
        "  Lets a busy reader jump straight to pricing / how to book / delivery instead of bouncing. Label links by what the reader wants (e.g. \"Pricing\", \"How to book\"), not by clever headings.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']toc["']/i],
  },
  {
    id: "key-takeaways",
    label: "Key Takeaways box",
    appliesTo: () => true,
    promptSpec: () =>
      [
        'KEY TAKEAWAYS (mandatory, near the end): <div class="key-takeaways"><h2>Key Takeaways</h2><ul>…3–5 specific, skimmable bullets…</ul></div>',
        "  Each bullet a concrete takeaway grounded in the article — not a generic platitude.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']key-takeaways["']/i],
  },
  {
    id: "local-tip",
    label: "Local Tip block (location-dependent only)",
    appliesTo: (c) => c.useLocalSection && c.locationTier === "city",
    promptSpec: () =>
      [
        'LOCAL TIP (mandatory for this LOCAL business): <div class="local-tip"><h3>…local-specific heading…</h3>…a grounded local consideration…</div>',
        "  Use ONLY local specifics from verified-location data (neighbourhood, listed landmarks, service-area cities, verified hours). Never imply first-hand experience or operational speed unless explicitly provided.",
        "  Frame location as useful context for the reader without promising speed, delivery condition, availability, or service coverage beyond the verified packet.",
        "  ANCHOR ON WHAT PEOPLE ACTUALLY SEARCH: verified CITY, NEIGHBOURHOOD, and SERVICE-AREA names. Never put a street number, postal code, or coordinates in prose; backend rendering owns location metadata.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']local-tip["']/i],
  },
  {
    id: "comparison-table",
    label: "Comparison / roundup table",
    appliesTo: (c) => c.isComparative,
    promptSpec: () =>
      [
        'COMPARISON / ROUNDUP TABLE (mandatory for this explicitly comparative topic): an HTML <table class="comparison-table">.',
        "  Include a named competitor row ONLY when that competitor and the row's attributes are present in supplied business/SERP evidence. A ranking result proves the page/business exists; it does NOT prove services, prices, scale, speed, or who it is best for.",
        "  If verified competitor attributes are unavailable, compare decision criteria or service categories instead of inventing company details. Never infer a 'best for', price, response time, geographic reach, or capability.",
        "  Justify any recommendation using only the verified packet and clearly state what readers should confirm directly with each provider.",
      ].join("\n"),
    requiredMarkers: [
      /<table\b[^>]*class\s*=\s*["'][^"']*\bcomparison-table\b[^"']*["']/i,
    ],
  },
  {
    id: "methodology",
    label: "Methodology / how we evaluated (E-E-A-T)",
    // Roundup/comparison content only — a trust signal for 'best X' posts.
    appliesTo: (c) => c.isComparative,
    promptSpec: () =>
      [
        'METHODOLOGY (mandatory for a roundup/comparison — an E-E-A-T trust signal): a short <section class="methodology"> covering Scope (what + when), Evaluation criteria, Approach (how it was assessed), and Limitations (what changes / to verify).',
        "  Be honest about how the assessment was made; do NOT claim tests, visits, or data you cannot stand behind.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']methodology["']/i],
  },
  {
    id: "howto-steps",
    label: "How-To numbered steps",
    appliesTo: (c) => c.isHowTo,
    promptSpec: () =>
      [
        'HOW-TO STEPS (mandatory for this how-to topic): an ordered list <ol class="howto-steps"> of 5–8 concise, action-first steps. Use clear step headings so backend rendering can derive HowTo structured data safely.',
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']howto-steps["']/i],
  },
  {
    id: "faq",
    label: "FAQ (≥3) with semantic answer markup",
    appliesTo: () => true,
    promptSpec: () =>
      [
        "FAQ (mandatory, ≥3 Q&As): each answer in <p class=\"faq-answer\" style=\"…\"> so backend rendering can derive FAQPage structured data from visible, verified content.",
        "  Use decision-friction questions that the body has not already answered. Each answer must add a new selection rule or limitation, not restate a service description. Answers ≤120 words, specific, non-generic, and limited to claims assigned to the FAQ outline section.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']faq-answer["']/i],
  },
  {
    id: "reviews",
    label: "Reviews / rating callout (when real reviews exist)",
    appliesTo: (c) => c.hasReviews,
    promptSpec: () =>
      [
        'SOCIAL PROOF (mandatory — real reviews are available): <div class="reviews">…</div> quoting 1–2 REAL customer reviews and/or the real average rating provided. Quote them accurately; never invent a review, name, or rating.',
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']reviews["']/i],
  },
  {
    id: "author-eeat",
    label: "Author E-E-A-T byline + bio",
    appliesTo: () => true,
    promptSpec: () =>
      [
        'AUTHOR E-E-A-T (mandatory): a visible byline near the top linked to the real author/business URL, and an <div class="author-bio">…</div> near the end with the real author name, job title, and expertise/experience provided.',
        "  Use ONLY real author data. Do NOT invent credentials, years of experience, or a founding year that isn't in the provided data.",
      ].join("\n"),
    requiredMarkers: [/class\s*=\s*["']author-bio["']/i],
  },
  {
    id: "schema",
    label: "Backend-owned structured data",
    appliesTo: () => false,
    promptSpec: () =>
      [
        "STRUCTURED DATA: do not emit JSON-LD. Backend rendering owns all schema and uses verified database fields.",
      ].join("\n"),
    requiredMarkers: [],
  },
];

/**
 * The required module set for this article — what the prompt instructs AND the
 * gate enforces (single source of truth, so they can't drift).
 *
 * Decision model:
 *  - `appliesTo(ctx)` is the applicability FILTER (never require a local-tip for a
 *    national business, or a methodology for a non-comparison) — a safety rail.
 *  - If the strategist made a decision (`ctx.chosenModules`), the required set is
 *    the BASELINE plus whatever the strategist chose, intersected with applicable.
 *    → the system DECIDES what fits instead of piling on every module.
 *  - If there's no decision (strategist off/failed), fall back to all-applicable.
 */
export function selectModules(ctx: ModuleContext): BlogModule[] {
  const applicable = BLOG_MODULES.filter((m) => m.appliesTo(ctx));
  const chosen = ctx.chosenModules;
  if (!chosen || chosen.length === 0) return applicable; // no decision → safe default
  const chosenSet = new Set(chosen);
  return applicable.filter(
    (m) => BASELINE_MODULE_IDS.has(m.id) || chosenSet.has(m.id),
  );
}

/** The prompt block instructing the writer to emit each applicable module. */
export function buildModulePlanPromptBlock(modules: BlogModule[]): string {
  if (modules.length === 0) return "";
  return [
    "        **REQUIRED CONTENT MODULES (emit every one — a deterministic gate rejects the draft if any is missing).**",
    "        Ground each ONLY in this business's real data; omit any piece you have no real data for rather than inventing it.",
    "",
    ...modules.map((m) =>
      m
        .promptSpec()
        .split("\n")
        .map((l) => `        ${l}`)
        .join("\n"),
    ),
  ].join("\n");
}
