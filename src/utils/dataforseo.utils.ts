import fetch from "node-fetch";
import OpenAI from "openai";
import { withCache } from "./dataforseo-cache";
import { readDataForSeoResponse } from "./dataforseo-response";

// DataForSEO API Configuration
const DATAFORSEO_USERNAME = process.env.DATAFORSEO_USERNAME || "";
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD || "";
// 🆕 NEW: Support direct base64 string from DataForSEO
const DATAFORSEO_BASE64 = process.env.DATAFORSEO_BASE64 || "";
const DATAFORSEO_API_URL = "https://api.dataforseo.com/v3";

/**
 * Get Base64 encoded credentials for DataForSEO API
 * Supports both methods:
 * 1. Direct base64 string (preferred if available)
 * 2. Username:Password encoding (fallback)
 */
export function getAuthHeader(): string {
  // If base64 string is provided directly, use it
  if (DATAFORSEO_BASE64) {
    return `Basic ${DATAFORSEO_BASE64}`;
  }

  // Otherwise, encode username:password
  if (DATAFORSEO_USERNAME && DATAFORSEO_PASSWORD) {
    const credentials = `${DATAFORSEO_USERNAME}:${DATAFORSEO_PASSWORD}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  // Return empty if no credentials
  return "";
}

/**
 * Keyword metrics from DataForSEO API
 */
export interface KeywordMetrics {
  searchVolume: number | null;
  competition: number | null; // 0.00 - 1.00
  cpc: number | null; // Cost per click in USD
  monthlySearches: number | null; // Current month search volume
  trend: Array<{ year: number; month: number; searchVolume: number }> | null;
  clicks: number | null; // Estimated monthly clicks
  impressions: number | null; // Estimated monthly impressions
  ctr: number | null; // Click-through rate
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
}

/**
 * Fetch keyword search volume and metrics from DataForSEO
 * @param keywords Array of keywords to fetch data for
 * @param locationCode Location code (2840 for US, see DataForSEO docs)
 * @param languageCode Language code (default: 'en')
 */
export async function fetchKeywordDataFromDataForSEO(
  keywords: string[],
  locationCode?: number, // Optional - no location filter by default
  languageCode: string = "en"
): Promise<Map<string, KeywordMetrics>> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      console.warn(
        "⚠️ DataForSEO credentials not configured. Skipping API call."
      );
      return new Map();
    }

    if (keywords.length === 0) {
      console.warn("⚠️ No keywords provided to DataForSEO");
      return new Map();
    }

    console.log(
      `📊 Fetching DataForSEO data for ${keywords.length} keywords${
        locationCode
          ? ` (location: ${locationCode})`
          : " (global - no location filter)"
      }...`
    );

    // 🚀 OPTIMIZATION: Handle large batches by splitting if needed
    // DataForSEO supports up to 1000 keywords per request
    const MAX_BATCH_SIZE = 1000;
    const keywordMap = new Map<string, KeywordMetrics>();

    if (keywords.length <= MAX_BATCH_SIZE) {
      // Single batch - fetch directly
      const requestPayload: any = {
        keywords: keywords,
        language_code: languageCode,
      };

      if (locationCode !== undefined && locationCode !== null) {
        requestPayload.location_code = locationCode;
      }

      const response = await fetch(
        `${DATAFORSEO_API_URL}/keywords_data/google_ads/search_volume/live`,
        {
          method: "POST",
          headers: {
            Authorization: getAuthHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify([requestPayload]),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `❌ DataForSEO API error: ${response.status} - ${errorText}`
        );
        throw new Error(
          `DataForSEO API error: ${response.status} - ${errorText}`
        );
      }

      const data = await readDataForSeoResponse(response);

      // Parse response
      if (data?.tasks?.[0]?.result) {
        for (const item of data.tasks[0].result) {
          const keyword = item.keyword;
          const monthlySearches =
            item.monthly_searches &&
            Array.isArray(item.monthly_searches) &&
            item.monthly_searches.length > 0
              ? item.monthly_searches[item.monthly_searches.length - 1]
                  ?.search_volume ?? null
              : null;

          const trend =
            item.monthly_searches &&
            Array.isArray(item.monthly_searches) &&
            item.monthly_searches.length > 0
              ? item.monthly_searches.map((ms: any) => ({
                  year: ms.year || 0,
                  month: ms.month || 0,
                  searchVolume: ms.search_volume || 0,
                }))
              : null;

          const competition = item.competition_index
            ? item.competition_index / 100
            : null;

          const keywordData = {
            searchVolume: item.search_volume ?? null,
            competition: competition,
            cpc: item.cpc ?? null,
            monthlySearches: monthlySearches,
            trend: trend,
            clicks: item.clicks ?? null,
            impressions: item.impressions ?? null,
            ctr: item.ctr ?? null,
            lowTopOfPageBid: item.low_top_of_page_bid ?? null,
            highTopOfPageBid: item.high_top_of_page_bid ?? null,
          };

          keywordMap.set(keyword, keywordData);
        }
      }
    } else {
      // 🚀 OPTIMIZATION: Split into batches and fetch in parallel
      console.log(
        `📊 Splitting ${keywords.length} keywords into ${Math.ceil(
          keywords.length / MAX_BATCH_SIZE
        )} batches for parallel fetching...`
      );

      const batches: string[][] = [];
      for (let i = 0; i < keywords.length; i += MAX_BATCH_SIZE) {
        batches.push(keywords.slice(i, i + MAX_BATCH_SIZE));
      }

      // Fetch all batches in parallel using Promise.all
      const batchPromises = batches.map((batch) =>
        fetchKeywordDataFromDataForSEO(batch, locationCode, languageCode)
      );

      const batchResults = await Promise.all(batchPromises);

      // Merge all results into single map
      for (const batchMap of batchResults) {
        for (const [keyword, metrics] of batchMap) {
          keywordMap.set(keyword, metrics);
        }
      }

      console.log(
        `✅ Merged ${batchResults.length} batches into ${keywordMap.size} total keywords`
      );
    }

    console.log(
      `✅ Successfully fetched DataForSEO data for ${keywordMap.size} keywords`
    );
    return keywordMap;
  } catch (error: any) {
    console.error("❌ DataForSEO API error:", error.message || error);
    return new Map();
  }
}

/**
 * Get related keywords from DataForSEO
 * Endpoint: /v3/keywords_data/google_ads/keywords_for_keywords/live
 */
export async function fetchRelatedKeywordsFromDataForSEO(
  seedKeywords: string[],
  locationCode: number = 2840,
  languageCode: string = "en",
  limit: number = 100
): Promise<string[]> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      return [];
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/keywords_data/google_ads/keywords_for_keywords/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          {
            keywords: seedKeywords,
            location_code: locationCode,
            language_code: languageCode,
            limit: limit,
          },
        ]),
      }
    );

    if (!response.ok) {
      throw new Error(`DataForSEO API error: ${response.status}`);
    }

      const data = await readDataForSeoResponse(response);
    const relatedKeywords: string[] = [];

    if (data?.tasks?.[0]?.result) {
      for (const item of data.tasks[0].result) {
        if (item.keyword && !seedKeywords.includes(item.keyword)) {
          relatedKeywords.push(item.keyword);
        }
      }
    }

    return relatedKeywords;
  } catch (error) {
    console.error("❌ DataForSEO related keywords error:", error);
    return [];
  }
}

/**
 * Get related keywords with difficulty and metrics from DataForSEO
 * Returns related keywords with their relationship to seed keywords
 */
export async function getRelatedKeywordsWithDifficulty(
  seedKeywords: string[],
  locationCode: number,
  languageCode: string,
  maxResults: number
): Promise<
  Array<{
    keyword: string;
    difficulty: number;
    searchVolume: number;
    relatedTo: string;
    metrics: KeywordMetrics;
  }>
> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      console.warn("⚠️ DataForSEO credentials not configured");
      return [];
    }

    if (seedKeywords.length === 0) {
      return [];
    }

    console.log(
      `🔍 Fetching related keywords with difficulty for ${seedKeywords.length} seed keywords...`
    );

    const relatedKeywordsMap = new Map<
      string,
      {
        keyword: string;
        difficulty: number;
        searchVolume: number;
        relatedTo: string;
        metrics: KeywordMetrics;
      }
    >();

    for (const seedKeyword of seedKeywords.slice(0, 10)) {
      try {
        const response = await fetch(
          `${DATAFORSEO_API_URL}/keywords_data/google_ads/keywords_for_keywords/live`,
          {
            method: "POST",
            headers: {
              Authorization: getAuthHeader(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify([
              {
                keywords: [seedKeyword],
                location_code: locationCode,
                language_code: languageCode,
                limit: Math.min(50, maxResults),
              },
            ]),
          }
        );

        if (!response.ok) {
          console.warn(
            `⚠️ Failed to fetch related keywords for "${seedKeyword}": ${response.status}`
          );
          continue;
        }

      const data = await readDataForSeoResponse(response);

        if (data?.tasks?.[0]?.result) {
          for (const item of data.tasks[0].result) {
            if (!item.keyword || seedKeywords.includes(item.keyword)) {
              continue;
            }

            const keywordLower = item.keyword.toLowerCase();
            if (relatedKeywordsMap.has(keywordLower)) {
              continue;
            }

            const searchVolume = item.search_volume || 0;
            const difficulty = item.competition_index || 0;
            const competition = difficulty / 100;

            const metrics: KeywordMetrics = {
              searchVolume: searchVolume,
              competition: competition,
              cpc: item.cpc || null,
              monthlySearches: searchVolume,
              trend:
                item.monthly_searches && Array.isArray(item.monthly_searches)
                  ? item.monthly_searches.map((ms: any) => ({
                      year: ms.year || 0,
                      month: ms.month || 0,
                      searchVolume: ms.search_volume || 0,
                    }))
                  : null,
              clicks: item.clicks || null,
              impressions: item.impressions || null,
              ctr: item.ctr || null,
              lowTopOfPageBid: item.low_top_of_page_bid || null,
              highTopOfPageBid: item.high_top_of_page_bid || null,
            };

            relatedKeywordsMap.set(keywordLower, {
              keyword: item.keyword,
              difficulty: difficulty,
              searchVolume: searchVolume,
              relatedTo: seedKeyword,
              metrics: metrics,
            });

            if (relatedKeywordsMap.size >= maxResults) {
              break;
            }
          }
        }

        if (relatedKeywordsMap.size >= maxResults) {
          break;
        }
      } catch (error: any) {
        console.warn(
          `⚠️ Error fetching related keywords for "${seedKeyword}": ${error.message}`
        );
        continue;
      }
    }

    const results = Array.from(relatedKeywordsMap.values());
    console.log(
      `✅ Found ${results.length} related keywords with difficulty metrics`
    );

    return results;
  } catch (error: any) {
    console.error("❌ DataForSEO related keywords with difficulty error:", error);
    return [];
  }
}

/**
 * Get real keyword suggestions with full metrics from DataForSEO
 * This is the PRIMARY keyword source - replaces LLM keyword invention
 */
export async function getKeywordSuggestionsWithMetrics(
  seedKeywords: string[],
  locationCode?: number, // Optional - no location filter by default
  languageCode: string = "en",
  limit: number = 200
): Promise<
  Array<{
    keyword: string;
    searchVolume: number;
    competition: number;
    cpc: number;
    difficulty: number;
    monthlySearches: number;
    clicks: number;
    impressions: number;
    ctr: number;
    trend: Array<{ year: number; month: number; searchVolume: number }>;
  }>
> {
  try {
    if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
      console.warn("⚠️ DataForSEO credentials not configured");
      return [];
    }

    console.log(
      `🔍 Getting REAL keyword suggestions from DataForSEO for: ${seedKeywords
        .slice(0, 3)
        .join(", ")}${
        locationCode
          ? ` (location: ${locationCode})`
          : " (global - no location filter)"
      }...`
    );

    // Build request payload - only include location_code if provided
    const requestPayload: any = {
      keywords: seedKeywords,
      language_code: languageCode,
      limit: limit,
      sort_by: "search_volume", // Get high-volume keywords first
      // Local/long-tail seeds can be the best keyword themselves. Excluding
      // them can leave GEO-aware plans with zero candidates even when the
      // exact seed has valid search-volume data.
      include_seed_keyword: true,
    };

    // Only add location_code if explicitly provided
    if (locationCode !== undefined && locationCode !== null) {
      requestPayload.location_code = locationCode;
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/keywords_data/google_ads/keywords_for_keywords/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO API error: ${response.status} - ${errorText}`
      );
      throw new Error(
        `DataForSEO API error: ${response.status} - ${errorText}`
      );
    }

      const data = await readDataForSeoResponse(response);
    const suggestions: Array<any> = [];

    if (data?.tasks?.[0]?.result) {
      for (const item of data.tasks[0].result) {
        // ✅ FIX: DataForSEO returns data at root level, NOT in keyword_info
        // Only include keywords with actual search volume
        const searchVolume = item.search_volume || 0;
        if (searchVolume > 0) {
          const monthlySearches =
            item.monthly_searches &&
            Array.isArray(item.monthly_searches) &&
            item.monthly_searches.length > 0
              ? item.monthly_searches[item.monthly_searches.length - 1]
                  ?.search_volume || searchVolume
              : searchVolume;

          // Convert competition_index (0-100) to decimal (0-1)
          const competition = item.competition_index
            ? item.competition_index / 100
            : 0;

          suggestions.push({
            keyword: item.keyword,
            searchVolume: searchVolume, // ✅ FIXED: Read from root
            competition: competition, // ✅ FIXED: Use competition_index
            cpc: item.cpc || 0, // ✅ FIXED: Read from root
            difficulty: item.competition_index || 0, // ✅ FIXED: 0-100 scale
            monthlySearches: monthlySearches,
            clicks: item.clicks || 0,
            impressions: item.impressions || 0,
            ctr: item.ctr || 0,
            trend:
              item.monthly_searches && Array.isArray(item.monthly_searches)
                ? item.monthly_searches.map((ms: any) => ({
                    year: ms.year || 0,
                    month: ms.month || 0,
                    searchVolume: ms.search_volume || 0,
                  }))
                : [],
          });
        }
      }
    }

    if (suggestions.length === 0 && seedKeywords.length > 0) {
      console.warn(
        "⚠️ DataForSEO suggestions returned zero rows; checking exact seed metrics before falling back.",
      );
      const seedMetrics = await fetchKeywordDataFromDataForSEO(
        seedKeywords,
        locationCode,
        languageCode,
      );

      for (const [keyword, metrics] of seedMetrics) {
        const searchVolume = metrics.searchVolume ?? 0;
        if (searchVolume <= 0) {
          continue;
        }

        const competition = metrics.competition ?? 0;
        const monthlySearches = metrics.monthlySearches ?? searchVolume;
        suggestions.push({
          keyword,
          searchVolume,
          competition,
          cpc: metrics.cpc ?? 0,
          difficulty: Math.round(competition * 100),
          monthlySearches,
          clicks: metrics.clicks ?? 0,
          impressions: metrics.impressions ?? 0,
          ctr: metrics.ctr ?? 0,
          trend: metrics.trend ?? [],
        });
      }
    }

    console.log(
      `✅ Found ${suggestions.length} REAL keywords with actual search data from DataForSEO`
    );
    return suggestions;
  } catch (error: any) {
    console.error("❌ DataForSEO keyword discovery error:", error.message);
    return [];
  }
}

/**
 * Get real competitors from DataForSEO SERP analysis
 * Analyzes top ranking domains for target keywords
 */
export async function getCompetitorsFromDataForSEO(
  targetKeywords: string[],
  locationCode: number = 2840,
  limit: number = 10,
  options?: { forceRefresh?: boolean; languageCode?: string },
): Promise<Array<{ name: string; url: string; domain: string }>> {
  const sortedKeys = [...targetKeywords].sort().join(",");
  const languageCode = options?.languageCode ?? "en";
  const cacheKey = `competitors:${sortedKeys}:${locationCode}:${languageCode}:${limit}`;
  return withCache(
    cacheKey,
    () =>
      _getCompetitorsFromDataForSEOInternal(
        targetKeywords,
        locationCode,
        limit,
        languageCode,
      ),
    { forceRefresh: options?.forceRefresh },
  );
}

async function _getCompetitorsFromDataForSEOInternal(
  targetKeywords: string[],
  locationCode: number = 2840,
  limit: number = 10,
  languageCode: string = "en",
): Promise<Array<{ name: string; url: string; domain: string }>> {
  try {
    if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
      console.warn(
        "⚠️ DataForSEO credentials not configured for competitor analysis"
      );
      return [];
    }

    console.log(
      `🔍 Finding real competitors for ${targetKeywords.length} keywords via DataForSEO SERP...`
    );

    // Use top 3 keywords to find competitors
    const seedKeywords = targetKeywords.slice(0, 3);

    const response = await fetch(
      `${DATAFORSEO_API_URL}/serp/google/organic/live/advanced`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          seedKeywords.map((keyword) => ({
            keyword: keyword,
            location_code: locationCode,
            language_code: languageCode,
            depth: 20, // Get top 20 results
            device: "desktop",
            os: "windows",
          }))
        ),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO SERP API error: ${response.status} - ${errorText}`
      );
      return [];
    }

      const data = await readDataForSeoResponse(response);
    const competitorMap = new Map<
      string,
      { name: string; url: string; domain: string; count: number }
    >();

    // Process SERP results from all keywords
    if (data?.tasks) {
      for (const task of data.tasks) {
        if (task?.result?.[0]?.items) {
          for (const item of task.result[0].items) {
            if (item.type === "organic" && item.domain) {
              const domain = item.domain.toLowerCase();
              const existing = competitorMap.get(domain);

              if (existing) {
                existing.count += 1; // Track how many times this domain appears
                // Update URL to use domain-based URL if we have a better one
                if (item.url && !item.url.includes("/") || item.url === `https://${domain}` || item.url === `http://${domain}`) {
                  existing.url = `https://${domain}`;
                }
              } else {
                // Use domain as the URL instead of specific page URL
                const domainUrl = `https://${domain}`;
                competitorMap.set(domain, {
                  name: item.title || domain.split(".")[0] || domain,
                  url: domainUrl, // Use domain URL instead of page URL
                  domain: domain,
                  count: 1,
                });
              }
            }
          }
        }
      }
    }

    // Sort by frequency (domains appearing in multiple SERPs are more relevant competitors)
    const competitors = Array.from(competitorMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((c) => ({
        name: c.name,
        url: `https://${c.domain}`, // Always use domain URL, not page-specific URLs
        domain: c.domain,
      }));

    console.log(
      `✅ Found ${competitors.length} real competitors from SERP analysis`
    );
    return competitors;
  } catch (error: any) {
    console.error("❌ DataForSEO competitor analysis error:", error.message);
    return [];
  }
}

export interface DataForSEOLocalMapsParams {
  keyword: string;
  locationCode?: number;
  languageCode?: string;
  latitude?: number | null;
  longitude?: number | null;
  depth?: number;
  device?: "desktop" | "mobile";
  forceRefresh?: boolean;
}

export interface DataForSEOLocalMapResult {
  keyword: string;
  title: string | null;
  rankGroup: number | null;
  rankAbsolute: number | null;
  placeId: string | null;
  cid: string | null;
  domain: string | null;
  url: string | null;
  rating: number | null;
  reviewCount: number | null;
  categories: string[];
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  raw: Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeCategories(item: Record<string, unknown>): string[] {
  const values = [
    item.category,
    ...(Array.isArray(item.additional_categories)
      ? item.additional_categories
      : []),
    ...(Array.isArray(item.categories) ? item.categories : []),
  ];

  return Array.from(
    new Set(
      values
        .map((value) =>
          typeof value === "string"
            ? value
            : typeof value === "object" &&
                value !== null &&
                "title" in value &&
                typeof (value as { title?: unknown }).title === "string"
              ? (value as { title: string }).title
              : null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export function normalizeDataForSEOLocalMapItems(
  keyword: string,
  items: unknown[],
): DataForSEOLocalMapResult[] {
  return items
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item) => {
      const rating =
        typeof item.rating === "object" && item.rating !== null
          ? normalizeNumber(
              (item.rating as { value?: unknown; rating_value?: unknown }).value ??
                (item.rating as { value?: unknown; rating_value?: unknown })
                  .rating_value,
            )
          : normalizeNumber(item.rating);

      const reviewCount =
        typeof item.rating === "object" && item.rating !== null
          ? normalizeNumber(
              (item.rating as { votes_count?: unknown; reviews_count?: unknown })
                .votes_count ??
                (item.rating as {
                  votes_count?: unknown;
                  reviews_count?: unknown;
                }).reviews_count,
            )
          : normalizeNumber(item.review_count ?? item.reviews_count);

      return {
        keyword,
        title: normalizeString(item.title),
        rankGroup: normalizeNumber(item.rank_group),
        rankAbsolute: normalizeNumber(item.rank_absolute),
        placeId: normalizeString(item.place_id ?? item.placeId),
        cid: normalizeString(item.cid),
        domain: normalizeString(item.domain),
        url: normalizeString(item.url),
        rating,
        reviewCount,
        categories: normalizeCategories(item),
        address: normalizeString(item.address),
        latitude: normalizeNumber(item.latitude),
        longitude: normalizeNumber(item.longitude),
        raw: item,
      };
    });
}

export async function getLocalMapsResultsFromDataForSEO(
  params: DataForSEOLocalMapsParams,
): Promise<DataForSEOLocalMapResult[]> {
  const keyword = params.keyword.trim();
  if (!keyword) {
    return [];
  }

  const locationCode = params.locationCode ?? 2840;
  const depth = params.depth ?? 20;
  const languageCode = params.languageCode ?? "en";
  const device = params.device ?? "desktop";
  const coordinateKey =
    typeof params.latitude === "number" && typeof params.longitude === "number"
      ? `${params.latitude.toFixed(5)},${params.longitude.toFixed(5)}`
      : "no-coordinate";

  const cacheKey = `maps-serp:${keyword}:${locationCode}:${languageCode}:${depth}:${device}:${coordinateKey}`;

  return withCache(
    cacheKey,
    async () => {
      try {
        if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
          console.warn(
            "⚠️ DataForSEO credentials not configured for local maps ranking",
          );
          return [];
        }

        const task: Record<string, unknown> = {
          keyword,
          location_code: locationCode,
          language_code: languageCode,
          depth,
          device,
          os: device === "mobile" ? "ios" : "windows",
        };

        if (
          typeof params.latitude === "number" &&
          typeof params.longitude === "number"
        ) {
          task.location_coordinate = `${params.latitude},${params.longitude},13z`;
        }

        const response = await fetch(
          `${DATAFORSEO_API_URL}/serp/google/maps/live/advanced`,
          {
            method: "POST",
            headers: {
              Authorization: getAuthHeader(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify([task]),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `❌ DataForSEO Maps API error: ${response.status} - ${errorText}`,
          );
          return [];
        }

      const data = await readDataForSeoResponse(response);
        const items = data?.tasks?.[0]?.result?.[0]?.items;
        return normalizeDataForSEOLocalMapItems(
          keyword,
          Array.isArray(items) ? items : [],
        );
      } catch (error: any) {
        console.error("❌ DataForSEO Maps ranking error:", error.message);
        return [];
      }
    },
    { forceRefresh: params.forceRefresh },
  );
}

// Walks an organic SERP item tree and yields every local_pack business entry.
// Local pack items can appear either flat (each entry has `type: "local_pack"`
// and its own rank fields) or wrapped (a container item with `type:
// "local_pack"` and a nested `items` array). Both forms in the wild.
//
// Exported for testing the parser in isolation without mocking `fetch`.
export function* extractLocalPackEntries(
  items: unknown[],
): Generator<Record<string, unknown>> {
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "local_pack") continue;

    if (Array.isArray(record.items)) {
      for (const inner of record.items) {
        if (typeof inner === "object" && inner !== null) {
          yield inner as Record<string, unknown>;
        }
      }
    } else {
      yield record;
    }
  }
}

export async function getLocalPackResultsFromDataForSEO(
  params: DataForSEOLocalMapsParams,
): Promise<DataForSEOLocalMapResult[]> {
  const keyword = params.keyword.trim();
  if (!keyword) {
    return [];
  }

  const locationCode = params.locationCode ?? 2840;
  const languageCode = params.languageCode ?? "en";
  const device = params.device ?? "desktop";
  const coordinateKey =
    typeof params.latitude === "number" && typeof params.longitude === "number"
      ? `${params.latitude.toFixed(5)},${params.longitude.toFixed(5)}`
      : "no-coordinate";

  // Cache key is intentionally distinct from the maps-serp cache so a forced
  // refresh of one doesn't bust the other.
  const cacheKey = `local-pack-serp:${keyword}:${locationCode}:${languageCode}:${device}:${coordinateKey}`;

  return withCache(
    cacheKey,
    async () => {
      try {
        if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
          console.warn(
            "⚠️ DataForSEO credentials not configured for local pack ranking",
          );
          return [];
        }

        const task: Record<string, unknown> = {
          keyword,
          location_code: locationCode,
          language_code: languageCode,
          depth: 20, // First page is plenty; local pack is always near the top
          device,
          os: device === "mobile" ? "ios" : "windows",
        };

        if (
          typeof params.latitude === "number" &&
          typeof params.longitude === "number"
        ) {
          task.location_coordinate = `${params.latitude},${params.longitude},13z`;
        }

        const response = await fetch(
          `${DATAFORSEO_API_URL}/serp/google/organic/live/advanced`,
          {
            method: "POST",
            headers: {
              Authorization: getAuthHeader(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify([task]),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `❌ DataForSEO Organic SERP error (local pack): ${response.status} - ${errorText}`,
          );
          return [];
        }

      const data = await readDataForSeoResponse(response);
        const items = data?.tasks?.[0]?.result?.[0]?.items;
        if (!Array.isArray(items)) return [];

        const packEntries = Array.from(extractLocalPackEntries(items));
        // Local pack entries from organic SERP don't carry rank_group/absolute
        // for the in-pack position by default. Assign 1-based pack position so
        // the downstream rank-result schema stays meaningful.
        return normalizeDataForSEOLocalMapItems(
          keyword,
          packEntries.map((entry, idx) => ({
            ...entry,
            rank_group: entry.rank_group ?? idx + 1,
            rank_absolute: entry.rank_absolute ?? idx + 1,
          })),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("❌ DataForSEO local pack ranking error:", message);
        return [];
      }
    },
    { forceRefresh: params.forceRefresh },
  );
}

/**
 * Get real domain rankings and visibility from DataForSEO
 */
export async function getDomainRankingsFromDataForSEO(
  domain: string,
  targetKeywords: string[],
  locationCode: number = 2840,
  languageCode: string = "en",
): Promise<{
  averagePosition: number | null;
  visibility: number | null; // 0-100 scale
  rankingKeywords: Array<{ keyword: string; position: number }>;
}> {
  try {
    if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
      console.warn(
        "⚠️ DataForSEO credentials not configured for ranking analysis"
      );
      return {
        averagePosition: null,
        visibility: null,
        rankingKeywords: [],
      };
    }

    // Use top 5 keywords to check rankings
    const seedKeywords = targetKeywords.slice(0, 5);

    const response = await fetch(
      `${DATAFORSEO_API_URL}/serp/google/organic/live/advanced`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          seedKeywords.map((keyword) => ({
            keyword: keyword,
            location_code: locationCode,
            language_code: languageCode,
            depth: 100, // Check top 100 positions
            device: "desktop",
            os: "windows",
          }))
        ),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO ranking API error: ${response.status} - ${errorText}`
      );
      return {
        averagePosition: null,
        visibility: null,
        rankingKeywords: [],
      };
    }

      const data = await readDataForSeoResponse(response);
    const rankingKeywords: Array<{ keyword: string; position: number }> = [];
    let totalPosition = 0;
    let rankedCount = 0;

    if (data?.tasks) {
      for (let i = 0; i < data.tasks.length; i++) {
        const task = data.tasks[i];
        const keyword = seedKeywords[i];

        if (keyword && task?.result?.[0]?.items) {
          for (const item of task.result[0].items) {
            if (
              item.type === "organic" &&
              item.domain &&
              item.domain.toLowerCase().includes(domain.toLowerCase())
            ) {
              const position = item.rank_group || item.rank_absolute || 0;
              rankingKeywords.push({
                keyword: keyword,
                position: position,
              });
              totalPosition += position;
              rankedCount += 1;
              break; // Found ranking for this keyword
            }
          }
        }
      }
    }

    const averagePosition =
      rankedCount > 0 ? Math.round(totalPosition / rankedCount) : null;

    // Calculate visibility score (inverse of average position, scaled 0-100)
    // Lower position = higher visibility
    const visibility = averagePosition
      ? Math.max(0, Math.round(100 - averagePosition * 5)) // Scale: position 1 = 95%, position 10 = 50%, position 20 = 0%
      : null;

    console.log(
      `✅ Domain rankings: ${rankedCount}/${
        seedKeywords.length
      } keywords ranked, avg position: ${
        averagePosition || "N/A"
      }, visibility: ${visibility || "N/A"}%`
    );

    return {
      averagePosition,
      visibility,
      rankingKeywords,
    };
  } catch (error: any) {
    console.error("❌ DataForSEO ranking analysis error:", error.message);
    return {
      averagePosition: null,
      visibility: null,
      rankingKeywords: [],
    };
  }
}

export async function getRelatedDomainsFromDataForSEO(
  domain: string,
  limit: number = 10,
  locationCode: number = 2840,
  languageCode: string = "en",
): Promise<Array<{ name: string; url: string; domain: string }>> {
  try {
    if (!DATAFORSEO_USERNAME && !DATAFORSEO_PASSWORD && !DATAFORSEO_BASE64) {
      console.warn(
        "⚠️ DataForSEO credentials not configured for domain analysis"
      );
      return [];
    }

    console.log(`🔍 Finding related domains/competitors for: ${domain} (location: ${locationCode})`);

    const response = await fetch(
      `${DATAFORSEO_API_URL}/domain_analytics/google/competitors/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          {
            target: domain,
            location_code: locationCode,
            language_code: languageCode,
            limit: limit,
          },
        ]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const errorData = JSON.parse(errorText);

      // Check if it's a 404 - means endpoint not available in subscription
      if (response.status === 404 || errorData?.status_code === 40400) {
        console.warn(
          `⚠️ DataForSEO Domain Analytics endpoint not available (may require upgraded subscription). Using SERP-based competitor discovery instead.`
        );
        return [];
      }

      console.error(
        `❌ DataForSEO domain analytics error: ${response.status} - ${errorText}`
      );
      return [];
    }

      const data = await readDataForSeoResponse(response);
    const competitors: Array<{ name: string; url: string; domain: string }> =
      [];

    if (data?.tasks?.[0]?.result) {
      for (const item of data.tasks[0].result) {
        if (item.domain && item.domain !== domain) {
          // Validate domain has TLD before using it
          const domainStr = item.domain;
          if (
            domainStr.includes(".") &&
            domainStr.split(".").pop()!.length >= 2
          ) {
            competitors.push({
              name: domainStr.split(".")[0] || domainStr,
              url: `https://${domainStr}`,
              domain: domainStr,
            });
          }
        }
      }
    }

    console.log(
      `✅ Found ${competitors.length} related domains from DataForSEO`
    );
    return competitors;
  } catch (error: any) {
    console.error("❌ DataForSEO related domains error:", error.message);
    return [];
  }
}

/**
 * Get keywords for a domain/website from DataForSEO
 * Endpoint: /v3/keywords_data/google_ads/keywords_for_site/live
 * This is the BEST way to get relevant keywords - DataForSEO analyzes the site directly
 */
export async function getKeywordsForDomainFromDataForSEO(
  domain: string,
  locationCode?: number,
  languageCode: string = "en",
  limit: number = 200,
  options?: { forceRefresh?: boolean },
): Promise<
  Array<{
    keyword: string;
    searchVolume: number;
    competition: number;
    cpc: number;
    difficulty: number;
    monthlySearches: number;
    clicks: number;
    impressions: number;
    ctr: number;
    trend: Array<{ year: number; month: number; searchVolume: number }>;
  }>
> {
  const cacheKey = `domain-keywords:${domain}:${locationCode ?? "global"}:${languageCode}:${limit}`;
  return withCache(
    cacheKey,
    () => _getKeywordsForDomainFromDataForSEOInternal(domain, locationCode, languageCode, limit),
    { forceRefresh: options?.forceRefresh },
  );
}

async function _getKeywordsForDomainFromDataForSEOInternal(
  domain: string,
  locationCode?: number,
  languageCode: string = "en",
  limit: number = 200
): Promise<
  Array<{
    keyword: string;
    searchVolume: number;
    competition: number;
    cpc: number;
    difficulty: number;
    monthlySearches: number;
    clicks: number;
    impressions: number;
    ctr: number;
    trend: Array<{ year: number; month: number; searchVolume: number }>;
  }>
> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      console.warn("⚠️ DataForSEO credentials not configured");
      return [];
    }

    // Remove protocol and www from domain
    const cleanDomain = domain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]; // Remove paths

    console.log(
      `🌐 Getting keywords for domain from DataForSEO: ${cleanDomain}${
        locationCode
          ? ` (location: ${locationCode})`
          : " (global - no location filter)"
      }`
    );

    const requestPayload: any = {
      target: cleanDomain,
      language_code: languageCode,
      limit: limit,
      sort_by: "search_volume",
      date_from: null,
      date_to: null,
      include_serp_info: false,
      include_subdomains: false,
    };

    if (locationCode !== undefined && locationCode !== null) {
      requestPayload.location_code = locationCode;
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/keywords_data/google_ads/keywords_for_site/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]), // ✅ FIX: Use the properly built payload
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO Keywords For Site API error: ${response.status} - ${errorText}`
      );
      return [];
    }

      const data = await readDataForSeoResponse(response);
    const keywords: Array<any> = [];

    if (data?.tasks?.[0]?.result) {
      for (const item of data.tasks[0].result) {
        // ✅ FIX: Read metrics directly from root 'item', not item.keyword_info
        // The /keywords_for_site/live endpoint returns data at root level
        const searchVolume = item.search_volume || 0;

        if (searchVolume > 0) {
          const monthlySearches =
            item.monthly_searches &&
            Array.isArray(item.monthly_searches) &&
            item.monthly_searches.length > 0
              ? item.monthly_searches[item.monthly_searches.length - 1]
                  ?.search_volume || searchVolume
              : searchVolume;

          // Handle competition: prefer competition_index (0-100), convert to 0-1 for competition field
          // If competition_index not available, use competition (assumed 0-1)
          const competitionIndex = item.competition_index;
          const competition =
            competitionIndex !== undefined && competitionIndex !== null
              ? competitionIndex / 100 // Convert 0-100 to 0-1
              : item.competition ?? 0; // Use competition if available (already 0-1)

          const difficulty =
            competitionIndex !== undefined && competitionIndex !== null
              ? competitionIndex // Keep as 0-100 for difficulty
              : Math.round((competition || 0) * 100); // Convert 0-1 to 0-100 if using competition

          keywords.push({
            keyword: item.keyword,
            searchVolume: searchVolume,
            competition: competition,
            cpc: item.cpc || 0, // ✅ FIX: Read from item.cpc
            difficulty: difficulty,
            monthlySearches: monthlySearches,
            clicks: item.clicks || 0,
            impressions: item.impressions || 0,
            ctr: item.ctr || 0,
            trend:
              item.monthly_searches && // ✅ FIX: Read from item.monthly_searches
              Array.isArray(item.monthly_searches)
                ? item.monthly_searches.map((ms: any) => ({
                    year: ms.year || 0,
                    month: ms.month || 0,
                    searchVolume: ms.search_volume || 0,
                  }))
                : [],
          });
        }
      }
    }

    console.log(
      `✅ Found ${keywords.length} keywords for domain ${cleanDomain} with real search data from DataForSEO`
    );
    return keywords;
  } catch (error: any) {
    console.error("❌ DataForSEO Keywords For Site error:", error.message);
    return [];
  }
}

/**
 * Get SERP results and analyze title patterns for a keyword
 * Returns ranking titles and pattern analysis to inform title generation
 */
export interface SERPTitleAnalysis {
  rankingTitles: Array<{
    title: string;
    position: number;
    url: string;
    domain: string;
  }>;
  titlePatterns: {
    structureTypes: Record<string, number>;
    commonPhrases: string[];
    averageLength: number;
    keywordPosition: { front: number; middle: number; end: number };
    contentIntent: { DIY: number; Service: number; Informational: number };
    powerWords: string[];
  };
  /** T3: "People Also Ask" questions extracted from the same SERP. Empty if none found. */
  paaQuestions: string[];
}

export async function getSERPTitleAnalysis(
  keyword: string,
  locationCode?: number,
  languageCode: string = "en",
  depth: number = 10
): Promise<SERPTitleAnalysis | null> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      console.warn(
        "⚠️ DataForSEO credentials not configured. Skipping SERP title analysis."
      );
      return null;
    }

    console.log(
      `📊 Analyzing SERP titles for keyword: "${keyword}"${
        locationCode ? ` (location: ${locationCode})` : ""
      }...`
    );

    const requestPayload: any = {
      keyword: keyword,
      language_code: languageCode,
      depth: depth,
      device: "desktop",
      os: "windows",
    };

    if (locationCode !== undefined && locationCode !== null) {
      requestPayload.location_code = locationCode;
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/serp/google/organic/live/advanced`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO SERP API error: ${response.status} - ${errorText}`
      );
      return null;
    }

      const data = await readDataForSeoResponse(response);
    const rankingTitles: Array<{
      title: string;
      position: number;
      url: string;
      domain: string;
    }> = [];

    // T3: also capture People Also Ask questions from the same SERP response.
    const paaQuestions: string[] = [];

    if (data?.tasks?.[0]?.result?.[0]?.items) {
      let position = 1;
      for (const item of data.tasks[0].result[0].items) {
        if (item.type === "organic" && item.title) {
          rankingTitles.push({
            title: item.title,
            position: position++,
            url: item.url || "",
            domain: item.domain || "",
          });
        }
        // T3: extract PAA questions
        if (item.type === "people_also_ask" && item.items) {
          for (const paaItem of item.items) {
            const question = paaItem.title || paaItem.question;
            if (typeof question === "string" && question.length > 10 && question.length < 120) {
              paaQuestions.push(question);
            }
          }
        }
      }
    }

    if (rankingTitles.length === 0) {
      console.warn(`⚠️ No ranking titles found for keyword: "${keyword}"`);
      return null;
    }

    const structureTypes: Record<string, number> = {};
    const commonPhrases: string[] = [];
    const powerWords: string[] = [];
    let totalLength = 0;
    let frontKeywordCount = 0;
    let middleKeywordCount = 0;
    let endKeywordCount = 0;
    let diyCount = 0;
    let serviceCount = 0;
    let informationalCount = 0;

    const keywordLower = keyword.toLowerCase();
    const keywordWords = keywordLower.split(" ");

    for (const rankingTitle of rankingTitles) {
      const title = rankingTitle.title;
      const titleLower = title.toLowerCase();
      totalLength += title.length;

      const keywordPos = titleLower.indexOf(keywordLower);
      if (keywordPos === 0 || keywordPos <= 3) {
        frontKeywordCount++;
      } else if (keywordPos < title.length / 2) {
        middleKeywordCount++;
      } else {
        endKeywordCount++;
      }

      if (
        titleLower.includes("how to") ||
        titleLower.includes("guide") ||
        titleLower.includes("tutorial") ||
        titleLower.includes("step")
      ) {
        diyCount++;
        structureTypes["how-to"] = (structureTypes["how-to"] || 0) + 1;
      } else if (
        titleLower.includes("service") ||
        titleLower.includes("company") ||
        titleLower.includes("professional") ||
        titleLower.includes("near me") ||
        titleLower.includes("cost") ||
        titleLower.includes("price")
      ) {
        serviceCount++;
        structureTypes["service"] = (structureTypes["service"] || 0) + 1;
      } else {
        informationalCount++;
        structureTypes["informational"] =
          (structureTypes["informational"] || 0) + 1;
      }

      if (titleLower.includes("top") || titleLower.includes("best")) {
        structureTypes["list-based"] = (structureTypes["list-based"] || 0) + 1;
        powerWords.push("top", "best");
      }
      if (titleLower.includes("vs") || titleLower.includes("comparison")) {
        structureTypes["comparison"] = (structureTypes["comparison"] || 0) + 1;
      }
      if (titleLower.includes("?")) {
        structureTypes["question"] = (structureTypes["question"] || 0) + 1;
      }
      if (
        titleLower.includes("mistake") ||
        titleLower.includes("avoid") ||
        titleLower.includes("error")
      ) {
        structureTypes["mistakes"] = (structureTypes["mistakes"] || 0) + 1;
      }

      const words = title
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !keywordWords.includes(w));
      commonPhrases.push(...words.slice(0, 3));
    }

    const analysis: SERPTitleAnalysis = {
      rankingTitles: rankingTitles.slice(0, 10),
      titlePatterns: {
        structureTypes,
        commonPhrases: Array.from(new Set(commonPhrases))
          .filter((p) => p.length > 3)
          .slice(0, 10),
        averageLength: Math.round(totalLength / rankingTitles.length),
        keywordPosition: {
          front: frontKeywordCount,
          middle: middleKeywordCount,
          end: endKeywordCount,
        },
        contentIntent: {
          DIY: diyCount,
          Service: serviceCount,
          Informational: informationalCount,
        },
        powerWords: Array.from(new Set(powerWords)).slice(0, 10),
      },
      paaQuestions: paaQuestions.slice(0, 8),
    };

    console.log(
      `✅ SERP analysis complete: ${rankingTitles.length} titles analyzed, ${paaQuestions.length} PAA questions, avg length: ${analysis.titlePatterns.averageLength} chars`
    );

    return analysis;
  } catch (error: any) {
    console.error("❌ DataForSEO SERP title analysis error:", error.message);
    return null;
  }
}

/**
 * Comprehensive SERP analysis for Skyscraper methodology
 * Analyzes top 10 results for content structure, word counts, sections, and gaps
 */
export interface ComprehensiveSERPAnalysis {
  top10Results: Array<{
    title: string;
    url: string;
    domain: string;
    position: number;
    estimatedWordCount?: number;
    structure?: "guide" | "list" | "how-to" | "service" | "article";
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
}

/**
 * Build a ComprehensiveSERPAnalysis from a plain list of organic results
 * (title/url/snippet). Shared shape for the ScraperAPI fallback so it matches
 * the DataForSEO output the strategist + skyscraper logic expect. Pure.
 */
export function buildSerpAnalysisFromResults(
  items: Array<{ title: string; url: string; domain?: string; snippet?: string; position?: number }>,
): ComprehensiveSERPAnalysis {
  const results: ComprehensiveSERPAnalysis["top10Results"] = [];
  const sectionsSet = new Set<string>();
  const formats: Array<"guide" | "list" | "how-to" | "service" | "article"> = [];
  let totalWordCount = 0;
  let wordCountCount = 0;
  let hasFAQCount = 0;

  for (const item of items.slice(0, 10)) {
    if (!item.title || !item.url) continue;
    const titleLower = item.title.toLowerCase();
    const snippet = item.snippet || "";
    const snippetLower = snippet.toLowerCase();

    let structure: "guide" | "list" | "how-to" | "service" | "article" = "article";
    if (titleLower.match(/complete|ultimate|comprehensive|guide|everything about/)) structure = "guide";
    else if (titleLower.match(/best|top \d+|list|\d+ ways|\d+ tips|compare/)) structure = "list";
    else if (titleLower.match(/how to|how-to|tutorial|step by step/)) structure = "how-to";
    else if (titleLower.match(/service|near me|in \w+|local/)) structure = "service";
    formats.push(structure);

    const estimatedWords = snippet ? snippet.split(/\s+/).length * 50 : 0;
    if (estimatedWords > 0) {
      totalWordCount += estimatedWords;
      wordCountCount++;
    }

    const hasFAQ = titleLower.includes("faq") || snippetLower.includes("frequently asked");
    if (hasFAQ) {
      sectionsSet.add("FAQ");
      hasFAQCount++;
    }
    if (titleLower.includes("pricing") || snippetLower.includes("cost") || snippetLower.includes("price")) sectionsSet.add("Pricing");
    if (titleLower.includes("tools") || snippetLower.includes("tool")) sectionsSet.add("Tools/Resources");
    if (titleLower.includes("best practice") || snippetLower.includes("best practice")) sectionsSet.add("Best Practices");
    if (titleLower.includes("case study") || snippetLower.includes("case study")) sectionsSet.add("Case Studies");
    if (titleLower.includes("how to") || snippetLower.includes("step")) sectionsSet.add("Step-by-Step");
    if (titleLower.includes("compare") || snippetLower.includes("vs") || snippetLower.includes("comparison")) sectionsSet.add("Comparison");

    results.push({
      title: item.title,
      url: item.url,
      domain: item.domain ?? "",
      position: item.position ?? results.length + 1,
      estimatedWordCount: estimatedWords > 0 ? estimatedWords : undefined,
      structure,
      hasFAQ,
      hasImages: false,
      hasVideos: false,
    });
  }

  const formatCounts = formats.reduce((acc, f) => {
    acc[f] = (acc[f] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const dominantFormat =
    (Object.entries(formatCounts).sort(([, a], [, b]) => b - a)[0]?.[0] as
      | "guide"
      | "list"
      | "how-to"
      | "service"
      | "mixed") || "mixed";

  const commonSections = Array.from(sectionsSet);
  const contentGaps: string[] = [];
  if (dominantFormat === "guide") {
    if (!commonSections.includes("Tools/Resources")) contentGaps.push("Tools/Resources section");
    if (!commonSections.includes("Case Studies")) contentGaps.push("Case Studies section");
    if (hasFAQCount < results.length * 0.7) contentGaps.push("Comprehensive FAQ section");
  } else if (dominantFormat === "list") {
    contentGaps.push("Comparison table", "Buying guide section");
  } else if (dominantFormat === "how-to") {
    contentGaps.push("Troubleshooting section", "Prerequisites section");
  }

  return {
    top10Results: results,
    averageWordCount: wordCountCount > 0 ? Math.round(totalWordCount / wordCountCount) : 0,
    commonSections,
    contentGaps,
    dominantFormat,
    visualElements: { averageImages: 0, hasInfographics: false, hasVideos: false },
  };
}

/**
 * Recovery-only final SERP fallback. This keeps the live-evidence ownership
 * gate intact when both DataForSEO and ScraperAPI are unavailable, while
 * making the extra paid OpenAI call opt-in for normal backend traffic.
 */
export async function getSerpAnalysisViaOpenAI(
  keyword: string,
  countryCode: string = "us",
): Promise<ComprehensiveSERPAnalysis | null> {
  if (
    process.env.RECOVERY_OPENAI_SERP_FALLBACK_ENABLED !== "true" ||
    !process.env.OPENAI_API_KEY ||
    !keyword.trim()
  ) {
    return null;
  }

  try {
    console.log(`🔁 SERP fallback via OpenAI web search for "${keyword}"…`);
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 1,
    });
    const model =
      process.env.RECOVERY_OPENAI_SERP_MODEL?.trim() || "gpt-5-mini";
    const response = await client.responses.create({
      model,
      store: false,
      tools: [
        {
          type: "web_search",
          search_context_size: "low",
          user_location: {
            type: "approximate",
            country: countryCode.toUpperCase(),
          },
        },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      max_output_tokens: 3000,
      instructions: [
        "Use live web search to identify organic results for the supplied search query.",
        "Return real result URLs and their visible titles. Do not invent or alter URLs.",
        "Exclude ads, maps, social posts, image results, and the search engine itself.",
        "Prefer eight distinct organic results, but return every verified result you can find up to ten.",
      ].join(" "),
      input: `Search query: ${keyword}\nMarket country: ${countryCode.toUpperCase()}`,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "recovery_openai_serp_results",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    snippet: { type: "string" },
                    position: { type: "integer" },
                  },
                  required: ["title", "url", "snippet", "position"],
                },
              },
            },
            required: ["results"],
          },
        },
      },
    });
    if (response.status !== "completed" || !response.output_text?.trim()) {
      console.error(
        `❌ OpenAI SERP fallback incomplete: ${response.status ?? "unknown"}`,
      );
      return null;
    }

    const parsed = JSON.parse(response.output_text) as {
      results?: Array<{
        title?: unknown;
        url?: unknown;
        snippet?: unknown;
        position?: unknown;
      }>;
    };
    const seen = new Set<string>();
    const items = (Array.isArray(parsed.results) ? parsed.results : [])
      .map((item, index) => {
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const url = typeof item.url === "string" ? item.url.trim() : "";
        const snippet =
          typeof item.snippet === "string" ? item.snippet.trim() : "";
        let domain = "";
        try {
          const parsedUrl = new URL(url);
          if (!/^https?:$/.test(parsedUrl.protocol)) return null;
          domain = parsedUrl.hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
        if (!title || !domain || seen.has(url)) return null;
        seen.add(url);
        return {
          title,
          url,
          domain,
          snippet,
          position:
            typeof item.position === "number" && item.position > 0
              ? Math.floor(item.position)
              : index + 1,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, 10);

    if (items.length < 3) {
      console.error(
        `❌ OpenAI SERP fallback returned only ${items.length} usable result(s)`,
      );
      return null;
    }
    const analysis = buildSerpAnalysisFromResults(items);
    console.log(
      `✅ OpenAI SERP fallback complete: ${analysis.top10Results.length} results, avg ${analysis.averageWordCount} words, format ${analysis.dominantFormat}`,
    );
    return analysis;
  } catch (error: any) {
    console.error("❌ OpenAI SERP fallback failed:", error?.message ?? error);
    return null;
  }
}

/**
 * SERP backup when DataForSEO is unavailable / out of credits (402). Uses
 * ScraperAPI's structured Google endpoint (SCRAPER_API_KEY — already used for
 * facts/competitor scraping). Best-effort: returns null on any failure so the
 * caller degrades to no-SERP rather than throwing.
 */
export async function getSerpAnalysisViaScraperAPI(
  keyword: string,
  countryCode: string = "us",
): Promise<ComprehensiveSERPAnalysis | null> {
  const key = process.env.SCRAPER_API_KEY;
  if (!keyword) return null;
  if (!key) return getSerpAnalysisViaOpenAI(keyword, countryCode);
  try {
    console.log(`🔁 SERP fallback via ScraperAPI for "${keyword}"…`);
    const url =
      `https://api.scraperapi.com/structured/google/search?api_key=${key}` +
      `&query=${encodeURIComponent(keyword)}&num=10&country_code=${countryCode}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`❌ ScraperAPI SERP fallback error: ${resp.status}`);
      return getSerpAnalysisViaOpenAI(keyword, countryCode);
    }
    const data: any = await resp.json();
    const organic: any[] = Array.isArray(data?.organic_results)
      ? data.organic_results
      : [];
    if (organic.length === 0) {
      return getSerpAnalysisViaOpenAI(keyword, countryCode);
    }
    const items = organic.slice(0, 10).map((r, i) => {
      const link = r.link || r.url || "";
      let domain: string | undefined;
      try {
        domain = link ? new URL(link).hostname.replace(/^www\./, "") : undefined;
      } catch {
        domain = undefined;
      }
      return {
        title: r.title || "",
        url: link,
        domain,
        snippet: r.snippet || r.description || "",
        position: typeof r.position === "number" ? r.position : i + 1,
      };
    });
    const analysis = buildSerpAnalysisFromResults(items);
    console.log(
      `✅ SERP fallback complete: ${analysis.top10Results.length} results, avg ${analysis.averageWordCount} words, format ${analysis.dominantFormat}`,
    );
    return analysis;
  } catch (err: any) {
    console.error("❌ ScraperAPI SERP fallback failed:", err?.message);
    return getSerpAnalysisViaOpenAI(keyword, countryCode);
  }
}

export async function getComprehensiveSERPAnalysis(
  keyword: string,
  locationCode?: number,
  languageCode: string = "en",
  depth: number = 10
): Promise<ComprehensiveSERPAnalysis | null> {
  try {
    if (!DATAFORSEO_BASE64 && (!DATAFORSEO_USERNAME || !DATAFORSEO_PASSWORD)) {
      console.warn(
        "⚠️ DataForSEO credentials not configured. Falling back to ScraperAPI SERP."
      );
      return getSerpAnalysisViaScraperAPI(keyword, locationCode === 2124 ? "ca" : "us");
    }

    console.log(
      `🔍 Performing comprehensive SERP analysis for keyword: "${keyword}"${
        locationCode ? ` (location: ${locationCode})` : ""
      }...`
    );

    const requestPayload: any = {
      keyword: keyword,
      language_code: languageCode,
      depth: depth,
      device: "desktop",
      os: "windows",
    };

    if (locationCode !== undefined && locationCode !== null) {
      requestPayload.location_code = locationCode;
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/serp/google/organic/live/advanced`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `❌ DataForSEO SERP API error: ${response.status} - ${errorText}`
      );
      // Out of credits (402) / any HTTP error → ScraperAPI backup.
      return getSerpAnalysisViaScraperAPI(keyword, locationCode === 2124 ? "ca" : "us");
    }

      const data = await readDataForSeoResponse(response);
    const results: ComprehensiveSERPAnalysis["top10Results"] = [];
    const sectionsSet = new Set<string>();
    const formats: Array<"guide" | "list" | "how-to" | "service" | "article"> = [];
    let totalWordCount = 0;
    let wordCountCount = 0;
    let totalImages = 0;
    let hasVideosCount = 0;
    let hasFAQCount = 0;

    if (data?.tasks?.[0]?.result?.[0]?.items) {
      for (const item of data.tasks[0].result[0].items) {
        if (item.type === "organic" && item.title && item.url && item.rank_absolute <= 10) {
          const titleLower = item.title.toLowerCase();
          
          // Detect structure/format
          let structure: "guide" | "list" | "how-to" | "service" | "article" = "article";
          if (titleLower.match(/complete|ultimate|comprehensive|guide|everything about/)) {
            structure = "guide";
          } else if (titleLower.match(/best|top \d+|list|\d+ ways|\d+ tips|compare/)) {
            structure = "list";
          } else if (titleLower.match(/how to|how-to|tutorial|step by step/)) {
            structure = "how-to";
          } else if (titleLower.match(/service|near me|in \w+|local/)) {
            structure = "service";
          }
          formats.push(structure);

          // Estimate word count from snippet/description (rough estimate)
          const snippet = item.description || item.snippet || "";
          const estimatedWords = snippet.split(/\s+/).length * 50; // Rough multiplier
          if (estimatedWords > 0) {
            totalWordCount += estimatedWords;
            wordCountCount++;
          }

          // Detect common sections from title/snippet
          if (titleLower.includes("faq") || snippet.toLowerCase().includes("frequently asked")) {
            sectionsSet.add("FAQ");
            hasFAQCount++;
          }
          if (titleLower.includes("pricing") || snippet.toLowerCase().includes("cost") || snippet.toLowerCase().includes("price")) {
            sectionsSet.add("Pricing");
          }
          if (titleLower.includes("tools") || snippet.toLowerCase().includes("tool")) {
            sectionsSet.add("Tools/Resources");
          }
          if (titleLower.includes("best practices") || snippet.toLowerCase().includes("best practice")) {
            sectionsSet.add("Best Practices");
          }
          if (titleLower.includes("case study") || snippet.toLowerCase().includes("case study")) {
            sectionsSet.add("Case Studies");
          }
          if (titleLower.includes("how to") || snippet.toLowerCase().includes("step")) {
            sectionsSet.add("Step-by-Step");
          }
          if (titleLower.includes("compare") || snippet.toLowerCase().includes("vs") || snippet.toLowerCase().includes("comparison")) {
            sectionsSet.add("Comparison");
          }

          // Check for images/videos (from item properties if available)
          if (item.images && item.images.length > 0) {
            totalImages += item.images.length;
          }
          if (item.videos && item.videos.length > 0) {
            hasVideosCount++;
          }

          results.push({
            title: item.title,
            url: item.url,
            domain: item.domain,
            position: item.rank_absolute,
            estimatedWordCount: estimatedWords > 0 ? estimatedWords : undefined,
            structure,
            hasFAQ: titleLower.includes("faq") || snippet.toLowerCase().includes("frequently asked"),
            hasImages: item.images && item.images.length > 0,
            hasVideos: item.videos && item.videos.length > 0,
          });
        }
      }
    }

    // Calculate dominant format
    const formatCounts = formats.reduce((acc, format) => {
      acc[format] = (acc[format] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const dominantFormat = Object.entries(formatCounts)
      .sort(([, a], [, b]) => b - a)[0]?.[0] as "guide" | "list" | "how-to" | "service" | "mixed" || "mixed";

    // Identify content gaps (common sections that might be missing)
    const commonSections = Array.from(sectionsSet);
    const contentGaps: string[] = [];
    
    // If most results are guides but lack certain sections, those are gaps
    if (dominantFormat === "guide") {
      if (!commonSections.includes("Tools/Resources")) contentGaps.push("Tools/Resources section");
      if (!commonSections.includes("Case Studies")) contentGaps.push("Case Studies section");
      if (hasFAQCount < results.length * 0.7) contentGaps.push("Comprehensive FAQ section");
    }
    if (dominantFormat === "list") {
      if (!commonSections.includes("Comparison Table")) contentGaps.push("Comparison table");
      if (!commonSections.includes("Buying Guide")) contentGaps.push("Buying guide section");
    }
    if (dominantFormat === "how-to") {
      if (!commonSections.includes("Troubleshooting")) contentGaps.push("Troubleshooting section");
      if (!commonSections.includes("Prerequisites")) contentGaps.push("Prerequisites section");
    }

    // DataForSEO responded OK but returned no usable organic results → backup.
    if (results.length === 0) {
      const fb = await getSerpAnalysisViaScraperAPI(
        keyword,
        locationCode === 2124 ? "ca" : "us",
      );
      if (fb) return fb;
    }

    const analysis: ComprehensiveSERPAnalysis = {
      top10Results: results.slice(0, 10),
      averageWordCount: wordCountCount > 0 ? Math.round(totalWordCount / wordCountCount) : 0,
      commonSections,
      contentGaps,
      dominantFormat,
      visualElements: {
        averageImages: results.length > 0 ? Math.round(totalImages / results.length) : 0,
        hasInfographics: totalImages > results.length * 2, // If average > 2 images per result
        hasVideos: hasVideosCount > 0,
      },
    };

    console.log(
      `✅ Comprehensive SERP analysis complete: ${results.length} results analyzed, avg word count: ${analysis.averageWordCount}, dominant format: ${analysis.dominantFormat}`
    );

    return analysis;
  } catch (error: any) {
    console.error("❌ Comprehensive SERP analysis error:", error.message);
    // Network / parse failure → ScraperAPI backup.
    return getSerpAnalysisViaScraperAPI(keyword, locationCode === 2124 ? "ca" : "us");
  }
}
