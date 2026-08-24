import { prisma } from "../config/db.config";
import { getLocationCode, getLanguageCodeFromCountry } from "./location.utils";

/**
 * GeoKeywordContext (GEO-KW-2)
 * ----------------------------------------------------------------------------
 * Derives a structured geo context for the keyword generation pipeline from
 * existing Business + BusinessGeoProfile + ServiceAreaGeoHint data. Never
 * calls Google Maps during keyword generation — reads only pre-cached data.
 *
 * Used by:
 *   - keyword.llm.ts (candidate expansion)
 *   - generate-new-keyword.llm.ts (LLM-first fallback)
 *   - SmartKeywordDiscoveryService (competitor seed queries)
 *   - Keyword selection / verification prompts
 *
 * Env overrides (with safe defaults):
 *   GEO_KEYWORD_EXPANSION_ENABLED    = "true"
 *   GEO_KEYWORD_MAX_CITIES           = "5"
 *   GEO_KEYWORD_MAX_PRIORITY_SERVICES = "3"
 *   GEO_KEYWORD_MAX_FINALISTS_FOR_KD = "200"
 */

// ---------------------------------------------------------------------------
// Config (env-overridable)
// ---------------------------------------------------------------------------

export const GEO_KW_CONFIG = {
  get enabled(): boolean {
    return (process.env.GEO_KEYWORD_EXPANSION_ENABLED ?? "true") !== "false";
  },
  get maxCities(): number {
    return Number(process.env.GEO_KEYWORD_MAX_CITIES) || 5;
  },
  get maxPriorityServices(): number {
    return Number(process.env.GEO_KEYWORD_MAX_PRIORITY_SERVICES) || 3;
  },
  get maxFinalistsForKD(): number {
    return Number(process.env.GEO_KEYWORD_MAX_FINALISTS_FOR_KD) || 200;
  },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeoTargetType = "primary" | "service-area" | "neighborhood" | "generic";

export interface GeoKeywordTarget {
  city: string; // display name used in keyword seeds
  locationCode: number; // DataForSEO metro/country code
  type: GeoTargetType;
  isResolved: boolean; // backed by Places API data vs raw user input
}

export interface GeoKeywordContext {
  /** Whether the business is eligible for local GEO expansion. */
  geoEligible: boolean;
  /** Why — for logging / debug. */
  geoEligibilityReason: string;

  /** Primary city target (verified > raw). Null if no address at all. */
  primaryTarget: GeoKeywordTarget | null;

  /** All targets including primary + service-area + neighborhood, capped. */
  allTargets: GeoKeywordTarget[];

  /** Service-area cities excluding the primary. */
  serviceAreaTargets: GeoKeywordTarget[];

  /** Neighborhood + metro targets (from verified GeoProfile only). */
  neighborhoodTargets: GeoKeywordTarget[];

  /** Language code for DataForSEO (e.g., "en", "fr"). */
  languageCode: string;

  /** Country-level fallback location code. */
  countryLocationCode: number;

  /** Top priority services to use as keyword seeds. */
  priorityServices: string[];

  /** The raw business city string (for backward compat in prompts). */
  rawBusinessCity: string | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the GEO context for keyword generation. Pure read — no Maps calls.
 * Returns a `GeoKeywordContext` that the keyword pipeline can consume to
 * expand and score candidates geographically.
 */
export async function buildGeoKeywordContext(
  businessId: string,
): Promise<GeoKeywordContext> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      businessName: true,
      businessType: true,
      businessCity: true,
      businessState: true,
      businessCountry: true,
      businessAddress: true,
      serviceArea: true,
      serviceAreaLocations: true,
      selectedServices: true,
      servicesPriority: true,
      GeoProfile: {
        select: {
          placeId: true,
          neighborhood: true,
          locality: true,
          adminArea2: true,
          countryCode: true,
          latitude: true,
          longitude: true,
        },
      },
    },
  });

  if (!business) {
    return emptyContext("business_not_found");
  }

  // Determine GEO eligibility — product/SaaS/online-only/national/international skip.
  const eligible = isGeoEligible(business);

  const countryCode = business.GeoProfile?.countryCode ?? business.businessCountry ?? undefined;
  const languageCode = getLanguageCodeFromCountry(countryCode) ?? "en";
  const countryLocationCode = getLocationCode(countryCode);

  // Primary target: prefer verified locality > raw businessCity.
  const primaryCity =
    business.GeoProfile?.locality ||
    business.businessCity ||
    null;
  const primaryTarget: GeoKeywordTarget | null = primaryCity
    ? {
        city: primaryCity,
        locationCode: getLocationCode(countryCode, primaryCity),
        type: "primary",
        isResolved: Boolean(business.GeoProfile?.placeId),
      }
    : null;

  // Service-area targets from resolved ServiceAreaGeoHints.
  const serviceAreaTargets: GeoKeywordTarget[] = [];
  if (eligible.geoEligible) {
    const hints = await prisma.serviceAreaGeoHint.findMany({
      where: { businessId },
      select: {
        cityName: true,
        canonicalCity: true,
        countryCode: true,
        resolved: true,
      },
    });

    for (const hint of hints) {
      const cityName = hint.canonicalCity || hint.cityName;
      // Skip if same as primary city.
      if (
        primaryCity &&
        cityName.toLowerCase() === primaryCity.toLowerCase()
      ) {
        continue;
      }
      serviceAreaTargets.push({
        city: cityName,
        locationCode: getLocationCode(
          hint.countryCode ?? countryCode,
          cityName,
        ),
        type: "service-area",
        isResolved: hint.resolved,
      });
    }

    // Fallback: if no resolved hints, use raw serviceAreaLocations.
    if (
      serviceAreaTargets.length === 0 &&
      business.serviceAreaLocations.length > 0
    ) {
      for (const raw of business.serviceAreaLocations) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (
          primaryCity &&
          trimmed.toLowerCase() === primaryCity.toLowerCase()
        ) {
          continue;
        }
        serviceAreaTargets.push({
          city: trimmed,
          locationCode: getLocationCode(countryCode, trimmed),
          type: "service-area",
          isResolved: false,
        });
      }
    }
  }

  // Cap to maxCities - 1 (primary takes one slot).
  const cappedServiceArea = serviceAreaTargets.slice(
    0,
    GEO_KW_CONFIG.maxCities - (primaryTarget ? 1 : 0),
  );

  // Neighborhood targets (verified GeoProfile only).
  const neighborhoodTargets: GeoKeywordTarget[] = [];
  if (eligible.geoEligible && business.GeoProfile?.placeId) {
    if (business.GeoProfile.neighborhood) {
      neighborhoodTargets.push({
        city: business.GeoProfile.neighborhood,
        // Neighborhood keywords are searched at the metro level (same code as primary).
        locationCode: primaryTarget?.locationCode ?? countryLocationCode,
        type: "neighborhood",
        isResolved: true,
      });
    }
    if (
      business.GeoProfile.adminArea2 &&
      business.GeoProfile.adminArea2 !== primaryCity
    ) {
      neighborhoodTargets.push({
        city: business.GeoProfile.adminArea2,
        locationCode: primaryTarget?.locationCode ?? countryLocationCode,
        type: "neighborhood",
        isResolved: true,
      });
    }
  }

  // Assemble all targets.
  const allTargets: GeoKeywordTarget[] = [
    ...(primaryTarget ? [primaryTarget] : []),
    ...cappedServiceArea,
    ...neighborhoodTargets,
  ];

  // Priority services for keyword seeds.
  const priorityServices = resolvePriorityServices(
    business.selectedServices,
    business.servicesPriority,
    GEO_KW_CONFIG.maxPriorityServices,
  );

  return {
    ...eligible,
    primaryTarget,
    allTargets,
    serviceAreaTargets: cappedServiceArea,
    neighborhoodTargets,
    languageCode,
    countryLocationCode,
    priorityServices,
    rawBusinessCity: business.businessCity,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

// GEO-FIX-5: patterns that suggest a non-local business model. However, these
// are OVERRIDDEN when the business explicitly declares a local/regional service
// area — a local web-design agency or a neighborhood software shop is still a
// local business even though their type mentions "software" or "digital".
const NON_LOCAL_PATTERNS =
  /\b(product|saas|e-?commerce|marketplace|fintech|edtech)\b/i;

const LOCAL_SERVICE_AREAS = new Set(["local", "regional"]);
const NON_LOCAL_SERVICE_AREAS = new Set(["national", "international", "global"]);

function isGeoEligible(business: {
  businessType: string | null;
  serviceArea: string | null;
  businessCity: string | null;
  businessAddress: string | null;
}): { geoEligible: boolean; geoEligibilityReason: string } {
  if (!GEO_KW_CONFIG.enabled) {
    return { geoEligible: false, geoEligibilityReason: "disabled_via_env" };
  }

  const serviceAreaLower = business.serviceArea?.toLowerCase() ?? "";

  // Explicit national/international → skip GEO.
  if (NON_LOCAL_SERVICE_AREAS.has(serviceAreaLower)) {
    return {
      geoEligible: false,
      geoEligibilityReason: `service_area_is_${business.serviceArea}`,
    };
  }

  // GEO-FIX-5: explicit local/regional OVERRIDES type-based exclusion.
  // A local software agency or digital studio that declared "local" service
  // area should absolutely get GEO keywords despite their businessType.
  const explicitlyLocal = LOCAL_SERVICE_AREAS.has(serviceAreaLower);

  if (
    !explicitlyLocal &&
    business.businessType &&
    NON_LOCAL_PATTERNS.test(business.businessType)
  ) {
    return {
      geoEligible: false,
      geoEligibilityReason: "business_type_non_local",
    };
  }

  if (!business.businessCity && !business.businessAddress) {
    return {
      geoEligible: false,
      geoEligibilityReason: "no_city_or_address",
    };
  }

  return { geoEligible: true, geoEligibilityReason: "local_or_regional" };
}

// ---------------------------------------------------------------------------
// Service priority
// ---------------------------------------------------------------------------

function resolvePriorityServices(
  selectedServices: string[],
  servicesPriority: unknown,
  max: number,
): string[] {
  if (!selectedServices || selectedServices.length === 0) return [];

  // If priority map exists, sort by it.
  if (servicesPriority && typeof servicesPriority === "object") {
    const pMap = servicesPriority as Record<string, number>;
    const sorted = [...selectedServices].sort((a, b) => {
      const pa = pMap[a] ?? Infinity;
      const pb = pMap[b] ?? Infinity;
      return pa - pb;
    });
    return sorted.slice(0, max);
  }

  return selectedServices.slice(0, max);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyContext(reason: string): GeoKeywordContext {
  return {
    geoEligible: false,
    geoEligibilityReason: reason,
    primaryTarget: null,
    allTargets: [],
    serviceAreaTargets: [],
    neighborhoodTargets: [],
    languageCode: "en",
    countryLocationCode: 2840,
    priorityServices: [],
    rawBusinessCity: null,
  };
}
