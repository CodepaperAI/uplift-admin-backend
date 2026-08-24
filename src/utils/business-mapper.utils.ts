import { z } from "zod";
import {
  CREATE_BUSINESS,
  WEBSITE_ANALYSIS,
} from "../validators/business.validation";
import { normalizeWebsiteUrl } from "./url-normalizer";
import {
  fetchKeywordDataFromDataForSEO,
  getCompetitorsFromDataForSEO,
  getDomainRankingsFromDataForSEO,
  getKeywordSuggestionsWithMetrics,
  getKeywordsForDomainFromDataForSEO,
  getRelatedDomainsFromDataForSEO,
} from "./dataforseo.utils";

type WebsiteAnalysisType = z.infer<typeof WEBSITE_ANALYSIS>;
type CreateBusinessType = z.infer<typeof CREATE_BUSINESS>;

/**
 * Parse address into components
 */
function parseAddress(address: string): {
  street?: string;
  city?: string;
  state?: string;
  country?: string;
} {
  if (!address) return {};

  // Try to extract components from common formats
  // Example: "1200 Clarence Street South Brantford, Ontario, Canada N3S 7Y4"
  const parts = address.split(",").map((p) => p.trim());

  let street = parts[0] || "";
  let city = "";
  let state = "";
  let country = "";

  if (parts.length >= 3) {
    // Format: "Street, City, State, Country Postal"
    city = parts[parts.length - 3] || "";
    state = parts[parts.length - 2] || "";
    country =
      parts[parts.length - 1]?.replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/, "") ||
      ""; // Remove postal code
  } else if (parts.length === 2) {
    // Format: "Street, City State"
    city = parts[0] || "";
    const stateCountry = parts[1] || "";
    const stateCountryParts = stateCountry.split(" ");
    state = stateCountryParts.slice(0, -1).join(" ") || "";
    country = stateCountryParts[stateCountryParts.length - 1] || "";
  }

  // Remove postal code from street if present
  street = street.replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/, "").trim();

  return { street: street || address, city, state, country };
}

function readStringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractAddressFromSchemaNode(
  node: unknown,
): { street?: string; city?: string; state?: string; country?: string } | null {
  if (node === null || node === undefined) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const extracted = extractAddressFromSchemaNode(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (typeof node !== "object") {
    return null;
  }

  const obj = node as Record<string, unknown>;
  const street = readStringField(obj, "streetAddress");
  const city = readStringField(obj, "addressLocality");
  const state = readStringField(obj, "addressRegion");

  const countryValue = obj["addressCountry"];
  const country =
    typeof countryValue === "string"
      ? countryValue.trim() || undefined
      : countryValue &&
          typeof countryValue === "object" &&
          !Array.isArray(countryValue)
        ? readStringField(countryValue as Record<string, unknown>, "name")
        : undefined;

  if (street || city || state || country) {
    return { street, city, state, country };
  }

  const nestedAddress = extractAddressFromSchemaNode(obj["address"]);
  if (nestedAddress) {
    return nestedAddress;
  }

  const nestedGraph = extractAddressFromSchemaNode(obj["@graph"]);
  if (nestedGraph) {
    return nestedGraph;
  }

  for (const value of Object.values(obj)) {
    const extracted = extractAddressFromSchemaNode(value);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

/**
 * Extract design info from WEBSITE_ANALYSIS for BrandAnalysis
 */
export function extractDesignInfo(analysis: WebsiteAnalysisType): {
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
} {
  const colors = analysis.design?.colors || [];
  const fonts = analysis.design?.fonts || [];
  const logos = analysis.brandIdentity?.logos || [];
  const favicon = analysis.brandIdentity?.favicon;

  // Extract primary colors (first 5)
  const primaryColors = colors
    .slice(0, 5)
    .map((c) => c.hex)
    .filter(Boolean);

  // Extract secondary colors (remaining, max 5)
  const secondaryColors = colors
    .slice(5, 10)
    .map((c) => c.hex)
    .filter(Boolean);

  // Extract font family
  const fontFamily = fonts[0]?.family || fonts[0]?.type || null;

  // Extract logo (prefer header logo, fallback to first logo, then favicon)
  const headerLogo = logos.find(
    (l) =>
      l.type?.toLowerCase().includes("header") ||
      l.type?.toLowerCase().includes("logo")
  );
  const logoUrl = headerLogo?.url || logos[0]?.url || favicon || null;

  return {
    primaryColors:
      primaryColors.length > 0 ? primaryColors : ["#000000", "#ffffff"],
    secondaryColors,
    fontFamily,
    logoUrl,
    faviconUrl: favicon || null,
  };
}

/**
 * Extract design info from CREATE_BUSINESS payload.designInfo
 * Keeps ALL data from LLM - no data is removed
 */
export function extractDesignInfoFromPayload(designInfo: {
  colors?: Array<{ type: string; hex: string; source?: string }>;
  fonts?: Array<{ type: string; family?: string; weight?: string }>;
  logos?: Array<{ type: string; url: string }>;
  favicon?: string;
}): {
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
} {
  const colors = designInfo.colors || [];
  const fonts = designInfo.fonts || [];
  const logos = designInfo.logos || [];
  const favicon = designInfo.favicon;

  // Keep ALL colors - no slicing or filtering
  // Extract ALL hex values - split into primary (first 10) and secondary (rest)
  const allColorHexes = colors.map((c) => c.hex).filter(Boolean);

  // Store first 10 as primary, rest as secondary (BrandAnalysis supports arrays)
  const primaryColors = allColorHexes.slice(0, 10);
  const secondaryColors = allColorHexes.slice(10);

  // Combine ALL fonts into a single string to preserve all information
  // Format: "Font1 (weight), Font2 (weight), ..."
  const fontFamily =
    fonts.length > 0
      ? fonts
          .map((f) => {
            const family = f.family || f.type || "";
            const weight = f.weight ? ` (${f.weight})` : "";
            return `${family}${weight}`;
          })
          .filter(Boolean)
          .join(", ")
      : null;

  // Extract logo - prefer header logo, but keep first logo URL
  const headerLogo = logos.find(
    (l) =>
      l.type?.toLowerCase().includes("header") ||
      l.type?.toLowerCase().includes("logo")
  );
  const logoUrl = headerLogo?.url || logos[0]?.url || favicon || null;

  return {
    primaryColors:
      primaryColors.length > 0 ? primaryColors : ["#000000", "#ffffff"],
    secondaryColors,
    fontFamily,
    logoUrl,
    faviconUrl: favicon || null,
  };
}

/**
 * Infer service area from locations
 */
function inferServiceArea(
  locations?: Array<{ type: string; address: string }>
): "local" | "regional" | "national" | "international" | undefined {
  if (!locations || locations.length === 0) return undefined;

  if (locations.length > 1) {
    const countries = new Set(
      locations
        .map((loc) => {
          const addr = parseAddress(loc.address);
          return addr.country;
        })
        .filter(Boolean)
    );

    if (countries.size > 1) return "international";
    if (locations.length > 3) return "national";
    return "regional";
  }

  return "local";
}

/**
 * Infer business type from services
 */
function inferBusinessType(services?: string[]): string {
  if (!services || services.length === 0) return "Business Services";

  // Extract common keywords from first service
  const firstService = services[0] || "";
  const keywords = firstService.split(" ").slice(0, 3).join(" ");
  return keywords || "Business Services";
}

/**
 * Infer content tone from tagline and content
 */
function inferContentTone(
  tagline?: string,
  metaDescription?: string
): "professional" | "casual" | "technical" | "friendly" | undefined {
  const text = `${tagline || ""} ${metaDescription || ""}`.toLowerCase();

  if (
    text.includes("technical") ||
    text.includes("enterprise") ||
    text.includes("solutions")
  ) {
    return "technical";
  }
  if (
    text.includes("friendly") ||
    text.includes("welcome") ||
    text.includes("hello")
  ) {
    return "friendly";
  }
  if (text.includes("casual") || text.includes("relaxed")) {
    return "casual";
  }

  return "professional"; // Default
}

/**
 * Infer publishing frequency from navigation/blog presence
 */
function inferPublishingFrequency(
  navigation?: Array<{ text: string; url: string }>
): "daily" | "weekly" | "bi-weekly" | "monthly" {
  // Default to daily for all businesses
  return "daily";
}

/**
 * Infer preferred content types from navigation and services
 */
function inferContentTypes(
  navigation?: Array<{ text: string; url: string }>,
  coreServices?: { topLevel?: string[] }
): Array<
  "guides" | "reviews" | "news" | "tutorials" | "case-studies" | "how-to"
> {
  const types: Array<
    "guides" | "reviews" | "news" | "tutorials" | "case-studies" | "how-to"
  > = [];

  const navText = navigation?.map((n) => n.text.toLowerCase()).join(" ") || "";
  const servicesText = coreServices?.topLevel?.join(" ").toLowerCase() || "";
  const combined = `${navText} ${servicesText}`;

  if (
    combined.includes("case study") ||
    combined.includes("case-study") ||
    combined.includes("portfolio")
  ) {
    types.push("case-studies");
  }
  if (combined.includes("guide") || combined.includes("tutorial")) {
    types.push("guides");
    types.push("tutorials");
  }
  if (combined.includes("blog") || combined.includes("news")) {
    types.push("news");
  }
  if (combined.includes("how to") || combined.includes("how-to")) {
    types.push("how-to");
  }

  // Defaults
  if (types.length === 0) {
    types.push("guides", "case-studies");
  }

  return types;
}

/**
 * Get real competitors from DataForSEO
 * Uses SERP analysis to find actual competitors ranking for the same keywords
 * 🆕 NOW USES USER'S LOCATION for local competitor discovery
 */
async function getRealCompetitors(
  targetKeywords: string[],
  domain: string,
  industryFocus?: string[],
  locationCode?: number
): Promise<Array<{ name: string; url: string }>> {
  const locationInfo = locationCode
    ? ` (location code: ${locationCode})`
    : " (global)";
  console.log(`🔍 Getting real competitors from DataForSEO${locationInfo}...`);

  // Strategy 1: Find competitors from SERP analysis (who ranks for same keywords)
  // Use user's location code if available, otherwise default to US (2840)
  const serpCompetitors = await getCompetitorsFromDataForSEO(
    targetKeywords.slice(0, 10), // Use top 10 keywords
    locationCode || 2840, // Use user's location or default to US
    10 // Get top 10 competitors
  );

  if (serpCompetitors.length >= 2) {
    console.log(
      `✅ Found ${serpCompetitors.length} real competitors from SERP analysis`
    );
    // Convert to required format (remove domain field)
    return serpCompetitors
      .filter((c) => c.domain !== domain.toLowerCase()) // Exclude self
      .slice(0, 5) // Limit to 5 competitors
      .map((c) => ({
        name: c.name,
        url: c.url,
      }));
  }

  // Strategy 2: Get related domains from DataForSEO Domain Analytics
  console.log(`⚠️ SERP competitors limited, trying related domains...`);
  const relatedDomains = await getRelatedDomainsFromDataForSEO(
    domain,
    5,
    locationCode || 2840
  );

  if (relatedDomains.length >= 2) {
    console.log(
      `✅ Found ${relatedDomains.length} related domains/competitors`
    );
    return relatedDomains
      .filter((c) => c.domain !== domain.toLowerCase()) // Exclude self
      .slice(0, 5)
      .map((c) => ({
        name: c.name,
        url: c.url,
      }));
  }

  // Fallback: Return empty array (better than fake data)
  console.warn(
    `⚠️ No real competitors found from DataForSEO - returning empty array`
  );
  return [];
}

/**
 * Validate and enrich keywords with DataForSEO real data
 * Filters zero-volume keywords and ranks by search volume
 * 🆕 NOW USES DOMAIN KEYWORDS AS PRIMARY SOURCE
 */
async function validateAndEnrichKeywords(
  llmKeywords: string[],
  businessName: string,
  businessCity?: string,
  businessState?: string,
  businessType?: string,
  industryFocus?: string[],
  domain?: string
): Promise<
  Array<{
    keyword: string;
    keywordType: "MUST_HAVE" | "NICE_TO_HAVE";
    searchVolume: number;
  }>
> {
  // Debug logging
  console.log(`📋 Business Type: ${businessType || "N/A"}`);
  console.log(`📋 Industry Focus: ${industryFocus?.join(", ") || "N/A"}`);
  console.log(
    `📋 City: ${businessCity || "N/A"}, State: ${businessState || "N/A"}`
  );
  console.log(`📋 Domain: ${domain || "N/A"}`);

  // 🚀 OPTIMIZATION: Fetch domain keywords and validate LLM keywords in PARALLEL
  // Don't block on slow domain analysis - use it as a bonus if available quickly
  let domainKeywords: Array<{ keyword: string; searchVolume: number }> = [];
  let validatedLLMKeywords: Array<{ keyword: string; searchVolume: number }> =
    [];

  // Create promises for parallel execution
  const DOMAIN_KEYWORD_TIMEOUT = 10000; // 10 seconds max for domain analysis

  // Start domain keyword fetching (with timeout)
  const domainKeywordPromise = domain
    ? (async () => {
        console.log(
          `🌐 Getting keywords for domain: ${domain} (parallel, timeout: ${DOMAIN_KEYWORD_TIMEOUT}ms)`
        );
        try {
          const domainKeywordData = await getKeywordsForDomainFromDataForSEO(
            domain,
            undefined, // No location code - global analysis
            "en",
            50 // Reduced from 100 for faster response
          );

          if (domainKeywordData.length > 0) {
            return domainKeywordData
              .filter((kw) => kw.searchVolume >= 50) // Minimum 50 searches/month
              .sort((a, b) => b.searchVolume - a.searchVolume)
              .slice(0, 50) // Top 50 domain keywords
              .map((kw) => ({
                keyword: kw.keyword,
                searchVolume: kw.searchVolume,
              }));
          }
          return [];
        } catch (error: any) {
          console.warn(
            `⚠️ Domain keyword fetch failed: ${error.message} - continuing without domain keywords`
          );
          return [];
        }
      })()
    : Promise.resolve([]);

  // Timeout wrapper for domain keywords
  const domainKeywordWithTimeout = Promise.race([
    domainKeywordPromise,
    new Promise<typeof domainKeywords>((resolve) => {
      setTimeout(() => {
        console.warn(
          `⏱️ Domain keyword fetch timed out after ${DOMAIN_KEYWORD_TIMEOUT}ms - continuing without domain keywords`
        );
        resolve([]);
      }, DOMAIN_KEYWORD_TIMEOUT);
    }),
  ]);

  // Start LLM keyword validation (runs in parallel with domain fetch)
  const llmValidationPromise =
    llmKeywords.length > 0
      ? (async () => {
          console.log(
            `🔍 Validating ${llmKeywords.length} LLM-extracted keywords with DataForSEO (parallel with domain fetch)...`
          );
          console.log(
            `📝 LLM Keywords: ${llmKeywords.slice(0, 5).join(", ")}${
              llmKeywords.length > 5 ? "..." : ""
            }`
          );

          try {
            const keywordMetrics = await fetchKeywordDataFromDataForSEO(
              llmKeywords,
              undefined, // No location code - global search
              "en"
            );

            return llmKeywords
              .map((keyword) => {
                const metrics = keywordMetrics.get(keyword);
                return {
                  keyword,
                  searchVolume:
                    metrics?.searchVolume || metrics?.monthlySearches || 0,
                };
              })
              .filter((kw) => kw.searchVolume > 0) // Remove zero-volume keywords
              .sort((a, b) => b.searchVolume - a.searchVolume); // Sort by volume (highest first)
          } catch (error: any) {
            console.warn(
              `⚠️ LLM keyword validation failed: ${error.message} - continuing with empty array`
            );
            return [];
          }
        })()
      : Promise.resolve([]);

  // Execute both in parallel
  const [domainKeywordsResult, validatedLLMKeywordsResult] = await Promise.all([
    domainKeywordWithTimeout,
    llmValidationPromise,
  ]);

  domainKeywords = domainKeywordsResult;
  validatedLLMKeywords = validatedLLMKeywordsResult;

  if (domainKeywords.length > 0) {
    console.log(
      `✅ Found ${domainKeywords.length} keywords from domain analysis (parallel fetch)`
    );
  }

  if (validatedLLMKeywords.length > 0) {
    console.log(
      `✅ Validated: ${validatedLLMKeywords.length} LLM keywords have real search volume`
    );
  }

  // Fallback: Generate basic seeds if nothing is available
  if (llmKeywords.length === 0 && domainKeywords.length === 0) {
    console.warn(
      "⚠️ No keywords extracted by LLM and no domain keywords. Generating seed keywords from business info"
    );
    llmKeywords = [businessName];
    if (businessType) {
      // Use first part of business type (not the whole comma-separated string)
      const firstService = businessType.split(",")[0]?.trim();
      if (firstService && firstService.length < 30) {
        llmKeywords.push(firstService);
      }
    }
    if (industryFocus && industryFocus.length > 0 && industryFocus[0]) {
      llmKeywords.push(industryFocus[0]); // Just first industry, not all
    }
  }

  // Step 3: Combine domain keywords + validated LLM keywords
  let finalKeywords: Array<{ keyword: string; searchVolume: number }> = [];

  if (domainKeywords.length >= 10) {
    // Domain keywords are the primary source - use them!
    finalKeywords = domainKeywords.slice(0, 30); // Top 30 domain keywords
    console.log(
      `✅ Using ${finalKeywords.length} keywords from domain analysis (primary source)`
    );

    // Optionally merge with top LLM keywords (if not duplicates)
    if (validatedLLMKeywords.length > 0) {
      const existingKeywords = new Set(
        finalKeywords.map((k) => k.keyword.toLowerCase())
      );
      const additionalLLM = validatedLLMKeywords
        .filter((k) => !existingKeywords.has(k.keyword.toLowerCase()))
        .slice(0, 10);

      if (additionalLLM.length > 0) {
        finalKeywords = [...finalKeywords, ...additionalLLM]
          .sort((a, b) => b.searchVolume - a.searchVolume)
          .slice(0, 30);
        console.log(
          `✅ Merged ${additionalLLM.length} validated LLM keywords = ${finalKeywords.length} total`
        );
      }
    }
  } else if (validatedLLMKeywords.length >= 10) {
    // Fallback: Use validated LLM keywords if domain keywords insufficient
    finalKeywords = validatedLLMKeywords;
    console.log(
      `✅ Using ${finalKeywords.length} validated LLM keywords (domain analysis returned ${domainKeywords.length} keywords)`
    );

    // Merge with available domain keywords
    if (domainKeywords.length > 0) {
      const existingKeywords = new Set(
        finalKeywords.map((k) => k.keyword.toLowerCase())
      );
      const additionalDomain = domainKeywords
        .filter((k) => !existingKeywords.has(k.keyword.toLowerCase()))
        .slice(0, 10);

      if (additionalDomain.length > 0) {
        finalKeywords = [...finalKeywords, ...additionalDomain]
          .sort((a, b) => b.searchVolume - a.searchVolume)
          .slice(0, 30);
        console.log(
          `✅ Merged ${additionalDomain.length} domain keywords = ${finalKeywords.length} total`
        );
      }
    }
  } else {
    // Last resort: Get suggestions using better seeds
    console.log(
      `⚠️ Domain keywords (${domainKeywords.length}) and LLM keywords (${validatedLLMKeywords.length}) insufficient. Getting DataForSEO suggestions...`
    );

    // Build better seed keywords
    const seedKeywords: string[] = [];

    // Use business name first (most reliable)
    if (businessName) {
      seedKeywords.push(businessName);
      console.log(`🌱 Primary seed: ${businessName}`);
    }

    // Use core services (first service, not all industries)
    if (businessType) {
      // Split by comma and take first meaningful term
      const firstService = businessType.split(",")[0]?.trim();
      if (firstService && firstService.length < 30 && firstService.length > 2) {
        seedKeywords.push(firstService);
        console.log(`🌱 Service seed: ${firstService}`);
      }
    }

    // Use first industry focus (not all)
    if (industryFocus && industryFocus.length > 0) {
      const firstIndustry = industryFocus[0];
      if (firstIndustry && firstIndustry.length < 30) {
        seedKeywords.push(firstIndustry);
        console.log(`🌱 Industry seed: ${firstIndustry}`);
      }
    }

    // Add validated keywords (if any)
    seedKeywords.push(
      ...validatedLLMKeywords.slice(0, 2).map((k) => k.keyword)
    );

    // Add top domain keywords as seeds (if any)
    if (domainKeywords.length > 0) {
      seedKeywords.push(...domainKeywords.slice(0, 2).map((k) => k.keyword));
    }

    // Deduplicate and limit
    const uniqueSeeds = [...new Set(seedKeywords.filter(Boolean))].slice(0, 5);

    console.log(`🌱 Using seed keywords: ${uniqueSeeds.join(", ")}`);

    const suggestions = await getKeywordSuggestionsWithMetrics(
      uniqueSeeds,
      undefined, // No location code - global search
      "en",
      100
    );

    if (suggestions.length > 0) {
      const dfseoSuggestions = suggestions
        .filter((s) => s.searchVolume > 50)
        .slice(0, 30)
        .map((s) => ({
          keyword: s.keyword,
          searchVolume: s.searchVolume,
        }));

      // Merge all sources
      const allKeywords = new Map<string, number>();
      [...domainKeywords, ...validatedLLMKeywords, ...dfseoSuggestions].forEach(
        (kw) => {
          const existing = allKeywords.get(kw.keyword.toLowerCase());
          if (!existing || kw.searchVolume > existing) {
            allKeywords.set(kw.keyword.toLowerCase(), kw.searchVolume);
          }
        }
      );

      finalKeywords = Array.from(allKeywords.entries())
        .map(([keyword, searchVolume]) => ({ keyword, searchVolume }))
        .sort((a, b) => b.searchVolume - a.searchVolume)
        .slice(0, 30);

      console.log(
        `✅ Combined: ${domainKeywords.length} domain + ${validatedLLMKeywords.length} LLM + ${suggestions.length} suggestions = ${finalKeywords.length} total`
      );
    } else {
      // Last fallback: combine what we have
      finalKeywords = [...domainKeywords, ...validatedLLMKeywords]
        .sort((a, b) => b.searchVolume - a.searchVolume)
        .slice(0, 30);
      console.warn(
        `⚠️ No DataForSEO suggestions available. Using ${finalKeywords.length} keywords from domain + LLM`
      );
    }
  }

  // Step 4: Categorize by search volume
  // MUST_HAVE: Top 10 by search volume (highest traffic)
  // NICE_TO_HAVE: Next 20 (lower but still valuable)
  const categorizedKeywords = finalKeywords.map((kw, index) => ({
    keyword: kw.keyword,
    keywordType: (index < 10 ? "MUST_HAVE" : "NICE_TO_HAVE") as
      | "MUST_HAVE"
      | "NICE_TO_HAVE",
    searchVolume: kw.searchVolume,
  }));

  // Ensure we have at least 10 MUST_HAVE and 20 NICE_TO_HAVE
  const mustHaveKeywords = categorizedKeywords.filter(
    (k) => k.keywordType === "MUST_HAVE"
  );
  const niceToHaveKeywords = categorizedKeywords.filter(
    (k) => k.keywordType === "NICE_TO_HAVE"
  );

  // 🆕 IMPROVED: Try DataForSEO to fill gaps instead of generic terms
  if (mustHaveKeywords.length < 10 || niceToHaveKeywords.length < 20) {
    const neededCount =
      10 - mustHaveKeywords.length + (20 - niceToHaveKeywords.length);

    if (neededCount > 0) {
      console.log(
        `⚠️ Need ${neededCount} more keywords. Getting DataForSEO suggestions...`
      );

      // Build comprehensive seed keywords for gap filling
      const seedKeywords: string[] = [];

      // Use business name first (most reliable)
      if (businessName) {
        seedKeywords.push(businessName);
      }

      // Add existing keywords
      seedKeywords.push(...finalKeywords.slice(0, 2).map((k) => k.keyword));

      // Use first service from business type (not the whole comma-separated string)
      if (businessType) {
        const firstService = businessType.split(",")[0]?.trim();
        if (
          firstService &&
          firstService.length < 30 &&
          firstService.length > 2
        ) {
          seedKeywords.push(firstService);
          if (businessCity) {
            seedKeywords.push(`${firstService} ${businessCity}`);
          }
        }
      }

      // Use first industry (not all)
      if (industryFocus && industryFocus.length > 0 && industryFocus[0]) {
        seedKeywords.push(industryFocus[0]);
      }

      // Add domain keywords as seeds (if available but not already in final)
      if (domainKeywords.length > finalKeywords.length) {
        const domainSeedKeywords = domainKeywords
          .slice(finalKeywords.length, finalKeywords.length + 2)
          .map((k) => k.keyword);
        seedKeywords.push(...domainSeedKeywords);
      }

      // Deduplicate and limit
      const uniqueSeeds = [...new Set(seedKeywords.filter(Boolean))].slice(
        0,
        5
      );

      console.log(`🌱 Gap-filling seed keywords: ${uniqueSeeds.join(", ")}`);

      const additionalSuggestions = await getKeywordSuggestionsWithMetrics(
        uniqueSeeds,
        undefined, // No location code - global search
        "en",
        neededCount * 2 // Get extra to ensure we have enough
      );

      if (additionalSuggestions.length > 0) {
        // Add to appropriate category
        const sortedSuggestions = additionalSuggestions
          .filter((s) => s.searchVolume > 50) // Only keywords with real volume
          .sort((a, b) => b.searchVolume - a.searchVolume);

        // Create a set of existing keywords for duplicate checking
        const existingKeywords = new Set([
          ...mustHaveKeywords.map((k) => k.keyword.toLowerCase()),
          ...niceToHaveKeywords.map((k) => k.keyword.toLowerCase()),
        ]);

        // Fill MUST_HAVE gaps
        while (mustHaveKeywords.length < 10 && sortedSuggestions.length > 0) {
          const suggestion = sortedSuggestions.shift();
          if (
            suggestion &&
            !existingKeywords.has(suggestion.keyword.toLowerCase())
          ) {
            mustHaveKeywords.push({
              keyword: suggestion.keyword,
              keywordType: "MUST_HAVE" as const,
              searchVolume: suggestion.searchVolume,
            });
            existingKeywords.add(suggestion.keyword.toLowerCase());
          }
        }

        // Fill NICE_TO_HAVE gaps
        while (niceToHaveKeywords.length < 20 && sortedSuggestions.length > 0) {
          const suggestion = sortedSuggestions.shift();
          if (
            suggestion &&
            !existingKeywords.has(suggestion.keyword.toLowerCase())
          ) {
            niceToHaveKeywords.push({
              keyword: suggestion.keyword,
              keywordType: "NICE_TO_HAVE" as const,
              searchVolume: suggestion.searchVolume,
            });
            existingKeywords.add(suggestion.keyword.toLowerCase());
          }
        }
      }
    }
  }

  // ⚠️ LAST RESORT: Only pad if DataForSEO completely fails (should be rare)
  if (mustHaveKeywords.length < 10 || niceToHaveKeywords.length < 20) {
    console.warn(
      `⚠️ DataForSEO failed to provide enough keywords. Using extracted data only (${mustHaveKeywords.length} MUST_HAVE, ${niceToHaveKeywords.length} NICE_TO_HAVE)`
    );
    // Don't pad with fake keywords - use what we have
  }

  console.log(
    `✅ Final: ${mustHaveKeywords.length} MUST_HAVE + ${niceToHaveKeywords.length} NICE_TO_HAVE keywords`
  );

  return [...mustHaveKeywords, ...niceToHaveKeywords].slice(0, 30);
}

/**
 * Map Website Analysis to CREATE_BUSINESS format
 * NOW WITH DataForSEO VALIDATION for keywords!
 */
export async function mapWebsiteAnalysisToBusiness(
  analysis: WebsiteAnalysisType,
  userId: string
): Promise<CreateBusinessType> {
  const mainLocation = analysis.contactInfo?.locations?.[0]?.address || "";
  const contactAddressParts = parseAddress(mainLocation);
  const schemaAddressParts = extractAddressFromSchemaNode(analysis.seo?.schema);
  const addressParts = {
    street: contactAddressParts.street || schemaAddressParts?.street,
    city: contactAddressParts.city || schemaAddressParts?.city,
    state: contactAddressParts.state || schemaAddressParts?.state,
    country: contactAddressParts.country || schemaAddressParts?.country,
  };

  const businessType =
    analysis.coreServices?.topLevel?.join(", ") ||
    analysis.brandIdentity.tagline ||
    "";

  // 🆕 ENHANCED: Use detailed businessInfo if available, otherwise fallback to existing logic
  const businessSummary =
    analysis.businessInfo?.businessSummary ||
    analysis.seo?.metaDescription ||
    analysis.brandIdentity.tagline ||
    "";

  const targetAudience = analysis.businessInfo?.targetAudience || "";

  const valuePropositions = analysis.businessInfo?.valuePropositions || [];

  const customerPainPoints = analysis.businessInfo?.customerPainPoints || [];

  const businessGoals = analysis.businessInfo?.businessGoals || [];

  const uniqueSellingPoints = analysis.businessInfo?.uniqueSellingPoints || [];

  console.log(
    `📊 Enhanced Business Info: Summary=${
      businessSummary ? "✅" : "❌"
    }, Audience=${targetAudience ? "✅" : "❌"}, Value Props=${
      valuePropositions.length
    }, Pain Points=${customerPainPoints.length}`
  );

  let mustHaveKeywords: Array<{ keyword: string; keywordType: "MUST_HAVE" }> =
    [];
  let niceToHaveKeywords: Array<{
    keyword: string;
    keywordType: "NICE_TO_HAVE";
  }> = [];

  if (
    analysis.seo?.targetKeywordsWithType &&
    analysis.seo.targetKeywordsWithType.length > 0
  ) {
    // Use LLM-categorized keywords
    const keywordsWithType = analysis.seo.targetKeywordsWithType;
    mustHaveKeywords = keywordsWithType
      .filter((kw) => kw.keywordType === "MUST_HAVE")
      .map((kw) => ({
        keyword: kw.keyword,
        keywordType: "MUST_HAVE" as const,
      }));

    niceToHaveKeywords = keywordsWithType
      .filter((kw) => kw.keywordType === "NICE_TO_HAVE")
      .map((kw) => ({
        keyword: kw.keyword,
        keywordType: "NICE_TO_HAVE" as const,
      }));

    console.log(
      `✅ Using ${mustHaveKeywords.length} MUST_HAVE and ${niceToHaveKeywords.length} NICE_TO_HAVE keywords from LLM categorization`
    );
  } else {
    // Fallback: Use simple split (existing logic)
    const targetKeywords = analysis.seo?.targetKeywords || [];
    mustHaveKeywords = targetKeywords.slice(0, 10).map((keyword) => ({
      keyword,
      keywordType: "MUST_HAVE" as const,
    }));
    niceToHaveKeywords = targetKeywords.slice(10, 30).map((keyword) => ({
      keyword,
      keywordType: "NICE_TO_HAVE" as const,
    }));
    console.warn(
      "⚠️ LLM did not categorize keywords, using fallback split (first 10 = MUST_HAVE, next 20 = NICE_TO_HAVE)"
    );
  }

  // 🆕 NEW: Use LLM-extracted competitive advantages if available, otherwise fallback
  let advantages: string[] = [];
  if (
    analysis.competitiveAdvantages &&
    analysis.competitiveAdvantages.length > 0
  ) {
    advantages = analysis.competitiveAdvantages.slice(0, 10);
    console.log(
      `✅ Using ${advantages.length} LLM-extracted competitive advantages`
    );
  } else {
    advantages = [
      ...(analysis.coreServices?.subOfferings?.slice(0, 5) || []),
      ...(analysis.recognition?.awards?.slice(0, 2) || []),
      ...(analysis.recognition?.partnerships?.slice(0, 2) || []),
    ].filter(Boolean);
    console.warn(
      "⚠️ Using fallback advantages extraction (LLM didn't extract competitive advantages)"
    );
    if (advantages.length === 0) {
      console.warn(
        "⚠️ No advantages extracted from website - leaving empty (better than fake data)"
      );
    } else if (advantages.length < 3) {
      console.warn(
        `⚠️ Only ${advantages.length} advantages extracted (recommended: 3+) - using real data only`
      );
    }
  }

  // Use LLM-extracted competitors directly.
  let competitors: Array<{ name: string; url: string }> = [];
  if (analysis.competitors && analysis.competitors.length > 0) {
    competitors = analysis.competitors
      .filter((c) => c.name)
      .map((c) => ({
        name: c.name,
        url: c.url || "",
      }))
      .slice(0, 10);

    console.log(`✅ Using ${competitors.length} LLM-extracted competitors`);
  } else {
    console.warn(`⚠️ No LLM-extracted competitors found in website analysis`);
  }

  // 🆕 NEW: Get REAL domain rankings from DataForSEO
  const allKeywordsForRanking = [
    ...mustHaveKeywords.map((k) => k.keyword),
    ...niceToHaveKeywords.slice(0, 3).map((k) => k.keyword),
  ];
  const domainRankings = await getDomainRankingsFromDataForSEO(
    analysis.domain,
    allKeywordsForRanking.slice(0, 5), // Use top 5 keywords
    undefined // No location filter - global analysis
  );

  // Format ranking string from real data
  let rankingString = "Not available";
  if (
    domainRankings.averagePosition !== null &&
    domainRankings.visibility !== null
  ) {
    if (domainRankings.rankingKeywords.length > 0) {
      const topRankings = domainRankings.rankingKeywords
        .slice(0, 3)
        .map((r) => `${r.keyword} (#${r.position})`)
        .join(", ");
      rankingString = `Avg Position: ${domainRankings.averagePosition}, Visibility: ${domainRankings.visibility}% | Top Rankings: ${topRankings}`;
    } else {
      rankingString = `Avg Position: ${domainRankings.averagePosition}, Visibility: ${domainRankings.visibility}%`;
    }
  }

  // Build result
  const result: CreateBusinessType = {
    businessName: analysis.brandIdentity.name,
    businessType: inferBusinessType(analysis.coreServices?.topLevel),
    businessDescription:
      businessSummary ||
      analysis.seo?.metaDescription ||
      analysis.brandIdentity.tagline ||
      `${analysis.brandIdentity.name} provides ${
        analysis.coreServices?.topLevel?.[0] || "professional services"
      }`,
    websiteURL: normalizeWebsiteUrl(analysis.scrapedUrl ?? "") || analysis.scrapedUrl,
    userId: userId,

    keywords: [...mustHaveKeywords, ...niceToHaveKeywords],
    advantage: advantages.slice(0, 10), // Limit to 10
    competitors: competitors,
    ranking: rankingString, // 🆕 REAL ranking data from DataForSEO
    website: normalizeWebsiteUrl(analysis.scrapedUrl ?? "") || analysis.scrapedUrl,

    // Geographic
    businessAddress: addressParts.street,
    businessCity: addressParts.city,
    businessState: addressParts.state,
    businessCountry: addressParts.country,
    serviceArea: inferServiceArea(analysis.contactInfo?.locations),

    // Preferences
    targetAudience:
      targetAudience ||
      analysis.coreServices?.industryFocus?.join(", ") ||
      analysis.coreServices?.topLevel?.join(", ") ||
      "",
    contentTone: inferContentTone(
      analysis.brandIdentity.tagline,
      analysis.seo?.metaDescription
    ),
    publishingFrequency: inferPublishingFrequency(analysis.navigation),
    preferredContentTypes: inferContentTypes(
      analysis.navigation,
      analysis.coreServices
    ),
  };

  return result;
}
