import { prisma } from "../config/db.config";
import {
  LLM_MODELS,
  createGPT54NanoModel,
} from "../config/llm.config";
import { LlmProvider } from "@prisma/client";
import { inngest } from "../inngest/client";
import {
  recordLlmUsageEvent,
  recordLlmUsageFromLangChainMessage,
} from "./llm-usage.service";
import {
  buildDomainMatchSet,
  isOwnDomain,
  matchBrand,
  type DomainMatchSet,
} from "../utils/citation-domain-matcher";
import { withCache } from "../utils/dataforseo-cache";
import { normalizeQueryForDedup } from "../utils/query-dedup.utils";

/**
 * Citation Monitoring Service
 *
 * Queries ChatGPT, Gemini, and Perplexity APIs with customer keywords
 * converted to natural-language questions. Parses responses for domain citations.
 *
 * Detection tiers (Phase 1):
 *   (a) Explicit URL match against customer domain
 *   (b) Brand/domain name mention (case-insensitive)
 */

const RUNS_PER_QUERY = 3;

// ----- Query expansion -----

const QUERY_TEMPLATES = [
  (kw: string) => `What is ${kw}?`,
  (kw: string) => `Can you recommend ${kw}?`,
  (kw: string) => `Tell me about ${kw}`,
];

export const BRAND_ANSWER_KEYWORD_PREFIX = "Brand answer:";

export type CitationQueryType = "discovery" | "brand_answer";

type BusinessForBrandChecks = {
  businessName: string;
  businessType: string;
  businessDescription?: string | null;
  businessWebsiteUrl: string;
  businessCity?: string | null;
  businessState?: string | null;
  businessCountry?: string | null;
  selectedServices?: string[];
};

type CitationScanTask = {
  keyword: string;
  queries: string[];
  queryType: CitationQueryType;
};

function normalizeQuestion(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.endsWith("?") ? normalized : `${normalized}?`;
}

export function getCitationQueryType(keyword: string): CitationQueryType {
  return keyword.startsWith(BRAND_ANSWER_KEYWORD_PREFIX)
    ? "brand_answer"
    : "discovery";
}

export function buildBrandAnswerCheckTasks(
  business: BusinessForBrandChecks,
): CitationScanTask[] {
  const businessName = business.businessName?.trim();
  if (!businessName) return [];

  const location = [
    business.businessCity,
    business.businessState,
    business.businessCountry,
  ]
    .filter(Boolean)
    .join(", ");
  const topServices = (business.selectedServices ?? [])
    .map((service) => service.trim())
    .filter(Boolean)
    .slice(0, 3);
  const serviceContext =
    topServices.length > 0
      ? topServices.join(", ")
      : business.businessType?.trim() || "services";
  const locationContext = location ? ` in ${location}` : "";

  return [
    {
      keyword: `${BRAND_ANSWER_KEYWORD_PREFIX} Overview`,
      queries: [
        normalizeQuestion(
          `What do you know about ${businessName}${locationContext}`,
        ),
      ],
      queryType: "brand_answer",
    },
    {
      keyword: `${BRAND_ANSWER_KEYWORD_PREFIX} Services`,
      queries: [
        normalizeQuestion(
          `What services does ${businessName} offer for ${serviceContext}`,
        ),
      ],
      queryType: "brand_answer",
    },
    {
      keyword: `${BRAND_ANSWER_KEYWORD_PREFIX} Location`,
      queries: [
        normalizeQuestion(
          `Where is ${businessName} located and what area does it serve`,
        ),
      ],
      queryType: "brand_answer",
    },
  ];
}

function buildAnswerExcerpt(responseText: string) {
  return responseText.replace(/\s+/g, " ").trim().slice(0, 600) || null;
}

/**
 * Expand a keyword into 2-3 natural language queries
 */
export function expandKeywordToQueries(keyword: string): string[] {
  const kw = keyword.trim();
  // Already looks like a question
  if (/^(what|how|why|when|where|which|can|do|does|is|are|should)\b/i.test(kw)) {
    return [kw.endsWith("?") ? kw : `${kw}?`];
  }
  return QUERY_TEMPLATES.slice(0, 2).map((t) => t(kw));
}

// ----- Citation detection -----

interface CitationResult {
  cited: boolean;
  citedUrl: string | null;
  citationContext: string | null;
  competitors: Array<{ domain: string; url?: string; context?: string }>;
}

/**
 * Generic domains that are almost never the "competitor" — even if they
 * appear in an LLM response's URL list, treat them as filler.
 */
const COMPETITOR_EXCLUDE_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "wikipedia.org",
  "en.wikipedia.org",
  "youtube.com",
  "www.youtube.com",
]);

/**
 * Normalize a URL-or-hostname string to a bare lowercase hostname (no www).
 * Returns null if the input is not parseable as a URL and not a plain hostname.
 *
 * Shared by Share of Voice aggregation and competitive gap analysis —
 * keep the normalization single-sourced to avoid drift with citation
 * detection in detectCitations().
 */
export function normalizeCompetitorHost(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * True if a hostname or URL should count as a tracked competitor —
 * i.e. it parses cleanly AND is not one of the filler hosts
 * (Google/Wikipedia/YouTube).
 */
export function isCompetitorDomain(input: string): boolean {
  const host = normalizeCompetitorHost(input);
  if (!host) return false;
  return !COMPETITOR_EXCLUDE_HOSTS.has(host);
}

/**
 * Detect if a business's domain / brand is cited in an LLM response.
 *
 *   Tier A (URL match)   → robust hostname comparison via isOwnDomain()
 *                          (handles www/apex variants; no substring traps)
 *   Tier B (Brand match) → word-boundary regex on the business name and
 *                          the domain's second-level label, with a
 *                          stopword denylist (see citation-domain-matcher).
 */
export function detectCitations(
  responseText: string,
  matchSet: DomainMatchSet,
): CitationResult {
  let cited = false;
  let citedUrl: string | null = null;
  let citationContext: string | null = null;

  const urlRegex = /https?:\/\/[^\s)>\]]+/gi;
  const urls = responseText.match(urlRegex) || [];

  // Tier A: URL match
  for (const url of urls) {
    if (isOwnDomain(url, matchSet)) {
      cited = true;
      citedUrl = url;
      const idx = responseText.indexOf(url);
      const start = Math.max(0, idx - 100);
      const end = Math.min(responseText.length, idx + url.length + 100);
      citationContext = responseText.slice(start, end).trim();
      break;
    }
  }

  // Tier B: word-boundary brand match
  if (!cited) {
    const hit = matchBrand(responseText, matchSet);
    if (hit) {
      cited = true;
      const start = Math.max(0, hit.index - 100);
      const end = Math.min(responseText.length, hit.index + hit.length + 100);
      citationContext = responseText.slice(start, end).trim();
    }
  }

  // Competitor extraction — any non-own, non-excluded URL.
  const competitors: CitationResult["competitors"] = [];
  for (const url of urls) {
    if (isOwnDomain(url, matchSet)) continue;
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (COMPETITOR_EXCLUDE_HOSTS.has(hostname)) continue;
    if (competitors.some((c) => c.domain === hostname)) continue;

    const idx = responseText.indexOf(url);
    const start = Math.max(0, idx - 80);
    const end = Math.min(responseText.length, idx + url.length + 80);
    competitors.push({
      domain: hostname,
      url,
      context: responseText.slice(start, end).trim(),
    });
  }

  return { cited, citedUrl, citationContext, competitors };
}

// ----- LLM query execution -----

type AiVisibilityUsageContext = {
  businessId: string;
  jobId?: string | null;
  source?: string | null;
  periodKey?: string | null;
  keyword?: string;
};

async function queryLlm(
  provider: LlmProvider,
  query: string,
  usageContext: AiVisibilityUsageContext,
): Promise<string> {
  const usageMetadata = {
    usageType: "ai_visibility_citation",
    provider,
    source: usageContext.source ?? null,
    periodKey: usageContext.periodKey ?? null,
    jobId: usageContext.jobId ?? null,
    keyword: usageContext.keyword ?? null,
    query: query.substring(0, 500),
  };

  if (provider === "CHATGPT") {
    const model = createGPT54NanoModel();
    const response = await model.invoke([
      {
        role: "system",
        content:
          "You are a helpful assistant. Answer the user's question thoroughly. Include specific website URLs and sources when relevant.",
      },
      { role: "user", content: query },
    ]);
    await recordLlmUsageFromLangChainMessage(response, {
      purpose: "ai_visibility",
      provider: "openai",
      businessId: usageContext.businessId,
      correlationId: usageContext.jobId ?? null,
      modelFallback: LLM_MODELS.GPT54_NANO,
      metadata: usageMetadata,
    });
    return typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  }

  if (provider === "GEMINI") {
    // Use OpenAI-compatible endpoint for Gemini
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.warn("⚠️ GEMINI_API_KEY not set, skipping Gemini scan");
      throw new Error("GEMINI_API_KEY not configured");
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          systemInstruction: {
            parts: [
              {
                text: "You are a helpful assistant. Answer the user's question thoroughly. Include specific website URLs and sources when relevant.",
              },
            ],
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const usage = data.usageMetadata as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined;
    await recordLlmUsageEvent({
      purpose: "ai_visibility",
      provider: "google",
      model: "gemini-2.5-flash",
      businessId: usageContext.businessId,
      correlationId: usageContext.jobId ?? null,
      inputTokens: usage?.promptTokenCount ?? null,
      outputTokens: usage?.candidatesTokenCount ?? null,
      totalTokens: usage?.totalTokenCount ?? null,
      metadata: {
        ...usageMetadata,
        googleUsageMetadata: usage ?? null,
      },
    });
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (provider === "PERPLEXITY") {
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (!pplxKey) {
      throw new Error("PERPLEXITY_API_KEY not configured");
    }

    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pplxKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Answer the user's question thoroughly. Include specific website URLs and sources when relevant.",
          },
          { role: "user", content: query },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    return (data as any).choices?.[0]?.message?.content || "";
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

// ----- Main scan orchestrator -----

export interface ScanOptions {
  businessId: string;
  maxKeywords?: number;
  runsPerQuery?: number;
  jobId?: string;
  source?: string;
  periodKey?: string | null;
}

export async function runCitationScan(options: ScanOptions) {
  const {
    businessId,
    maxKeywords = 50,
    runsPerQuery = RUNS_PER_QUERY,
  } = options;
  const normalizedRunsPerQuery = Math.max(1, Math.floor(runsPerQuery));

  // Get business domain
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      businessName: true,
      businessType: true,
      businessDescription: true,
      businessWebsiteUrl: true,
      businessCity: true,
      businessState: true,
      businessCountry: true,
      selectedServices: true,
    },
  });

  if (!business?.businessWebsiteUrl) {
    throw new Error(`Business ${businessId} has no website URL`);
  }

  // Build the domain match set once per scan. Business name (if present)
  // is included as a Tier-B brand pattern so citations like
  // "Acme Plumbing is recommended" are detected even when the domain
  // itself is generic (e.g. acmeco.com).
  const matchSet = buildDomainMatchSet(
    business.businessWebsiteUrl,
    business.businessName ?? undefined,
  );

  // Get keywords from the Plan table (active, non-deleted keywords)
  const plans = await prisma.plan.findMany({
    where: {
      businessId,
      deletedAt: null,
    },
    select: { keyword: true },
    distinct: ["keyword"],
    take: maxKeywords,
    orderBy: { createdAt: "desc" },
  });

  const scanTasks: CitationScanTask[] = [
    ...plans.map((plan) => ({
      keyword: plan.keyword,
      queries: expandKeywordToQueries(plan.keyword),
      queryType: "discovery" as const,
    })),
    ...buildBrandAnswerCheckTasks(business),
  ];

  if (scanTasks.length === 0) {
    console.log(`ℹ️ No keywords found for business ${businessId}`);
    return { success: true, keywordsScanned: 0, citations: 0 };
  }

  // Create scan record
  const scan = await prisma.llmCitationScan.create({
    data: {
      businessId,
      status: "running",
    },
  });

  const providers: LlmProvider[] = ["CHATGPT", "GEMINI"];
  if (process.env.PERPLEXITY_API_KEY) {
    providers.push("PERPLEXITY");
  }
  let totalCitations = 0;
  let keywordsScanned = 0;
  const failedProviders: LlmProvider[] = [];

  // Process a single keyword against a single provider
  async function scanKeywordProvider(
    keyword: string,
    queries: string[],
    provider: LlmProvider,
    queryType: CitationQueryType,
  ) {
    let citedCount = 0;
    let lastCitedUrl: string | null = null;
    let lastContext: string | null = null;
    let allCompetitors: CitationResult["competitors"] = [];
    let successfulRuns = 0;

    for (let run = 0; run < normalizedRunsPerQuery; run++) {
      const query = queries[run % queries.length] as string;
      try {
        const response = await queryLlm(provider, query, {
          businessId,
          jobId: options.jobId,
          source: options.source,
          periodKey: options.periodKey,
          keyword,
        });
        const result = detectCitations(response, matchSet);
        successfulRuns++;
        if (result.cited) {
          citedCount++;
          lastCitedUrl = result.citedUrl || lastCitedUrl;
          lastContext = result.citationContext || lastContext;
        }
        if (queryType === "brand_answer" && !lastContext) {
          lastContext = buildAnswerExcerpt(response);
        }
        allCompetitors.push(...result.competitors);
      } catch (error: any) {
        console.error(`⚠️ ${provider} query failed for "${keyword}": ${error.message}`);
        if (!failedProviders.includes(provider)) failedProviders.push(provider);
        break;
      }
    }

    if (successfulRuns > 0) {
      const uniqueCompetitors = allCompetitors.filter(
        (c, i, arr) => arr.findIndex((x) => x.domain === c.domain) === i,
      );
      await prisma.llmCitation.create({
        data: {
          scanId: scan.id,
          businessId,
          keyword,
          query: queries[0] || keyword,
          llmProvider: provider,
          citedCount,
          totalRuns: successfulRuns,
          cited: citedCount > 0,
          citedUrl: lastCitedUrl,
          citationContext: lastContext,
          competitorsCited: uniqueCompetitors,
        },
      });
      if (citedCount > 0) totalCitations++;
    }
  }

  // Process keywords in parallel batches of 5, both providers concurrently per keyword
  const BATCH_SIZE = 5;
  for (let i = 0; i < scanTasks.length; i += BATCH_SIZE) {
    const batch = scanTasks.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.flatMap((task) => {
        keywordsScanned++;
        return providers.map((provider) =>
          scanKeywordProvider(task.keyword, task.queries, provider, task.queryType),
        );
      }),
    );
  }

  // Update scan status
  const finalStatus =
    failedProviders.length === providers.length
      ? "failed"
      : failedProviders.length > 0
        ? "partial"
        : "completed";

  await prisma.llmCitationScan.update({
    where: { id: scan.id },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      keywordsScanned,
    },
  });

  // On a successful or partial scan, kick off competitive gap analysis
  // (Phase 3). We fire-and-forget — the scan itself is already finalized
  // and we never want gap-analysis problems to mask a successful scan.
  if (finalStatus === "completed" || finalStatus === "partial") {
    try {
      await inngest.send({
        name: "ai-visibility/analyze-gaps",
        data: { scanId: scan.id, businessId },
      });
    } catch (err: any) {
      console.error(
        "[citation-monitoring] failed to emit analyze-gaps event:",
        err?.message ?? err,
      );
    }
  }

  // When every provider failed we want a clear operational signal. Emit
  // both a structured log and an Inngest event — consumers can plug in
  // Slack / email / PagerDuty later without touching this code path.
  if (finalStatus === "failed") {
    const alertPayload = {
      event: "ai_visibility.provider_failure",
      businessId,
      scanId: scan.id,
      failedProviders,
      keywordsScanned,
    };
    console.error(JSON.stringify(alertPayload));
    try {
      await inngest.send({
        name: "ai-visibility/provider-failure",
        data: alertPayload,
      });
    } catch (err: any) {
      // Never rethrow from the alert — the scan is already finalized.
      console.error(
        "[citation-monitoring] failed to emit provider-failure event:",
        err?.message ?? err,
      );
    }
  }

  return {
    success: true,
    scanId: scan.id,
    status: finalStatus,
    keywordsScanned,
    citations: totalCitations,
    failedProviders,
  };
}

// ----- Dashboard data queries -----

export async function getAiVisibilityStats(businessId: string) {
  // Get latest scan
  const latestScan = await prisma.llmCitationScan.findFirst({
    where: { businessId, status: { in: ["completed", "partial"] } },
    orderBy: { completedAt: "desc" },
  });

  // Get citation counts from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const recentCitations = await prisma.llmCitation.findMany({
    where: {
      businessId,
      createdAt: { gte: thirtyDaysAgo },
      cited: true,
    },
  });

  // Total unique keywords tracked
  const keywordsTracked = await prisma.llmCitation.findMany({
    where: {
      businessId,
      createdAt: { gte: thirtyDaysAgo },
    },
    distinct: ["keyword"],
    select: { keyword: true },
  });

  // Content LLM readiness
  const contentScores = await prisma.contentLlmScore.findMany({
    where: { businessId },
    select: { overallScore: true },
  });

  const totalContent = contentScores.length;
  const llmReadyContent = contentScores.filter((s) => s.overallScore >= 7).length;

  // Calculate AI Visibility Score: % of keyword-provider combinations that got cited
  const totalCombinations = await prisma.llmCitation.count({
    where: {
      businessId,
      createdAt: { gte: thirtyDaysAgo },
    },
  });
  const citedCombinations = recentCitations.length;
  const visibilityScore =
    totalCombinations > 0
      ? Math.round((citedCombinations / totalCombinations) * 100)
      : 0;

  return {
    visibilityScore,
    totalCitations: citedCombinations,
    keywordsTracked: keywordsTracked.length,
    contentLlmReady: llmReadyContent,
    totalContent,
    lastScan: latestScan
      ? {
          completedAt: latestScan.completedAt,
          status: latestScan.status,
          keywordsScanned: latestScan.keywordsScanned,
        }
      : null,
  };
}

export async function getCitationTracker(businessId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Get latest citations per keyword per provider
  const citations = await prisma.llmCitation.findMany({
    where: {
      businessId,
      createdAt: { gte: thirtyDaysAgo },
    },
    orderBy: { createdAt: "desc" },
  });

  // Group by keyword and get latest result per provider
  const keywordMap = new Map<
    string,
    {
      keyword: string;
      query: string;
      queryType: CitationQueryType;
      providers: Record<
        string,
        {
          cited: boolean;
          citedCount: number;
          totalRuns: number;
          citedUrl: string | null;
          citationContext: string | null;
        }
      >;
      competitorsCited: Array<{ domain: string }>;
      route: string | null;
    }
  >();

  for (const c of citations) {
    if (!keywordMap.has(c.keyword)) {
      keywordMap.set(c.keyword, {
        keyword: c.keyword,
        query: c.query,
        queryType: getCitationQueryType(c.keyword),
        providers: {},
        competitorsCited: [],
        route: null,
      });
    }
    const entry = keywordMap.get(c.keyword)!;
    if (!entry.providers[c.llmProvider]) {
      entry.providers[c.llmProvider] = {
        cited: c.cited,
        citedCount: c.citedCount,
        totalRuns: c.totalRuns,
        citedUrl: c.citedUrl,
        citationContext: c.citationContext,
      };
    }
    // Merge competitors
    const competitors = (c.competitorsCited as any[]) || [];
    for (const comp of competitors) {
      if (!entry.competitorsCited.some((e) => e.domain === comp.domain)) {
        entry.competitorsCited.push({ domain: comp.domain });
      }
    }
  }

  return Array.from(keywordMap.values());
}

/**
 * Get trend data for a keyword (7-day rolling average)
 */
export async function getCitationTrend(
  businessId: string,
  keyword: string,
  days: number = 30,
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const citations = await prisma.llmCitation.findMany({
    where: {
      businessId,
      keyword,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      cited: true,
      citedCount: true,
      totalRuns: true,
      llmProvider: true,
    },
  });

  // Group by date
  const dailyData = new Map<string, { cited: number; total: number }>();
  for (const c of citations) {
    const day = c.createdAt.toISOString().slice(0, 10);
    const existing = dailyData.get(day) || { cited: 0, total: 0 };
    existing.cited += c.citedCount;
    existing.total += c.totalRuns;
    dailyData.set(day, existing);
  }

  // Convert to array with 7-day rolling average
  const sortedDays = Array.from(dailyData.entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );

  return sortedDays.map(([date, data], idx) => {
    // 7-day rolling average
    const windowStart = Math.max(0, idx - 6);
    const window = sortedDays.slice(windowStart, idx + 1);
    const avgCited =
      window.reduce((sum, [, d]) => sum + d.cited, 0) /
      Math.max(window.reduce((sum, [, d]) => sum + d.total, 0), 1);

    return {
      date,
      citedCount: data.cited,
      totalRuns: data.total,
      rollingAverage: Math.round(avgCited * 100),
    };
  });
}

// ----- Citation context for blog generation -----

export interface CitationContext {
  hasCitationHistory: boolean;
  overallCitationRate: number;
  competitors: Array<{ domain: string }>;
  promptGuidance: string;
}

const CITATION_CONTEXT_TTL_MS = 60 * 60 * 1000; // 1h — bounded staleness during blog batches.

/**
 * Get citation context for a keyword to inform blog generation.
 * Returns structured data + a computed prompt guidance string.
 *
 * Cached for 1h per (businessId, normalized keyword). This matters for
 * cron-driven blog batches that generate many posts in quick succession —
 * before the cache, every generation re-queried the citation table and
 * recomputed the prompt string identically.
 */
export async function getCitationContextForKeyword(
  businessId: string,
  keyword: string,
): Promise<CitationContext> {
  const cacheKey = `ai-viz-ctx:${businessId}:${normalizeQueryForDedup(keyword) || keyword.toLowerCase()}`;
  return withCache(
    cacheKey,
    () => computeCitationContextForKeyword(businessId, keyword),
    { ttlMs: CITATION_CONTEXT_TTL_MS },
  );
}

async function computeCitationContextForKeyword(
  businessId: string,
  keyword: string,
): Promise<CitationContext> {
  const citations = await prisma.llmCitation.findMany({
    where: { businessId, keyword },
    orderBy: { createdAt: "desc" },
    take: 10, // Latest results across providers
  });

  if (citations.length === 0) {
    return {
      hasCitationHistory: false,
      overallCitationRate: 0,
      competitors: [],
      promptGuidance:
        "No citation history for this keyword yet. Apply general LLM-readiness best practices: clear opening definition, FAQ section, authoritative sources.",
    };
  }

  // Calculate overall citation rate
  const totalCited = citations.reduce((sum, c) => sum + c.citedCount, 0);
  const totalRuns = citations.reduce((sum, c) => sum + c.totalRuns, 0);
  const overallCitationRate = totalRuns > 0 ? totalCited / totalRuns : 0;

  // Collect unique competitor domains
  const competitorSet = new Map<string, boolean>();
  for (const c of citations) {
    const comps = (c.competitorsCited as any[]) || [];
    for (const comp of comps) {
      if (comp.domain && !competitorSet.has(comp.domain)) {
        competitorSet.set(comp.domain, true);
      }
    }
  }
  const competitors = Array.from(competitorSet.keys()).map((d) => ({ domain: d }));

  // Compute prompt guidance
  let promptGuidance: string;
  const pct = Math.round(overallCitationRate * 100);

  if (overallCitationRate > 0.5) {
    promptGuidance = `This keyword is ALREADY cited by AI (${pct}% citation rate). MAINTAIN existing citation signals. Keep: clear definitional opening, FAQ structure, authoritative sources. Do not change what is working.`;
  } else if (overallCitationRate > 0) {
    promptGuidance = `This keyword has PARTIAL AI citation (${pct}% rate). AMPLIFY citation signals. Strengthen: concise definitional opening paragraph, comprehensive FAQ section, 3+ authoritative source citations, structured data.`;
  } else if (competitors.length > 0) {
    const domains = competitors.slice(0, 5).map((c) => c.domain).join(", ");
    promptGuidance = `This keyword has ZERO citations but competitors [${domains}] ARE cited by AI. AGGRESSIVELY optimize for LLM visibility: lead with a quotable definitional paragraph, include comprehensive FAQ section, cite 3+ authoritative external sources, use clear structured headings that match how people ask questions.`;
  } else {
    promptGuidance =
      "No citations found for this keyword from any source. Apply strong LLM-readiness patterns: definitional opening, FAQ section, source citations.";
  }

  return {
    hasCitationHistory: true,
    overallCitationRate,
    competitors,
    promptGuidance,
  };
}
