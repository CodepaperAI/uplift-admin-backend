import {
  getKeywordsForDomainFromDataForSEO,
  getCompetitorsFromDataForSEO,
  getDomainRankingsFromDataForSEO,
} from "../utils/dataforseo.utils";
import { KeywordAllocationService } from "./keyword-allocation.service";

export interface KeywordOpportunity {
  keyword: string;
  searchVolume: number;
  difficulty: number;
  cpc?: number;
  opportunityScore: number;
  source: "own" | "competitor" | "gap";
  isAvailable?: boolean;
  competitorDomain?: string;
}

export interface Competitor {
  name: string;
  url: string;
  domain: string;
}

const NON_COMPETITOR_PLATFORM_DOMAINS = new Set([
  "facebook.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "medium.com",
  "quora.com",
  "reddit.com",
  "tiktok.com",
  "twitter.com",
  "wikipedia.org",
  "x.com",
  "youtube.com",
]);

export function isMineableCompetitorDomain(domain: string): boolean {
  const normalizedDomain = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  if (!normalizedDomain) return false;

  return !Array.from(NON_COMPETITOR_PLATFORM_DOMAINS).some(
    (platformDomain) =>
      normalizedDomain === platformDomain ||
      normalizedDomain.endsWith(`.${platformDomain}`),
  );
}

/**
 * Service implementing the 6-step data-driven keyword discovery flow
 */
export class SmartKeywordDiscoveryService {
  private keywordAllocationService: KeywordAllocationService;

  constructor() {
    this.keywordAllocationService = new KeywordAllocationService();
  }

  /**
   * STEP 1: Domain Analysis (YOUR website)
   * Get keywords Google associates with your domain
   */
  async getOwnDomainKeywords(
    domain: string,
    locationCode?: number,
    limit: number = 200,
    languageCode: string = "en",
  ): Promise<KeywordOpportunity[]> {
    console.log(`🔍 STEP 1: Analyzing domain keywords for ${domain}...`);

    const keywords = await getKeywordsForDomainFromDataForSEO(
      domain,
      locationCode,
      languageCode,
      limit
    );

    const opportunities: KeywordOpportunity[] = keywords.map((kw) => ({
      keyword: kw.keyword,
      searchVolume: kw.searchVolume,
      difficulty: kw.difficulty,
      cpc: kw.cpc,
      opportunityScore: this.calculateOpportunityScore(kw),
      source: "own" as const,
    }));

    console.log(`✅ STEP 1 Complete: Found ${opportunities.length} keywords for your domain`);
    return opportunities;
  }

  /**
   * STEP 2: Competitor Discovery (WHO ranks for your services)
   * Find top domains ranking for your core services
   */
  async discoverCompetitors(
    realServices: string[],
    locationCode: number,
    limit: number = 20,
    languageCode: string = "en",
    /** GEO-KW-5: dynamic city name for geo-aware seed queries (replaces hardcoded "toronto"). */
    cityName?: string | null,
  ): Promise<Competitor[]> {
    console.log(`🔍 STEP 2: Discovering competitors for services: ${realServices.join(", ")}...`);

    // Build seed queries from real services.
    // GEO-KW-5: use the actual business city instead of hardcoding "toronto"
    // for Canadian businesses. Falls back to empty string for non-local or
    // when city is unknown so the seed remains service-only.
    const cityTag = cityName?.trim() || "";
    const queries = realServices.flatMap((service) => [
      service,
      ...(cityTag ? [`${service} ${cityTag}`] : []),
      `best ${service}`,
      `${service} near me`,
    ]);

    const competitors = await getCompetitorsFromDataForSEO(
      queries.slice(0, 10), // Use top 10 queries
      locationCode,
      limit,
      { languageCode },
    );

    const mineableCompetitors = competitors.filter((competitor) =>
      isMineableCompetitorDomain(competitor.domain),
    );

    console.log(
      `✅ STEP 2 Complete: Found ${mineableCompetitors.length} mineable competitors (${competitors.length - mineableCompetitors.length} platform domains excluded)`,
    );
    return mineableCompetitors;
  }

  /**
   * STEP 3: Competitor Keyword Mining (WHAT are they ranking for)
   * Get keywords for each competitor domain
   */
  async mineCompetitorKeywords(
    competitors: Competitor[],
    locationCode: number,
    keywordsPerCompetitor: number = 200,
    languageCode: string = "en",
  ): Promise<{
    allCompetitorKeywords: KeywordOpportunity[];
    competitorKeywordMap: Map<string, KeywordOpportunity[]>;
  }> {
    console.log(`🔍 STEP 3: Mining keywords from ${competitors.length} competitors...`);

    const allKeywords: KeywordOpportunity[] = [];
    const competitorKeywordMap = new Map<string, KeywordOpportunity[]>();

    // Process top 5 competitors in parallel (diminishing returns beyond 5)
    const topCompetitors = competitors.slice(0, 5);

    // Chunk into groups of 3 to avoid rate limits
    const CHUNK_SIZE = 3;
    for (let i = 0; i < topCompetitors.length; i += CHUNK_SIZE) {
      const chunk = topCompetitors.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (competitor) => {
          const keywords = await getKeywordsForDomainFromDataForSEO(
            competitor.domain,
            locationCode,
            languageCode,
            keywordsPerCompetitor
          );
          return { competitor, keywords };
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          const { competitor, keywords } = result.value;
          const opportunities: KeywordOpportunity[] = keywords.map((kw) => ({
            keyword: kw.keyword,
            searchVolume: kw.searchVolume,
            difficulty: kw.difficulty,
            cpc: kw.cpc,
            opportunityScore: this.calculateOpportunityScore(kw),
            source: "competitor" as const,
            competitorDomain: competitor.domain,
          }));

          competitorKeywordMap.set(competitor.domain, opportunities);
          allKeywords.push(...opportunities);
          console.log(`   ✅ Mined ${opportunities.length} keywords from ${competitor.domain}`);
        } else {
          console.warn(`   ⚠️ Failed to mine keywords from competitor: ${result.reason?.message || result.reason}`);
        }
      }
    }

    console.log(`✅ STEP 3 Complete: Mined ${allKeywords.length} total competitor keywords`);
    return { allCompetitorKeywords: allKeywords, competitorKeywordMap };
  }

  /**
   * STEP 4: Keyword Gap Analysis
   * Find keywords competitors have that you don't
   */
  async findKeywordGaps(
    ownKeywords: KeywordOpportunity[],
    competitorKeywords: KeywordOpportunity[]
  ): Promise<KeywordOpportunity[]> {
    console.log(`🔍 STEP 4: Analyzing keyword gaps...`);

    const ownKeywordSet = new Set(
      ownKeywords.map((k) => k.keyword.toLowerCase().trim())
    );

    // Find keywords in competitors but not in own
    const gaps = competitorKeywords
      .filter((k) => !ownKeywordSet.has(k.keyword.toLowerCase().trim()))
      .map((k) => ({
        ...k,
        source: "gap" as const,
        opportunityScore: k.opportunityScore * 1.2, // Boost gap keywords
      }))
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    console.log(`✅ STEP 4 Complete: Found ${gaps.length} keyword gaps`);
    return gaps;
  }

  /**
   * STEP 5: Ranking Check (AVOID what's already dominated)
   * Check if platform users already rank #1-3 for keywords
   */
  async checkPlatformConflicts(
    keywords: KeywordOpportunity[],
    businessId: string,
    locationScope: string,
    industryId: string,
    platformBusinesses: Array<{ id: string; domain: string }>,
    locationCode: number,
    languageCode: string = "en",
  ): Promise<KeywordOpportunity[]> {
    console.log(`🔍 STEP 5: Checking platform conflicts for ${keywords.length} keywords...`);

    // Check top 20 keywords for conflicts (reduced from 50 to cut API costs)
    const topKeywords = keywords.slice(0, 20);

    // STEP A: Batch all allocation checks in parallel (DB queries, fast)
    const allocationResults = await Promise.allSettled(
      topKeywords.map(async (keyword) => ({
        keyword,
        allocation: await this.keywordAllocationService.isKeywordAvailable(
          keyword.keyword,
          businessId,
          locationScope,
          industryId
        ),
      }))
    );

    const checkedKeywords: KeywordOpportunity[] = [];
    const needsSerpCheck: KeywordOpportunity[] = [];

    for (const result of allocationResults) {
      if (result.status === "fulfilled") {
        const { keyword, allocation } = result.value;
        if (!allocation.available) {
          keyword.isAvailable = false;
          checkedKeywords.push(keyword);
        } else {
          needsSerpCheck.push(keyword);
        }
      } else {
        // On failure, default to available
        const idx = allocationResults.indexOf(result);
        if (topKeywords[idx]) {
          topKeywords[idx].isAvailable = true;
          checkedKeywords.push(topKeywords[idx]);
        }
      }
    }

    // STEP B: Batch SERP ranking checks (groups of 5 keywords per API call)
    const firstPlatform = platformBusinesses[0];
    if (firstPlatform?.domain && needsSerpCheck.length > 0) {
      const SERP_BATCH_SIZE = 5;
      for (let i = 0; i < needsSerpCheck.length; i += SERP_BATCH_SIZE) {
        const batch = needsSerpCheck.slice(i, i + SERP_BATCH_SIZE);
        const batchKeywordStrings = batch.map((k) => k.keyword);

        try {
          const rankings = await getDomainRankingsFromDataForSEO(
            firstPlatform.domain,
            batchKeywordStrings,
            locationCode,
            languageCode,
          );

          // Build a set of keywords with top-3 rankings
          const topRankedKeywords = new Set(
            rankings.rankingKeywords
              .filter((rk) => rk.position <= 3)
              .map((rk) => rk.keyword.toLowerCase().trim())
          );

          for (const keyword of batch) {
            keyword.isAvailable = !topRankedKeywords.has(keyword.keyword.toLowerCase().trim());
            checkedKeywords.push(keyword);
          }
        } catch (error: any) {
          console.warn(`   ⚠️ SERP batch check failed: ${error.message}`);
          for (const keyword of batch) {
            keyword.isAvailable = true;
            checkedKeywords.push(keyword);
          }
        }
      }
    } else {
      // No platform domain or no keywords need SERP check
      for (const keyword of needsSerpCheck) {
        keyword.isAvailable = true;
        checkedKeywords.push(keyword);
      }
    }

    // Add remaining keywords as available (no conflict check for lower priority)
    const remaining = keywords.slice(20).map((k) => ({
      ...k,
      isAvailable: true,
    }));
    checkedKeywords.push(...remaining);

    const availableCount = checkedKeywords.filter((k) => k.isAvailable).length;
    console.log(`✅ STEP 5 Complete: ${availableCount}/${checkedKeywords.length} keywords available`);

    return checkedKeywords;
  }

  /**
   * STEP 6: Unique Keyword Assignment
   * Master function that orchestrates all 6 steps
   */
  async generateUniqueKeywordOpportunities(
    businessId: string,
    domain: string,
    realServices: string[],
    businessType: string,
    locationCode: number,
    locationScope: string,
    limit: number = 100,
    languageCode: string = "en",
    /** GEO-KW-5: pass the actual business city for geo-aware competitor seed queries. */
    cityName?: string | null,
  ): Promise<KeywordOpportunity[]> {
    console.log(`🚀 Starting 6-step keyword discovery for ${domain}...`);

    // STEP 1: Domain Analysis
    const ownKeywords = await this.getOwnDomainKeywords(
      domain,
      locationCode,
      200,
      languageCode,
    );

    // STEP 2: Competitor Discovery
    const competitors = await this.discoverCompetitors(
      realServices,
      locationCode,
      20,
      languageCode,
      cityName,
    );

    if (competitors.length === 0) {
      console.warn("⚠️ No competitors found, returning own keywords only");
      return ownKeywords.slice(0, limit);
    }

    // STEP 3: Competitor Keyword Mining
    const { allCompetitorKeywords } = await this.mineCompetitorKeywords(
      competitors,
      locationCode,
      200,
      languageCode,
    );

    // STEP 4: Keyword Gap Analysis
    const gapKeywords = await this.findKeywordGaps(ownKeywords, allCompetitorKeywords);

    // Combine all opportunities
    const allOpportunities = [
      ...ownKeywords,
      ...gapKeywords,
    ].sort((a, b) => b.opportunityScore - a.opportunityScore);

    // STEP 5: Ranking Check
    const industryId = this.keywordAllocationService.extractIndustryId(businessType);
    const platformBusinesses = await this.keywordAllocationService.getPlatformBusinessesInScope(
      locationScope,
      industryId,
      businessId
    );

    const checkedOpportunities = await this.checkPlatformConflicts(
      allOpportunities,
      businessId,
      locationScope,
      industryId,
      platformBusinesses,
      locationCode,
      languageCode,
    );

    // STEP 6: Filter and return available keywords
    const availableOpportunities = checkedOpportunities
      .filter((k) => k.isAvailable !== false) // Include if available or undefined
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, limit);

    console.log(`✅ STEP 6 Complete: ${availableOpportunities.length} unique keyword opportunities assigned`);

    return availableOpportunities;
  }

  /**
   * Calculate opportunity score for a keyword
   */
  private calculateOpportunityScore(kw: {
    searchVolume: number;
    difficulty: number;
    cpc?: number;
  }): number {
    const volume = kw.searchVolume || 0;
    const difficulty = kw.difficulty || 100;
    const cpc = kw.cpc || 0;

    // Higher volume = better
    // Lower difficulty = better
    // Higher CPC = better (indicates commercial value)
    const volumeScore = Math.min(1.0, volume / 1000); // Normalize to 0-1
    const difficultyScore = (100 - difficulty) / 100; // Invert difficulty (0-1)
    const cpcScore = Math.min(1.0, cpc / 10); // Normalize CPC (0-1)

    // Weighted combination
    return volumeScore * 0.4 + difficultyScore * 0.4 + cpcScore * 0.2;
  }
}
