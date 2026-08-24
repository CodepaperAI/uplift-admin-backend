import { getLLMForKeywords } from "../../config/llm.config";
import type { GeoKeywordContext } from "../../utils/geo-keyword-context";
import type {
  GeoTarget,
  KeywordIntentBucket,
} from "../../utils/dataforseo-keyword-plan.utils";
import type { BusinessContextAnalysis } from "./business-context-analyzer";

type RawGeoAwareKeywordIdea = {
  keyword?: unknown;
  intent?: unknown;
  category?: unknown;
  service?: unknown;
  targetLocation?: unknown;
  estimatedSearchVolume?: unknown;
  estimatedDifficulty?: unknown;
  reason?: unknown;
};

export type GeoAwareLLMKeywordIdea = {
  keyword: string;
  intent: KeywordIntentBucket;
  category: string;
  service: string | null;
  targetLocation: string | null;
  estimatedSearchVolume: number;
  estimatedDifficulty: number;
  reason: string | null;
  geoTarget: GeoTarget | null;
};

type AllowedGeoTarget = {
  city: string;
  geoTarget: GeoTarget;
};

type GeoAwareKeywordGenerationParams = {
  business: any;
  businessContext: BusinessContextAnalysis;
  geoContext?: GeoKeywordContext | null;
  primaryServices: string[];
  focusAreas: string[];
  expandedSubOfferings: string[];
  existingKeywordTexts?: string[];
  previousKeywords?: Array<{ keyword?: string | null }>;
  locationScope: string;
  limit?: number;
};

const VALID_INTENTS = new Set<KeywordIntentBucket>([
  "informational",
  "commercial",
  "transactional",
  "navigational",
]);

function toTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function normalizeKeyword(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const keyword = value
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  const wordCount = keyword.split(" ").filter(Boolean).length;
  if (keyword.length < 4 || wordCount < 2 || wordCount > 10) {
    return null;
  }

  return keyword;
}

function normalizeIntent(value: unknown): KeywordIntentBucket {
  const intent = typeof value === "string" ? value.toLowerCase().trim() : "";
  return VALID_INTENTS.has(intent as KeywordIntentBucket)
    ? (intent as KeywordIntentBucket)
    : "informational";
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function buildAllowedGeoTargets(
  params: Pick<GeoAwareKeywordGenerationParams, "business" | "geoContext" | "locationScope">,
): AllowedGeoTarget[] {
  const targets: AllowedGeoTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (
    city: string | null | undefined,
    geoTarget: GeoTarget,
  ) => {
    const cleaned = normalizeOptionalString(city);
    if (!cleaned) {
      return;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ city: cleaned, geoTarget });
  };

  for (const target of params.geoContext?.allTargets ?? []) {
    addTarget(target.city, {
      targetCity: target.city,
      targetLocationCode: target.locationCode,
      geoSource: target.type,
      isResolved: target.isResolved,
    });
  }

  const city = normalizeOptionalString(params.business.businessCity);
  if (city) {
    addTarget(city, {
      targetCity: city,
      targetLocationCode:
        params.geoContext?.primaryTarget?.locationCode ??
        params.geoContext?.countryLocationCode ??
        2840,
      geoSource: "primary",
      isResolved: Boolean(params.geoContext?.primaryTarget?.isResolved),
    });
  }

  const locationScope = normalizeOptionalString(params.locationScope);
  if (locationScope && locationScope.toLowerCase() !== city?.toLowerCase()) {
    addTarget(locationScope, {
      targetCity: locationScope,
      targetLocationCode:
        params.geoContext?.countryLocationCode ??
        params.geoContext?.primaryTarget?.locationCode ??
        2840,
      geoSource: "generic",
      isResolved: false,
    });
  }

  return targets;
}

function resolveGeoTarget(
  idea: RawGeoAwareKeywordIdea,
  keyword: string,
  allowedTargets: AllowedGeoTarget[],
): { targetLocation: string | null; geoTarget: GeoTarget | null } {
  const requestedTarget = normalizeOptionalString(idea.targetLocation);
  const requestedKey = requestedTarget?.toLowerCase();

  if (requestedKey) {
    const match = allowedTargets.find(
      (target) => target.city.toLowerCase() === requestedKey,
    );
    if (match && keyword.includes(match.city.toLowerCase())) {
      return { targetLocation: match.city, geoTarget: match.geoTarget };
    }
  }

  const inferredTarget = allowedTargets.find((target) =>
    keyword.includes(target.city.toLowerCase()),
  );
  if (inferredTarget) {
    return {
      targetLocation: inferredTarget.city,
      geoTarget: inferredTarget.geoTarget,
    };
  }

  return { targetLocation: null, geoTarget: null };
}

function extractRawIdeas(text: string): RawGeoAwareKeywordIdea[] {
  const stripped = text.replace(/```json|```/gi, "").trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as
      | RawGeoAwareKeywordIdea[]
      | { ideas?: RawGeoAwareKeywordIdea[]; keywords?: RawGeoAwareKeywordIdea[] };
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.ideas)) {
      return parsed.ideas;
    }
    if (Array.isArray(parsed.keywords)) {
      return parsed.keywords;
    }
  } catch {
    return [];
  }

  return [];
}

export function normalizeGeoAwareKeywordIdeas(
  rawIdeas: RawGeoAwareKeywordIdea[],
  params: GeoAwareKeywordGenerationParams,
): GeoAwareLLMKeywordIdea[] {
  const limit = params.limit ?? 90;
  const allowedTargets = buildAllowedGeoTargets(params);
  const existing = new Set(
    [
      ...(params.existingKeywordTexts ?? []),
      ...(params.previousKeywords ?? []).map((item) => item.keyword ?? ""),
    ]
      .map((keyword) => keyword.toLowerCase().trim())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const normalized: GeoAwareLLMKeywordIdea[] = [];

  for (const rawIdea of rawIdeas) {
    const keyword = normalizeKeyword(rawIdea.keyword);
    if (!keyword || existing.has(keyword) || seen.has(keyword)) {
      continue;
    }

    const requestedTarget = normalizeOptionalString(rawIdea.targetLocation);
    if (
      requestedTarget &&
      !allowedTargets.some(
        (target) => target.city.toLowerCase() === requestedTarget.toLowerCase(),
      )
    ) {
      continue;
    }

    const { targetLocation, geoTarget } = resolveGeoTarget(
      rawIdea,
      keyword,
      allowedTargets,
    );
    const index = normalized.length;
    const estimatedSearchVolume = clampNumber(
      rawIdea.estimatedSearchVolume,
      Math.max(20, 160 - index * 2),
      0,
      5000,
    );
    const estimatedDifficulty = clampNumber(
      rawIdea.estimatedDifficulty,
      35 + (index % 8) * 5,
      0,
      100,
    );

    seen.add(keyword);
    normalized.push({
      keyword,
      intent: normalizeIntent(rawIdea.intent),
      category: normalizeOptionalString(rawIdea.category) ?? "llm_geo_fallback",
      service: normalizeOptionalString(rawIdea.service),
      targetLocation,
      estimatedSearchVolume,
      estimatedDifficulty,
      reason: normalizeOptionalString(rawIdea.reason),
      geoTarget,
    });

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

export function parseGeoAwareKeywordIdeas(
  text: string,
  params: GeoAwareKeywordGenerationParams,
): GeoAwareLLMKeywordIdea[] {
  return normalizeGeoAwareKeywordIdeas(extractRawIdeas(text), params);
}

export function buildGeoAwareKeywordGenerationPrompt(
  params: GeoAwareKeywordGenerationParams,
): string {
  const {
    business,
    businessContext,
    geoContext,
    primaryServices,
    focusAreas,
    expandedSubOfferings,
    locationScope,
    limit = 90,
  } = params;
  const allowedTargets = buildAllowedGeoTargets(params).map((target) => ({
    city: target.city,
    source: target.geoTarget.geoSource,
    verified: target.geoTarget.isResolved,
  }));
  const serviceAreas = geoContext?.serviceAreaTargets.map((target) => target.city) ?? [];
  const neighborhoods = geoContext?.neighborhoodTargets.map((target) => target.city) ?? [];
  const previousTopics = [
    ...(params.existingKeywordTexts ?? []),
    ...(params.previousKeywords ?? []).map((item) => item.keyword ?? ""),
  ]
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 20);

  return `Generate GEO-aware SEO keyword candidates for a 30-day blog/content plan.

The output will be metrics-enriched by DataForSEO later when possible. Do not claim metrics are real.

BUSINESS
- Name: ${business.businessName || "N/A"}
- Type: ${business.businessType || "N/A"}
- Description: ${business.businessDescription || "N/A"}
- Target audience: ${business.targetAudience || "N/A"}
- Website: ${business.businessWebsiteUrl || "N/A"}

SERVICES AND TOPICS
- Primary services: ${primaryServices.join(", ") || "N/A"}
- Business-context services: ${businessContext.services.primary.join(", ") || "N/A"}
- Focus areas: ${focusAreas.join(", ") || "N/A"}
- Sub-offerings: ${expandedSubOfferings.slice(0, 30).join(", ") || "N/A"}
- Industry: ${businessContext.market.industry.vertical}
- Customer segment: ${businessContext.market.customerSegment.primary}
- Existing/previous topics to avoid: ${previousTopics.join(", ") || "none"}

LOCATION CONTEXT
- GEO eligible: ${geoContext?.geoEligible ? "yes" : "no"} (${geoContext?.geoEligibilityReason ?? "unknown"})
- Primary location: ${geoContext?.primaryTarget?.city || business.businessCity || locationScope || "N/A"}
- Service-area cities: ${serviceAreas.join(", ") || "none"}
- Neighborhood/admin targets: ${neighborhoods.join(", ") || "none"}
- Allowed location names: ${allowedTargets.map((target) => `${target.city}${target.verified ? " (verified)" : ""}`).join(", ") || "none"}

RULES
- Return up to ${limit} keyword ideas.
- Generate blog-worthy keywords, not generic service-page titles.
- Use the exact services/offers above. Do not invent unrelated practice areas, services, cities, or neighborhoods.
- If GEO eligible, make roughly 40-55% of ideas local by using ONLY allowed location names.
- Include a balanced mix: how-to, cost, checklist, comparison, mistakes, process, buyer questions, local decision criteria, and high-intent service research.
- Avoid duplicate phrasing and avoid previous/existing topics.
- Keep keywords natural, 2-10 words, lowercase is fine.
- For targetLocation, use an allowed location name exactly, or null for non-local topics.

Return ONLY valid JSON in this shape:
{
  "ideas": [
    {
      "keyword": "family law checklist for brampton",
      "intent": "informational",
      "category": "local_guide",
      "service": "Family Law",
      "targetLocation": "Brampton",
      "estimatedSearchVolume": 120,
      "estimatedDifficulty": 42,
      "reason": "Targets local family-law research intent."
    }
  ]
}`;
}

export async function generateGeoAwareKeywordIdeas(
  params: GeoAwareKeywordGenerationParams,
): Promise<GeoAwareLLMKeywordIdea[]> {
  try {
    const model = getLLMForKeywords();
    const response = await model.invoke([
      {
        role: "system",
        content:
          "You are an expert local SEO strategist. Return only valid JSON. Never invent cities, metrics, or services outside the provided context.",
      },
      {
        role: "user",
        content: buildGeoAwareKeywordGenerationPrompt(params),
      },
    ]);

    const text = toTextContent(response.content);
    const ideas = parseGeoAwareKeywordIdeas(text, params);
    console.log(
      `🧠 [KeywordGeneration] GEO-aware LLM generated ${ideas.length} keyword candidates`,
    );
    return ideas;
  } catch (error) {
    console.warn(
      "[KeywordGeneration] GEO-aware LLM keyword generation failed:",
      (error as Error).message,
    );
    return [];
  }
}
