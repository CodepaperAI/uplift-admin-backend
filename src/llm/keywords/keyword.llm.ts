import { Prisma } from "@prisma/client";
import type { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { prisma } from "../../config/db.config";
import {
  getGraphMaxToolRounds,
  getGraphRecursionLimit,
  getLLMForKeywords,
} from "../../config/llm.config";
import { CompetitorIntelligenceService } from "../../services/competitor-intelligence.service";
import { KeywordAllocationService } from "../../services/keyword-allocation.service";
import { SmartKeywordDiscoveryService } from "../../services/smart-keyword-discovery.service";
import {
  getKeywordSuggestionsWithMetrics,
  getKeywordsForDomainFromDataForSEO,
  getRelatedKeywordsWithDifficulty,
} from "../../utils/dataforseo.utils";
import {
  analyzeBusinessContext,
  type BusinessContextAnalysis,
} from "./business-context-analyzer";
import { generateGeoAwareKeywordIdeas } from "./geo-keyword-llm";
import {
  extractCoreOfferings,
  type CoreOfferings,
} from "./core-offerings-extractor";
import { shouldContinueWithGuards } from "../utils/graph-guard";
import {
  verifyKeyword,
  verifyKeywords,
  type KeywordVerificationResult,
} from "./keyword-verifier";
import { saveKeywordsToDb } from "./tools.keyword";
import { resolveEffectiveServices } from "../../utils/effective-services.utils";
import { savePlanKeywords } from "../../utils/plan-keyword-save.utils";
import { getKeywordLocations } from "../../utils/location.utils";
import { resolveDataForSEOKeywordTarget } from "../../utils/dataforseo-targeting.utils";
import {
  buildCanonicalBusinessAreas,
  buildSelectionMetadata,
  bucketDifficulty,
  canonicalizeBusinessAreaName,
  deriveSemanticCluster,
  evaluateKeywordCandidateQuality,
  inferKeywordIntent,
  mapKeywordToBusinessArea,
  mapKeywordToService,
  mergeKeywordCandidate,
  normalizeKeywordText,
  selectKeywordsDeterministically,
  type BusinessAreaGroup,
  type CanonicalBusinessArea,
  type DifficultyBucket,
  type KeywordCandidate,
  type KeywordIntentBucket,
  type KeywordSelectionSummary,
  type KeywordSourceType,
  type KeywordTrendPoint,
} from "../../utils/dataforseo-keyword-plan.utils";
import {
  KEYWORD_CANDIDATE_GROUP_LIMIT,
  KEYWORD_CANDIDATE_POOL_LIMIT,
  capKeywordCandidates,
  chunkArray,
  mapWithConcurrency,
} from "../../utils/keyword-generation.utils";

const tools: StructuredToolInterface[] = [saveKeywordsToDb];
const toolNode = new ToolNode(tools);

// GPT-5 mini can exceed one minute when classifying a full 35-keyword batch.
// Keep a hard bound, but allow enough time for the structured result before
// falling back to deterministic classification.
const KEYWORD_LLM_TIMEOUT_DEFAULT_MS = 120_000;

function keywordLlmTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KEYWORD_LLM_TIMEOUT_MS ?? String(KEYWORD_LLM_TIMEOUT_DEFAULT_MS),
    10,
  );
  return Number.isFinite(configured)
    ? Math.min(180_000, Math.max(15_000, configured))
    : KEYWORD_LLM_TIMEOUT_DEFAULT_MS;
}

function keywordLlmInvocationConfig() {
  return { signal: AbortSignal.timeout(keywordLlmTimeoutMs()) };
}

export const keywordLLM = getLLMForKeywords().bindTools(tools);
const keywordAnalysisLLM = getLLMForKeywords();

export type KeywordCandidateCollectionResult = {
  businessContext: BusinessContextAnalysis;
  coreOfferings: CoreOfferings;
  businessAreas: CanonicalBusinessArea[];
  candidateSourceCounts: Record<string, number>;
  previousKeywordsArray: Array<{ keyword: string; publishDate?: string | Date | null }>;
  existingKeywordTexts: string[];
  existingTopics: string[];
  businessKeywordsFromOnboarding: string[];
  takenDates: string[];
  primaryServices: string[];
  focusAreas: string[];
  expandedSubOfferings: string[];
  technologies: string[];
  keywordsForLLM: KeywordCandidate[];
  counts: {
    raw: number;
    filtered: number;
    preFiltered: number;
    capped: number;
  };
  locationScope: string;
  /** GEO-KW-6: geo context for selection + plan distribution. Null if business isn't GEO-eligible or context build failed. */
  geoContext?: import("../../utils/geo-keyword-context").GeoKeywordContext | null;
};

export type KeywordCandidateSelectionResult = {
  selectedCandidates: KeywordCandidate[];
  fallbackCandidates: KeywordCandidate[];
  quotaSummary: KeywordSelectionSummary;
  counts: {
    classificationBatches: number;
    areaFiltered: number;
    retained: number;
    selected: number;
    selectedByLlm: number;
  };
};

export type KeywordPlanDraftItem = {
  keyword: string;
  publishDate: string;
  publishTime: string;
  keywordDiffculty: string;
  keywordSearchVolume: string;
  userId: string;
  businessId: string | null;
  keywordCategory: string | null;
  keywordIntent: string | null;
  keywordSource: string | null;
  difficultyBucket: DifficultyBucket | null;
  selectionMetadata: Record<string, unknown> | null;
  keywordCpc: number | null;
  keywordCompetition: number | null;
  keywordTrend: KeywordTrendPoint[] | null;
  keywordMonthlySearches: number | null;
  keywordClicks: number | null;
  keywordImpressions: number | null;
  keywordCTR: number | null;
  keywordDataUpdatedAt: string | null;
  clusterId?: string | null;
  clusterRole?: string | null;
};

export type KeywordPlanBuildResult = {
  keywordPlanToSave: KeywordPlanDraftItem[];
  counts: {
    verified: number;
    planned: number;
    deduped: number;
  };
};

function shouldRejectLocationKeywordForProductBusiness(
  keyword: string,
  businessContext: BusinessContextAnalysis,
): boolean {
  if (
    businessContext.businessModel.isLocationDependent ||
    businessContext.businessModel.type !== "product"
  ) {
    return false;
  }

  const locationPatterns = [
    /in \w+$/,
    /near me$/,
    /\w+ \w+ area$/,
    /\w+ \w+ city$/,
    /in \w+ \w+$/,
    /\w+ \w+ location$/,
  ];

  return locationPatterns.some((pattern) => pattern.test(keyword.toLowerCase()));
}

function scoreAndSortKeywordCandidates(params: {
  candidates: KeywordCandidate[];
  business: any;
  businessContext: BusinessContextAnalysis;
  coreServices: ReturnType<typeof resolveEffectiveServices>;
  minSearchVolume?: number;
  maxDifficulty?: number;
  maxWordCount?: number;
}) {
  const {
    candidates,
    business,
    businessContext,
    coreServices,
    minSearchVolume = 10,
    maxDifficulty = 90,
    maxWordCount = 8,
  } = params;

  return candidates
    .filter((candidate) => {
      const volume = candidate.searchVolume ?? 0;
      // DataForSEO can return 0 for very easy keywords; keep 0 as valid.
      const difficulty = candidate.difficulty ?? 100;
      const wordCount = candidate.keyword.split(" ").length;

      if (
        shouldRejectLocationKeywordForProductBusiness(
          candidate.keyword,
          businessContext,
        )
      ) {
        return false;
      }

      return (
        volume >= minSearchVolume &&
        difficulty <= maxDifficulty &&
        wordCount >= 2 &&
        wordCount <= maxWordCount
      );
    })
    .map((candidate) => {
      const trendGrowth = calculateTrendGrowth(candidate.trend || []);
      const relevanceScore = calculateRelevanceScore(
        candidate.keyword,
        business,
        coreServices,
      );
      const baseScore = calculateKeywordScore(
        candidate,
        business,
        trendGrowth,
        coreServices,
      );
      const trafficPotential = calculateTrafficPotential(
        candidate,
        businessContext,
      );

      return {
        ...candidate,
        score: baseScore,
        trendGrowth,
        relevanceScore,
        trafficPotential,
      };
    })
    .sort((a, b) => {
      if (Math.abs((a.trafficPotential ?? 0) - (b.trafficPotential ?? 0)) > 0.1) {
        return (b.trafficPotential ?? 0) - (a.trafficPotential ?? 0);
      }
      if (Math.abs((a.relevanceScore ?? 0) - (b.relevanceScore ?? 0)) > 0.3) {
        return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
      }
      return (b.score ?? 0) - (a.score ?? 0);
    });
}

function compactKeywordPart(value: string | null | undefined): string | null {
  const cleaned =
    typeof value === "string"
      ? value
          .replace(/\s+/g, " ")
          .replace(/\bservices?\b$/i, "")
          .trim()
      : "";
  return cleaned.length > 1 ? cleaned : null;
}

function uniqueKeywordParts(values: Array<string | null | undefined>, limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const cleaned = compactKeywordPart(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }

  return out;
}

function buildEstimatedKeywordFallbackPool(params: {
  business: any;
  businessContext: BusinessContextAnalysis;
  primaryServices: string[];
  focusAreas: string[];
  expandedSubOfferings: string[];
  locationScope: string;
  limit?: number;
}): Array<{
  keyword: string;
  searchVolume: number;
  difficulty: number;
  monthlySearches: number;
  cpc: number;
  competition: number;
}> {
  const {
    business,
    businessContext,
    primaryServices,
    focusAreas,
    expandedSubOfferings,
    locationScope,
    limit = 90,
  } = params;
  const areas = uniqueKeywordParts(
    [
      ...primaryServices,
      ...businessContext.services.primary,
      ...focusAreas,
      ...expandedSubOfferings,
      ...(businessContext.market.industry.subVertical || []),
      businessContext.market.industry.vertical,
      business.businessType,
    ],
    18,
  );
  const city = compactKeywordPart(
    business.businessCity || businessContext.market.geographic.primary,
  );
  const region = compactKeywordPart(business.businessState || business.businessCountry);
  const localSuffixes = uniqueKeywordParts([city, region, locationScope], 3);
  const templates = [
    (area: string, place?: string) => `${area} guide${place ? ` in ${place}` : ""}`,
    (area: string, place?: string) => `how to choose ${area}${place ? ` in ${place}` : ""}`,
    (area: string, place?: string) => `${area} cost${place ? ` in ${place}` : ""}`,
    (area: string, place?: string) => `${area} checklist${place ? ` for ${place}` : ""}`,
    (area: string, place?: string) => `questions to ask ${area}${place ? ` in ${place}` : ""}`,
    (area: string, place?: string) => `${area} process${place ? ` in ${place}` : ""}`,
    (area: string) => `what to know about ${area}`,
    (area: string) => `${area} mistakes to avoid`,
  ];
  const candidates: Array<{
    keyword: string;
    searchVolume: number;
    difficulty: number;
    monthlySearches: number;
    cpc: number;
    competition: number;
  }> = [];
  const seen = new Set<string>();

  for (const area of areas) {
    const places = localSuffixes.length > 0 ? localSuffixes : [undefined];
    for (const place of places) {
      for (const template of templates) {
        const keyword = template(area, place)
          .replace(/\s+/g, " ")
          .replace(/\s+([?.!,])/g, "$1")
          .trim()
          .toLowerCase();
        const wordCount = keyword.split(" ").length;
        if (wordCount < 2 || wordCount > 10 || seen.has(keyword)) {
          continue;
        }

        const index = candidates.length;
        const isLocal = Boolean(place && city && place.toLowerCase() === city.toLowerCase());
        const searchVolume = Math.max(
          20,
          Math.round((isLocal ? 170 : 110) - Math.min(index, 60) * 1.25),
        );
        const difficulty = Math.min(78, 32 + (index % 9) * 5);
        seen.add(keyword);
        candidates.push({
          keyword,
          searchVolume,
          difficulty,
          monthlySearches: searchVolume,
          cpc: 0,
          competition: difficulty / 100,
        });

        if (candidates.length >= limit) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

function buildTakenDateStrings(
  existingPlanData: Array<{ publishDate: Date | string | null }>,
): string[] {
  const takenDates = new Set<string>();

  for (const keyword of existingPlanData) {
    if (!keyword.publishDate) {
      continue;
    }

    const value = keyword.publishDate;
    const date =
      value instanceof Date
        ? value
        : typeof value === "string"
          ? new Date(value)
          : null;
    if (!date || Number.isNaN(date.getTime())) {
      continue;
    }

    const dateString = date.toISOString().split("T")[0];
    if (dateString) {
      takenDates.add(dateString);
    }
  }

  return Array.from(takenDates);
}

async function verifyKeywordCandidatesInBatches(params: {
  candidates: KeywordCandidate[];
  business: any;
  businessContext: BusinessContextAnalysis;
  coreOfferings: CoreOfferings;
}) {
  const resultMap = new Map<string, KeywordVerificationResult>();

  for (const batch of chunkArray(params.candidates, 5)) {
    const batchResults = await verifyKeywords(
      batch.map((candidate) => candidate.keyword),
      params.business,
      params.businessContext,
      params.coreOfferings,
    );

    for (const result of batchResults) {
      resultMap.set(normalizeKeywordText(result.keyword), result);
    }
  }

  return resultMap;
}

export async function collectKeywordCandidatesForPlan(params: {
  business: any;
  userId: string;
  businessId: string | null;
  isPrimary: boolean;
  lastKeywords: Array<{ keyword: string; publishDate?: Date | string | null }>;
  isTopUp?: boolean;
}) {
  const { business, userId, businessId, isPrimary, lastKeywords, isTopUp = false } = params;

  console.log(
    `🧠 [KeywordGeneration] Collecting candidates for business ${businessId ?? "unknown"}`,
  );

  const businessContext = await analyzeBusinessContext(business);
  const coreOfferings = await extractCoreOfferings(business);
  const coreServices = resolveEffectiveServices(business);

  const topLevelServices: string[] =
    coreServices?.topLevel || businessContext.services.primary || [];
  const subOfferings: string[] = coreServices?.subOfferings || [];

  let technologies: string[] = [];
  if (businessId) {
    const serviceTaxonomies = await prisma.serviceTaxonomy.findMany({
      where: { businessId },
      select: { technologies: true },
    });
    technologies = serviceTaxonomies.flatMap(
      (taxonomy) => taxonomy.technologies || [],
    );
  }

  const techStack = business.websiteAnalysis?.techStack || business.techStack;
  if (techStack) {
    const techStackTechnologies = [
      ...(techStack.frontend || []),
      ...(techStack.backend || []),
      ...(techStack.database || []),
      ...(techStack.automation || []),
    ];
    technologies = [...technologies, ...techStackTechnologies];
  }

  technologies = Array.from(new Set(technologies));
  const expandedSubOfferings = [...subOfferings, ...technologies];
  const realServices = [...topLevelServices, ...expandedSubOfferings];

  const smartDiscovery = new SmartKeywordDiscoveryService();
  const keywordAllocation = new KeywordAllocationService();
  const dataForSEOTarget = resolveDataForSEOKeywordTarget(
    business,
    businessContext,
  );
  const locationScope = businessContext.businessModel.isLocationDependent
    ? keywordAllocation.getLocationScope(
        business.businessCity,
        business.businessCountry,
      )
    : dataForSEOTarget.locationCountry;
  const locationCode = dataForSEOTarget.locationCode;
  const dataForSEOLanguageCode = dataForSEOTarget.languageCode;
  console.log(
    `📍 [KeywordGeneration] DataForSEO target: ${dataForSEOTarget.reason} (code: ${locationCode})`,
  );

  const websiteUrl =
    business.businessWebsiteUrl || business.website || business.websiteURL;
  const domain = websiteUrl
    ? websiteUrl
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
    : null;

  const primaryServices = businessContext.services.primary;
  const focusAreas = businessContext.keywordStrategy.focusAreas;
  const candidateSourceCounts = new Map<string, number>();

  const incrementSourceCount = (sourceType: string) => {
    candidateSourceCounts.set(
      sourceType,
      (candidateSourceCounts.get(sourceType) ?? 0) + 1,
    );
  };

  const createCandidate = (
    keywordData: any,
    sourceType: KeywordSourceType,
    sourceLabel: string | null,
    originSeeds: string[],
    refinementRound: number,
    matchedServiceHint?: string | null,
  ): KeywordCandidate | null => {
    const keywordText =
      typeof keywordData.keyword === "string" ? keywordData.keyword.trim() : "";
    if (!keywordText) {
      return null;
    }

    const searchVolume =
      typeof keywordData.searchVolume === "number"
        ? keywordData.searchVolume
        : typeof keywordData.monthlySearches === "number"
          ? keywordData.monthlySearches
          : 0;
    const difficulty =
      typeof keywordData.difficulty === "number" ? keywordData.difficulty : 50;
    const competition =
      typeof keywordData.competition === "number"
        ? keywordData.competition
        : typeof keywordData.competition === "string"
          ? parseFloat(keywordData.competition)
          : null;

    return {
      keyword: keywordText,
      searchVolume,
      difficulty,
      cpc: typeof keywordData.cpc === "number" ? keywordData.cpc : null,
      competition:
        competition !== null && Number.isFinite(competition)
          ? competition
          : null,
      trend: Array.isArray(keywordData.trend) ? keywordData.trend : [],
      monthlySearches:
        typeof keywordData.monthlySearches === "number"
          ? keywordData.monthlySearches
          : null,
      clicks: typeof keywordData.clicks === "number" ? keywordData.clicks : null,
      impressions:
        typeof keywordData.impressions === "number"
          ? keywordData.impressions
          : null,
      ctr: typeof keywordData.ctr === "number" ? keywordData.ctr : null,
      sourceType,
      allSources: [sourceType],
      sourceLabel,
      originSeeds,
      matchedService:
        matchedServiceHint ||
        mapKeywordToService(keywordText, primaryServices, focusAreas),
      refinementRound,
    };
  };

  const upsertCandidate = (
    candidateMap: Map<string, KeywordCandidate>,
    candidate: KeywordCandidate | null,
  ) => {
    if (!candidate) {
      return;
    }

    const key = normalizeKeywordText(candidate.keyword);
    candidateMap.set(key, mergeKeywordCandidate(candidateMap.get(key), candidate));
    incrementSourceCount(candidate.sourceType);
  };

  // Start smart discovery as a non-blocking promise (runs in parallel with main sources)
  // Skip smart discovery on daily top-ups to save API costs (uses main keyword sources + cache instead)
  const smartDiscoveryEnabled = !!(domain && realServices.length > 0 && businessId && !isTopUp);
  if (isTopUp) {
    console.log("⏩ Skipping smart discovery for top-up (using main keyword sources + cache)");
  }
  // GEO-KW-4: build geo context for local expansion (reads cached data only, no Maps calls).
  let geoCtx: import("../../utils/geo-keyword-context").GeoKeywordContext | null = null;
  if (businessId) {
    try {
      const { buildGeoKeywordContext } = await import("../../utils/geo-keyword-context");
      geoCtx = await buildGeoKeywordContext(businessId);
    } catch (err) {
      console.warn("[KeywordGeneration] GEO context build failed, continuing without:", (err as Error).message);
    }
  }

  const smartDiscoveryPromise = smartDiscoveryEnabled
    ? smartDiscovery.generateUniqueKeywordOpportunities(
        businessId!,
        domain,
        realServices,
        business.businessType || "",
        locationCode,
        locationScope,
        200,
        dataForSEOLanguageCode,
        // GEO-KW-5: pass dynamic city name instead of hardcoded "toronto"
        businessContext.businessModel.isLocationDependent
          ? geoCtx?.primaryTarget?.city ?? business.businessCity ?? null
          : null,
      ).catch((error: any) => {
        console.warn(
          `⚠️ 6-step discovery failed: ${error.message}, continuing with standard flow`,
        );
        return [] as import("../../services/smart-keyword-discovery.service").KeywordOpportunity[];
      })
    : Promise.resolve([] as import("../../services/smart-keyword-discovery.service").KeywordOpportunity[]);

  const seedKeywords: string[] = [];
  seedKeywords.push(...businessContext.keywordStrategy.mustHaveKeywords);
  seedKeywords.push(...businessContext.services.primary);

  if (expandedSubOfferings.length > 0) {
    seedKeywords.push(...expandedSubOfferings.slice(0, 15));
  }

  if (businessContext.market.industry.vertical) {
    seedKeywords.push(businessContext.market.industry.vertical);
  }
  if (businessContext.market.industry.subVertical) {
    seedKeywords.push(...businessContext.market.industry.subVertical.slice(0, 3));
  }
  if (businessContext.market.customerSegment.primary) {
    seedKeywords.push(businessContext.market.customerSegment.primary);
  }
  if (business.businessName) {
    seedKeywords.push(business.businessName);
  }
  if (business.businessType) {
    seedKeywords.push(business.businessType);
  }
  if (business.businessDescription) {
    const descriptionWords = business.businessDescription
      .toLowerCase()
      .split(/\s+/)
      .filter((word: string) => word.length > 4)
      .slice(0, 5);
    seedKeywords.push(...descriptionWords);
  }

  const uniqueSeeds = Array.from(
    new Set(seedKeywords.map((seed) => seed.toLowerCase())),
  ).slice(0, 20);
  if (uniqueSeeds.length === 0) {
    uniqueSeeds.push(business.businessName || "business");
  }

  const keywordSourceRequests: Array<{
    sourceType: KeywordSourceType;
    sourceLabel: string | null;
    originSeeds: string[];
    matchedServiceHint?: string | null;
    refinementRound: number;
    promise: Promise<any[]>;
  }> = [];

  if (businessContext.services.primary.length > 0) {
    keywordSourceRequests.push({
      sourceType: "service_seed",
      sourceLabel: "primary_services",
      originSeeds: businessContext.services.primary.slice(0, 3),
      matchedServiceHint: null,
      refinementRound: 0,
      promise: getKeywordSuggestionsWithMetrics(
        businessContext.services.primary.slice(0, 3),
        locationCode,
        dataForSEOLanguageCode,
        50,
      ),
    });
  }

  const industryTerms = [
    businessContext.market.industry.vertical,
    ...(businessContext.market.industry.subVertical || []).slice(0, 2),
  ].filter(Boolean);
  if (industryTerms.length > 0) {
    keywordSourceRequests.push({
      sourceType: "service_seed",
      sourceLabel: "industry_terms",
      originSeeds: industryTerms,
      matchedServiceHint: null,
      refinementRound: 0,
      promise: getKeywordSuggestionsWithMetrics(
        industryTerms,
        locationCode,
        dataForSEOLanguageCode,
        50,
      ),
    });
  }

  if (
    businessContext.businessModel.isLocationDependent &&
    (businessContext.market.geographic.scope === "local" ||
      businessContext.market.geographic.scope === "regional")
  ) {
    const locationTerms = [
      ...businessContext.services.primary.slice(0, 2),
      businessContext.market.geographic.primary,
    ];
    keywordSourceRequests.push({
      sourceType: "service_seed",
      sourceLabel: "location_terms",
      originSeeds: locationTerms,
      matchedServiceHint: null,
      refinementRound: 0,
      promise: getKeywordSuggestionsWithMetrics(
        locationTerms,
        locationCode,
        dataForSEOLanguageCode,
        30,
      ),
    });
  }

  if (businessContext.keywordStrategy.mustHaveKeywords.length > 0) {
    keywordSourceRequests.push({
      sourceType: "service_seed",
      sourceLabel: "must_have_terms",
      originSeeds: businessContext.keywordStrategy.mustHaveKeywords.slice(0, 5),
      matchedServiceHint: null,
      refinementRound: 0,
      promise: getKeywordSuggestionsWithMetrics(
        businessContext.keywordStrategy.mustHaveKeywords.slice(0, 5),
        locationCode,
        dataForSEOLanguageCode,
        30,
      ),
    });
  }

  // Skip domain keyword fetch if smart discovery is enabled (it already fetches domain keywords with limit 200)
  if (websiteUrl && domain && !smartDiscoveryEnabled) {
    keywordSourceRequests.push({
      sourceType: "domain",
      sourceLabel: domain,
      originSeeds: [domain],
      matchedServiceHint: null,
      refinementRound: 0,
      promise: getKeywordsForDomainFromDataForSEO(
        domain,
        locationCode,
        dataForSEOLanguageCode,
        50,
      ).catch(() => []),
    });
  }

  // Run smart discovery and main keyword sources in parallel
  const [rawOpportunities, keywordResults] = await Promise.all([
    smartDiscoveryPromise,
    Promise.all(
      keywordSourceRequests.map(async (request) => ({
        request,
        results: await request.promise.catch(() => []),
      })),
    ),
  ]);

  // Process smart discovery results into candidates
  let uniqueOpportunities: KeywordCandidate[] = [];
  if (rawOpportunities.length > 0) {
    uniqueOpportunities = rawOpportunities
      .map((opportunity) =>
        createCandidate(
          {
            keyword: opportunity.keyword,
            searchVolume: opportunity.searchVolume,
            difficulty: opportunity.difficulty,
            cpc: opportunity.cpc,
            competition:
              typeof opportunity.difficulty === "number"
                ? opportunity.difficulty / 100
                : null,
            monthlySearches: opportunity.searchVolume,
            clicks: 0,
            impressions: 0,
            ctr: 0,
            trend: [],
          },
          opportunity.source === "own"
            ? "domain"
            : opportunity.source === "gap"
              ? "gap"
              : "competitor",
          opportunity.competitorDomain ?? opportunity.source,
          opportunity.competitorDomain ? [opportunity.competitorDomain] : [],
          0,
        ),
      )
      .filter(
        (candidate): candidate is KeywordCandidate => candidate !== null,
      );
  }

  const allKeywordsMap = new Map<string, KeywordCandidate>();
  for (const opportunity of uniqueOpportunities) {
    upsertCandidate(allKeywordsMap, opportunity);
  }

  for (const { request, results } of keywordResults) {
    if (!Array.isArray(results)) {
      continue;
    }

    for (const result of results) {
      upsertCandidate(
        allKeywordsMap,
        createCandidate(
          result,
          request.sourceType,
          request.sourceLabel,
          request.originSeeds,
          request.refinementRound,
          request.matchedServiceHint,
        ),
      );
    }
  }

  // ====================================================================
  // GEO-KW-4: Local candidate expansion
  // ====================================================================
  // For GEO-eligible businesses, expand candidates with city + neighborhood
  // seeds scored at metro-level DataForSEO codes. Each target city gets at
  // most one keyword-suggestion API call. Hard caps enforced per the plan.
  // Failure in any geo expansion call does NOT fail overall generation.
  if (geoCtx?.geoEligible && geoCtx.priorityServices.length > 0) {
    const { getKeywordSuggestionsWithMetrics } = await import("../../utils/dataforseo.utils");
    const { withCache } = await import("../../utils/dataforseo-cache");
    const maxGeoExpansionCalls = 5; // hard cap per plan
    let geoCallsMade = 0;

    // GEO-FIX-3: cached wrapper so retries/re-runs don't double-spend on
    // DataForSEO. Cache key includes seeds + locationCode + language.
    // TTL 4h — generous enough to survive retry windows, short enough for
    // daily regeneration to see fresh data.
    const cachedSuggestions = (
      seeds: string[],
      locCode: number,
      lang: string,
      limit: number,
    ) => {
      const cacheKey = `geo-kw-sugg:${seeds.sort().join("|")}:${locCode}:${lang}:${limit}`;
      return withCache(cacheKey, () =>
        getKeywordSuggestionsWithMetrics(seeds, locCode, lang, limit),
        { ttlMs: 4 * 60 * 60 * 1000 },
      );
    };

    // Combine service-area + primary city targets for expansion (cap-then-parallel).
    const expansionTargets = geoCtx.allTargets
      .filter((t) => t.type === "primary" || t.type === "service-area")
      .slice(0, maxGeoExpansionCalls); // cap BEFORE dispatch, not inside loop

    // Also include one neighborhood target if available (the "+1" slot).
    const neighborhoodTarget =
      geoCtx.neighborhoodTargets.length > 0 ? geoCtx.neighborhoodTargets[0]! : null;

    // Build all expansion tasks up-front, then fire in parallel via Promise.all.
    // Each task is self-contained and catch-guarded so one city failure doesn't
    // block the others. Same cap, same cost, ~5x faster wall-clock.
    type GeoExpansionTask = {
      target: import("../../utils/geo-keyword-context").GeoKeywordTarget;
      seeds: string[];
      limit: number;
    };

    const tasks: GeoExpansionTask[] = expansionTargets.map((target) => ({
      target,
      seeds: geoCtx.priorityServices.slice(0, 3).map((svc) => `${svc} ${target.city}`),
      limit: 30,
    }));

    if (neighborhoodTarget) {
      tasks.push({
        target: neighborhoodTarget,
        seeds: geoCtx.priorityServices.slice(0, 2).map((svc) => `${svc} ${neighborhoodTarget.city}`),
        limit: 20,
      });
    }

    const geoResults = await Promise.all(
      tasks.map(async (task) => {
        try {
          const results = await cachedSuggestions(
            task.seeds,
            task.target.locationCode,
            geoCtx.languageCode,
            task.limit,
          );
          return { task, results, ok: true as const };
        } catch (err) {
          console.warn(
            `⚠️ GEO expansion failed for "${task.target.city}":`,
            (err as Error).message,
          );
          return { task, results: [] as any[], ok: false as const };
        }
      }),
    );

    for (const { task, results, ok } of geoResults) {
      if (!ok) continue;
      geoCallsMade++;

      for (const result of results) {
        const candidate = createCandidate(
          result,
          "geo_expansion",
          `geo:${task.target.type}:${task.target.city}`,
          task.seeds,
          0,
          null,
        );
        if (candidate) {
          candidate.geoTarget = {
            targetCity: task.target.city,
            targetLocationCode: task.target.locationCode,
            geoSource: task.target.type,
            isResolved: task.target.isResolved,
          };
          upsertCandidate(allKeywordsMap, candidate);
        }
      }
      console.log(
        `🗺️  GEO expansion: ${task.target.type} "${task.target.city}" (code=${task.target.locationCode}) → ${results.length} candidates`,
      );
    }

    console.log(
      `🗺️  GEO expansion complete: ${geoCallsMade} DataForSEO calls (parallel), pool now ${allKeywordsMap.size} candidates`,
    );
  }

  if (allKeywordsMap.size === 0) {
    const llmGeoCandidates = await generateGeoAwareKeywordIdeas({
      business,
      businessContext,
      geoContext: geoCtx,
      primaryServices,
      focusAreas,
      expandedSubOfferings,
      existingKeywordTexts: lastKeywords.map((item) => item.keyword),
      previousKeywords: lastKeywords,
      locationScope,
      limit: 90,
    });

    if (llmGeoCandidates.length > 0) {
      console.warn(
        `⚠️ [KeywordGeneration] DataForSEO returned zero keyword candidates; using ${llmGeoCandidates.length} GEO-aware LLM fallback candidates.`,
      );
    }

    for (const candidateData of llmGeoCandidates) {
      const candidate = createCandidate(
        {
          keyword: candidateData.keyword,
          searchVolume: candidateData.estimatedSearchVolume,
          difficulty: candidateData.estimatedDifficulty,
          monthlySearches: candidateData.estimatedSearchVolume,
          cpc: 0,
          competition: candidateData.estimatedDifficulty / 100,
        },
        candidateData.geoTarget ? "geo_expansion" : "service_seed",
        "llm_geo_fallback",
        [candidateData.keyword],
        0,
        candidateData.service ||
          mapKeywordToService(candidateData.keyword, primaryServices, focusAreas),
      );
      if (candidate) {
        candidate.keywordIntent = candidateData.intent;
        candidate.keywordCategory = candidateData.category;
        candidate.intentSource = "ai";
        candidate.aiReason = candidateData.reason;
        candidate.aiRelevanceScore = candidateData.geoTarget ? 92 : 82;
        candidate.geoTarget = candidateData.geoTarget;
      }
      upsertCandidate(allKeywordsMap, candidate);
    }
  }

  if (allKeywordsMap.size === 0) {
    const fallbackCandidates = buildEstimatedKeywordFallbackPool({
      business,
      businessContext,
      primaryServices,
      focusAreas,
      expandedSubOfferings,
      locationScope,
    });

    console.warn(
      `⚠️ [KeywordGeneration] DataForSEO returned zero keyword candidates; using ${fallbackCandidates.length} estimated business-specific fallback candidates.`,
    );

    for (const candidateData of fallbackCandidates) {
      upsertCandidate(
        allKeywordsMap,
        createCandidate(
          candidateData,
          "service_seed",
          "estimated_no_data_fallback",
          [candidateData.keyword],
          0,
          mapKeywordToService(candidateData.keyword, primaryServices, focusAreas),
        ),
      );
    }
  }

  let allKeywords = Array.from(allKeywordsMap.values());
  let filteredKeywords = scoreAndSortKeywordCandidates({
    candidates: allKeywords,
    business,
    businessContext,
    coreServices,
  });

  for (let refinementRound = 1; refinementRound <= 2; refinementRound += 1) {
    const serviceCandidateCounts = new Map<string, number>();
    for (const service of primaryServices) {
      serviceCandidateCounts.set(
        service,
        filteredKeywords.filter((candidate) => {
          const matchedService =
            candidate.matchedService ||
            mapKeywordToService(candidate.keyword, primaryServices, focusAreas);
          return matchedService === service;
        }).length,
      );
    }

    const weakServices = primaryServices.filter(
      (service) => (serviceCandidateCounts.get(service) ?? 0) < 4,
    );

    if (filteredKeywords.length >= 60 && weakServices.length === 0) {
      break;
    }

    const refinedSeedsByService = await generateRefinedServiceSeeds(
      weakServices.slice(0, 5),
      business,
      businessContext,
      filteredKeywords.map((candidate) => candidate.keyword),
    );
    const refinementRequests = Object.entries(refinedSeedsByService).filter(
      ([, seeds]) => seeds.length > 0,
    );

    if (refinementRequests.length === 0) {
      break;
    }

    const refinementResults = await Promise.all(
      refinementRequests.map(async ([service, seeds]) => ({
        service,
        seeds,
        results: await getKeywordSuggestionsWithMetrics(
          seeds,
          locationCode,
          dataForSEOLanguageCode,
          20,
        ).catch(() => []),
      })),
    );

    for (const { service, seeds, results } of refinementResults) {
      for (const result of results) {
        upsertCandidate(
          allKeywordsMap,
          createCandidate(
            result,
            "refinement",
            service,
            seeds,
            refinementRound,
            service,
          ),
        );
      }
    }

    allKeywords = Array.from(allKeywordsMap.values());
    filteredKeywords = scoreAndSortKeywordCandidates({
      candidates: allKeywords,
      business,
      businessContext,
      coreServices,
    });
  }

  if (filteredKeywords.length === 0 && allKeywords.length > 0) {
    console.warn(
      `⚠️ [KeywordGeneration] Strict candidate filtering removed all ${allKeywords.length} candidates; retrying with relaxed local/long-tail thresholds.`,
    );
    filteredKeywords = scoreAndSortKeywordCandidates({
      candidates: allKeywords,
      business,
      businessContext,
      coreServices,
      minSearchVolume: 0,
      maxDifficulty: 100,
      maxWordCount: 10,
    });
  }

  if (filteredKeywords.length === 0) {
    const sample = allKeywords
      .slice(0, 8)
      .map(
        (candidate) =>
          `${candidate.keyword} (vol=${candidate.searchVolume ?? 0}, difficulty=${candidate.difficulty ?? "n/a"})`,
      )
      .join("; ");
    throw new Error(
      `No keywords passed filtering (raw=${allKeywords.length}; sample=${sample || "none"})`,
    );
  }

  const preFilteredKeywords = preFilterKeywords(
    filteredKeywords,
    coreOfferings,
    businessContext,
  );
  const keywordWhere: any = {
    userId,
    deletedAt: null,
  };

  if (businessId) {
    if (isPrimary) {
      keywordWhere.OR = [{ businessId }, { businessId: null }];
    } else {
      keywordWhere.businessId = businessId;
    }
  } else {
    keywordWhere.businessId = null;
  }

  const existingPlanData = await prisma.plan.findMany({
    where: keywordWhere,
    select: { keyword: true, publishDate: true },
    orderBy: { createdAt: "desc" },
  });
  const existingTopics = existingPlanData.slice(0, 10).map((keyword) => keyword.keyword);
  const businessKeywordsFromOnboarding =
    business.keywords?.map((keyword: any) => keyword.keyword) || [];
  const existingKeywordTexts = Array.from(
    new Set(existingPlanData.map((keyword) => keyword.keyword.toLowerCase().trim())),
  );
  const takenDates = buildTakenDateStrings(existingPlanData);
  const businessAreas = buildCanonicalBusinessAreas({
    business,
    businessContext,
    effectiveServices: coreServices,
  });

  const keywordsForLLM =
    preFilteredKeywords.length > 0 ? preFilteredKeywords : filteredKeywords;
  const cappedKeywordsForLLM = capKeywordCandidates({
    candidates: keywordsForLLM,
    businessAreas,
    primaryServices,
    focusAreas,
    totalLimit: KEYWORD_CANDIDATE_POOL_LIMIT,
    perGroupLimit: KEYWORD_CANDIDATE_GROUP_LIMIT,
  });

  console.log(
    `🔍 Candidate counts for business ${businessId ?? "unknown"}: raw=${allKeywords.length}, filtered=${filteredKeywords.length}, preFiltered=${preFilteredKeywords.length}, capped=${cappedKeywordsForLLM.length}`,
  );

  return {
    businessContext,
    coreOfferings,
    businessAreas,
    candidateSourceCounts: Object.fromEntries(candidateSourceCounts.entries()),
    previousKeywordsArray: lastKeywords,
    existingKeywordTexts,
    existingTopics,
    businessKeywordsFromOnboarding,
    takenDates,
    primaryServices,
    focusAreas,
    expandedSubOfferings,
    technologies,
    keywordsForLLM: cappedKeywordsForLLM,
    counts: {
      raw: allKeywords.length,
      filtered: filteredKeywords.length,
      preFiltered: preFilteredKeywords.length,
      capped: cappedKeywordsForLLM.length,
    },
    locationScope,
    geoContext: geoCtx,
  } satisfies KeywordCandidateCollectionResult;
}

export async function selectKeywordsForPlan(params: {
  business: any;
  collection: KeywordCandidateCollectionResult;
}) {
  const { business, collection } = params;
  const areaEnforcementEnabled =
    process.env.KEYWORD_AREA_ENFORCEMENT_ENABLED !== "false";
  const candidateClassifications = areaEnforcementEnabled
    ? await classifyKeywordCandidatesByBusinessArea({
        candidates: collection.keywordsForLLM,
        business,
        businessContext: collection.businessContext,
        businessAreas: collection.businessAreas,
      })
    : new Map<string, LLMKeywordCandidateClassification>();
  const rejectedCandidateCounts = new Map<string, number>();

  const areaFilteredKeywords = collection.keywordsForLLM
    .map((candidate) => {
      const classification =
        candidateClassifications.get(normalizeKeywordText(candidate.keyword)) ||
        buildFallbackCandidateClassification(candidate, collection.businessAreas);
      const canonicalBusinessArea =
        canonicalizeBusinessAreaName(
          classification.canonicalBusinessArea ||
            candidate.canonicalBusinessArea ||
            candidate.aiSelectedService ||
            candidate.matchedService ||
            mapKeywordToBusinessArea(candidate.keyword, collection.businessAreas),
          collection.businessAreas,
        ) || null;
      const businessArea = canonicalBusinessArea
        ? collection.businessAreas.find((area) => area.name === canonicalBusinessArea)
        : null;
      const keywordIntent =
        classification.intent ||
        (candidate.keywordIntent as KeywordIntentBucket | undefined) ||
        inferKeywordIntent(candidate.keyword);
      const intentSource =
        classification.intent ? "ai" : candidate.keywordIntent ? "dataforseo" : "heuristic";

      const enrichedCandidate: KeywordCandidate = {
        ...candidate,
        canonicalBusinessArea,
        businessAreaGroup:
          classification.businessAreaGroup || businessArea?.group || null,
        businessAreaPriority: businessArea?.priorityRank ?? null,
        semanticCluster:
          classification.semanticCluster ||
          candidate.semanticCluster ||
          deriveSemanticCluster(candidate.keyword),
        naturalnessScore:
          typeof classification.naturalnessScore === "number"
            ? classification.naturalnessScore
            : candidate.naturalnessScore ?? 0.75,
        isBlogWorthy:
          typeof classification.isBlogWorthy === "boolean"
            ? classification.isBlogWorthy
            : candidate.isBlogWorthy ?? true,
        keywordIntent,
        intentSource,
        selectionReason:
          classification.selectionReason ||
          candidate.selectionReason ||
          candidate.aiReason ||
          null,
        aiSelectedService:
          canonicalBusinessArea ||
          candidate.aiSelectedService ||
          candidate.matchedService ||
          null,
        matchedService:
          canonicalBusinessArea ||
          candidate.matchedService ||
          mapKeywordToService(
            candidate.keyword,
            collection.primaryServices,
            collection.focusAreas,
          ),
        aiRelevanceScore:
          typeof classification.relevanceScore === "number"
            ? Math.max(
                candidate.aiRelevanceScore ?? 0,
                classification.relevanceScore,
              )
            : candidate.aiRelevanceScore,
      };

      const quality = evaluateKeywordCandidateQuality(enrichedCandidate, {
        businessAreas: collection.businessAreas,
        businessContext: collection.businessContext,
        mustHaveKeywords:
          collection.businessContext.keywordStrategy.mustHaveKeywords,
      });
      enrichedCandidate.qualityScore = quality.qualityScore;

      if (areaEnforcementEnabled && !quality.accepted) {
        quality.reasons.forEach((reason) => {
          rejectedCandidateCounts.set(
            reason,
            (rejectedCandidateCounts.get(reason) ?? 0) + 1,
          );
        });
        return null;
      }

      return enrichedCandidate;
    })
    .filter(
      (candidate): candidate is KeywordCandidate => candidate !== null,
    );

  const viableAreas = collection.businessAreas.filter((area) =>
    areaFilteredKeywords.some(
      (candidate) => candidate.canonicalBusinessArea === area.name,
    ),
  );
  const requiredAreaNames = new Set(
    viableAreas.slice(0, 4).map((area) => area.name),
  );
  collection.businessAreas.forEach((area) => {
    area.required = requiredAreaNames.has(area.name);
  });

  const keywordsForLLM =
    areaFilteredKeywords.length > 0 ? areaFilteredKeywords : collection.keywordsForLLM;
  const businessAreasText =
    viableAreas.length > 0
      ? viableAreas
          .map(
            (area) =>
              `${area.name} [${area.group}] aliases: ${area.aliases.join(", ")}`,
          )
          .join("\n")
      : collection.businessAreas
          .map(
            (area) =>
              `${area.name} [${area.group}] aliases: ${area.aliases.join(", ")}`,
          )
          .join("\n");
  const businessSubOfferings =
    collection.expandedSubOfferings.length > 0
      ? collection.expandedSubOfferings.join(", ")
      : "N/A";
  const businessTechnologies =
    collection.technologies.length > 0
      ? collection.technologies.join(", ")
      : "N/A";
  const competitiveAdvantages =
    business.competitiveAdvantage
      ?.map((advantage: any) => advantage.advantage)
      .flat()
      .slice(0, 5)
      .join(", ") || "N/A";
  const previousKeywordsText =
    collection.previousKeywordsArray.length > 0
      ? `\n\nPrevious ${collection.previousKeywordsArray.length} Keywords Used (avoid similar topics):
${collection.previousKeywordsArray
  .slice(0, 10)
  .map((keyword) => `- ${keyword.keyword}`)
  .join("\n")}`
      : "";

  const llmPrompt = `You are an SEO expert and intelligent keyword strategist. Your task is to analyze and select the BEST 30 keywords that will generate meaningful traffic for this specific business.

🧠 BUSINESS INTELLIGENCE ANALYSIS:
- Business Model: ${collection.businessContext.businessModel.type} (Location Dependent: ${
    collection.businessContext.businessModel.isLocationDependent ? "Yes" : "No"
  })
- Primary Services/Products: ${collection.businessContext.services.primary.join(", ")}
- Secondary Services/Products: ${
    collection.businessContext.services.secondary.join(", ") || "N/A"
  }
- Canonical Business Areas:
${businessAreasText || "N/A"}
- Sub-Offerings/Technologies/Frameworks/Tools: ${
    businessSubOfferings !== "N/A" ? businessSubOfferings : "N/A"
  }
${
  businessTechnologies !== "N/A"
    ? `- Technologies/Frameworks Detected: ${businessTechnologies}`
    : ""
}
- Industry: ${collection.businessContext.market.industry.vertical}
- Sub-Verticals: ${
    collection.businessContext.market.industry.subVertical?.join(", ") || "N/A"
  }
- Market Scope: ${collection.businessContext.market.geographic.scope}
${
  collection.businessContext.businessModel.isLocationDependent
    ? `- Primary Location: ${collection.businessContext.market.geographic.primary}`
    : "- Location: NOT RELEVANT (product-based business)"
}
- Target Customers: ${collection.businessContext.market.customerSegment.primary}
- Customer Characteristics: ${
    collection.businessContext.market.customerSegment.characteristics.join(", ") ||
    "N/A"
  }
- Business Model: ${collection.businessContext.market.industry.b2bOrB2c}

📋 ADDITIONAL BUSINESS CONTEXT:
- Business Name: ${business.businessName}
- Business Type: ${business.businessType}
- Business Description: ${business.businessDescription}
- Location: ${business.businessCity || "N/A"}, ${
    business.businessState || "N/A"
  }, ${business.businessCountry || "N/A"}
- Competitive Advantages: ${competitiveAdvantages}
- Existing Topics: ${collection.existingTopics.join(", ") || "none"}
- Existing Keywords: ${
    collection.businessKeywordsFromOnboarding.slice(0, 10).join(", ") || "none"
  }
${previousKeywordsText}

CORE BUSINESS OFFERINGS:
This business sells: ${collection.coreOfferings.whatBusinessSells}
Primary offerings: ${collection.coreOfferings.primaryOfferings.join(", ")}
Target customers: ${collection.coreOfferings.targetCustomers}
Explicit statement: ${collection.coreOfferings.explicitStatement}

🚨 ABSOLUTE REJECTION RULES:
- ❌ REJECT: Keywords that are ONLY location names without service context
- ❌ REJECT: Keywords mentioning competitor names: ${
    collection.coreOfferings.competitorNames.length > 0
      ? collection.coreOfferings.competitorNames.join(", ")
      : "none identified"
  }
- ❌ REJECT: Keywords that don't mention any service/product the business offers
- ❌ REJECT: Generic location terms without service context

You have ${
    keywordsForLLM.length
  } REAL keyword suggestions with actual Google search data from DataForSEO API.

Available Keywords (with metrics and traffic potential):
${keywordsForLLM
  .slice(0, 200)
  .map((keyword, index) => {
    const cpc =
      typeof keyword.cpc === "number" ? keyword.cpc.toFixed(2) : "0.00";
    const trafficPotential =
      typeof keyword.trafficPotential === "number"
        ? keyword.trafficPotential.toFixed(2)
        : "0.00";
    const quality =
      typeof keyword.qualityScore === "number"
        ? keyword.qualityScore.toFixed(2)
        : "0.75";

    return `${index + 1}. "${keyword.keyword}" - ${keyword.searchVolume} searches/mo, ${
      keyword.difficulty
    }% difficulty, $${cpc} CPC, Traffic Potential: ${trafficPotential}, Area: ${
      keyword.canonicalBusinessArea || "unmapped"
    }, Group: ${keyword.businessAreaGroup || "unknown"}, Intent: ${
      keyword.keywordIntent || "unknown"
    }, Quality: ${quality}`;
  })
  .join("\n")}

OUTPUT FORMAT:
Output ONLY a JSON array with exactly 30 selected keywords:
[
  {
    "keyword": "exact keyword from list above",
    "selectedBusinessArea": "exact canonical business area from the list above",
    "reason": "short reason this keyword is strategically valuable",
    "relevanceScore": 0.91
  }
]`;

  let selectedKeywords: LLMKeywordSelection[] = [];
  let selectionRequestFailed = false;
  try {
    const llmResponse = await keywordLLM.invoke(
      [
        {
          role: "system",
          content:
            "You are an intelligent SEO keyword strategist. Output ONLY a JSON array with keyword, selectedBusinessArea, reason, and relevanceScore.",
        },
        { role: "user", content: llmPrompt },
      ],
      keywordLlmInvocationConfig(),
    );

    const llmContent =
      typeof llmResponse.content === "string"
        ? llmResponse.content
        : JSON.stringify(llmResponse.content);
    selectedKeywords = parseLLMSelection(llmContent);
  } catch (error) {
    selectionRequestFailed = true;
    console.warn(
      "⚠️ Keyword strategy selection timed out or failed; using deterministic selection:",
      error instanceof Error ? error.message : error,
    );
  }

  const uniqueSelectedMap = new Map<string, LLMKeywordSelection>();
  for (const keyword of selectedKeywords) {
    const key = normalizeKeywordText(keyword.keyword);
    if (!uniqueSelectedMap.has(key)) {
      uniqueSelectedMap.set(key, keyword);
    }
  }
  selectedKeywords = Array.from(uniqueSelectedMap.values());

  if (selectedKeywords.length === 0 && !selectionRequestFailed) {
    try {
      const retryResponse = await keywordLLM.invoke(
        [
          {
            role: "system",
            content:
              "Select exactly 30 keyword objects. Prioritize business relevance. Output ONLY JSON array with keyword, selectedBusinessArea, reason, and relevanceScore.",
          },
          {
            role: "user",
            content: `Select exactly 30 keywords from this business-relevant pool:\n${keywordsForLLM
              .slice(0, 200)
              .map((keyword, index) => `${index + 1}. "${keyword.keyword}"`)
              .join("\n")}`,
          },
        ],
        keywordLlmInvocationConfig(),
      );

      const retryContent =
        typeof retryResponse.content === "string"
          ? retryResponse.content
          : JSON.stringify(retryResponse.content);
      selectedKeywords = parseLLMSelection(retryContent);
    } catch (error) {
      console.warn(
        "⚠️ Keyword strategy retry timed out or failed; using deterministic selection:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (selectedKeywords.length === 0) {
    console.warn(
      "⚠️ No usable LLM keyword selection was returned; continuing with the deterministic ranked plan.",
    );
  }

  const existingKeywordTexts = new Set(collection.existingKeywordTexts);
  const candidatePoolForSelection = keywordsForLLM
    .filter(
      (candidate) =>
        !existingKeywordTexts.has(normalizeKeywordText(candidate.keyword)),
    )
    .map((candidate) => ({
      ...candidate,
      canonicalBusinessArea:
        candidate.canonicalBusinessArea ||
        mapKeywordToBusinessArea(candidate.keyword, collection.businessAreas),
      businessAreaGroup:
        candidate.businessAreaGroup ||
        (() => {
          const areaName =
            candidate.canonicalBusinessArea ||
            mapKeywordToBusinessArea(candidate.keyword, collection.businessAreas);
          return areaName
            ? collection.businessAreas.find((area) => area.name === areaName)?.group ||
                null
            : null;
        })(),
      matchedService:
        candidate.matchedService ||
        candidate.canonicalBusinessArea ||
        mapKeywordToService(
          candidate.keyword,
          collection.primaryServices,
          collection.focusAreas,
        ),
      keywordIntent:
        candidate.keywordIntent || inferKeywordIntent(candidate.keyword),
      semanticCluster:
        candidate.semanticCluster || deriveSemanticCluster(candidate.keyword),
    }));

  const candidateMapForSelection = new Map(
    candidatePoolForSelection.map((candidate) => [
      normalizeKeywordText(candidate.keyword),
      candidate,
    ]),
  );

  for (const selection of selectedKeywords) {
    const key = normalizeKeywordText(selection.keyword);
    const candidate = candidateMapForSelection.get(key);
    if (!candidate) {
      continue;
    }

    const selectedBusinessArea =
      canonicalizeBusinessAreaName(
        selection.selectedBusinessArea ||
          selection.selectedService ||
          candidate.canonicalBusinessArea ||
          candidate.matchedService,
        collection.businessAreas,
      ) ||
      candidate.canonicalBusinessArea ||
      mapKeywordToBusinessArea(selection.keyword, collection.businessAreas);
    const matchedArea = selectedBusinessArea
      ? collection.businessAreas.find((area) => area.name === selectedBusinessArea)
      : null;

    candidate.canonicalBusinessArea = selectedBusinessArea || null;
    candidate.aiSelectedService =
      selectedBusinessArea ||
      candidate.matchedService ||
      mapKeywordToService(
        selection.keyword,
        collection.primaryServices,
        collection.focusAreas,
      );
    candidate.businessAreaGroup =
      candidate.businessAreaGroup || matchedArea?.group || null;
    candidate.businessAreaPriority =
      candidate.businessAreaPriority ?? matchedArea?.priorityRank ?? null;
    candidate.aiReason = selection.reason || null;
    candidate.aiRelevanceScore =
      typeof selection.relevanceScore === "number"
        ? selection.relevanceScore
        : candidate.aiRelevanceScore ?? Math.max(candidate.relevanceScore ?? 0, 0.7);
  }

  const selectionResult = selectKeywordsDeterministically({
    candidates: candidatePoolForSelection,
    businessAreas: collection.businessAreas,
    mustHaveKeywords:
      collection.businessContext.keywordStrategy.mustHaveKeywords,
    strategy: collection.businessContext.keywordStrategy,
  });

  // ====================================================================
  // GEO-KW-6: Post-selection GEO rebalancing
  // ====================================================================
  // If the business is GEO-eligible but the deterministic selection
  // under-represents local keywords, swap in GEO candidates from the
  // pool to reach ~35-55% local mix. Also cap any single city at 40%.
  const geoCtx = collection.geoContext;
  if (geoCtx?.geoEligible && selectionResult.selected.length > 0) {
    const allowedCities = new Set(
      geoCtx.allTargets.map((t) => t.city.toLowerCase()),
    );
    const isGeoKeyword = (kw: KeywordCandidate): boolean => {
      if (kw.geoTarget) return true;
      // Heuristic: keyword contains an allowed city name.
      const lower = kw.keyword.toLowerCase();
      for (const city of allowedCities) {
        if (lower.includes(city)) return true;
      }
      return false;
    };

    const totalSelected = selectionResult.selected.length;
    const geoSelected = selectionResult.selected.filter(isGeoKeyword).length;
    const geoRatio = geoSelected / totalSelected;
    const targetMin = 0.35;
    const targetMax = 0.55;
    const cityMaxRatio = 0.4;

    // If under-represented, try to swap in GEO candidates from the pool.
    if (geoRatio < targetMin) {
      const deficit = Math.ceil(targetMin * totalSelected) - geoSelected;
      const selectedSet = new Set(
        selectionResult.selected.map((kw) => normalizeKeywordText(kw.keyword)),
      );
      const geoCandidatesFromPool = candidatePoolForSelection
        .filter(
          (kw) =>
            isGeoKeyword(kw) &&
            !selectedSet.has(normalizeKeywordText(kw.keyword)) &&
            kw.searchVolume > 0 &&
            (kw.difficulty ?? 100) < 80,
        )
        .sort(
          (a, b) =>
            (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
            b.searchVolume - a.searchVolume,
        );

      // Swap: replace the weakest non-GEO selected keywords with the strongest
      // GEO candidates from the pool.
      const nonGeoSelected = selectionResult.selected
        .filter((kw) => !isGeoKeyword(kw))
        .sort(
          (a, b) =>
            (a.qualityScore ?? 0) - (b.qualityScore ?? 0) ||
            a.searchVolume - b.searchVolume,
        );

      let swapped = 0;
      for (const geoCandidate of geoCandidatesFromPool) {
        if (swapped >= deficit) break;
        const victim = nonGeoSelected[swapped];
        if (!victim) break;
        const victimIdx = selectionResult.selected.indexOf(victim);
        if (victimIdx === -1) continue;
        selectionResult.selected[victimIdx] = geoCandidate;
        swapped++;
      }

      if (swapped > 0) {
        console.log(
          `🗺️  GEO rebalance: swapped ${swapped} non-geo keywords for geo candidates (${geoRatio.toFixed(2)} → ${((geoSelected + swapped) / totalSelected).toFixed(2)})`,
        );
      }
    }

    // GEO-FIX-2: enforce city cap — swap excess same-city keywords with
    // underrepresented city candidates from the pool. Only applies when
    // multiple cities are in play (single-city businesses keep all their keywords).
    const cityCounts = new Map<string, number>();
    for (const kw of selectionResult.selected) {
      const city = kw.geoTarget?.targetCity?.toLowerCase();
      if (city) {
        cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1);
      }
    }
    const cityMax = Math.ceil(totalSelected * cityMaxRatio);
    if (cityCounts.size > 1) {
      const selectedSet = new Set(
        selectionResult.selected.map((kw) => normalizeKeywordText(kw.keyword)),
      );
      for (const [overCity, count] of cityCounts) {
        if (count <= cityMax) continue;
        const excess = count - cityMax;

        // Find selected keywords from the over-represented city, weakest first.
        const overCityKeywords = selectionResult.selected
          .filter(
            (kw) =>
              kw.geoTarget?.targetCity?.toLowerCase() === overCity,
          )
          .sort(
            (a, b) =>
              (a.qualityScore ?? 0) - (b.qualityScore ?? 0) ||
              a.searchVolume - b.searchVolume,
          );

        // Find replacement candidates from OTHER cities that aren't already selected.
        const replacements = candidatePoolForSelection
          .filter((kw) => {
            if (!kw.geoTarget) return false;
            const kwCity = kw.geoTarget.targetCity?.toLowerCase();
            if (!kwCity || kwCity === overCity) return false;
            return (
              !selectedSet.has(normalizeKeywordText(kw.keyword)) &&
              kw.searchVolume > 0 &&
              (kw.difficulty ?? 100) < 80
            );
          })
          .sort(
            (a, b) =>
              (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
              b.searchVolume - a.searchVolume,
          );

        let swapped = 0;
        for (let i = 0; i < Math.min(excess, replacements.length); i++) {
          const victim = overCityKeywords[i];
          const replacement = replacements[i];
          if (!victim || !replacement) break;
          const victimIdx = selectionResult.selected.indexOf(victim);
          if (victimIdx === -1) continue;
          selectionResult.selected[victimIdx] = replacement;
          selectedSet.delete(normalizeKeywordText(victim.keyword));
          selectedSet.add(normalizeKeywordText(replacement.keyword));
          swapped++;
        }
        if (swapped > 0) {
          console.log(
            `🗺️  GEO cap: swapped ${swapped} excess "${overCity}" keywords for other-city candidates (was ${count}/${totalSelected}, now ${count - swapped}/${totalSelected})`,
          );
        }
      }
    }
  }

  return {
    selectedCandidates: selectionResult.selected,
    fallbackCandidates: candidatePoolForSelection,
    quotaSummary: selectionResult.summary,
    counts: {
      classificationBatches: Math.ceil(collection.keywordsForLLM.length / 35),
      areaFiltered: areaFilteredKeywords.length,
      retained: keywordsForLLM.length,
      selected: selectionResult.summary.selectedCount,
      selectedByLlm: selectedKeywords.length,
    },
  } satisfies KeywordCandidateSelectionResult;
}

export async function buildKeywordPlanForPersistence(params: {
  business: any;
  userId: string;
  businessId: string | null;
  collection: KeywordCandidateCollectionResult;
  selection: KeywordCandidateSelectionResult;
}) {
  const { business, userId, businessId, collection, selection } = params;
  const existingKeywordTexts = new Set(collection.existingKeywordTexts);
  const finalizedCandidates: KeywordCandidate[] = [];
  const finalizedSet = new Set<string>();

  const verificationResults = await verifyKeywordCandidatesInBatches({
    candidates: selection.selectedCandidates,
    business,
    businessContext: collection.businessContext,
    coreOfferings: collection.coreOfferings,
  });

  const selectedCandidateKeys = new Set(
    selection.selectedCandidates.map((candidate) =>
      normalizeKeywordText(candidate.keyword),
    ),
  );
  const sortedFallbackCandidates = [...selection.fallbackCandidates]
    .filter(
      (candidate) =>
        !selectedCandidateKeys.has(normalizeKeywordText(candidate.keyword)),
    )
    .sort((a, b) => {
      const aiDiff = (b.aiRelevanceScore ?? 0) - (a.aiRelevanceScore ?? 0);
      if (Math.abs(aiDiff) > 0.001) {
        return aiDiff;
      }
      const trafficDiff =
        (b.trafficPotential ?? 0) - (a.trafficPotential ?? 0);
      if (Math.abs(trafficDiff) > 0.001) {
        return trafficDiff;
      }
      return (b.searchVolume ?? 0) - (a.searchVolume ?? 0);
    });

  const configuredReplacementLimit = Number.parseInt(
    process.env.KEYWORD_REPLACEMENT_VERIFICATION_LIMIT ?? "90",
    10,
  );
  const replacementVerificationLimit = Number.isFinite(
    configuredReplacementLimit,
  )
    ? Math.min(
        sortedFallbackCandidates.length,
        Math.max(30, configuredReplacementLimit),
      )
    : Math.min(sortedFallbackCandidates.length, 90);
  let fallbackCursor = 0;
  const verifiedReplacementQueue: KeywordCandidate[] = [];
  const replacementVerificationBatchSize = 10;

  const findReplacementCandidate = async () => {
    while (verifiedReplacementQueue.length === 0) {
      const candidatesToVerify: KeywordCandidate[] = [];

      while (
        candidatesToVerify.length < replacementVerificationBatchSize &&
        fallbackCursor < sortedFallbackCandidates.length &&
        fallbackCursor < replacementVerificationLimit
      ) {
        const candidate = sortedFallbackCandidates[fallbackCursor];
        fallbackCursor += 1;
        if (!candidate) continue;

        const key = normalizeKeywordText(candidate.keyword);
        if (finalizedSet.has(key) || existingKeywordTexts.has(key)) continue;
        candidatesToVerify.push(candidate);
      }

      if (candidatesToVerify.length === 0) return null;

      const verificationResults = await verifyKeywords(
        candidatesToVerify.map((candidate) => candidate.keyword),
        business,
        collection.businessContext,
        collection.coreOfferings,
      );
      const verificationByKeyword = new Map(
        verificationResults.map((verification) => [
          normalizeKeywordText(verification.keyword),
          verification,
        ]),
      );

      for (const candidate of candidatesToVerify) {
        const verification = verificationByKeyword.get(
          normalizeKeywordText(candidate.keyword),
        );
        if (
          !verification?.isValid ||
          verification.relevanceScore < 0.55
        ) {
          continue;
        }

        verifiedReplacementQueue.push({
          ...candidate,
          aiReason:
            candidate.aiReason ||
            "Selected from remaining candidate pool after validation",
          aiRelevanceScore:
            candidate.aiRelevanceScore ?? verification.relevanceScore,
          matchedService:
            candidate.aiSelectedService ||
            candidate.matchedService ||
            mapKeywordToService(
              candidate.keyword,
              collection.primaryServices,
              collection.focusAreas,
            ),
        });
      }
    }

    return verifiedReplacementQueue.shift() ?? null;
  };

  for (const candidate of selection.selectedCandidates) {
    const key = normalizeKeywordText(candidate.keyword);
    if (finalizedSet.has(key)) {
      continue;
    }

    const verification = verificationResults.get(key);
    if (verification && verification.isValid && verification.relevanceScore >= 0.55) {
      finalizedCandidates.push({
        ...candidate,
        aiRelevanceScore:
          candidate.aiRelevanceScore ?? verification.relevanceScore,
        matchedService:
          candidate.aiSelectedService ||
          candidate.matchedService ||
          mapKeywordToService(
            candidate.keyword,
            collection.primaryServices,
            collection.focusAreas,
          ),
      });
      finalizedSet.add(key);
      continue;
    }

    const replacement = await findReplacementCandidate();
    if (replacement) {
      finalizedCandidates.push(replacement);
      finalizedSet.add(normalizeKeywordText(replacement.keyword));
    }
  }

  while (finalizedCandidates.length < 30) {
    const replacement = await findReplacementCandidate();
    if (!replacement) {
      break;
    }
    finalizedCandidates.push(replacement);
    finalizedSet.add(normalizeKeywordText(replacement.keyword));
  }

  const takenDates = new Set(collection.takenDates);
  const isOngoing = collection.previousKeywordsArray.length > 0;
  const latestDate =
    collection.previousKeywordsArray.length > 0 &&
    collection.previousKeywordsArray[0]?.publishDate
      ? new Date(collection.previousKeywordsArray[0].publishDate!)
      : new Date();
  const startDate = new Date(latestDate);
  if (isOngoing) {
    startDate.setDate(startDate.getDate() + 1);
  }

  const sortedByDifficulty = [...finalizedCandidates].sort(
    (a, b) => a.difficulty - b.difficulty,
  );
  let dateOffset = 0;
  const keywordPlan: KeywordPlanDraftItem[] = [];

  for (const selected of sortedByDifficulty) {
    let publishDate: Date;
    let dateString: string | undefined;
    let attempts = 0;

    do {
      publishDate = new Date(startDate);
      publishDate.setDate(publishDate.getDate() + dateOffset);
      dateString = publishDate.toISOString().split("T")[0];
      dateOffset += 1;
      attempts += 1;
      if (attempts > 365) {
        break;
      }
    } while (dateString && takenDates.has(dateString));

    if (!dateString) {
      continue;
    }

    takenDates.add(dateString);
    const { category, intent } = categorizeKeywordAdvanced(
      selected.keyword,
      business,
    );

    keywordPlan.push({
      keyword: selected.keyword,
      publishDate: dateString,
      publishTime: "08:00",
      keywordDiffculty: selected.difficulty.toString(),
      keywordSearchVolume: selected.searchVolume.toString(),
      userId,
      businessId,
      keywordCategory: category,
      keywordIntent: selected.keywordIntent || intent,
      keywordSource: selected.sourceType,
      difficultyBucket: bucketDifficulty(
        selected.difficulty,
        collection.businessContext.keywordStrategy,
      ) as DifficultyBucket,
      selectionMetadata: buildSelectionMetadata(
        selected,
        collection.focusAreas,
        collection.businessAreas,
      ) as Record<string, unknown>,
      keywordCpc: selected.cpc ?? null,
      keywordCompetition: selected.competition ?? null,
      keywordTrend: selected.trend?.length ? selected.trend : null,
      keywordMonthlySearches: selected.monthlySearches ?? null,
      keywordClicks: selected.clicks ?? null,
      keywordImpressions: selected.impressions ?? null,
      keywordCTR: selected.ctr ?? null,
      keywordDataUpdatedAt: new Date().toISOString(),
    });
  }

  const seenPlanKeywords = new Set<string>();
  const keywordPlanToSave = keywordPlan.filter((item) => {
    const key = normalizeKeywordText(item.keyword);
    if (seenPlanKeywords.has(key)) {
      return false;
    }
    seenPlanKeywords.add(key);
    return true;
  });

  if (businessId) {
    const { assignKeywordClusters } = await import(
      "../../utils/keyword-cluster.utils"
    );
    const clusterMap = await assignKeywordClusters(
      keywordPlanToSave.map((item) => ({
        keyword: item.keyword,
        ...(item.keywordCategory ? { keywordCategory: item.keywordCategory } : {}),
        ...(item.keywordIntent ? { keywordIntent: item.keywordIntent } : {}),
      })),
      businessId,
      userId,
    );

    for (const item of keywordPlanToSave) {
      const assignment = clusterMap.get(item.keyword.toLowerCase());
      if (assignment) {
        item.clusterId = assignment.clusterId;
        item.clusterRole = assignment.clusterRole;
      }
    }
  }

  return {
    keywordPlanToSave,
    counts: {
      verified: finalizedCandidates.length,
      planned: keywordPlan.length,
      deduped: keywordPlanToSave.length,
    },
  } satisfies KeywordPlanBuildResult;
}

/**
 * Helper: Calculate trend growth from trend data
 */
function calculateTrendGrowth(
  trend: Array<{ year: number; month: number; searchVolume: number }>,
): number {
  if (!trend || trend.length < 2) return 1.0;

  const sorted = [...trend].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  const first = sorted[0]?.searchVolume || 0;
  const last = sorted[sorted.length - 1]?.searchVolume || 0;

  if (first === 0) return 1.0;
  return last / first;
}

/**
 * Helper: Calculate enhanced relevance score for keyword
 */
function calculateRelevanceScore(
  keyword: string,
  business: any,
  coreServices?: any,
): number {
  const keywordLower = keyword.toLowerCase();
  const keywordWords = keywordLower.split(/\s+/).filter((w) => w.length > 2);

  const businessTerms: string[] = [];

  if (business.businessName) {
    const nameWords = business.businessName.toLowerCase().split(/\s+/);
    businessTerms.push(...nameWords);
    businessTerms.push(business.businessName.toLowerCase());
  }

  if (business.businessType) {
    businessTerms.push(business.businessType.toLowerCase());
    const typeWords = business.businessType.toLowerCase().split(/\s+/);
    businessTerms.push(...typeWords.filter((w: string) => w.length > 3));
  }

  if (business.businessDescription) {
    const descWords = business.businessDescription
      .toLowerCase()
      .split(/\s+/)
      .filter(
        (w: string) =>
          w.length > 4 &&
          ![
            "the",
            "and",
            "with",
            "that",
            "this",
            "from",
            "your",
            "their",
            "for",
            "are",
            "has",
            "have",
          ].includes(w),
      );
    businessTerms.push(...descWords.slice(0, 20));
  }

  if (coreServices?.topLevel && Array.isArray(coreServices.topLevel)) {
    coreServices.topLevel.forEach((service: string) => {
      const serviceLower = service.toLowerCase();
      businessTerms.push(serviceLower);
      serviceLower.split(/\s+/).forEach((word: string) => {
        if (word.length > 3) businessTerms.push(word);
      });
    });
  }

  if (coreServices?.subOfferings && Array.isArray(coreServices.subOfferings)) {
    coreServices.subOfferings.forEach((offering: string) => {
      const offeringLower = offering.toLowerCase();
      businessTerms.push(offeringLower);
      offeringLower.split(/\s+/).forEach((word: string) => {
        if (word.length > 3) businessTerms.push(word);
      });
    });
  }

  if (business.keywords && Array.isArray(business.keywords)) {
    business.keywords.forEach((kw: any) => {
      if (kw.keyword) {
        businessTerms.push(kw.keyword.toLowerCase());
        kw.keyword
          .toLowerCase()
          .split(/\s+/)
          .forEach((word: string) => {
            if (word.length > 3) businessTerms.push(word);
          });
      }
    });
  }

  const uniqueTerms = Array.from(new Set(businessTerms));

  let relevanceScore = 0;

  for (const term of uniqueTerms) {
    if (term.length > 4 && keywordLower.includes(term)) {
      relevanceScore += 3.0;
    }
  }

  for (const keywordWord of keywordWords) {
    if (uniqueTerms.includes(keywordWord)) {
      relevanceScore += 1.5;
    }
  }

  for (const keywordWord of keywordWords) {
    for (const term of uniqueTerms) {
      if (
        term.length > 4 &&
        (keywordWord.includes(term) || term.includes(keywordWord))
      ) {
        relevanceScore += 0.5;
      }
    }
  }

  const normalizedScore = Math.min(
    2.5,
    1.0 + relevanceScore / Math.max(1, keywordWords.length * 2),
  );

  return normalizedScore;
}

/**
 * Helper: Calculate composite keyword score for ranking
 */
function calculateKeywordScore(
  keyword: any,
  business: any,
  trendGrowth: number = 1.0,
  coreServices?: any,
): number {
  const searchVolume = keyword.searchVolume || 0;
  const difficulty = keyword.difficulty || 50;
  const cpc = keyword.cpc || 0;

  const relevanceScore = calculateRelevanceScore(
    keyword.keyword,
    business,
    coreServices,
  );

  const wordCount = keyword.keyword.split(" ").length;
  const lengthScore = wordCount >= 2 && wordCount <= 5 ? 1.2 : 0.8;

  const trendMultiplier =
    trendGrowth > 1.0 ? 1.3 : trendGrowth < 0.8 ? 0.7 : 1.0;

  const baseScore =
    (searchVolume *
      trendMultiplier *
      Math.pow(relevanceScore, 1.3) *
      lengthScore) /
    Math.pow(difficulty, 1.5);
  const cpcBonus = cpc > 0 ? Math.log(cpc + 1) * 0.1 : 0;

  return baseScore + cpcBonus;
}

/**
 * Helper: Calculate relevance to business context
 */
function calculateRelevanceToBusiness(
  keyword: any,
  businessContext: BusinessContextAnalysis,
): number {
  const keywordLower = keyword.keyword.toLowerCase();
  let relevanceScore = 0;

  for (const service of businessContext.services.primary) {
    if (keywordLower.includes(service.toLowerCase())) {
      relevanceScore += 0.3;
    }
  }

  if (
    keywordLower.includes(
      businessContext.market.industry.vertical.toLowerCase(),
    )
  ) {
    relevanceScore += 0.2;
  }

  if (
    businessContext.market.geographic.scope === "local" ||
    businessContext.market.geographic.scope === "regional"
  ) {
    if (
      keywordLower.includes(
        businessContext.market.geographic.primary.toLowerCase(),
      )
    ) {
      relevanceScore += 0.2;
    }
  }

  if (
    keywordLower.includes(
      businessContext.market.customerSegment.primary.toLowerCase(),
    )
  ) {
    relevanceScore += 0.1;
  }

  for (const mustHave of businessContext.keywordStrategy.mustHaveKeywords) {
    if (keywordLower.includes(mustHave.toLowerCase())) {
      relevanceScore += 0.2;
    }
  }

  return Math.min(1.0, relevanceScore);
}

/**
 * Helper: Check if keyword matches intent strategy
 */
function matchesIntentStrategy(
  keyword: any,
  strategy: BusinessContextAnalysis["keywordStrategy"],
): number {
  const keywordLower = keyword.keyword.toLowerCase();
  let intent = "informational";

  if (keywordLower.match(/best|top|review|compare|vs|alternative|rating/)) {
    intent = "commercial";
  } else if (
    keywordLower.match(/buy|price|order|cost|purchase|hire|book|quote/)
  ) {
    intent = "transactional";
  } else if (keywordLower.match(/near me|in \w+|local|\w+ \w+ area/)) {
    intent = "navigational";
  }

  const targetDistribution = strategy.intentDistribution;
  const targetPercent =
    intent === "informational"
      ? targetDistribution.informational
      : intent === "commercial"
        ? targetDistribution.commercial
        : intent === "transactional"
          ? targetDistribution.transactional
          : targetDistribution.navigational;

  return targetPercent / 100;
}

/**
 * Helper: Check if keyword matches market context
 */
function matchesMarketContext(
  keyword: any,
  market: BusinessContextAnalysis["market"],
): number {
  const keywordLower = keyword.keyword.toLowerCase();
  let matchScore = 0;

  if (
    market.geographic.scope === "local" ||
    market.geographic.scope === "regional"
  ) {
    if (keywordLower.includes(market.geographic.primary.toLowerCase())) {
      matchScore += 0.5;
    }
  }

  if (keywordLower.includes(market.industry.vertical.toLowerCase())) {
    matchScore += 0.3;
  }

  if (keywordLower.includes(market.customerSegment.primary.toLowerCase())) {
    matchScore += 0.2;
  }

  return Math.min(1.0, matchScore);
}

/**
 * Helper: Calculate traffic potential score for keyword
 */
function calculateTrafficPotential(
  keyword: any,
  businessContext: BusinessContextAnalysis,
): number {
  const relevanceScore = calculateRelevanceToBusiness(keyword, businessContext);
  const volumeScore = Math.min(1.0, (keyword.searchVolume || 0) / 1000);
  const difficultyScore = (100 - (keyword.difficulty || 50)) / 100;
  const intentMatch = matchesIntentStrategy(
    keyword,
    businessContext.keywordStrategy,
  );
  const marketMatch = matchesMarketContext(keyword, businessContext.market);

  return (
    relevanceScore * 0.3 +
    volumeScore * 0.25 +
    difficultyScore * 0.2 +
    intentMatch * 0.15 +
    marketMatch * 0.1
  );
}

/**
 * Helper: Enhanced keyword categorization with content type
 */
function categorizeKeywordAdvanced(
  keyword: string,
  business: any,
): {
  category: string;
  intent: string;
  contentType: string;
} {
  const lower = keyword.toLowerCase();
  const businessName = business.businessName?.toLowerCase() || "";

  // Intent detection
  let intent = "informational";
  if (lower.match(/best|top|review|compare|vs|alternative|rating/)) {
    intent = "commercial";
  } else if (lower.match(/buy|price|order|cost|purchase|hire|book|quote/)) {
    intent = "transactional";
  } else if (
    lower.match(/near me|in \w+|local|\w+ \w+ area/) ||
    lower.includes(businessName)
  ) {
    intent = "navigational";
  }

  // Content type detection
  let contentType = "blog";
  if (lower.match(/how to|how-to|tutorial|step by step|guide to/)) {
    contentType = "how-to";
  } else if (lower.match(/best|top \d+|list of|\d+ ways|\d+ tips/)) {
    contentType = "list";
  } else if (
    lower.match(/complete guide|ultimate guide|comprehensive|everything about/)
  ) {
    contentType = "guide";
  } else if (lower.match(/review|rating|vs |comparison/)) {
    contentType = "review";
  }

  // Category (for keywordCategory field)
  const category = intent === "navigational" ? "local" : intent;

  return { category, intent, contentType };
}

/**
 * Helper: Categorize keyword based on content (backward compatibility)
 */
function categorizeKeyword(keyword: string): string {
  const lower = keyword.toLowerCase();
  if (lower.match(/how to|what is|guide|tutorial|why|when/))
    return "informational";
  if (lower.match(/best|top|review|compare|vs|alternative/))
    return "commercial";
  if (lower.match(/near me|in \w+|local|\w+ \w+ area/)) return "local";
  if (lower.match(/buy|price|order|cost|purchase|hire|book/))
    return "transactional";
  return "informational";
}

/**
 * Helper: Determine search intent (backward compatibility)
 */
function determineIntent(keyword: string): string {
  const category = categorizeKeyword(keyword);
  if (category === "local") return "navigational";
  return category;
}

/**
 * Helper: Parse LLM's keyword selection response
 */
type LLMKeywordSelection = {
  keyword: string;
  selectedService?: string;
  selectedBusinessArea?: string;
  reason?: string;
  relevanceScore?: number;
};

function parseLLMSelection(content: string): LLMKeywordSelection[] {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => {
          if (typeof item === "string") {
            return { keyword: item };
          }
          if (item && typeof item === "object" && typeof item.keyword === "string") {
            return {
              keyword: item.keyword,
              selectedService:
                typeof item.selectedService === "string"
                  ? item.selectedService
                  : undefined,
              selectedBusinessArea:
                typeof item.selectedBusinessArea === "string"
                  ? item.selectedBusinessArea
                  : undefined,
              reason: typeof item.reason === "string" ? item.reason : undefined,
              relevanceScore:
                typeof item.relevanceScore === "number"
                  ? item.relevanceScore
                  : undefined,
            } satisfies LLMKeywordSelection;
          }
          return null;
        })
        .filter((item) => item !== null) as LLMKeywordSelection[];
    }
    return [];
  } catch (error) {
    console.error("Failed to parse LLM selection:", error);
    return [];
  }
}

type LLMKeywordCandidateClassification = {
  keyword: string;
  canonicalBusinessArea?: string | null;
  businessAreaGroup?: BusinessAreaGroup | null;
  isBlogWorthy?: boolean;
  naturalnessScore?: number;
  semanticCluster?: string | null;
  intent?: KeywordIntentBucket;
  selectionReason?: string;
  relevanceScore?: number;
};

function parseCandidateClassifications(
  content: string,
): LLMKeywordCandidateClassification[] {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => {
        if (!item || typeof item !== "object" || typeof item.keyword !== "string") {
          return null;
        }

        const intent =
          typeof item.intent === "string"
            ? (item.intent as KeywordIntentBucket)
            : undefined;
        const businessAreaGroup =
          item.businessAreaGroup === "product" || item.businessAreaGroup === "service"
            ? (item.businessAreaGroup as BusinessAreaGroup)
            : undefined;

        return {
          keyword: item.keyword,
          canonicalBusinessArea:
            typeof item.canonicalBusinessArea === "string"
              ? item.canonicalBusinessArea
              : item.canonicalBusinessArea === null
                ? null
                : undefined,
          businessAreaGroup,
          isBlogWorthy:
            typeof item.isBlogWorthy === "boolean"
              ? item.isBlogWorthy
              : undefined,
          naturalnessScore:
            typeof item.naturalnessScore === "number"
              ? item.naturalnessScore
              : undefined,
          semanticCluster:
            typeof item.semanticCluster === "string"
              ? item.semanticCluster
              : item.semanticCluster === null
                ? null
                : undefined,
          intent,
          selectionReason:
            typeof item.selectionReason === "string"
              ? item.selectionReason
              : undefined,
          relevanceScore:
            typeof item.relevanceScore === "number"
              ? item.relevanceScore
              : undefined,
        } satisfies LLMKeywordCandidateClassification;
      })
      .filter((item) => item !== null) as LLMKeywordCandidateClassification[];
  } catch (error) {
    console.error("Failed to parse LLM candidate classifications:", error);
    return [];
  }
}

async function generateRefinedServiceSeeds(
  weakServices: string[],
  business: any,
  businessContext: BusinessContextAnalysis,
  candidateKeywords: string[],
): Promise<Record<string, string[]>> {
  if (weakServices.length === 0) {
    return {};
  }

  const prompt = `You are refining DataForSEO seed keywords for weak service coverage.

Business:
- Name: ${business.businessName || "N/A"}
- Type: ${business.businessType || "N/A"}
- Description: ${business.businessDescription || "N/A"}
- Primary Services: ${businessContext.services.primary.join(", ") || "N/A"}
- Focus Areas: ${businessContext.keywordStrategy.focusAreas.join(", ") || "N/A"}

Weak services that need better keyword expansion:
${weakServices.map((service) => `- ${service}`).join("\n")}

Current candidate keyword examples:
${candidateKeywords.slice(0, 50).map((keyword) => `- ${keyword}`).join("\n")}

Return JSON only in this format:
{
  "service name": ["seed one", "seed two", "seed three"]
}

Rules:
- Return up to 3 refined DataForSEO seed terms per service
- Seeds must be realistic Google search terms
- Seeds must stay tightly aligned to the actual service
- Prefer topic, problem, comparison, or use-case phrasing over generic filler`;

  try {
    const response = await keywordLLM.invoke([
      {
        role: "system",
        content:
          "Return only valid JSON. Provide short, realistic search seed phrases.",
      },
      { role: "user", content: prompt },
    ]);

    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {};
    }
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const refinedSeeds: Record<string, string[]> = {};

    for (const service of weakServices) {
      const serviceSeeds = parsed[service];
      if (Array.isArray(serviceSeeds)) {
        refinedSeeds[service] = serviceSeeds
          .filter((seed): seed is string => typeof seed === "string")
          .map((seed) => seed.trim())
          .filter(Boolean)
          .slice(0, 3);
      }
    }

    return refinedSeeds;
  } catch (error) {
    console.warn("⚠️ Failed to generate refined service seeds:", error);
    return {};
  }
}

function buildFallbackCandidateClassification(
  candidate: KeywordCandidate,
  businessAreas: CanonicalBusinessArea[],
): LLMKeywordCandidateClassification {
  const canonicalBusinessArea =
    canonicalizeBusinessAreaName(
      candidate.canonicalBusinessArea ||
        candidate.aiSelectedService ||
        candidate.matchedService ||
        mapKeywordToBusinessArea(candidate.keyword, businessAreas),
      businessAreas,
    ) || null;
  const area = canonicalBusinessArea
    ? businessAreas.find((item) => item.name === canonicalBusinessArea)
    : null;
  const intent = inferKeywordIntent(candidate.keyword);
  const semanticCluster = deriveSemanticCluster(candidate.keyword);
  const awkwardPhrase = ["nvr video", "master electrical service"].includes(
    normalizeKeywordText(candidate.keyword),
  );
  const locationMismatch =
    candidate.businessAreaGroup !== "service" &&
    /\blocal\b/.test(normalizeKeywordText(candidate.keyword));
  const naturalnessScore = awkwardPhrase ? 0.35 : 0.75;

  return {
    keyword: candidate.keyword,
    canonicalBusinessArea,
    businessAreaGroup: area?.group,
    isBlogWorthy: !awkwardPhrase && !locationMismatch,
    naturalnessScore,
    semanticCluster,
    intent,
    selectionReason: canonicalBusinessArea
      ? "Heuristic business-area match"
      : "No confident business-area match",
    relevanceScore: candidate.relevanceScore ?? 0.75,
  };
}

async function classifyKeywordCandidatesByBusinessArea(params: {
  candidates: KeywordCandidate[];
  business: any;
  businessContext: BusinessContextAnalysis;
  businessAreas: CanonicalBusinessArea[];
}): Promise<Map<string, LLMKeywordCandidateClassification>> {
  const { candidates, business, businessContext, businessAreas } = params;
  const classificationMap = new Map<string, LLMKeywordCandidateClassification>();

  if (candidates.length === 0 || businessAreas.length === 0) {
    return classificationMap;
  }

  const areaLines = businessAreas
    .map(
      (area, index) =>
        `${index + 1}. ${area.name} [${area.group}] aliases: ${area.aliases.join(", ")}`,
    )
    .join("\n");

  const configuredConcurrency = Number.parseInt(
    process.env.KEYWORD_CLASSIFICATION_CONCURRENCY ?? "6",
    10,
  );
  const classificationConcurrency = Number.isFinite(configuredConcurrency)
    ? Math.min(8, Math.max(1, configuredConcurrency))
    : 6;
  const batches = chunkArray(candidates, 35);

  const batchResults = await mapWithConcurrency(
    batches,
    classificationConcurrency,
    async (batch) => {
      const candidateLines = batch
        .map(
          (candidate, candidateIndex) =>
            `${candidateIndex + 1}. "${candidate.keyword}" | volume=${
              candidate.monthlySearches ?? candidate.searchVolume ?? 0
            } | difficulty=${candidate.difficulty} | source=${candidate.sourceType}`,
        )
        .join("\n");

    const prompt = `You are classifying keyword candidates for a 30-day SEO blog plan.

Business:
- Name: ${business.businessName || "N/A"}
- Type: ${business.businessType || "N/A"}
- Description: ${business.businessDescription || "N/A"}
- Business model: ${businessContext.businessModel.type}
- Location dependent: ${businessContext.businessModel.isLocationDependent ? "yes" : "no"}
- Primary services/products: ${businessContext.services.primary.join(", ") || "N/A"}
- Secondary services/products: ${businessContext.services.secondary.join(", ") || "N/A"}
- Focus areas: ${businessContext.keywordStrategy.focusAreas.join(", ") || "N/A"}

Canonical business areas:
${areaLines}

Classify every keyword candidate and return JSON array only. For each keyword:
- canonicalBusinessArea must be one exact area name from the list above, or null if it does not clearly fit
- businessAreaGroup must be product or service when an area is chosen
- isBlogWorthy should be false for awkward phrases, thin service-page fragments, or bad blog topics
- naturalnessScore is 0.0 to 1.0
- semanticCluster should be a short reusable cluster label like "security camera", "commercial electrical", "nvr system"
- intent must be informational, commercial, transactional, or navigational
- selectionReason should be one short sentence
- relevanceScore is 0.0 to 1.0

Hard rules:
- If the business is not location dependent, reject "local", "near me", or city-modified keywords
- Reject awkward stump phrases like "nvr video"
- Reject repetitive installation/service variants that are too thin for a distinct blog post
- Prefer commercial or transactional intent when the keyword reads like a product evaluation, solution comparison, buying query, or purchase-driven query

Candidates:
${candidateLines}

Return this exact shape:
[
  {
    "keyword": "exact keyword",
    "canonicalBusinessArea": "exact area name or null",
    "businessAreaGroup": "product|service",
    "isBlogWorthy": true,
    "naturalnessScore": 0.82,
    "semanticCluster": "short label",
    "intent": "commercial",
    "selectionReason": "short reason",
    "relevanceScore": 0.91
  }
]`;

    try {
      const response = await keywordAnalysisLLM.invoke(
        [
          {
            role: "system",
            content:
              "Return only valid JSON. Classify each keyword carefully against the provided business areas.",
          },
          { role: "user", content: prompt },
        ],
        keywordLlmInvocationConfig(),
      );

      const raw =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      const parsed = parseCandidateClassifications(raw);

      return parsed;
    } catch (error) {
      console.warn("⚠️ Candidate classification batch failed:", error);
      return [];
    }
    },
  );

  for (const parsed of batchResults) {
    for (const classification of parsed) {
      classificationMap.set(
        normalizeKeywordText(classification.keyword),
        classification,
      );
    }
  }

  for (const candidate of candidates) {
    const key = normalizeKeywordText(candidate.keyword);
    if (!classificationMap.has(key)) {
      classificationMap.set(
        key,
        buildFallbackCandidateClassification(candidate, businessAreas),
      );
    }
  }

  return classificationMap;
}

/**
 * Pre-filter keywords to remove competitor names and location-only keywords
 */
function preFilterKeywords(
  keywords: any[],
  coreOfferings: any,
  businessContext: BusinessContextAnalysis,
): any[] {
  const canadianCities = [
    "toronto",
    "duffrin",
    "york",
    "mississauga",
    "vancouver",
    "calgary",
    "montreal",
    "ottawa",
    "edmonton",
    "winnipeg",
    "halifax",
    "victoria",
    "saskatoon",
    "regina",
    "hamilton",
    "kitchener",
    "london",
    "windsor",
    "oshawa",
    "barrie",
    "sudbury",
    "sherbrooke",
    "saguenay",
    "trois-rivières",
    "saint-john",
    "charlottetown",
    "fredericton",
    "moncton",
    "st-john's",
    "yellowknife",
    "whitehorse",
    "iqaluit",
  ];

  const usCities = [
    "new york",
    "los angeles",
    "chicago",
    "houston",
    "phoenix",
    "philadelphia",
    "san antonio",
    "san diego",
    "dallas",
    "san jose",
    "austin",
    "jacksonville",
    "fort worth",
    "columbus",
    "charlotte",
    "san francisco",
    "indianapolis",
    "seattle",
    "denver",
    "washington",
    "boston",
    "el paso",
    "detroit",
    "nashville",
    "portland",
    "oklahoma city",
    "las vegas",
    "memphis",
    "louisville",
    "baltimore",
  ];

  const allCities = [...canadianCities, ...usCities];

  const provinceStateTerms = [
    "ontario",
    "quebec",
    "british columbia",
    "alberta",
    "manitoba",
    "saskatchewan",
    "nova scotia",
    "new brunswick",
    "newfoundland",
    "pei",
    "prince edward island",
    "yukon",
    "northwest territories",
    "nunavut",
    "california",
    "texas",
    "florida",
    "new york",
    "illinois",
    "pennsylvania",
    "ohio",
    "georgia",
    "michigan",
    "arizona",
    "washington",
    "massachusetts",
    "colorado",
    "virginia",
    "oregon",
  ];

  const pureLocationModifiers = [
    "to",
    "in",
    "near",
    "around",
    "area",
    "location",
    "city",
    "downtown",
    "uptown",
    "east",
    "west",
    "north",
    "south",
    "port",
    "credit",
    "canada",
    "usa",
    "united states",
  ];

  const isPureLocationKeyword = (keyword: string): boolean => {
    const words = keyword.split(/\s+/).filter((w) => w.length > 1);

    let locationWordCount = 0;
    let nonLocationWordCount = 0;

    for (const word of words) {
      const wordLower = word.toLowerCase();
      const isLocationWord =
        allCities.includes(wordLower) ||
        provinceStateTerms.includes(wordLower) ||
        pureLocationModifiers.includes(wordLower);

      if (isLocationWord) {
        locationWordCount++;
      } else {
        nonLocationWordCount++;
      }
    }

    if (locationWordCount > 0 && nonLocationWordCount === 0) {
      return true;
    }

    return false;
  };

  return keywords.filter((kw) => {
    const keywordLower = kw.keyword.toLowerCase().trim();

    for (const competitor of coreOfferings.competitorNames || []) {
      if (competitor && keywordLower.includes(competitor.toLowerCase())) {
        console.log(`🚫 Rejected competitor keyword: "${kw.keyword}"`);
        return false;
      }
    }

    const mentionsService =
      (coreOfferings.primaryOfferings || []).some((offering: string) =>
        keywordLower.includes(offering.toLowerCase()),
      ) ||
      (coreOfferings.serviceTypes || []).some((type: string) =>
        keywordLower.includes(type.toLowerCase()),
      );

    const mentionsIndustry = keywordLower.includes(
      businessContext.market.industry.vertical.toLowerCase(),
    );

    if (mentionsService || mentionsIndustry) {
      return true;
    }

    if (isPureLocationKeyword(keywordLower)) {
      console.log(`🚫 Rejected pure location keyword: "${kw.keyword}"`);
      return false;
    }

    const locationOnlyPattern = new RegExp(
      `^(${allCities.join(
        "|",
      )})(\\s+(to|in|near|around|area|location|city|downtown|uptown|east|west|north|south|ontario|quebec|canada|port|credit))*(\\s+(${allCities.join(
        "|",
      )}))?$`,
      "i",
    );

    if (locationOnlyPattern.test(keywordLower)) {
      console.log(`🚫 Rejected location pattern keyword: "${kw.keyword}"`);
      return false;
    }

    return true;
  });
}

/**
 * Helper: Get location code — now uses shared city-aware utility from
 * location.utils.ts (supports 54+ metro-level codes for CA/US cities).
 * The local country-only stub has been removed.
 *
 * @see ../../utils/location.utils.ts getLocationCode
 */

/**
 * Verify keywords and regenerate invalid ones
 */
async function verifyAndRegenerateKeywords(
  selectedKeywords: Array<{ keyword: string }>,
  availableKeywords: any[],
  business: any,
  businessContext: BusinessContextAnalysis,
  existingKeywordTexts: Set<string>,
  coreOfferings?: CoreOfferings,
): Promise<Array<{ keyword: string }>> {
  const keywordTexts = selectedKeywords.map((kw) => kw.keyword);

  console.log("🔍 Starting keyword verification with verification agent...");
  const verificationResults = await verifyKeywords(
    keywordTexts,
    business,
    businessContext,
    coreOfferings,
  );

  const validKeywords: Array<{ keyword: string }> = [];
  const invalidKeywords: string[] = [];

  verificationResults.forEach((result) => {
    if (result.isValid && result.relevanceScore >= 0.6) {
      validKeywords.push({ keyword: result.keyword });
    } else {
      invalidKeywords.push(result.keyword);
      console.log(
        `❌ Invalid keyword: "${result.keyword}" - ${
          result.reason
        } (relevance: ${result.relevanceScore.toFixed(2)})`,
      );
    }
  });

  if (invalidKeywords.length === 0) {
    console.log("✅ All keywords passed verification!");
    return validKeywords;
  }

  console.log(`🔄 Regenerating ${invalidKeywords.length} invalid keywords...`);

  const selectedSet = new Set(
    validKeywords.map((kw) => kw.keyword.toLowerCase().trim()),
  );

  const replacementKeywords: Array<{ keyword: string }> = [];

  for (const invalidKeyword of invalidKeywords) {
    const availablePool = availableKeywords
      .filter(
        (kw) =>
          !selectedSet.has(kw.keyword.toLowerCase().trim()) &&
          !existingKeywordTexts.has(kw.keyword.toLowerCase().trim()) &&
          kw.keyword.toLowerCase().trim() !==
            invalidKeyword.toLowerCase().trim(),
      )
      .sort((a, b) => {
        const aPotential = calculateTrafficPotential(a, businessContext);
        const bPotential = calculateTrafficPotential(b, businessContext);
        return bPotential - aPotential;
      });

    let replacementFound = false;

    for (const candidate of availablePool.slice(0, 50)) {
      const candidateVerification = await verifyKeyword(
        candidate.keyword,
        business,
        businessContext,
        coreOfferings,
      );

      if (
        candidateVerification.isValid &&
        candidateVerification.relevanceScore >= 0.6
      ) {
        replacementKeywords.push({ keyword: candidate.keyword });
        selectedSet.add(candidate.keyword.toLowerCase().trim());
        console.log(
          `✅ Replaced "${invalidKeyword}" with "${
            candidate.keyword
          }" (relevance: ${candidateVerification.relevanceScore.toFixed(2)})`,
        );
        replacementFound = true;
        break;
      }
    }

    if (!replacementFound) {
      const bestAvailable = availablePool.filter((kw) => {
        const kwLower = kw.keyword.toLowerCase();
        return (
          !kwLower.includes("jimmy") &&
          !kwLower.includes("mr greek") &&
          !kwLower.includes("mr. greek") &&
          !kwLower.includes("competitor")
        );
      })[0];

      if (bestAvailable) {
        replacementKeywords.push({ keyword: bestAvailable.keyword });
        selectedSet.add(bestAvailable.keyword.toLowerCase().trim());
        console.log(
          `⚠️ Using best available replacement for "${invalidKeyword}": "${bestAvailable.keyword}"`,
        );
      } else {
        console.warn(
          `⚠️ No replacement found for "${invalidKeyword}", will generate new keyword`,
        );
      }
    }
  }

  const finalKeywords = [...validKeywords, ...replacementKeywords];

  console.log(
    `✅ Verification complete: ${finalKeywords.length} verified keywords ready for 30-day plan (LLM selected, no truncation)`,
  );

  return finalKeywords;
}

/**
 * Validate and refine keywords against strategy
 */
async function validateAndRefineKeywords(
  selectedKeywords: Array<{ keyword: string }>,
  availableKeywords: any[],
  businessContext: BusinessContextAnalysis,
  locationCode: number,
  business: any,
  coreOfferings: CoreOfferings,
  existingKeywordTexts: Set<string>,
  languageCode: string = "en",
): Promise<Array<{ keyword: string }>> {
  const validated: Array<{ keyword: string }> = [];
  const keywordMap = new Map<string, any>();

  for (const kw of availableKeywords) {
    keywordMap.set(kw.keyword.toLowerCase().trim(), kw);
  }

  const selectedMap = new Map<string, { keyword: string }>();
  for (const kw of selectedKeywords) {
    selectedMap.set(kw.keyword.toLowerCase().trim(), kw);
  }

  const mustHaveSet = new Set(
    businessContext.keywordStrategy.mustHaveKeywords.map((k) =>
      k.toLowerCase(),
    ),
  );

  const intentCounts = {
    informational: 0,
    commercial: 0,
    transactional: 0,
    navigational: 0,
  };

  const difficultyCounts = {
    easy: 0,
    medium: 0,
    hard: 0,
  };

  const lowTrafficKeywords: Array<{
    keyword: string;
    trafficPotential: number;
  }> = [];

  for (const selected of selectedKeywords) {
    const keywordLower = selected.keyword.toLowerCase().trim();
    const realData = keywordMap.get(keywordLower);

    if (!realData) {
      continue;
    }

    const trafficPotential = calculateTrafficPotential(
      realData,
      businessContext,
    );

    if (trafficPotential < 0.2) {
      lowTrafficKeywords.push({ keyword: selected.keyword, trafficPotential });
      continue;
    }

    const difficulty = realData.difficulty || 50;
    if (
      difficulty <
      businessContext.keywordStrategy.difficultyDistribution.easy.max
    ) {
      difficultyCounts.easy++;
    } else if (
      difficulty <
      businessContext.keywordStrategy.difficultyDistribution.medium.max
    ) {
      difficultyCounts.medium++;
    } else {
      difficultyCounts.hard++;
    }

    const keywordLower2 = selected.keyword.toLowerCase();
    if (keywordLower2.match(/best|top|review|compare|vs|alternative|rating/)) {
      intentCounts.commercial++;
    } else if (
      keywordLower2.match(/buy|price|order|cost|purchase|hire|book|quote/)
    ) {
      intentCounts.transactional++;
    } else if (keywordLower2.match(/near me|in \w+|local|\w+ \w+ area/)) {
      intentCounts.navigational++;
    } else {
      intentCounts.informational++;
    }

    validated.push(selected);
  }

  const targetEasy =
    businessContext.keywordStrategy.difficultyDistribution.easy.count;
  const targetMedium =
    businessContext.keywordStrategy.difficultyDistribution.medium.count;
  const targetHard =
    businessContext.keywordStrategy.difficultyDistribution.hard.count;

  const targetInformational = Math.round(
    30 *
      (businessContext.keywordStrategy.intentDistribution.informational / 100),
  );
  const targetCommercial = Math.round(
    30 * (businessContext.keywordStrategy.intentDistribution.commercial / 100),
  );
  const targetTransactional = Math.round(
    30 *
      (businessContext.keywordStrategy.intentDistribution.transactional / 100),
  );
  const targetNavigational = Math.round(
    30 *
      (businessContext.keywordStrategy.intentDistribution.navigational / 100),
  );

  console.log(`📊 Strategy validation:`);
  console.log(
    `   Difficulty: Easy ${difficultyCounts.easy}/${targetEasy}, Medium ${difficultyCounts.medium}/${targetMedium}, Hard ${difficultyCounts.hard}/${targetHard}`,
  );
  console.log(
    `   Intent: Informational ${intentCounts.informational}/${targetInformational}, Commercial ${intentCounts.commercial}/${targetCommercial}, Transactional ${intentCounts.transactional}/${targetTransactional}, Navigational ${intentCounts.navigational}/${targetNavigational}`,
  );

  if (lowTrafficKeywords.length > 0 && validated.length < 30) {
    console.log(
      `🔄 Fetching related keywords for ${lowTrafficKeywords.length} low-traffic keywords...`,
    );

    const relatedKeywords = await getRelatedKeywordsWithDifficulty(
      lowTrafficKeywords.slice(0, 5).map((k) => k.keyword),
      locationCode,
      languageCode,
      20,
    );

    for (const related of relatedKeywords) {
      if (validated.length >= 30) break;

      const relatedLower = related.keyword.toLowerCase().trim();
      if (selectedMap.has(relatedLower)) continue;

      const relatedTrafficPotential = calculateTrafficPotential(
        {
          keyword: related.keyword,
          searchVolume: related.searchVolume,
          difficulty: related.difficulty,
          cpc: related.metrics.cpc || 0,
          trend: related.metrics.trend || [],
        },
        businessContext,
      );

      if (relatedTrafficPotential > 0.4) {
        validated.push({ keyword: related.keyword });
        selectedMap.set(relatedLower, { keyword: related.keyword });
        console.log(
          `✅ Replaced low-traffic keyword with related: "${
            related.keyword
          }" (traffic potential: ${relatedTrafficPotential.toFixed(2)})`,
        );
      }
    }
  }

  const mustHaveIncluded =
    businessContext.keywordStrategy.mustHaveKeywords.filter((mustHave) => {
      const mustHaveLower = mustHave.toLowerCase();
      return Array.from(validated.values()).some((kw) =>
        kw.keyword.toLowerCase().includes(mustHaveLower),
      );
    }).length;

  if (
    mustHaveIncluded < businessContext.keywordStrategy.mustHaveKeywords.length
  ) {
    console.log(
      `⚠️ Only ${mustHaveIncluded}/${businessContext.keywordStrategy.mustHaveKeywords.length} must-have keywords included`,
    );
  } else {
    console.log(`✅ All ${mustHaveIncluded} must-have keywords included`);
  }

  let finalKeywords = [...validated];

  if (finalKeywords.length < 30) {
    console.log(
      `🔄 Filling remaining ${
        30 - finalKeywords.length
      } slots from available keyword pool...`,
    );

    const selectedSet = new Set(
      finalKeywords.map((kw) => kw.keyword.toLowerCase().trim()),
    );

    const remaining = availableKeywords.filter((kw) => {
      const kwLower = kw.keyword.toLowerCase().trim();
      return (
        !selectedSet.has(kwLower) &&
        !existingKeywordTexts.has(kwLower) &&
        !kwLower.includes("jimmy") &&
        !kwLower.includes("mr greek") &&
        !kwLower.includes("mr. greek") &&
        !kwLower.includes("competitor")
      );
    });

    const sortedRemaining = remaining
      .map((kw) => ({
        keyword: kw.keyword,
        trafficPotential: calculateTrafficPotential(kw, businessContext),
        data: kw,
      }))
      .sort((a, b) => b.trafficPotential - a.trafficPotential)
      .slice(0, 30 - finalKeywords.length);

    for (const candidate of sortedRemaining) {
      if (finalKeywords.length >= 30) break;

      const candidateVerification = await verifyKeyword(
        candidate.keyword,
        business,
        businessContext,
        coreOfferings,
      );

      if (
        candidateVerification.isValid &&
        candidateVerification.relevanceScore >= 0.6
      ) {
        finalKeywords.push({ keyword: candidate.keyword });
        selectedSet.add(candidate.keyword.toLowerCase().trim());
      } else if (candidate.trafficPotential > 0.2) {
        finalKeywords.push({ keyword: candidate.keyword });
        selectedSet.add(candidate.keyword.toLowerCase().trim());
        console.log(
          `⚠️ Added keyword with lower relevance: "${
            candidate.keyword
          }" (relevance: ${candidateVerification.relevanceScore.toFixed(
            2,
          )}, traffic: ${candidate.trafficPotential.toFixed(2)})`,
        );
      }
    }
  }

  console.log(
    `✅ Verification complete: ${finalKeywords.length} verified keywords ready for 30-day plan`,
  );

  return finalKeywords.slice(0, 30);
}

/**
 * 30-DAY KEYWORD GENERATION (Optimized DataForSEO-first approach)
 * Works for both initial and ongoing generation
 * @param keywords - Business info as JSON string
 * @param userId - User ID
 * @param previousKeywords - Optional: Previous keywords as JSON string (for ongoing generation)
 */
export async function generateKeywordLLM(
  keywords: string,
  userId: string,
  previousKeywords?: string,
) {
  try {
    const business = JSON.parse(keywords);

    console.log("🧠 Starting intelligent keyword strategy system...");

    const businessContext = await analyzeBusinessContext(business);
    console.log("✅ Business context analysis completed");

    const coreOfferings = await extractCoreOfferings(business);
    console.log("✅ Core offerings extraction completed");

    const coreServices = resolveEffectiveServices(business);

    // 🆕 NEW: Extract REAL services AND sub-offerings (including technologies, frameworks, tools) from website analysis
    const topLevelServices: string[] =
      coreServices?.topLevel || businessContext.services.primary || [];

    const subOfferings: string[] = coreServices?.subOfferings || [];

    // 🆕 NEW: Get business ID first (needed for ServiceTaxonomy lookup)
    let businessId = business.id;
    if (!businessId && business.userId) {
      const businessRecord = await prisma.business.findFirst({
        where: {
          userId: business.userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
      businessId = businessRecord?.id;
    }

    // 🆕 Log which business is being used for keyword generation
    if (businessId) {
      console.log(
        `🔍 Generating keywords for business: ${businessId} (${business.businessName || "Unknown"}) - Website: ${business.businessWebsiteUrl || "Unknown"}`,
      );
    } else {
      console.warn(
        `⚠️ No businessId found for business: ${business.businessName || "Unknown"}`,
      );
    }

    // 🆕 NEW: Extract technologies from ServiceTaxonomy and techStack
    let technologies: string[] = [];
    if (businessId) {
      const serviceTaxonomies = await prisma.serviceTaxonomy.findMany({
        where: { businessId },
        select: { technologies: true },
      });
      technologies = serviceTaxonomies.flatMap((st) => st.technologies || []);
    }

    // 🆕 NEW: Extract technologies from techStack if available
    const techStack = business.websiteAnalysis?.techStack || business.techStack;
    if (techStack) {
      const techStackTechnologies = [
        ...(techStack.frontend || []),
        ...(techStack.backend || []),
        ...(techStack.database || []),
        ...(techStack.automation || []),
      ];
      technologies = [...technologies, ...techStackTechnologies];
    }

    // Remove duplicates
    technologies = Array.from(new Set(technologies));

    // 🆕 NEW: Combine sub-offerings with technologies, frameworks, and tools
    // Sub-offerings now include: specific services, technologies, frameworks, tools, and related topics
    const expandedSubOfferings = [...subOfferings, ...technologies];

    const realServices: string[] = [
      ...topLevelServices,
      ...expandedSubOfferings,
    ];

    console.log(`📋 Top-level services: ${topLevelServices.join(", ")}`);
    console.log(
      `📋 Sub-offerings (services, technologies, frameworks, tools): ${
        expandedSubOfferings.length > 0
          ? expandedSubOfferings.join(", ")
          : "None"
      }`,
    );
    console.log(
      `📋 Technologies/Frameworks found: ${
        technologies.length > 0 ? technologies.join(", ") : "None"
      }`,
    );
    console.log(
      `📋 Total services + sub-offerings + technologies for keyword discovery: ${realServices.length}`,
    );

    // 🆕 NEW: Initialize 6-step keyword discovery services
    const smartDiscovery = new SmartKeywordDiscoveryService();
    const keywordAllocation = new KeywordAllocationService();
    const competitorIntelligence = new CompetitorIntelligenceService();

    // 🆕 NEW: Get DataForSEO target using language + market compatibility.
    const dataForSEOTarget = resolveDataForSEOKeywordTarget(
      business,
      businessContext,
    );
    const locationScope = businessContext.businessModel.isLocationDependent
      ? keywordAllocation.getLocationScope(
          business.businessCity,
          business.businessCountry,
        )
      : dataForSEOTarget.locationCountry;

    // 🆕 FIX: Calculate location code BEFORE using it in 6-step discovery
    const locationCode = dataForSEOTarget.locationCode;
    const dataForSEOLanguageCode = dataForSEOTarget.languageCode;
    console.log(
      `📍 Using DataForSEO target: ${dataForSEOTarget.reason} (code: ${locationCode})`,
    );

    // 🆕 NEW: Extract domain from website URL
    const websiteUrl =
      business.businessWebsiteUrl || business.website || business.websiteURL;
    const domain = websiteUrl
      ? websiteUrl
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0]
      : null;

    const primaryServices = businessContext.services.primary;
    const focusAreas = businessContext.keywordStrategy.focusAreas;
    const candidateSourceCounts = new Map<string, number>();

    const incrementSourceCount = (sourceType: string) => {
      candidateSourceCounts.set(
        sourceType,
        (candidateSourceCounts.get(sourceType) ?? 0) + 1,
      );
    };

    const createCandidate = (
      kw: any,
      sourceType: KeywordSourceType,
      sourceLabel: string | null,
      originSeeds: string[],
      refinementRound: number,
      matchedServiceHint?: string | null,
    ): KeywordCandidate | null => {
      const keywordText = typeof kw.keyword === "string" ? kw.keyword.trim() : "";
      if (!keywordText) {
        return null;
      }

      const searchVolume =
        typeof kw.searchVolume === "number"
          ? kw.searchVolume
          : typeof kw.monthlySearches === "number"
            ? kw.monthlySearches
            : 0;
      const difficulty =
        typeof kw.difficulty === "number" ? kw.difficulty : 50;
      const competition =
        typeof kw.competition === "number"
          ? kw.competition
          : typeof kw.competition === "string"
            ? parseFloat(kw.competition)
            : null;

      return {
        keyword: keywordText,
        searchVolume,
        difficulty,
        cpc: typeof kw.cpc === "number" ? kw.cpc : null,
        competition:
          competition !== null && Number.isFinite(competition)
            ? competition
            : null,
        trend: Array.isArray(kw.trend) ? kw.trend : [],
        monthlySearches:
          typeof kw.monthlySearches === "number" ? kw.monthlySearches : null,
        clicks: typeof kw.clicks === "number" ? kw.clicks : null,
        impressions:
          typeof kw.impressions === "number" ? kw.impressions : null,
        ctr: typeof kw.ctr === "number" ? kw.ctr : null,
        sourceType,
        allSources: [sourceType],
        sourceLabel,
        originSeeds,
        matchedService:
          matchedServiceHint ||
          mapKeywordToService(keywordText, primaryServices, focusAreas),
        refinementRound,
      };
    };

    const upsertCandidate = (
      candidateMap: Map<string, KeywordCandidate>,
      candidate: KeywordCandidate | null,
    ) => {
      if (!candidate) {
        return;
      }
      const key = normalizeKeywordText(candidate.keyword);
      const merged = mergeKeywordCandidate(candidateMap.get(key), candidate);
      candidateMap.set(key, merged);
      incrementSourceCount(candidate.sourceType);
    };

    // 🆕 NEW: Use 6-step discovery flow if we have domain and real services
    let uniqueOpportunities: KeywordCandidate[] = [];
    if (domain && realServices.length > 0 && businessId) {
      console.log("🚀 Using 6-step data-driven keyword discovery flow...");

      try {
        const rawOpportunities =
          await smartDiscovery.generateUniqueKeywordOpportunities(
            businessId,
            domain,
            realServices,
            business.businessType || "",
            locationCode,
            locationScope,
            200,
            dataForSEOLanguageCode,
            businessContext.businessModel.isLocationDependent
              ? business.businessCity ?? null
              : null,
          );

        uniqueOpportunities = rawOpportunities
          .map((opp) =>
            createCandidate(
              {
                keyword: opp.keyword,
                searchVolume: opp.searchVolume,
                difficulty: opp.difficulty,
                cpc: opp.cpc,
                competition:
                  typeof opp.difficulty === "number"
                    ? opp.difficulty / 100
                    : null,
                monthlySearches: opp.searchVolume,
                clicks: 0,
                impressions: 0,
                ctr: 0,
                trend: [],
              },
              opp.source === "own"
                ? "domain"
                : opp.source === "gap"
                  ? "gap"
                  : "competitor",
              opp.competitorDomain ?? opp.source,
              opp.competitorDomain ? [opp.competitorDomain] : [],
              0,
            ),
          )
          .filter(
            (candidate): candidate is KeywordCandidate => candidate !== null,
          );

        console.log(
          `✅ 6-step discovery found ${uniqueOpportunities.length} unique opportunities`,
        );
      } catch (error: any) {
        console.warn(
          `⚠️ 6-step discovery failed: ${error.message}, falling back to standard flow`,
        );
      }
    }

    const seedKeywords: string[] = [];

    seedKeywords.push(...businessContext.keywordStrategy.mustHaveKeywords);

    seedKeywords.push(...businessContext.services.primary);

    // 🆕 NEW: Include sub-offerings and technologies in seed keywords for more comprehensive coverage
    if (expandedSubOfferings.length > 0) {
      seedKeywords.push(...expandedSubOfferings.slice(0, 15));
      console.log(
        `📋 Added ${Math.min(
          expandedSubOfferings.length,
          15,
        )} sub-offerings/technologies to seed keywords`,
      );
    }

    if (businessContext.market.industry.vertical) {
      seedKeywords.push(businessContext.market.industry.vertical);
    }
    if (businessContext.market.industry.subVertical) {
      seedKeywords.push(
        ...businessContext.market.industry.subVertical.slice(0, 3),
      );
    }

    if (businessContext.market.customerSegment.primary) {
      seedKeywords.push(businessContext.market.customerSegment.primary);
    }

    if (business.businessName) seedKeywords.push(business.businessName);
    if (business.businessType) seedKeywords.push(business.businessType);

    if (business.businessDescription) {
      const descWords = business.businessDescription
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 4)
        .slice(0, 5);
      seedKeywords.push(...descWords);
    }

    const uniqueSeeds = Array.from(
      new Set(seedKeywords.map((s) => s.toLowerCase())),
    ).slice(0, 20);

    if (uniqueSeeds.length === 0) {
      console.warn("⚠️ No seed keywords found, using business name");
      uniqueSeeds.push(business.businessName || "business");
    }

    console.log(
      `🌱 Using ${uniqueSeeds.length} strategic seed keywords: ${uniqueSeeds
        .slice(0, 5)
        .join(", ")}...`,
    );

    const keywordSourceRequests: Array<{
      sourceType: KeywordSourceType;
      sourceLabel: string | null;
      originSeeds: string[];
      matchedServiceHint?: string | null;
      refinementRound: number;
      promise: Promise<any[]>;
    }> = [];

    if (businessContext.services.primary.length > 0) {
      keywordSourceRequests.push({
        sourceType: "service_seed",
        sourceLabel: "primary_services",
        originSeeds: businessContext.services.primary.slice(0, 3),
        matchedServiceHint: null,
        refinementRound: 0,
        promise: getKeywordSuggestionsWithMetrics(
          businessContext.services.primary.slice(0, 3),
          locationCode,
          dataForSEOLanguageCode,
          50,
        ),
      });
    }

    const industryTerms = [
      businessContext.market.industry.vertical,
      ...(businessContext.market.industry.subVertical || []).slice(0, 2),
    ].filter(Boolean);
    if (industryTerms.length > 0) {
      keywordSourceRequests.push({
        sourceType: "service_seed",
        sourceLabel: "industry_terms",
        originSeeds: industryTerms,
        matchedServiceHint: null,
        refinementRound: 0,
        promise: getKeywordSuggestionsWithMetrics(
          industryTerms,
          locationCode,
          dataForSEOLanguageCode,
          50,
        ),
      });
    }

    if (
      businessContext.businessModel.isLocationDependent &&
      (businessContext.market.geographic.scope === "local" ||
        businessContext.market.geographic.scope === "regional")
    ) {
      const locationTerms = [
        ...businessContext.services.primary.slice(0, 2),
        businessContext.market.geographic.primary,
      ];
      keywordSourceRequests.push({
        sourceType: "service_seed",
        sourceLabel: "location_terms",
        originSeeds: locationTerms,
        matchedServiceHint: null,
        refinementRound: 0,
        promise: getKeywordSuggestionsWithMetrics(
          locationTerms,
          locationCode,
          dataForSEOLanguageCode,
          30,
        ),
      });
    }

    if (businessContext.keywordStrategy.mustHaveKeywords.length > 0) {
      keywordSourceRequests.push({
        sourceType: "service_seed",
        sourceLabel: "must_have_terms",
        originSeeds: businessContext.keywordStrategy.mustHaveKeywords.slice(0, 5),
        matchedServiceHint: null,
        refinementRound: 0,
        promise: getKeywordSuggestionsWithMetrics(
          businessContext.keywordStrategy.mustHaveKeywords.slice(0, 5),
          locationCode,
          dataForSEOLanguageCode,
          30,
        ),
      });
    }

    // Use existing websiteUrl and domain variables (already declared above)
    if (websiteUrl && domain) {
      try {
        keywordSourceRequests.push({
          sourceType: "domain",
          sourceLabel: domain,
          originSeeds: [domain],
          matchedServiceHint: null,
          refinementRound: 0,
          promise: getKeywordsForDomainFromDataForSEO(
            domain,
            locationCode,
            dataForSEOLanguageCode,
            50,
          ).catch(() => []),
        });
      } catch (e) {}
    }

    const keywordResults = await Promise.all(
      keywordSourceRequests.map(async (request) => ({
        request,
        results: await request.promise.catch(() => []),
      })),
    );
    const allKeywordsMap = new Map<string, KeywordCandidate>();

    for (const opportunity of uniqueOpportunities) {
      upsertCandidate(allKeywordsMap, opportunity);
    }

    if (uniqueOpportunities.length > 0) {
      console.log(
        `✅ Added ${uniqueOpportunities.length} keywords from 6-step discovery`,
      );
    }

    for (const { request, results } of keywordResults) {
      if (!Array.isArray(results)) {
        continue;
      }

      for (const kw of results) {
        upsertCandidate(
          allKeywordsMap,
          createCandidate(
            kw,
            request.sourceType,
            request.sourceLabel,
            request.originSeeds,
            request.refinementRound,
            request.matchedServiceHint,
          ),
        );
      }
    }

    let allKeywords = Array.from(allKeywordsMap.values());
    console.log(
      `✅ Collected ${allKeywords.length} unique keywords from all sources (including 6-step discovery)`,
    );

    // 🚀 IMPROVEMENT 3: Advanced filtering and scoring
    const MIN_SEARCH_VOLUME = 10; // Lower threshold for more variety
    const MAX_DIFFICULTY = 90; // Exclude extremely competitive keywords

    let filteredKeywords = allKeywords
      .filter((kw) => {
        const volume = kw.searchVolume || 0;
        const difficulty = kw.difficulty || 100;
        const wordCount = kw.keyword.split(" ").length;
        const keywordLower = kw.keyword.toLowerCase();

        if (
          !businessContext.businessModel.isLocationDependent &&
          businessContext.businessModel.type === "product"
        ) {
          const locationPatterns = [
            /in \w+$/,
            /near me$/,
            /\w+ \w+ area$/,
            /\w+ \w+ city$/,
            /in \w+ \w+$/,
            /\w+ \w+ location$/,
          ];
          const hasLocation = locationPatterns.some((pattern) =>
            pattern.test(keywordLower),
          );
          if (hasLocation) {
            return false;
          }
        }

        return (
          volume >= MIN_SEARCH_VOLUME &&
          difficulty <= MAX_DIFFICULTY &&
          wordCount >= 2 &&
          wordCount <= 8
        );
      })
      .map((kw) => {
        const trendGrowth = calculateTrendGrowth(kw.trend || []);
        const relevanceScore = calculateRelevanceScore(
          kw.keyword,
          business,
          coreServices,
        );
        const baseScore = calculateKeywordScore(
          kw,
          business,
          trendGrowth,
          coreServices,
        );
        const trafficPotential = calculateTrafficPotential(kw, businessContext);
        return {
          ...kw,
          score: baseScore,
          trendGrowth,
          relevanceScore,
          trafficPotential,
        };
      })
      .sort((a, b) => {
        if (Math.abs(a.trafficPotential - b.trafficPotential) > 0.1) {
          return b.trafficPotential - a.trafficPotential;
        }
        if (Math.abs(a.relevanceScore - b.relevanceScore) > 0.3) {
          return b.relevanceScore - a.relevanceScore;
        }
        return b.score - a.score;
      });

    console.log(
      `🔍 Filtered to ${filteredKeywords.length} high-quality keywords with advanced scoring`,
    );

    for (let refinementRound = 1; refinementRound <= 2; refinementRound++) {
      const serviceCandidateCounts = new Map<string, number>();
      for (const service of primaryServices) {
        serviceCandidateCounts.set(
          service,
          filteredKeywords.filter((candidate) => {
            const matchedService =
              candidate.matchedService ||
              mapKeywordToService(candidate.keyword, primaryServices, focusAreas);
            return matchedService === service;
          }).length,
        );
      }

      const weakServices = primaryServices.filter(
        (service) => (serviceCandidateCounts.get(service) ?? 0) < 4,
      );

      if (filteredKeywords.length >= 60 && weakServices.length === 0) {
        break;
      }

      console.log(
        `🧠 Refinement round ${refinementRound}: ${filteredKeywords.length} candidates, weak services: ${
          weakServices.join(", ") || "none"
        }`,
      );

      const refinedSeedsByService = await generateRefinedServiceSeeds(
        weakServices.slice(0, 5),
        business,
        businessContext,
        filteredKeywords.map((candidate) => candidate.keyword),
      );

      const refinementRequests = Object.entries(refinedSeedsByService).filter(
        ([, seeds]) => seeds.length > 0,
      );

      if (refinementRequests.length === 0) {
        break;
      }

      const refinementResults = await Promise.all(
        refinementRequests.map(async ([service, seeds]) => ({
          service,
          seeds,
          results: await getKeywordSuggestionsWithMetrics(
            seeds,
            locationCode,
            dataForSEOLanguageCode,
            20,
          ).catch(() => []),
        })),
      );

      for (const { service, seeds, results } of refinementResults) {
        for (const result of results) {
          upsertCandidate(
            allKeywordsMap,
            createCandidate(
              result,
              "refinement",
              service,
              seeds,
              refinementRound,
              service,
            ),
          );
        }
      }

      allKeywords = Array.from(allKeywordsMap.values());
      filteredKeywords = allKeywords
        .filter((kw) => {
          const volume = kw.searchVolume || 0;
          const difficulty = kw.difficulty || 100;
          const wordCount = kw.keyword.split(" ").length;
          const keywordLower = kw.keyword.toLowerCase();

          if (
            !businessContext.businessModel.isLocationDependent &&
            businessContext.businessModel.type === "product"
          ) {
            const locationPatterns = [
              /in \w+$/,
              /near me$/,
              /\w+ \w+ area$/,
              /\w+ \w+ city$/,
              /in \w+ \w+$/,
              /\w+ \w+ location$/,
            ];
            const hasLocation = locationPatterns.some((pattern) =>
              pattern.test(keywordLower),
            );
            if (hasLocation) {
              return false;
            }
          }

          return (
            volume >= MIN_SEARCH_VOLUME &&
            difficulty <= MAX_DIFFICULTY &&
            wordCount >= 2 &&
            wordCount <= 8
          );
        })
        .map((kw) => {
          const trendGrowth = calculateTrendGrowth(kw.trend || []);
          const relevanceScore = calculateRelevanceScore(
            kw.keyword,
            business,
            coreServices,
          );
          const baseScore = calculateKeywordScore(
            kw,
            business,
            trendGrowth,
            coreServices,
          );
          const trafficPotential = calculateTrafficPotential(
            kw,
            businessContext,
          );
          return {
            ...kw,
            score: baseScore,
            trendGrowth,
            relevanceScore,
            trafficPotential,
          };
        })
        .sort((a, b) => {
          if (Math.abs(a.trafficPotential - b.trafficPotential) > 0.1) {
            return b.trafficPotential - a.trafficPotential;
          }
          if (Math.abs(a.relevanceScore - b.relevanceScore) > 0.3) {
            return b.relevanceScore - a.relevanceScore;
          }
          return b.score - a.score;
        });
    }

    if (filteredKeywords.length === 0) {
      console.warn("⚠️ No keywords passed filtering, falling back to LLM-only");
      return await fallbackToLLMGeneration(business, userId, businessId);
    }

    // 🚀 IMPROVEMENT: Let LLM be the primary filter - show all keywords with context
    // Remove hard-coded relevance filtering - LLM will decide based on business context
    let realKeywordSuggestions: KeywordCandidate[] = filteredKeywords;

    console.log(
      `✅ Prepared ${realKeywordSuggestions.length} keywords for LLM intelligent filtering`,
    );

    const preFilteredKeywords = preFilterKeywords(
      realKeywordSuggestions,
      coreOfferings,
      businessContext,
    );

    console.log(
      `🔍 Pre-filtered to ${preFilteredKeywords.length} keywords (removed competitors and location-only keywords)`,
    );

    let keywordsForLLM: KeywordCandidate[] =
      preFilteredKeywords.length > 0
        ? preFilteredKeywords
        : realKeywordSuggestions;

    // Parse previous keywords if provided
    let previousKeywordsArray: any[] = [];
    if (previousKeywords) {
      try {
        previousKeywordsArray = JSON.parse(previousKeywords);
      } catch (e) {
        console.warn("Failed to parse previous keywords");
      }
    }

    const isOngoing = previousKeywordsArray.length > 0;
    const previousKeywordsText = isOngoing
      ? `\n\nPrevious ${
          previousKeywordsArray.length
        } Keywords Used (avoid similar topics):
${previousKeywordsArray
  .slice(0, 10)
  .map((k: any) => `- ${k.keyword}`)
  .join("\n")}`
      : "";

    // 🆕 FIX: Get existing keywords and topics from database for THIS specific business only
    // Include legacy keywords (null businessId) if this is the primary business
    let keywordWhere: any = {
      userId,
      deletedAt: null,
    };

    if (businessId) {
      // Check if this is the primary business
      const businessRecord = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId: userId,
          isActive: true,
        },
        select: { id: true, isPrimary: true },
      });

      if (businessRecord?.isPrimary) {
        // Primary business: include its keywords + legacy keywords (null businessId)
        keywordWhere.OR = [
          { businessId: businessId },
          { businessId: null }, // Legacy keywords
        ];
      } else {
        // Non-primary business: only show its own keywords (no legacy)
        keywordWhere.businessId = businessId;
      }
    } else {
      // If no businessId, get primary business and show its keywords + legacy
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });

      if (primaryBusiness) {
        keywordWhere.OR = [
          { businessId: primaryBusiness.id },
          { businessId: null }, // Legacy keywords
        ];
      } else {
        // No primary business, only show legacy
        keywordWhere.businessId = null;
      }
    }

    const existingPlanData = await prisma.plan.findMany({
      where: keywordWhere,
      select: { keyword: true, publishDate: true },
      orderBy: { createdAt: "desc" },
    });

    // Extract existing topics for LLM prompt (top 10)
    const existingTopics = existingPlanData.slice(0, 10).map((k) => k.keyword);

    // Extract business keywords from onboarding (for LLM prompt context)
    const businessKeywordsFromOnboarding =
      business.keywords?.map((k: any) => k.keyword) || [];

    // Create a Set of existing keyword texts for deduplication (all keywords)
    const existingKeywordTexts = new Set<string>(
      existingPlanData.map((kw) => kw.keyword.toLowerCase().trim()),
    );

    // Create a Set of taken dates (as YYYY-MM-DD strings) - check ALL existing dates
    const takenDates = new Set<string>();
    for (const kw of existingPlanData) {
      if (kw.publishDate) {
        const dateValue = kw.publishDate as Date | string;
        let date: Date | null = null;
        if (dateValue instanceof Date) {
          date = dateValue;
        } else if (typeof dateValue === "string") {
          date = new Date(dateValue);
        }
        if (date && !isNaN(date.getTime())) {
          const dateStr = date.toISOString().split("T")[0];
          if (dateStr) {
            takenDates.add(dateStr);
          }
        }
      }
    }

    console.log(
      `📋 Found ${existingKeywordTexts.size} existing keywords and ${takenDates.size} existing dates - will exclude duplicates`,
    );

    const areaEnforcementEnabled =
      process.env.KEYWORD_AREA_ENFORCEMENT_ENABLED !== "false";
    const businessAreas = buildCanonicalBusinessAreas({
      business,
      businessContext,
      effectiveServices: coreServices,
    });

    console.log(
      `🧭 Canonical business areas: ${
        businessAreas.length > 0
          ? businessAreas
              .map((area) => `${area.name} [${area.group}]`)
              .join(", ")
          : "none"
      }`,
    );

    const candidateClassifications = areaEnforcementEnabled
      ? await classifyKeywordCandidatesByBusinessArea({
          candidates: keywordsForLLM,
          business,
          businessContext,
          businessAreas,
        })
      : new Map<string, LLMKeywordCandidateClassification>();
    const rejectedCandidateCounts = new Map<string, number>();

    const areaFilteredKeywords = keywordsForLLM
      .map((candidate) => {
        const classification =
          candidateClassifications.get(normalizeKeywordText(candidate.keyword)) ||
          buildFallbackCandidateClassification(candidate, businessAreas);
        const canonicalBusinessArea =
          canonicalizeBusinessAreaName(
            classification.canonicalBusinessArea ||
              candidate.canonicalBusinessArea ||
              candidate.aiSelectedService ||
              candidate.matchedService ||
              mapKeywordToBusinessArea(candidate.keyword, businessAreas),
            businessAreas,
          ) || null;
        const businessArea = canonicalBusinessArea
          ? businessAreas.find((area) => area.name === canonicalBusinessArea)
          : null;
        const keywordIntent =
          classification.intent ||
          (candidate.keywordIntent as KeywordIntentBucket | undefined) ||
          inferKeywordIntent(candidate.keyword);
        const intentSource =
          classification.intent
            ? "ai"
            : candidate.keywordIntent
              ? "dataforseo"
              : "heuristic";

        const enrichedCandidate: KeywordCandidate = {
          ...candidate,
          canonicalBusinessArea,
          businessAreaGroup:
            classification.businessAreaGroup || businessArea?.group || null,
          businessAreaPriority: businessArea?.priorityRank ?? null,
          semanticCluster:
            classification.semanticCluster ||
            candidate.semanticCluster ||
            deriveSemanticCluster(candidate.keyword),
          naturalnessScore:
            typeof classification.naturalnessScore === "number"
              ? classification.naturalnessScore
              : candidate.naturalnessScore ?? 0.75,
          isBlogWorthy:
            typeof classification.isBlogWorthy === "boolean"
              ? classification.isBlogWorthy
              : candidate.isBlogWorthy ?? true,
          keywordIntent,
          intentSource,
          selectionReason:
            classification.selectionReason ||
            candidate.selectionReason ||
            candidate.aiReason ||
            null,
          aiSelectedService:
            canonicalBusinessArea ||
            candidate.aiSelectedService ||
            candidate.matchedService ||
            null,
          matchedService:
            canonicalBusinessArea ||
            candidate.matchedService ||
            mapKeywordToService(candidate.keyword, primaryServices, focusAreas),
          aiRelevanceScore:
            typeof classification.relevanceScore === "number"
              ? Math.max(
                  candidate.aiRelevanceScore ?? 0,
                  classification.relevanceScore,
                )
              : candidate.aiRelevanceScore,
        };

        const quality = evaluateKeywordCandidateQuality(enrichedCandidate, {
          businessAreas,
          businessContext,
          mustHaveKeywords: businessContext.keywordStrategy.mustHaveKeywords,
        });
        enrichedCandidate.qualityScore = quality.qualityScore;

        if (areaEnforcementEnabled && !quality.accepted) {
          quality.reasons.forEach((reason) => {
            rejectedCandidateCounts.set(
              reason,
              (rejectedCandidateCounts.get(reason) ?? 0) + 1,
            );
          });
          return null;
        }

        return enrichedCandidate;
      })
      .filter(
        (candidate): candidate is KeywordCandidate => candidate !== null,
      );

    const viableAreas = businessAreas.filter((area) =>
      areaFilteredKeywords.some(
        (candidate) => candidate.canonicalBusinessArea === area.name,
      ),
    );
    const requiredAreaNames = new Set(
      viableAreas.slice(0, 4).map((area) => area.name),
    );
    businessAreas.forEach((area) => {
      area.required = requiredAreaNames.has(area.name);
    });

    if (areaEnforcementEnabled) {
      console.log(
        `🧠 Business-area enforcement retained ${areaFilteredKeywords.length}/${keywordsForLLM.length} candidates`,
      );
      console.log(
        `📊 Rejected candidate summary: ${
          rejectedCandidateCounts.size > 0
            ? JSON.stringify(Object.fromEntries(rejectedCandidateCounts.entries()))
            : "{}"
        }`,
      );
      console.log(
        `📊 Viable business areas: ${
          viableAreas.length > 0
            ? viableAreas
                .map((area) => `${area.name} [${area.group}]`)
                .join(", ")
            : "none"
        }`,
      );
    }

    realKeywordSuggestions =
      areaFilteredKeywords.length > 0 ? areaFilteredKeywords : realKeywordSuggestions;
    keywordsForLLM =
      areaFilteredKeywords.length > 0 ? areaFilteredKeywords : keywordsForLLM;

    const businessServices = coreServices?.topLevel?.join(", ") || "N/A";
    const businessAreasText =
      viableAreas.length > 0
        ? viableAreas
            .map(
              (area) =>
                `${area.name} [${area.group}] aliases: ${area.aliases.join(", ")}`,
            )
            .join("\n")
        : businessAreas
            .map(
              (area) =>
                `${area.name} [${area.group}] aliases: ${area.aliases.join(", ")}`,
            )
            .join("\n");
    const businessSubOfferings =
      expandedSubOfferings.length > 0 ? expandedSubOfferings.join(", ") : "N/A";
    const businessTechnologies =
      technologies.length > 0 ? technologies.join(", ") : "N/A";
    const competitiveAdvantages =
      business.competitiveAdvantage
        ?.map((a: any) => a.advantage)
        .flat()
        .slice(0, 5)
        .join(", ") || "N/A";

    const llmPrompt = `You are an SEO expert and intelligent keyword strategist. Your task is to analyze and select the BEST 30 keywords that will generate meaningful traffic for this specific business.

🧠 BUSINESS INTELLIGENCE ANALYSIS:
- Business Model: ${businessContext.businessModel.type} (Location Dependent: ${
      businessContext.businessModel.isLocationDependent ? "Yes" : "No"
    })
- Primary Services/Products: ${businessContext.services.primary.join(", ")}
- Secondary Services/Products: ${
      businessContext.services.secondary.join(", ") || "N/A"
    }
- Canonical Business Areas:
${businessAreasText || "N/A"}
- Sub-Offerings/Technologies/Frameworks/Tools: ${
      businessSubOfferings !== "N/A" ? businessSubOfferings : "N/A"
    }
   ${
     businessSubOfferings !== "N/A"
       ? `  ⚠️ CRITICAL: Sub-offerings include technologies, frameworks, tools, and related topics within each main service.
   
   For example, if the business offers "Web Development", sub-offerings might include:
   - Technologies: React.js, Next.js, Node.js, TypeScript
   - Frameworks: Full Stack Development, Frontend Development, Backend Development
   - Tools: Git, Docker, AWS
   - Related topics: API Development, Database Design, UI/UX
   
   Generate keywords that EXPLORE these deeper topics, technologies, and areas - not just service variations.
   Create educational, exploratory content around these technologies and topics for a comprehensive 30-day plan.`
       : ""
   }
   ${
     businessTechnologies !== "N/A"
       ? `- Technologies/Frameworks Detected: ${businessTechnologies}`
       : ""
   }
- Industry: ${businessContext.market.industry.vertical}
- Sub-Verticals: ${
      businessContext.market.industry.subVertical?.join(", ") || "N/A"
    }
- Market Scope: ${businessContext.market.geographic.scope}
${
  businessContext.businessModel.isLocationDependent
    ? `- Primary Location: ${businessContext.market.geographic.primary}`
    : "- Location: NOT RELEVANT (product-based business)"
}
- Target Customers: ${businessContext.market.customerSegment.primary}
- Customer Characteristics: ${
      businessContext.market.customerSegment.characteristics.join(", ") || "N/A"
    }
- Business Model: ${businessContext.market.industry.b2bOrB2c}

📊 KEYWORD STRATEGY:
- Intent Distribution: 
  * Informational: ${
    businessContext.keywordStrategy.intentDistribution.informational
  }% (${Math.round(
    (30 * businessContext.keywordStrategy.intentDistribution.informational) /
      100,
  )} keywords)
  * Commercial: ${
    businessContext.keywordStrategy.intentDistribution.commercial
  }% (${Math.round(
    (30 * businessContext.keywordStrategy.intentDistribution.commercial) / 100,
  )} keywords)
  * Transactional: ${
    businessContext.keywordStrategy.intentDistribution.transactional
  }% (${Math.round(
    (30 * businessContext.keywordStrategy.intentDistribution.transactional) /
      100,
  )} keywords)
  * Navigational: ${
    businessContext.keywordStrategy.intentDistribution.navigational
  }% (${Math.round(
    (30 * businessContext.keywordStrategy.intentDistribution.navigational) /
      100,
  )} keywords)

- Difficulty Distribution:
  * Easy (${businessContext.keywordStrategy.difficultyDistribution.easy.min}-${
    businessContext.keywordStrategy.difficultyDistribution.easy.max
  }): ${
    businessContext.keywordStrategy.difficultyDistribution.easy.count
  } keywords
  * Medium (${
    businessContext.keywordStrategy.difficultyDistribution.medium.min
  }-${businessContext.keywordStrategy.difficultyDistribution.medium.max}): ${
    businessContext.keywordStrategy.difficultyDistribution.medium.count
  } keywords
  * Hard (${businessContext.keywordStrategy.difficultyDistribution.hard.min}-${
    businessContext.keywordStrategy.difficultyDistribution.hard.max
  }): ${
    businessContext.keywordStrategy.difficultyDistribution.hard.count
  } keywords

- Must-Have Keywords (CRITICAL - prioritize these): ${
      businessContext.keywordStrategy.mustHaveKeywords.join(", ") || "N/A"
    }
- Focus Areas: ${businessContext.keywordStrategy.focusAreas.join(", ") || "N/A"}

📋 ADDITIONAL BUSINESS CONTEXT:
- Business Name: ${business.businessName}
- Business Type: ${business.businessType}
- Business Description: ${business.businessDescription}
- Location: ${business.businessCity || "N/A"}, ${
      business.businessState || "N/A"
    }, ${business.businessCountry || "N/A"}
- Competitive Advantages: ${competitiveAdvantages}
- Existing Topics: ${existingTopics.join(", ") || "none"}
- Existing Keywords: ${
      businessKeywordsFromOnboarding.slice(0, 10).join(", ") || "none"
    }
${previousKeywordsText}

CORE BUSINESS OFFERINGS:
This business sells: ${coreOfferings.whatBusinessSells}
Primary offerings: ${coreOfferings.primaryOfferings.join(", ")}
Target customers: ${coreOfferings.targetCustomers}
Explicit statement: ${coreOfferings.explicitStatement}

🚀 INDUSTRY TOOLS, METHODS & TERMS:
${
  coreOfferings.technologies?.length > 0
    ? `Specific terms, tools, methods, and specializations in this industry:
${coreOfferings.technologies.join(", ")}

⚠️ Look for keywords that include these industry-specific terms! Customers search using these exact words.`
    : "No specific industry terms identified - infer from business type"
}

🚀 SUB-TOPICS & SPECIALIZATIONS:
${
  coreOfferings.subTopics?.length > 0
    ? `Deeper sub-topics and specialized areas within this business domain:
${coreOfferings.subTopics.join(", ")}

⚠️ These represent specialized services/topics that customers actively search for!`
    : "No specific sub-topics identified - infer from business services"
}

🚀 REAL CUSTOMER SEARCH QUERIES (What People Actually Type Into Google):
${
  coreOfferings.practicalTutorialIdeas?.length > 0
    ? `These are REAL search patterns customers use in this industry:
${coreOfferings.practicalTutorialIdeas.slice(0, 15).join("\n")}

⚠️ CRITICAL: Prioritize keywords matching these patterns! These are what real customers search.`
    : "No specific search queries identified - think about what customers would ask"
}

🚨 KEYWORD SELECTION PRIORITY:
1. HIGHEST: Problem-solving queries ("how to...", "[issue] solutions", "best [service] for [use case]")
2. HIGH: Service + location for local businesses ("[service] near me", "[service] in [city]")
3. HIGH: Comparison/decision queries ("[A] vs [B]", "[service] cost", "[service] reviews")
4. MEDIUM: Educational content ("what is [topic]", "[topic] guide", "[topic] tips")
5. LOW: Generic terms without specificity

🚨 ABSOLUTE REJECTION RULES:
- ❌ REJECT: Keywords that are ONLY location names (e.g., "toronto", "duffrin", "toronto to duffrin") without service context
- ❌ REJECT: Keywords mentioning competitor names: ${
      coreOfferings.competitorNames.length > 0
        ? coreOfferings.competitorNames.join(", ")
        : "none identified"
    }
- ❌ REJECT: Keywords that don't mention any service/product the business offers
- ❌ REJECT: Generic location terms without service context (e.g., "best toronto" without mentioning catering/restaurant)
- ✅ ACCEPT: Location + service (e.g., "shawarma catering toronto", "mediterranean catering in toronto")
- ✅ ACCEPT: Service-focused keywords (e.g., "office catering", "greek catering")

✅ GOOD KEYWORD EXAMPLES:
- "shawarma catering toronto"
- "office catering toronto"
- "mediterranean catering for events"
- "online shawarma ordering"

❌ BAD KEYWORD EXAMPLES (REJECT THESE):
- "toronto to duffrin" (just area names, no service)
${
  coreOfferings.competitorNames.length > 0
    ? `- "${coreOfferings.competitorNames[0]} catering" (competitor name)`
    : ""
}
- "toronto" (too generic, no service)
- "best toronto" (no service context)

CRITICAL RULE: Keywords MUST relate to these specific offerings: ${coreOfferings.primaryOfferings.join(
      ", ",
    )}. 
REJECT keywords that are generic area names, competitor names, or don't mention services/products.

You have ${
      keywordsForLLM.length
    } REAL keyword suggestions with actual Google search data from DataForSEO API (pre-filtered to remove competitors and location-only keywords).

Available Keywords (with metrics and traffic potential):
${keywordsForLLM
  .slice(0, 200)
  .map(
    (kw, i) =>
      `${i + 1}. "${kw.keyword}" - ${kw.searchVolume} searches/mo, ${
        kw.difficulty
      }% difficulty, $${(kw.cpc ?? 0).toFixed(
        2,
      )} CPC, Traffic Potential: ${(kw.trafficPotential ?? 0).toFixed(
        2,
      )}, Area: ${
        kw.canonicalBusinessArea || "unmapped"
      }, Group: ${kw.businessAreaGroup || "unknown"}, Intent: ${
        kw.keywordIntent || "unknown"
      }, Quality: ${(kw.qualityScore ?? 0.75).toFixed(2)}${
        (kw.trendGrowth ?? 1) > 1.1
          ? " (📈 Growing)"
          : (kw.trendGrowth ?? 1) < 0.9
            ? " (📉 Declining)"
            : ""
      }`,
  )
  .join("\n")}

YOUR TASK - STRATEGIC KEYWORD SELECTION:

1. ANALYZE each keyword for relevance:
   - CRITICAL: Does it relate to what this business sells: ${
     coreOfferings.whatBusinessSells
   }?
   - CRITICAL: Does it mention at least ONE primary offering: ${coreOfferings.primaryOfferings.join(
     ", ",
   )}?
   - Does it match the industry: ${businessContext.market.industry.vertical}?
   - Does it target the right customers: ${coreOfferings.targetCustomers}?
   - Does it align with focus areas: ${businessContext.keywordStrategy.focusAreas.join(
     ", ",
   )}?
   ${
     businessContext.businessModel.isLocationDependent
       ? `- For SERVICE businesses: Location may be relevant (${businessContext.market.geographic.primary}) IF service is mentioned`
       : `- 🚨 FOR PRODUCT BUSINESSES: REJECT any location-specific keywords (e.g., "product in [city]", "product near me"). Products can be shipped anywhere - focus on product features, reviews, comparisons, buying guides.`
   }
   - 🚨 REJECT: Keywords that are ONLY location names (e.g., "toronto to duffrin") without service context
   - 🚨 REJECT: Keywords mentioning competitors: ${
     coreOfferings.competitorNames.length > 0
       ? coreOfferings.competitorNames.join(", ")
       : "none"
   }
   - 🚨 REJECT: Keywords that don't mention any service/product the business offers
   - 🚨 REJECT: Generic location terms without service context
   - Keywords MUST be business-specific (related to what they sell/offer)
   - **🚨 FOR RESTAURANTS: Keywords MUST be specific to their actual menu items, cuisine type, and services - NOT generic restaurant terms**

2. SELECT exactly 30 keywords that:
   - MUST map clearly to one canonical business area listed above
   - Are SPECIFIC to business services/products: ${businessContext.services.primary.join(
     ", ",
   )}
   ${
     businessSubOfferings !== "N/A"
       ? `- MUST include keywords exploring TECHNOLOGIES, FRAMEWORKS, TOOLS, and RELATED TOPICS: ${businessSubOfferings}
   - Focus on EXPLORING topics rather than just service keywords:
     * Technologies: React.js, Next.js, Node.js, TypeScript, etc.
     * Frameworks: Full Stack, Frontend, Backend, etc.
     * Tools: Git, Docker, AWS, etc.
     * Related areas: API Development, Database Design, UI/UX, etc.
   - Generate educational, exploratory content around these technologies and topics`
       : ""
   }
   - Generate a MIX of keywords covering:
     * Main services (${businessContext.services.primary.length} main services)
     ${
       businessSubOfferings !== "N/A"
         ? `* Technologies, frameworks, tools, and related topics (${
             expandedSubOfferings.length
           } items: ${expandedSubOfferings.slice(0, 10).join(", ")}...)`
         : ""
     }
     * Service combinations and variations
     * How-to guides, best practices, and educational content
     * Technology-specific tutorials and guides
     * Framework comparisons and deep dives
   ${
     businessContext.businessModel.isLocationDependent
       ? `- For SERVICE businesses: May include location (${businessContext.market.geographic.primary}) when relevant`
       : `- For PRODUCT businesses: MUST be location-agnostic (NO city names, NO "near me", NO location-specific terms)`
   }
   - Match the intent distribution strategy (${
     businessContext.keywordStrategy.intentDistribution.informational
   }% informational, ${
     businessContext.keywordStrategy.intentDistribution.commercial
   }% commercial, ${
     businessContext.keywordStrategy.intentDistribution.transactional
   }% transactional, ${
     businessContext.keywordStrategy.intentDistribution.navigational
   }% navigational)
   - Match the difficulty distribution strategy (${
     businessContext.keywordStrategy.difficultyDistribution.easy.count
   } easy, ${
     businessContext.keywordStrategy.difficultyDistribution.medium.count
   } medium, ${
     businessContext.keywordStrategy.difficultyDistribution.hard.count
   } hard)
   - Prioritize must-have keywords: ${businessContext.keywordStrategy.mustHaveKeywords.join(
     ", ",
   )}
   - Will generate meaningful traffic for THIS specific business${
     businessContext.businessModel.isLocationDependent
       ? ` in THIS market (${businessContext.market.geographic.scope} market targeting ${businessContext.market.customerSegment.primary})`
       : ` (${businessContext.market.customerSegment.primary} customers)`
   }
   - Consider traffic potential scores - higher scores indicate better fit
   - Focus on what the business SELLS/OFFERS, not generic or location-based terms

3. HANDLE COMPROMISES INTELLIGENTLY:
   - If a keyword is somewhat relevant but not perfect, you can include it IF it has high value (high search volume, low difficulty)
   - If location is important but keyword doesn't have location, you can still select if it's highly relevant to services
   - Balance between perfect relevance and SEO value
   - Prioritize business alignment over raw metrics

4. REPLACE IRRELEVANT KEYWORDS:
   - If you see keywords that mention other companies/locations, REJECT them
   - If you see generic keywords not related to services, REJECT them
   - If you see keywords that don't match business type, REJECT them
   - Select alternative keywords from the list that ARE relevant

5. LOCATION ALIGNMENT:
${
  businessContext.businessModel.isLocationDependent && business.businessCity
    ? (() => {
        const allLocations = getKeywordLocations(
          business.businessCity,
          business.serviceAreaLocations,
        );
        const locationsText =
          allLocations.length > 1
            ? allLocations.join(", ")
            : business.businessCity;

        return `
   - For SERVICE businesses: PREFER keywords that include service area locations when relevant
   - Service Area Locations: ${locationsText}
   - ACCEPT location-agnostic keywords if they're highly relevant to services
   - REJECT keywords that mention OTHER cities/locations not in service area
   ${
     allLocations.length > 1
       ? `- Create location-based keywords for ALL service areas: ${allLocations.map((loc: string) => `"${loc} ${business.businessType || "service"}"`).join(", ")}`
       : `- Examples of GOOD location keywords: "${business.businessCity} ${business.businessType}", "best ${business.businessType} in ${business.businessCity}"`
   }
   - Examples of BAD keywords: "restaurant in [other city]", "domino's pizza delivery" (different company)
`;
      })()
    : businessContext.businessModel.type === "product"
      ? `
   - 🚨 FOR PRODUCT BUSINESSES: REJECT ALL location-specific keywords
   - REJECT keywords with city names, "near me", "in [location]", or any location terms
   - Focus on: product features, reviews, comparisons, buying guides, specifications
   - Examples of GOOD product keywords: "best running shoes", "wireless headphones review", "laptop buying guide"
   - Examples of BAD keywords: "running shoes in Toronto", "headphones near me", "laptop in [city]"
`
      : ""
}

OUTPUT FORMAT:
Output ONLY a JSON array with exactly 30 selected keywords:
[
  {
    "keyword": "exact keyword from list above",
    "selectedBusinessArea": "exact canonical business area from the list above",
    "reason": "short reason this keyword is strategically valuable",
    "relevanceScore": 0.91
  },
  ...30 total
]

CRITICAL RULES:
- Use EXACT keyword text from the list above
- Output ONLY the JSON array, no explanation
- You are the intelligent filter - reject irrelevant keywords even if they have high scores
- Select keywords that align with business services, type, and ${(() => {
      const allLocations = getKeywordLocations(
        business.businessCity,
        business.serviceAreaLocations,
      );
      return allLocations.length > 0
        ? `locations (${allLocations.join(", ")})`
        : "description";
    })()}
- Ensure variety and strategic distribution
- Make intelligent compromises when needed, but prioritize business alignment`;

    const llmResponse = await keywordLLM.invoke([
      {
        role: "system",
        content: `You are an intelligent SEO keyword strategist who THINKS DEEPLY about what REAL CUSTOMERS actually search for. Your task is to select exactly 30 keywords that will generate meaningful traffic for this specific business.

🧠 THINK LIKE A CUSTOMER - WHAT DO THEY ACTUALLY SEARCH?
Put yourself in the shoes of someone looking for this business's services. What would they type into Google?

Examples of DEEP THINKING by industry:
- Restaurant/Catering: "best shawarma near me", "halal catering for office", "mediterranean food delivery", "corporate lunch catering prices"
  
  **🚨 CRITICAL FOR RESTAURANTS: Keywords MUST be specific to the restaurant's ACTUAL menu items, cuisine type, and services.**
  - If the restaurant serves Mediterranean food, keywords should focus on Mediterranean dishes (shawarma, falafel, hummus, etc.), NOT Italian, Asian, or other cuisines
  - If the restaurant offers halal food, keywords should mention halal options, NOT non-halal items
  - If the restaurant has a specific menu focus (e.g., vegan, gluten-free, keto), keywords should reflect those specific offerings
  - Keywords should match the actual dishes, ingredients, and services listed on their menu/website
  - DO NOT generate generic restaurant keywords that could apply to any restaurant - they must be contextually relevant to THIS specific restaurant's offerings
  - Example: For a Mediterranean restaurant, use "best falafel wrap", "mediterranean catering menu", "halal shawarma delivery" - NOT "best pizza", "sushi restaurant", or "steakhouse menu"
- Event Venue: "wedding venue checklist", "banquet hall prices per person", "corporate event planning tips", "birthday party venue ideas"
- Law Firm: "do I need a lawyer for...", "personal injury lawyer cost", "how to file for divorce"
- Dental: "how much do braces cost", "dental implant vs bridge", "teeth whitening options"
- Plumber: "emergency plumber near me", "how to unclog a drain", "water heater making noise"
- Real Estate: "first time home buyer tips", "how to stage a home", "best neighborhoods for families"
- Tech/DevOps: "how to deploy to aws", "docker tutorial", "kubernetes best practices"
- Fitness: "best workout for beginners", "how to lose weight fast", "gym membership prices"
- Salon: "hair color trends", "best haircut for face shape", "how often to get a haircut"

You have access to:
- Business intelligence (services, market, customers)
- Industry-specific tools, methods, and terms (USE THESE!)
- Practical search queries that real customers use (PRIORITIZE THESE!)
- Real keyword data from DataForSEO

🚀 KEYWORD PRIORITY ORDER:

**HIGHEST PRIORITY - Problem-Solving & Educational:**
- "how to [solve problem]" → People searching for solutions
- "[topic] tips/guide/checklist" → People researching
- "[option A] vs [option B]" → People comparing options
- "best [service] for [use case]" → People ready to decide
- "[service] cost/prices" → People ready to buy

**HIGH PRIORITY - Local Commercial (for local businesses):**
- "[service] near me" / "[service] in [city]"
- "best [service] [location]"
- "[service] + [neighborhood/city]"

**MEDIUM PRIORITY - Informational:**
- "what is [topic]", "why [topic]", "when to [action]"
- Industry-specific guides and tutorials

**❌ REJECT these types of keywords:**
1. **Pure location keywords** - ONLY location names with NO service:
   - BAD: "Mississauga Ontario", "port credit", "downtown toronto"

2. **Competitor brand names** - Specific other businesses:
   - BAD: Competitor venue/company names

3. **Irrelevant generic queries**:
   - BAD: "things to do in [city]", park names, landmarks

**DECISION LOGIC:**
- Contains service/product term the business offers → ACCEPT
- Answers a question customers would ask → ACCEPT
- Is a competitor's name → REJECT
- Is ONLY location with zero service context → REJECT
- **For restaurants: Matches their actual menu items, cuisine type, or services → ACCEPT**
- **For restaurants: Generic restaurant terms not specific to their offerings → REJECT**

Your selection criteria:
1. Prioritize keywords that align with business services/products: ${businessContext.services.primary.join(
          ", ",
        )}
2. ${
          businessContext.businessModel.isLocationDependent
            ? `For SERVICE businesses: Location is only valid when combined with a service term`
            : `For PRODUCT businesses: REJECT all location-specific keywords (no cities, no "near me")`
        }
3. Match the strategic intent distribution (${
          businessContext.keywordStrategy.intentDistribution.informational
        }% informational, ${
          businessContext.keywordStrategy.intentDistribution.commercial
        }% commercial, etc.)
4. Match the strategic difficulty distribution (${
          businessContext.keywordStrategy.difficultyDistribution.easy.count
        } easy, ${
          businessContext.keywordStrategy.difficultyDistribution.medium.count
        } medium, ${
          businessContext.keywordStrategy.difficultyDistribution.hard.count
        } hard)
5. Prioritize must-have keywords: ${businessContext.keywordStrategy.mustHaveKeywords.join(
          ", ",
        )}
6. Consider traffic potential scores - higher scores = better fit for this business
7. Ensure keywords relate to what the business actually sells/offers${
          businessContext.businessModel.isLocationDependent
            ? ` in the ${businessContext.market.geographic.scope} market targeting ${businessContext.market.customerSegment.primary}`
            : ` (focus on products/services, not location)`
        }

Reject keywords about other companies, wrong locations, generic terms, pure location terms, or location-specific terms for product businesses.
Keywords MUST be business-specific (related to services/products they offer).

**🚨 RESTAURANT-SPECIFIC RULES:**
- Keywords MUST align with the restaurant's actual menu items, cuisine type, and services
- If the restaurant serves Mediterranean food, keywords should be about Mediterranean dishes, NOT other cuisines
- If the restaurant offers specific dietary options (halal, vegan, gluten-free), keywords should reflect those ONLY if they actually offer them
- Keywords should match what customers would search for when looking for THIS specific restaurant's offerings
- DO NOT generate generic restaurant keywords that don't match their cuisine, menu, or services
- Example: For a shawarma restaurant, use "best shawarma wrap", "halal mediterranean food", "shawarma catering" - NOT "best pizza", "sushi restaurant", or generic "restaurant near me"

Output ONLY a JSON array with exactly 30 keyword objects. Each object must include keyword, selectedBusinessArea, reason, and relevanceScore (0 to 1).`,
      },
      { role: "user", content: llmPrompt },
    ]);

    // Parse LLM selection
    const llmContent =
      typeof llmResponse.content === "string"
        ? llmResponse.content
        : JSON.stringify(llmResponse.content);
    let selectedKeywords = parseLLMSelection(llmContent);

    // 🚀 FIX: Deduplicate LLM-selected keywords (case-insensitive)
    const uniqueSelectedMap = new Map<string, LLMKeywordSelection>();
    for (const kw of selectedKeywords) {
      const key = normalizeKeywordText(kw.keyword);
      if (!uniqueSelectedMap.has(key)) {
        uniqueSelectedMap.set(key, kw);
      }
    }
    selectedKeywords = Array.from(uniqueSelectedMap.values());
    console.log(
      `🔍 Deduplicated LLM selection to ${selectedKeywords.length} unique keywords`,
    );

    if (selectedKeywords.length === 0) {
      console.warn(
        "⚠️ LLM failed to select keywords, asking LLM to retry with more context",
      );

      // Ask LLM again with explicit instruction to select from all keywords
      const retryPrompt = `You must select exactly 30 keywords from the list. If you cannot find 30 perfect matches, select the best available keywords that are MOST relevant to:
- Business: ${business.businessName} (${business.businessType})
- Main Services: ${businessServices}
${
  businessSubOfferings !== "N/A"
    ? `- Sub-Offerings: ${businessSubOfferings}`
    : ""
}
${business.businessCity ? `- Location: ${business.businessCity}` : ""}

Select 30 keywords now, prioritizing:
1. Relevance to main services: ${businessServices}
 ${
   businessSubOfferings !== "N/A"
     ? `2. EXPLORING technologies, frameworks, tools, and related topics: ${businessSubOfferings}
   - Generate keywords that explore these deeper topics (e.g., "React.js best practices", "Next.js vs React", "Full stack development guide")
   - Focus on educational content around technologies, not just service variations`
     : ""
 }
 3. ${
   business.businessCity
     ? `Location relevance (${business.businessCity})`
     : "Service/product relevance"
 }
 4. A balanced mix covering:
   - Main services
   - Technologies, frameworks, and tools (exploratory content)
   - Educational guides and tutorials
   - Best practices and comparisons
   - For a comprehensive, practical 30-day plan that explores all aspects of what the business offers

Available keywords:
${realKeywordSuggestions
  .slice(0, 200)
  .map((kw, i) => `${i + 1}. "${kw.keyword}"`)
  .join("\n")}

Output JSON array with 30 objects:
[
  {
    "keyword": "exact keyword from the list",
    "selectedBusinessArea": "best matching canonical business area",
    "reason": "short reason",
    "relevanceScore": 0.88
  }
]`;

      const retryResponse = await keywordLLM.invoke([
        {
          role: "system",
          content:
            "Select exactly 30 keyword objects. Prioritize business relevance. Output ONLY JSON array with keyword, selectedBusinessArea, reason, and relevanceScore.",
        },
        { role: "user", content: retryPrompt },
      ]);

      const retryContent =
        typeof retryResponse.content === "string"
          ? retryResponse.content
          : JSON.stringify(retryResponse.content);
      selectedKeywords = parseLLMSelection(retryContent);

      if (selectedKeywords.length === 0) {
        throw new Error("LLM failed to select any keywords");
      }
    }

    console.log(`✅ LLM selected ${selectedKeywords.length} keywords`);

    const candidatePoolForSelection = keywordsForLLM
      .filter(
        (candidate) =>
          !existingKeywordTexts.has(normalizeKeywordText(candidate.keyword)),
      )
      .map((candidate) => ({
        ...candidate,
        canonicalBusinessArea:
          candidate.canonicalBusinessArea ||
          mapKeywordToBusinessArea(candidate.keyword, businessAreas),
        businessAreaGroup:
          candidate.businessAreaGroup ||
          (() => {
            const areaName =
              candidate.canonicalBusinessArea ||
              mapKeywordToBusinessArea(candidate.keyword, businessAreas);
            return areaName
              ? businessAreas.find((area) => area.name === areaName)?.group || null
              : null;
          })(),
        matchedService:
          candidate.matchedService ||
          candidate.canonicalBusinessArea ||
          mapKeywordToService(candidate.keyword, primaryServices, focusAreas),
        keywordIntent:
          candidate.keywordIntent || inferKeywordIntent(candidate.keyword),
        semanticCluster:
          candidate.semanticCluster || deriveSemanticCluster(candidate.keyword),
      }));

    const candidateMapForSelection = new Map(
      candidatePoolForSelection.map((candidate) => [
        normalizeKeywordText(candidate.keyword),
        candidate,
      ]),
    );

    for (const selection of selectedKeywords) {
      const key = normalizeKeywordText(selection.keyword);
      const candidate = candidateMapForSelection.get(key);
      if (!candidate) {
        continue;
      }
      const selectedBusinessArea =
        canonicalizeBusinessAreaName(
          selection.selectedBusinessArea ||
            selection.selectedService ||
            candidate.canonicalBusinessArea ||
            candidate.matchedService,
          businessAreas,
        ) ||
        candidate.canonicalBusinessArea ||
        mapKeywordToBusinessArea(selection.keyword, businessAreas);
      const matchedArea = selectedBusinessArea
        ? businessAreas.find((area) => area.name === selectedBusinessArea)
        : null;
      candidate.canonicalBusinessArea = selectedBusinessArea || null;
      candidate.aiSelectedService =
        selectedBusinessArea ||
        candidate.matchedService ||
        mapKeywordToService(selection.keyword, primaryServices, focusAreas);
      candidate.businessAreaGroup =
        candidate.businessAreaGroup ||
        matchedArea?.group ||
        null;
      candidate.businessAreaPriority =
        candidate.businessAreaPriority ?? matchedArea?.priorityRank ?? null;
      candidate.aiReason = selection.reason || null;
      candidate.aiRelevanceScore =
        typeof selection.relevanceScore === "number"
          ? selection.relevanceScore
          : candidate.aiRelevanceScore ?? Math.max(candidate.relevanceScore ?? 0, 0.7);
    }

    const selectionResult = selectKeywordsDeterministically({
      candidates: candidatePoolForSelection,
      businessAreas,
      mustHaveKeywords: businessContext.keywordStrategy.mustHaveKeywords,
      strategy: businessContext.keywordStrategy,
    });

    console.log(
      `✅ Deterministic selection produced ${selectionResult.summary.selectedCount} keywords`,
    );
    console.log(
      `📊 Final quota summary: difficulty=${JSON.stringify(
        selectionResult.summary.difficultyCounts,
      )}, intent=${JSON.stringify(
        selectionResult.summary.intentCounts,
      )}, areas=${JSON.stringify(
        selectionResult.summary.serviceCounts,
      )}, groups=${JSON.stringify(selectionResult.summary.groupCounts)}`,
    );

    const finalizedCandidates: KeywordCandidate[] = [];
    const finalizedSet = new Set<string>();

    const sortedFallbackCandidates = [...candidatePoolForSelection].sort((a, b) => {
      const aiDiff = (b.aiRelevanceScore ?? 0) - (a.aiRelevanceScore ?? 0);
      if (Math.abs(aiDiff) > 0.001) return aiDiff;
      const trafficDiff = (b.trafficPotential ?? 0) - (a.trafficPotential ?? 0);
      if (Math.abs(trafficDiff) > 0.001) return trafficDiff;
      return (b.searchVolume ?? 0) - (a.searchVolume ?? 0);
    });

    const findReplacementCandidate = async () => {
      for (const candidate of sortedFallbackCandidates) {
        const key = normalizeKeywordText(candidate.keyword);
        if (finalizedSet.has(key)) {
          continue;
        }

        const verification = await verifyKeyword(
          candidate.keyword,
          business,
          businessContext,
          coreOfferings,
        );

        if (
          verification.isValid &&
          verification.relevanceScore >= 0.55 &&
          !existingKeywordTexts.has(key)
        ) {
          return {
            ...candidate,
            aiReason:
              candidate.aiReason ||
              "Selected from remaining candidate pool after validation",
            aiRelevanceScore:
              candidate.aiRelevanceScore ?? verification.relevanceScore,
            matchedService:
              candidate.aiSelectedService ||
              candidate.matchedService ||
              mapKeywordToService(candidate.keyword, primaryServices, focusAreas),
          } satisfies KeywordCandidate;
        }
      }

      return null;
    };

    for (const candidate of selectionResult.selected) {
      const key = normalizeKeywordText(candidate.keyword);
      if (finalizedSet.has(key)) {
        continue;
      }

      const verification = await verifyKeyword(
        candidate.keyword,
        business,
        businessContext,
        coreOfferings,
      );

      if (verification.isValid && verification.relevanceScore >= 0.55) {
        finalizedCandidates.push({
          ...candidate,
          aiRelevanceScore:
            candidate.aiRelevanceScore ?? verification.relevanceScore,
          matchedService:
            candidate.aiSelectedService ||
            candidate.matchedService ||
            mapKeywordToService(candidate.keyword, primaryServices, focusAreas),
        });
        finalizedSet.add(key);
        continue;
      }

      const replacement = await findReplacementCandidate();
      if (replacement) {
        finalizedCandidates.push(replacement);
        finalizedSet.add(normalizeKeywordText(replacement.keyword));
      }
    }

    while (finalizedCandidates.length < 30) {
      const replacement = await findReplacementCandidate();
      if (!replacement) {
        break;
      }
      finalizedCandidates.push(replacement);
      finalizedSet.add(normalizeKeywordText(replacement.keyword));
    }

    console.log(
      `✅ Verified and finalized ${finalizedCandidates.length} keywords for business`,
    );

    // Note: takenDates is already created above from existingPlanData

    // Build 30-day plan with REAL data from DataForSEO
    // 🆕 FIX: Start from last keyword date if previous keywords exist (ongoing generation)
    // Otherwise start from today (initial generation)
    // Note: previousKeywordsArray is already parsed above for LLM prompt
    console.log(
      `🎯 Starting DataForSEO-first keyword generation for user ${userId}${
        isOngoing ? " (ongoing)" : " (initial)"
      }`,
    );

    const latestDate =
      previousKeywordsArray.length > 0 && previousKeywordsArray[0].publishDate
        ? new Date(previousKeywordsArray[0].publishDate)
        : new Date();

    const startDate = new Date(latestDate);
    if (isOngoing) {
      startDate.setDate(startDate.getDate() + 1); // Start from next day after last keyword
    }

    // 🚀 IMPROVEMENT 5: Sort by difficulty for progressive distribution
    const sortedByDifficulty = [...finalizedCandidates].sort(
      (a, b) => a.difficulty - b.difficulty,
    );

    // Build 30-day plan with strategic distribution
    let dateOffset = 0;
    const keywordPlan = sortedByDifficulty
      .map((selected) => {
        // Find next available date - skip dates that already have keywords
        let publishDate: Date;
        let dateString: string | undefined;
        let attempts = 0;
        do {
          publishDate = new Date(startDate);
          publishDate.setDate(publishDate.getDate() + dateOffset);
          dateString = publishDate.toISOString().split("T")[0];
          dateOffset++;
          attempts++;
          if (attempts > 365) {
            console.warn(
              `⚠️ Could not find available date after 365 attempts for keyword: ${selected.keyword}`,
            );
            break;
          }
        } while (dateString && takenDates.has(dateString));

        if (!dateString) {
          console.warn(
            `⚠️ Could not assign date to keyword: ${selected.keyword}`,
          );
          return null;
        }

        // Mark this date as taken to avoid duplicates in the same batch
        takenDates.add(dateString);

        // Use advanced categorization
        const { category, intent, contentType } = categorizeKeywordAdvanced(
          selected.keyword,
          business,
        );

        return {
          keyword: selected.keyword,
          publishDate: dateString,
          publishTime: "08:00",
          keywordDiffculty: selected.difficulty.toString(),
          keywordSearchVolume: selected.searchVolume.toString(),
          keywordCategory: category,
          keywordIntent: selected.keywordIntent || intent,
          keywordInstructions: contentType, // Store content type here
          userId: userId,
          businessId: businessId || null, // 🆕 Link keyword to business
          keywordSource: selected.sourceType,
          difficultyBucket: bucketDifficulty(
            selected.difficulty,
            businessContext.keywordStrategy,
          ) as DifficultyBucket,
          selectionMetadata: buildSelectionMetadata(
            selected,
            focusAreas,
            businessAreas,
          ),
          // All real DataForSEO metrics
          keywordCpc: selected.cpc ?? null,
          keywordCompetition: selected.competition ?? null,
          keywordMonthlySearches: selected.monthlySearches ?? null,
          keywordClicks: selected.clicks ?? null,
          keywordImpressions: selected.impressions ?? null,
          keywordCTR: selected.ctr ?? null,
          keywordTrend: JSON.stringify(selected.trend || []),
          keywordDataUpdatedAt: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    // 🚀 CRITICAL: Ensure exactly 30 keywords in the plan (no compromise)
    if (keywordPlan.length < 30) {
      const needed = 30 - keywordPlan.length;
      console.warn(
        `⚠️ Only generated ${keywordPlan.length} keywords, need ${needed} more. This should not happen - all keywords should have valid data.`,
      );

      // This should rarely happen since we ensure 30 selected keywords above
      // But if some keywords don't have realData, we need to fill the gap
      const selectedTexts = new Set(
        keywordPlan.map((kp: any) => kp.keyword.toLowerCase().trim()),
      );

      const additionalKeywords = sortedFallbackCandidates
        .filter(
          (kw) =>
            !selectedTexts.has(kw.keyword.toLowerCase().trim()) &&
            !existingKeywordTexts.has(kw.keyword.toLowerCase().trim()),
        )
        .slice(0, needed) // Already sorted by composite score
        .map((kw) => {
          // Find next available date
          let publishDate: Date;
          let dateString: string | undefined;
          do {
            publishDate = new Date(startDate);
            publishDate.setDate(publishDate.getDate() + dateOffset);
            dateString = publishDate.toISOString().split("T")[0];
            dateOffset++;
            if (dateOffset > 365) break;
          } while (dateString && takenDates.has(dateString));

          if (!dateString) {
            console.error(
              "❌ Failed to generate date string for additional keyword",
            );
            return null;
          }

          // Use advanced categorization
          const { category, intent, contentType } = categorizeKeywordAdvanced(
            kw.keyword,
            business,
          );

          return {
            keyword: kw.keyword,
            publishDate: dateString,
            publishTime: "08:00",
            keywordDiffculty: kw.difficulty.toString(),
            keywordSearchVolume: kw.searchVolume.toString(),
            keywordCategory: category,
            keywordIntent: kw.keywordIntent || intent,
            keywordInstructions: contentType,
            userId: userId,
            businessId: businessId || null, // 🆕 Link keyword to business
            keywordSource: kw.sourceType,
            difficultyBucket: bucketDifficulty(
              kw.difficulty,
              businessContext.keywordStrategy,
            ) as DifficultyBucket,
            selectionMetadata: buildSelectionMetadata(
              kw,
              focusAreas,
              businessAreas,
            ),
            keywordCpc: kw.cpc ?? null,
            keywordCompetition: kw.competition ?? null,
            keywordMonthlySearches: kw.monthlySearches ?? null,
            keywordClicks: kw.clicks ?? null,
            keywordImpressions: kw.impressions ?? null,
            keywordCTR: kw.ctr ?? null,
            keywordTrend: JSON.stringify(kw.trend || []),
            keywordDataUpdatedAt: new Date().toISOString(),
          };
        })
        .filter((kw): kw is NonNullable<typeof kw> => kw !== null);

      keywordPlan.push(...additionalKeywords);
      console.log(
        `✅ Added ${additionalKeywords.length} keywords to complete 30-day plan`,
      );
    }

    // Final check - must have exactly 30
    if (keywordPlan.length !== 30) {
      console.error(
        `❌ CRITICAL: Expected exactly 30 keywords, got ${keywordPlan.length}. Truncating or filling as needed.`,
      );
      // Truncate to 30 if more, or this should not happen
      while (keywordPlan.length < 30) {
        // Emergency fallback - duplicate last keyword if needed (should never happen)
        const lastKeyword = keywordPlan[keywordPlan.length - 1];
        if (lastKeyword && lastKeyword.publishDate) {
          const newKeyword = { ...lastKeyword };
          const newDate = new Date(
            new Date(newKeyword.publishDate).getTime() +
              keywordPlan.length * 24 * 60 * 60 * 1000,
          );
          const dateStr = newDate.toISOString().split("T")[0];
          if (dateStr) {
            newKeyword.publishDate = dateStr;
            keywordPlan.push(newKeyword);
          } else {
            break; // Can't generate valid date
          }
        } else {
          break; // Can't continue
        }
      }
      // Truncate to exactly 30
      keywordPlan.splice(30);
    }

    console.log(
      `✅ Generated ${keywordPlan.length} keywords with optimized strategy (multi-source, advanced scoring, strategic distribution)`,
    );

    const nonNullKeywordPlan = keywordPlan.filter(
      (item): item is NonNullable<(typeof keywordPlan)[number]> => item != null,
    );
    const seenPlanKeywords = new Set<string>();
    const keywordPlanToSave = nonNullKeywordPlan.filter((item) => {
      const key = normalizeKeywordText(item.keyword);
      if (seenPlanKeywords.has(key)) {
        return false;
      }
      seenPlanKeywords.add(key);
      return true;
    });

    const { assignKeywordClusters } = await import(
      "../../utils/keyword-cluster.utils"
    );
    const clusterMap = await assignKeywordClusters(
      keywordPlanToSave.map((item) => ({
        keyword: item.keyword,
        keywordCategory: item.keywordCategory,
        keywordIntent: item.keywordIntent,
      })),
      businessId,
      userId,
    );

    for (const item of keywordPlanToSave) {
      const assignment = clusterMap.get(item.keyword.toLowerCase());
      if (assignment) {
        (item as any).clusterId = assignment.clusterId;
        (item as any).clusterRole = assignment.clusterRole;
      }
    }

    console.log(
      `💾 Saving ${keywordPlanToSave.length} keywords directly to database (${clusterMap.size} cluster-assigned)`,
    );
    console.log(
      `🔍 Sample keyword data:`,
      JSON.stringify(keywordPlanToSave[0], null, 2),
    );

    const saveResult = await savePlanKeywords(
      keywordPlanToSave.map((item) => ({
        keyword: item.keyword,
        publishDate: item.publishDate,
        publishTime: item.publishTime,
        keywordDiffculty: item.keywordDiffculty,
        keywordSearchVolume: item.keywordSearchVolume,
        userId: item.userId,
        businessId: item.businessId,
        keywordCategory: item.keywordCategory || null,
        keywordIntent: item.keywordIntent || null,
        keywordSource: item.keywordSource || null,
        difficultyBucket: item.difficultyBucket || null,
        selectionMetadata: item.selectionMetadata ?? Prisma.JsonNull,
        keywordCpc: item.keywordCpc ?? null,
        keywordCompetition: item.keywordCompetition ?? null,
        keywordTrend: item.keywordTrend
          ? (JSON.parse(item.keywordTrend) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        keywordMonthlySearches: item.keywordMonthlySearches ?? null,
        keywordClicks: item.keywordClicks ?? null,
        keywordImpressions: item.keywordImpressions ?? null,
        keywordCTR: item.keywordCTR ?? null,
        keywordDataUpdatedAt: item.keywordDataUpdatedAt ?? null,
        clusterId: (item as any).clusterId ?? undefined,
        clusterRole: (item as any).clusterRole ?? undefined,
      })),
    );

    const savedCount = saveResult.count;
    const skippedCount = saveResult.skipped;

    console.log(`✅ Keywords saved: ${savedCount} saved, ${skippedCount} skipped`);

    if (skippedCount > 0) {
      saveResult.skippedDetails.forEach((skipped) => {
        console.warn(
          `   ⚠️ Skipped "${skipped.keyword}" on ${skipped.date}: ${skipped.reason}`,
        );
      });
    }

    // 🆕 NEW: Allocate keywords to business in platform-wide allocation system
    if (savedCount > 0 && businessId) {
      console.log(
        `🔐 Allocating ${savedCount} keywords to platform allocation system...`,
      );

      for (const keywordPlanItem of keywordPlanToSave.slice(0, savedCount)) {
        if (!keywordPlanItem) continue; // Skip null entries
        try {
          await keywordAllocation.allocateKeyword(
            keywordPlanItem.keyword,
            businessId,
            userId,
            business.businessType || "",
            locationScope,
            parseInt(keywordPlanItem.keywordSearchVolume) || undefined,
            parseFloat(keywordPlanItem.keywordDiffculty) || undefined,
            1, // Default priority
            undefined, // No expiration
          );
        } catch (error: any) {
          console.warn(
            `⚠️ Failed to allocate keyword "${keywordPlanItem.keyword}": ${error.message}`,
          );
          // Continue with other keywords even if one fails
        }
      }
      console.log(`✅ Allocated keywords to platform system`);
    }

    if (savedCount === 0) {
      console.error(
        `❌ CRITICAL: No keywords were saved to database! Skipped: ${skippedCount}, Total attempted: ${keywordPlanToSave.length}`,
      );
      throw new Error(
        `No keywords were saved. ${skippedCount} were skipped due to duplicate dates. Please check date assignment logic.`,
      );
    }

    console.log(
      `✅ Keywords saved to database: ${savedCount} saved, ${skippedCount} skipped (duplicate dates)`,
    );

    if (savedCount < keywordPlanToSave.length) {
      console.warn(
        `⚠️ Only ${savedCount} out of ${keywordPlanToSave.length} keywords were saved. ${skippedCount} were skipped due to duplicate dates.`,
      );
    }

    return {
      success: true,
      count: savedCount,
      skipped: skippedCount,
      method: "dataforseo_ai",
      message: `Saved ${savedCount} keywords successfully`,
      sourceCounts: Object.fromEntries(candidateSourceCounts.entries()),
      quotaSummary: selectionResult.summary,
    };
  } catch (error: any) {
    console.error(
      "❌ DataForSEO-first initial generation failed:",
      error.message,
    );
    // Last resort: fallback to original LLM method
    const business = JSON.parse(keywords);
    return await fallbackToLLMGeneration(
      business,
      userId,
      typeof business.id === "string" ? business.id : null,
    );
  }
}

/**
 * Fallback: Original LLM-only generation (when DataForSEO fails)
 */
async function fallbackToLLMGeneration(
  business: any,
  userId: string,
  businessId?: string | null,
) {
  console.log(
    "⚠️ Using LLM-only fallback (not recommended - data will be estimates)",
  );

  async function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
    return shouldContinueWithGuards(messages as AIMessage[], {
      workflowName: "keyword-fallback-generation",
      maxToolRounds: getGraphMaxToolRounds(),
      duplicateToolCallLimit: 2,
      successMarkers: ["Saved", "keywords successfully"],
      failureMarkers: ["Tool execution failed", "Error:"],
    });
  }

  async function callModel(state: typeof MessagesAnnotation.State) {
    const response = await keywordLLM.invoke([
      {
        role: "system",
        content: `You are an expert SEO Strategist. Generate 30 keyword ideas for an INITIAL 30-day content plan.

IMPORTANT: Your keyword difficulty and search volume will be ESTIMATES only. Real data from DataForSEO API is not available.

Generate keywords based on:
- Business: ${business.businessName} (${business.businessType})
- Description: ${business.businessDescription}
- Location: ${business.businessCity || "N/A"}, ${
          business.businessCountry || "N/A"
        }

Strategic Framework:
- Days 1-10: Low-difficulty long-tail keywords (quick wins)
- Days 11-20: Medium-difficulty keywords (competitive positioning)
- Days 21-30: Higher-difficulty keywords (authority building)

Output format:
{
  "data": [
    {
      "keyword": "your keyword suggestion",
      "publishDate": "YYYY-MM-DD",
      "publishTime": "08:00",
      "keywordDiffculty": "estimated 0-100",
      "keywordSearchVolume": "estimated monthly searches",
      "keywordCategory": "informational|commercial|local|transactional",
      "keywordIntent": "informational|navigational|commercial|transactional",
      "userId": "${userId}",
      "businessId": "${businessId || business.id || ""}"
    }
  ]
}`,
      },
      ...state.messages,
    ]);

    return { messages: [response] };
  }

  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("llm", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "llm")
    .addEdge("tools", "llm")
    .addConditionalEdges("llm", shouldContinue);

  const app = workflow.compile();

  const response = await app.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Generate INITIAL 30-day keyword plan. Business: ${JSON.stringify(
            business,
          )}`,
        },
      ],
    },
    {
      recursionLimit: getGraphRecursionLimit(),
    },
  );

  return response.messages[response.messages.length - 1]?.content;
}
