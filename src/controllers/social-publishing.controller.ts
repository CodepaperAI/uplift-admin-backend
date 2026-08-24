import { createHash } from "node:crypto";

import type { Request, Response } from "express";
import { z } from "zod";

import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import { deleteImageFromBunny } from "../lib/bunny-storage";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  createSocialPublishAttempts,
  deactivateZernioAccountForReconnect,
  disconnectZernioAccount,
  getSocialConnectionSummary,
  getZernioConnectUrl,
  listRunPublishAttempts,
  reconcileActiveSocialPublishAttempts,
  setDefaultZernioAccount,
  SocialPublishingError,
  syncZernioAccounts,
  zernioPostFailureDetails,
} from "../services/zernio/social-publishing.service";
import { ZernioApiError } from "../services/zernio/zernio.client";
import { zernioWebhookSignatureMatches } from "../services/zernio/zernio-webhook-signature";
import { checkSiteFeatureAccess } from "../services/website-plan-entitlement.service";
import {
  extractSocialPromotionDocument,
  SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE,
  SocialPromotionValidationError,
  uploadSocialPromotionImage,
} from "../services/social-promotion.service";
import { selectRecentPositiveGoogleReviews } from "../services/social-creative/brand-context";
import { sendError, sendSuccess } from "../utils/response.utils";

const businessSchema = z.object({ businessId: z.string().uuid() });
const socialReferenceScopeSchema = z.enum(["always", "promotion"]);
const socialReferenceScope = {
  always: "ALWAYS",
  promotion: "PROMOTION",
} as const;
export const publishingSettingsSchema = businessSchema
  .extend({
    approvalRequired: z.boolean().optional(),
    logoUsageMode: z.enum(["recommended", "always"]).optional(),
    carouselEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.approvalRequired !== undefined ||
      value.logoUsageMode !== undefined ||
      value.carouselEnabled !== undefined,
    { message: "Choose at least one social publishing setting" },
  );

function publicLogoUsageMode(value: "RECOMMENDED" | "ALWAYS" | undefined) {
  return value === "ALWAYS" ? ("always" as const) : ("recommended" as const);
}
const nullablePromotionText = (maximumLength: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim() || null : value,
    z.string().max(maximumLength).nullable(),
  );
const nullablePromotionContent = (maximumLength: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
            .replace(/\r\n?/g, "\n")
            .trim() || null
        : value,
    z.string().max(maximumLength).nullable(),
  );
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDate(value: string | null): value is string {
  if (!value || !LOCAL_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const socialPromotionSettingsSchema = businessSchema
  .extend({
    enabled: z.boolean(),
    title: nullablePromotionText(160),
    information: nullablePromotionContent(5_000),
    preferredContent: nullablePromotionContent(5_000),
    startsOn: nullablePromotionText(10),
    endsOn: nullablePromotionText(10),
  })
  .superRefine((value, context) => {
    for (const field of ["startsOn", "endsOn"] as const) {
      if (value[field] && !isCalendarDate(value[field])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Choose a valid calendar date",
        });
      }
    }
    if (value.enabled) {
      if (!value.title || value.title.length < 3) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["title"],
          message: "Promotion name is required",
        });
      }
      if (!value.information || value.information.length < 12) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["information"],
          message: "Add enough promotion information to generate accurate content",
        });
      }
      if (!isCalendarDate(value.startsOn)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startsOn"],
          message: "Promotion start date is required",
        });
      }
      if (!isCalendarDate(value.endsOn)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endsOn"],
          message: "Promotion end date is required",
        });
      }
    }
    if (
      isCalendarDate(value.startsOn) &&
      isCalendarDate(value.endsOn) &&
      value.endsOn < value.startsOn
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsOn"],
        message: "Promotion end date must be on or after its start date",
      });
    }
    if (isCalendarDate(value.startsOn) && isCalendarDate(value.endsOn)) {
      const durationDays =
        (Date.parse(`${value.endsOn}T00:00:00.000Z`) -
          Date.parse(`${value.startsOn}T00:00:00.000Z`)) /
          86_400_000 +
        1;
      if (durationDays > 366) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endsOn"],
          message: "Promotion duration cannot exceed 366 days",
        });
      }
    }
  });
const connectSchema = businessSchema.extend({
  platform: z.enum(["instagram", "facebook", "linkedin", "x"]),
});
const syncSchema = businessSchema.extend({
  preferredExternalAccountId: z.string().trim().min(1).max(200).nullish(),
});
const accountMutationSchema = businessSchema.extend({
  accountId: z.string().uuid(),
});
const publishSchema = z
  .object({
    businessId: z.string().uuid(),
    mode: z.enum(["NOW", "SCHEDULE"]),
    scheduledFor: z.coerce.date().nullish(),
    timezone: z.string().trim().min(1).max(100).default("UTC"),
    platforms: z
      .array(z.enum(["instagram", "facebook", "linkedin", "x"]))
      .min(1)
      .max(4)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "SCHEDULE" && !value.scheduledFor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledFor"],
        message: "Choose when this post should publish",
      });
    }
    if (
      value.scheduledFor &&
      value.scheduledFor.getTime() < Date.now() + 60_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledFor"],
        message: "Schedule posts at least one minute in the future",
      });
    }
    if (
      value.scheduledFor &&
      value.scheduledFor.getTime() > Date.now() + 366 * 86_400_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledFor"],
        message: "Social posts can be scheduled up to one year ahead",
      });
    }
  });

async function ownedBusiness(userId: string, businessId: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, userId, isActive: true },
    select: {
      id: true,
      businessName: true,
      businessWebsiteUrl: true,
    },
  });
  if (!business) {
    throw new SocialPublishingError(
      "Business not found",
      404,
      "BUSINESS_NOT_FOUND",
    );
  }
  return business;
}

async function assertPublishingEntitlement(businessId: string) {
  const access = await checkSiteFeatureAccess(businessId, "social_publishing");
  if (!access.hasAccess) {
    throw new SocialPublishingError(
      access.message || "Upgrade to SEO + Social to publish social content",
      403,
      "SOCIAL_PUBLISHING_NOT_INCLUDED",
    );
  }
}

function publicAccount(account: {
  id: string;
  platform: string;
  username: string | null;
  displayName: string | null;
  profileUrl: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastSyncedAt: Date;
}) {
  return {
    id: account.id,
    platform: account.platform,
    username: account.username,
    displayName: account.displayName,
    profileUrl: account.profileUrl,
    avatarUrl: account.avatarUrl,
    isActive: account.isActive,
    isDefault: account.isDefault,
    connectedAt: account.connectedAt.toISOString(),
    disconnectedAt: account.disconnectedAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt.toISOString(),
  };
}

function handleControllerError(res: Response, error: unknown, fallback: string) {
  if (error instanceof z.ZodError) {
    return sendError(res, "Invalid social publishing request", 400, {
      code: "VALIDATION_ERROR",
      details: error.flatten(),
    });
  }
  if (error instanceof SocialPublishingError) {
    return sendError(res, error.message, error.status, { code: error.code });
  }
  if (error instanceof SocialPromotionValidationError) {
    return sendError(res, error.message, error.statusCode, {
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof ZernioApiError) {
    return sendError(res, error.message, error.status, {
      code: error.code,
      retryable: error.retryable,
    });
  }
  console.error(`[social-publishing] ${fallback}`, error);
  return sendError(res, fallback, 500);
}

type SocialPromotionRecord = {
  enabled: boolean;
  title: string | null;
  information: string | null;
  preferredContent: string | null;
  startsOn: string | null;
  endsOn: string | null;
  imageUrl: string | null;
  imageName: string | null;
  imageMimeType: string | null;
  imageSizeBytes: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  documentName: string | null;
  documentMimeType: string | null;
  documentSizeBytes: number | null;
  documentText: string | null;
};

type SocialReferenceImageRecord = {
  id: string;
  scope: "ALWAYS" | "PROMOTION";
  url: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

function publicSocialReferenceImage(image: SocialReferenceImageRecord) {
  return {
    id: image.id,
    url: image.url,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    createdAt: image.createdAt.toISOString(),
  };
}

function publicSocialPromotion(
  promotion: SocialPromotionRecord | null,
  timezone: string,
  references: SocialReferenceImageRecord[] = [],
  googleReviewCreative: {
    eligible: boolean;
    lastSyncAt: string | null;
    recentReviewCount: number;
  } = { eligible: false, lastSyncAt: null, recentReviewCount: 0 },
) {
  const alwaysReferences = references
    .filter((image) => image.scope === "ALWAYS")
    .map(publicSocialReferenceImage);
  const promotionReferences = references
    .filter((image) => image.scope === "PROMOTION")
    .map(publicSocialReferenceImage);
  const legacyPromotionImage = promotion?.imageUrl
    ? {
        id: `legacy-${createHash("sha256")
          .update(promotion.imageUrl)
          .digest("hex")
          .slice(0, 24)}`,
        url: promotion.imageUrl,
        name: promotion.imageName,
        mimeType: promotion.imageMimeType,
        sizeBytes: promotion.imageSizeBytes,
        width: promotion.imageWidth,
        height: promotion.imageHeight,
        createdAt: null,
      }
    : null;
  const promotionImages = promotionReferences.length
    ? promotionReferences
    : legacyPromotionImage
      ? [legacyPromotionImage]
      : [];
  return {
    timezone,
    googleReviewCreative,
    referenceImages: alwaysReferences,
    promotion: {
      enabled: promotion?.enabled ?? false,
      title: promotion?.title ?? null,
      information: promotion?.information ?? null,
      preferredContent: promotion?.preferredContent ?? null,
      startsOn: promotion?.startsOn ?? null,
      endsOn: promotion?.endsOn ?? null,
      images: promotionImages,
      image: promotionImages[0] ?? null,
      document: promotion?.documentName
        ? {
            name: promotion.documentName,
            mimeType: promotion.documentMimeType,
            sizeBytes: promotion.documentSizeBytes,
            textCharacters: promotion.documentText?.length ?? 0,
          }
        : null,
    },
  };
}

const socialPromotionSelect = {
  enabled: true,
  title: true,
  information: true,
  preferredContent: true,
  startsOn: true,
  endsOn: true,
  imageUrl: true,
  imageName: true,
  imageMimeType: true,
  imageSizeBytes: true,
  imageWidth: true,
  imageHeight: true,
  documentName: true,
  documentMimeType: true,
  documentSizeBytes: true,
  documentText: true,
} as const;

const socialReferenceImageSelect = {
  id: true,
  scope: true,
  url: true,
  name: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  createdAt: true,
} as const;

async function socialPromotionTimezone(businessId: string): Promise<string> {
  return (
    (
      await prisma.socialAutomationSettings.findUnique({
        where: { businessId },
        select: { timezone: true },
      })
    )?.timezone ?? "UTC"
  );
}

async function publicSocialSettings(
  businessId: string,
  promotion: SocialPromotionRecord | null,
) {
  const [timezone, references, gmb] = await Promise.all([
    socialPromotionTimezone(businessId),
    prisma.socialCreativeReferenceImage.findMany({
      where: { businessId },
      orderBy: [{ scope: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: socialReferenceImageSelect,
    }),
    prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        isActive: true,
        isDemo: true,
        accountId: true,
        locationId: true,
        lastSyncAt: true,
        gmbReviews: {
          where: { rating: { gte: 4 }, comment: { not: null } },
          orderBy: [{ reviewDate: "desc" }, { id: "asc" }],
          take: 10,
          select: { rating: true, comment: true, reviewDate: true },
        },
      },
    }),
  ]);
  const recentReviews = selectRecentPositiveGoogleReviews(gmb);
  return publicSocialPromotion(promotion, timezone, references, {
    eligible: recentReviews.length > 0,
    lastSyncAt: gmb?.lastSyncAt?.toISOString() ?? null,
    recentReviewCount: recentReviews.length,
  });
}

export async function getSocialConnections(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.query);
    await ownedBusiness(userId, businessId);
    const summary = await getSocialConnectionSummary(businessId, prisma);
    return sendSuccess(res, {
      ...summary,
      lastSyncedAt: summary.lastSyncedAt?.toISOString() ?? null,
      accounts: summary.accounts.map(publicAccount),
      supportedPlatforms: ["instagram", "facebook", "linkedin", "x"],
    });
  } catch (error) {
    return handleControllerError(res, error, "Social connections could not be loaded");
  }
}

export async function getSocialPublishingSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.query);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const settings = await prisma.socialAutomationSettings.findUnique({
      where: { businessId },
      select: {
        approvalRequired: true,
        logoUsageMode: true,
        carouselEnabled: true,
      },
    });
    const approvalRequired = settings?.approvalRequired ?? false;
    return sendSuccess(res, {
      approvalRequired,
      mode: approvalRequired ? "approval_required" : "auto_publish",
      logoUsageMode: publicLogoUsageMode(settings?.logoUsageMode),
      carouselEnabled: settings?.carouselEnabled ?? true,
    });
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Social publishing settings could not be loaded",
    );
  }
}

export async function updateSocialPublishingSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = publishingSettingsSchema.parse(req.body);
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const logoUsageMode = input.logoUsageMode?.toUpperCase() as
      | "RECOMMENDED"
      | "ALWAYS"
      | undefined;
    const settings = await prisma.socialAutomationSettings.upsert({
      where: { businessId: input.businessId },
      create: {
        businessId: input.businessId,
        enabled: true,
        approvalRequired: input.approvalRequired ?? false,
        logoUsageMode: logoUsageMode ?? "RECOMMENDED",
        carouselEnabled: input.carouselEnabled ?? true,
      },
      update: {
        ...(input.approvalRequired !== undefined
          ? { approvalRequired: input.approvalRequired }
          : {}),
        ...(logoUsageMode ? { logoUsageMode } : {}),
        ...(input.carouselEnabled !== undefined
          ? { carouselEnabled: input.carouselEnabled }
          : {}),
      },
      select: {
        approvalRequired: true,
        logoUsageMode: true,
        carouselEnabled: true,
      },
    });
    if (input.approvalRequired === false) {
      try {
        await inngest.send({
          name: "social/publish.ready.scan",
          data: { businessId: input.businessId },
        });
      } catch (error) {
        console.error(
          "[social-publishing] Could not request auto-publish scan after settings update",
          error,
        );
      }
    }
    if (input.carouselEnabled === true) {
      try {
        await inngest.send({
          name: "social/carousels.assign.requested",
          data: { businessId: input.businessId },
        });
      } catch (error) {
        console.error(
          "[social-publishing] Could not request weekly carousel assignment",
          error,
        );
      }
    }
    return sendSuccess(
      res,
      {
        approvalRequired: settings.approvalRequired,
        mode: settings.approvalRequired
          ? "approval_required"
          : "auto_publish",
        logoUsageMode: publicLogoUsageMode(settings.logoUsageMode),
        carouselEnabled: settings.carouselEnabled,
      },
      "Social publishing settings updated",
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Social publishing settings could not be updated",
    );
  }
}

export async function getSocialPromotionSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.query);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const promotion = await prisma.socialPromotionCampaign.findUnique({
      where: { businessId },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Promotion settings could not be loaded",
    );
  }
}

export async function updateSocialPromotionSettings(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = socialPromotionSettingsSchema.parse(req.body);
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const promotion = await prisma.socialPromotionCampaign.upsert({
      where: { businessId: input.businessId },
      create: {
        businessId: input.businessId,
        enabled: input.enabled,
        title: input.title,
        information: input.information,
        preferredContent: input.preferredContent,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      },
      update: {
        enabled: input.enabled,
        title: input.title,
        information: input.information,
        preferredContent: input.preferredContent,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(input.businessId, promotion),
      input.enabled ? "Promotion enabled" : "Promotion draft saved",
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Promotion settings could not be updated",
    );
  }
}

export async function uploadSocialPromotionImageController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.body);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File })
      .file;
    if (!file) {
      return sendError(res, "Promotion image is required", 400, {
        code: "SOCIAL_PROMOTION_IMAGE_REQUIRED",
        message: "Send one promotion image in the multipart field named image.",
      });
    }
    const image = await uploadSocialPromotionImage({
      buffer: file.buffer,
      businessId,
      declaredMimeType: file.mimetype,
      originalName: file.originalname,
    });
    const promotion = await prisma.socialPromotionCampaign.upsert({
      where: { businessId },
      create: {
        businessId,
        imageUrl: image.url,
        imageName: image.name,
        imageMimeType: image.mimeType,
        imageSizeBytes: image.sizeBytes,
        imageWidth: image.width,
        imageHeight: image.height,
        imageChecksumSha256: image.checksumSha256,
      },
      update: {
        imageUrl: image.url,
        imageName: image.name,
        imageMimeType: image.mimeType,
        imageSizeBytes: image.sizeBytes,
        imageWidth: image.width,
        imageHeight: image.height,
        imageChecksumSha256: image.checksumSha256,
      },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
      "Promotion image uploaded",
    );
  } catch (error) {
    return handleControllerError(res, error, "Promotion image could not be uploaded");
  }
}

export async function uploadSocialReferenceImagesController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.body);
    const publicScope = socialReferenceScopeSchema.parse(req.params.scope);
    const scope = socialReferenceScope[publicScope];
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const files = (
      req as AuthenticatedRequest & { files?: Express.Multer.File[] }
    ).files ?? [];
    if (files.length === 0) {
      return sendError(res, "Reference images are required", 400, {
        code: "SOCIAL_REFERENCE_IMAGES_REQUIRED",
        message: "Choose at least one JPEG, PNG, or WebP reference image.",
      });
    }
    const existingCount = await prisma.socialCreativeReferenceImage.count({
      where: { businessId, scope },
    });
    if (existingCount + files.length > SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE) {
      return sendError(res, "Too many reference images", 400, {
        code: "SOCIAL_REFERENCE_IMAGE_LIMIT",
        message: `Keep up to ${SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE} ${publicScope === "always" ? "always-on" : "promotion"} reference images.`,
      });
    }

    for (const file of files) {
      const image = await uploadSocialPromotionImage({
        buffer: file.buffer,
        businessId,
        declaredMimeType: file.mimetype,
        originalName: file.originalname,
        scope: publicScope,
      });
      await prisma.socialCreativeReferenceImage.upsert({
        where: {
          businessId_scope_checksumSha256: {
            businessId,
            scope,
            checksumSha256: image.checksumSha256,
          },
        },
        create: {
          businessId,
          scope,
          url: image.url,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          width: image.width,
          height: image.height,
          checksumSha256: image.checksumSha256,
        },
        update: {
          url: image.url,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          width: image.width,
          height: image.height,
        },
      });
    }
    const promotion = await prisma.socialPromotionCampaign.findUnique({
      where: { businessId },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
      `${files.length} reference image${files.length === 1 ? "" : "s"} added`,
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Reference images could not be uploaded",
    );
  }
}

export async function removeSocialReferenceImageController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.body);
    const imageId = z.string().trim().min(1).max(240).parse(req.params.imageId);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const image = await prisma.socialCreativeReferenceImage.findFirst({
      where: { id: imageId, businessId },
      select: { id: true, url: true },
    });
    if (!image) {
      return sendError(res, "Reference image not found", 404, {
        code: "SOCIAL_REFERENCE_IMAGE_NOT_FOUND",
      });
    }
    await prisma.socialCreativeReferenceImage.delete({ where: { id: image.id } });
    try {
      await deleteImageFromBunny(image.url);
    } catch (error) {
      console.error("[social-publishing] Reference image storage cleanup failed", {
        imageId: image.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const promotion = await prisma.socialPromotionCampaign.findUnique({
      where: { businessId },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
      "Reference image removed",
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Reference image could not be removed",
    );
  }
}

export async function uploadSocialPromotionDocumentController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.body);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File })
      .file;
    if (!file) {
      return sendError(res, "Promotion document is required", 400, {
        code: "SOCIAL_PROMOTION_DOCUMENT_REQUIRED",
        message:
          "Send one promotion document in the multipart field named document.",
      });
    }
    const document = await extractSocialPromotionDocument({
      buffer: file.buffer,
      declaredMimeType: file.mimetype,
      originalName: file.originalname,
    });
    const promotion = await prisma.socialPromotionCampaign.upsert({
      where: { businessId },
      create: {
        businessId,
        documentName: document.name,
        documentMimeType: document.mimeType,
        documentSizeBytes: document.sizeBytes,
        documentChecksumSha256: document.checksumSha256,
        documentText: document.text,
      },
      update: {
        documentName: document.name,
        documentMimeType: document.mimeType,
        documentSizeBytes: document.sizeBytes,
        documentChecksumSha256: document.checksumSha256,
        documentText: document.text,
      },
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
      "Promotion document added",
    );
  } catch (error) {
    return handleControllerError(
      res,
      error,
      "Promotion document could not be processed",
    );
  }
}

export async function removeSocialPromotionAsset(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = businessSchema.parse(req.body);
    const assetKind = z.enum(["image", "document"]).parse(req.params.assetKind);
    await ownedBusiness(userId, businessId);
    await assertPublishingEntitlement(businessId);
    const updates = {
      image: {
        imageUrl: null,
        imageName: null,
        imageMimeType: null,
        imageSizeBytes: null,
        imageWidth: null,
        imageHeight: null,
        imageChecksumSha256: null,
      },
      document: {
        documentName: null,
        documentMimeType: null,
        documentSizeBytes: null,
        documentChecksumSha256: null,
        documentText: null,
      },
    } as const;
    const promotion = await prisma.socialPromotionCampaign.upsert({
      where: { businessId },
      create: { businessId, ...updates[assetKind] },
      update: updates[assetKind],
      select: socialPromotionSelect,
    });
    return sendSuccess(
      res,
      await publicSocialSettings(businessId, promotion),
      `Promotion ${assetKind} removed`,
    );
  } catch (error) {
    return handleControllerError(res, error, "Promotion asset could not be removed");
  }
}

export async function createSocialConnectionUrl(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = connectSchema.parse(req.body);
    const business = await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const authUrl = await getZernioConnectUrl(
      {
        businessId: business.id,
        businessName: business.businessName || business.businessWebsiteUrl,
        websiteUrl: business.businessWebsiteUrl,
        platform: input.platform,
      },
      prisma,
    );
    return sendSuccess(res, { authUrl, platform: input.platform });
  } catch (error) {
    return handleControllerError(res, error, "Social connection could not be started");
  }
}

export async function syncSocialConnections(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = syncSchema.parse(req.body);
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const accounts = await syncZernioAccounts(input, prisma);
    if (accounts.some((account) => account.isActive && account.isDefault)) {
      try {
        await inngest.send({
          name: "social/publish.ready.scan",
          data: { businessId: input.businessId },
        });
      } catch (error) {
        // Account connection must remain successful. The 15-minute recovery
        // scan will pick up the ready content if this event dispatch is lost.
        console.error(
          "[social-publishing] Could not request ready-content auto-publish scan",
          error,
        );
      }
    }
    return sendSuccess(
      res,
      { businessId: input.businessId, accounts: accounts.map(publicAccount) },
      "Social accounts synchronized",
    );
  } catch (error) {
    return handleControllerError(res, error, "Social accounts could not be synchronized");
  }
}

export async function disconnectSocialConnection(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = accountMutationSchema.parse({
      ...req.body,
      accountId: req.params.accountId,
    });
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    await disconnectZernioAccount(input, prisma);
    return sendSuccess(res, { accountId: input.accountId }, "Social account disconnected");
  } catch (error) {
    return handleControllerError(res, error, "Social account could not be disconnected");
  }
}

export async function selectDefaultSocialConnection(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const input = accountMutationSchema.parse({
      ...req.body,
      accountId: req.params.accountId,
    });
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const account = await setDefaultZernioAccount(input, prisma);
    return sendSuccess(res, { accountId: account.id }, "Default social account updated");
  } catch (error) {
    return handleControllerError(res, error, "Default social account could not be updated");
  }
}

export async function requestSocialPublishing(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const runId = z.string().uuid().parse(req.params.runId);
    const input = publishSchema.parse(req.body);
    await ownedBusiness(userId, input.businessId);
    await assertPublishingEntitlement(input.businessId);
    const attempts = await createSocialPublishAttempts(
      {
        userId,
        businessId: input.businessId,
        runId,
        mode: input.mode,
        scheduledFor: input.scheduledFor,
        timezone: input.timezone,
        platforms: input.platforms,
      },
      prisma,
    );
    const queuedAttempts = attempts.filter((attempt) =>
      ["PENDING", "FAILED"].includes(attempt.status),
    );
    if (queuedAttempts.length > 0) {
      try {
        await inngest.send(
          queuedAttempts.map((attempt) => ({
            name: "social/publish.requested" as const,
            data: {
              attemptId: attempt.id,
              businessId: input.businessId,
              runId,
            },
          })),
        );
      } catch (error) {
        await prisma.socialPublishAttempt.updateMany({
          where: { id: { in: queuedAttempts.map((attempt) => attempt.id) }, status: "PENDING" },
          data: {
            status: "FAILED",
            lastErrorCode: "SOCIAL_PUBLISH_DISPATCH_FAILED",
            lastErrorMessage:
              error instanceof Error ? error.message.slice(0, 500) : "Queue dispatch failed",
          },
        });
        throw error;
      }
    }
    return sendSuccess(
      res,
      {
        runId,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          platform: attempt.platform,
          status: attempt.status,
          scheduledFor: attempt.scheduledFor?.toISOString() ?? null,
        })),
      },
      input.mode === "NOW" ? "Social publishing queued" : "Social posts scheduled",
      202,
    );
  } catch (error) {
    return handleControllerError(res, error, "Social publishing could not be queued");
  }
}

export async function getSocialPublishingStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const runId = z.string().uuid().parse(req.params.runId);
    await reconcileActiveSocialPublishAttempts({ userId, runId }, prisma);
    const attempts = await listRunPublishAttempts({ userId, runId }, prisma);
    return sendSuccess(res, {
      runId,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        platform: attempt.platform,
        mode: attempt.mode,
        status: attempt.status,
        scheduledFor: attempt.scheduledFor?.toISOString() ?? null,
        externalPostUrl: attempt.externalPostUrl,
        errorCode: attempt.lastErrorCode,
        errorMessage: attempt.lastErrorMessage,
        account: attempt.publisherAccount,
        updatedAt: attempt.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    return handleControllerError(res, error, "Social publishing status could not be loaded");
  }
}

export async function retrySocialPublishing(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const attemptId = z.string().uuid().parse(req.params.attemptId);
    const attempt = await prisma.socialPublishAttempt.findFirst({
      where: { id: attemptId, business: { userId } },
      select: {
        id: true,
        businessId: true,
        runId: true,
        status: true,
        publisherAccount: {
          select: {
            isActive: true,
            platform: true,
            displayName: true,
            username: true,
          },
        },
      },
    });
    if (!attempt) return sendError(res, "Social publish attempt not found", 404);
    if (attempt.status !== "FAILED") {
      return sendError(res, "Only failed social publishing can be retried", 409);
    }
    if (!attempt.publisherAccount.isActive) {
      const accountName =
        attempt.publisherAccount.displayName ??
        attempt.publisherAccount.username ??
        (attempt.publisherAccount.platform === "x"
          ? "X"
          : attempt.publisherAccount.platform);
      throw new SocialPublishingError(
        `Reconnect ${accountName} before retrying this post`,
        409,
        "SOCIAL_ACCOUNT_RECONNECT_REQUIRED",
      );
    }
    await assertPublishingEntitlement(attempt.businessId);
    await inngest.send({
      name: "social/publish.requested",
      data: {
        attemptId: attempt.id,
        businessId: attempt.businessId,
        runId: attempt.runId,
      },
    });
    return sendSuccess(res, { attemptId, queued: true }, "Social publishing retry queued", 202);
  } catch (error) {
    return handleControllerError(res, error, "Social publishing could not be retried");
  }
}

function webhookRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function webhookString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function handleZernioWebhook(req: Request, res: Response) {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET?.trim();
  if (!secret) return sendError(res, "Zernio webhook is not configured", 503);
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  const signature = webhookString(
    req.header("x-zernio-signature"),
    req.header("x-late-signature"),
  );
  if (
    !rawBody ||
    !signature ||
    !zernioWebhookSignatureMatches(rawBody, signature, secret)
  ) {
    return sendError(res, "Invalid webhook signature", 401);
  }

  const payload = webhookRecord(req.body);
  const data = webhookRecord(payload.data);
  const post = Object.keys(webhookRecord(data.post)).length
    ? webhookRecord(data.post)
    : webhookRecord(payload.post);
  const account = Object.keys(webhookRecord(data.account)).length
    ? webhookRecord(data.account)
    : webhookRecord(payload.account);
  const externalEventId = webhookString(
    payload.id,
    payload.eventId,
    req.header("x-zernio-event-id"),
    req.header("x-late-event-id"),
  );
  const eventType = webhookString(payload.type, payload.event);
  if (!externalEventId || !eventType) {
    return sendError(res, "Invalid webhook payload", 400);
  }
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");

  try {
    const existing = await prisma.zernioWebhookEvent.findUnique({
      where: { externalEventId },
    });
    if (existing && ["PROCESSED", "IGNORED"].includes(existing.status)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    await prisma.zernioWebhookEvent.upsert({
      where: { externalEventId },
      create: { externalEventId, eventType, payloadHash },
      update: {
        eventType,
        payloadHash,
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      },
    });

    const externalPostId = webhookString(
      post._id,
      post.id,
      data.postId,
      data._id,
      payload.postId,
    );
    let updated = 0;
    if (externalPostId && eventType.startsWith("post.")) {
      const status = eventType.includes("published")
        ? "PUBLISHED"
        : eventType.includes("failed")
          ? "FAILED"
          : eventType.includes("partial")
            ? "FAILED"
          : eventType.includes("cancel")
            ? "CANCELLED"
            : eventType.includes("scheduled")
              ? "SCHEDULED"
              : null;
      if (status) {
        const failure =
          status === "FAILED"
            ? zernioPostFailureDetails({
                ...post,
                platforms: post.platforms ?? data.platforms ?? payload.platforms,
                errorCategory:
                  post.errorCategory ?? data.errorCategory ?? payload.errorCategory,
                errorMessage:
                  post.errorMessage ??
                  data.errorMessage ??
                  payload.errorMessage ??
                  data.error ??
                  payload.error,
              })
            : null;
        const failedAttempt = failure?.reconnectRequired
          ? await prisma.socialPublishAttempt.findFirst({
              where: { externalPostId },
              select: { publisherAccountId: true },
            })
          : null;
        const result = await prisma.socialPublishAttempt.updateMany({
          where: { externalPostId },
          data: {
            status,
            externalStatus: eventType,
            externalPostUrl: webhookString(
              post.platformPostUrl,
              data.platformPostUrl,
              payload.platformPostUrl,
            ),
            publishedAt: status === "PUBLISHED" ? new Date() : undefined,
            lastErrorCode:
              status === "FAILED"
                ? failure?.code ?? (eventType.includes("partial")
                  ? "ZERNIO_POST_PARTIAL"
                  : webhookString(data.code, payload.code) ?? "ZERNIO_POST_FAILED")
                : null,
            lastErrorMessage:
              status === "FAILED"
                ? failure?.message ??
                  webhookString(data.error, data.message, payload.error, payload.message)?.slice(0, 500) ??
                  "Zernio could not publish this post"
                : null,
          },
        });
        updated = result.count;
        if (failedAttempt && failure?.reconnectRequired) {
          const accountResult = await deactivateZernioAccountForReconnect(
            failedAttempt.publisherAccountId,
            prisma,
          );
          updated += accountResult.count;
          console.warn("[social-publishing] Account requires OAuth reconnection", {
            externalPostId,
            publisherAccountId: failedAttempt.publisherAccountId,
            providerCategory: failure.category,
          });
        }
      }
    }
    if (eventType === "account.connected" || eventType === "account.disconnected") {
      const externalAccountId = webhookString(
        account.accountId,
        account.id,
        account._id,
        data.accountId,
        payload.accountId,
      );
      if (externalAccountId) {
        const disconnected = eventType === "account.disconnected";
        const result = await prisma.socialPublisherAccount.updateMany({
          where: { externalAccountId },
          data: {
            isActive: !disconnected,
            isDefault: disconnected ? false : undefined,
            disconnectedAt: disconnected ? new Date() : null,
            lastSyncedAt: new Date(),
          },
        });
        updated += result.count;
      }
    }
    await prisma.zernioWebhookEvent.update({
      where: { externalEventId },
      data: {
        status: updated > 0 ? "PROCESSED" : "IGNORED",
        processedAt: new Date(),
      },
    });
    return res.status(200).json({ received: true });
  } catch (error) {
    await prisma.zernioWebhookEvent.updateMany({
      where: { externalEventId },
      data: {
        status: "FAILED",
        errorMessage:
          error instanceof Error ? error.message.slice(0, 500) : "Webhook processing failed",
      },
    });
    console.error("[social-publishing] Zernio webhook failed", error);
    return sendError(res, "Webhook processing failed", 500);
  }
}
