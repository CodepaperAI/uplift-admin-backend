import { prisma } from "../config/db.config";
import {
  LLM_MODELS,
  createGPT5MiniModel,
  createGPT54NanoModel,
} from "../config/llm.config";
import { getAuthHeader } from "../utils/dataforseo.utils";
import { LlmQueryDifficulty, LlmQuerySource } from "@prisma/client";
import {
  buildDomainMatchSet,
  isOwnDomain,
} from "../utils/citation-domain-matcher";
import {
  dedupStringsByNormalized,
  normalizeQueryForDedup,
} from "../utils/query-dedup.utils";
import { computeAuthorityWeightedDifficulty } from "./competitor-authority.service";
import { getShareOfVoice } from "./share-of-voice.service";
import {
  recordLlmUsageEvent,
  recordLlmUsageFromLangChainMessage,
} from "./llm-usage.service";

/**
 * LLM Query Discovery Service
 *
 * Discovers keywords a business can rank on in AI answers by:
 * 1. Expanding business services into candidate questions via GPT-5 mini
 * 2. Fetching People Also Ask (PAA) data from DataForSEO
 * 3. Probing ChatGPT + Gemini + Perplexity to assess competition
 * 4. Rating difficulty (EASY/MEDIUM/HARD) based on competitor count
 * 5. Storing results in LlmQueryDiscovery table
 */

// ----- Step 1: Generate candidate keywords -----

async function generateCandidateQueries(
  businessName: string,
  businessType: string,
  services: string[],
  location?: string,
  usageContext?: AiVisibilityDiscoveryUsageContext,
): Promise<string[]> {
  const model = createGPT5MiniModel();

  const serviceList = services.slice(0, 10).join(", ");
  const locationCtx = location ? ` in ${location}` : "";

  const response = await model.invoke([
    {
      role: "system",
      content:
        "You generate realistic questions that people would ask AI chatbots (ChatGPT, Gemini, Perplexity) about a specific type of business. Output ONLY a JSON array of strings, nothing else.",
    },
    {
      role: "user",
      content: `Generate 30 questions that real people would ask AI chatbots about "${businessType}" businesses${locationCtx}.

Business: ${businessName}
Services: ${serviceList}

Include a mix of:
- "What is the best..." questions
- "How to..." questions
- "How much does..." questions
- "Do I need..." questions
- Comparison questions ("X vs Y")
- Local questions ("... in [city]")
- Problem/solution questions ("My [thing] is broken, what should I do?")

Output ONLY a JSON array of question strings. No explanation.`,
    },
  ]);
  await recordLlmUsageFromLangChainMessage(response, {
    purpose: "ai_visibility",
    provider: "openai",
    businessId: usageContext?.businessId ?? null,
    correlationId: usageContext?.jobId ?? null,
    modelFallback: LLM_MODELS.GPT5_MINI,
    metadata: {
      usageType: "ai_visibility_query_candidate_generation",
      source: usageContext?.source ?? null,
      periodKey: usageContext?.periodKey ?? null,
      jobId: usageContext?.jobId ?? null,
    },
  });

  const text = typeof response.content === "string" ? response.content : "";

  try {
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((q: any) => typeof q === "string" && q.length > 10).slice(0, 30);
      }
    }
  } catch {
    // Fallback: split by newlines
    return text
      .split("\n")
      .map((l) => l.replace(/^\d+[\.\)]\s*/, "").replace(/^["'-]\s*/, "").trim())
      .filter((l) => l.length > 10 && l.includes("?"))
      .slice(0, 30);
  }

  return [];
}

// ----- Step 2: Fetch PAA data from DataForSEO -----

async function fetchPAAQueries(
  seedKeywords: string[],
  locationCode?: number,
): Promise<string[]> {
  const authHeader = getAuthHeader();
  if (!authHeader) {
    console.warn("⚠️ DataForSEO not configured, skipping PAA fetch");
    return [];
  }

  const queries: string[] = [];

  // Batch up to 5 seed keywords to stay within API limits
  for (const keyword of seedKeywords.slice(0, 5)) {
    try {
      const response = await fetch(
        "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
        {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([
            {
              keyword,
              location_code: locationCode || 2840, // US default
              language_code: "en",
              depth: 10,
            },
          ]),
        },
      );

      if (!response.ok) continue;

      const data = (await response.json()) as any;
      const items = data?.tasks?.[0]?.result?.[0]?.items || [];

      for (const item of items) {
        if (item.type === "people_also_ask" && item.items) {
          for (const paa of item.items) {
            if (paa.title) queries.push(paa.title);
          }
        }
      }
    } catch (error: any) {
      console.warn(`⚠️ PAA fetch failed for "${keyword}": ${error.message}`);
    }
  }

  return [...new Set(queries)]; // Deduplicate
}

// ----- Step 3: Probe LLMs for competition -----

interface ProbeResult {
  query: string;
  competitorCount: number;
  competitorDomains: string[];
  hasStrongCitation: boolean; // Any response included URLs
}

type AiVisibilityDiscoveryUsageContext = {
  businessId: string;
  jobId?: string | null;
  source?: string | null;
  periodKey?: string | null;
};

async function probeLlmCompetition(
  query: string,
  customerDomain: string,
  usageContext: AiVisibilityDiscoveryUsageContext,
): Promise<ProbeResult> {
  const competitorDomains = new Set<string>();
  let hasStrongCitation = false;

  // Use the shared domain matcher so www/apex handling is consistent
  // with the citation-detection path.
  const matchSet = buildDomainMatchSet(customerDomain);

  // Probe ChatGPT
  try {
    const model = createGPT54NanoModel();
    const response = await model.invoke([
      {
        role: "system",
        content: "Answer the question thoroughly. Include specific website URLs and sources when relevant.",
      },
      { role: "user", content: query },
    ]);
    await recordLlmUsageFromLangChainMessage(response, {
      purpose: "ai_visibility",
      provider: "openai",
      businessId: usageContext.businessId,
      correlationId: usageContext.jobId ?? null,
      modelFallback: LLM_MODELS.GPT54_NANO,
      metadata: {
        usageType: "ai_visibility_query_probe",
        provider: "CHATGPT",
        source: usageContext.source ?? null,
        periodKey: usageContext.periodKey ?? null,
        jobId: usageContext.jobId ?? null,
        query: query.substring(0, 500),
      },
    });
    const text = typeof response.content === "string" ? response.content : "";
    extractCompetitors(text, matchSet, competitorDomains);
    if (text.match(/https?:\/\//)) hasStrongCitation = true;
  } catch {}

  // Probe Gemini
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: query }] }],
            systemInstruction: {
              parts: [{ text: "Answer thoroughly. Include specific website URLs and sources when relevant." }],
            },
          }),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as any;
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
            usageType: "ai_visibility_query_probe",
            provider: "GEMINI",
            source: usageContext.source ?? null,
            periodKey: usageContext.periodKey ?? null,
            jobId: usageContext.jobId ?? null,
            query: query.substring(0, 500),
            googleUsageMetadata: usage ?? null,
          },
        });
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        extractCompetitors(text, matchSet, competitorDomains);
        if (text.match(/https?:\/\//)) hasStrongCitation = true;
      }
    }
  } catch {}

  // Probe Perplexity (if configured)
  try {
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (pplxKey) {
      const response = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pplxKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [
            { role: "system", content: "Answer thoroughly with specific sources and URLs." },
            { role: "user", content: query },
          ],
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as any;
        const text = data.choices?.[0]?.message?.content || "";
        extractCompetitors(text, matchSet, competitorDomains);
        if (text.match(/https?:\/\//)) hasStrongCitation = true;
      }
    }
  } catch {}

  return {
    query,
    competitorCount: competitorDomains.size,
    competitorDomains: Array.from(competitorDomains),
    hasStrongCitation,
  };
}

const DISCOVERY_COMPETITOR_EXCLUDE_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "wikipedia.org",
  "en.wikipedia.org",
  "youtube.com",
  "www.youtube.com",
]);

function extractCompetitors(
  text: string,
  matchSet: ReturnType<typeof buildDomainMatchSet>,
  competitors: Set<string>,
) {
  const urlRegex = /https?:\/\/[^\s)>\]"']+/gi;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    if (isOwnDomain(url, matchSet)) continue;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      if (DISCOVERY_COMPETITOR_EXCLUDE_HOSTS.has(hostname)) continue;
      competitors.add(hostname);
    } catch {}
  }
}

// ----- Step 4: Rate difficulty -----
//
// Difficulty is authority-weighted — see competitor-authority.service.ts.
// High-rank domains (wikipedia.org, yelp.com, etc.) weigh more than raw
// count, so 2 authorities can outrank a crowd of low-rank blogs.

// ----- Main discovery orchestrator -----

export interface DiscoveryOptions {
  businessId: string;
  maxCandidates?: number;
  jobId?: string;
  source?: string;
  periodKey?: string | null;
}

export async function runLlmQueryDiscovery(options: DiscoveryOptions) {
  const { businessId, maxCandidates = 30 } = options;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      businessName: true,
      businessType: true,
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
  // Pinned non-null reference so closures (like priorityFor) keep the
  // narrowed type without needing a non-null assertion at each use.
  const businessRecord = business;

  const customerDomain = businessRecord.businessWebsiteUrl;
  const services = businessRecord.selectedServices.length > 0
    ? businessRecord.selectedServices
    : [businessRecord.businessType];

  const location = [businessRecord.businessCity, businessRecord.businessState]
    .filter(Boolean)
    .join(", ");

  console.log(`🔍 LLM Query Discovery: Starting for "${businessRecord.businessName}"`);

  // Step 1: Generate candidates via GPT-5 mini
  const llmCandidates = await generateCandidateQueries(
    businessRecord.businessName,
    businessRecord.businessType,
    services,
    location || undefined,
    {
      businessId,
      jobId: options.jobId,
      source: options.source,
      periodKey: options.periodKey,
    },
  );
  console.log(`  → ${llmCandidates.length} candidates from LLM expansion`);

  // Step 2: Fetch PAA questions
  const seedKeywords = services.slice(0, 5).map(
    (s) => `${s}${location ? ` ${location}` : ""}`,
  );
  const paaQueries = await fetchPAAQueries(seedKeywords);
  console.log(`  → ${paaQueries.length} candidates from PAA`);

  // Combine and deduplicate using structural normalization so that
  // "How much does plumbing cost?" and "How much for plumbing?" don't
  // both end up as separate candidate rows.
  const allCandidates = dedupStringsByNormalized([
    ...llmCandidates,
    ...paaQueries,
  ]).slice(0, maxCandidates);
  console.log(`  → ${allCandidates.length} unique candidates to probe`);

  // Step 3: Probe LLMs for competition (batches of 5)
  const results: Array<ProbeResult & { source: LlmQuerySource }> = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < allCandidates.length; i += BATCH_SIZE) {
    const batch = allCandidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((q) =>
        probeLlmCompetition(q, customerDomain, {
          businessId,
          jobId: options.jobId,
          source: options.source,
          periodKey: options.periodKey,
        }),
      ),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const candidate = allCandidates[i + j]!;
      const source: LlmQuerySource = llmCandidates.includes(candidate)
        ? "LLM_EXPANSION"
        : "PAA";
      results.push({ ...batchResults[j]!, source });
    }
  }

  // Resolve authority-weighted difficulty for every candidate up front so
  // our final counts are consistent with what we store.
  const difficulties: LlmQueryDifficulty[] = await Promise.all(
    results.map((r) => computeAuthorityWeightedDifficulty(r.competitorDomains)),
  );

  // Step 5 (Phase 2): compute a priority score per candidate.
  //
  //   priority = 0.4 × volumeNorm     (proxy; 1.0 until DataForSEO hooks up)
  //            + 0.3 × (1 - difficultyNorm)   (easier = higher)
  //            + 0.3 × sovGap          (where we trail most)
  //
  // Values normalized to [0,1]. This lets the dashboard surface the
  // highest-leverage "write this next" queries without shipping a new
  // tracking system.
  let sovBySeedKeyword = new Map<string, number>();
  try {
    const sov = await getShareOfVoice(businessId, { window: "30d" });
    for (const kw of sov.perKeyword) {
      sovBySeedKeyword.set(kw.keyword.toLowerCase(), kw.yourPct);
    }
  } catch (err) {
    // SoV is optional — a fresh business with no scans yet will fail here.
    // Fall back to neutral (50%) for every keyword.
    console.warn(
      "[llm-query-discovery] SoV unavailable for priority scoring:",
      (err as Error).message,
    );
  }

  function priorityFor(
    candidateIdx: number,
    difficulty: LlmQueryDifficulty,
  ): number {
    // Volume proxy: we don't have DataForSEO volume for discovered queries
    // yet, so we treat LLM expansion at 0.5 and PAA at 0.7 (PAA questions
    // tend to carry real traffic — they came from the actual SERP).
    const result = results[candidateIdx]!;
    const volumeNorm = result.source === "PAA" ? 0.7 : 0.5;

    const difficultyNorm =
      difficulty === "EASY" ? 0.1 : difficulty === "MEDIUM" ? 0.5 : 0.9;

    // SoV gap: 1.0 means we have 0% share, 0.0 means we have 100%.
    // Neutral 0.5 when no signal is available.
    const seedKeyword = (
      seedKeywords[0] || businessRecord.businessType
    ).toLowerCase();
    const yourPct = sovBySeedKeyword.get(seedKeyword);
    const sovGap = typeof yourPct === "number" ? 1 - yourPct / 100 : 0.5;

    const score =
      0.4 * volumeNorm + 0.3 * (1 - difficultyNorm) + 0.3 * sovGap;
    // Clamp defensively.
    return Math.max(0, Math.min(1, Number(score.toFixed(4))));
  }

  // Load existing discoveries once and index by normalized query so we can
  // upsert by near-match (catches re-discoveries of the same question with
  // slightly different phrasing without creating duplicate rows).
  const existingDiscoveries = await prisma.llmQueryDiscovery.findMany({
    where: { businessId },
    select: { id: true, discoveredQuery: true },
  });
  const existingIdByNormalized = new Map<string, string>();
  for (const row of existingDiscoveries) {
    const key = normalizeQueryForDedup(row.discoveredQuery);
    if (key && !existingIdByNormalized.has(key)) {
      existingIdByNormalized.set(key, row.id);
    }
  }

  let stored = 0;
  const scoredAt = new Date();
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const difficulty = difficulties[i]!;
    const priorityScore = priorityFor(i, difficulty);
    const normalizedKey = normalizeQueryForDedup(result.query);
    const existingId = normalizedKey
      ? existingIdByNormalized.get(normalizedKey)
      : undefined;

    await prisma.llmQueryDiscovery.upsert({
      where: { id: existingId ?? crypto.randomUUID() },
      create: {
        businessId,
        keyword: seedKeywords[0] || businessRecord.businessType,
        discoveredQuery: result.query,
        source: result.source,
        difficulty,
        category: categorizeQuery(result.query),
        priorityScore,
        lastScoredAt: scoredAt,
      },
      update: {
        difficulty,
        priorityScore,
        lastScoredAt: scoredAt,
        updatedAt: new Date(),
      },
    });
    stored++;
  }

  const easy = difficulties.filter((d) => d === "EASY").length;
  const medium = difficulties.filter((d) => d === "MEDIUM").length;
  const hard = difficulties.filter((d) => d === "HARD").length;

  console.log(
    `✅ LLM Query Discovery: ${stored} queries stored (${easy} easy, ${medium} medium, ${hard} hard)`,
  );

  return {
    success: true,
    totalDiscovered: stored,
    easy,
    medium,
    hard,
  };
}

// Categorize query by type
function categorizeQuery(query: string): string {
  const q = query.toLowerCase();
  if (/^how (much|many)/.test(q) || /cost|price|charge/.test(q)) return "pricing";
  if (/^how to/.test(q) || /steps|guide|tutorial/.test(q)) return "how-to";
  if (/^what is|^what are|^what does/.test(q)) return "definition";
  if (/best|top|recommend/.test(q)) return "recommendation";
  if (/vs|versus|compared|difference/.test(q)) return "comparison";
  if (/near me|in \w+/.test(q)) return "local";
  if (/do i need|should i/.test(q)) return "decision";
  return "general";
}

// ----- Dashboard queries -----

export async function getDiscoveredQueries(businessId: string) {
  return prisma.llmQueryDiscovery.findMany({
    where: { businessId },
    // Highest priority first. Fall back to difficulty so queries that haven't
    // been scored yet (priorityScore=0) still sort by difficulty.
    orderBy: [
      { priorityScore: "desc" },
      { difficulty: "asc" },
      { createdAt: "desc" },
    ],
  });
}

/**
 * Add the top N un-targeted, high-priority discovered queries to the
 * content plan. Reuses `addOpportunityKeywordToPlan` so the monthly AI
 * keyword cap, near-duplicate detection, and publish-day scheduling are
 * all applied consistently with the single-keyword flow.
 *
 * Rows are marked `targeted=true` whether the plan call succeeds or is
 * skipped as a near-duplicate — either way the row is no longer an
 * "un-actioned" discovery.
 */
export async function generateTopDiscoveredQueries(
  businessId: string,
  userId: string,
  options: { limit?: number } = {},
): Promise<{
  added: number;
  skipped: number;
  queries: { id: string; query: string; added: boolean; message?: string }[];
}> {
  const limit = options.limit ?? 10;
  const rows = await prisma.llmQueryDiscovery.findMany({
    where: { businessId, targeted: false },
    orderBy: [
      { priorityScore: "desc" },
      { difficulty: "asc" },
      { createdAt: "desc" },
    ],
    take: limit,
  });

  if (rows.length === 0) {
    return { added: 0, skipped: 0, queries: [] };
  }

  const { addOpportunityKeywordToPlan } = await import(
    "./ai-keyword-opportunity.service"
  );

  let added = 0;
  let skipped = 0;
  const queries: {
    id: string;
    query: string;
    added: boolean;
    message?: string;
  }[] = [];

  for (const row of rows) {
    try {
      const result = await addOpportunityKeywordToPlan(
        businessId,
        userId,
        row.discoveredQuery,
      );
      if (result && (result as any).success === false) {
        queries.push({
          id: row.id,
          query: row.discoveredQuery,
          added: false,
          message: (result as any).message,
        });
        skipped++;
      } else {
        queries.push({ id: row.id, query: row.discoveredQuery, added: true });
        added++;
      }
    } catch (err) {
      console.error(
        `[llm-query-discovery] failed to add "${row.discoveredQuery}" to plan:`,
        (err as Error).message,
      );
      queries.push({
        id: row.id,
        query: row.discoveredQuery,
        added: false,
        message: (err as Error).message,
      });
      skipped++;
    }
  }

  // Mark ALL attempted rows as targeted so they stop surfacing in the
  // "top 10" bulk action — whether they were added or skipped as near-dupes.
  await prisma.llmQueryDiscovery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { targeted: true },
  });

  return { added, skipped, queries };
}
