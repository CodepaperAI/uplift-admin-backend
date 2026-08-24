import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { decryptPublishingSecret } from "../utils/publishing-secret-crypto";
import { safeFetch } from "../utils/ssrf-guard";
import {
  fetchNearbyLandmarks,
  resolvePlaceDetails,
  searchPlaceCandidates,
  type LandmarkResult,
  type PlaceCandidate,
  type ResolvedPlace,
} from "../lib/google-maps.client";

/**
 * Business Geo Profile Service
 * ----------------------------------------------------------------------------
 * One-stop API for everything related to verified business location:
 *   - validateGeoProfile()     : pure, no network — scores completeness, drives
 *                                 the dashboard nudge banner. Ships in C1a.
 *   - searchPlaceCandidates()  : re-export; Place ID picker UI.
 *   - enrichGeoProfile()       : upserts BusinessGeoProfile with canonical
 *                                 Google-sourced data + landmarks.
 *   - getGeoContextForBlog()   : structured location context fed into the blog
 *                                 generator. Falls back to legacy raw strings.
 *   - refreshExpiringPOIs()    : 30-day TTL worker, called by Inngest cron.
 *
 * NB: Maps API calls live in `../lib/google-maps.client`. This service wires
 *     them into persistence + validation.
 */

export interface GeoProfileRecommendation {
  field: string;
  severity: "high" | "medium" | "low";
  hint: string;
}

export interface GeoProfileStatus {
  isComplete: boolean;
  qualityScore: number; // 0-100
  missingFields: string[];
  recommendations: GeoProfileRecommendation[];
  hasPlaceId: boolean;
  hasCoordinates: boolean;
}

export interface BlogGeoContext {
  // legacy passthrough (always present)
  businessCity: string | null;
  businessState: string | null;
  businessCountry: string | null;
  businessAddress: string | null;
  // new structured fields (present only when verified)
  verified: boolean;
  placeId?: string | null;
  formattedAddress?: string | null;
  coordinates?: { lat: number; lng: number } | null;
  neighborhood?: string | null;
  metroArea?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  googleMapsUri?: string | null;
  landmarks?: Array<{ name: string; type: string; distanceM?: number }>;
  areaPOIs?: Array<{ name: string; type: string }>;
  // D12: multi-city service-area hints (city-level only, no landmarks)
  serviceAreaCities?: Array<{
    cityName: string;
    canonicalCity: string | null;
    state: string | null;
    countryCode: string | null;
    lat: number | null;
    lng: number | null;
  }>;
}

type BusinessWithGeo = {
  id: string;
  businessName: string | null;
  businessAddress: string | null;
  businessCity: string | null;
  businessState: string | null;
  businessCountry: string | null;
  geoProfile?: {
    placeId: string | null;
    formattedAddress?: string | null;
    latitude: number | null;
    longitude: number | null;
    streetNumber?: string | null;
    route?: string | null;
    locality?: string | null;
    adminArea1?: string | null;
    countryCode?: string | null;
  } | null;
};

// --------------------------------------------------------------------------
// Validation (C1a) — pure, no network
// --------------------------------------------------------------------------

/**
 * Score a business's location completeness 0–100.
 *
 *   40 pts : businessCity + businessState + businessCountry present
 *   20 pts : businessAddress present
 *   20 pts : geoProfile.placeId present (implies Maps-verified)
 *   10 pts : geoProfile.latitude + longitude present
 *   10 pts : business name looks non-empty
 *
 * Anything < 70 → banner shown. < 40 → red severity.
 */
export function validateGeoProfile(business: BusinessWithGeo): GeoProfileStatus {
  const missing: string[] = [];
  const recs: GeoProfileRecommendation[] = [];
  let score = 0;
  const hasBusinessRegionalFields = Boolean(
    business.businessCity && business.businessState && business.businessCountry,
  );
  const hasVerifiedRegionalFields = Boolean(
    business.geoProfile?.placeId &&
      business.geoProfile.locality &&
      business.geoProfile.adminArea1 &&
      business.geoProfile.countryCode,
  );
  const hasBusinessStreetAddress = Boolean(
    business.businessAddress && business.businessAddress.trim().length > 5,
  );
  const hasVerifiedStreetAddress = Boolean(
    business.geoProfile?.placeId &&
      (business.geoProfile.formattedAddress ||
        (business.geoProfile.streetNumber && business.geoProfile.route)),
  );

  if (hasBusinessRegionalFields || hasVerifiedRegionalFields) {
    score += 40;
  } else {
    if (!business.businessCity) missing.push("businessCity");
    if (!business.businessState) missing.push("businessState");
    if (!business.businessCountry) missing.push("businessCountry");
    recs.push({
      field: "businessCity",
      severity: "high",
      hint: "Add city, state, and country so blogs reference the right region.",
    });
  }

  if (hasBusinessStreetAddress || hasVerifiedStreetAddress) {
    score += 20;
  } else {
    missing.push("businessAddress");
    recs.push({
      field: "businessAddress",
      severity: "medium",
      hint: "Add a street address for accurate LocalBusiness schema and map linkage.",
    });
  }

  if (business.geoProfile?.placeId) {
    score += 20;
  } else if (business.businessAddress) {
    missing.push("placeId");
    recs.push({
      field: "placeId",
      severity: "medium",
      hint: "Verify your business on Google Maps so blogs use real neighborhood and landmark names.",
    });
  }

  if (business.geoProfile?.latitude != null && business.geoProfile?.longitude != null) {
    score += 10;
  } else if (business.geoProfile?.placeId) {
    // Has placeId but no lat/lng — enrichment probably mid-flight.
    recs.push({
      field: "coordinates",
      severity: "low",
      hint: "Location enrichment in progress — coordinates will populate automatically.",
    });
  }

  if (business.businessName && business.businessName.trim().length > 1) {
    score += 10;
  } else {
    missing.push("businessName");
  }

  return {
    isComplete: missing.length === 0,
    qualityScore: Math.max(0, Math.min(100, score)),
    missingFields: missing,
    recommendations: recs,
    hasPlaceId: Boolean(business.geoProfile?.placeId),
    hasCoordinates: Boolean(
      business.geoProfile?.latitude != null && business.geoProfile?.longitude != null,
    ),
  };
}

/**
 * Recompute + upsert a BusinessGeoProfile's quality columns. No network.
 * Called by the nightly cron and by post-update hooks on Business.
 */
export async function recomputeGeoProfileQuality(businessId: string): Promise<GeoProfileStatus> {
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
          streetNumber: true,
          route: true,
          locality: true,
          adminArea1: true,
          countryCode: true,
        },
      },
    },
  });
  if (!business) {
    throw new Error(`Business ${businessId} not found`);
  }

  const status = validateGeoProfile({
    id: business.id,
    businessName: business.businessName,
    businessAddress: business.businessAddress,
    businessCity: business.businessCity,
    businessState: business.businessState,
    businessCountry: business.businessCountry,
    geoProfile: business.GeoProfile,
  });

  await prisma.businessGeoProfile.upsert({
    where: { businessId },
    create: {
      businessId,
      qualityScore: status.qualityScore,
      missingFields: status.missingFields,
      recommendations: status.recommendations as unknown as Prisma.InputJsonValue,
    },
    update: {
      qualityScore: status.qualityScore,
      missingFields: status.missingFields,
      recommendations: status.recommendations as unknown as Prisma.InputJsonValue,
    },
  });

  return status;
}

// --------------------------------------------------------------------------
// Enrichment (C1b) — wraps Google Places API
// --------------------------------------------------------------------------

export interface EnrichOutcome {
  status: "enriched" | "needs_confirmation" | "no_match" | "skipped";
  candidates?: PlaceCandidate[];
  placeId?: string;
  qualityScore?: number;
}

/**
 * Idempotent enrichment. If `placeId` is provided, skips search and fetches
 * details directly. Otherwise, runs `searchText` with business name + address
 * and either auto-accepts a high-confidence match or returns candidates.
 */
export async function enrichGeoProfile(
  businessId: string,
  placeId?: string,
): Promise<EnrichOutcome> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      businessName: true,
      businessAddress: true,
      businessCity: true,
      businessState: true,
      businessCountry: true,
    },
  });
  if (!business) throw new Error(`Business ${businessId} not found`);
  if (!business.businessName && !business.businessAddress) {
    return { status: "skipped" };
  }

  let resolvedPlaceId = placeId;
  let candidates: PlaceCandidate[] | undefined;
  let confidence: number | null = null;

  if (!resolvedPlaceId) {
    const query = [business.businessName, business.businessAddress, business.businessCity]
      .filter(Boolean)
      .join(", ");

    candidates = await searchPlaceCandidates(query, {
      country: business.businessCountry ?? undefined,
      city: business.businessCity ?? undefined,
    });

    if (!candidates || candidates.length === 0) {
      // Record a recommendation and bail — still safe for blog generation.
      await prisma.businessGeoProfile.upsert({
        where: { businessId },
        create: {
          businessId,
          resolutionSource: "auto",
          alternateCandidates: [] as unknown as Prisma.InputJsonValue,
          qualityScore: 0,
          missingFields: ["placeId"],
          recommendations: [
            {
              field: "placeId",
              severity: "medium",
              hint: "Could not auto-locate on Google Maps; please confirm the address.",
            },
          ] as unknown as Prisma.InputJsonValue,
        },
        update: {
          resolutionSource: "auto",
          alternateCandidates: [] as unknown as Prisma.InputJsonValue,
        },
      });
      return { status: "no_match" };
    }

    confidence = scoreCandidateMatch(candidates[0]!, business);
    if (confidence >= 0.8 && candidates.length === 1) {
      resolvedPlaceId = candidates[0]!.id;
    } else {
      // Persist candidates for audit + picker
      await prisma.businessGeoProfile.upsert({
        where: { businessId },
        create: {
          businessId,
          resolutionSource: "auto",
          alternateCandidates: candidates as unknown as Prisma.InputJsonValue,
        },
        update: {
          alternateCandidates: candidates as unknown as Prisma.InputJsonValue,
        },
      });
      return { status: "needs_confirmation", candidates };
    }
  }

  // We have a placeId — fetch canonical details + landmarks
  const details = await resolvePlaceDetails(resolvedPlaceId);
  const landmarks = details.location
    ? await fetchNearbyLandmarks(details.location.lat, details.location.lng)
    : [];

  await persistEnrichment(businessId, details, landmarks, {
    resolutionSource: placeId ? "user_confirmed" : "auto",
    resolutionConfidence: confidence,
    alternateCandidates: candidates ?? null,
  });

  // Refresh quality score from the upserted row
  const quality = await recomputeGeoProfileQuality(businessId);

  return {
    status: "enriched",
    placeId: resolvedPlaceId,
    qualityScore: quality.qualityScore,
  };
}

function scoreCandidateMatch(
  candidate: PlaceCandidate,
  business: { businessName: string | null; businessAddress: string | null },
): number {
  const name = business.businessName?.toLowerCase() ?? "";
  const addr = business.businessAddress?.toLowerCase() ?? "";
  const candName = candidate.displayName?.toLowerCase() ?? "";
  const candAddr = candidate.formattedAddress?.toLowerCase() ?? "";

  let score = 0;
  if (name && candName && candName.includes(name)) score += 0.5;
  if (addr && candAddr && tokenOverlap(addr, candAddr) > 0.5) score += 0.3;
  if (candidate.types?.some((t) => t === "establishment" || t === "point_of_interest")) score += 0.2;
  return Math.min(1, score);
}

function tokenOverlap(a: string, b: string): number {
  const at = new Set(a.split(/\s+/).filter((t) => t.length >= 3));
  const bt = new Set(b.split(/\s+/).filter((t) => t.length >= 3));
  if (at.size === 0) return 0;
  let hits = 0;
  for (const t of at) if (bt.has(t)) hits++;
  return hits / at.size;
}

interface PersistOpts {
  resolutionSource: string;
  resolutionConfidence: number | null;
  alternateCandidates: PlaceCandidate[] | null;
}

/**
 * D11: fire-and-forget cache invalidation call to any WordPress plugin
 * connected for this business. Best-effort — never raises and never blocks
 * enrichment. Uses the existing `PublishingIntegration.wordpressIntegrationKey`
 * as the Bearer token (the plugin's `verify_token` check accepts it).
 */
async function invalidateWordPressSchemaCache(businessId: string): Promise<void> {
  try {
    const integrations = await prisma.publishingIntegration.findMany({
      where: {
        businessId,
        platform: "WORDPRESS",
        isActive: true,
        wordpressUrl: { not: null },
        wordpressIntegrationKey: { not: null },
      },
      select: { wordpressUrl: true, wordpressIntegrationKey: true },
    });
    if (integrations.length === 0) return;

    await Promise.all(
      integrations.map(async (i) => {
        if (!i.wordpressUrl || !i.wordpressIntegrationKey) return;
        const endpoint =
          i.wordpressUrl.replace(/\/$/, "") +
          "/wp-json/seo-tool/v1/cache-invalidate";
        try {
          const integrationKey = decryptPublishingSecret(
            i.wordpressIntegrationKey,
            "wordpress-integration-key",
          );
          const res = await safeFetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${integrationKey}`,
            },
            body: JSON.stringify({ trigger: "geo-profile-updated" }),
          }, { maxRedirects: 0, timeoutMs: 4000 });
          if (!res.ok) {
            console.warn(
              `[geo-profile] WP cache-invalidate returned ${res.status}`,
            );
          }
        } catch (err) {
          // Dead site / timeout — don't fail the main flow.
          console.warn(
            `[geo-profile] WP cache-invalidate failed for ${endpoint}:`,
            (err as Error).message,
          );
        }
      }),
    );
  } catch (err) {
    console.error(
      "[geo-profile] invalidateWordPressSchemaCache outer failure:",
      (err as Error).message,
    );
  }
}

async function persistEnrichment(
  businessId: string,
  details: ResolvedPlace,
  landmarks: LandmarkResult[],
  opts: PersistOpts,
) {
  let data: Record<string, unknown> = {
    placeId: details.id,
    formattedAddress: details.formattedAddress ?? null,
    latitude: details.location?.lat ?? null,
    longitude: details.location?.lng ?? null,
    plusCode: details.plusCode ?? null,
    googleMapsUri: details.googleMapsUri ?? null,
    addressComponents: (details.addressComponents ?? null) as unknown as Prisma.InputJsonValue,
    streetNumber: details.streetNumber ?? null,
    route: details.route ?? null,
    neighborhood: details.neighborhood ?? null,
    locality: details.locality ?? null,
    adminArea2: details.adminArea2 ?? null,
    adminArea1: details.adminArea1 ?? null,
    postalCode: details.postalCode ?? null,
    countryCode: details.countryCode ?? null,
    viewportJson: (details.viewport ?? null) as unknown as Prisma.InputJsonValue,
    resolutionSource: opts.resolutionSource,
    resolutionConfidence: opts.resolutionConfidence,
    alternateCandidates: (opts.alternateCandidates ?? null) as unknown as Prisma.InputJsonValue,
    nearbyLandmarksJson: landmarks as unknown as Prisma.InputJsonValue,
    poisRefreshedAt: new Date(),
  };

  // D19: detect placeId collision BEFORE upsert. Two businesses at the same
  // physical location (franchise siblings, shared NAP in test data) would
  // otherwise collide on the unique constraint. We still save by businessId,
  // but flag the shared Place ID for review rather than 500-ing the save.
  if (data.placeId) {
    const existingOwner = await prisma.businessGeoProfile.findFirst({
      where: {
        placeId: data.placeId,
        businessId: { not: businessId },
      },
      select: { id: true, businessId: true },
    });
    if (existingOwner) {
      console.warn(
        `[geo-profile] Place ID ${data.placeId} already owned by business ${existingOwner.businessId}; marking as shared.`,
      );
      // Null out the placeId on this row (so the unique constraint doesn't
      // conflict) but keep all the other resolved geo fields — the customer
      // still benefits from neighborhood + coordinates in blog content. Add
      // an ops recommendation so a human can review the conflict.
      const sharedRecs = [
        {
          field: "placeId",
          severity: "low" as const,
          hint: `Google Place ID matches an existing business (${existingOwner.businessId}). Skipped linking to avoid collision — review ownership and re-verify if needed.`,
        },
      ];
      data = {
        ...data,
        placeId: null,
        resolutionSource: "shared_place_id",
        alternateCandidates: {
          collision: {
            placeId: existingOwner.businessId,
            originalPlaceId: data.placeId,
          },
        } as unknown as Prisma.InputJsonValue,
      };
      // Merge recommendations into the existing profile row if it exists.
      const existing = await prisma.businessGeoProfile.findUnique({
        where: { businessId },
        select: { recommendations: true },
      });
      const existingRecs = Array.isArray(existing?.recommendations)
        ? (existing.recommendations as unknown as Array<{
            field: string;
            severity: string;
            hint: string;
          }>)
        : [];
      const mergedRecs = [
        ...existingRecs.filter((r) => r.field !== "placeId"),
        ...sharedRecs,
      ];
      // Upsert with merged recommendations.
      await prisma.businessGeoProfile.upsert({
        where: { businessId },
        create: {
          businessId,
          ...data,
          recommendations: mergedRecs as unknown as Prisma.InputJsonValue,
        },
        update: {
          ...data,
          recommendations: mergedRecs as unknown as Prisma.InputJsonValue,
        },
      });
      void invalidateWordPressSchemaCache(businessId);
      return;
    }
  }

  await prisma.businessGeoProfile.upsert({
    where: { businessId },
    create: { businessId, ...data },
    update: data,
  });

  // D11: fire cache invalidation to any connected WP site. Fire-and-forget —
  // never block enrichment on the customer's WP responding.
  void invalidateWordPressSchemaCache(businessId);
}

// --------------------------------------------------------------------------
// Blog-generation integration (C1c)
// --------------------------------------------------------------------------

/**
 * Assemble the structured location object handed to `generateBlogFromKeywordLLM`.
 * Always returns legacy fields; adds structured fields only when a verified
 * BusinessGeoProfile exists with at least a placeId.
 */
export async function getGeoContextForBlog(businessId: string): Promise<BlogGeoContext> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      businessCity: true,
      businessState: true,
      businessCountry: true,
      businessAddress: true,
      GeoProfile: {
        select: {
          placeId: true,
          formattedAddress: true,
          latitude: true,
          longitude: true,
          neighborhood: true,
          locality: true,
          adminArea2: true,
          postalCode: true,
          countryCode: true,
          googleMapsUri: true,
          nearbyLandmarksJson: true,
          areaPOIsJson: true,
        },
      },
    },
  });

  // D12: always load service-area hints (even for unverified businesses).
  const { getResolvedServiceAreas } = await import(
    "./service-area-geo.service"
  );
  const serviceAreaHints = await getResolvedServiceAreas(businessId);
  const serviceAreaCities = serviceAreaHints.map((h) => ({
    cityName: h.cityName,
    canonicalCity: h.canonicalCity,
    state: h.state,
    countryCode: h.countryCode,
    lat: h.latitude,
    lng: h.longitude,
  }));

  const base: BlogGeoContext = {
    businessCity: business?.businessCity ?? null,
    businessState: business?.businessState ?? null,
    businessCountry: business?.businessCountry ?? null,
    businessAddress: business?.businessAddress ?? null,
    verified: false,
    serviceAreaCities: serviceAreaCities.length > 0 ? serviceAreaCities : undefined,
  };

  const gp = business?.GeoProfile;
  if (!gp?.placeId) return base;

  const landmarksRaw = (gp.nearbyLandmarksJson ?? []) as unknown as LandmarkResult[];
  const landmarks = landmarksRaw
    .slice(0, 5)
    .map((l) => ({
      name: l.displayName ?? "",
      type: l.primaryType ?? "",
      distanceM: l.distanceM,
    }))
    .filter((l) => l.name && l.type);

  return {
    ...base,
    verified: true,
    placeId: gp.placeId,
    formattedAddress: gp.formattedAddress,
    coordinates:
      gp.latitude != null && gp.longitude != null
        ? { lat: gp.latitude, lng: gp.longitude }
        : null,
    neighborhood: gp.neighborhood,
    metroArea: gp.adminArea2,
    postalCode: gp.postalCode,
    countryCode: gp.countryCode,
    googleMapsUri: gp.googleMapsUri,
    landmarks,
  };
}

// --------------------------------------------------------------------------
// POI refresh (C1d)
// --------------------------------------------------------------------------

export async function refreshExpiringPOIs(batchSize = 50): Promise<{ refreshed: number; failures: number }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const expiring = await prisma.businessGeoProfile.findMany({
    where: {
      placeId: { not: null },
      OR: [{ poisRefreshedAt: null }, { poisRefreshedAt: { lt: cutoff } }],
    },
    take: batchSize,
    select: { id: true, businessId: true, latitude: true, longitude: true },
  });

  let refreshed = 0;
  let failures = 0;
  for (const row of expiring) {
    if (row.latitude == null || row.longitude == null) continue;
    try {
      const landmarks = await fetchNearbyLandmarks(row.latitude, row.longitude);
      await prisma.businessGeoProfile.update({
        where: { id: row.id },
        data: {
          nearbyLandmarksJson: landmarks as unknown as Prisma.InputJsonValue,
          poisRefreshedAt: new Date(),
        },
      });
      refreshed++;
    } catch (err) {
      failures++;
      console.error(
        `⚠️ POI refresh failed for geoProfile ${row.id} (business ${row.businessId}):`,
        (err as Error).message,
      );
    }
  }
  return { refreshed, failures };
}

// --------------------------------------------------------------------------
// Convenience re-exports
// --------------------------------------------------------------------------
export { searchPlaceCandidates, resolvePlaceDetails } from "../lib/google-maps.client";
