import type { Response } from "express";
import type { Prisma } from "@prisma/client";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { z, ZodError } from "zod";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "../utils/tenant-response-cache";
import { canViewHistoricalDashboardData } from "../utils/website-workspace-access.utils";

const id = z.string().uuid();
const businessTarget = z.object({ businessId: id.optional() }).strict();
const bounded = (max: number) => z.string().trim().max(max);
const optionalBusinessPhone = bounded(USER_INPUT_LIMITS.businessPhone)
  .superRefine((value, context) => {
    if (!value) return;

    const parsed = parsePhoneNumberFromString(value);
    if (!parsed?.isValid()) {
      context.addIssue({
        code: "custom",
        message: "Enter a valid mobile number including its country code",
      });
    }
  })
  .transform((value) => {
    if (!value) return null;
    const parsed = parsePhoneNumberFromString(value);
    return parsed?.isValid() ? parsed.number : value;
  });

const basicInfoSchema = businessTarget.extend({
  businessName: bounded(USER_INPUT_LIMITS.businessName).min(1),
  businessType: bounded(USER_INPUT_LIMITS.businessType).min(1),
  businessDescription: bounded(USER_INPUT_LIMITS.businessDescription),
  businessWebsiteUrl: bounded(USER_INPUT_LIMITS.url).min(1),
  businessPhone: optionalBusinessPhone.optional(),
}).strict();

const keywordCreateSchema = businessTarget.extend({
  keyword: bounded(USER_INPUT_LIMITS.keyword).min(1),
  keywordType: z.enum(["MUST_HAVE", "NICE_TO_HAVE"]),
}).strict();

const keywordMutationSchema = keywordCreateSchema.extend({ keywordId: id }).strict();
const recordDeleteSchema = z.object({ recordId: id, businessId: id.optional() }).strict();

const advantagesSchema = businessTarget.extend({
  advantages: z
    .array(bounded(USER_INPUT_LIMITS.competitiveAdvantage).min(1))
    .max(USER_INPUT_LIMITS.competitiveAdvantages),
}).strict();

const competitorCreateSchema = businessTarget.extend({
  name: bounded(USER_INPUT_LIMITS.competitorName).min(1),
  url: bounded(USER_INPUT_LIMITS.url).min(1),
}).strict();

const competitorMutationSchema = competitorCreateSchema.extend({ competitorId: id }).strict();

const rankingCreateSchema = businessTarget.extend({
  website: bounded(USER_INPUT_LIMITS.url).min(1),
  ranking: bounded(USER_INPUT_LIMITS.genericInput).min(1),
}).strict();

const rankingMutationSchema = rankingCreateSchema.extend({ rankingId: id }).strict();

const localeSchema = businessTarget.extend({
  defaultLocale: bounded(35).min(2),
}).strict();

const blogContentSettingsSchema = businessTarget.extend({
  blogImagesEnabled: z.boolean(),
}).strict();

const SUPPORTED_LOCALES = new Set([
  "en-US", "en-CA", "en-GB", "en-AU", "fr-FR", "fr-CA", "es-ES",
  "es-MX", "es-AR", "de-DE", "zh-CN", "ja-JP", "pt-BR", "pt-PT",
  "it-IT", "ru-RU", "ar-SA", "hi-IN", "nl-NL", "ko-KR",
]);

function requireUserId(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.authUserId) {
    sendError(res, "Unauthorized", 401);
    return null;
  }
  return req.authUserId;
}

async function resolveOwnedBusiness(userId: string, businessId?: string) {
  if (businessId) {
    return prisma.business.findFirst({
      where: { id: businessId, userId, isActive: true },
      select: { id: true },
    });
  }
  return prisma.business.findFirst({
    where: { userId, isPrimary: true, isActive: true },
    select: { id: true },
  });
}

async function resolveOwnedBlogContentSettings(
  userId: string,
  businessId?: string,
) {
  return prisma.business.findFirst({
    where: businessId
      ? { id: businessId, userId, isActive: true }
      : { userId, isPrimary: true, isActive: true },
    select: { id: true, blogImagesEnabled: true },
  });
}

function controllerError(res: Response, error: unknown, operation: string) {
  if (error instanceof ZodError) return handleValidationError(res, error);
  console.error(`[business-settings] ${operation} failed`, error);
  return sendError(res, "Request could not be completed", 500);
}

export async function getBusinessSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { businessId } = businessTarget.parse(req.body ?? {});

    const include = {
      keywords: { orderBy: [{ keywordType: "asc" }, { createdAt: "asc" }] },
      competitiveAdvantage: true,
      competitiors: true,
      currentRanking: true,
    } satisfies Prisma.BusinessInclude;

    const requestedTarget = businessId
      ? await prisma.business.findFirst({
          where: { id: businessId, userId },
          select: {
            id: true,
            isActive: true,
            websiteStatus: true,
            onboardingFlow: true,
            onboardingStatus: true,
            removalStatus: true,
            websiteSubscription: { select: { status: true } },
          },
        })
      : null;
    let target = businessId
      ? requestedTarget && canViewHistoricalDashboardData(requestedTarget)
        ? requestedTarget
        : null
      : await prisma.business.findFirst({
          where: { userId, isPrimary: true, isActive: true },
          select: { id: true },
        });

    if (!target && !businessId) {
      target = await prisma.business.findFirst({
        where: { userId, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
    }
    if (!target && !businessId) {
      target = await prisma.business.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
    }
    if (!target) return sendError(res, "Business not found", 404);

    const cached = await readTenantCache<unknown>({
      namespace: "business-settings",
      userId,
      businessId: target.id,
    });
    if (cached) return sendSuccess(res, { business: cached }, "Business retrieved");

    const business = await prisma.business.findUnique({
      where: { id: target.id },
      include,
    });
    if (!business) return sendError(res, "Business not found", 404);
    await writeTenantCache({
      namespace: "business-settings",
      userId,
      businessId: business.id,
      value: business,
      ttlSeconds: 5 * 60,
    });
    return sendSuccess(res, { business }, "Business retrieved");
  } catch (error) {
    return controllerError(res, error, "get");
  }
}

export async function getBlogContentSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { businessId } = businessTarget.parse(req.body ?? {});
    const business = await resolveOwnedBlogContentSettings(userId, businessId);
    if (!business) return sendError(res, "Business not found", 404);

    return sendSuccess(
      res,
      {
        settings: {
          businessId: business.id,
          blogImagesEnabled: business.blogImagesEnabled,
        },
      },
      "Blog content settings retrieved",
    );
  } catch (error) {
    return controllerError(res, error, "get blog content settings");
  }
}

export async function updateBlogContentSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = blogContentSettingsSchema.parse(req.body);
    const business = await resolveOwnedBlogContentSettings(
      userId,
      payload.businessId,
    );
    if (!business) return sendError(res, "Business not found", 404);

    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { blogImagesEnabled: payload.blogImagesEnabled },
      select: { id: true, blogImagesEnabled: true },
    });
    await invalidateTenantCache(userId, business.id);

    return sendSuccess(
      res,
      {
        settings: {
          businessId: updated.id,
          blogImagesEnabled: updated.blogImagesEnabled,
        },
      },
      "Blog content settings updated",
    );
  } catch (error) {
    return controllerError(res, error, "update blog content settings");
  }
}

export async function authorizeBusinessAccess(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { businessId } = z.object({ businessId: id }).strict().parse(req.body ?? {});
    const business = await resolveOwnedBusiness(userId, businessId);
    if (!business) return sendError(res, "Business not found", 404);
    return sendSuccess(res, { authorized: true }, "Access authorized");
  } catch (error) {
    return controllerError(res, error, "authorize access");
  }
}

export async function getBusinessSitemap(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const { businessId } = businessTarget.parse(req.body ?? {});
    const business = await resolveOwnedBusiness(userId, businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const sitemap = await prisma.sitemapUrls.findFirst({
      where: { userId, businessId: business.id },
      select: { urls: true },
    });
    return sendSuccess(res, { urls: sitemap?.urls ?? [] }, "Sitemap retrieved");
  } catch (error) {
    return controllerError(res, error, "get sitemap");
  }
}

export async function updateBusinessBasicSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = basicInfoSchema.parse(req.body);
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        businessName: payload.businessName,
        businessType: payload.businessType,
        businessDescription: payload.businessDescription,
        businessWebsiteUrl: payload.businessWebsiteUrl,
        ...(payload.businessPhone !== undefined
          ? { businessPhone: payload.businessPhone }
          : {}),
      },
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { business: updated }, "Business updated");
  } catch (error) {
    return controllerError(res, error, "update basic info");
  }
}

export async function createBusinessKeyword(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = keywordCreateSchema.parse(req.body);
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const keyword = await prisma.keywords.create({
      data: { keyword: payload.keyword, keywordType: payload.keywordType, businessId: business.id },
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { keyword }, "Keyword created", 201);
  } catch (error) {
    return controllerError(res, error, "create keyword");
  }
}

export async function updateBusinessKeyword(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = keywordMutationSchema.parse(req.body);
    const existing = await prisma.keywords.findFirst({
      where: {
        id: payload.keywordId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Keyword not found", 404);
    const keyword = await prisma.keywords.update({
      where: { id: existing.id },
      data: { keyword: payload.keyword, keywordType: payload.keywordType },
    });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, { keyword }, "Keyword updated");
  } catch (error) {
    return controllerError(res, error, "update keyword");
  }
}

export async function deleteBusinessKeyword(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = recordDeleteSchema.parse(req.body);
    const existing = await prisma.keywords.findFirst({
      where: {
        id: payload.recordId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Keyword not found", 404);
    await prisma.keywords.delete({ where: { id: existing.id } });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, {}, "Keyword deleted");
  } catch (error) {
    return controllerError(res, error, "delete keyword");
  }
}

export async function replaceBusinessAdvantages(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = advantagesSchema.parse(req.body);
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const advantage = await prisma.$transaction(async (tx) => {
      await tx.competitiveAdvantage.deleteMany({ where: { businessId: business.id } });
      return tx.competitiveAdvantage.create({
        data: { advantage: payload.advantages, businessId: business.id },
      });
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { advantage }, "Advantages updated");
  } catch (error) {
    return controllerError(res, error, "replace advantages");
  }
}

export async function createBusinessCompetitor(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = competitorCreateSchema.parse(req.body);
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const competitor = await prisma.competitors.create({
      data: { name: payload.name, url: payload.url, businessId: business.id },
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { competitor }, "Competitor created", 201);
  } catch (error) {
    return controllerError(res, error, "create competitor");
  }
}

export async function updateBusinessCompetitor(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = competitorMutationSchema.parse(req.body);
    const existing = await prisma.competitors.findFirst({
      where: {
        id: payload.competitorId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Competitor not found", 404);
    const competitor = await prisma.competitors.update({
      where: { id: existing.id },
      data: { name: payload.name, url: payload.url },
    });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, { competitor }, "Competitor updated");
  } catch (error) {
    return controllerError(res, error, "update competitor");
  }
}

export async function deleteBusinessCompetitor(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = recordDeleteSchema.parse(req.body);
    const existing = await prisma.competitors.findFirst({
      where: {
        id: payload.recordId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Competitor not found", 404);
    await prisma.competitors.delete({ where: { id: existing.id } });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, {}, "Competitor deleted");
  } catch (error) {
    return controllerError(res, error, "delete competitor");
  }
}

export async function createBusinessRanking(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = rankingCreateSchema.parse(req.body);
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const ranking = await prisma.currentRanking.create({
      data: { website: payload.website, ranking: payload.ranking, businessId: business.id },
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { ranking }, "Ranking created", 201);
  } catch (error) {
    return controllerError(res, error, "create ranking");
  }
}

export async function updateBusinessRanking(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = rankingMutationSchema.parse(req.body);
    const existing = await prisma.currentRanking.findFirst({
      where: {
        id: payload.rankingId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Ranking not found", 404);
    const ranking = await prisma.currentRanking.update({
      where: { id: existing.id },
      data: { website: payload.website, ranking: payload.ranking },
    });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, { ranking }, "Ranking updated");
  } catch (error) {
    return controllerError(res, error, "update ranking");
  }
}

export async function deleteBusinessRanking(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = recordDeleteSchema.parse(req.body);
    const existing = await prisma.currentRanking.findFirst({
      where: {
        id: payload.recordId,
        ...(payload.businessId ? { businessId: payload.businessId } : {}),
        Business: { userId, isActive: true },
      },
      select: { id: true, businessId: true },
    });
    if (!existing) return sendError(res, "Ranking not found", 404);
    await prisma.currentRanking.delete({ where: { id: existing.id } });
    await invalidateTenantCache(userId, existing.businessId);
    return sendSuccess(res, {}, "Ranking deleted");
  } catch (error) {
    return controllerError(res, error, "delete ranking");
  }
}

export async function updateBusinessLocale(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const payload = localeSchema.parse(req.body);
    if (!SUPPORTED_LOCALES.has(payload.defaultLocale)) {
      return sendError(res, "Invalid locale", 400);
    }
    const business = await resolveOwnedBusiness(userId, payload.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { defaultLocale: payload.defaultLocale },
    });
    await invalidateTenantCache(userId, business.id);
    return sendSuccess(res, { business: updated }, "Locale updated");
  } catch (error) {
    return controllerError(res, error, "update locale");
  }
}
