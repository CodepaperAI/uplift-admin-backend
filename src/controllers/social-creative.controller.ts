import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { loadSocialCreativeBrandContext } from "../services/social-creative/brand-context";
import { isSocialCreativeGenerationEnabled } from "../services/social-creative/constants";
import { normalizeSocialPlatforms } from "../services/social-creative/formats";
import { estimateSocialCreativeImageBudget } from "../services/social-creative/pipeline";
import { SOCIAL_PLATFORM_COPY_LIMITS } from "../services/social-creative/platform-copy";
import type { SocialPlatform } from "../services/social-creative/types";
import { checkSiteFeatureAccess } from "../services/website-plan-entitlement.service";
import {
  resolveAutomaticSocialPublishSlots,
  resolveSocialTopicImagePlatforms,
  resolveSocialTopicPublishPlatforms,
} from "../utils/social-platform-schedule.utils";
import {
  markInitialSocialTopicPlanFailed,
  markInitialSocialTopicPlanQueued,
  publicSocialTopicInitialization,
} from "../services/social-topic-initialization.service";
import {
  createOrGetSocialCreativeRun,
  getSocialCreativeRunForUser,
  listSocialCalendarForUser,
  listSocialCreativeRunsForUser,
} from "../services/social-creative/repository";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  claimSocialCarouselRun,
  socialCreativeKindForTopic,
} from "../services/social-carousel-scheduling.service";

const generationSchema = z.object({
  businessId: z.string().uuid(),
  topic: z.string().trim().min(3).max(300),
  kind: z.enum(["single", "carousel"]).default("single"),
  source: z
    .enum(["MANUAL", "BLOG", "SCHEDULE", "ONBOARDING"])
    .default("MANUAL"),
  sourceBlogId: z.string().uuid().nullish(),
  sourcePlanId: z.string().uuid().nullish(),
  socialTopicPlanId: z.string().uuid().nullish(),
  platforms: z
    .array(z.enum(["instagram", "facebook", "linkedin", "x"]))
    .min(1)
    .max(4)
    .optional(),
  platform: z.enum(["instagram", "facebook", "linkedin", "x"]).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const topicPlanRequestSchema = z.object({
  businessId: z.string().uuid(),
  source: z.enum(["INITIAL", "ROLLING"]).default("INITIAL"),
});

const listSchema = z.object({
  businessId: z.string().uuid(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const calendarSchema = z
  .object({
    businessId: z.string().uuid(),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((value) => value.to >= value.from, {
    message: "Calendar end must be after start",
  })
  .refine(
    (value) => value.to.getTime() - value.from.getTime() <= 120 * 86_400_000,
    { message: "Calendar range cannot exceed 120 days" },
  );

type SocialCreativeFeatureAccessChecker = (
  businessId: string,
  feature: "social_generation",
) => Promise<{ hasAccess: boolean; message?: string }>;

export async function getSocialCreativeRetryEntitlementError(
  businessId: string,
  checkFeatureAccess: SocialCreativeFeatureAccessChecker =
    checkSiteFeatureAccess,
): Promise<string | null> {
  const access = await checkFeatureAccess(businessId, "social_generation");
  return access.hasAccess
    ? null
    : access.message || "No active social entitlement";
}

export async function assertOwnedSocialCreativeGenerationBusiness(
  input: { businessId: string; userId: string },
  prismaClient: PrismaClient = prisma,
): Promise<void> {
  const business = await prismaClient.business.findFirst({
    where: {
      id: input.businessId,
      userId: input.userId,
      isActive: true,
    },
    select: { id: true },
  });
  if (!business) throw new Error("Business not found or ownership mismatch");
}

export async function loadSocialCreativeBrandAfterEntitlement(
  input: { businessId: string; userId: string },
  access: { hasAccess: boolean },
  loadBrand: typeof loadSocialCreativeBrandContext =
    loadSocialCreativeBrandContext,
) {
  if (!access.hasAccess) return null;
  return loadBrand(input, prisma);
}

export function mapSocialCreativeRequestError(
  error: unknown,
): { status: number; message: string } | null {
  const message = error instanceof Error ? error.message : "";
  if (message === "Business not found or ownership mismatch") {
    return { status: 404, message: "Business not found" };
  }
  if (
    message === "Social creative idempotency key ownership mismatch" ||
    message === "Social creative idempotency key input mismatch" ||
    message === "Social creative idempotency key request mismatch"
  ) {
    return { status: 409, message: "Social creative idempotency key conflict" };
  }
  return null;
}

type PublicSocialPlatformCopy = Partial<
  Record<SocialPlatform, { caption: string; hashtags: string[] }>
>;

type PublicSocialPlatformCopyVariants = Partial<
  Record<
    SocialPlatform,
    Array<{
      slot: "primary" | "lunch" | "evening";
      caption: string;
      hashtags: string[];
    }>
  >
>;

function publicSocialPlatformSchedule(input: {
  platforms: readonly SocialPlatform[];
  scheduledFor?: Date | null;
  timezone?: string | null;
}) {
  if (!input.scheduledFor || !input.timezone) return [];
  return input.platforms.flatMap((platform) =>
    resolveAutomaticSocialPublishSlots({
      platform,
      topicScheduledFor: input.scheduledFor,
      timeZone: input.timezone,
    }).map((slot) => ({
      platform,
      slot: slot.id,
      scheduledFor: slot.scheduledFor.toISOString(),
      mediaMode: slot.mediaMode,
    })),
  );
}

const PUBLIC_SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "x",
] as const satisfies readonly SocialPlatform[];

const PUBLIC_HASHTAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_]{0,39}$/u;
const UNSAFE_CAPTION_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PUBLIC_SOCIAL_COPY_SLOTS = new Set(["primary", "lunch", "evening"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicBrandLogoUrl(
  contentPlan: Record<string, unknown> | null,
): string | null {
  const references = contentPlan?.brandReferences;
  const candidates = [
    contentPlan?.brandLogoUrl,
    ...(Array.isArray(references)
      ? references.flatMap((reference) =>
          isRecord(reference) && reference.role === "logo"
            ? [reference.url]
            : [],
        )
      : []),
  ];

  for (const value of candidates) {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate || candidate.length > 2_048) continue;

    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname
      ) {
        continue;
      }
      return url.toString();
    } catch {
      continue;
    }
  }

  return null;
}

function sanitizePublicCaption(
  value: unknown,
  maxCharacters: number,
): string | null {
  if (typeof value !== "string") return null;
  const caption = value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (
    caption.length < 3 ||
    caption.length > maxCharacters ||
    UNSAFE_CAPTION_CONTROL_CHARACTERS.test(caption)
  ) {
    return null;
  }
  return caption;
}

function sanitizePublicHashtags(
  value: unknown,
  maxHashtags: number,
): string[] | null {
  if (!Array.isArray(value)) return null;
  if (maxHashtags <= 0) return [];
  const hashtags: string[] = [];
  const seen = new Set<string>();
  for (const rawHashtag of value) {
    if (typeof rawHashtag !== "string") continue;
    const hashtag = rawHashtag
      .normalize("NFC")
      .trim()
      .replace(/^#+/, "");
    if (!PUBLIC_HASHTAG_PATTERN.test(hashtag)) continue;
    const dedupeKey = hashtag.toLocaleLowerCase("en-US");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    hashtags.push(hashtag);
    if (hashtags.length === maxHashtags) break;
  }
  return hashtags;
}

function sanitizePublicPlatformCopy(
  value: unknown,
): PublicSocialPlatformCopy | null {
  if (!isRecord(value)) return null;
  const platformCopy: PublicSocialPlatformCopy = {};
  for (const platform of PUBLIC_SOCIAL_PLATFORMS) {
    const rawCopy = value[platform];
    if (!isRecord(rawCopy)) continue;
    const limits = SOCIAL_PLATFORM_COPY_LIMITS[platform];
    const caption = sanitizePublicCaption(rawCopy.caption, limits.maxCharacters);
    const hashtags = sanitizePublicHashtags(
      rawCopy.hashtags,
      limits.maxHashtags,
    );
    if (!caption || !hashtags) continue;

    while (
      hashtags.length > 0 &&
      [caption, hashtags.map((hashtag) => `#${hashtag}`).join(" ")]
        .filter(Boolean)
        .join("\n\n").length > limits.maxCharacters
    ) {
      hashtags.pop();
    }
    platformCopy[platform] = { caption, hashtags };
  }
  return Object.keys(platformCopy).length > 0 ? platformCopy : null;
}

function sanitizePublicPlatformCopyVariants(
  value: unknown,
): PublicSocialPlatformCopyVariants | null {
  if (!isRecord(value)) return null;
  const platformCopyVariants: PublicSocialPlatformCopyVariants = {};
  for (const platform of PUBLIC_SOCIAL_PLATFORMS) {
    const rawVariants = value[platform];
    if (!Array.isArray(rawVariants)) continue;
    const limits = SOCIAL_PLATFORM_COPY_LIMITS[platform];
    const seenSlots = new Set<string>();
    const variants: NonNullable<
      PublicSocialPlatformCopyVariants[typeof platform]
    > = [];
    for (const rawVariant of rawVariants) {
      if (!isRecord(rawVariant) || typeof rawVariant.slot !== "string") {
        continue;
      }
      const slot = rawVariant.slot.trim().toLowerCase();
      if (!PUBLIC_SOCIAL_COPY_SLOTS.has(slot) || seenSlots.has(slot)) continue;
      const caption = sanitizePublicCaption(
        rawVariant.caption,
        limits.maxCharacters,
      );
      const hashtags = sanitizePublicHashtags(
        rawVariant.hashtags,
        limits.maxHashtags,
      );
      if (!caption || !hashtags) continue;
      seenSlots.add(slot);
      variants.push({
        slot: slot as "primary" | "lunch" | "evening",
        caption,
        hashtags,
      });
    }
    if (variants.length > 0) platformCopyVariants[platform] = variants;
  }
  return Object.keys(platformCopyVariants).length > 0
    ? platformCopyVariants
    : null;
}

export function serializeSocialCreativeRun(run: any) {
  const {
    business,
    socialTopicPlan,
    sourcePlan,
    _usage: _runUsage,
    ...publicRun
  } = run;
  const rawContentPlan = isRecord(run.contentPlan) ? run.contentPlan : null;
  const platformCopy = sanitizePublicPlatformCopy(rawContentPlan?.platformCopy);
  const platformCopyVariants = sanitizePublicPlatformCopyVariants(
    rawContentPlan?.platformCopyVariants,
  );
  const storedRequestedPlatforms = normalizeSocialPlatforms(
    run.requestedPlatforms,
  );
  const requestedPlatforms = socialTopicPlan
    ? resolveSocialTopicPublishPlatforms({
        platforms: storedRequestedPlatforms,
        topicScheduledFor: socialTopicPlan.scheduledFor,
        timeZone: socialTopicPlan.timezone,
      })
    : storedRequestedPlatforms;
  const imagePlatforms = socialTopicPlan
    ? resolveSocialTopicImagePlatforms({
        platforms: requestedPlatforms,
        topicScheduledFor: socialTopicPlan.scheduledFor,
        timeZone: socialTopicPlan.timezone,
      })
    : requestedPlatforms;
  const platformSchedule = publicSocialPlatformSchedule({
    platforms: requestedPlatforms,
    scheduledFor: socialTopicPlan?.scheduledFor,
    timezone: socialTopicPlan?.timezone,
  });
  const contentPlan = rawContentPlan
    ? {
        ...Object.fromEntries(
          Object.entries(rawContentPlan).filter(
            ([key]) =>
              key !== "_usage" &&
              key !== "platformCopy" &&
              key !== "platformCopyVariants",
          ),
        ),
        ...(platformCopy ? { platformCopy } : {}),
        ...(platformCopyVariants ? { platformCopyVariants } : {}),
      }
    : run.contentPlan;
  return {
    ...publicRun,
    requestedPlatforms,
    imagePlatforms,
    platformSchedule,
    contentSetId: run.id,
    brandName: business?.businessName ?? null,
    brandLogoUrl: publicBrandLogoUrl(rawContentPlan),
    schedule:
      run.source === "SCHEDULE" && !socialTopicPlan && sourcePlan?.publishDate
        ? {
            date: sourcePlan.publishDate,
            time: sourcePlan.publishTime || "00:00",
          }
        : null,
    scheduledFor: socialTopicPlan?.scheduledFor?.toISOString?.() ?? null,
    scheduleTimezone: socialTopicPlan?.timezone ?? null,
    contentPlan,
    estimatedBudgetUsd: Number(run.estimatedBudgetUsd ?? 0),
    actualCostUsd: Number(run.actualCostUsd ?? 0),
    posts: (run.posts ?? []).map((post: any) => {
      const { platformCopy: _rawPostPlatformCopy, ...publicPost } = post;
      return {
        ...publicPost,
        ...(platformCopy ? { platformCopy } : {}),
        ...(platformCopyVariants ? { platformCopyVariants } : {}),
        assets: (post.assets ?? []).map((asset: any) => {
          const {
            providerArtifactUrl: _providerArtifactUrl,
            uploadMetadata: _uploadMetadata,
            prompt: _prompt,
            ...publicAsset
          } = asset;
          return {
            ...publicAsset,
            estimatedUsd: Number(asset.estimatedUsd ?? 0),
            actualUsd:
              asset.actualUsd === null || asset.actualUsd === undefined
                ? null
                : Number(asset.actualUsd),
          };
        }),
      };
    }),
    publishingEnabled: Boolean(process.env.ZERNIO_API_KEY?.trim()),
  };
}

export async function listSocialCreativeRuns(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = listSchema.parse(req.query);
    const result = await listSocialCreativeRunsForUser(
      { ...input, userId },
      prisma,
    );
    return sendSuccess(res, {
      businessId: input.businessId,
      businessName: result.businessName,
      initialization: publicSocialTopicInitialization(result.initialization),
      items: result.items.map((run) =>
        serializeSocialCreativeRun({ ...run, business: { businessName: result.businessName } }),
      ),
      nextCursor: result.nextCursor,
      limit: input.limit,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid social creative list request", 400, {
        code: "VALIDATION_ERROR",
        details: error.flatten(),
      });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "Business not found or ownership mismatch") {
      return sendError(res, "Business not found", 404);
    }
    if (message === "Social creative cursor not found") {
      return sendError(res, "Social creative cursor not found", 400);
    }
    console.error("[social-creative] list failed", error);
    return sendError(res, "Social creative list failed", 500);
  }
}

export async function requestSocialCreativeGeneration(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    if (!isSocialCreativeGenerationEnabled()) {
      return sendError(res, "Social creative generation is currently disabled", 503);
    }
    const requestedInput = generationSchema.parse(req.body);
    let input = requestedInput;
    let topicPlanSchedule: {
      scheduledFor: Date;
      timezone: string;
    } | null = null;
    if (requestedInput.socialTopicPlanId) {
      const topicPlan = await prisma.socialTopicPlan.findFirst({
        where: {
          id: requestedInput.socialTopicPlanId,
          userId,
          businessId: requestedInput.businessId,
        },
        select: {
          id: true,
          topic: true,
          platforms: true,
          scheduledFor: true,
          timezone: true,
          sourceSeoPlanId: true,
          carouselWeekAssignment: { select: { status: true } },
          business: {
            select: {
              socialAutomationSettings: {
                select: { carouselEnabled: true },
              },
            },
          },
        },
      });
      if (!topicPlan) {
        return sendError(res, "Social calendar topic not found", 404);
      }
      topicPlanSchedule = {
        scheduledFor: topicPlan.scheduledFor,
        timezone: topicPlan.timezone,
      };
      const publishPlatforms = resolveSocialTopicPublishPlatforms({
        platforms: normalizeSocialPlatforms(topicPlan.platforms),
        topicScheduledFor: topicPlan.scheduledFor,
        timeZone: topicPlan.timezone,
      });
      if (publishPlatforms.length === 0) {
        return sendError(
          res,
          "This topic has no publishing destination on its scheduled local day",
          409,
          { code: "SOCIAL_TOPIC_HAS_NO_PUBLISHING_SLOT" },
        );
      }
      input = {
        ...requestedInput,
        topic: topicPlan.topic,
        kind: socialCreativeKindForTopic({
          carouselEnabled:
            topicPlan.business.socialAutomationSettings?.carouselEnabled,
          carouselAssignmentStatus: topicPlan.carouselWeekAssignment?.status,
        }),
        source: "SCHEDULE",
        sourcePlanId: topicPlan.sourceSeoPlanId,
        platforms: publishPlatforms,
        platform: undefined,
        idempotencyKey: `social-topic-run:${topicPlan.id}:${
          topicPlan.carouselWeekAssignment?.status === "SELECTED" &&
          topicPlan.business.socialAutomationSettings?.carouselEnabled !== false
            ? "carousel-v1"
            : "v1"
        }`,
      };
    }
    await assertOwnedSocialCreativeGenerationBusiness(
      { businessId: input.businessId, userId },
      prisma,
    );
    const access = await checkSiteFeatureAccess(
      input.businessId,
      "social_generation",
    );
    if (!access.hasAccess) {
      return sendError(res, access.message || "No active site entitlement", 403);
    }
    if (input.sourceBlogId) {
      const sourceBlog = await prisma.blog.findFirst({
        where: {
          id: input.sourceBlogId,
          userId,
          businessId: input.businessId,
        },
        select: { id: true },
      });
      if (!sourceBlog) return sendError(res, "Source blog not found", 400);
    }
    if (input.sourcePlanId) {
      const sourcePlan = await prisma.plan.findFirst({
        where: {
          id: input.sourcePlanId,
          userId,
          businessId: input.businessId,
        },
        select: { id: true },
      });
      if (!sourcePlan) return sendError(res, "Source plan not found", 400);
    }
    await loadSocialCreativeBrandAfterEntitlement(
      { businessId: input.businessId, userId },
      access,
    );
    const platforms = normalizeSocialPlatforms(
      input.platform ? [input.platform] : input.platforms,
    );
    const imagePlatforms = topicPlanSchedule
      ? resolveSocialTopicImagePlatforms({
          platforms,
          topicScheduledFor: topicPlanSchedule.scheduledFor,
          timeZone: topicPlanSchedule.timezone,
        })
      : platforms;
    const estimatedBudgetUsd = estimateSocialCreativeImageBudget({
      kind: input.kind,
      platforms: imagePlatforms,
    });
    const run = await createOrGetSocialCreativeRun(
      {
        ...input,
        userId,
        platforms,
        estimatedBudgetUsd,
      },
      prisma,
    );
    if (input.kind === "carousel" && input.socialTopicPlanId) {
      await claimSocialCarouselRun({
        topicPlanId: input.socialTopicPlanId,
        runId: run.id,
        prisma,
      });
    }
    if (run.status === "PENDING") {
      await inngest.send({
        name: "social/creative.requested",
        data: { runId: run.id, businessId: run.businessId },
      });
    }
    if (input.socialTopicPlanId && run.status !== "COMPLETE") {
      await prisma.socialTopicPlan.updateMany({
        where: {
          id: input.socialTopicPlanId,
          userId,
          businessId: input.businessId,
        },
        data: {
          status: "GENERATING",
          platforms,
          failureCode: null,
          failureMessage: null,
        },
      });
    }
    return sendSuccess(
      res,
      {
        runId: run.id,
        status: run.status,
        estimatedImageCostUsd: Number(run.estimatedBudgetUsd ?? estimatedBudgetUsd),
        platforms,
        imagePlatforms,
        slides: run.plannedSlides,
        publishingEnabled: Boolean(process.env.ZERNIO_API_KEY?.trim()),
        generationMode: "website-campaign",
      },
      run.status === "PENDING"
        ? "Social creative generation queued"
        : "Existing social creative run returned",
      202,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid social creative request", 400, {
        code: "VALIDATION_ERROR",
        message: error.message,
        details: error.flatten(),
      });
    }
    const mapped = mapSocialCreativeRequestError(error);
    if (mapped) {
      return sendError(res, mapped.message, mapped.status);
    }
    const message = error instanceof Error ? error.message : "";
    console.error("[social-creative] request failed", error);
    return sendError(
      res,
      message || "Social creative request failed",
      500,
    );
  }
}

export async function retryFailedSocialCreativeAssets(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = req.authUserId;
  if (!userId) return sendError(res, "Unauthorized", 401);
  if (!isSocialCreativeGenerationEnabled()) {
    return sendError(res, "Social creative generation is currently disabled", 503);
  }

  const runId = String(req.params.runId ?? "").trim();
  if (!z.string().uuid().safeParse(runId).success) {
    return sendError(res, "Valid runId is required", 400);
  }

  try {
    const run = await getSocialCreativeRunForUser({ runId, userId }, prisma);
    if (!run) return sendError(res, "Social creative run not found", 404);

    const entitlementError = await getSocialCreativeRetryEntitlementError(
      run.businessId,
    );
    if (entitlementError) {
      return sendError(res, entitlementError, 403);
    }

    const failedAssets = run.posts.flatMap((post) =>
      post.assets.filter((asset) => asset.status === "FAILED"),
    );
    if (failedAssets.length === 0) {
      return sendSuccess(res, {
        runId,
        queued: false,
        retriedAssets: 0,
        status: run.status,
      });
    }
    if (run.status === "RENDERING") {
      return sendSuccess(
        res,
        {
          runId,
          queued: false,
          retriedAssets: failedAssets.length,
          status: run.status,
        },
        "Failed social creatives are already retrying",
        202,
      );
    }
    if (run.status !== "FAILED") {
      return sendError(res, "Social creative run is not ready to retry", 409);
    }

    const claimed = await prisma.socialCreativeRun.updateMany({
      where: { id: runId, userId, status: "FAILED" },
      data: {
        status: "RENDERING",
        errorCode: null,
        errorMessage: null,
        failureStage: null,
        completedAt: null,
      },
    });
    if (claimed.count === 0) {
      return sendSuccess(
        res,
        {
          runId,
          queued: false,
          retriedAssets: failedAssets.length,
          status: "RENDERING",
        },
        "Failed social creatives are already retrying",
        202,
      );
    }

    try {
      await inngest.send(
        failedAssets.map((asset) => ({
          name: "social/creative.asset.requested" as const,
          data: {
            assetId: asset.id,
            runId,
            businessId: run.businessId,
          },
        })),
      );
    } catch (error) {
      await prisma.socialCreativeRun.updateMany({
        where: { id: runId, userId, status: "RENDERING" },
        data: {
          status: "FAILED",
          errorCode: "SOCIAL_CREATIVE_RETRY_DISPATCH_FAILED",
          errorMessage:
            error instanceof Error ? error.message.slice(0, 2_000) : "Retry dispatch failed",
          failureStage: "dispatch",
          completedAt: new Date(),
        },
      });
      throw error;
    }

    return sendSuccess(
      res,
      {
        runId,
        queued: true,
        retriedAssets: failedAssets.length,
        status: "RENDERING",
      },
      "Failed social creatives queued for retry",
      202,
    );
  } catch (error) {
    console.error("[social-creative] retry failed", error);
    return sendError(
      res,
      error instanceof Error
        ? error.message
        : "Failed social creatives could not be retried",
      500,
    );
  }
}

export async function requestSocialTopicPlan(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = topicPlanRequestSchema.parse(req.body);
    const business = await prisma.business.findFirst({
      where: { id: input.businessId, userId, isActive: true },
      select: {
        id: true,
        socialAutomationSettings: {
          select: {
            initialPlanStatus: true,
            initialPlanQueuedAt: true,
            initialPlanStartedAt: true,
            initialPlanGeneratedAt: true,
            initialPlanErrorCode: true,
            initialPlanErrorMessage: true,
          },
        },
      },
    });
    if (!business) {
      return sendError(res, "Business not found", 404, {
        code: "BUSINESS_NOT_FOUND",
      });
    }
    const access = await checkSiteFeatureAccess(
      input.businessId,
      "social_generation",
    );
    if (!access.hasAccess) {
      return sendError(res, access.message || "No active social entitlement", 403);
    }

    if (
      input.source === "INITIAL" &&
      business.socialAutomationSettings?.initialPlanGeneratedAt
    ) {
      return sendSuccess(res, {
        businessId: input.businessId,
        source: input.source,
        queued: false,
        initialization: publicSocialTopicInitialization(
          business.socialAutomationSettings,
        ),
      });
    }

    if (input.source === "INITIAL") {
      await markInitialSocialTopicPlanQueued(prisma, input.businessId);
    }

    try {
      const queued = await inngest.send({
        name: "social/topics.plan.requested",
        data: {
          userId,
          businessId: input.businessId,
          source: input.source,
        },
      });
      if (!queued.ids?.length) {
        throw new Error("Social topic planner was not queued");
      }
    } catch (queueError) {
      if (input.source === "INITIAL") {
        await markInitialSocialTopicPlanFailed(
          prisma,
          input.businessId,
          queueError,
        );
      }
      throw queueError;
    }

    const initialization =
      input.source === "INITIAL"
        ? await prisma.socialAutomationSettings.findUnique({
            where: { businessId: input.businessId },
            select: {
              initialPlanStatus: true,
              initialPlanQueuedAt: true,
              initialPlanStartedAt: true,
              initialPlanGeneratedAt: true,
              initialPlanErrorCode: true,
              initialPlanErrorMessage: true,
            },
          })
        : null;
    return sendSuccess(
      res,
      {
        businessId: input.businessId,
        source: input.source,
        queued: true,
        initialization: initialization
          ? publicSocialTopicInitialization(initialization)
          : null,
      },
      "Social topic planning queued",
      202,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid social topic plan request", 400, {
        code: "VALIDATION_ERROR",
        details: error.flatten(),
      });
    }
    console.error("[social-creative] topic planning failed", error);
    return sendError(
      res,
      "Social topic planning could not be queued. Please try again.",
      500,
      { code: "SOCIAL_TOPIC_QUEUE_FAILED" },
    );
  }
}

export async function listSocialCalendar(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = calendarSchema.parse(req.query);
    const result = await listSocialCalendarForUser(
      { ...input, userId },
      prisma,
    );
    return sendSuccess(res, {
      businessId: input.businessId,
      businessName: result.businessName,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      initialization: publicSocialTopicInitialization(result.initialization),
      items: result.items.map((item) => ({
        ...(() => {
          const platforms = resolveSocialTopicPublishPlatforms({
            platforms: normalizeSocialPlatforms(item.platforms),
            topicScheduledFor: item.scheduledFor,
            timeZone: item.timezone,
          });
          return {
            platforms,
            imagePlatforms: resolveSocialTopicImagePlatforms({
              platforms,
              topicScheduledFor: item.scheduledFor,
              timeZone: item.timezone,
            }),
            platformSchedule: publicSocialPlatformSchedule({
              platforms,
              scheduledFor: item.scheduledFor,
              timezone: item.timezone,
            }),
          };
        })(),
        id: item.id,
        topic: item.topic,
        status: item.status,
        scheduledFor: item.scheduledFor.toISOString(),
        timezone: item.timezone,
        contentPillar: item.contentPillar,
        objective: item.objective,
        kind:
          item.carouselWeekAssignment?.status === "SELECTED"
            ? "carousel"
            : "single",
        creativeRun: item.creativeRun
          ? serializeSocialCreativeRun({
              ...item.creativeRun,
              business: { businessName: result.businessName },
              socialTopicPlan: {
                scheduledFor: item.scheduledFor,
                timezone: item.timezone,
              },
            })
          : null,
      })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid social calendar request", 400, {
        code: "VALIDATION_ERROR",
        details: error.flatten(),
      });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "Business not found or ownership mismatch") {
      return sendError(res, "Business not found", 404);
    }
    console.error("[social-creative] calendar failed", error);
    return sendError(res, "Social calendar failed", 500);
  }
}

export async function getSocialCreativeRun(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const runId = String(req.params.runId ?? "").trim();
    if (!z.string().uuid().safeParse(runId).success) {
      return sendError(res, "Valid runId is required", 400);
    }
    const run = await getSocialCreativeRunForUser({ runId, userId }, prisma);
    if (!run) return sendError(res, "Social creative run not found", 404);
    return sendSuccess(res, serializeSocialCreativeRun(run));
  } catch (error) {
    console.error("[social-creative] status failed", error);
    return sendError(
      res,
      error instanceof Error ? error.message : "Social creative status failed",
      500,
    );
  }
}
