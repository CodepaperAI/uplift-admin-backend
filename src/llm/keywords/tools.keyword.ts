import { tool } from "@langchain/core/tools";
import { Prisma } from "@prisma/client";
import { fetchKeywordDataFromDataForSEO } from "../../utils/dataforseo.utils";
import { savePlanKeywords } from "../../utils/plan-keyword-save.utils";
import { KEYWORD_DATA_FOR_DB } from "../../validators/keyword.validation";

type KeywordItem = {
  keyword: string;
  publishDate: string;
  publishTime: string;
  keywordDiffculty: string;
  keywordSearchVolume: string;
  userId?: string;
  businessId?: string | null;
  keywordCategory?: string;
  keywordIntent?: string;
  keywordSource?: string;
  difficultyBucket?: string;
  selectionMetadata?: Prisma.InputJsonValue | null;
  keywordCpc?: number | null;
  keywordCompetition?: number | null;
  keywordTrend?: string | null;
  keywordMonthlySearches?: number | null;
  keywordClicks?: number | null;
  keywordImpressions?: number | null;
  keywordCTR?: number | null;
  keywordLowTopOfPageBid?: number | null;
  keywordHighTopOfPageBid?: number | null;
  keywordDataUpdatedAt?: string | null;
};

export const saveKeywordsToDb = tool(
  async (structuredJson: unknown) => {
    try {
      const payload = KEYWORD_DATA_FOR_DB.parse(structuredJson);

      const hasRealData =
        payload.data[0]?.keywordDataUpdatedAt !== undefined &&
        payload.data[0]?.keywordDataUpdatedAt !== null;

      let enrichedData: KeywordItem[];

      if (hasRealData) {
        console.log(
          `✅ Tool: Keywords already have REAL DataForSEO metrics, skipping enrichment`
        );
        enrichedData = payload.data as KeywordItem[];
      } else {
        console.log(
          `⚠️ Tool: Keywords missing real data, enriching with DataForSEO...`
        );

        const keywords = payload.data.map((item) => item.keyword);
        console.log(
          `📊 Tool: Fetching DataForSEO data for ${keywords.length} keywords...`
        );

        const keywordMetrics = await fetchKeywordDataFromDataForSEO(keywords);

        enrichedData = payload.data.map((item) => {
          const metrics = keywordMetrics.get(item.keyword);

          const searchVolume =
            metrics?.searchVolume?.toString() ||
            metrics?.monthlySearches?.toString() ||
            item.keywordSearchVolume;

          const difficulty = metrics?.competition
            ? Math.round(metrics.competition * 100).toString()
            : item.keywordDiffculty;

          return {
            ...item,
            keywordDiffculty: difficulty,
            keywordSearchVolume: searchVolume,
            keywordCpc: metrics?.cpc ?? null,
            keywordCompetition: metrics?.competition ?? null,
            keywordTrend: metrics?.trend ? JSON.stringify(metrics.trend) : null,
            keywordMonthlySearches: metrics?.monthlySearches ?? null,
            keywordClicks: metrics?.clicks ?? null,
            keywordImpressions: metrics?.impressions ?? null,
            keywordCTR: metrics?.ctr ?? null,
            keywordLowTopOfPageBid: metrics?.lowTopOfPageBid ?? null,
            keywordHighTopOfPageBid: metrics?.highTopOfPageBid ?? null,
            keywordDataUpdatedAt: metrics ? new Date().toISOString() : null,
          } as KeywordItem;
        });

        console.log(
          "✅ Tool: Enriched with DataForSEO data. Saving to database..."
        );
      }

      const targetBusinessId = payload.businessId ?? enrichedData[0]?.businessId ?? null;
      if (!targetBusinessId) {
        return "Error: businessId is required";
      }

      const result = await savePlanKeywords(
        enrichedData.map((item) => ({
          keyword: item.keyword,
          publishDate: item.publishDate,
          publishTime: item.publishTime,
          keywordDiffculty: item.keywordDiffculty,
          keywordSearchVolume: item.keywordSearchVolume,
          userId: item.userId ?? "",
          businessId: item.businessId ?? targetBusinessId,
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
          keywordLowTopOfPageBid: item.keywordLowTopOfPageBid ?? null,
          keywordHighTopOfPageBid: item.keywordHighTopOfPageBid ?? null,
          keywordDataUpdatedAt: item.keywordDataUpdatedAt ?? null,
        })),
      );

      const message = `Saved ${result.count} keywords, skipped ${result.skipped} duplicates`;
      console.log(`✅ Tool: ${message}`);
      return message;
    } catch (error: unknown) {
      const err = error as Error;
      const errorMessage = `Tool execution failed: ${err.message}`;
      console.error(errorMessage);
      return errorMessage;
    }
  },
  {
    name: "save-keyword-info",
    description:
      "This is the final tool to be used. It takes the complete, structured keyword data JSON and saves it to the database. If keywords already have DataForSEO metrics (from DataForSEO-first flow), they are saved directly. Otherwise, it fetches real-time keyword metrics from DataForSEO API before saving.",
    schema: KEYWORD_DATA_FOR_DB,
  }
);
