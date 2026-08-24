import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";
import {
  resolveOrderedSelectedServices,
  resolveServicesPriorityMap,
  type EffectiveServices,
} from "./effective-services.utils";

export type KeywordSourceType =
  | "service_seed"
  | "domain"
  | "competitor"
  | "gap"
  | "refinement"
  | "geo_expansion";

export type DifficultyBucket = "easy" | "medium" | "hard";
export type KeywordIntentBucket =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";
export type IntentSource = "dataforseo" | "ai" | "heuristic";
export type BusinessAreaGroup = "product" | "service";

export type KeywordTrendPoint = {
  year: number;
  month: number;
  searchVolume: number;
};

export type CanonicalBusinessArea = {
  name: string;
  aliases: string[];
  group: BusinessAreaGroup;
  priorityRank: number;
  required: boolean;
};

/** GEO-KW-3: GEO target metadata attached to location-expanded candidates. */
export type GeoTarget = {
  /** Display city name used for keyword seeding (e.g., "Toronto", "Yorkville"). */
  targetCity: string;
  /** DataForSEO location code used for search-volume scoring. */
  targetLocationCode: number;
  /** How this candidate's geo target was derived. */
  geoSource: "primary" | "service-area" | "neighborhood" | "generic";
  /** Whether the city was verified via Google Places (vs raw user input). */
  isResolved: boolean;
};

export type KeywordCandidate = {
  keyword: string;
  searchVolume: number;
  difficulty: number;
  cpc?: number | null;
  competition?: number | null;
  trend?: KeywordTrendPoint[];
  monthlySearches?: number | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  keywordCategory?: string | null;
  keywordIntent?: string | null;
  intentSource?: IntentSource | null;
  score?: number;
  trendGrowth?: number;
  relevanceScore?: number;
  trafficPotential?: number;
  sourceType: KeywordSourceType;
  allSources?: KeywordSourceType[];
  sourceLabel?: string | null;
  originSeeds: string[];
  matchedService?: string | null;
  refinementRound: number;
  aiSelectedService?: string | null;
  aiReason?: string | null;
  aiRelevanceScore?: number | null;
  canonicalBusinessArea?: string | null;
  businessAreaGroup?: BusinessAreaGroup | null;
  businessAreaPriority?: number | null;
  semanticCluster?: string | null;
  naturalnessScore?: number | null;
  isBlogWorthy?: boolean | null;
  qualityScore?: number | null;
  selectionReason?: string | null;
  /** GEO-KW-3: geo targeting metadata for location-expanded candidates. */
  geoTarget?: GeoTarget | null;
};

export type SelectionMetadata = {
  selectedService: string | null;
  focusArea: string | null;
  sourceType: KeywordSourceType;
  allSources: KeywordSourceType[];
  sourceLabel: string | null;
  originSeeds: string[];
  aiReason: string | null;
  selectionReason: string | null;
  aiRelevanceScore: number | null;
  refinementRound: number;
  canonicalBusinessArea: string | null;
  businessAreaGroup: BusinessAreaGroup | null;
  priorityRank: number | null;
  semanticCluster: string | null;
  naturalnessScore: number | null;
  qualityScore: number | null;
  isBlogWorthy: boolean | null;
  intentSource: IntentSource | null;
  metricsSnapshot: {
    searchVolume: number;
    difficulty: number;
    competition: number | null;
    cpc: number | null;
    monthlySearches: number | null;
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
  };
  /** GEO-KW-3: persisted geo-targeting detail for this keyword's plan entry. */
  geo?: {
    targetCity: string;
    targetLocationCode: number;
    geoSource: "primary" | "service-area" | "neighborhood" | "generic";
    isResolved: boolean;
  } | null;
};

export type KeywordSelectionSummary = {
  selectedCount: number;
  difficultyCounts: Record<DifficultyBucket, number>;
  intentCounts: Record<KeywordIntentBucket, number>;
  serviceCounts: Record<string, number>;
  groupCounts: Record<BusinessAreaGroup, number>;
};

export type KeywordSelectionTargets = {
  difficulty: Record<DifficultyBucket, number>;
  intent: Record<KeywordIntentBucket, number>;
  maxPerArea: number;
  productMin: number;
  serviceMin: number;
};

export type CandidateQualityEvaluation = {
  accepted: boolean;
  reasons: string[];
  qualityScore: number;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "best",
  "for",
  "from",
  "guide",
  "how",
  "in",
  "is",
  "near",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "what",
  "why",
  "with",
]);

const PRODUCT_HINTS = [
  "camera",
  "cameras",
  "cctv",
  "nvr",
  "dvr",
  "recorder",
  "recorders",
  "accessory",
  "accessories",
  "device",
  "devices",
  "lens",
  "lenses",
  "sensor",
  "sensors",
  "detector",
  "detectors",
  "mount",
  "mounts",
  "box",
  "boxes",
  "kit",
  "kits",
  "app",
  "apps",
];

const SERVICE_HINTS = [
  "service",
  "services",
  "installation",
  "install",
  "installer",
  "estimate",
  "estimates",
  "consulting",
  "consultant",
  "repair",
  "repairs",
  "maintenance",
  "troubleshooting",
  "troubleshoot",
  "electrician",
  "electrical",
  "contractor",
  "contractors",
  "monitoring",
  "support",
  "inspection",
  "audits",
];

const CLUSTER_MODIFIERS = new Set([
  "best",
  "local",
  "smart",
  "small",
  "home",
  "residential",
  "commercial",
  "industrial",
  "high",
  "low",
  "resolution",
  "service",
  "services",
  "installation",
  "install",
  "installer",
  "guide",
  "guides",
  "tips",
  "tip",
  "solution",
  "solutions",
  "cost",
  "costs",
  "price",
  "prices",
  "buy",
  "purchase",
  "review",
  "reviews",
  "comparison",
  "compare",
]);

const LOW_SIGNAL_PHRASES = new Set([
  "nvr video",
  "master electrical service",
]);

const GENERIC_PRODUCT_NOUNS = new Set([
  "camera",
  "cameras",
  "system",
  "systems",
  "video",
  "security",
  "electrical",
]);

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStringList(values?: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = normalizeText(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(cleaned);
  }

  return normalized;
}

function tokenizeNormalizedText(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .map(singularizeToken)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function computeTokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenizeNormalizedText(a));
  const tokensB = new Set(tokenizeNormalizedText(b));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  const overlapA = intersection / tokensA.size;
  const overlapB = intersection / tokensB.size;
  const jaccard = intersection / union;

  return Math.max(jaccard, (overlapA + overlapB) / 2);
}

function resolveAreaSourceThreshold(source: string): number {
  switch (source) {
    case "sub_offering":
    case "industry_focus":
      return 0.75;
    case "detected":
      return 0.68;
    default:
      return 0.58;
  }
}

function inferBusinessAreaGroup(
  serviceName: string,
  businessContext: BusinessContextAnalysis,
): BusinessAreaGroup {
  const normalized = normalizeText(serviceName);
  const tokens = tokenizeNormalizedText(serviceName);
  const productHits = tokens.filter((token) =>
    PRODUCT_HINTS.includes(token),
  ).length;
  const serviceHits = tokens.filter((token) =>
    SERVICE_HINTS.includes(token),
  ).length;

  if (serviceHits > productHits) {
    return "service";
  }
  if (productHits > serviceHits) {
    return "product";
  }

  if (/(installation|electrical|consult|estimate|repair|troubleshoot)/.test(normalized)) {
    return "service";
  }
  if (/(camera|cctv|nvr|accessor|device|kit|mount)/.test(normalized)) {
    return "product";
  }

  return businessContext.businessModel.type === "product" ? "product" : "service";
}

export function normalizeKeywordText(keyword: string): string {
  return normalizeText(keyword);
}

export function tokenizeKeyword(text: string): string[] {
  return tokenizeNormalizedText(text);
}

export function inferKeywordIntent(keyword: string): KeywordIntentBucket {
  const keywordLower = normalizeKeywordText(keyword);

  if (/(buy|price|order|cost|purchase|hire|book|quote|sale|deal)/.test(keywordLower)) {
    return "transactional";
  }
  if (
    /(best|top|review|compare|vs|alternative|rating|solution|solutions|system|systems)/.test(
      keywordLower,
    )
  ) {
    return "commercial";
  }
  if (/(near me| in [a-z]+| local\b| location\b| directions\b)/.test(keywordLower)) {
    return "navigational";
  }
  return "informational";
}

export function bucketDifficulty(
  difficulty: number,
  strategy?: BusinessContextAnalysis["keywordStrategy"],
): DifficultyBucket {
  if (!strategy) {
    if (difficulty < 45) return "easy";
    if (difficulty < 70) return "medium";
    return "hard";
  }

  if (difficulty <= strategy.difficultyDistribution.easy.max) {
    return "easy";
  }
  if (difficulty <= strategy.difficultyDistribution.medium.max) {
    return "medium";
  }
  return "hard";
}

export function mapKeywordToService(
  keyword: string,
  services: string[],
  focusAreas: string[] = [],
): string | null {
  const keywordTokens = new Set(tokenizeKeyword(keyword));
  let bestService: string | null = null;
  let bestScore = 0;

  for (const service of [...services, ...focusAreas]) {
    const serviceTokens = tokenizeKeyword(service);
    if (serviceTokens.length === 0) continue;

    let overlap = 0;
    for (const token of serviceTokens) {
      if (keywordTokens.has(token)) {
        overlap += 1;
      }
    }

    const exactPhrase = normalizeKeywordText(keyword).includes(
      normalizeKeywordText(service),
    )
      ? 2
      : 0;
    const score = overlap / serviceTokens.length + exactPhrase;

    if (score > bestScore) {
      bestScore = score;
      bestService = service;
    }
  }

  return bestScore > 0 ? bestService : null;
}

export function canonicalizeServiceName(
  serviceName: string | null | undefined,
  services: string[],
  focusAreas: string[] = [],
): string | null {
  if (!serviceName) {
    return null;
  }

  const normalizedServiceName = normalizeKeywordText(serviceName);
  const canonicalMatch = [...services, ...focusAreas].find(
    (service) => normalizeKeywordText(service) === normalizedServiceName,
  );
  if (canonicalMatch) {
    return canonicalMatch;
  }

  return mapKeywordToService(serviceName, services, focusAreas) || serviceName;
}

export function buildCanonicalBusinessAreas(params: {
  business: any;
  businessContext: BusinessContextAnalysis;
  effectiveServices: EffectiveServices;
}): CanonicalBusinessArea[] {
  const { business, businessContext, effectiveServices } = params;
  const priorityMap = resolveServicesPriorityMap(business.servicesPriority);
  const selectedServices = resolveOrderedSelectedServices(
    business.selectedServices,
    business.servicesPriority,
  );
  const detectedServices = normalizeStringList(business.detectedServices);
  const sourceEntries: Array<{
    label: string;
    source: string;
    priorityRank: number;
  }> = [];

  const pushSourceEntries = (
    labels: string[],
    source: string,
    baseRank: number,
  ) => {
    labels.forEach((label, index) => {
      const cleaned = label.replace(/\s+/g, " ").trim();
      if (!cleaned) return;
      sourceEntries.push({
        label: cleaned,
        source,
        priorityRank: priorityMap[cleaned] ?? baseRank + index,
      });
    });
  };

  pushSourceEntries(selectedServices, "selected", 0);
  pushSourceEntries(effectiveServices.topLevel, "top_level", 100);
  pushSourceEntries(detectedServices, "detected", 200);
  pushSourceEntries(effectiveServices.subOfferings, "sub_offering", 300);
  pushSourceEntries(effectiveServices.industryFocus, "industry_focus", 400);

  if (sourceEntries.length === 0) {
    pushSourceEntries(businessContext.services.primary, "context_primary", 500);
  }

  const areas: CanonicalBusinessArea[] = [];

  const findBestArea = (label: string) => {
    const normalized = normalizeText(label);
    let best:
      | {
          area: CanonicalBusinessArea;
          score: number;
        }
      | null = null;

    for (const area of areas) {
      const scores = [area.name, ...area.aliases].map((alias) => {
        const aliasNormalized = normalizeText(alias);
        if (aliasNormalized === normalized) {
          return 1;
        }
        return computeTokenSimilarity(alias, label);
      });
      const score = Math.max(...scores);
      if (!best || score > best.score) {
        best = { area, score };
      }
    }

    return best;
  };

  for (const entry of sourceEntries) {
    const threshold = resolveAreaSourceThreshold(entry.source);
    const bestArea = findBestArea(entry.label);

    if (
      entry.source === "industry_focus" &&
      tokenizeNormalizedText(entry.label).length < 2
    ) {
      if (bestArea && bestArea.score >= 0.45) {
        if (
          !bestArea.area.aliases.some(
            (alias) => normalizeText(alias) === normalizeText(entry.label),
          )
        ) {
          bestArea.area.aliases.push(entry.label);
        }
      }
      continue;
    }

    if (bestArea && bestArea.score >= threshold) {
      if (
        !bestArea.area.aliases.some(
          (alias) => normalizeText(alias) === normalizeText(entry.label),
        )
      ) {
        bestArea.area.aliases.push(entry.label);
      }
      bestArea.area.priorityRank = Math.min(
        bestArea.area.priorityRank,
        entry.priorityRank,
      );
      continue;
    }

    areas.push({
      name: entry.label,
      aliases: [entry.label],
      group: inferBusinessAreaGroup(entry.label, businessContext),
      priorityRank: entry.priorityRank,
      required: false,
    });
  }

  return areas
    .sort((a, b) => {
      if (a.priorityRank !== b.priorityRank) {
        return a.priorityRank - b.priorityRank;
      }
      return a.name.localeCompare(b.name);
    })
    .map((area, index) => ({
      ...area,
      priorityRank: index + 1,
      aliases: Array.from(
        new Set(area.aliases.map((alias) => alias.replace(/\s+/g, " ").trim())),
      ),
    }));
}

export function canonicalizeBusinessAreaName(
  areaName: string | null | undefined,
  businessAreas: CanonicalBusinessArea[],
): string | null {
  if (!areaName) {
    return null;
  }

  const normalizedAreaName = normalizeText(areaName);
  const directMatch = businessAreas.find(
    (area) =>
      normalizeText(area.name) === normalizedAreaName ||
      area.aliases.some((alias) => normalizeText(alias) === normalizedAreaName),
  );

  if (directMatch) {
    return directMatch.name;
  }

  let best: { name: string; score: number } | null = null;

  for (const area of businessAreas) {
    const score = Math.max(
      computeTokenSimilarity(area.name, areaName),
      ...area.aliases.map((alias) => computeTokenSimilarity(alias, areaName)),
    );
    if (!best || score > best.score) {
      best = { name: area.name, score };
    }
  }

  return best && best.score >= 0.55 ? best.name : null;
}

export function mapKeywordToBusinessArea(
  keyword: string,
  businessAreas: CanonicalBusinessArea[],
): string | null {
  const normalizedKeyword = normalizeKeywordText(keyword);
  let bestMatch: { areaName: string; score: number } | null = null;

  for (const area of businessAreas) {
    const aliasScores = [area.name, ...area.aliases].map((alias) => {
      const normalizedAlias = normalizeKeywordText(alias);
      if (
        normalizedKeyword.includes(normalizedAlias) ||
        normalizedAlias.includes(normalizedKeyword)
      ) {
        return 1.2;
      }
      return computeTokenSimilarity(keyword, alias);
    });
    const score = Math.max(...aliasScores);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { areaName: area.name, score };
    }
  }

  return bestMatch && bestMatch.score >= 0.4 ? bestMatch.areaName : null;
}

export function deriveSemanticCluster(keyword: string): string {
  const tokens = tokenizeKeyword(keyword).filter(
    (token) => !CLUSTER_MODIFIERS.has(token),
  );
  const clusterTokens = tokens.length > 0 ? tokens : tokenizeKeyword(keyword);
  return clusterTokens.slice(0, 3).join(" ");
}

export function looksLocationModifiedKeyword(keyword: string): boolean {
  return /(\bnear me\b|\bin [a-z]+\b|\blocal\b|\bnearby\b)/.test(
    normalizeKeywordText(keyword),
  );
}

function isThinServiceVariant(keyword: string): boolean {
  const normalized = normalizeKeywordText(keyword);
  const tokens = tokenizeKeyword(keyword);
  if (tokens.length <= 2 && /(services?|solutions?)$/.test(normalized)) {
    return true;
  }

  return (
    /(installation services?|installation service|service installation)$/.test(
      normalized,
    ) && tokens.length <= 4
  );
}

export function isAwkwardKeywordPhrase(keyword: string): boolean {
  const normalized = normalizeKeywordText(keyword);
  if (LOW_SIGNAL_PHRASES.has(normalized)) {
    return true;
  }

  if (/^(master|expert|professional)\s+[a-z]+\s+service$/.test(normalized)) {
    return true;
  }

  if (/^[a-z]{2,5}\s+video$/.test(normalized)) {
    return true;
  }

  return false;
}

export function calculateKeywordQualityScore(candidate: KeywordCandidate): number {
  const keyword = normalizeKeywordText(candidate.keyword);
  const tokens = tokenizeKeyword(candidate.keyword);
  let quality = 1;

  if (tokens.length < 2 || tokens.length > 8) {
    quality -= 0.25;
  }

  if (!candidate.canonicalBusinessArea) {
    quality -= 0.35;
  }

  if (isAwkwardKeywordPhrase(keyword)) {
    quality -= 0.45;
  }

  if (isThinServiceVariant(keyword)) {
    quality -= 0.2;
  }

  const meaningfulTokens = tokens.filter(
    (token) => !GENERIC_PRODUCT_NOUNS.has(token),
  );
  if (meaningfulTokens.length === 0) {
    quality -= 0.25;
  }

  if ((candidate.monthlySearches ?? candidate.searchVolume ?? 0) < 20) {
    quality -= 0.15;
  }

  return Math.max(0, Math.min(1, quality));
}

export function evaluateKeywordCandidateQuality(
  candidate: KeywordCandidate,
  options: {
    businessAreas: CanonicalBusinessArea[];
    businessContext: BusinessContextAnalysis;
    mustHaveKeywords: string[];
  },
): CandidateQualityEvaluation {
  const mustHaveSet = new Set(
    options.mustHaveKeywords.map((keyword) => normalizeKeywordText(keyword)),
  );
  const normalizedKeyword = normalizeKeywordText(candidate.keyword);
  const monthlyVolume =
    candidate.monthlySearches ?? candidate.searchVolume ?? 0;
  const qualityScore = calculateKeywordQualityScore(candidate);
  const reasons: string[] = [];

  if (!candidate.canonicalBusinessArea) {
    reasons.push("no_business_area");
  }

  if (candidate.isBlogWorthy === false) {
    reasons.push("not_blog_worthy");
  }

  if ((candidate.naturalnessScore ?? 1) < 0.65) {
    reasons.push("low_naturalness");
  }

  if (
    !options.businessContext.businessModel.isLocationDependent &&
    looksLocationModifiedKeyword(candidate.keyword)
  ) {
    reasons.push("invalid_location_modifier");
  }

  if (isAwkwardKeywordPhrase(candidate.keyword)) {
    reasons.push("awkward_phrase");
  }

  if (isThinServiceVariant(candidate.keyword)) {
    reasons.push("thin_service_fragment");
  }

  const isMustHave = Array.from(mustHaveSet).some((mustHave) =>
    normalizedKeyword.includes(mustHave),
  );

  if (monthlyVolume < 20 && !isMustHave) {
    reasons.push("low_volume");
  }

  if (qualityScore < 0.45) {
    reasons.push("low_quality");
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    qualityScore,
  };
}

export function mergeKeywordCandidate(
  existing: KeywordCandidate | undefined,
  next: KeywordCandidate,
): KeywordCandidate {
  if (!existing) {
    return {
      ...next,
      originSeeds: Array.from(new Set(next.originSeeds)),
    };
  }

  const preferred =
    (next.searchVolume ?? 0) > (existing.searchVolume ?? 0) ? next : existing;
  const secondary = preferred === next ? existing : next;

  const allSources = Array.from(
    new Set([existing.sourceType, next.sourceType].filter(Boolean)),
  ) as KeywordSourceType[];

  return {
    ...preferred,
    cpc: preferred.cpc ?? secondary.cpc ?? null,
    competition: preferred.competition ?? secondary.competition ?? null,
    trend: preferred.trend?.length ? preferred.trend : secondary.trend,
    monthlySearches:
      preferred.monthlySearches ?? secondary.monthlySearches ?? null,
    clicks: preferred.clicks ?? secondary.clicks ?? null,
    impressions: preferred.impressions ?? secondary.impressions ?? null,
    ctr: preferred.ctr ?? secondary.ctr ?? null,
    keywordCategory:
      preferred.keywordCategory ?? secondary.keywordCategory ?? null,
    keywordIntent: preferred.keywordIntent ?? secondary.keywordIntent ?? null,
    intentSource: preferred.intentSource ?? secondary.intentSource ?? null,
    matchedService: preferred.matchedService ?? secondary.matchedService ?? null,
    aiSelectedService:
      preferred.aiSelectedService ?? secondary.aiSelectedService ?? null,
    aiReason: preferred.aiReason ?? secondary.aiReason ?? null,
    aiRelevanceScore:
      preferred.aiRelevanceScore ?? secondary.aiRelevanceScore ?? null,
    canonicalBusinessArea:
      preferred.canonicalBusinessArea ?? secondary.canonicalBusinessArea ?? null,
    businessAreaGroup:
      preferred.businessAreaGroup ?? secondary.businessAreaGroup ?? null,
    businessAreaPriority:
      preferred.businessAreaPriority ?? secondary.businessAreaPriority ?? null,
    semanticCluster: preferred.semanticCluster ?? secondary.semanticCluster ?? null,
    naturalnessScore:
      preferred.naturalnessScore ?? secondary.naturalnessScore ?? null,
    isBlogWorthy: preferred.isBlogWorthy ?? secondary.isBlogWorthy ?? null,
    qualityScore: preferred.qualityScore ?? secondary.qualityScore ?? null,
    selectionReason: preferred.selectionReason ?? secondary.selectionReason ?? null,
    sourceType: preferred.sourceType,
    allSources,
    sourceLabel: preferred.sourceLabel ?? secondary.sourceLabel ?? null,
    originSeeds: Array.from(
      new Set([...(existing.originSeeds || []), ...(next.originSeeds || [])]),
    ),
    refinementRound: Math.max(
      existing.refinementRound ?? 0,
      next.refinementRound ?? 0,
    ),
  } as KeywordCandidate;
}

export function isNearDuplicateKeyword(a: string, b: string): boolean {
  const normalizedA = normalizeKeywordText(a);
  const normalizedB = normalizeKeywordText(b);
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return true;
  }

  const tokensA = new Set(tokenizeKeyword(normalizedA));
  const tokensB = new Set(tokenizeKeyword(normalizedB));
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union >= 0.75 : false;
}

function normalizeIntentTargets(
  targets: Record<KeywordIntentBucket, number>,
): Record<KeywordIntentBucket, number> {
  const normalized = { ...targets };
  const total =
    normalized.informational +
    normalized.commercial +
    normalized.transactional +
    normalized.navigational;
  let diff = 30 - total;

  const priority: KeywordIntentBucket[] = [
    "informational",
    "commercial",
    "transactional",
    "navigational",
  ];

  while (diff !== 0) {
    for (const intent of priority) {
      if (diff === 0) break;
      if (diff > 0) {
        normalized[intent] += 1;
        diff -= 1;
      } else if (normalized[intent] > 0) {
        normalized[intent] -= 1;
        diff += 1;
      }
    }
  }

  return normalized;
}

export function getSelectionTargets(
  strategy: BusinessContextAnalysis["keywordStrategy"] | undefined,
  areaCount: number = 1,
  hasProductAndService: boolean = false,
): KeywordSelectionTargets {
  const fallbackDifficulty: Record<DifficultyBucket, number> = {
    easy: 10,
    medium: 12,
    hard: 8,
  };
  const fallbackIntent: Record<KeywordIntentBucket, number> = {
    informational: 16,
    commercial: 8,
    transactional: 4,
    navigational: 2,
  };

  const difficulty = strategy
    ? {
        easy: strategy.difficultyDistribution.easy.count,
        medium: strategy.difficultyDistribution.medium.count,
        hard: strategy.difficultyDistribution.hard.count,
      }
    : fallbackDifficulty;

  let intent = strategy
    ? normalizeIntentTargets({
        informational: Math.round(
          30 * (strategy.intentDistribution.informational / 100),
        ),
        commercial: Math.round(
          30 * (strategy.intentDistribution.commercial / 100),
        ),
        transactional: Math.round(
          30 * (strategy.intentDistribution.transactional / 100),
        ),
        navigational: Math.round(
          30 * (strategy.intentDistribution.navigational / 100),
        ),
      })
    : fallbackIntent;

  if (hasProductAndService) {
    intent = normalizeIntentTargets({
      ...intent,
      commercial: Math.max(intent.commercial, 6),
      transactional: Math.max(intent.transactional, 3),
    });
  }

  const maxPerArea =
    areaCount <= 1 ? 30 : areaCount < 4 ? 12 : 8;

  return {
    difficulty,
    intent,
    maxPerArea,
    productMin: hasProductAndService ? 12 : 0,
    serviceMin: hasProductAndService ? 12 : 0,
  };
}

function getCandidateScore(candidate: KeywordCandidate): number {
  const aiScore = candidate.aiRelevanceScore ?? 0;
  const traffic = candidate.trafficPotential ?? 0;
  const relevance = candidate.relevanceScore ?? 0;
  const quality = candidate.qualityScore ?? calculateKeywordQualityScore(candidate);
  const naturalness = candidate.naturalnessScore ?? 0.75;
  const sourceBonus =
    candidate.sourceType === "gap"
      ? 0.6
      : candidate.sourceType === "competitor"
        ? 0.45
        : candidate.sourceType === "refinement"
          ? 0.5
          : candidate.sourceType === "domain"
            ? 0.35
            : 0.25;

  return (
    aiScore * 5 +
    relevance * 3 +
    traffic * 4 +
    quality * 2.5 +
    naturalness * 1.5 +
    sourceBonus
  );
}

function sortCandidatesForSelection(candidates: KeywordCandidate[]) {
  return [...candidates].sort((a, b) => {
    const scoreDiff = getCandidateScore(b) - getCandidateScore(a);
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
    if ((b.searchVolume ?? 0) !== (a.searchVolume ?? 0)) {
      return (b.searchVolume ?? 0) - (a.searchVolume ?? 0);
    }
    return a.keyword.localeCompare(b.keyword);
  });
}

function resolveIntent(candidate: KeywordCandidate): KeywordIntentBucket {
  return (
    (candidate.keywordIntent as KeywordIntentBucket | undefined) ||
    inferKeywordIntent(candidate.keyword)
  );
}

function rankCandidateForNeeds(
  candidate: KeywordCandidate,
  strategy: BusinessContextAnalysis["keywordStrategy"] | undefined,
  difficultyCounts: Record<DifficultyBucket, number>,
  intentCounts: Record<KeywordIntentBucket, number>,
  targets: KeywordSelectionTargets,
  areaCounts: Map<string, number>,
  areaMinimums: Map<string, number>,
  groupCounts: Record<BusinessAreaGroup, number>,
): number {
  const difficultyBucket = bucketDifficulty(candidate.difficulty, strategy);
  const intent = resolveIntent(candidate);
  const areaName = candidate.canonicalBusinessArea;
  const areaGroup = candidate.businessAreaGroup;

  let score = getCandidateScore(candidate);

  if (difficultyCounts[difficultyBucket] < targets.difficulty[difficultyBucket]) {
    score += 5;
  } else {
    score -= 1.5;
  }

  if (intentCounts[intent] < targets.intent[intent]) {
    score += 4.5;
  } else {
    score -= 1;
  }

  if (areaName) {
    const minTarget = areaMinimums.get(areaName) ?? 0;
    if ((areaCounts.get(areaName) ?? 0) < minTarget) {
      score += 8;
    }
    if ((areaCounts.get(areaName) ?? 0) >= targets.maxPerArea) {
      score -= 12;
    }
  }

  if (areaGroup === "product" && groupCounts.product < targets.productMin) {
    score += 5;
  }
  if (areaGroup === "service" && groupCounts.service < targets.serviceMin) {
    score += 5;
  }

  if (intent === "commercial" || intent === "transactional") {
    score += 1;
  }

  return score;
}

type SelectKeywordsParams = {
  candidates: KeywordCandidate[];
  businessAreas: CanonicalBusinessArea[];
  mustHaveKeywords: string[];
  strategy?: BusinessContextAnalysis["keywordStrategy"];
};

export function selectKeywordsDeterministically({
  candidates,
  businessAreas,
  mustHaveKeywords,
  strategy,
}: SelectKeywordsParams): {
  selected: KeywordCandidate[];
  summary: KeywordSelectionSummary;
} {
  const viableAreas = businessAreas
    .map((area) => ({
      ...area,
      required: false,
      candidateCount: candidates.filter(
        (candidate) => candidate.canonicalBusinessArea === area.name,
      ).length,
    }))
    .filter((area) => area.candidateCount > 0)
    .sort((a, b) => a.priorityRank - b.priorityRank);

  const hasProductAreas = viableAreas.some((area) => area.group === "product");
  const hasServiceAreas = viableAreas.some((area) => area.group === "service");
  const targets = getSelectionTargets(
    strategy,
    viableAreas.length,
    hasProductAreas && hasServiceAreas,
  );
  const sortedCandidates = sortCandidatesForSelection(candidates);
  const selected: KeywordCandidate[] = [];
  const selectedTextSet = new Set<string>();
  const areaCounts = new Map<string, number>();
  const difficultyCounts: Record<DifficultyBucket, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
  };
  const intentCounts: Record<KeywordIntentBucket, number> = {
    informational: 0,
    commercial: 0,
    transactional: 0,
    navigational: 0,
  };
  const groupCounts: Record<BusinessAreaGroup, number> = {
    product: 0,
    service: 0,
  };

  const requiredAreaNames = new Set(
    viableAreas.slice(0, 4).map((area) => area.name),
  );
  const areaMinimums = new Map<string, number>();
  for (const area of viableAreas) {
    if (requiredAreaNames.has(area.name)) {
      areaMinimums.set(area.name, Math.min(2, area.candidateCount));
    } else if (viableAreas.length <= 22) {
      areaMinimums.set(area.name, 1);
    }
  }

  const productCandidateCount = candidates.filter(
    (candidate) => candidate.businessAreaGroup === "product",
  ).length;
  const serviceCandidateCount = candidates.filter(
    (candidate) => candidate.businessAreaGroup === "service",
  ).length;
  targets.productMin = Math.min(targets.productMin, productCandidateCount);
  targets.serviceMin = Math.min(targets.serviceMin, serviceCandidateCount);

  const canAdd = (candidate: KeywordCandidate) => {
    const normalized = normalizeKeywordText(candidate.keyword);
    if (selectedTextSet.has(normalized)) {
      return false;
    }

    const areaName = candidate.canonicalBusinessArea;
    if (areaName && (areaCounts.get(areaName) ?? 0) >= targets.maxPerArea) {
      return false;
    }

    const candidateIntent = resolveIntent(candidate);
    const candidateCluster =
      candidate.semanticCluster || deriveSemanticCluster(candidate.keyword);

    for (const existing of selected) {
      const existingIntent = resolveIntent(existing);
      const existingCluster =
        existing.semanticCluster || deriveSemanticCluster(existing.keyword);
      const differentArea =
        existing.canonicalBusinessArea &&
        candidate.canonicalBusinessArea &&
        existing.canonicalBusinessArea !== candidate.canonicalBusinessArea;
      const differentIntent = existingIntent !== candidateIntent;

      if (candidateCluster && existingCluster && candidateCluster === existingCluster) {
        if (!(differentArea && differentIntent)) {
          return false;
        }
      }

      if (
        existingIntent === candidateIntent &&
        isNearDuplicateKeyword(existing.keyword, candidate.keyword)
      ) {
        return false;
      }
    }

    return true;
  };

  const addCandidate = (candidate: KeywordCandidate) => {
    const normalized = normalizeKeywordText(candidate.keyword);
    selected.push(candidate);
    selectedTextSet.add(normalized);

    if (candidate.canonicalBusinessArea) {
      areaCounts.set(
        candidate.canonicalBusinessArea,
        (areaCounts.get(candidate.canonicalBusinessArea) ?? 0) + 1,
      );
    }

    const difficultyBucket = bucketDifficulty(candidate.difficulty, strategy);
    difficultyCounts[difficultyBucket] += 1;

    const intent = resolveIntent(candidate);
    intentCounts[intent] += 1;

    if (candidate.businessAreaGroup) {
      groupCounts[candidate.businessAreaGroup] += 1;
    }
  };

  const sortedByNeed = (pool: KeywordCandidate[]) =>
    [...pool].sort(
      (a, b) =>
        rankCandidateForNeeds(
          b,
          strategy,
          difficultyCounts,
          intentCounts,
          targets,
          areaCounts,
          areaMinimums,
          groupCounts,
        ) -
        rankCandidateForNeeds(
          a,
          strategy,
          difficultyCounts,
          intentCounts,
          targets,
          areaCounts,
          areaMinimums,
          groupCounts,
        ),
    );

  for (const mustHave of mustHaveKeywords) {
    const mustHaveLower = normalizeKeywordText(mustHave);
    const candidate = sortedByNeed(
      sortedCandidates.filter((item) => {
        const keywordLower = normalizeKeywordText(item.keyword);
        return keywordLower.includes(mustHaveLower) && canAdd(item);
      }),
    )[0];

    if (candidate) {
      addCandidate(candidate);
    }
  }

  for (const area of viableAreas.filter((item) => requiredAreaNames.has(item.name))) {
    while (
      (areaCounts.get(area.name) ?? 0) < (areaMinimums.get(area.name) ?? 0) &&
      selected.length < 30
    ) {
      const candidate = sortedByNeed(
        sortedCandidates.filter(
          (item) => item.canonicalBusinessArea === area.name && canAdd(item),
        ),
      )[0];
      if (!candidate) break;
      addCandidate(candidate);
    }
  }

  for (const area of viableAreas.filter((item) => !requiredAreaNames.has(item.name))) {
    if (selected.length >= 30) break;
    if ((areaMinimums.get(area.name) ?? 0) === 0) continue;
    const candidate = sortedByNeed(
      sortedCandidates.filter(
        (item) => item.canonicalBusinessArea === area.name && canAdd(item),
      ),
    )[0];
    if (candidate) {
      addCandidate(candidate);
    }
  }

  const fillByPredicate = (
    predicate: (candidate: KeywordCandidate) => boolean,
    target: number,
    currentCount: () => number,
  ) => {
    while (currentCount() < target && selected.length < 30) {
      const candidate = sortedByNeed(
        sortedCandidates.filter((item) => predicate(item) && canAdd(item)),
      )[0];
      if (!candidate) break;
      addCandidate(candidate);
    }
  };

  fillByPredicate(
    (candidate) => candidate.businessAreaGroup === "product",
    targets.productMin,
    () => groupCounts.product,
  );
  fillByPredicate(
    (candidate) => candidate.businessAreaGroup === "service",
    targets.serviceMin,
    () => groupCounts.service,
  );

  fillByPredicate(
    (candidate) => bucketDifficulty(candidate.difficulty, strategy) === "hard",
    targets.difficulty.hard,
    () => difficultyCounts.hard,
  );
  fillByPredicate(
    (candidate) => bucketDifficulty(candidate.difficulty, strategy) === "medium",
    targets.difficulty.medium,
    () => difficultyCounts.medium,
  );
  fillByPredicate(
    (candidate) => bucketDifficulty(candidate.difficulty, strategy) === "easy",
    targets.difficulty.easy,
    () => difficultyCounts.easy,
  );

  fillByPredicate(
    (candidate) => resolveIntent(candidate) === "commercial",
    targets.intent.commercial,
    () => intentCounts.commercial,
  );
  fillByPredicate(
    (candidate) => resolveIntent(candidate) === "transactional",
    targets.intent.transactional,
    () => intentCounts.transactional,
  );
  fillByPredicate(
    (candidate) => resolveIntent(candidate) === "navigational",
    targets.intent.navigational,
    () => intentCounts.navigational,
  );
  fillByPredicate(
    (candidate) => resolveIntent(candidate) === "informational",
    targets.intent.informational,
    () => intentCounts.informational,
  );

  for (const candidate of sortedByNeed(sortedCandidates)) {
    if (selected.length >= 30) break;
    if (!canAdd(candidate)) continue;
    addCandidate(candidate);
  }

  return {
    selected: selected.slice(0, 30),
    summary: {
      selectedCount: Math.min(selected.length, 30),
      difficultyCounts,
      intentCounts,
      serviceCounts: Object.fromEntries(areaCounts.entries()),
      groupCounts,
    },
  };
}

export function buildSelectionMetadata(
  candidate: KeywordCandidate,
  focusAreas: string[] = [],
  businessAreas: CanonicalBusinessArea[] = [],
): SelectionMetadata {
  const allSources = Array.from(
    new Set([...(candidate.allSources || []), candidate.sourceType].filter(Boolean)),
  ) as KeywordSourceType[];
  const canonicalArea =
    candidate.canonicalBusinessArea ||
    canonicalizeBusinessAreaName(
      candidate.aiSelectedService || candidate.matchedService,
      businessAreas,
    ) ||
    null;
  const businessArea = canonicalArea
    ? businessAreas.find((area) => area.name === canonicalArea)
    : null;

  return {
    selectedService: canonicalArea || candidate.aiSelectedService || candidate.matchedService || null,
    focusArea:
      canonicalArea && focusAreas.includes(canonicalArea)
        ? canonicalArea
        : candidate.aiSelectedService && focusAreas.includes(candidate.aiSelectedService)
          ? candidate.aiSelectedService
          : candidate.matchedService && focusAreas.includes(candidate.matchedService)
            ? candidate.matchedService
            : null,
    sourceType: candidate.sourceType,
    allSources,
    sourceLabel: candidate.sourceLabel ?? null,
    originSeeds: candidate.originSeeds,
    aiReason: candidate.aiReason ?? null,
    selectionReason: candidate.selectionReason ?? candidate.aiReason ?? null,
    aiRelevanceScore: candidate.aiRelevanceScore ?? null,
    refinementRound: candidate.refinementRound ?? 0,
    canonicalBusinessArea: canonicalArea,
    businessAreaGroup: candidate.businessAreaGroup ?? businessArea?.group ?? null,
    priorityRank: candidate.businessAreaPriority ?? businessArea?.priorityRank ?? null,
    semanticCluster: candidate.semanticCluster ?? deriveSemanticCluster(candidate.keyword),
    naturalnessScore: candidate.naturalnessScore ?? null,
    qualityScore:
      candidate.qualityScore ?? calculateKeywordQualityScore(candidate),
    isBlogWorthy: candidate.isBlogWorthy ?? null,
    intentSource: candidate.intentSource ?? null,
    metricsSnapshot: {
      searchVolume: candidate.searchVolume ?? 0,
      difficulty: candidate.difficulty ?? 0,
      competition: candidate.competition ?? null,
      cpc: candidate.cpc ?? null,
      monthlySearches: candidate.monthlySearches ?? null,
      clicks: candidate.clicks ?? null,
      impressions: candidate.impressions ?? null,
      ctr: candidate.ctr ?? null,
    },
    // GEO-KW-7: persist the geo targeting context so downstream systems
    // (keyword allocation, blog generation) know which metro this keyword
    // was scored against and where it should rank.
    geo: candidate.geoTarget
      ? {
          targetCity: candidate.geoTarget.targetCity,
          targetLocationCode: candidate.geoTarget.targetLocationCode,
          geoSource: candidate.geoTarget.geoSource,
          isResolved: candidate.geoTarget.isResolved,
        }
      : null,
  };
}
