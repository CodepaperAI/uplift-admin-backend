import type { Response } from "express";
import { ZodError } from "zod";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import {
  enrichGeoProfile,
  recomputeGeoProfileQuality,
} from "../services/business-geo-profile.service";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  UPDATE_BUSINESS_AUTHOR_PROFILE,
  UPDATE_BUSINESS_BLOG_URLS,
  UPDATE_BUSINESS_LOCATION,
  UPDATE_BUSINESS_PREFERENCES,
} from "../validators/business-onboarding.validation";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

export async function updateBusinessLocation(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = UPDATE_BUSINESS_LOCATION.parse(body);

    let business;
    if (payload.businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: payload.businessId,
          userId,
          isActive: true,
        },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // Update the business with location information
    const updatedBusiness = await prisma.business.update({
      where: { id: business.id },
      data: {
        businessAddress: payload.businessAddress,
        businessCity: payload.businessCity,
        businessState: payload.businessState,
        businessCountry: payload.businessCountry,
        serviceArea: payload.serviceArea,
        serviceAreaLocations: payload.serviceAreaLocations || [],
      },
    });
    await invalidateTenantCache(userId, business.id);

    // 🆕 C1a: re-score the geo profile immediately so the dashboard nudge
    // banner reflects the new address without waiting for the nightly cron.
    // Fire-and-forget — never block the location update on this.
    void recomputeGeoProfileQuality(business.id).catch((err) => {
      console.error("⚠️ recomputeGeoProfileQuality failed after location update:", err);
    });

    // 🆕 D1: auto-enrich from Google Maps the moment a valid address is saved.
    // enrichGeoProfile auto-accepts high-confidence single matches and surfaces
    // candidates to the picker for ambiguous ones. Gated on API key presence so
    // dev/test environments without Maps billing degrade gracefully.
    if (process.env.GOOGLE_MAPS_API_KEY && payload.businessAddress) {
      void enrichGeoProfile(business.id).catch((err) => {
        console.error("⚠️ enrichGeoProfile failed after location update:", err);
      });
    }

    // 🆕 D12: resolve service-area cities the moment they're saved. Idempotent
    // + per-city cached permanently (resolveServiceAreaCity short-circuits on
    // already-resolved rows). Fire-and-forget.
    if (payload.serviceAreaLocations && payload.serviceAreaLocations.length > 0) {
      void import("../services/service-area-geo.service").then(
        ({ resolveAllServiceAreasForBusiness }) =>
          resolveAllServiceAreasForBusiness(business.id).catch((err) => {
            console.error(
              "⚠️ service-area geo resolution failed:",
              (err as Error).message,
            );
          }),
      );
    }

    // 🆕 NEW: Trigger keyword generation when service area is set during onboarding
    // This starts keyword generation as soon as user completes location/service area setup
    if (payload.serviceArea && business) {
      try {
        const current = await prisma.business.findUnique({
          where: { id: business.id },
          select: { keywordGenerationStatus: true },
        });

        if (
          current &&
          (current.keywordGenerationStatus === "idle" ||
            current.keywordGenerationStatus === "failed" ||
            !current.keywordGenerationStatus)
        ) {
          await prisma.business.update({
            where: { id: business.id },
            data: {
              keywordGenerationStatus: "pending",
              keywordGenerationStartedAt: null,
              keywordGenerationCompletedAt: null,
            },
          });

          await inngest.send({
            name: "keywords/generate",
            data: {
              userId: userId,
              businessId: business.id,
            },
          });

          console.log(
            `✅ Service area set. Keyword generation started for user ${userId}, business ${business.id}`,
          );
        }
      } catch (keywordError) {
        // Don't fail location update if keyword generation fails to start
        console.error(
          "⚠️ Failed to start keyword generation after service area update:",
          keywordError,
        );
      }
    }

    return sendSuccess(
      res,
      {
        business: updatedBusiness,
      },
      "Location information updated successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error updating business location:", error);
    return sendError(res, "Failed to update location information", 500, error);
  }
}

export async function updateBusinessPreferences(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = UPDATE_BUSINESS_PREFERENCES.parse(body);

    let business;
    if (payload.businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: payload.businessId,
          userId,
          isActive: true,
        },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // 🆕 NEW: Validate locale if provided
    let defaultLocale = payload.defaultLocale;
    if (defaultLocale) {
      const { validateLocaleCode } = await import("../utils/language.utils");
      defaultLocale = validateLocaleCode(defaultLocale);
    }

    const updateData: Record<string, unknown> = {
      targetAudience: payload.targetAudience,
      contentTone: payload.contentTone,
      publishingFrequency: payload.publishingFrequency,
      preferredContentTypes: payload.preferredContentTypes,
    };
    if (defaultLocale) updateData.defaultLocale = defaultLocale;
    if (payload.publishDaysOfWeek !== undefined)
      updateData.publishDaysOfWeek = payload.publishDaysOfWeek;

    const updatedBusiness = await prisma.business.update({
      where: { id: business.id },
      data: updateData as Parameters<typeof prisma.business.update>[0]["data"],
    });
    await invalidateTenantCache(userId, business.id);

    return sendSuccess(
      res,
      {
        business: updatedBusiness,
      },
      "Business preferences updated successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error updating business preferences:", error);
    return sendError(res, "Failed to update business preferences", 500, error);
  }
}

export async function updateBusinessBlogUrls(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = UPDATE_BUSINESS_BLOG_URLS.parse(body);

    let business;
    if (payload.businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: payload.businessId,
          userId,
          isActive: true,
        },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const updatedBusiness = await prisma.business.update({
      where: { id: business.id },
      data: {
        exampleBlogUrls: payload.blogUrls,
      },
    });
    await invalidateTenantCache(userId, business.id);

    return sendSuccess(
      res,
      {
        business: updatedBusiness,
      },
      "Blog URLs updated successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error updating blog URLs:", error);
    return sendError(res, "Failed to update blog URLs", 500, error);
  }
}

export async function updateBusinessAuthorProfile(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = UPDATE_BUSINESS_AUTHOR_PROFILE.parse(body);

    let business;
    if (payload.businessId) {
      business = await prisma.business.findFirst({
        where: { id: payload.businessId, userId, isActive: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: { userId, isPrimary: true, isActive: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        authorName: payload.authorName,
        authorBio: payload.authorBio || null,
        authorJobTitle: payload.authorJobTitle || null,
        authorImage: payload.authorImage || null,
        authorExpertise: payload.authorExpertise || [],
        authorSocialLinks: payload.authorSocialLinks ? JSON.parse(JSON.stringify(payload.authorSocialLinks)) : null,
      },
    });
    await invalidateTenantCache(userId, business.id);

    return sendSuccess(res, {
      authorName: updated.authorName,
      authorBio: updated.authorBio,
      authorJobTitle: updated.authorJobTitle,
      authorImage: updated.authorImage,
      authorExpertise: updated.authorExpertise,
      authorSocialLinks: updated.authorSocialLinks,
    }, "Author profile updated successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error updating author profile:", error);
    return sendError(res, "Failed to update author profile", 500);
  }
}
