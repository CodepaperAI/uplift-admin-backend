import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { prisma } from "../config/db.config";
import { PublisherDiscoveryService } from "../services/publisher-discovery.service";
import { handleValidationError, sendError, sendSuccess } from "../utils/response.utils";
import { getDatabaseUserId } from "../utils/user.utils";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";

const discoveryService = new PublisherDiscoveryService();

function authenticatedUserId(req: Request): string {
  return (req as AuthenticatedRequest).authUserId!;
}

// Validation schemas
const DISCOVER_PUBLISHERS_SCHEMA = z.object({
  userId: z.string(),
  sources: z.array(z.enum(["reddit", "medium", "competitors"])).min(1),
  keywords: z.array(z.string().trim().min(1).max(USER_INPUT_LIMITS.keyword)).min(1).max(25),
  niche: z.string().trim().max(USER_INPUT_LIMITS.locationName).optional(),
  competitorDomains: z.array(z.string().trim().max(USER_INPUT_LIMITS.url)).max(25).optional(),
  filters: z
    .object({
      minDomainAuthority: z.number().min(0).max(100).optional(),
      maxDomainAuthority: z.number().min(0).max(100).optional(),
      minAIConfidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
  limit: z.number().min(1).max(100).default(20).optional(),
});

const BULK_CREATE_PUBLISHERS_SCHEMA = z.object({
  userId: z.string(),
  publishers: z.array(
    z.object({
      websiteUrl: z.string().trim().max(USER_INPUT_LIMITS.url).url(),
      name: z.string().trim().max(USER_INPUT_LIMITS.businessName),
      domain: z.string().trim().max(255),
      niche: z.string().trim().max(USER_INPUT_LIMITS.locationName).optional(),
      contactEmail: z.string().trim().max(320).email().optional(),
      contactName: z.string().trim().max(USER_INPUT_LIMITS.locationName).optional(),
      submissionGuidelines: z.string().trim().max(USER_INPUT_LIMITS.genericTextarea).optional(),
      domainAuthority: z.number().optional(),
      domainRank: z.number().optional(),
      source: z.string().trim().max(160),
      discoveryMetadata: z.any().optional(),
      aiConfidenceScore: z.number().min(0).max(1).optional(),
      aiExtractedGuidelines: z.string().trim().max(USER_INPUT_LIMITS.genericTextarea).optional(),
    })
  ).max(100),
});

const ANALYZE_PUBLISHER_SCHEMA = z.object({
  userId: z.string(),
  url: z.string().trim().max(USER_INPUT_LIMITS.url).url(),
});

/**
 * Discover publishers from multiple sources
 */
export async function discoverPublishers(req: Request, res: Response) {
  try {
    const body = DISCOVER_PUBLISHERS_SCHEMA.parse({
      ...req.body,
      userId: authenticatedUserId(req),
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    let competitorDomains = body.competitorDomains;

    if (
      body.sources.includes("competitors") &&
      (!competitorDomains || competitorDomains.length === 0)
    ) {
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: databaseUserId,
          isActive: true,
          isPrimary: true,
        },
        select: {
          competitiors: {
            select: {
              url: true,
            },
          },
        },
      });

      const fallbackBusiness =
        primaryBusiness ??
        (await prisma.business.findFirst({
          where: {
            userId: databaseUserId,
            isActive: true,
          },
          select: {
            competitiors: {
              select: {
                url: true,
              },
            },
          },
        }));

      competitorDomains = fallbackBusiness?.competitiors
        .map((competitor) => competitor.url)
        .filter((url): url is string => Boolean(url && url.trim().length > 0));
    }

    const discoveryResult = await discoveryService.discoverPublishers(
      body.sources,
      body.keywords,
      body.niche,
      body.filters,
      body.limit || 20,
      competitorDomains
    );

    return sendSuccess(res, discoveryResult, "Publishers discovered successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error discovering publishers:", error);
    return sendError(res, error.message || "Failed to discover publishers", 500);
  }
}

/**
 * Discover publishers from Reddit
 */
export async function discoverFromReddit(req: Request, res: Response) {
  try {
    const body = z
      .object({
        userId: z.string(),
        keywords: z.array(z.string()).min(1),
        niche: z.string().optional(),
        limit: z.number().min(1).max(100).default(20).optional(),
      })
      .parse({
        ...req.body,
        userId: authenticatedUserId(req),
      });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publishers = await discoveryService.discoverFromReddit(
      body.keywords,
      body.niche,
      body.limit || 20
    );

    return sendSuccess(res, publishers, "Publishers discovered from Reddit successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error discovering from Reddit:", error);
    return sendError(res, error.message || "Failed to discover from Reddit", 500);
  }
}

/**
 * Discover publishers from Medium
 */
export async function discoverFromMedium(req: Request, res: Response) {
  try {
    const body = z
      .object({
        userId: z.string(),
        keywords: z.array(z.string()).min(1),
        niche: z.string().optional(),
        limit: z.number().min(1).max(100).default(20).optional(),
      })
      .parse({
        ...req.body,
        userId: authenticatedUserId(req),
      });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publishers = await discoveryService.discoverFromMedium(
      body.keywords,
      body.niche,
      body.limit || 20
    );

    return sendSuccess(res, publishers, "Publishers discovered from Medium successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error discovering from Medium:", error);
    return sendError(res, error.message || "Failed to discover from Medium", 500);
  }
}

/**
 * Discover publishers from competitors
 */
export async function discoverFromCompetitors(req: Request, res: Response) {
  try {
    const body = z
      .object({
        userId: z.string(),
        competitorDomains: z.array(z.string()).min(1),
        limit: z.number().min(1).max(100).default(20).optional(),
      })
      .parse({
        ...req.body,
        userId: authenticatedUserId(req),
      });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publishers = await discoveryService.discoverFromCompetitors(
      body.competitorDomains,
      databaseUserId,
      body.limit || 20
    );

    return sendSuccess(
      res,
      publishers,
      "Publishers discovered from competitors successfully"
    );
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error discovering from competitors:", error);
    return sendError(res, error.message || "Failed to discover from competitors", 500);
  }
}

/**
 * Analyze a single publisher URL with AI
 */
export async function analyzePublisherUrl(req: Request, res: Response) {
  try {
    const body = ANALYZE_PUBLISHER_SCHEMA.parse({
      ...req.body,
      userId: authenticatedUserId(req),
      url: req.body.url || req.query.url,
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publisher = await discoveryService.analyzePublisherUrl(body.url);

    if (!publisher) {
      return sendError(
        res,
        "Publisher does not appear to accept guest posts or analysis failed",
        404
      );
    }

    return sendSuccess(res, publisher, "Publisher analyzed successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error analyzing publisher URL:", error);
    return sendError(res, error.message || "Failed to analyze publisher", 500);
  }
}

/**
 * Bulk create discovered publishers
 */
export async function bulkCreatePublishers(req: Request, res: Response) {
  try {
    const body = BULK_CREATE_PUBLISHERS_SCHEMA.parse({
      ...req.body,
      userId: authenticatedUserId(req),
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const result = await discoveryService.bulkCreatePublishers(
      databaseUserId,
      body.publishers
    );

    return sendSuccess(res, result, "Publishers created successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error bulk creating publishers:", error);
    return sendError(res, error.message || "Failed to bulk create publishers", 500);
  }
}
