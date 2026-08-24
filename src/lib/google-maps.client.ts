/**
 * Google Maps Platform — Places API (New) v1 client.
 *
 * Thin raw-fetch wrapper (matches the `google-my-business.service.ts` style —
 * no SDK). FieldMask headers are mandatory for cost control: omitting or
 * over-requesting fields can multiply the bill by 10×.
 *
 * Caching policy (per Google Maps Platform ToS §3.4):
 *   - Permanent (indefinite): Place ID only.
 *   - Long-term (12 mo): structured fields like coordinates, addressComponents,
 *     plusCode, formattedAddress — refreshed opportunistically on edits.
 *   - Short-term (≤30d): nearby POI names/types/ratings/hours/photos — enforced
 *     by the `businessGeoPoiRefresh` Inngest cron.
 *
 * Env:
 *   GOOGLE_MAPS_API_KEY — restrict to `places.googleapis.com` + IP-allowlist in
 *                         Google Cloud Console. Separate from GOOGLE_API_KEY (Gemini).
 */

const PLACES_BASE_URL = "https://places.googleapis.com/v1";
const NEARBY_RADIUS_METERS = 1200;
const NEARBY_MAX_RESULTS = 8;
const REQUEST_TIMEOUT_MS = 8000;
const REGION_DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

const COUNTRY_NAME_TO_REGION_CODE: Record<string, string> = {
  AMERICA: "US",
  AUSTRALIA: "AU",
  BRAZIL: "BR",
  CANADA: "CA",
  CHINA: "CN",
  FRANCE: "FR",
  GERMANY: "DE",
  INDIA: "IN",
  JAPAN: "JP",
  MEXICO: "MX",
  "NEW ZEALAND": "NZ",
  SINGAPORE: "SG",
  "SOUTH AFRICA": "ZA",
  SPAIN: "ES",
  UAE: "AE",
  UK: "GB",
  "UNITED ARAB EMIRATES": "AE",
  "UNITED KINGDOM": "GB",
  "UNITED STATES": "US",
  USA: "US",
};

const SUBDIVISION_TO_REGION_CODE: Record<string, string> = {
  AB: "CA",
  ALABAMA: "US",
  ALASKA: "US",
  ALBERTA: "CA",
  ARIZONA: "US",
  ARKANSAS: "US",
  "BRITISH COLUMBIA": "CA",
  CA: "US",
  CALIFORNIA: "US",
  COLORADO: "US",
  CONNECTICUT: "US",
  DELAWARE: "US",
  FLORIDA: "US",
  GEORGIA: "US",
  HAWAII: "US",
  ILLINOIS: "US",
  INDIANA: "US",
  IOWA: "US",
  KANSAS: "US",
  KENTUCKY: "US",
  LOUISIANA: "US",
  MAINE: "US",
  MANITOBA: "CA",
  MARYLAND: "US",
  MASSACHUSETTS: "US",
  MB: "CA",
  MICHIGAN: "US",
  MINNESOTA: "US",
  MISSISSIPPI: "US",
  MISSOURI: "US",
  MONTANA: "US",
  NB: "CA",
  NEBRASKA: "US",
  NEVADA: "US",
  "NEW BRUNSWICK": "CA",
  "NEW HAMPSHIRE": "US",
  "NEW JERSEY": "US",
  "NEW MEXICO": "US",
  "NEW SOUTH WALES": "AU",
  "NEW YORK": "US",
  NEWFOUNDLAND: "CA",
  "NEWFOUNDLAND AND LABRADOR": "CA",
  "NORTH CAROLINA": "US",
  "NORTH DAKOTA": "US",
  "NORTHERN TERRITORY": "AU",
  "NORTHWEST TERRITORIES": "CA",
  NS: "CA",
  NSW: "AU",
  NT: "AU",
  NU: "CA",
  NUNAVUT: "CA",
  NV: "US",
  OHIO: "US",
  OKLAHOMA: "US",
  ON: "CA",
  ONTARIO: "CA",
  OREGON: "US",
  PA: "US",
  PENNSYLVANIA: "US",
  PE: "CA",
  "PRINCE EDWARD ISLAND": "CA",
  QC: "CA",
  QUEBEC: "CA",
  QUEENSLAND: "AU",
  QLD: "AU",
  "RHODE ISLAND": "US",
  SA: "AU",
  SASKATCHEWAN: "CA",
  SK: "CA",
  "SOUTH AUSTRALIA": "AU",
  "SOUTH CAROLINA": "US",
  "SOUTH DAKOTA": "US",
  TAS: "AU",
  TASMANIA: "AU",
  TENNESSEE: "US",
  TEXAS: "US",
  UTAH: "US",
  VERMONT: "US",
  VIC: "AU",
  VICTORIA: "AU",
  VIRGINIA: "US",
  WASHINGTON: "US",
  "WEST VIRGINIA": "US",
  "WESTERN AUSTRALIA": "AU",
  WISCONSIN: "US",
  WYOMING: "US",
  WA: "US",
  YT: "CA",
  YUKON: "CA",
};

export type PlacesApiError = {
  status: number;
  code?: string;
  message: string;
};

export interface PlaceCandidate {
  id: string;
  displayName: string;
  formattedAddress: string;
  location?: { lat: number; lng: number };
  types?: string[];
}

export interface AddressComponentRaw {
  longText: string;
  shortText: string;
  types: string[];
  languageCode?: string;
}

export interface ResolvedPlace {
  id: string;
  displayName: string | null;
  formattedAddress: string | null;
  location: { lat: number; lng: number } | null;
  viewport: { low: { lat: number; lng: number }; high: { lat: number; lng: number } } | null;
  plusCode: string | null;
  googleMapsUri: string | null;
  addressComponents: AddressComponentRaw[] | null;
  // extracted convenience fields
  streetNumber: string | null;
  route: string | null;
  neighborhood: string | null;
  locality: string | null;
  adminArea2: string | null;
  adminArea1: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

export interface LandmarkResult {
  displayName: string;
  primaryType: string;
  shortFormattedAddress?: string;
  location?: { lat: number; lng: number };
  placeId: string;
  distanceM?: number;
}

// ---------------------------------------------------------------------------
// 429 circuit breaker — pauses all calls for N seconds after consecutive 429s.
// Intentionally simple; Inngest observability surfaces the state change.
// ---------------------------------------------------------------------------
const BREAKER_STATE = {
  consecutive429: 0,
  cooldownUntil: 0,
};

function isBreakerOpen(): boolean {
  return Date.now() < BREAKER_STATE.cooldownUntil;
}

function tripBreaker() {
  BREAKER_STATE.consecutive429++;
  if (BREAKER_STATE.consecutive429 >= 3) {
    BREAKER_STATE.cooldownUntil = Date.now() + 60_000;
    console.warn(
      `⚠️ Google Maps Places API: breaker tripped — cooling down for 60s after 3 consecutive 429s.`,
    );
    // D8: surface breaker trips as an Inngest event so ops + observability
    // hooks can react (Slack alert, counter increment, runbook link). Fire
    // and forget — we're already in a failure path, never make it worse.
    void emitBreakerEvent({
      consecutive429: BREAKER_STATE.consecutive429,
      cooldownUntil: BREAKER_STATE.cooldownUntil,
    });
  }
}

async function emitBreakerEvent(payload: {
  consecutive429: number;
  cooldownUntil: number;
}) {
  try {
    // Dynamic import — avoids a circular dependency between lib and inngest/client.
    const { inngest } = await import("../inngest/client");
    await inngest.send({
      name: "maps/breaker-tripped",
      data: {
        ...payload,
        at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(
      "[google-maps.client] failed to emit breaker event:",
      (err as Error).message,
    );
  }
}

function resetBreaker() {
  BREAKER_STATE.consecutive429 = 0;
  BREAKER_STATE.cooldownUntil = 0;
}

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY is not configured. Create a Google Cloud key with Places API (New) enabled and set the env var.",
    );
  }
  return key;
}

function normalizeRegionKey(value?: string | null): string | null {
  if (!value) return null;

  const normalized = value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  return normalized || null;
}

function isValidPlacesRegionCode(value: string): boolean {
  if (!/^[A-Z]{2}$/.test(value)) return false;

  const displayName = REGION_DISPLAY_NAMES.of(value);
  return Boolean(displayName && displayName !== value && displayName !== "Unknown Region");
}

export function normalizePlacesRegionCode(value?: string | null): string | undefined {
  const normalized = normalizeRegionKey(value);
  if (!normalized) return undefined;

  const countryCode = COUNTRY_NAME_TO_REGION_CODE[normalized];
  if (countryCode) {
    return countryCode;
  }

  if (isValidPlacesRegionCode(normalized)) {
    return normalized;
  }

  return SUBDIVISION_TO_REGION_CODE[normalized];
}

async function placesFetch<T>(
  path: string,
  method: "GET" | "POST",
  fieldMask: string,
  body?: object,
): Promise<T> {
  if (isBreakerOpen()) {
    throw new Error(
      "Google Maps Places API circuit breaker is open (cooling down after 429s).",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${PLACES_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getApiKey(),
        "X-Goog-FieldMask": fieldMask,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 429) {
      tripBreaker();
      throw new Error(`Places API rate limited (429): ${path}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Places API ${res.status} on ${path}: ${text.slice(0, 200)}`);
    }

    resetBreaker();
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1) searchPlaceCandidates — for the Place ID picker UI
// ---------------------------------------------------------------------------

const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
].join(",");

export async function searchPlaceCandidates(
  query: string,
  regionHint?: { country?: string; city?: string },
): Promise<PlaceCandidate[]> {
  if (!query || query.trim().length < 3) return [];

  type ResponseShape = {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      types?: string[];
    }>;
  };

  const body: Record<string, unknown> = {
    textQuery: query.trim(),
    maxResultCount: 3,
  };
  const regionCode = normalizePlacesRegionCode(regionHint?.country);
  if (regionCode) {
    body.regionCode = regionCode;
  }

  const res = await placesFetch<ResponseShape>(
    "/places:searchText",
    "POST",
    SEARCH_FIELD_MASK,
    body,
  );

  return (res.places ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName?.text ?? "",
    formattedAddress: p.formattedAddress ?? "",
    location: p.location
      ? { lat: p.location.latitude, lng: p.location.longitude }
      : undefined,
    types: p.types,
  }));
}

// ---------------------------------------------------------------------------
// 2) resolvePlaceDetails — canonical fields for a confirmed Place ID
// ---------------------------------------------------------------------------

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "location",
  "viewport",
  "plusCode",
  "googleMapsUri",
  "types",
  "businessStatus",
].join(",");

export async function resolvePlaceDetails(placeId: string): Promise<ResolvedPlace> {
  type ResponseShape = {
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    addressComponents?: AddressComponentRaw[];
    location?: { latitude: number; longitude: number };
    viewport?: {
      low: { latitude: number; longitude: number };
      high: { latitude: number; longitude: number };
    };
    plusCode?: { globalCode?: string; compoundCode?: string };
    googleMapsUri?: string;
  };

  const res = await placesFetch<ResponseShape>(
    `/places/${encodeURIComponent(placeId)}`,
    "GET",
    DETAILS_FIELD_MASK,
  );

  const pickComponent = (type: string): AddressComponentRaw | undefined =>
    res.addressComponents?.find((c) => c.types.includes(type));

  return {
    id: res.id,
    displayName: res.displayName?.text ?? null,
    formattedAddress: res.formattedAddress ?? null,
    location: res.location
      ? { lat: res.location.latitude, lng: res.location.longitude }
      : null,
    viewport: res.viewport
      ? {
          low: { lat: res.viewport.low.latitude, lng: res.viewport.low.longitude },
          high: { lat: res.viewport.high.latitude, lng: res.viewport.high.longitude },
        }
      : null,
    plusCode: res.plusCode?.globalCode ?? res.plusCode?.compoundCode ?? null,
    googleMapsUri: res.googleMapsUri ?? null,
    addressComponents: res.addressComponents ?? null,
    streetNumber: pickComponent("street_number")?.longText ?? null,
    route: pickComponent("route")?.longText ?? null,
    neighborhood:
      pickComponent("sublocality_level_1")?.longText ??
      pickComponent("neighborhood")?.longText ??
      null,
    locality: pickComponent("locality")?.longText ?? null,
    adminArea2: pickComponent("administrative_area_level_2")?.longText ?? null,
    adminArea1: pickComponent("administrative_area_level_1")?.longText ?? null,
    postalCode: pickComponent("postal_code")?.longText ?? null,
    countryCode: pickComponent("country")?.shortText ?? null,
  };
}

// ---------------------------------------------------------------------------
// 3) fetchNearbyLandmarks — grounds "Local considerations" in real POIs
// ---------------------------------------------------------------------------

const NEARBY_FIELD_MASK = [
  "places.displayName",
  "places.primaryType",
  "places.location",
  "places.shortFormattedAddress",
  "places.id",
].join(",");

const NEARBY_INCLUDED_TYPES = [
  "tourist_attraction",
  "park",
  "transit_station",
  "shopping_mall",
  "university",
  "stadium",
  "library",
  "museum",
];

export async function fetchNearbyLandmarks(
  lat: number,
  lng: number,
): Promise<LandmarkResult[]> {
  type ResponseShape = {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      primaryType?: string;
      shortFormattedAddress?: string;
      location?: { latitude: number; longitude: number };
    }>;
  };

  const body = {
    includedTypes: NEARBY_INCLUDED_TYPES,
    maxResultCount: NEARBY_MAX_RESULTS,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: NEARBY_RADIUS_METERS,
      },
    },
  };

  const res = await placesFetch<ResponseShape>(
    "/places:searchNearby",
    "POST",
    NEARBY_FIELD_MASK,
    body,
  );

  return (res.places ?? [])
    .filter((p) => p.displayName?.text && p.primaryType)
    .map((p) => ({
      placeId: p.id,
      displayName: p.displayName!.text,
      primaryType: p.primaryType!,
      shortFormattedAddress: p.shortFormattedAddress,
      location: p.location
        ? { lat: p.location.latitude, lng: p.location.longitude }
        : undefined,
      distanceM: p.location
        ? haversineMeters(lat, lng, p.location.latitude, p.location.longitude)
        : undefined,
    }));
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
