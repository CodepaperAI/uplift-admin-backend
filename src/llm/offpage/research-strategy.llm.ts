/**
 * research-strategy.llm.ts
 *
 * First-pass planning agent for off-page research. It understands the business
 * before any Reddit or directory searching happens, then produces the exact
 * search strategy those channel agents should follow.
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import { formatBriefForPrompt } from "../../services/offpage/offpage-research.service";
import type {
  BusinessDiscoveryArchetype,
  BusinessOffPageProfile,
  BusinessResearchBrief,
  OffPageResearchStrategy,
} from "../../services/offpage/offpage-types";

const MODEL_FALLBACK = "gpt-5-mini";
const MAX_ITEMS = 10;

const ARCHETYPES: BusinessDiscoveryArchetype[] = [
  "local_recommendation",
  "local_service",
  "b2b_service",
  "professional_service",
  "saas",
  "ecommerce",
  "healthcare",
  "real_estate",
  "hospitality",
  "education",
  "other",
];

function uniq(values: string[], limit = MAX_ITEMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function asStringArray(value: unknown, limit = MAX_ITEMS): string[] {
  return Array.isArray(value)
    ? uniq(value.filter((v): v is string => typeof v === "string"), limit)
    : [];
}

function normalizeArchetype(value: unknown): BusinessDiscoveryArchetype {
  const raw = String(value ?? "").trim();
  return ARCHETYPES.includes(raw as BusinessDiscoveryArchetype)
    ? (raw as BusinessDiscoveryArchetype)
    : "other";
}

function splitTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}

function serviceTerms(brief: BusinessResearchBrief, profile: BusinessOffPageProfile): string[] {
  return uniq(
    [
      ...brief.services,
      ...brief.keywords,
      brief.category ?? "",
      profile.category ?? "",
      profile.businessName,
    ],
    12,
  );
}

function locationParts(brief: BusinessResearchBrief): string[] {
  return uniq(
    [
      brief.location.city ?? "",
      ...brief.location.neighborhoods,
      ...brief.location.serviceAreaLocations,
      brief.location.country ?? "",
    ],
    8,
  );
}

function classifyFallbackArchetype(
  brief: BusinessResearchBrief,
  profile: BusinessOffPageProfile,
): BusinessDiscoveryArchetype {
  const text = [
    brief.businessName,
    profile.businessName,
    brief.category,
    brief.description,
    brief.summary,
    ...brief.services,
    brief.industryPositioning,
  ]
    .join(" ")
    .toLowerCase();

  if (/\b(software|saas|platform|apps?|automation|crm|analytics|developer|api)\b/.test(text)) {
    return "saas";
  }
  if (/\b(ecommerce|e-commerce|shop|store|retail|product|marketplace|dtc|d2c)\b/.test(text)) {
    return "ecommerce";
  }
  if (/\b(plumbing|plumber|drain|hvac|roofing|electrician|electrical|demolition|moving|landscaping|cleaning|repair|contractor|construction)\b/.test(text)) {
    return "local_service";
  }
  if (/\b(doctor|clinic|dental|dentist|therapy|health|medical|wellness)\b/.test(text)) {
    return "healthcare";
  }
  if (/\b(agency|consulting|consultant|accounting|law|legal|marketing|design|development)\b/.test(text)) {
    return "professional_service";
  }
  if (/\b(real estate|realtor|mortgage|property|brokerage)\b/.test(text)) {
    return "real_estate";
  }
  if (/\b(restaurant|food|cafe|coffee|bar|bakery|catering|salon|spa|fitness|gym|venue|events?)\b/.test(text)) {
    return "local_recommendation";
  }
  if (profile.businessModelType === "service" && profile.isLocationDependent) {
    return "local_service";
  }
  if (profile.businessModelType === "service") return "b2b_service";
  return "other";
}

function archetypeRedditQueries(
  archetype: BusinessDiscoveryArchetype,
  primaryTerm: string,
  category: string,
  primaryLocation: string,
  painPoints: string[],
  keywords: string[],
): string[] {
  const localTerm = [primaryTerm, primaryLocation].filter(Boolean).join(" ");
  if (archetype === "saas") {
    return uniq([
      primaryTerm,
      `${primaryTerm} software`,
      `${primaryTerm} alternatives`,
      `best ${primaryTerm} tool`,
      ...painPoints.slice(0, 4),
      ...keywords.slice(0, 4),
    ], 8);
  }
  if (archetype === "ecommerce") {
    return uniq([
      primaryTerm,
      `best ${primaryTerm}`,
      `${primaryTerm} reviews`,
      `${category} recommendations`,
      ...painPoints.slice(0, 4),
      ...keywords.slice(0, 4),
    ], 8);
  }
  if (archetype === "professional_service" || archetype === "b2b_service") {
    return uniq([
      primaryTerm,
      `${category} recommendations`,
      `${category} advice`,
      `${primaryTerm} vs agency`,
      ...painPoints.slice(0, 4),
      ...keywords.slice(0, 4),
    ], 8);
  }
  if (archetype === "local_service" || archetype === "healthcare" || archetype === "real_estate") {
    return uniq([
      primaryTerm,
      localTerm,
      `recommend ${category} ${primaryLocation}`.trim(),
      `${category} advice`,
      ...painPoints.slice(0, 4),
      ...keywords.slice(0, 4),
    ], 8);
  }
  return uniq([
    primaryTerm,
    localTerm,
    ["best", primaryTerm, primaryLocation].filter(Boolean).join(" "),
    ...painPoints.slice(0, 3),
    ...keywords.slice(0, 4),
  ], 8);
}

function archetypeDirectoryQueries(
  archetype: BusinessDiscoveryArchetype,
  primaryTerm: string,
  category: string,
  primaryLocation: string,
  country?: string | null,
): string[] {
  if (archetype === "saas") {
    return uniq([
      `${category} reviews`,
      `best ${primaryTerm} software`,
      `${primaryTerm} alternatives`,
      `${category} directory`,
      `${category} Product Hunt`,
    ], 8);
  }
  if (archetype === "ecommerce") {
    return uniq([
      `${category} marketplace`,
      `${primaryTerm} reviews`,
      `best ${primaryTerm}`,
      `${category} shopping`,
      `${category} directory`,
    ], 8);
  }
  if (archetype === "professional_service" || archetype === "b2b_service") {
    return uniq([
      `${category} ${primaryLocation}`.trim(),
      `best ${category} ${primaryLocation}`.trim(),
      `${category} directory ${country ?? ""}`.trim(),
      `${category} reviews`,
      `${category} firms`,
    ], 8);
  }
  return uniq([
    [category, primaryLocation].filter(Boolean).join(" "),
    ["best", category, primaryLocation].filter(Boolean).join(" "),
    [primaryTerm, primaryLocation].filter(Boolean).join(" "),
    [category, "directory", country ?? ""].filter(Boolean).join(" "),
    [category, "reviews", primaryLocation].filter(Boolean).join(" "),
  ], 8);
}

function archetypeRequiredDirectories(
  archetype: BusinessDiscoveryArchetype,
): string[] {
  const localTrust = [
    "Google Business Profile",
    "Apple Business Connect",
    "Bing Places",
    "Yelp or regional review directory",
  ];
  if (archetype === "saas") {
    return ["G2", "Capterra", "Product Hunt", "Crunchbase", "LinkedIn company page"];
  }
  if (archetype === "ecommerce") {
    return ["Google Merchant Center", "Google Shopping", "Amazon/eBay or relevant marketplaces", "Pinterest business"];
  }
  if (archetype === "professional_service" || archetype === "b2b_service") {
    return [...localTrust, "Clutch", "GoodFirms", "DesignRush or industry portfolio directory"];
  }
  if (archetype === "healthcare") {
    return [...localTrust, "Healthgrades/RateMDs or regional healthcare directory"];
  }
  if (archetype === "real_estate") {
    return [...localTrust, "Zillow/Realtor or regional property directory"];
  }
  if (archetype === "local_recommendation" || archetype === "hospitality") {
    return [...localTrust, "TripAdvisor", "OpenTable/booking or food/travel marketplace"];
  }
  if (archetype === "local_service") {
    return [...localTrust, "HomeStars/Angi/Thumbtack or regional services marketplace"];
  }
  return localTrust;
}

export function buildFallbackResearchStrategy(
  brief: BusinessResearchBrief,
  profile: BusinessOffPageProfile,
): OffPageResearchStrategy {
  const terms = serviceTerms(brief, profile);
  const locations = locationParts(brief);
  const primaryTerm = terms[0] ?? brief.category ?? profile.businessName;
  const primaryLocation = locations[0] ?? "";
  const category = brief.category ?? profile.category ?? "business";
  const archetype = classifyFallbackArchetype(brief, profile);
  const topicQueries = archetypeRedditQueries(
    archetype,
    primaryTerm,
    category,
    primaryLocation,
    brief.painPoints,
    brief.keywords,
  );
  const directoryQueries = archetypeDirectoryQueries(
    archetype,
    primaryTerm,
    category,
    primaryLocation,
    brief.location.country,
  );

  const coreTerms = uniq(
    terms.flatMap(splitTerms).filter((term) => !locations.join(" ").toLowerCase().includes(term)),
    8,
  );

  return {
    businessSummary: `${profile.businessName || "This business"} is a ${category} with ${profile.scope} reach.`,
    archetype,
    demandSignals: uniq(
      [...(brief.contentTopics ?? []), ...brief.painPoints, ...brief.services, ...brief.keywords],
      12,
    ),
    reddit: {
      enabled: Boolean(primaryTerm),
      reason:
        "Use Reddit when people ask for recommendations, comparisons, troubleshooting, or lived experience around this business category.",
      subredditSeeds: uniq(
        [
          primaryLocation ? `r/${primaryLocation.replace(/[^a-z0-9_]/gi, "")}` : "",
          category,
          ...brief.services.slice(0, 4),
          ...(brief.targetAudience ? [brief.targetAudience] : []),
        ],
        8,
      ),
      threadSearchQueries: uniq(
        [...topicQueries, ...(brief.contentTopics ?? []).slice(0, 5)],
        10,
      ),
      coreTerms,
      audienceAngles: uniq(
        [
          ...brief.painPoints.slice(0, 4),
          ...brief.differentiators.slice(0, 4),
          `helpful ${category} recommendations`,
        ],
        8,
      ),
      avoidTerms: ["jobs", "hiring", "coupon", "free", "scam"],
    },
    directory: {
      enabled: Boolean(primaryTerm || category),
      reason:
        "Use directories where customers compare providers, verify legitimacy, or find local/category-specific options.",
      searchQueries: directoryQueries,
      requiredDirectoryTypes: archetypeRequiredDirectories(archetype),
      nicheDirectoryTypes: uniq(
        [
          `${category} directories`,
          `${primaryLocation || brief.location.country || "regional"} directories`,
          ...brief.competitorTopics.slice(0, 4),
        ],
        8,
      ),
      regionalHints: locations,
      avoidDirectories: [],
    },
  };
}

function normalizeStrategy(
  raw: unknown,
  fallback: OffPageResearchStrategy,
): OffPageResearchStrategy {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const reddit = r.reddit && typeof r.reddit === "object" ? r.reddit as Record<string, unknown> : {};
  const directory =
    r.directory && typeof r.directory === "object" ? r.directory as Record<string, unknown> : {};

  return {
    businessSummary: String(r.businessSummary ?? fallback.businessSummary).trim() || fallback.businessSummary,
    archetype: normalizeArchetype(r.archetype ?? fallback.archetype),
    demandSignals: asStringArray(r.demandSignals, 12).length
      ? asStringArray(r.demandSignals, 12)
      : fallback.demandSignals,
    reddit: {
      enabled: reddit.enabled !== false && fallback.reddit.enabled,
      reason: String(reddit.reason ?? fallback.reddit.reason).trim(),
      subredditSeeds: asStringArray(reddit.subredditSeeds, 12).length
        ? asStringArray(reddit.subredditSeeds, 12)
        : fallback.reddit.subredditSeeds,
      threadSearchQueries: asStringArray(reddit.threadSearchQueries, 12).length
        ? asStringArray(reddit.threadSearchQueries, 12)
        : fallback.reddit.threadSearchQueries,
      coreTerms: asStringArray(reddit.coreTerms, 12).length
        ? asStringArray(reddit.coreTerms, 12)
        : fallback.reddit.coreTerms,
      audienceAngles: asStringArray(reddit.audienceAngles, 12).length
        ? asStringArray(reddit.audienceAngles, 12)
        : fallback.reddit.audienceAngles,
      avoidTerms: asStringArray(reddit.avoidTerms, 12).length
        ? asStringArray(reddit.avoidTerms, 12)
        : fallback.reddit.avoidTerms,
    },
    directory: {
      enabled: directory.enabled !== false && fallback.directory.enabled,
      reason: String(directory.reason ?? fallback.directory.reason).trim(),
      searchQueries: asStringArray(directory.searchQueries, 12).length
        ? asStringArray(directory.searchQueries, 12)
        : fallback.directory.searchQueries,
      requiredDirectoryTypes: asStringArray(directory.requiredDirectoryTypes, 12).length
        ? asStringArray(directory.requiredDirectoryTypes, 12)
        : fallback.directory.requiredDirectoryTypes,
      nicheDirectoryTypes: asStringArray(directory.nicheDirectoryTypes, 12).length
        ? asStringArray(directory.nicheDirectoryTypes, 12)
        : fallback.directory.nicheDirectoryTypes,
      regionalHints: asStringArray(directory.regionalHints, 12).length
        ? asStringArray(directory.regionalHints, 12)
        : fallback.directory.regionalHints,
      avoidDirectories: asStringArray(directory.avoidDirectories, 12),
    },
  };
}

export function formatStrategyForPrompt(strategy?: OffPageResearchStrategy): string {
  if (!strategy) return "(no strategy supplied)";
  return [
    `Planner summary: ${strategy.businessSummary}`,
    `Archetype: ${strategy.archetype}`,
    strategy.demandSignals.length ? `Demand signals: ${strategy.demandSignals.join(", ")}` : "",
    `Reddit: ${strategy.reddit.enabled ? "enabled" : "disabled"} — ${strategy.reddit.reason}`,
    strategy.reddit.subredditSeeds.length ? `Reddit subreddit/audience seeds: ${strategy.reddit.subredditSeeds.join(", ")}` : "",
    strategy.reddit.threadSearchQueries.length ? `Reddit thread search queries: ${strategy.reddit.threadSearchQueries.join(", ")}` : "",
    strategy.reddit.coreTerms.length ? `Reddit relevance terms: ${strategy.reddit.coreTerms.join(", ")}` : "",
    strategy.reddit.audienceAngles.length ? `Reddit helpful angles: ${strategy.reddit.audienceAngles.join("; ")}` : "",
    `Directories: ${strategy.directory.enabled ? "enabled" : "disabled"} — ${strategy.directory.reason}`,
    strategy.directory.searchQueries.length ? `Directory discovery searches: ${strategy.directory.searchQueries.join(", ")}` : "",
    strategy.directory.requiredDirectoryTypes.length ? `Required directory types: ${strategy.directory.requiredDirectoryTypes.join(", ")}` : "",
    strategy.directory.nicheDirectoryTypes.length ? `Niche directory types: ${strategy.directory.nicheDirectoryTypes.join(", ")}` : "",
    strategy.directory.regionalHints.length ? `Regional hints: ${strategy.directory.regionalHints.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT =
  "You are the first-pass off-page research planner. Before anyone searches Reddit " +
  "or directory sites, you understand the business, classify its discovery pattern, " +
  "and decide exactly what should be searched. You are business-type-aware, not " +
  "restaurant-tuned: plumbers, dentists, SaaS, agencies, e-commerce, creators, " +
  "restaurants, and real estate all need different search language and directories. " +
  "Return valid JSON only.";

export async function generateOffPageResearchStrategy(
  brief: BusinessResearchBrief,
  profile: BusinessOffPageProfile,
): Promise<OffPageResearchStrategy> {
  const fallback = buildFallbackResearchStrategy(brief, profile);

  const prompt = `Create the Reddit and directory research strategy for this business BEFORE channel research runs.

BUSINESS:
${formatBriefForPrompt(brief)}

DETERMINISTIC FALLBACK STRATEGY:
${formatStrategyForPrompt(fallback)}

RULES:
- First understand what kind of business this is and how customers discover it.
- Do not use a one-size-fits-all list. Pick search language based on business type, audience, pain points, services, location, and competitors.
- Reddit strategy should decide what communities and thread queries are worth searching, including problem/comparison/recommendation language. If Reddit is low-value, keep it conservative but still provide fallback queries that could surface genuine questions.
- Directory strategy should decide which trust, regional, category-intent, marketplace, review, software, professional-service, or niche directory classes matter.
- Core terms must be distinctive topic words used to filter live Reddit threads. Exclude city/country-only words.
- Search queries must be concrete strings a live search worker can run.

Return ONLY this JSON object, no markdown:
{
  "businessSummary": "one sentence",
  "archetype": "local_recommendation | local_service | b2b_service | professional_service | saas | ecommerce | healthcare | real_estate | hospitality | education | other",
  "demandSignals": ["customer problem/search language"],
  "reddit": {
    "enabled": true,
    "reason": "why Reddit is or is not useful",
    "subredditSeeds": ["r/city or audience/category seed"],
    "threadSearchQueries": ["queries to search inside Reddit"],
    "coreTerms": ["distinctive topic terms"],
    "audienceAngles": ["helpful reply angles"],
    "avoidTerms": ["off-topic/noisy terms"]
  },
  "directory": {
    "enabled": true,
    "reason": "why directories matter",
    "searchQueries": ["queries to discover directory domains"],
    "requiredDirectoryTypes": ["must-consider directory/platform classes"],
    "nicheDirectoryTypes": ["specific niche/regional directory classes"],
    "regionalHints": ["city/country/region hints"],
    "avoidDirectories": ["classes that do not fit"]
  }
}`;

  const llm = getLLMForComplexTasks();
  let response: { content: unknown };
  try {
    response = await llm.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    console.warn("[offpage/strategy] LLM call failed:", (err as Error).message);
    return fallback;
  }

  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: brief.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "research_strategy" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }

  return normalizeStrategy(parsed, fallback);
}
