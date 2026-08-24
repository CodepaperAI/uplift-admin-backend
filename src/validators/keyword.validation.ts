import z from "zod";

export const KEYWORD_ALL = z.object({
  businessId: z.string(),
  userId: z.string().optional(),
});

export const KEYWORD_DATA_FOR_DB = z.object({
  businessId: z.string().optional(),
  data: z.array(
    z.object({
      keyword: z.string(),
      publishDate: z.string(),
      publishTime: z.string(),
      keywordDiffculty: z.string(),
      keywordSearchVolume: z.string(),
      userId: z.string().optional(),
      businessId: z.string().nullable().optional(),
      keywordCategory: z.string().optional(),
      keywordIntent: z.string().optional(),
      keywordSource: z.string().optional(),
      difficultyBucket: z.string().optional(),
      selectionMetadata: z.unknown().nullable().optional(),
      // 🆕 NEW: DataForSEO fields (optional)
      keywordCpc: z.number().nullable().optional(),
      keywordCompetition: z.number().nullable().optional(),
      keywordTrend: z.string().nullable().optional(), // JSON string
      keywordMonthlySearches: z.number().nullable().optional(),
      keywordClicks: z.number().nullable().optional(),
      keywordImpressions: z.number().nullable().optional(),
      keywordCTR: z.number().nullable().optional(),
      keywordLowTopOfPageBid: z.number().nullable().optional(),
      keywordHighTopOfPageBid: z.number().nullable().optional(),
      keywordDataUpdatedAt: z.string().nullable().optional(), // ISO string
    })
  ),
});

export const GET_KEYWORD = z.object({
  userId: z.string().optional(),
  businessId: z.string().optional(),
});

export const GET_KEYWORD_STRICT = z.object({
  userId: z.string().optional(),
  businessId: z.string(),
});

export const GET_KEYWORDS_BODY = z.object({
  businessId: z.string().uuid().optional(),
}).strict();

export const GENERATE_KEYWORD_VALIDATION = z.object({
  userId: z.string().optional(),
  businessId: z.string(),
});

export const DELETE_KEYWORD = z.object({
  id: z.string().optional(),
  keywordId: z.string().optional(),
}).refine((v) => v.id != null || v.keywordId != null, { message: "id or keywordId required" }).transform((v) => ({ id: v.id ?? v.keywordId! }));

export const GENERATE_MISSING_KEYWORD = z.object({
  userId: z.string().optional(),
  businessId: z.string().optional(),
});

export const ADD_KEYWORD_INSTRUCTIONS = z.object({
  keywordId: z.string(),
  keywordInstruction: z.string(),
});

export const SEARCH_KEYWORDS = z.object({
  seedKeyword: z.string().min(1, "Seed keyword is required"),
  businessId: z.string().optional(),
  locationCode: z.coerce.number().optional(),
  languageCode: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const GENERATE_SINGLE_MISSING_KEYWORD = z.object({
  userId: z.string().optional(),
  businessId: z.string().optional(),
  publishDate: z.string(),
  publishTime: z.string(),
  instructions: z.string().min(1, "Instructions are required"),
});
