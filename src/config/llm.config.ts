import { ChatOpenAI } from "@langchain/openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY not found in environment variables");
}

export const LLM_MODELS = {
  GPT4O: "gpt-4o",
  GPT4O_MINI: "gpt-4o-mini",
  GPT5: "gpt-5",
  GPT5_MINI: "gpt-5-mini",
  GPT56_LUNA: "gpt-5.6-luna",
  GPT54_MINI: "gpt-5.4-mini",
  GPT54_NANO: "gpt-5.4-nano",
} as const;

export const SEO_AUDIT_MODEL_NAME = LLM_MODELS.GPT56_LUNA;

/** Default pass bar (0-10) for the expert-voice judge. Defined here so the
 * config has no dependency on the judge service (which imports from here). */
export const EXPERT_VOICE_BAR_DEFAULT = 7;

/**
 * Model used by the expert-voice blog judge. Luna keeps the judge aligned with
 * the production article writer while remaining cost optimized.
 */
export function createBlogJudgeModel(_temperature: number = 0) {
  return createGPT56LunaModel();
}

/**
 * Model used by the per-article strategist (content type, angle, rank modules,
 * outline). It shares Luna with the production article pipeline.
 */
export function createStrategistModel(_temperature: number = 0.2) {
  return createGPT56LunaModel();
}

export function createGPT4oModel(temperature: number = 0.2) {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT4O,
    temperature,
  });
}

export function createGPT4oMiniModel(temperature: number = 0.7) {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT4O_MINI,
    temperature,
  });
}

export function createGPT54MiniModel() {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT54_MINI,
  });
}

export function createGPT5Model(_temperature?: number) {
  // GPT-5 currently rejects non-default temperature values. We keep the
  // call signature stable for existing callers, but let the API use its
  // default behavior and rely on prompt/tool constraints for determinism.
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT5,
  });
}

export function createGPT5MiniModel() {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT5_MINI,
  });
}

export function createGPT56LunaModel() {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT56_LUNA,
  });
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/**
 * The canonical writer contract is provider-neutral. It defaults on for the
 * keyword pipeline; the escape hatch exists only for a short rollback to the
 * pre-grounding GPT prompt while an incident is investigated.
 */
export function isGroundedBlogWriterContractEnabled(): boolean {
  return process.env.BLOG_GROUNDED_WRITER_CONTRACT_ENABLED !== "false";
}

/**
 * Enables the retired section-at-a-time writer for compatibility with offline
 * evaluation code. Production generation does not consult this setting.
 */
export function isSectionedBlogWriterEnabled(): boolean {
  return process.env.BLOG_SECTIONED_WRITER_ENABLED !== "false";
}

export function getGraphRecursionLimit(): number {
  return parsePositiveInteger(process.env.LLM_GRAPH_RECURSION_LIMIT, 60);
}

export function getGraphMaxToolRounds(): number {
  // Bumped from 12 → 16. The blog generation pipeline now needs:
  //   1 round: generate-seo-titles (T1 — with archetype)
  //   1 round: find-all-relevant-links
  //   1 round: get-batch-images-for-blog
  //   5-8 rounds: LLM writes content (long blogs take multiple rounds)
  //   1 round: save-blog-info
  // Total: 9-12 rounds in normal flow. 16 gives 4-7 rounds of slack.
  // The new same-tool-name loop guard in graph-guard.ts prevents the
  // "stuck calling links forever" bug, so the higher cap is safe.
  //
  // When the expert-voice critique-revise loop is enabled, each revision is a
  // full content rewrite (~5-8 extra rounds), so we add headroom per allowed
  // revision unless an explicit override is set.
  if (!process.env.LLM_GRAPH_MAX_TOOL_ROUNDS && isBlogCritiqueLoopEnabled()) {
    return (
      16 +
      8 * getBlogCritiqueMaxRevisions() +
      4 * getBlogGroundingMaxRevisions()
    );
  }
  return parsePositiveInteger(process.env.LLM_GRAPH_MAX_TOOL_ROUNDS, 16);
}

/**
 * Inject real competitors + business-type offerings into the generation prompt.
 * Dark-launched (off by default): it changes live output, so validate on staging
 * first. Lower-risk than the loop below — enable this first, then the loop.
 */
export function isBlogSubstanceGroundingEnabled(): boolean {
  return process.env.BLOG_SUBSTANCE_GROUNDING_ENABLED === "true";
}

/**
 * Inject the business's real Google Search Console signals into the generation
 * prompt (already-ranking position, striking-distance queries) so the article is
 * written to improve ranking. Off by default; degrades safely when GSC is not
 * connected or has no data (the section is simply omitted).
 */
export function isBlogGscGroundingEnabled(): boolean {
  return process.env.BLOG_GSC_GROUNDING_ENABLED === "true";
}

/**
 * Fetch competitor sitemaps to extract their real products for "X vs Y" blogs.
 * Off by default: it makes external HTTP calls (cached, capped, best-effort) so
 * it is the heaviest of the grounding options. Requires substance grounding on.
 */
export function isBlogCompetitorProductsEnabled(): boolean {
  return process.env.BLOG_COMPETITOR_PRODUCTS_ENABLED === "true";
}

/**
 * Fetch product pages to extract real ld+json price/brand for the catalog.
 * Heaviest option (one HTTP fetch per product, capped + cached); needs catalog
 * grounding on. Off by default.
 */
export function isBlogProductDetailsEnabled(): boolean {
  return process.env.BLOG_PRODUCT_DETAILS_ENABLED === "true";
}

/**
 * Expert-voice critique-revise loop config (dark-launched). Off by default so
 * it can be enabled per environment once the rubric is calibrated. For the judge
 * to grade competitor/offering use fairly, enable substance grounding too.
 */
export function isBlogCritiqueLoopEnabled(): boolean {
  return process.env.BLOG_CRITIQUE_LOOP_ENABLED === "true";
}

/**
 * Auto-scrape the business's own website for facts we don't store (price-from,
 * group size, founding year, lead time, dietary/options) to ground the
 * At-a-Glance table, pricing Quick Answer, and "since YYYY" E-E-A-T. Best-effort
 * + cached; omits anything not found. Off by default.
 */
export function isBlogBusinessFactsEnabled(): boolean {
  return process.env.BLOG_BUSINESS_FACTS_ENABLED === "true";
}

/**
 * Per-article GPT-5 mini strategist: reads the live SERP + business
 * approach profile and decides content type, intent, the winning angle, the
 * required rank-modules, and the outline — replacing the regex archetype. Falls
 * back to the archetype service on failure. Off by default.
 */
export function isBlogStrategistEnabled(): boolean {
  return process.env.BLOG_STRATEGIST_ENABLED === "true";
}

/**
 * Number of EXTRA revise attempts (total drafts = this + 1). The blog graphs set
 * a per-tool `save-blog-info` loop limit of (this + 3) in the graph-guard, so the
 * critique loop's repeated saves are no longer cut off as a same-tool loop, and
 * `getGraphMaxToolRounds` scales tool-round headroom by this value too.
 */
export function getBlogCritiqueMaxRevisions(): number {
  // Default 2 (→ 3 drafts total). A draft that clears the bar ships immediately
  // (decideCritiqueAction returns "save"), so the extra budget is only spent on
  // sub-bar drafts that still need work. The graph-guard's per-tool loop limit
  // for save-blog-info scales with this value, so raising it stays safe.
  return parsePositiveInteger(process.env.BLOG_CRITIQUE_MAX_REVISIONS, 2);
}

/**
 * Deterministic correction attempts for unsupported facts, banned phrases, and
 * missing rank modules. These do not consume the expert-voice revision budget:
 * factual correctness must be established before paying the editorial judge.
 */
export function getBlogGroundingMaxRevisions(): number {
  return parsePositiveInteger(process.env.BLOG_GROUNDING_MAX_REVISIONS, 2);
}

/**
 * When the editorial judge is enabled, do not persist a draft that never clears
 * the configured bar or could not be judged. This defaults to fail-closed; set
 * BLOG_CRITIQUE_FAIL_CLOSED=false only for an intentional diagnostic rollout.
 */
export function isBlogCritiqueFailClosed(): boolean {
  return process.env.BLOG_CRITIQUE_FAIL_CLOSED !== "false";
}

/**
 * INCIDENT ROLLBACK (default off): when true, fail-open EVERY blog-quality gate
 * — the expert-voice judge, the save-time grounding gate, the pre-writer
 * evidence-sufficiency gate, and the canonical business-data-conflict gate — so
 * the raw model draft is persisted like the pre-July-13 pipeline. This is the
 * single switch for a deliberate backlog-recovery push. It DISABLES fabrication
 * protection and must never be enabled for steady-state generation.
 */
export function isBlogCritiqueGateBypassEnabled(): boolean {
  return process.env.BLOG_CRITIQUE_GATE_BYPASS === "true";
}

/**
 * Optional per-dimension weights for the expert-voice judge's overall score,
 * so you can re-weight the rubric toward whatever the ranking-correlation
 * analysis shows actually ranks — WITHOUT a code change. Format:
 *   BLOG_VOICE_WEIGHTS="specificity:2,opinions:1.5,competitorUse:0.5"
 * Returns null when unset (judge keeps its default overall).
 */
export function getExpertVoiceWeights(): Record<string, number> | null {
  const raw = process.env.BLOG_VOICE_WEIGHTS;
  if (!raw) return null;
  const out: Record<string, number> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    const num = Number(v);
    if (k && Number.isFinite(num) && num >= 0) out[k] = num;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Pass bar (0-10) for the expert-voice judge. */
export function getBlogCritiqueBar(): number {
  const raw = Number(process.env.BLOG_CRITIQUE_BAR);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 10) {
    return EXPERT_VOICE_BAR_DEFAULT;
  }
  return raw;
}

export function createGPT54NanoModel() {
  return new ChatOpenAI({
    apiKey: OPENAI_API_KEY,
    model: LLM_MODELS.GPT54_NANO,
  });
}

export const getLLMForKeywords = () => createGPT5MiniModel();
export const getLLMForBlogs = () => createGPT56LunaModel();
export const getLLMForComplexTasks = () => createGPT5MiniModel();
export const getLLMForOnboarding = () => createGPT5Model();
export const getLLMForPremiumTasks = () => createGPT5MiniModel();
export const getLLMForSeoAudit = () => createGPT56LunaModel();
