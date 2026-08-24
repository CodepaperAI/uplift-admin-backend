import { Prisma, STATUS } from "@prisma/client";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { upsertBlog, type BlogPayload } from "../config/pinecone.config";
import {
  getBlogGenerationPausedResult,
  getBlogGenerationWorkerState,
  inngest,
} from "../inngest/client";
import { KeywordTrackingService } from "../services/keyword-tracking.service";
import { getBlogExternalLinkMetrics } from "../services/managed-backlinks.service";
import {
    handleValidationError,
    sendError,
    sendLegacySuccess,
    sendSuccess,
} from "../utils/response.utils";
import { getLocationCode } from "../utils/location.utils";
import { normalizeManagedLinkUrl } from "../utils/managed-backlinks.utils";
import {
    CREATE_BLOG,
    GET_ALL_BLOGS,
    GET_BLOG_GENERATION_STATUSES_BODY,
    GET_BLOG_BY_ID,
    GET_BLOG_BY_SLUG,
    GET_KEYWORD_INFO_STRICT,
    REGENERATE_MISSED_BLOGS,
    UPDATE_BLOG,
} from "../validators/blog.validation";
import {
  evaluateScheduleDue,
  getUtcScheduleQueryCeiling,
} from "../utils/blog-schedule.utils";
import { resolveEffectiveServices } from "../utils/effective-services.utils";
import { normalizeContentArchetype } from "../services/content-archetype.service";
import { buildExtendedBlogMeta } from "../utils/blog-seo.utils";
import { sanitizeBlogImagePayload } from "../utils/blog-image-url.utils";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";
import {
  canAccessFeature,
  checkSiteAccess,
} from "../utils/access-control.utils";
import { buildPinnedBlogGenerateEventData } from "../services/blog-pipeline-v2";
import {
  failQueuedProductionBlogGeneration,
  getProductionBlogGenerationStatuses,
  queueProductionBlogGenerationRun,
} from "../services/blog-pipeline-v2/generation-status";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "../utils/tenant-response-cache";
import { canViewHistoricalDashboardData } from "../utils/website-workspace-access.utils";

type BlogPublicationSummary = {
  id: string;
  platform: string;
  status: string;
  externalPostUrl: string | null;
  externalPostId: string | null;
  publishedAt: Date | null;
  integrationId: string | null;
};

function normalizeApiTokenSiteUrl(rawUrl?: string | null): string | null {
  if (!rawUrl?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function buildApiTokenPublishedUrl(siteUrl: string | null, slug: string): string | null {
  if (!siteUrl) return null;
  try {
    const base = new URL(siteUrl);
    const pathname = base.pathname.replace(/\/+$/, "");
    const blogPath = pathname.endsWith("/blog") ? pathname : `${pathname}/blog`;
    return `${base.origin}${blogPath}/${encodeURIComponent(slug)}`;
  } catch {
    return null;
  }
}

async function appendApiTokenPublication<T extends {
  businessId: string | null;
  status: STATUS;
  slug: string;
  publishedBlogs: BlogPublicationSummary[];
}>(blog: T, apiToken?: {
  id: string;
  createdAt: Date;
  connectedSiteUrlAtCreation: string | null;
  allowedOrigins: string[];
} | null): Promise<T> {
  if (
    !blog.businessId ||
    blog.status !== STATUS.PUBLISH ||
    blog.publishedBlogs.some((entry) => entry.platform === "API_TOKEN")
  ) return blog;

  const source = apiToken ?? await prisma.apiToken.findFirst({
    where: { businessId: blog.businessId, isActive: true, permissions: { has: "read:blogs" } },
    select: { id: true, createdAt: true, connectedSiteUrlAtCreation: true, allowedOrigins: true },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
  });
  if (!source) return blog;
  const siteUrl = normalizeApiTokenSiteUrl(source.connectedSiteUrlAtCreation)
    ?? normalizeApiTokenSiteUrl(source.allowedOrigins[0]);
  return {
    ...blog,
    publishedBlogs: [
      ...blog.publishedBlogs,
      {
        id: `api-token-${source.id}`,
        platform: "API_TOKEN",
        status: "PUBLISHED",
        externalPostUrl: buildApiTokenPublishedUrl(siteUrl, blog.slug),
        externalPostId: null,
        publishedAt: source.createdAt,
        integrationId: null,
      },
    ],
  };
}

async function queueBlogDistributionIfDue(params: {
  blogId: string;
  businessId: string;
  status: STATUS;
  blogPublishDate: string;
  blogPublishTime: string;
  business: {
    businessName?: string | null;
    defaultLocale?: string | null;
    businessCountry?: string | null;
    businessState?: string | null;
    businessCity?: string | null;
  };
}) {
  if (params.status !== STATUS.PUBLISH) {
    return;
  }

  const dueEvaluation = evaluateScheduleDue({
    publishDate: params.blogPublishDate,
    publishTime: params.blogPublishTime,
    defaultLocale: params.business.defaultLocale,
    businessCountry: params.business.businessCountry,
    businessState: params.business.businessState,
    businessCity: params.business.businessCity,
  });

  if (!dueEvaluation.isDue) {
    console.log(
      `⏳ Deferring publish/GMB queue for blog ${params.blogId} until ${params.blogPublishDate} ${params.blogPublishTime} (${dueEvaluation.timeZone}; local now ${dueEvaluation.date} ${dueEvaluation.time})`,
    );
    return;
  }

  try {
    await inngest.send({
      name: "publishing/auto-publish",
      data: {
        blogId: params.blogId,
      },
    });
    console.log(`📤 Triggered auto-publish for blog ${params.blogId}`);
  } catch (publishError) {
    console.error(
      `❌ Failed to trigger auto-publish for blog ${params.blogId}:`,
      publishError,
    );
  }

  try {
    await inngest.send({
      name: "gmb/auto-post-from-blog",
      data: {
        blogId: params.blogId,
        businessId: params.businessId,
      },
    });
    console.log(`📤 Triggered GMB auto-post for blog ${params.blogId}`);
  } catch (gmbError) {
    console.error(
      `❌ Failed to trigger GMB auto-post for blog ${params.blogId}:`,
      gmbError,
    );
  }
}

function buildDraftBlogBaseUrl(websiteUrl: string | null | undefined, slug: string) {
  const normalizedWebsiteUrl = normalizeManagedLinkUrl(websiteUrl ?? "");
  if (!normalizedWebsiteUrl) {
    return "";
  }

  try {
    return new URL(`blog/${slug}`, normalizedWebsiteUrl).toString();
  } catch {
    return normalizedWebsiteUrl;
  }
}

async function reconcileKeywordTrackingForExistingBlog(params: {
  authUserId: string;
  businessId: string;
  existingBlogId: string;
  keywordId?: string | null;
  focusKeyword?: string | null;
}) {
  if (params.keywordId) {
    try {
      await KeywordTrackingService.markKeywordAsUsed(
        params.keywordId,
        params.existingBlogId,
      );
      console.log(
        `✅ Reconciled keyword ${params.keywordId} to existing blog ${params.existingBlogId}`,
      );
    } catch (error) {
      console.error("❌ Failed to reconcile duplicate keyword tracking:", error);
    }
    return;
  }

  if (!params.focusKeyword) {
    return;
  }

  try {
    const matchingKeyword = await prisma.plan.findFirst({
      where: {
        userId: params.authUserId,
        businessId: params.businessId,
        keyword: {
          equals: params.focusKeyword,
          mode: "insensitive",
        },
        blogId: null,
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, keyword: true },
    });

    if (!matchingKeyword) {
      return;
    }

    await KeywordTrackingService.markKeywordAsUsed(
      matchingKeyword.id,
      params.existingBlogId,
    );
    console.log(
      `✅ Reconciled focus keyword "${matchingKeyword.keyword}" (${matchingKeyword.id}) to existing blog ${params.existingBlogId}`,
    );
  } catch (error) {
    console.error(
      "❌ Failed to reconcile duplicate focus keyword tracking:",
      error,
    );
  }
}

export async function postBlog(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = CREATE_BLOG.parse(body);
    const imageSanitization = sanitizeBlogImagePayload(payload);
    if (
      imageSanitization.featuredMediaChanged ||
      imageSanitization.removedInvalidImages > 0 ||
      imageSanitization.normalizedImageSources > 0
    ) {
      console.log("🖼️ Sanitized incoming blog image URLs:", imageSanitization);
    }

    const business = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: authUserId,
        isActive: true,
      },
      include: {
        User: true,
      },
    });

    if (!business) {
      return sendError(res, "Business not found or inactive", 400);
    }

    const slug =
      payload.slug || payload.title.toLowerCase().trim().replace(/\s+/g, "-");

    const existingBlog = await prisma.blog.findFirst({
      where: {
        userId: authUserId,
        businessId: business.id,
        OR: [{ slug: slug }, { title: payload.title }],
      },
    });

    if (existingBlog) {
      console.log(
        `⚠️ Duplicate blog detected: ${existingBlog.id} (slug: ${slug}, title: ${payload.title})`
      );
      await reconcileKeywordTrackingForExistingBlog({
        authUserId,
        businessId: business.id,
        existingBlogId: existingBlog.id,
        keywordId: payload.keywordId,
        focusKeyword: payload.meta.focus_keyword,
      });
      return sendSuccess(
        res,
        {
          blogId: existingBlog.id,
          message: "Blog already exists",
          isDuplicate: true,
        },
        "Blog already exists - duplicate prevented"
      );
    }

    if (payload.keywordId) {
      const keywordWithBlog = await prisma.plan.findFirst({
        where: {
          id: payload.keywordId,
          blogId: { not: null },
        },
        select: { id: true, blogId: true, keyword: true },
      });

      if (keywordWithBlog && keywordWithBlog.blogId) {
        console.log(
          `⚠️ Duplicate blog detected via keywordId: keyword ${keywordWithBlog.id} already has blog ${keywordWithBlog.blogId}`
        );
        await reconcileKeywordTrackingForExistingBlog({
          authUserId,
          businessId: business.id,
          existingBlogId: keywordWithBlog.blogId,
          keywordId: payload.keywordId,
          focusKeyword: payload.meta.focus_keyword,
        });
        return sendSuccess(
          res,
          {
            blogId: keywordWithBlog.blogId,
            message: "Blog already exists for this keyword",
            isDuplicate: true,
          },
          "Blog already exists for this keyword - duplicate prevented"
        );
      }
    }

    if (payload.meta.focus_keyword) {
      const existingBlogByFocusKeyword = await prisma.blog.findFirst({
        where: {
          userId: authUserId,
          businessId: business.id,
          meta: {
            focus_keyword: {
              equals: payload.meta.focus_keyword,
              mode: "insensitive",
            },
          },
        },
        select: { id: true, title: true },
      });

      if (existingBlogByFocusKeyword) {
        console.log(
          `⚠️ Duplicate blog detected via focus_keyword: "${payload.meta.focus_keyword}" already used in blog ${existingBlogByFocusKeyword.id}`
        );
        await reconcileKeywordTrackingForExistingBlog({
          authUserId,
          businessId: business.id,
          existingBlogId: existingBlogByFocusKeyword.id,
          keywordId: payload.keywordId,
          focusKeyword: payload.meta.focus_keyword,
        });
        return sendSuccess(
          res,
          {
            blogId: existingBlogByFocusKeyword.id,
            message: "Blog already exists with this focus keyword",
            isDuplicate: true,
          },
          "Blog already exists with this focus keyword - duplicate prevented"
        );
      }
    }

    const meta = await prisma.meta.create({
      data: {
        seo_title: payload.meta.seo_title,
        seo_description: payload.meta.seo_description,
        focus_keyword: payload.meta.focus_keyword || "",
        keywords: payload.meta.keywords || [],
      },
    });

    const customField = await prisma.customField.create({
      data: {
        reading_time: payload.custom_fields.reading_time || "",
        rating: payload.custom_fields.rating || 0,
      },
    });

    // Note: Legacy uploadBlogToWordPress removed - publishing is now handled by
    // the autoPublishBlogTask via PublishingIntegration system (lines 113-131 below)
    // This prevents duplicate blog posts on WordPress

    const draftBlogBaseUrl = buildDraftBlogBaseUrl(
      business.businessWebsiteUrl,
      slug,
    );
    const { totalExternalLinks } = getBlogExternalLinkMetrics({
      html: payload.content,
      sourceBaseUrl: draftBlogBaseUrl || business.businessWebsiteUrl || "",
      currentBusinessWebsiteUrl: business.businessWebsiteUrl || "",
    });

    // Prepare analytics object with actual external links count
    const analytics = payload.analytics
      ? {
          ...payload.analytics,
          externalLinksCount: totalExternalLinks,
          managedCrossLinksCount: 0,
        }
      : {
          externalLinksCount: totalExternalLinks,
          managedCrossLinksCount: 0,
        };

    // Resolve author: business author profile > payload author > user name > business name
    const resolvedAuthorName =
      (business as any).authorName?.trim() ||
      (payload.author && payload.author !== "username here" ? payload.author : null) ||
      business.User?.name ||
      business.businessName;

    const authorSocialLinks = (business as any).authorSocialLinks as Record<string, string> | null;
    const extendedSeoMeta = buildExtendedBlogMeta({
      title: payload.title,
      excerpt: payload.excerpt,
      slug,
      meta: payload.meta,
      categories: payload.categories,
      tags: payload.tags,
      authorName: resolvedAuthorName,
      businessName: business.businessName,
      businessWebsiteUrl: business.businessWebsiteUrl,
      defaultLocale: business.defaultLocale,
    });

    const analyticsWithSeoMeta = analytics
      ? {
          ...analytics,
          seoMeta: extendedSeoMeta,
        }
      : {
          seoMeta: extendedSeoMeta,
        };

    const blog = await prisma.blog.create({
      data: {
        userId: authUserId,
        title: payload.title,
        content: payload.content,
        excerpt: payload.excerpt,
        businessId: business.id as string,
        featured_media: payload.featured_media,
        slug: payload.slug,
        status: payload.status || STATUS.DRAFT,
        customFieldId: customField.id,
        metaId: meta.id,
        categories: payload.categories,
        tags: payload.tags,
        blogPublishDate: payload.blogPublishInfo.date,
        blogPublishTime: payload.blogPublishInfo.time,
        seoScore: payload.seoScore ?? null,
        analytics: JSON.parse(JSON.stringify(analyticsWithSeoMeta)),
        authorName: resolvedAuthorName,
        authorBio: (business as any).authorBio || null,
        authorUrl: authorSocialLinks?.website || business.businessWebsiteUrl || null,
        authorImage: (business as any).authorImage || null,
      },
    });

    await queueBlogDistributionIfDue({
      blogId: blog.id,
      businessId: business.id,
      status: blog.status,
      blogPublishDate: blog.blogPublishDate,
      blogPublishTime: blog.blogPublishTime,
      business,
    });

    const pineconePayload: BlogPayload = {
      title: payload.title,
      content: payload.content,
      url: null,
      userId: authUserId,
      businessId: business.id,
      tags: payload.tags,
      categories: payload.categories,
      seoDescription: payload.meta.seo_description,
    };

    upsertBlog(blog.id, pineconePayload).catch(console.error);

    if (payload.keywordId) {
      try {
        await KeywordTrackingService.markKeywordAsUsed(
          payload.keywordId,
          blog.id
        );
        console.log(
          `✅ Marked keyword ${payload.keywordId} as used for blog ${blog.id}`
        );
      } catch (error) {
        console.error("❌ Failed to mark keyword as used:", error);
      }
    } else if (payload.meta.focus_keyword) {
      try {
        const matchingKeyword = await prisma.plan.findFirst({
          where: {
            userId: authUserId,
            businessId: business.id,
            keyword: {
              equals: payload.meta.focus_keyword,
              mode: "insensitive",
            },
            blogId: null,
            deletedAt: null,
          },
          orderBy: { createdAt: "desc" },
        });

        if (matchingKeyword) {
          await KeywordTrackingService.markKeywordAsUsed(
            matchingKeyword.id,
            blog.id
          );
          console.log(
            `✅ Matched and marked keyword "${matchingKeyword.keyword}" (${matchingKeyword.id}) as used for blog ${blog.id} via focus_keyword fallback`
          );
        } else {
          console.log(
            `ℹ️ No matching unused keyword found for focus_keyword: "${payload.meta.focus_keyword}"`
          );
        }
      } catch (error) {
        console.error("❌ Failed to match keyword by focus_keyword:", error);
      }
    }

    await invalidateTenantCache(authUserId, business.id);

    setImmediate(async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: authUserId },
          select: {
            email: true,
            name: true,
            trialStatus: true,
            trialEndDate: true,
            trialStartDate: true,
            role: true,
          },
        });

        if (user && isPlatformStaffSubscriptionBypassRole(user.role)) {
          console.log(`ℹ️ Skipping blog email for admin user ${user.email}`);
          return;
        }

        const ws = blog.businessId
          ? await prisma.websiteSubscription.findUnique({
              where: { businessId: blog.businessId },
            })
          : null;
        const isWebsiteTrial =
          ws !== null &&
          ws.trialStatus === "trialing" &&
          ws.trialEndDate !== null &&
          ws.trialEndDate > new Date();
        const isUserTrial =
          user !== null &&
          user.trialStatus === "active" &&
          user.trialEndDate !== null &&
          user.trialEndDate > new Date();

        if (user && (isWebsiteTrial || isUserTrial)) {
          const { sendBlogEmail } = await import("../services/trial-email.service");
          const { TrialAnalyticsService } = await import("../services/trial-analytics.service");

          const existingBlogs = await prisma.blog.count({
            where: { userId: authUserId },
          });

          const isFirstBlog = existingBlogs === 1;

          const userEmail = user.email ?? "";
          const userName = (user.name ?? userEmail.split("@")[0]) || "";
          await sendBlogEmail(
            userEmail,
            userName,
            payload.title,
            slug,
            payload.excerpt || "",
            isFirstBlog,
            user.trialStartDate
          );
          console.log(`✅ Blog email sent to trial user ${userEmail}`);

          if (isFirstBlog) {
            await TrialAnalyticsService.trackFirstBlogGenerated(authUserId);
          }
          await TrialAnalyticsService.trackEmailSent(
            authUserId,
            isFirstBlog ? "firstBlog" : "blogGenerated"
          );
        }
      } catch (error) {
        console.error(`❌ Failed to send first blog email:`, error);
      }
    });

    return sendLegacySuccess(res, {
      message: "Blog Created",
      blogId: blog.id,
      isDuplicate: false,
      blogInfo: blog,
    });
  } catch (error: any) {
    console.error("❌ Error in postBlog:", error);
    console.error("❌ Error stack:", error?.stack);
    console.error("❌ Error code:", error?.code);
    console.error("❌ Error message:", error?.message);

    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to create blog", 500, {
      message: error?.message || "Unknown error",
      code: error?.code || "UNKNOWN_ERROR",
      details:
        process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
}

export async function generateBlogFromPlannedKeywords(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_KEYWORD_INFO_STRICT.parse(body);

    if (!getBlogGenerationWorkerState().enabled) {
      return sendSuccess(
        res,
        getBlogGenerationPausedResult({ businessId: payload.businessId }),
        "Blog generation paused",
      );
    }

    const keyword = await prisma.plan.findUnique({
      where: { id: payload.keywordId },
      select: { userId: true, businessId: true, blogId: true, deletedAt: true },
    });

    if (!keyword) {
      return sendError(res, "Keyword not found", 404);
    }

    if (keyword.deletedAt) {
      return sendError(res, "Cannot generate blog for deleted keyword", 400);
    }

    if (keyword.userId !== authUserId) {
      return sendError(res, "Keyword does not belong to user", 403);
    }

    const keywordBusinessId = keyword.businessId ?? payload.businessId;
    if (keywordBusinessId !== payload.businessId) {
      return sendError(res, "Keyword does not belong to the specified website", 403);
    }

    const business = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: authUserId,
        isActive: true,
      },
      select: {
        id: true,
        businessName: true,
        businessWebsiteUrl: true,
      },
    });

    if (!business) {
      return sendError(res, "Business not found or inactive", 404);
    }

    const access = await checkSiteAccess(business.id);
    if (!canAccessFeature(access, "blogGeneration")) {
      return sendError(
        res,
        access.accessType === "trial"
          ? "Your trial includes one sample blog. Upgrade this website to generate additional blogs."
          : access.message || "Blog generation is not available for this website",
        403,
      );
    }

    if (keyword.blogId) {
      return sendSuccess(
        res,
        {
          status: "completed",
          keywordId: payload.keywordId,
          businessId: business.id,
          blogId: keyword.blogId,
        },
        "Article is already available",
      );
    }

    const queuedRun = await queueProductionBlogGenerationRun({
      keywordId: payload.keywordId,
      userId: authUserId,
      businessId: business.id,
    });
    if (queuedRun.alreadyProcessing) {
      return sendSuccess(
        res,
        {
          status: queuedRun.status,
          keywordId: payload.keywordId,
          businessId: business.id,
          alreadyProcessing: true,
        },
        queuedRun.status === "running"
          ? "Article generation is already running"
          : "Article generation is already queued",
      );
    }

    let enqueueResult: Awaited<ReturnType<typeof inngest.send>>;
    try {
      enqueueResult = await inngest.send({
        name: "blog/generate",
        data: buildPinnedBlogGenerateEventData(payload.keywordId, {
          userId: authUserId,
          keywordId: payload.keywordId,
          businessId: business.id,
          selectedTitle: payload.selectedTitle ?? null,
        }),
      });
    } catch (enqueueError) {
      await failQueuedProductionBlogGeneration({
        keywordId: payload.keywordId,
        message:
          enqueueError instanceof Error
            ? enqueueError.message
            : "Background queue rejected the generation request",
      });
      throw enqueueError;
    }

    const eventIds = enqueueResult.ids ?? [];
    if (eventIds.length === 0) {
      await failQueuedProductionBlogGeneration({
        keywordId: payload.keywordId,
        message: "Background queue accepted no blog generation event",
      });
      throw new Error("Inngest accepted no blog generation event");
    }

    return sendSuccess(
      res,
      {
        status: "queued",
        keywordId: payload.keywordId,
        businessId: business.id,
        eventIds,
      },
      "Blog generation started in background"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error starting blog generation:", error);
    return sendError(res, "Failed to start blog generation", 500, error);
  }
}

export async function getBlogGenerationStatuses(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const payload = GET_BLOG_GENERATION_STATUSES_BODY.parse(req.body);
    const business = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: authUserId,
        isActive: true,
      },
      select: { id: true, isPrimary: true },
    });
    if (!business) {
      return sendError(res, "Business not found or inactive", 404);
    }
    const statuses = await getProductionBlogGenerationStatuses({
      userId: authUserId,
      businessId: business.id,
      includeUnassignedPrimaryPlans: business.isPrimary,
    });
    return sendSuccess(
      res,
      { statuses },
      "Article generation statuses retrieved",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error retrieving blog generation statuses:", error);
    return sendError(res, "Failed to retrieve article generation statuses", 500);
  }
}

/**
 * Get available languages for blog generation
 * Returns detected languages based on business context + all supported languages
 */
export async function getAvailableLanguages(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const business = await prisma.business.findFirst({
      where: { 
        userId: authUserId,
        isPrimary: true,
        isActive: true,
      },
      select: {
        businessCountry: true,
        businessCity: true,
        serviceArea: true,
        targetAudience: true,
        defaultLanguage: true,
        defaultLocale: true,
        supportedLanguages: true,
      },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const {
      getDetectedLocalesForBusiness,
      getAllSupportedLocales,
      getLocaleInfo,
      validateLocaleCode,
      languageToDefaultLocale,
    } = await import("../utils/language.utils");

    const { detected, all, recommended } = getDetectedLocalesForBusiness({
      businessCountry: business.businessCountry,
      businessCity: business.businessCity,
      serviceArea: business.serviceArea,
      targetAudience: business.targetAudience,
    });

    let defaultLocale = "en-US";
    if (business.defaultLocale) {
      defaultLocale = validateLocaleCode(business.defaultLocale);
    } else if (business.defaultLanguage) {
      const businessCountry = business.businessCountry?.toUpperCase();
      defaultLocale = languageToDefaultLocale(
        business.defaultLanguage,
        businessCountry
      );
    }

    return sendSuccess(
      res,
      {
        detected: detected,
        all: all,
        recommended: recommended,
        defaultLanguage: business.defaultLanguage || "en",
        defaultLocale: defaultLocale,
        supportedLanguages: business.supportedLanguages || [],
      },
      "Available languages and locales retrieved successfully"
    );
  } catch (error) {
    console.error("Error getting available languages:", error);
    return sendError(res, "Failed to get available languages", 500, error);
  }
}

export async function getAllBlogs(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_ALL_BLOGS.parse(body);

    const requestedBusiness = payload.businessId
      ? await prisma.business.findFirst({
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
        })
      : null;
    const business = payload.businessId
      ? requestedBusiness && canViewHistoricalDashboardData(requestedBusiness)
        ? requestedBusiness
        : null
      : await prisma.business.findFirst({
          where: { userId: authUserId, isPrimary: true, isActive: true },
          select: { id: true },
        });
    if (!business) return sendSuccess(res, { blogs: [] }, "Blogs retrieved successfully");

    const cached = await readTenantCache<unknown[]>({
      namespace: "content-blogs",
      userId: authUserId,
      businessId: business.id,
    });
    if (cached) return sendSuccess(res, { blogs: cached }, "Blogs retrieved successfully");

    const whereClause: Prisma.BlogWhereInput = {
      userId: authUserId,
      businessId: business.id,
    };

    const blogs = await prisma.blog.findMany({
      where: whereClause,
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            defaultLocale: true,
          },
        },
        meta: true,
        customField: true,
        publishedBlogs: {
          select: {
            id: true,
            platform: true,
            status: true,
            externalPostUrl: true,
            externalPostId: true,
            publishedAt: true,
            integrationId: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const apiToken = await prisma.apiToken.findFirst({
      where: { businessId: business.id, isActive: true, permissions: { has: "read:blogs" } },
      select: { id: true, createdAt: true, connectedSiteUrlAtCreation: true, allowedOrigins: true },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    });
    const blogsWithPublicationState = await Promise.all(
      blogs.map((blog) => appendApiTokenPublication(blog, apiToken)),
    );
    await writeTenantCache({
      namespace: "content-blogs",
      userId: authUserId,
      businessId: business.id,
      value: blogsWithPublicationState,
      ttlSeconds: 2 * 60,
    });

    return sendSuccess(res, { blogs: blogsWithPublicationState }, "Blogs retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to retrieve blogs", 500, error);
  }
}

export async function getBlogById(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = GET_BLOG_BY_SLUG.parse(body);

    const blog = await prisma.blog.findFirst({
      where: {
        ...(payload.blogId ? { id: payload.blogId } : { slug: payload.slug! }),
        userId: authUserId,
      },
      include: {
        customField: true,
        meta: true,
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            defaultLocale: true,
          },
        },
        publishedBlogs: {
          select: {
            id: true,
            platform: true,
            status: true,
            externalPostUrl: true,
            externalPostId: true,
            publishedAt: true,
            integrationId: true,
          },
        },
        guestPostSubmissions: {
          select: { id: true, status: true, publishedUrl: true },
        },
      },
    });
    if (!blog) return sendError(res, "Blog not found", 404);
    const blogWithPublicationState = await appendApiTokenPublication(blog);
    return sendSuccess(res, { blog: blogWithPublicationState }, "Blog retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to retrieve blog", 500, error);
  }
}

const TRIGGER_DAILY_BODY = z.object({
  userId: z.string(),
  businessId: z.string(),
});

export async function triggerDailyBlogGeneration(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const payload = TRIGGER_DAILY_BODY.parse(req.body);

    if (!getBlogGenerationWorkerState().enabled) {
      return sendSuccess(
        res,
        getBlogGenerationPausedResult({ businessId: payload.businessId }),
        "Blog generation paused",
      );
    }

    const business = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: authUserId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!business) {
      return sendError(res, "Business not found or inactive", 404);
    }

    await inngest.send({
      name: "blog/trigger-daily-generation",
      data: { userId: authUserId, businessId: payload.businessId },
    });

    return sendSuccess(
      res,
      { status: "processing", businessId: payload.businessId },
      "Daily blog generation triggered for this website."
    );
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error triggering daily blog generation:", error);
    return sendError(
      res,
      "Failed to trigger daily blog generation",
      500,
      error
    );
  }
}

export async function generateTitlesOnly(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { GENERATE_TITLES_BODY } = await import("../validators/blog.validation");
    const body = GENERATE_TITLES_BODY.parse(req.body);
    const { keywordId, businessId } = body;

    const businessInfo = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: authUserId,
        isActive: true,
      },
      include: {
        websiteAnalysis: {
          include: {
            businessInfo: true,
            coreServices: true,
          },
        },
      },
    });

    if (!businessInfo) {
      return sendError(res, "Business not found", 404);
    }

    const keywordInfo = await prisma.plan.findUnique({
      where: { id: keywordId },
    });

    if (!keywordInfo) {
      return sendError(res, "Keyword not found", 404);
    }

    if (keywordInfo.deletedAt) {
      return sendError(res, "Cannot generate blog for deleted keyword", 400);
    }

    if (keywordInfo.userId !== authUserId) {
      return sendError(res, "Keyword does not belong to user", 403);
    }

    const kwBusinessId = keywordInfo.businessId ?? businessId;
    if (kwBusinessId !== businessId) {
      return sendError(res, "Keyword does not belong to the specified website", 403);
    }

    const { validateLocaleCode, languageToDefaultLocale } = await import(
      "../utils/language.utils"
    );

    let localeCode = "en-US";
    if (businessInfo.defaultLocale) {
      localeCode = validateLocaleCode(businessInfo.defaultLocale);
    } else if (businessInfo.defaultLanguage) {
      const businessCountry = businessInfo.businessCountry?.toUpperCase();
      localeCode = languageToDefaultLocale(
        businessInfo.defaultLanguage,
        businessCountry
      );
    }

    const validLocale = validateLocaleCode(localeCode);

    // GEO-KW-1: uses shared city-aware getLocationCode from location.utils.ts
    const locationCode = getLocationCode(
      businessInfo.businessCountry ?? undefined,
      businessInfo.businessCity ?? undefined
    );

    const effectiveServices = resolveEffectiveServices(businessInfo);

    const businessInfoForTitles = {
      ...businessInfo,
      enhancedBusinessInfo: businessInfo.websiteAnalysis?.businessInfo || null,
      coreServices: effectiveServices,
      effectiveServices,
    };

    const { generateTitlesOnlyLLM } = await import(
      "../llm/keywords/generate-titles-only.llm"
    );

    console.log(
      "🔄 Starting title generation for keyword:",
      keywordInfo.keyword
    );

    // For frontend, we need to generate titles and return array
    const { generateTitlesArrayForFrontend } = await import(
      "../llm/keywords/generate-titles-only.llm"
    );

    const titles = await generateTitlesArrayForFrontend({
      keyword: keywordInfo.keyword,
      businessInfo: JSON.stringify(businessInfoForTitles),
      businessLocation: {
        businessCity: businessInfo.businessCity ?? undefined,
        businessState: businessInfo.businessState ?? undefined,
        businessCountry: businessInfo.businessCountry ?? undefined,
      },
      locale: validLocale,
      locationCode: locationCode,
      archetype: normalizeContentArchetype(keywordInfo.keywordInstructions),
    });

    console.log(
      `✅ Generated ${titles.length} titles for keyword: ${keywordInfo.keyword}`
    );

    return sendSuccess(
      res,
      {
        titles: titles,
        keyword: keywordInfo.keyword,
        message: "Titles generated successfully",
      },
      "Titles generated successfully"
    );
  } catch (error: any) {
    console.error("❌ Error generating titles:", error);
    console.error("❌ Error stack:", error?.stack);
    return sendError(res, "Failed to generate titles", 500, {
      message: error?.message || "Unknown error",
      stack: process.env.NODE_ENV === "development" ? error?.stack : undefined,
    });
  }
}

export async function regenerateMissedBlogs(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = REGENERATE_MISSED_BLOGS.parse(body);
    const { businessId, limit } = payload;

    if (!getBlogGenerationWorkerState().enabled) {
      return sendSuccess(
        res,
        {
          ...getBlogGenerationPausedResult({ businessId }),
          missedCount: 0,
          regenerated: [],
        },
        "Blog generation paused",
      );
    }

    const business = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: authUserId,
        isActive: true,
      },
      select: { id: true },
    });

    if (!business) {
      return sendError(res, "Business not found or inactive", 404);
    }

    const now = new Date();
    const whereClause: Prisma.PlanWhereInput = {
      userId: authUserId,
      blogId: null,
      deletedAt: null,
      isUsed: false,
      usedAt: null,
      businessId: business.id,
      publishDate: {
        lte: getUtcScheduleQueryCeiling(now, 0),
      },
    };

    const [dueCount, missedKeywords] = await Promise.all([
      prisma.plan.count({ where: whereClause }),
      prisma.plan.findMany({
        where: whereClause,
        select: {
          id: true,
          keyword: true,
          businessId: true,
          publishDate: true,
          publishTime: true,
        },
        orderBy: [{ publishDate: "asc" }, { publishTime: "asc" }],
        take: limit,
      }),
    ]);

    if (missedKeywords.length === 0) {
      return sendSuccess(
        res,
        {
          missedCount: 0,
          dueCount: 0,
          remainingCount: 0,
          regenerated: [],
        },
        "No missed keywords found. All keywords have blogs."
      );
    }

    const regenerationPromises = missedKeywords.map(async (keyword) => {
      const targetBusinessId = keyword.businessId!;

      await inngest.send({
        name: "blog/generate",
        data: buildPinnedBlogGenerateEventData(keyword.id, {
          userId: authUserId,
          keywordId: keyword.id,
          businessId: targetBusinessId,
          selectedTitle: null,
        }),
      });

      return {
        keywordId: keyword.id,
        keyword: keyword.keyword,
        businessId: targetBusinessId,
      };
    });

    const regenerated = await Promise.all(regenerationPromises);

    return sendSuccess(
      res,
      {
        missedCount: missedKeywords.length,
        dueCount,
        remainingCount: Math.max(0, dueCount - regenerated.length),
        limit,
        regenerated: regenerated,
        message: `Blog generation started for ${regenerated.length} missed keyword(s)`,
      },
      `Successfully triggered blog generation for ${regenerated.length} missed keyword(s)`
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error regenerating missed blogs:", error);
    return sendError(res, "Failed to regenerate missed blogs", 500, error);
  }
}

export async function updateBlog(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const blogId = req.params.id;
    if (typeof blogId !== "string" || !blogId) {
      return sendError(res, "Blog ID is required", 400);
    }

    const payload = UPDATE_BLOG.parse(req.body);
    const imageSanitization = sanitizeBlogImagePayload(payload);
    if (
      imageSanitization.featuredMediaChanged ||
      imageSanitization.removedInvalidImages > 0 ||
      imageSanitization.normalizedImageSources > 0
    ) {
      console.log("🖼️ Sanitized updated blog image URLs:", imageSanitization);
    }

    const existingBlog = await prisma.blog.findUnique({
      where: { id: blogId },
      include: {
        meta: true,
        customField: true,
        business: true,
      },
    });

    if (!existingBlog) {
      return sendError(res, "Blog not found", 404);
    }

    if (existingBlog.userId !== authUserId) {
      return sendError(res, "Unauthorized to edit this blog", 403);
    }

    const updateData: Prisma.BlogUpdateInput = {};

    if (payload.title !== undefined) {
      updateData.title = payload.title;
    }
    if (payload.content !== undefined) {
      updateData.content = payload.content;
    }
    if (payload.excerpt !== undefined) {
      updateData.excerpt = payload.excerpt;
    }
    if (payload.categories !== undefined) {
      updateData.categories = payload.categories;
    }
    if (payload.tags !== undefined) {
      updateData.tags = payload.tags;
    }
    if (payload.featured_media !== undefined) {
      updateData.featured_media = payload.featured_media;
    }
    if (payload.status !== undefined) {
      updateData.status = payload.status as STATUS;
    }
    if (payload.seoScore !== undefined) {
      updateData.seoScore = payload.seoScore;
    }
    if (payload.blogPublishInfo?.date !== undefined) {
      updateData.blogPublishDate = payload.blogPublishInfo.date;
    }
    if (payload.blogPublishInfo?.time !== undefined) {
      updateData.blogPublishTime = payload.blogPublishInfo.time;
    }

    if (payload.meta) {
      const metaUpdate: Prisma.MetaUpdateInput = {};
      if (payload.meta.seo_title !== undefined) {
        metaUpdate.seo_title = payload.meta.seo_title;
      }
      if (payload.meta.seo_description !== undefined) {
        metaUpdate.seo_description = payload.meta.seo_description;
      }
      if (payload.meta.focus_keyword !== undefined) {
        metaUpdate.focus_keyword = payload.meta.focus_keyword;
      }
      if (payload.meta.keywords !== undefined) {
        metaUpdate.keywords = payload.meta.keywords;
      }

      if (Object.keys(metaUpdate).length > 0) {
        await prisma.meta.update({
          where: { id: existingBlog.metaId },
          data: metaUpdate,
        });
      }
    }

    if (payload.custom_fields) {
      const customFieldUpdate: Prisma.CustomFieldUpdateInput = {};
      if (payload.custom_fields.reading_time !== undefined) {
        customFieldUpdate.reading_time = payload.custom_fields.reading_time;
      }
      if (payload.custom_fields.rating !== undefined) {
        customFieldUpdate.rating = payload.custom_fields.rating;
      }

      if (Object.keys(customFieldUpdate).length > 0) {
        await prisma.customField.update({
          where: { id: existingBlog.customFieldId },
          data: customFieldUpdate,
        });
      }
    }

    const nextAnalytics =
      existingBlog.analytics &&
      typeof existingBlog.analytics === "object" &&
      !Array.isArray(existingBlog.analytics)
        ? { ...(existingBlog.analytics as Record<string, unknown>) }
        : {};

    const nextMetaInput = {
      seo_title: payload.meta?.seo_title ?? existingBlog.meta.seo_title,
      seo_description:
        payload.meta?.seo_description ?? existingBlog.meta.seo_description,
      focus_keyword:
        payload.meta?.focus_keyword ?? existingBlog.meta.focus_keyword,
      keywords: payload.meta?.keywords ?? existingBlog.meta.keywords,
      og_title:
        payload.meta?.og_title ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_title as string | undefined),
      og_description:
        payload.meta?.og_description ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_description as string | undefined),
      og_type:
        payload.meta?.og_type ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_type as string | undefined),
      og_url:
        payload.meta?.og_url ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_url as string | undefined),
      og_site_name:
        payload.meta?.og_site_name ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_site_name as string | undefined),
      og_locale:
        payload.meta?.og_locale ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.og_locale as string | undefined),
      article_author:
        payload.meta?.article_author ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.article_author as string | undefined),
      article_section:
        payload.meta?.article_section ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.article_section as string | undefined),
      article_tags:
        payload.meta?.article_tags ??
        ((nextAnalytics.seoMeta as Record<string, unknown> | undefined)
          ?.article_tags as string[] | undefined),
    };

    nextAnalytics.seoMeta = buildExtendedBlogMeta({
      title: payload.title ?? existingBlog.title,
      excerpt: payload.excerpt ?? existingBlog.excerpt,
      slug: existingBlog.slug,
      meta: nextMetaInput,
      categories: payload.categories ?? existingBlog.categories,
      tags: payload.tags ?? existingBlog.tags,
      authorName: existingBlog.authorName || existingBlog.business.authorName,
      businessName: existingBlog.business.businessName,
      businessWebsiteUrl: existingBlog.business.businessWebsiteUrl,
      defaultLocale: existingBlog.business.defaultLocale,
    });

    if (
      payload.content !== undefined
    ) {
      const nextSlug = existingBlog.slug;
      const nextContent = payload.content ?? existingBlog.content;
      const nextBusinessWebsiteUrl = existingBlog.business.businessWebsiteUrl || "";
      const draftBlogBaseUrl = buildDraftBlogBaseUrl(
        nextBusinessWebsiteUrl,
        nextSlug,
      );
      const { totalExternalLinks } = getBlogExternalLinkMetrics({
        html: nextContent,
        sourceBaseUrl: draftBlogBaseUrl || nextBusinessWebsiteUrl,
        currentBusinessWebsiteUrl: nextBusinessWebsiteUrl,
      });

      nextAnalytics.externalLinksCount = totalExternalLinks;
      nextAnalytics.managedCrossLinksCount =
        (nextAnalytics.managedCrossLinksCount as number | undefined) ?? 0;
    }

    if (Object.keys(nextAnalytics).length > 0) {
      updateData.analytics = JSON.parse(JSON.stringify(nextAnalytics));
    }

    const updatedBlog = await prisma.blog.update({
      where: { id: blogId },
      data: updateData,
      include: {
        meta: true,
        customField: true,
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            defaultLocale: true,
            businessCountry: true,
            businessState: true,
            businessCity: true,
          },
        },
        publishedBlogs: {
          select: {
            id: true,
            platform: true,
            status: true,
            externalPostId: true,
            externalPostUrl: true,
            publishedAt: true,
          },
        },
      },
    });

    const pineconePayload: BlogPayload = {
      title: updatedBlog.title,
      content: updatedBlog.content,
      userId: updatedBlog.userId,
      businessId: updatedBlog.businessId,
      tags: updatedBlog.tags,
      categories: updatedBlog.categories,
      seoDescription: updatedBlog.meta.seo_description,
    };
    upsertBlog(updatedBlog.id, pineconePayload).catch(console.error);

    await queueBlogDistributionIfDue({
      blogId: updatedBlog.id,
      businessId: updatedBlog.businessId,
      status: updatedBlog.status,
      blogPublishDate: updatedBlog.blogPublishDate,
      blogPublishTime: updatedBlog.blogPublishTime,
      business: updatedBlog.business,
    });

    console.log(`✅ Blog ${blogId} updated successfully by user ${authUserId}`);
    await invalidateTenantCache(authUserId, updatedBlog.businessId);

    return sendSuccess(
      res,
      {
        blog: updatedBlog,
        hasPublishedVersions: updatedBlog.publishedBlogs.length > 0,
      },
      "Blog updated successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error updating blog:", error);
    return sendError(res, "Failed to update blog", 500, error);
  }
}
