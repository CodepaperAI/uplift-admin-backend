import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import { ExternalBacklinksService } from "../services/external-backlinks.service";
import { getBacklinkServiceEligibilityForBusiness } from "../utils/backlink-access.utils";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";

const backlinksService = new ExternalBacklinksService();

const BUSINESS_QUERY_FIELDS = {
  userId: z.string().optional(),
  businessId: z.string().uuid().optional(),
};

const BACKLINK_SETTINGS_QUERY = z.object(BUSINESS_QUERY_FIELDS).strict();

const BACKLINK_FILTERS = z.object({
  status: z.enum(["active", "lost", "new", "reviewed"]).optional(),
  linkType: z.enum(["dofollow", "nofollow", "sponsored", "ugc"]).optional(),
  minDomainAuthority: z.number().finite().min(0).max(100).optional(),
  maxSpamScore: z.number().finite().min(0).max(100).optional(),
  sourceDomain: z.string().trim().min(1).max(253).optional(),
  anchorText: z.string().trim().min(1).max(500).optional(),
}).strict();

const BACKLINK_PAGINATION = z.object({
  page: z.number().int().min(1).max(100_000).default(1),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

function boundedJsonQuery<T extends z.ZodTypeAny>(
  schema: T,
  maxLength: number,
) {
  return z.string().max(maxLength).transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "Invalid JSON" });
      return z.NEVER;
    }
  }).pipe(schema);
}

const BACKLINKS_QUERY = z.object({
  ...BUSINESS_QUERY_FIELDS,
  filters: boundedJsonQuery(BACKLINK_FILTERS, 2_048).optional(),
  pagination: boundedJsonQuery(BACKLINK_PAGINATION, 256)
    .default({ page: 1, limit: 20 }),
  sortBy: z.enum(["domainAuthority", "pageAuthority", "firstSeen", "lastSeen"])
    .default("lastSeen"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
}).strict();

const BACKLINK_LIST_QUERY = z.object({
  ...BUSINESS_QUERY_FIELDS,
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const BACKLINK_SYNC_BODY = z.object({
  userId: z.string().optional(),
  businessId: z.string().uuid().optional(),
}).strict();

const BACKLINK_SETTINGS_BODY = z.object({
  userId: z.string().optional(),
  enabled: z.boolean(),
}).strict();

async function findOwnedActiveBusiness(userId: string, businessId?: string) {
  return prisma.business.findFirst({
    where: businessId
      ? { id: businessId, userId, isActive: true }
      : { userId, isPrimary: true, isActive: true },
  });
}

async function loadBacklinkSettings(userId: string, businessId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      backlinkEnabled: true,
      business: {
        where: businessId ? { id: businessId, isActive: true } : { isActive: true },
        select: {
          isActive: true,
          websiteSubscription: {
            select: { status: true, trialStatus: true },
          },
        },
      },
    },
  });
  if (!user) return null;
  const canUseBacklinkService = user.business.some(({ isActive, websiteSubscription }) =>
    isActive &&
    websiteSubscription?.status === "active" &&
    !["trialing", "expired"].includes(websiteSubscription.trialStatus),
  );
  return {
    backlinkEnabled: user.backlinkEnabled,
    canUseBacklinkService,
    unavailableReason: canUseBacklinkService
      ? null
      : "Backlink analysis is available with an active subscription.",
  };
}

export async function getBacklinkSettings(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const query = BACKLINK_SETTINGS_QUERY.parse(req.query);
    if (query.businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: query.businessId, userId, isActive: true },
        select: { id: true },
      });
      if (!owned) return sendError(res, "Business not found", 404);
    }
    const settings = await loadBacklinkSettings(userId, query.businessId);
    if (!settings) return sendError(res, "User not found", 404);
    return sendSuccess(res, { settings });
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function updateBacklinkEnabled(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const query = BACKLINK_SETTINGS_QUERY.parse(req.query);
    const body = BACKLINK_SETTINGS_BODY.parse(req.body);
    if (query.businessId) {
      const owned = await prisma.business.findFirst({
        where: { id: query.businessId, userId, isActive: true },
        select: { id: true },
      });
      if (!owned) return sendError(res, "Business not found", 404);
    }
    const settings = await loadBacklinkSettings(userId, query.businessId);
    if (!settings?.canUseBacklinkService) {
      return sendError(res, settings?.unavailableReason ?? "Feature unavailable", 403);
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { backlinkEnabled: body.enabled },
      select: { backlinkEnabled: true },
    });
    return sendSuccess(res, { backlinkEnabled: user.backlinkEnabled });
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    return sendError(res, "Request could not be completed", 500);
  }
}

/**
 * GET /api/v1/external-backlinks/:userId/summary
 * Get backlink summary for user's business
 */
export async function getBacklinkSummary(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const query = BACKLINK_SETTINGS_QUERY.parse(req.query);
    const business = await findOwnedActiveBusiness(userId, query.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // Get or create summary
    let summary = await prisma.externalBacklinkSummary.findUnique({
      where: { businessId: business.id },
    });

    if (!summary) {
      // Create empty summary
      summary = await prisma.externalBacklinkSummary.create({
        data: {
          businessId: business.id,
        },
      });
    }

    return sendSuccess(res, { summary }, "Backlink summary retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to retrieve backlink summary", 500, error);
  }
}

/**
 * GET /api/v1/external-backlinks/:userId/backlinks
 * Get all backlinks with filters
 */
export async function getBacklinks(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const query = BACKLINKS_QUERY.parse(req.query);
    const business = await findOwnedActiveBusiness(userId, query.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const filters = query.filters;
    const pagination = query.pagination;
    const sortBy = query.sortBy;
    const sortOrder = query.sortOrder;

    // Build where clause
    // Note: ExternalBacklink.businessId is not nullable, so we only filter by businessId
    // Legacy external backlinks would have been created with a businessId, so we just filter by the target business
    const where: Prisma.ExternalBacklinkWhereInput = {
      businessId: business.id,
    };

    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.linkType) {
      where.linkType = filters.linkType;
    }
    if (filters?.minDomainAuthority !== undefined) {
      where.domainAuthority = {
        gte: filters.minDomainAuthority,
      };
    }
    if (filters?.maxSpamScore !== undefined) {
      where.spamScore = {
        lte: filters.maxSpamScore,
      };
    }
    if (filters?.sourceDomain) {
      where.sourceDomain = {
        contains: filters.sourceDomain,
        mode: "insensitive",
      };
    }
    if (filters?.anchorText) {
      where.anchorText = {
        contains: filters.anchorText,
        mode: "insensitive",
      };
    }

    // Build orderBy
    const orderBy: Prisma.ExternalBacklinkOrderByWithRelationInput = {};
    if (sortBy === "domainAuthority") {
      orderBy.domainAuthority = sortOrder;
    } else if (sortBy === "pageAuthority") {
      orderBy.pageAuthority = sortOrder;
    } else if (sortBy === "firstSeen") {
      orderBy.firstSeen = sortOrder;
    } else {
      orderBy.lastSeen = sortOrder;
    }

    // Get total count
    const totalCount = await prisma.externalBacklink.count({ where });

    // Get paginated results
    const skip = (pagination.page - 1) * pagination.limit;
    const backlinks = await prisma.externalBacklink.findMany({
      where,
      orderBy,
      skip,
      take: pagination.limit,
    });

    return sendSuccess(
      res,
      {
        backlinks,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / pagination.limit),
        },
      },
      "Backlinks retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to retrieve backlinks", 500, error);
  }
}

/**
 * GET /api/v1/external-backlinks/:userId/referring-domains
 * Get referring domains
 */
export async function getReferringDomains(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const query = BACKLINK_LIST_QUERY.parse(req.query);
    const business = await findOwnedActiveBusiness(userId, query.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const domains = await prisma.externalReferringDomain.findMany({
      where: { businessId: business.id },
      orderBy: { totalBacklinks: "desc" },
      take: query.limit,
    });

    return sendSuccess(
      res,
      { domains },
      "Referring domains retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to retrieve referring domains", 500, error);
  }
}

/**
 * GET /api/v1/external-backlinks/:userId/anchors
 * Get anchor text distribution
 */
export async function getAnchorTexts(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const query = BACKLINK_LIST_QUERY.parse(req.query);
    const business = await findOwnedActiveBusiness(userId, query.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const anchors = await prisma.externalBacklinkAnchor.findMany({
      where: { businessId: business.id },
      orderBy: { occurrenceCount: "desc" },
      take: query.limit,
    });

    return sendSuccess(
      res,
      { anchors },
      "Anchor texts retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to retrieve anchor texts", 500, error);
  }
}

/**
 * POST /api/v1/external-backlinks/:userId/sync
 * Trigger manual sync
 */
export async function syncBacklinks(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = BACKLINK_SYNC_BODY.parse(req.body);
    const business = await findOwnedActiveBusiness(userId, body.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const eligibility = await getBacklinkServiceEligibilityForBusiness(
      business.id,
    );
    if (!eligibility.eligible) {
      return sendError(
        res,
        eligibility.message || "Backlink analysis is not available.",
        eligibility.reason === "disabled" ? 400 : 403,
        { code: eligibility.reason },
      );
    }

    // Trigger Inngest event for async sync
    await inngest.send({
      name: "backlinks/manual-sync",
      data: {
        businessId: business.id,
        // The stored, owned business URL is the only accepted sync target.
        // A caller must not be able to spend provider credits on arbitrary hosts.
        targetDomain: business.businessWebsiteUrl,
      },
    });

    return sendSuccess(
      res,
      { message: "Backlink sync started" },
      "Backlink sync initiated successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to sync backlinks", 500, error);
  }
}

/**
 * GET /api/v1/external-backlinks/:userId/stats
 * Get comprehensive statistics
 */
export async function getBacklinkStats(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    const query = BACKLINK_SETTINGS_QUERY.parse(req.query);
    const business = await findOwnedActiveBusiness(userId, query.businessId);

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // Get summary
    const summary = await prisma.externalBacklinkSummary.findUnique({
      where: { businessId: business.id },
    });

    // Get counts by status
    const [activeCount, lostCount, newCount, reviewedCount] =
      await Promise.all([
        prisma.externalBacklink.count({
          where: { businessId: business.id, status: "active" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, status: "lost" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, status: "new" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, status: "reviewed" },
        }),
      ]);

    // Get counts by link type
    const [dofollowCount, nofollowCount, sponsoredCount, ugcCount] =
      await Promise.all([
        prisma.externalBacklink.count({
          where: { businessId: business.id, linkType: "dofollow" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, linkType: "nofollow" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, linkType: "sponsored" },
        }),
        prisma.externalBacklink.count({
          where: { businessId: business.id, linkType: "ugc" },
        }),
      ]);

    const stats = {
      summary: summary || {
        totalBacklinks: 0,
        totalReferringDomains: 0,
        averageDomainAuthority: null,
        averagePageAuthority: null,
        growthRate: null,
      },
      statusCounts: {
        active: activeCount,
        lost: lostCount,
        new: newCount,
        reviewed: reviewedCount,
      },
      linkTypeCounts: {
        dofollow: dofollowCount,
        nofollow: nofollowCount,
        sponsored: sponsoredCount,
        ugc: ugcCount,
      },
    };

    return sendSuccess(res, { stats }, "Statistics retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to retrieve statistics", 500, error);
  }
}
