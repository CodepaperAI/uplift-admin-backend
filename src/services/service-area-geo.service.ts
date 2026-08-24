import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { searchPlaceCandidates } from "../lib/google-maps.client";

/**
 * ServiceAreaGeoHint service (D12)
 * ----------------------------------------------------------------------------
 * Lightweight city-level geocoding for multi-location businesses. We do NOT
 * create full BusinessGeoProfile rows for each service-area city — that'd
 *10× the Maps API bill for marginal prompt value and clutter the NAP model
 * (since each hint is a city the business *serves*, not *operates from*).
 *
 * One call per city, centroid coordinates only, cached permanently (cities
 * don't move).
 */

export interface ServiceAreaHint {
  cityName: string;
  canonicalCity: string | null;
  state: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  resolved: boolean;
}

/**
 * Upsert one city into the hints table. Skipped if already resolved (cities
 * don't change). Fire-and-forget-safe — always returns a hint, never throws.
 */
export async function resolveServiceAreaCity(
  businessId: string,
  cityName: string,
  regionHint?: { country?: string },
): Promise<ServiceAreaHint> {
  const existing = await prisma.serviceAreaGeoHint.findUnique({
    where: { businessId_cityName: { businessId, cityName } },
  });
  if (existing?.resolved) {
    return {
      cityName: existing.cityName,
      canonicalCity: existing.canonicalCity,
      state: existing.state,
      countryCode: existing.countryCode,
      latitude: existing.latitude,
      longitude: existing.longitude,
      placeId: existing.placeId,
      resolved: true,
    };
  }

  // Early-exit when Maps key isn't configured — still persist the hint so
  // consumers can see that we *tried* and fall back to raw city name.
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    await prisma.serviceAreaGeoHint.upsert({
      where: { businessId_cityName: { businessId, cityName } },
      create: {
        businessId,
        cityName,
        resolved: false,
        lastResolveError: "GOOGLE_MAPS_API_KEY not configured",
      },
      update: {
        lastResolveError: "GOOGLE_MAPS_API_KEY not configured",
      },
    });
    return {
      cityName,
      canonicalCity: null,
      state: null,
      countryCode: null,
      latitude: null,
      longitude: null,
      placeId: null,
      resolved: false,
    };
  }

  try {
    const candidates = await searchPlaceCandidates(cityName, regionHint);
    // Prefer a candidate tagged as a locality or political entity.
    const locality =
      candidates.find((c) => (c.types ?? []).includes("locality")) ??
      candidates.find((c) => (c.types ?? []).includes("political")) ??
      candidates[0];

    if (!locality) {
      await prisma.serviceAreaGeoHint.upsert({
        where: { businessId_cityName: { businessId, cityName } },
        create: {
          businessId,
          cityName,
          resolved: false,
          lastResolveError: "no_candidates",
        },
        update: { lastResolveError: "no_candidates" },
      });
      return {
        cityName,
        canonicalCity: null,
        state: null,
        countryCode: null,
        latitude: null,
        longitude: null,
        placeId: null,
        resolved: false,
      };
    }

    const payload: Prisma.ServiceAreaGeoHintUncheckedCreateInput = {
      businessId,
      cityName,
      canonicalCity: locality.displayName || null,
      placeId: locality.id,
      latitude: locality.location?.lat ?? null,
      longitude: locality.location?.lng ?? null,
      countryCode: regionHint?.country ?? null,
      resolved: true,
      lastResolveError: null,
    };

    await prisma.serviceAreaGeoHint.upsert({
      where: { businessId_cityName: { businessId, cityName } },
      create: payload,
      update: {
        canonicalCity: payload.canonicalCity,
        placeId: payload.placeId,
        latitude: payload.latitude,
        longitude: payload.longitude,
        countryCode: payload.countryCode,
        resolved: true,
        lastResolveError: null,
      },
    });

    return {
      cityName,
      canonicalCity: payload.canonicalCity ?? null,
      state: null,
      countryCode: payload.countryCode ?? null,
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      placeId: payload.placeId ?? null,
      resolved: true,
    };
  } catch (err) {
    await prisma.serviceAreaGeoHint.upsert({
      where: { businessId_cityName: { businessId, cityName } },
      create: {
        businessId,
        cityName,
        resolved: false,
        lastResolveError: (err as Error).message.slice(0, 200),
      },
      update: {
        lastResolveError: (err as Error).message.slice(0, 200),
      },
    });
    return {
      cityName,
      canonicalCity: null,
      state: null,
      countryCode: null,
      latitude: null,
      longitude: null,
      placeId: null,
      resolved: false,
    };
  }
}

/**
 * Resolve the full `serviceAreaLocations[]` array for a business. Idempotent
 * and cheap on repeat calls thanks to the `resolved=true` short-circuit.
 */
export async function resolveAllServiceAreasForBusiness(
  businessId: string,
): Promise<ServiceAreaHint[]> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { serviceAreaLocations: true, businessCountry: true },
  });
  if (!business || business.serviceAreaLocations.length === 0) return [];

  const results: ServiceAreaHint[] = [];
  for (const city of business.serviceAreaLocations) {
    const trimmed = city.trim();
    if (!trimmed) continue;
    const hint = await resolveServiceAreaCity(businessId, trimmed, {
      country: business.businessCountry ?? undefined,
    });
    results.push(hint);
  }
  return results;
}

/**
 * Read-only getter for the blog generator. Returns only resolved hints so the
 * prompt never references a city we couldn't verify.
 */
export async function getResolvedServiceAreas(
  businessId: string,
): Promise<ServiceAreaHint[]> {
  const rows = await prisma.serviceAreaGeoHint.findMany({
    where: { businessId, resolved: true },
    select: {
      cityName: true,
      canonicalCity: true,
      state: true,
      countryCode: true,
      latitude: true,
      longitude: true,
      placeId: true,
    },
  });
  return rows.map((r) => ({ ...r, resolved: true }));
}
