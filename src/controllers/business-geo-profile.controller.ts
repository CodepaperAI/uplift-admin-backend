import type { Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  enrichGeoProfile,
  recomputeGeoProfileQuality,
  searchPlaceCandidates,
  validateGeoProfile,
} from "../services/business-geo-profile.service";
import { sendError, sendSuccess } from "../utils/response.utils";

async function assertBusinessOwnership(
  req: AuthenticatedRequest,
  businessId: string,
): Promise<{ allowed: true } | { allowed: false; statusCode: number; message: string }> {
  const userId = req.authUserId;
  if (!userId) {
    return { allowed: false, statusCode: 401, message: "Unauthorized" };
  }

  const business = await prisma.business.findFirst({
    where: { id: businessId, userId },
    select: { id: true },
  });

  if (!business) {
    return { allowed: false, statusCode: 404, message: "Business not found" };
  }

  return { allowed: true };
}

/**
 * POST /api/v1/geo-profile/status
 * Returns the current quality score + recommendations for a business.
 * Computed live from Business + GeoProfile join — no stale cache reads.
 */
export async function getGeoProfileStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const ownership = await assertBusinessOwnership(req, businessId);
    if (!ownership.allowed) {
      return sendError(res, ownership.message, ownership.statusCode);
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        businessName: true,
        businessAddress: true,
        businessCity: true,
        businessState: true,
        businessCountry: true,
        GeoProfile: {
          select: {
            placeId: true,
            formattedAddress: true,
            latitude: true,
            longitude: true,
            neighborhood: true,
            locality: true,
            adminArea1: true,
            countryCode: true,
            googleMapsUri: true,
            poisRefreshedAt: true,
          },
        },
      },
    });
    if (!business) return sendError(res, "Business not found", 404);

    const status = validateGeoProfile({
      id: business.id,
      businessName: business.businessName,
      businessAddress: business.businessAddress,
      businessCity: business.businessCity,
      businessState: business.businessState,
      businessCountry: business.businessCountry,
      geoProfile: business.GeoProfile,
    });

    return sendSuccess(res, {
      status,
      profile: business.GeoProfile,
    });
  } catch (error: any) {
    console.error("❌ Geo profile status error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/geo-profile/search
 * Place ID picker: returns top 3 candidates from Google Places searchText.
 */
export async function searchPlaces(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId, query } = req.body;
    if (!businessId || !query) {
      return sendError(res, "businessId and query are required", 400);
    }
    const ownership = await assertBusinessOwnership(req, businessId);
    if (!ownership.allowed) {
      return sendError(res, ownership.message, ownership.statusCode);
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { businessCountry: true, businessCity: true },
    });

    const candidates = await searchPlaceCandidates(query, {
      country: business?.businessCountry ?? undefined,
      city: business?.businessCity ?? undefined,
    });
    return sendSuccess(res, { candidates });
  } catch (error: any) {
    console.error("❌ Place search error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/geo-profile/resolve
 * User has confirmed a Place ID from the picker — enrich + persist.
 */
export async function resolveGeoProfile(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId, placeId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const ownership = await assertBusinessOwnership(req, businessId);
    if (!ownership.allowed) {
      return sendError(res, ownership.message, ownership.statusCode);
    }

    const outcome = await enrichGeoProfile(businessId, placeId);
    await recomputeGeoProfileQuality(businessId);
    return sendSuccess(res, outcome);
  } catch (error: any) {
    console.error("❌ Geo profile resolve error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/geo-profile/auto-enrich
 * Run automatic enrichment (search + details + landmarks) without user picker.
 * Used on first address save when we want to try to match automatically.
 */
export async function autoEnrichGeoProfile(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const ownership = await assertBusinessOwnership(req, businessId);
    if (!ownership.allowed) {
      return sendError(res, ownership.message, ownership.statusCode);
    }

    const outcome = await enrichGeoProfile(businessId);
    await recomputeGeoProfileQuality(businessId);
    return sendSuccess(res, outcome);
  } catch (error: any) {
    console.error("❌ Geo profile auto-enrich error:", error);
    return sendError(res, error.message, 500);
  }
}
