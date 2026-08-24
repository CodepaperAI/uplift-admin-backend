import type { Request, Response } from "express";
import { ZodError } from "zod";
import { prisma } from "../config/db.config";
import { savePlanKeywords } from "../utils/plan-keyword-save.utils";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { inngest } from "../inngest/client";
import {
  generateMissingKeywordLLM,
  generateSingleMissingKeywordLLM,
} from "../llm/keywords/generate-missing-keywords";
import { KeywordTrackingService } from "../services/keyword-tracking.service";
import { getKeywordSuggestionsWithMetrics } from "../utils/dataforseo.utils";
import {
  handleValidationError,
  sendError,
  sendLegacySuccess,
  sendSuccess,
} from "../utils/response.utils";
import {
  ADD_KEYWORD_INSTRUCTIONS,
  DELETE_KEYWORD,
  GENERATE_KEYWORD_VALIDATION,
  GENERATE_MISSING_KEYWORD,
  GENERATE_SINGLE_MISSING_KEYWORD,
  GET_KEYWORD,
  GET_KEYWORDS_BODY,
  GET_KEYWORD_STRICT,
  KEYWORD_ALL,
  KEYWORD_DATA_FOR_DB,
  SEARCH_KEYWORDS,
} from "../validators/keyword.validation";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "../utils/tenant-response-cache";
import { canViewHistoricalDashboardData } from "../utils/website-workspace-access.utils";

async function invalidateKeywordReadModels(
  userId: string,
  businessIds: Array<string | null | undefined>,
) {
  const resolved = new Set(
    businessIds.filter((value): value is string => Boolean(value)),
  );
  if (resolved.size === 0) {
    const primary = await prisma.business.findFirst({
      where: { userId, isPrimary: true },
      select: { id: true },
    });
    if (primary) resolved.add(primary.id);
  }
  await Promise.all([
    invalidateTenantCache(userId),
    ...Array.from(resolved).map((businessId) =>
      invalidateTenantCache(userId, businessId),
    ),
  ]);
}

export async function keywordGenerator(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = KEYWORD_ALL.parse(body);

    const businessInfo = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: authUserId,
      },
      include: {
        competitiors: true,
        competitiveAdvantage: true,
        keywords: true,
        currentRanking: true,
      },
    });

    if (!businessInfo) {
      return sendError(res, "Business not found or unauthorized", 404);
    }

    return sendLegacySuccess(
      res,
      { businessInfo },
      "Business information retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(
      res,
      "Failed to retrieve business information",
      500,
      error
    );
  }
}

export async function uploadKeywordPlan(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = KEYWORD_DATA_FOR_DB.parse(body);

    const firstKeywordBusinessId = payload.data[0]?.businessId;
    const targetBusinessId = payload.businessId ?? firstKeywordBusinessId ?? null;

    if (!targetBusinessId) {
      return sendError(res, "businessId is required (provide in body or in each keyword item)", 400);
    }

    const business = await prisma.business.findUnique({
      where: { id: targetBusinessId },
      select: { id: true, userId: true },
    });
    if (!business || business.userId !== authUserId) {
      return sendError(res, "Business not found or does not belong to user", 404);
    }

    for (const item of payload.data) {
      const itemBusinessId: string = item.businessId ?? targetBusinessId;
      if (itemBusinessId !== targetBusinessId) {
        return sendError(res, "All keyword rows must belong to the same business", 400);
      }
    }

    const keywordsToCreate = payload.data.map((item) => ({
      keyword: item.keyword,
      publishDate: item.publishDate,
      publishTime: item.publishTime,
      keywordDiffculty: item.keywordDiffculty,
      keywordSearchVolume: item.keywordSearchVolume,
      userId: authUserId,
      businessId: item.businessId ?? targetBusinessId,
      keywordCategory: item.keywordCategory || null,
      keywordIntent: item.keywordIntent || null,
      keywordSource: item.keywordSource || null,
      difficultyBucket: item.difficultyBucket || null,
      selectionMetadata:
        item.selectionMetadata === undefined || item.selectionMetadata === null
          ? null
          : typeof item.selectionMetadata === "string"
            ? (JSON.parse(item.selectionMetadata) as any)
            : (item.selectionMetadata as any),
      // 🆕 NEW: DataForSEO fields
      keywordCpc: item.keywordCpc ?? null,
      keywordCompetition: item.keywordCompetition ?? null,
      keywordTrend: item.keywordTrend
        ? (JSON.parse(item.keywordTrend) as any)
        : null,
      keywordMonthlySearches: item.keywordMonthlySearches ?? null,
      keywordClicks: item.keywordClicks ?? null,
      keywordImpressions: item.keywordImpressions ?? null,
      keywordCTR: item.keywordCTR ?? null,
      keywordLowTopOfPageBid: item.keywordLowTopOfPageBid ?? null,
      keywordHighTopOfPageBid: item.keywordHighTopOfPageBid ?? null,
      keywordDataUpdatedAt: item.keywordDataUpdatedAt
        ? new Date(item.keywordDataUpdatedAt)
        : null,
    }));

    if (keywordsToCreate.length === 0) {
      console.error("❌ No keywords to create - empty payload");
      return sendError(res, "No keywords provided", 400);
    }

    console.log(
      `💾 Attempting to save ${keywordsToCreate.length} keywords to database`
    );

    const result = await savePlanKeywords(keywordsToCreate);
    await invalidateKeywordReadModels(authUserId, [targetBusinessId]);

    console.log(
      `✅ Saved ${result.count} keywords, skipped ${result.skipped} duplicates`
    );

    if (result.skippedDetails.length > 0) {
      console.warn("⚠️ Skipped keywords due to duplicate dates:");
      result.skippedDetails.forEach((skipped) => {
        console.warn(
          `   - "${skipped.keyword}" on ${skipped.date}: ${skipped.reason}`
        );
      });
    }

    const message =
      result.skipped > 0
        ? `Saved ${result.count} keywords successfully. ${result.skipped} keywords were skipped due to duplicate dates.`
        : `Saved ${result.count} keywords successfully with DataForSEO data!`;

    return sendSuccess(
      res,
      {
        count: result.count,
        skipped: result.skipped || 0,
        message: message,
      },
      message,
      201
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error uploading keyword plan:", error);
    return sendError(res, "Failed to upload keyword plan", 500, error);
  }
}

export async function getKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORDS_BODY.parse(body);

    const requestedBusiness = payload.businessId
      ? await prisma.business.findFirst({
          where: { id: payload.businessId, userId: authUserId },
          select: {
            id: true,
            isPrimary: true,
            isActive: true,
            websiteStatus: true,
            onboardingFlow: true,
            onboardingStatus: true,
            removalStatus: true,
            websiteSubscription: { select: { status: true } },
            keywords: { select: { keyword: true, keywordType: true } },
          },
        })
      : null;
    const business = payload.businessId
      ? requestedBusiness && canViewHistoricalDashboardData(requestedBusiness)
        ? requestedBusiness
        : null
      : await prisma.business.findFirst({
          where: { userId: authUserId, isPrimary: true, isActive: true },
          select: {
            id: true,
            isPrimary: true,
            keywords: { select: { keyword: true, keywordType: true } },
          },
        });
    if (!business) {
      return sendLegacySuccess(res, { keywords: [] }, "Keywords retrieved successfully");
    }

    const cached = await readTenantCache<unknown[]>({
      namespace: "content-keywords",
      userId: authUserId,
      businessId: business.id,
    });
    if (cached) {
      return sendLegacySuccess(res, { keywords: cached }, "Keywords retrieved successfully");
    }

    const keywords = await prisma.plan.findMany({
      where: {
        userId: authUserId,
        deletedAt: null,
        ...(business.isPrimary
          ? { OR: [{ businessId: business.id }, { businessId: null }] }
          : { businessId: business.id }),
      },
      include: {
        blog: {
          select: { slug: true },
        },
      },
      orderBy: { publishDate: "asc" },
    });

    const keywordTypeByKeyword = new Map(
      business.keywords.map((item) => [
        item.keyword.trim().toLowerCase(),
        item.keywordType,
      ])
    );

    const keywordsWithSlug = keywords.map((kw) => ({
      ...kw,
      keywordType: keywordTypeByKeyword.get(kw.keyword.trim().toLowerCase()) ?? null,
      blogSlug: kw.blog?.slug ?? null,
      blog: undefined,
    }));
    await writeTenantCache({
      namespace: "content-keywords",
      userId: authUserId,
      businessId: business.id,
      value: keywordsWithSlug,
      ttlSeconds: 15 * 60,
    });

    return sendLegacySuccess(
      res,
      { keywords: keywordsWithSlug },
      "Keywords retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error retrieving keywords:", error);
    return sendError(res, "Failed to retrieve keywords", 500, error);
  }
}

export async function generateNewKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GENERATE_KEYWORD_VALIDATION.parse(body);

    const targetBusinessId = payload.businessId;
    if (!targetBusinessId) {
      return sendError(res, "businessId is required", 400);
    }

    const business = await prisma.business.findUnique({
      where: { id: targetBusinessId },
      select: { id: true, userId: true, isActive: true },
    });

    if (!business || business.userId !== authUserId) {
      return sendError(res, "Business not found or unauthorized", 404);
    }

    if (!business.isActive) {
      return sendError(res, "Business is not active", 400);
    }

    const currentBusiness = await prisma.business.findUnique({
      where: { id: targetBusinessId },
      select: { keywordGenerationStatus: true },
    });

    if (
      currentBusiness?.keywordGenerationStatus === "processing" ||
      currentBusiness?.keywordGenerationStatus === "pending"
    ) {
      return sendSuccess(
        res,
        {
          status: "already_processing",
          currentStatus: currentBusiness.keywordGenerationStatus,
          businessId: targetBusinessId,
        },
        `Keyword generation is already ${currentBusiness.keywordGenerationStatus} for this website`
      );
    }

    await prisma.business.update({
      where: { id: targetBusinessId },
      data: {
        keywordGenerationStatus: "pending",
        keywordGenerationStartedAt: null,
        keywordGenerationCompletedAt: null,
      },
    });

    let eventIds: string[] = [];
    try {
      const enqueueResult = await inngest.send({
        name: "keywords/generate",
        data: {
          userId: authUserId,
          businessId: targetBusinessId,
        },
      });
      eventIds = enqueueResult.ids ?? [];

      if (eventIds.length === 0) {
        throw new Error("Inngest accepted no keyword generation event");
      }
    } catch (enqueueError) {
      // Do not leave the business permanently queued when Inngest is
      // unavailable. A failed status lets the user retry immediately and
      // communicates the real outcome to the calendar status query.
      await prisma.business
        .updateMany({
          where: {
            id: targetBusinessId,
            keywordGenerationStatus: "pending",
          },
          data: {
            keywordGenerationStatus: "failed",
            keywordGenerationCompletedAt: new Date(),
          },
        })
        .catch((rollbackError) => {
          console.error(
            "Failed to roll back keyword generation status after enqueue failure:",
            rollbackError,
          );
        });
      await invalidateKeywordReadModels(authUserId, [targetBusinessId]);
      throw enqueueError;
    }
    await invalidateKeywordReadModels(authUserId, [targetBusinessId]);

    return sendSuccess(
      res,
      {
        status: "processing",
        businessId: targetBusinessId,
        eventIds,
      },
      "Keyword generation started in background"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error starting keyword generation:", error);
    return sendError(res, "Failed to start keyword generation", 500, error);
  }
}

export async function deleteKeyword(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = DELETE_KEYWORD.parse(body);

    const keyword = await prisma.plan.findUnique({
      where: { id: payload.id },
      include: {
        blog: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    if (!keyword) {
      return sendError(res, "Keyword not found", 404);
    }
    if (keyword.userId !== authUserId) {
      return sendError(res, "Keyword not found or access denied", 404);
    }

    if (keyword.deletedAt) {
      return sendError(res, "Keyword is already deleted", 400);
    }

    try {
      const deletedKeyword = await prisma.plan.update({
        where: {
          id: payload.id,
        },
        data: {
          deletedAt: new Date(),
        },
        include: {
          blog: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });

      const message = deletedKeyword.blogId
        ? "Keyword deleted successfully. The associated blog remains available."
        : "Keyword deleted successfully";

      await invalidateKeywordReadModels(authUserId, [
        deletedKeyword.businessId,
      ]);

      return sendLegacySuccess(
        res,
        {
          deletedKeyword,
          hasBlog: !!deletedKeyword.blogId,
          blogId: deletedKeyword.blogId,
        },
        message
      );
    } catch (updateError: any) {
      if (updateError?.code === "P2025") {
        return sendError(res, "Keyword not found or already deleted", 404);
      }
      throw updateError;
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error deleting keyword:", error);
    return sendError(res, "Failed to delete keyword", 500, error);
  }
}

export async function getDeletedKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD_STRICT.parse(body);

    const business = await prisma.business.findFirst({
      where: { id: payload.businessId, userId: authUserId },
      select: {
        id: true,
        isActive: true,
        websiteStatus: true,
        onboardingFlow: true,
        onboardingStatus: true,
        removalStatus: true,
        websiteSubscription: { select: { status: true } },
      },
    });
    if (!business || !canViewHistoricalDashboardData(business)) {
      return sendError(res, "Business not found or unauthorized", 404);
    }

    const keywords = await prisma.plan.findMany({
      where: {
        userId: authUserId,
        businessId: payload.businessId,
        deletedAt: { not: null },
      },
      include: {
        blog: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { deletedAt: "desc" },
    });

    return sendLegacySuccess(
      res,
      { keywords },
      "Deleted keywords retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error retrieving deleted keywords:", error);
    return sendError(res, "Failed to retrieve deleted keywords", 500, error);
  }
}

export async function restoreKeyword(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = DELETE_KEYWORD.parse(body);

    const keyword = await prisma.plan.findUnique({
      where: { id: payload.id },
    });

    if (!keyword) {
      return sendError(res, "Keyword not found", 404);
    }
    if (keyword.userId !== authUserId) {
      return sendError(res, "Keyword not found or access denied", 404);
    }

    if (!keyword.deletedAt) {
      return sendError(res, "Keyword is not deleted", 400);
    }

    const restoredKeyword = await prisma.plan.update({
      where: {
        id: payload.id,
      },
      data: {
        deletedAt: null,
      },
    });
    await invalidateKeywordReadModels(authUserId, [
      restoredKeyword.businessId,
    ]);

    return sendLegacySuccess(
      res,
      { restoredKeyword },
      "Keyword restored successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error restoring keyword:", error);
    return sendError(res, "Failed to restore keyword", 500, error);
  }
}

export async function missingKeywordGenerator(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GENERATE_MISSING_KEYWORD.parse(body);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const whereClause: Record<string, unknown> = {
      userId: authUserId,
      deletedAt: {
        not: null,
      },
    };

    if (payload.businessId) {
      whereClause.businessId = payload.businessId;
    } else {
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: authUserId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });

      if (primaryBusiness) {
        whereClause.businessId = primaryBusiness.id;
      }
    }

    const deletedKeywords = await prisma.plan.findMany({
      where: whereClause,
      orderBy: {
        publishDate: "asc",
      },
    });

    if (deletedKeywords.length === 0) {
      return sendLegacySuccess(
        res,
        { result: "No deleted keywords found" },
        "No deleted keywords to replace"
      );
    }

    const futureDeletedKeywords = deletedKeywords.filter((kw) => {
      if (!kw.publishDate) return false;
      const publishDate = new Date(kw.publishDate);
      publishDate.setUTCHours(0, 0, 0, 0);
      return publishDate >= today;
    });

    if (futureDeletedKeywords.length === 0) {
      return sendLegacySuccess(
        res,
        { result: "No deleted keywords with future dates found" },
        "All deleted keywords have past dates. No replacements needed."
      );
    }

    console.log(
      `🔄 Generating ${futureDeletedKeywords.length} replacement keywords for deleted keywords with future dates`
    );

    const response = await generateMissingKeywordLLM(
      JSON.stringify(futureDeletedKeywords),
      authUserId
    );
    await invalidateKeywordReadModels(
      authUserId,
      futureDeletedKeywords.map((keyword) => keyword.businessId),
    );

    return sendLegacySuccess(
      res,
      {
        result: response,
        replacedCount: futureDeletedKeywords.length,
      },
      `Successfully generated ${futureDeletedKeywords.length} replacement keyword(s)`
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error generating missing keywords:", error);
    return sendError(res, "Failed to generate missing keywords", 500, error);
  }
}

export async function addKeywordInstruction(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = ADD_KEYWORD_INSTRUCTIONS.parse(body);

    const existing = await prisma.plan.findUnique({
      where: { id: payload.keywordId },
      select: { userId: true, businessId: true },
    });
    if (!existing || existing.userId !== authUserId) {
      return sendError(res, "Keyword not found or access denied", 404);
    }

    const updatedKeyword = await prisma.plan.update({
      where: { id: payload.keywordId },
      data: {
        keywordInstructions: payload.keywordInstruction,
      },
    });
    await invalidateKeywordReadModels(authUserId, [existing.businessId]);

    return sendLegacySuccess(
      res,
      { result: updatedKeyword },
      "Keyword instruction added successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to add keyword instruction", 500, error);
  }
}

export async function generateSingleMissingKeyword(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GENERATE_SINGLE_MISSING_KEYWORD.parse(body);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const publishDate = new Date(payload.publishDate);
    publishDate.setUTCHours(0, 0, 0, 0);

    if (publishDate < today) {
      return sendError(
        res,
        "Cannot generate replacement keyword for a past date",
        400
      );
    }

    let targetBusinessId: string | undefined = payload.businessId;
    if (!targetBusinessId) {
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: authUserId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
      targetBusinessId = primaryBusiness?.id;
    }

    const deletedKeywordWhere: Record<string, unknown> = {
      userId: authUserId,
      publishDate: payload.publishDate,
      publishTime: payload.publishTime,
      deletedAt: {
        not: null,
      },
    };

    if (targetBusinessId) {
      deletedKeywordWhere.businessId = targetBusinessId;
    }

    const deletedKeyword = await prisma.plan.findFirst({
      where: deletedKeywordWhere,
    });

    if (!deletedKeyword) {
      return sendError(
        res,
        "No deleted keyword found for the specified date and time",
        404
      );
    }

    const existingKeywordWhere: Record<string, unknown> = {
      userId: authUserId,
      publishDate: payload.publishDate,
      publishTime: payload.publishTime,
      deletedAt: null,
    };

    if (targetBusinessId) {
      existingKeywordWhere.businessId = targetBusinessId;
    }

    const existingKeyword = await prisma.plan.findFirst({
      where: existingKeywordWhere,
    });

    if (existingKeyword) {
      return sendError(
        res,
        "A keyword already exists for this date and time",
        400
      );
    }

    console.log(
      `🔄 Generating single replacement keyword for ${payload.publishDate} ${payload.publishTime} with user instructions`
    );

    const response = await generateSingleMissingKeywordLLM(
      JSON.stringify(deletedKeyword),
      payload.publishDate,
      payload.publishTime,
      authUserId,
      payload.instructions
    );
    await invalidateKeywordReadModels(authUserId, [targetBusinessId]);

    return sendLegacySuccess(
      res,
      { result: response },
      "Replacement keyword generated successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error generating single missing keyword:", error);
    return sendError(res, "Failed to generate replacement keyword", 500, error);
  }
}

// New keyword tracking functions

export async function getKeywordAnalytics(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD.parse(body);

    const analytics = await KeywordTrackingService.getKeywordAnalytics(
      authUserId
    );

    return sendSuccess(
      res,
      { analytics },
      "Keyword analytics retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error getting keyword analytics:", error);
    return sendError(res, "Failed to get keyword analytics", 500, error);
  }
}

export async function getUnusedKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD.parse(body);

    const keywords = await KeywordTrackingService.getUnusedKeywords(
      authUserId
    );

    return sendSuccess(
      res,
      { keywords },
      "Unused keywords retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error getting unused keywords:", error);
    return sendError(res, "Failed to get unused keywords", 500, error);
  }
}

export async function getUsedKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD.parse(body);

    const keywords = await KeywordTrackingService.getUsedKeywords(
      authUserId
    );

    return sendSuccess(
      res,
      { keywords },
      "Used keywords retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error getting used keywords:", error);
    return sendError(res, "Failed to get used keywords", 500, error);
  }
}

export async function checkKeywordSimilarity(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const { keyword, threshold = 0.7 } = body;

    if (!keyword || typeof keyword !== "string") {
      return sendError(res, "Keyword is required", 400);
    }

    const isSimilar = await KeywordTrackingService.checkKeywordSimilarity(
      keyword,
      authUserId,
      threshold
    );

    return sendSuccess(
      res,
      { isSimilar, keyword, threshold },
      "Keyword similarity check completed"
    );
  } catch (error) {
    console.error("Error checking keyword similarity:", error);
    return sendError(res, "Failed to check keyword similarity", 500, error);
  }
}

export async function getKeywordGenerationStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD_STRICT.parse(body);

    const business = await prisma.business.findFirst({
      where: { id: payload.businessId, userId: authUserId },
      select: {
        isActive: true,
        keywordGenerationStatus: true,
        keywordGenerationStartedAt: true,
        keywordGenerationCompletedAt: true,
      },
    });

    if (!business) {
      return sendError(res, "Business not found or unauthorized", 404);
    }

    return sendSuccess(
      res,
      {
        overallStatus: business.keywordGenerationStatus,
        startedAt: business.keywordGenerationStartedAt,
        completedAt: business.keywordGenerationCompletedAt,
        businessId: payload.businessId,
        workspaceAvailable: business.isActive,
      },
      "Keyword generation status retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error getting keyword generation status:", error);
    return sendError(
      res,
      "Failed to get keyword generation status",
      500,
      error
    );
  }
}

export async function searchKeywordsWithDataForSEO(
  req: Request,
  res: Response
) {
  try {
    const parsed = SEARCH_KEYWORDS.safeParse(req.body);
    if (!parsed.success) {
      if (parsed.error instanceof ZodError) {
        return handleValidationError(res, parsed.error);
      }
      return sendError(res, "Seed keyword is required", 400);
    }
    const {
      seedKeyword,
      locationCode,
      languageCode = "en",
      limit = 50,
    } = parsed.data;

    const suggestions = await getKeywordSuggestionsWithMetrics(
      [seedKeyword],
      locationCode,
      languageCode,
      limit
    );

    return sendSuccess(
      res,
      { keywords: suggestions },
      "Keywords retrieved successfully"
    );
  } catch (error: any) {
    console.error("Error searching keywords:", error);
    return sendError(
      res,
      error.message || "Failed to search keywords",
      500,
      error
    );
  }
}
