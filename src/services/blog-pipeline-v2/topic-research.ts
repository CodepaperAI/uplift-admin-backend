import { createHash } from "node:crypto";
import OpenAI from "openai";

export const RECOVERY_TOPIC_SERP_OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";
// One seed ownership check, one optional Playbook refinement check, and one
// optional evidence-focused search when the first two result sets do not yield
// two admissible directly relevant sources.
export const RECOVERY_TOPIC_SERP_OPENAI_MAX_CALLS_PER_PLAN = 3;
export const RECOVERY_TOPIC_SERP_OPENAI_DEFAULT_USD_RESERVATION_PER_CALL = 0.04;
export const RECOVERY_TOPIC_SERP_OPENAI_MAX_OUTPUT_TOKENS = 3200;

export type RecoveryTopicSerpProviderMode =
  | "legacy"
  | "openai-web-search"
  | "legacy-openai-fallback";

type SerpStructure = "guide" | "list" | "how-to" | "service" | "article";

export type RecoveryTopicSerpAnalysis = {
  top10Results: Array<{
    title: string;
    url: string;
    domain: string;
    position: number;
    estimatedWordCount?: number;
    structure?: SerpStructure;
    hasFAQ?: boolean;
    hasImages?: boolean;
    hasVideos?: boolean;
  }>;
  averageWordCount: number;
  commonSections: string[];
  contentGaps: string[];
  dominantFormat: "guide" | "list" | "how-to" | "service" | "mixed";
  visualElements: {
    averageImages: number;
    hasInfographics: boolean;
    hasVideos: boolean;
  };
};

export type RecoveryTopicSerpEvidenceExcerpt = {
  title: string;
  url: string;
  excerpt: string;
  authority: "authoritative_external";
  provider: "openai_responses_web_search";
  provenance: {
    responseId: string;
    captureMethod: "single_web_search_response_exact_excerpt";
    citationBound: true;
  };
  retrievedAt: string;
};

export type RecoveryTopicSerpLocation = {
  locationCode: number;
  languageCode: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
};

export type RecoveryTopicSerpOpenAiProvenance = {
  schemaVersion: "recovery-topic-serp-openai-provenance-v2";
  provider: "openai_responses_web_search";
  model: string;
  responseId: string;
  responseStatus: string;
  exactInput: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    city: string | null;
    region: string | null;
    country: string | null;
  };
  tool: {
    type: "web_search";
    searchContextSize: "low";
    userLocation: Record<string, string>;
  };
  requestLimits: {
    maxOutputTokens: number;
    maxResults: 10;
    excerptWords: { minimum: 30; maximum: 90 };
  };
  legacyProvider: {
    provider: "dataforseo_with_scraperapi_fallback";
    outcome: "bypassed_by_explicit_mode" | "no_usable_analysis";
  };
  citedResultCount: number;
  citedResultUrlsSha256: string;
  evidenceExcerptCount: number;
  evidenceExcerptSha256: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Responses API requests made for this captured response. */
    webSearchCalls: number;
    /** web_search_call output actions emitted inside the single response. */
    webSearchActions: number;
  };
  costAccounting: {
    kind: "configured_per_call_hard_upper_bound";
    estimatedUsd: number;
  };
  capturedAt: string;
};

type ResponsesClient = {
  responses: {
    create: (request: any) => Promise<any>;
  };
};

type RecoveryTopicSerpOpenAiInput = {
  keyword: string;
  location: RecoveryTopicSerpLocation;
  model?: string;
  estimatedUsdPerCall?: number;
  client?: ResponsesClient;
  now?: () => Date;
  legacyProviderOutcome?:
    | "bypassed_by_explicit_mode"
    | "no_usable_analysis";
};

type RecoveryTopicSerpResolutionInput = Omit<
  RecoveryTopicSerpOpenAiInput,
  "legacyProviderOutcome"
> & {
  mode: RecoveryTopicSerpProviderMode;
  legacyLookup: () => Promise<RecoveryTopicSerpAnalysis | null>;
  onProviderCallStarted?: (
    provider: "legacy" | "openai_responses_web_search",
  ) => Promise<void> | void;
};

export type RecoveryTopicSerpResolution = {
  analysis: RecoveryTopicSerpAnalysis;
  evidenceExcerpts: RecoveryTopicSerpEvidenceExcerpt[];
  provenance:
    | RecoveryTopicSerpOpenAiProvenance
    | {
        schemaVersion: "recovery-topic-serp-legacy-provenance-v1";
        provider: "dataforseo_with_scraperapi_fallback";
        providerMode: "legacy" | "legacy-openai-fallback";
        exactInput: {
          keyword: string;
          locationCode: number;
          languageCode: string;
          city: string | null;
          region: string | null;
          country: string | null;
        };
        outcome: "usable_analysis";
        capturedAt: string;
      };
  providerCalls: {
    legacy: number;
    openAiWebSearch: number;
    total: number;
  };
};

function requiredTrimmed(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`Missing ${label}`);
  return normalized;
}

function finiteNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoCountryCode(country: string | null): string | null {
  if (!country) return null;
  const normalized = country.trim().toLowerCase();
  const aliases: Record<string, string> = {
    ca: "CA",
    can: "CA",
    canada: "CA",
    us: "US",
    usa: "US",
    "united states": "US",
    "united states of america": "US",
    ae: "AE",
    uae: "AE",
    "united arab emirates": "AE",
    gb: "GB",
    uk: "GB",
    "united kingdom": "GB",
    in: "IN",
    india: "IN",
    au: "AU",
    australia: "AU",
  };
  // Fail closed for unknown two-letter values. Production business records can
  // contain province/state abbreviations (for example "ON") in the country
  // field, and passing those through as ISO country codes makes the OpenAI web
  // search request fail. The numeric location code plus city/region remain the
  // authoritative recovery location when the country value is not recognized.
  return aliases[normalized] ?? null;
}

function urlKey(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

type RecoveryTopicSerpCitation = {
  title: string;
  url: string;
  evidenceExcerpt?: string;
};

function collectOutputText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  return (Array.isArray(response?.output) ? response.output : [])
    .filter((output: any) => output?.type === "message")
    .flatMap((output: any) => (Array.isArray(output.content) ? output.content : []))
    .map((content: any) => {
      const text =
        typeof content?.text === "string"
          ? content.text
          : typeof content?.text?.value === "string"
            ? content.text.value
            : "";
      return text.trim();
    })
    .filter(Boolean)
    .join("\n");
}

function parseStructuredResultExcerpts(response: any): Array<{
  title: string;
  url: string;
  evidenceExcerpt: string;
}> {
  const text = collectOutputText(response);
  if (!text) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const withoutFence = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const rows = Array.isArray(parsed?.results) ? parsed.results : [];
  return rows
    .map((row: any) => {
      const url = urlKey(String(row?.url ?? ""));
      const title = String(row?.title ?? "").replace(/\s+/g, " ").trim();
      const evidenceExcerpt = String(row?.evidenceExcerpt ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        !url ||
        !title ||
        evidenceExcerpt.length < 60 ||
        evidenceExcerpt.length > 700
      ) {
        return null;
      }
      return { title, url, evidenceExcerpt };
    })
    .filter((row: any): row is NonNullable<typeof row> => row !== null)
    .slice(0, 10);
}

function collectCitations(response: any): RecoveryTopicSerpCitation[] {
  const sourceUrls = new Map<string, { url: string; title: string | null }>();
  const annotationCitations = new Map<
    string,
    { title: string; url: string }
  >();
  for (const output of Array.isArray(response?.output) ? response.output : []) {
    if (output?.type === "web_search_call") {
      for (const source of Array.isArray(output?.action?.sources)
        ? output.action.sources
        : []) {
        const normalizedUrl = urlKey(String(source?.url ?? ""));
        if (!normalizedUrl) continue;
        // The Responses SDK intentionally exposes web-search sources as URL
        // objects without titles. Preserve the exact source URL here; the
        // structured result supplies its requested title and excerpt.
        const title = String(source?.title ?? "").replace(/\s+/g, " ").trim();
        const previous = sourceUrls.get(normalizedUrl);
        sourceUrls.set(normalizedUrl, {
          url: normalizedUrl,
          title: (previous?.title ?? title) || null,
        });
      }
    }
    if (output?.type !== "message") continue;
    for (const content of Array.isArray(output.content) ? output.content : []) {
      for (const annotation of Array.isArray(content?.annotations)
        ? content.annotations
        : []) {
        const citation =
          annotation?.type === "url_citation"
            ? annotation
            : annotation?.url_citation ?? null;
        if (!citation || citation?.type && citation.type !== "url_citation") {
          continue;
        }
        const normalizedUrl = urlKey(String(citation.url ?? ""));
        const title = String(citation.title ?? "").replace(/\s+/g, " ").trim();
        if (!normalizedUrl || !title) continue;
        const previous = sourceUrls.get(normalizedUrl);
        sourceUrls.set(normalizedUrl, {
          url: normalizedUrl,
          title: previous?.title ?? title,
        });
        if (!annotationCitations.has(normalizedUrl)) {
          annotationCitations.set(normalizedUrl, { title, url: normalizedUrl });
        }
      }
    }
  }
  const structured = parseStructuredResultExcerpts(response);
  const ordered: RecoveryTopicSerpCitation[] = [];
  const orderedUrls = new Set<string>();
  for (const row of structured) {
    const exactSource = sourceUrls.get(row.url);
    const annotated = annotationCitations.get(row.url);
    // A model-authored URL is never enough. Bind every excerpt to a URL that
    // the web-search tool returned or cited in the same response. An annotation
    // title wins; source-list entries have no title, so use the structured title
    // only after the exact URL has been bound to that list.
    if (!exactSource || orderedUrls.has(exactSource.url)) continue;
    orderedUrls.add(exactSource.url);
    ordered.push({
      title: annotated?.title ?? exactSource.title ?? row.title,
      url: exactSource.url,
      evidenceExcerpt: row.evidenceExcerpt,
    });
  }
  for (const cited of annotationCitations.values()) {
    if (orderedUrls.has(cited.url)) continue;
    orderedUrls.add(cited.url);
    ordered.push(cited);
  }
  for (const source of sourceUrls.values()) {
    if (!source.title || orderedUrls.has(source.url)) continue;
    orderedUrls.add(source.url);
    ordered.push({ title: source.title, url: source.url });
  }
  return ordered.slice(0, 10);
}

function classifyStructure(title: string, url: string): SerpStructure {
  const normalizedTitle = title.toLowerCase();
  const normalizedUrl = url.toLowerCase();
  let shallowPath = false;
  let pathSegmentCount = 0;
  let blogSubdomain = false;
  try {
    const parsed = new URL(normalizedUrl);
    pathSegmentCount = parsed.pathname.split("/").filter(Boolean).length;
    shallowPath = pathSegmentCount <= 2;
    blogSubdomain = parsed.hostname.startsWith("blog.");
  } catch {
    shallowPath = false;
  }
  const explicitBlogPath =
    /\/(?:blogs?|articles?|learn|resources?|guides?|news)(?:\/|$|[?#])/.test(
      normalizedUrl,
    ) || blogSubdomain;
  const explicitMoneyPath =
    /\/(?:collections?|products?|services?|menu|orders?|booking|book|shop|store|category|practice-areas?|coaching|personal-training|rentals?|rooms?|catering|locations?)(?:\/|$|[?#])/.test(
      normalizedUrl,
    );
  const informationalTitle =
    /\b(?:how to|how do|how can|what to|why\b|when\b|which\b|tips?|checklist|guide|tutorial|step by step|questions? to ask|according to|ways? to|easiest way)\b/.test(
      normalizedTitle,
    );
  const informationalShallowPath =
    shallowPath &&
    pathSegmentCount > 0 &&
    informationalTitle &&
    !explicitMoneyPath;
  if (
    explicitMoneyPath ||
    /\b(?:book now|order online|shop now|our services|service area|view menu|near me)\b/.test(
      normalizedTitle,
    ) ||
    (shallowPath && !explicitBlogPath && !informationalShallowPath)
  ) {
    return "service";
  }
  if (/\b(?:how to|how-to|tutorial|step by step)\b/.test(normalizedTitle)) {
    return "how-to";
  }
  if (/\b(?:best|top \d+|\d+ (?:ways|tips)|compare|comparison)\b/.test(normalizedTitle)) {
    return "list";
  }
  if (/\b(?:complete|ultimate|comprehensive|guide)\b/.test(normalizedTitle)) {
    return "guide";
  }
  return "article";
}

export function buildRecoveryTopicSerpAnalysisFromCitations(
  citations: Array<{ title: string; url: string; evidenceExcerpt?: string }>,
): RecoveryTopicSerpAnalysis {
  const results = citations
    .map((citation, index) => {
      const url = urlKey(citation.url);
      const title = citation.title.trim();
      if (!url || !title) return null;
      return {
        title,
        url,
        domain: new URL(url).hostname.replace(/^www\./, ""),
        position: index + 1,
        structure: classifyStructure(title, url),
        hasFAQ: /\bfaq\b|frequently asked/i.test(title),
        hasImages: false,
        hasVideos: false,
      };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .slice(0, 10);
  if (results.length < 3) {
    throw new Error(
      `BLOG_TOPIC_OPENAI_SERP_INSUFFICIENT_CITATIONS: expected at least 3 cited live results, found ${results.length}`,
    );
  }
  const counts = results.reduce<Record<string, number>>((acc, result) => {
    const structure = result.structure ?? "article";
    acc[structure] = (acc[structure] ?? 0) + 1;
    return acc;
  }, {});
  const dominant = Object.entries(counts).sort(([, left], [, right]) => right - left)[0]?.[0];
  const dominantFormat =
    dominant === "article" ? "mixed" : ((dominant ?? "mixed") as RecoveryTopicSerpAnalysis["dominantFormat"]);
  return {
    top10Results: results,
    averageWordCount: 0,
    commonSections: [],
    contentGaps: [],
    dominantFormat,
    visualElements: {
      averageImages: 0,
      hasInfographics: false,
      hasVideos: false,
    },
  };
}

function exactLocation(input: RecoveryTopicSerpLocation) {
  const city = input.city?.trim() || null;
  const region = input.region?.trim() || null;
  const country = input.country?.trim() || null;
  return {
    locationCode: input.locationCode,
    languageCode: requiredTrimmed(input.languageCode, "SERP language code"),
    city,
    region,
    country,
  };
}

export async function fetchRecoveryTopicSerpViaOpenAi(
  input: RecoveryTopicSerpOpenAiInput,
): Promise<{
  analysis: RecoveryTopicSerpAnalysis;
  evidenceExcerpts: RecoveryTopicSerpEvidenceExcerpt[];
  provenance: RecoveryTopicSerpOpenAiProvenance;
}> {
  const keyword = requiredTrimmed(input.keyword, "SERP keyword");
  const location = exactLocation(input.location);
  if (!Number.isInteger(location.locationCode) || location.locationCode <= 0) {
    throw new Error("Missing positive SERP location code");
  }
  const model = input.model?.trim() || RECOVERY_TOPIC_SERP_OPENAI_DEFAULT_MODEL;
  const estimatedUsdPerCall = Number(
    input.estimatedUsdPerCall ??
      RECOVERY_TOPIC_SERP_OPENAI_DEFAULT_USD_RESERVATION_PER_CALL,
  );
  if (!Number.isFinite(estimatedUsdPerCall) || estimatedUsdPerCall <= 0) {
    throw new Error("OpenAI SERP fallback cost reservation must be positive");
  }
  const client =
    input.client ??
    new OpenAI({
      apiKey: requiredTrimmed(process.env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      maxRetries: 0,
      timeout: 180_000,
    });
  const countryCode = isoCountryCode(location.country);
  const userLocation: Record<string, string> = {
    type: "approximate",
    ...(countryCode ? { country: countryCode } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.city ? { city: location.city } : {}),
  };
  const tool = {
    type: "web_search" as const,
    search_context_size: "low" as const,
    user_location: userLocation,
  };
  const response = await client.responses.create({
    model,
    store: false,
    tools: [tool],
    include: ["web_search_call.action.sources"],
    tool_choice: "required",
    parallel_tool_calls: false,
    reasoning: { effort: "low" },
    max_output_tokens: RECOVERY_TOPIC_SERP_OPENAI_MAX_OUTPUT_TOKENS,
    instructions: [
      "Run one live web search for the exact query and location supplied by the user message.",
      "Do not rewrite, broaden, translate, or add terms to the query.",
      "Report eight to ten distinct organic web results in ranking order when available.",
      "Exclude advertisements, maps, social posts, image results, and search-engine pages.",
      "Every result must include a web-search URL citation. Do not invent URLs or titles.",
      "For each result, copy one short contiguous 30-90 word excerpt verbatim from that exact source page. The excerpt itself—not its title or URL—must directly address the exact query and the supplied locale or jurisdiction when the subject is location-sensitive.",
      "Omit results that offer only a title, byline, navigation, boilerplate, or an excerpt from a different category. Do not paraphrase excerpts and do not combine text from multiple pages.",
    ].join(" "),
    input: [
      `Exact query: ${keyword}`,
      `Exact location code: ${location.locationCode}`,
      `Exact language code: ${location.languageCode}`,
      `Exact city: ${location.city ?? "not supplied"}`,
      `Exact region: ${location.region ?? "not supplied"}`,
      `Exact country: ${location.country ?? "not supplied"}`,
    ].join("\n"),
    text: {
      format: {
        type: "json_schema",
        name: "recovery_topic_serp_results_with_exact_excerpts",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  url: { type: "string" },
                  evidenceExcerpt: { type: "string" },
                },
                required: ["title", "url", "evidenceExcerpt"],
              },
            },
          },
          required: ["results"],
        },
      },
    },
  });
  if (response?.status !== "completed") {
    const incompleteReason = String(
      response?.incomplete_details?.reason ?? "not_supplied",
    );
    const incompleteDetails = JSON.stringify(
      response?.incomplete_details ?? null,
    ).slice(0, 500);
    if (
      response?.status === "incomplete" &&
      incompleteReason === "max_output_tokens"
    ) {
      throw new Error(
        `BLOG_TOPIC_OPENAI_SERP_INCOMPLETE_MAX_OUTPUT_TOKENS: bounded output envelope ${RECOVERY_TOPIC_SERP_OPENAI_MAX_OUTPUT_TOKENS} tokens was exhausted; incomplete_details=${incompleteDetails}`,
      );
    }
    throw new Error(
      `BLOG_TOPIC_OPENAI_SERP_INCOMPLETE: status=${String(response?.status ?? "unknown")}; reason=${incompleteReason}; incomplete_details=${incompleteDetails}`,
    );
  }
  const citations = collectCitations(response);
  const analysis = buildRecoveryTopicSerpAnalysisFromCitations(citations);
  const webSearchActions = (
    Array.isArray(response.output) ? response.output : []
  ).filter((output: any) => output?.type === "web_search_call").length;
  if (webSearchActions < 1) {
    throw new Error(
      "BLOG_TOPIC_OPENAI_SERP_ACTION_COUNT_INVALID: a completed OpenAI web-search response must contain at least one web_search_call action",
    );
  }
  // This function made exactly one Responses API request. A single response may
  // legitimately contain multiple web_search_call actions; provider budgets and
  // per-call cost reservations remain request-based rather than action-based.
  const webSearchCalls = 1;
  const inputTokens = finiteNonNegativeInteger(response?.usage?.input_tokens);
  const outputTokens = finiteNonNegativeInteger(response?.usage?.output_tokens);
  const totalTokens = finiteNonNegativeInteger(
    response?.usage?.total_tokens ?? inputTokens + outputTokens,
  );
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  const responseId = requiredTrimmed(response?.id, "OpenAI SERP response id");
  const evidenceExcerpts: RecoveryTopicSerpEvidenceExcerpt[] = citations
    .filter(
      (citation): citation is RecoveryTopicSerpCitation & { evidenceExcerpt: string } =>
        Boolean(citation.evidenceExcerpt),
    )
    .map((citation) => ({
      title: citation.title,
      url: citation.url,
      excerpt: citation.evidenceExcerpt,
      authority: "authoritative_external",
      provider: "openai_responses_web_search",
      provenance: {
        responseId,
        captureMethod: "single_web_search_response_exact_excerpt",
        citationBound: true,
      },
      retrievedAt: capturedAt,
    }));
  return {
    analysis,
    evidenceExcerpts,
    provenance: {
      schemaVersion: "recovery-topic-serp-openai-provenance-v2",
      provider: "openai_responses_web_search",
      model,
      responseId,
      responseStatus: response.status,
      exactInput: { keyword, ...location },
      tool: {
        type: "web_search",
        searchContextSize: "low",
        userLocation,
      },
      requestLimits: {
        maxOutputTokens: RECOVERY_TOPIC_SERP_OPENAI_MAX_OUTPUT_TOKENS,
        maxResults: 10,
        excerptWords: { minimum: 30, maximum: 90 },
      },
      legacyProvider: {
        provider: "dataforseo_with_scraperapi_fallback",
        outcome: input.legacyProviderOutcome ?? "no_usable_analysis",
      },
      citedResultCount: analysis.top10Results.length,
      citedResultUrlsSha256: createHash("sha256")
        .update(JSON.stringify(analysis.top10Results.map((result) => result.url)))
        .digest("hex"),
      evidenceExcerptCount: evidenceExcerpts.length,
      evidenceExcerptSha256: createHash("sha256")
        .update(
          JSON.stringify(
            evidenceExcerpts.map((item) => ({
              title: item.title,
              url: item.url,
              excerpt: item.excerpt,
            })),
          ),
        )
        .digest("hex"),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        webSearchCalls,
        webSearchActions,
      },
      costAccounting: {
        kind: "configured_per_call_hard_upper_bound",
        estimatedUsd: estimatedUsdPerCall,
      },
      capturedAt,
    },
  };
}

export function recoveryTopicSerpOpenAiProvenanceAccountingValid(
  provenance: unknown,
): boolean {
  const value = provenance as RecoveryTopicSerpOpenAiProvenance | null;
  return value?.schemaVersion === "recovery-topic-serp-openai-provenance-v2" &&
    value.provider === "openai_responses_web_search" &&
    Number(value.usage?.webSearchCalls) === 1 &&
    Number.isInteger(Number(value.usage?.webSearchActions)) &&
    Number(value.usage?.webSearchActions) >= 1 &&
    value.costAccounting?.kind === "configured_per_call_hard_upper_bound" &&
    Number.isFinite(Number(value.costAccounting?.estimatedUsd)) &&
    Number(value.costAccounting?.estimatedUsd) > 0;
}

export function recoveryTopicSerpProviderLedgerValid(input: {
  mode: RecoveryTopicSerpProviderMode;
  logicalCalls: number;
  legacyCalls: number;
  openAiWebSearchCalls: number;
}): boolean {
  const { mode, logicalCalls, legacyCalls, openAiWebSearchCalls } = input;
  if (
    !Number.isInteger(logicalCalls) ||
    !Number.isInteger(legacyCalls) ||
    !Number.isInteger(openAiWebSearchCalls) ||
    logicalCalls < 0 ||
    legacyCalls < 0 ||
    openAiWebSearchCalls < 0
  ) {
    return false;
  }
  // A context root can supply backlinks without supplying topic SERP evidence.
  // Use the logical SERP call count—not the mere presence of a reuse root—to
  // distinguish a genuinely reused topic checkpoint from a fresh live lookup.
  if (logicalCalls === 0) {
    return legacyCalls === 0 && openAiWebSearchCalls === 0;
  }
  if (mode === "openai-web-search") {
    return legacyCalls === 0 && openAiWebSearchCalls === logicalCalls;
  }
  if (mode === "legacy-openai-fallback") {
    return (
      legacyCalls === logicalCalls &&
      openAiWebSearchCalls <= logicalCalls
    );
  }
  return legacyCalls === logicalCalls && openAiWebSearchCalls === 0;
}

export function recoveryTopicSerpEvidenceExcerptsValid(
  value: unknown,
  expectedResponseId: string,
  expectedDigest?: string,
): value is RecoveryTopicSerpEvidenceExcerpt[] {
  if (!Array.isArray(value) || value.length === 0 || !expectedResponseId.trim()) {
    return false;
  }
  const urls = new Set<string>();
  for (const item of value) {
    const url = urlKey(String(item?.url ?? ""));
    if (
      !url ||
      urls.has(url) ||
      !String(item?.title ?? "").trim() ||
      String(item?.excerpt ?? "").trim().length < 60 ||
      item?.authority !== "authoritative_external" ||
      item?.provider !== "openai_responses_web_search" ||
      item?.provenance?.responseId !== expectedResponseId ||
      item?.provenance?.captureMethod !==
        "single_web_search_response_exact_excerpt" ||
      item?.provenance?.citationBound !== true ||
      !Number.isFinite(Date.parse(String(item?.retrievedAt ?? "")))
    ) {
      return false;
    }
    urls.add(url);
  }
  if (
    expectedDigest !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedDigest) ||
      createHash("sha256")
      .update(
        JSON.stringify(
          value.map((item) => ({
            title: item.title,
            url: item.url,
            excerpt: item.excerpt,
          })),
        ),
      )
      .digest("hex") !== expectedDigest)
  ) {
    return false;
  }
  return true;
}

export async function resolveRecoveryTopicSerpEvidence(
  input: RecoveryTopicSerpResolutionInput,
): Promise<RecoveryTopicSerpResolution> {
  const keyword = requiredTrimmed(input.keyword, "SERP keyword");
  const location = exactLocation(input.location);
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  if (input.mode === "openai-web-search") {
    await input.onProviderCallStarted?.("openai_responses_web_search");
    const openAi = await fetchRecoveryTopicSerpViaOpenAi({
      ...input,
      keyword,
      location,
      legacyProviderOutcome: "bypassed_by_explicit_mode",
    });
    return {
      ...openAi,
      providerCalls: { legacy: 0, openAiWebSearch: 1, total: 1 },
    };
  }

  await input.onProviderCallStarted?.("legacy");
  let legacyAnalysis: RecoveryTopicSerpAnalysis | null = null;
  try {
    legacyAnalysis = await input.legacyLookup();
  } catch (error) {
    if (input.mode !== "legacy-openai-fallback") throw error;
  }
  if (legacyAnalysis) {
    return {
      analysis: legacyAnalysis,
      evidenceExcerpts: [],
      provenance: {
        schemaVersion: "recovery-topic-serp-legacy-provenance-v1",
        provider: "dataforseo_with_scraperapi_fallback",
        providerMode: input.mode,
        exactInput: { keyword, ...location },
        outcome: "usable_analysis",
        capturedAt,
      },
      providerCalls: { legacy: 1, openAiWebSearch: 0, total: 1 },
    };
  }
  if (input.mode === "legacy") {
    throw new Error(
      "BLOG_TOPIC_SERP_UNAVAILABLE: existing SERP providers returned no usable analysis",
    );
  }

  await input.onProviderCallStarted?.("openai_responses_web_search");
  const openAi = await fetchRecoveryTopicSerpViaOpenAi({
    ...input,
    keyword,
    location,
    legacyProviderOutcome: "no_usable_analysis",
  });
  return {
    ...openAi,
    providerCalls: { legacy: 1, openAiWebSearch: 1, total: 2 },
  };
}
