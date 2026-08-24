import { createHash } from "node:crypto";

import type { BusinessFacts } from "../utils/business-facts.utils";
import { resolveBlogAuthor } from "../utils/blog-author.utils";

export const CANONICAL_BLOG_FACT_PACKET_VERSION = 3 as const;

export type CanonicalFactSource =
  | "verified_geo"
  | "gmb"
  | "user_confirmed"
  | "user_selected"
  | "website"
  | "database"
  | "legacy_inferred";

export type CanonicalVerification =
  | "verified"
  | "confirmed"
  | "extracted"
  | "unverified";

export type CanonicalFactKind =
  | "identity"
  | "contact"
  | "location"
  | "service"
  | "audience"
  | "benefit"
  | "credential"
  | "operation"
  | "review"
  | "reputation";

export interface CanonicalFactProvenance {
  id: string;
  field: string;
  kind: CanonicalFactKind;
  value: string;
  source: CanonicalFactSource;
  verification: CanonicalVerification;
  sourceUrl: string | null;
  extractedAt: string | null;
}

export interface CanonicalExcludedFact {
  field: string;
  kind: CanonicalFactKind;
  source: "legacy_inferred";
  sourcePath: string;
  count: number;
  reason: "not_user_confirmed" | "llm_derived_without_evidence";
}

export interface CanonicalBusinessDataConflict {
  code:
    | "LOCATION_LEVEL_MISMATCH"
    | "CONFLICTING_CITY"
    | "CONFLICTING_REGION"
    | "CONFLICTING_COUNTRY";
  field: "city" | "region" | "country";
  values: string[];
  sources: CanonicalFactSource[];
  blocking: boolean;
  message: string;
}

export type CanonicalClaimType =
  | "business_identity"
  | "business_contact"
  | "business_location"
  | "business_service"
  | "business_audience"
  | "business_benefit"
  | "business_credential"
  | "business_operation"
  | "business_review"
  | "business_reputation"
  | "educational"
  | "competitor"
  | "regulatory"
  | "statistical";

export type CanonicalEvidenceTag =
  | "identity"
  | "location"
  | "service"
  | "menu"
  | "pricing"
  | "capacity"
  | "booking"
  | "delivery"
  | "dietary"
  | "availability"
  | "audience"
  | "history"
  | "credential"
  | "review"
  | "reputation"
  | "regulatory"
  | "statistical"
  | "educational";

export interface CanonicalClaim {
  id: string;
  type: CanonicalClaimType;
  text: string;
  classification: "business" | "educational" | "competitor";
  factIds: string[];
  sourceUrl: string | null;
  authority: "verified_profile" | "user_confirmed" | "owned_website" | "authoritative_external";
  evidenceExcerpt: string | null;
  /** Deterministic semantic labels used to route evidence to matching sections. */
  evidenceTags?: CanonicalEvidenceTag[];
  /** Human-readable source page metadata supplied to the writer for scope. */
  sourceTitle?: string | null;
  /** The complete retrieved passage. Only `text` is publishable as a claim. */
  sourceContext?: string | null;
  sourceRelevance?: number | null;
}

export interface CanonicalBlogFactPacket {
  version: typeof CANONICAL_BLOG_FACT_PACKET_VERSION;
  compiledAt: string;
  packetHash: string;
  status: "ready" | "blocked";
  identity: {
    businessName: string | null;
    website: string | null;
    description: string | null;
  };
  contact: {
    phone: string | null;
  };
  location: {
    verified: boolean;
    address: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    postalCode: string | null;
    coordinates: { lat: number; lng: number } | null;
  };
  serviceAreas: string[];
  services: string[];
  audiences: string[];
  approvedBenefits: string[];
  credentials: string[];
  operatingFacts: string[];
  businessHours: string[];
  reviews: Array<{
    reviewer: string | null;
    rating: number | null;
    text: string;
    source: "gmb";
  }>;
  reputationFacts: string[];
  author: { name: string; jobTitle: string; expertise: string[] };
  regulatedTopic: "health" | "legal" | "financial" | null;
  provenance: CanonicalFactProvenance[];
  excludedFacts: CanonicalExcludedFact[];
  conflicts: CanonicalBusinessDataConflict[];
  claims: CanonicalClaim[];
}

export class BusinessDataConflictError extends Error {
  readonly code = "BUSINESS_DATA_CONFLICT";

  constructor(
    readonly conflicts: CanonicalBusinessDataConflict[],
    readonly packet: CanonicalBlogFactPacket,
  ) {
    super(
      `BUSINESS_DATA_CONFLICT: ${conflicts
        .filter((conflict) => conflict.blocking)
        .map((conflict) => conflict.message)
        .join("; ")}`,
    );
    this.name = "BusinessDataConflictError";
  }
}

type UnknownRecord = Record<string, unknown>;

type LocationInput = {
  businessCity?: string | null;
  businessState?: string | null;
  businessCountry?: string | null;
  businessAddress?: string | null;
  verified?: boolean;
  formattedAddress?: string | null;
  coordinates?: { lat: number; lng: number } | null;
  postalCode?: string | null;
  targetCity?: string | null;
};

type Candidate = {
  value: string;
  source: CanonicalFactSource;
  verification: CanonicalVerification;
  rank: number;
};

const CANADIAN_REGION_NAMES = new Set(
  [
    "alberta",
    "british columbia",
    "manitoba",
    "new brunswick",
    "newfoundland and labrador",
    "northwest territories",
    "nova scotia",
    "nunavut",
    "ontario",
    "prince edward island",
    "quebec",
    "saskatchewan",
    "yukon",
  ].map(normalizeComparable),
);

const CANADIAN_REGION_ABBREVIATIONS = new Map<string, string>([
  ["AB", "Alberta"],
  ["BC", "British Columbia"],
  ["MB", "Manitoba"],
  ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"],
  ["NU", "Nunavut"],
  ["ON", "Ontario"],
  ["PE", "Prince Edward Island"],
  ["QC", "Quebec"],
  ["SK", "Saskatchewan"],
  ["YT", "Yukon"],
]);

const US_REGION_ABBREVIATIONS = new Map<string, string>([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"],
  ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"],
  ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"],
  ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"],
  ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["DC", "District of Columbia"],
]);

const US_REGION_NAMES = new Set(
  [
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
  ].map(normalizeComparable),
);

const REGION_NAMES = new Set([
  ...CANADIAN_REGION_NAMES,
  ...US_REGION_NAMES,
  ...[...US_REGION_ABBREVIATIONS.values()].map(normalizeComparable),
]);

/**
 * Alias map for the countries this product actually serves. Values outside the
 * map do not participate in cross-source country conflict detection, so exotic
 * spellings can never produce a false block.
 */
const COUNTRY_ALIASES = new Map<string, string>([
  ["ca", "ca"],
  ["can", "ca"],
  ["canada", "ca"],
  ["us", "us"],
  ["usa", "us"],
  ["united states", "us"],
  ["united states of america", "us"],
  ["america", "us"],
  ["gb", "gb"],
  ["uk", "gb"],
  ["united kingdom", "gb"],
  ["great britain", "gb"],
  ["au", "au"],
  ["aus", "au"],
  ["australia", "au"],
]);

function normalizeCountryCode(value: string): string | null {
  return COUNTRY_ALIASES.get(normalizeComparable(value)) ?? null;
}

function impliedCountryFromRegion(value: string): string | null {
  const normalized = normalizeComparable(value);
  if (CANADIAN_REGION_NAMES.has(normalized)) return "ca";
  if (US_REGION_NAMES.has(normalized)) return "us";
  return null;
}

/** CA postal codes ("L8H 4S3") and US ZIPs sometimes end up stored in the
 * region column; they must never become an authoritative region candidate. */
function looksLikePostalCode(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(trimmed) ||
    /^\d{5}(-\d{4})?$/.test(trimmed)
  );
}

/** Normalize only the malformed-but-unambiguous `STATE ZIP` shape. A bare
 * abbreviation or arbitrary trailing text remains untouched and cannot weaken
 * genuine city/region conflict checks. */
function normalizeRegionWithUsPostalCode(value: string): string {
  const match = value.trim().match(/^([A-Za-z]{2})[\s,]+(\d{5}(?:-\d{4})?)$/);
  if (!match) return value;
  return US_REGION_ABBREVIATIONS.get(match[1]!.toUpperCase()) ?? value;
}

/** Normalize region identity only for equality checks where the country is
 * known. This must not promote an unconfirmed abbreviation into a canonical
 * location candidate. */
function normalizeRegionIdentityForCountry(
  value: string,
  country: string | null,
): string {
  const cleaned = normalizeRegionWithUsPostalCode(value).trim();
  const countryCode = country ? normalizeCountryCode(country) : null;
  const abbreviation = cleaned.toUpperCase();
  const expanded =
    countryCode === "ca"
      ? CANADIAN_REGION_ABBREVIATIONS.get(abbreviation)
      : countryCode === "us"
        ? US_REGION_ABBREVIATIONS.get(abbreviation)
        : undefined;

  return normalizeComparable(expanded ?? cleaned);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(record: UnknownRecord, key: string): UnknownRecord {
  return isRecord(record[key]) ? (record[key] as UnknownRecord) : {};
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: unknown[], max = 30): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const visit = (value: unknown) => {
    if (output.length >= max) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const cleaned = cleanString(value);
    if (!cleaned) return;
    const key = normalizeComparable(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(cleaned);
  };
  values.forEach(visit);
  return output;
}

function usableScrapedPrice(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  if (
    /\bunit\s+price\b[\s/:|-]*(?:\/?\s*per\s+sale)\b/i.test(cleaned)
  ) {
    return null;
  }
  const currency =
    /(?:[$€£¥]|\b(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\b)/i.test(cleaned);
  if (!currency) return cleaned;
  if (
    /^\.?0+(?:[.,]0+)?\s*(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\b/i.test(cleaned) ||
    /^(?:[$€£¥]\s*)?0+(?:[.,]0+)?(?:\s|$)/.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function extractTextValues(value: unknown, max = 20): string[] {
  if (typeof value === "string") return uniqueStrings([value], max);
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((entry) => extractTextValues(entry, max)), max);
  }
  if (!isRecord(value)) return [];
  return uniqueStrings(
    [
      value.title,
      value.name,
      value.label,
      value.description,
      value.credential,
      value.certification,
      value.award,
    ].flatMap((entry) => extractTextValues(entry, max)),
    max,
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function factId(field: string, value: string, source: CanonicalFactSource): string {
  return `fact_${hashJson({ field, value: normalizeComparable(value), source }).slice(0, 16)}`;
}

function claimTypeForKind(kind: CanonicalFactKind): CanonicalClaimType {
  const map: Record<CanonicalFactKind, CanonicalClaimType> = {
    identity: "business_identity",
    contact: "business_contact",
    location: "business_location",
    service: "business_service",
    audience: "business_audience",
    benefit: "business_benefit",
    credential: "business_credential",
    operation: "business_operation",
    review: "business_review",
    reputation: "business_reputation",
  };
  return map[kind];
}

function evidenceTagsForFact(
  fact: Pick<CanonicalFactProvenance, "field" | "kind" | "value">,
): CanonicalEvidenceTag[] {
  if (fact.kind === "identity") return ["identity"];
  if (fact.kind === "location") return ["location"];
  if (fact.kind === "service") return ["service"];
  if (fact.kind === "audience") return ["audience"];
  if (fact.kind === "credential") return ["credential"];
  if (fact.kind === "review") return ["review"];
  if (fact.kind === "reputation") return ["reputation"];
  if (fact.kind === "benefit") return ["service"];

  const value = fact.value.toLowerCase();
  const tags: CanonicalEvidenceTag[] = [];
  if (/\$|\b(?:price|pricing|cost|per person|per guest)\b/.test(value)) {
    tags.push("pricing");
  }
  if (/\b(?:guest|guests|people|persons|attendees|capacity|seats?)\b/.test(value)) {
    tags.push("capacity");
  }
  if (/\b(?:advance|notice|lead time|book|booking|quote)\b/.test(value)) {
    tags.push("booking");
  }
  if (/\b(?:deliver|delivery|pickup|service area|across)\b/.test(value)) {
    tags.push("delivery");
  }
  if (/\b(?:halal|kosher|vegan|vegetarian|gluten|dairy|nut[- ]free)\b/.test(value)) {
    tags.push("dietary");
  }
  if (/\b(?:founded|established|since)\s+(?:19|20)\d{2}\b/.test(value)) {
    tags.push("history");
  }
  return tags.length > 0 ? tags : ["service"];
}

function authorityForSource(
  source: CanonicalFactSource,
): CanonicalClaim["authority"] {
  if (source === "verified_geo" || source === "gmb") return "verified_profile";
  if (source === "website") return "owned_website";
  return "user_confirmed";
}

function hasConfirmedSecondaryDetails(business: UnknownRecord): boolean {
  return business.secondaryDetailsConfirmed === true;
}

function isVerifiedGmbProfile(business: UnknownRecord): boolean {
  const google = nestedRecord(business, "GoogleMyBusiness");
  return google.isActive !== false && google.verified === true;
}

function selectCandidate(candidates: Candidate[]): Candidate | null {
  return [...candidates].sort((left, right) => right.rank - left.rank)[0] ?? null;
}

function conflictingTopCandidates(
  field: CanonicalBusinessDataConflict["field"],
  candidates: Candidate[],
): CanonicalBusinessDataConflict | null {
  if (candidates.length < 2) return null;
  const maxRank = Math.max(...candidates.map((candidate) => candidate.rank));
  const top = candidates.filter((candidate) => candidate.rank === maxRank);
  const values = uniqueStrings(top.map((candidate) => candidate.value));
  if (values.length < 2) return null;
  return {
    code:
      field === "city"
        ? "CONFLICTING_CITY"
        : field === "region"
          ? "CONFLICTING_REGION"
          : "CONFLICTING_COUNTRY",
    field,
    values,
    sources: top.map((candidate) => candidate.source),
    blocking: true,
    message: `Conflicting authoritative ${field} values: ${values.join(" vs ")}`,
  };
}

function extractBusinessHours(business: UnknownRecord): string[] {
  const hours = Array.isArray(business.GMBBusinessHours)
    ? business.GMBBusinessHours
    : [];
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return uniqueStrings(
    hours.map((entry) => {
      if (!isRecord(entry) || typeof entry.dayOfWeek !== "number") return null;
      const day = days[entry.dayOfWeek];
      if (!day) return null;
      if (entry.isClosed === true) return `${day}: closed`;
      if (entry.is24Hours === true) return `${day}: open 24 hours`;
      const open = cleanString(entry.openTime);
      const close = cleanString(entry.closeTime);
      return open && close ? `${day}: ${open}-${close}` : null;
    }),
    14,
  );
}

function extractReviews(business: UnknownRecord): CanonicalBlogFactPacket["reviews"] {
  const google = nestedRecord(business, "GoogleMyBusiness");
  const candidates = Array.isArray(google.gmbReviews)
    ? google.gmbReviews
    : Array.isArray(business.gmbReviews)
      ? business.gmbReviews
      : [];
  const reviews: CanonicalBlogFactPacket["reviews"] = [];
  for (const entry of candidates) {
    if (!isRecord(entry)) continue;
    const reviewer = nestedRecord(entry, "reviewer");
    const text = cleanString(
      entry.reviewText ?? entry.comment ?? entry.text ?? entry.review,
    );
    if (!text) continue;
    const ratingValue = entry.rating ?? entry.starRating;
    const rating =
      typeof ratingValue === "number" && Number.isFinite(ratingValue)
        ? ratingValue
        : typeof ratingValue === "string" && /^\d(?:\.\d)?$/.test(ratingValue)
          ? Number(ratingValue)
          : null;
    reviews.push({
      reviewer:
        cleanString(entry.reviewerName) ??
        cleanString(entry.authorName) ??
        cleanString(reviewer.displayName),
      rating,
      text,
      source: "gmb",
    });
    if (reviews.length >= 5) break;
  }
  return reviews;
}

function detectRegulatedTopic(
  business: UnknownRecord,
  services: string[],
): CanonicalBlogFactPacket["regulatedTopic"] {
  const text = uniqueStrings([
    business.businessType,
    business.businessDescription,
    services,
  ])
    .join(" ")
    .toLowerCase();
  if (/\b(dental|dentist|medical|health|clinic|physician|therapy|therapist|pharmacy|chiropract|optometr|healthcare)\b/.test(text)) return "health";
  if (/\b(law|lawyer|legal|attorney|paralegal)\b/.test(text)) return "legal";
  if (/\b(financial|finance|investment|mortgage|accounting|accountant|tax advisor|wealth)\b/.test(text)) return "financial";
  return null;
}

export function compileCanonicalBlogFacts(input: {
  business: unknown;
  businessLocation?: LocationInput;
  scrapedFacts?: BusinessFacts | null;
  compiledAt?: Date;
  throwOnConflict?: boolean;
}): CanonicalBlogFactPacket {
  const business = isRecord(input.business) ? input.business : {};
  const geo = nestedRecord(business, "GeoProfile");
  const enhanced = nestedRecord(business, "enhancedBusinessInfo");
  const coreServices = nestedRecord(business, "coreServices");
  const effectiveServices = nestedRecord(business, "effectiveServices");
  const detectedServices = nestedRecord(business, "detectedServices");
  const websiteAnalysis = nestedRecord(business, "websiteAnalysis");
  const google = nestedRecord(business, "GoogleMyBusiness");
  const websiteUrl = cleanString(business.businessWebsiteUrl);
  const compiledAt = (input.compiledAt ?? new Date()).toISOString();
  const verifiedLocation = input.businessLocation?.verified === true;
  const secondaryDetailsConfirmed = hasConfirmedSecondaryDetails(business);
  const gmbVerified = isVerifiedGmbProfile(business);
  const geoVerified = Boolean(
    cleanString(geo.placeId) &&
      ["user_confirmed", "gmb_sync", "manual"].includes(
        cleanString(geo.resolutionSource) ?? "",
      ),
  );

  const excludedFacts: CanonicalExcludedFact[] = [];
  const addExcluded = (
    field: string,
    kind: CanonicalFactKind,
    sourcePath: string,
    values: unknown[],
    reason: CanonicalExcludedFact["reason"],
  ) => {
    const count = uniqueStrings(values).length;
    if (count === 0) return;
    excludedFacts.push({
      field,
      kind,
      source: "legacy_inferred",
      sourcePath,
      count,
      reason,
    });
  };

  const serviceAreas = uniqueStrings([business.serviceAreaLocations]);
  const targetCity = cleanString(input.businessLocation?.targetCity);
  const targetIsServiceArea = Boolean(
    targetCity &&
      serviceAreas.some(
        (area) => normalizeComparable(area) === normalizeComparable(targetCity),
      ),
  );

  const candidates = {
    city: [] as Candidate[],
    region: [] as Candidate[],
    country: [] as Candidate[],
  };
  const addCandidate = (
    field: keyof typeof candidates,
    value: unknown,
    source: CanonicalFactSource,
    verification: CanonicalVerification,
    rank: number,
  ) => {
    const cleaned = cleanString(value);
    if (!cleaned) return;
    const normalizedValue =
      field === "region" ? normalizeRegionWithUsPostalCode(cleaned) : cleaned;
    // Postal codes stored in a city/region column are malformed data, not an
    // authoritative location signal (e.g. businessState="L8H 4S3").
    if (field !== "country" && looksLikePostalCode(normalizedValue)) return;
    candidates[field].push({
      value: normalizedValue,
      source,
      verification,
      rank,
    });
  };

  if (targetCity && targetIsServiceArea) {
    addCandidate("city", targetCity, "user_selected", "confirmed", 500);
  } else if (verifiedLocation) {
    addCandidate(
      "city",
      input.businessLocation?.businessCity,
      "verified_geo",
      "verified",
      450,
    );
  }
  if (geoVerified) {
    addCandidate("city", geo.locality, "verified_geo", "verified", 400);
    addCandidate("region", geo.adminArea1, "verified_geo", "verified", 400);
    addCandidate("country", geo.countryCode, "verified_geo", "verified", 400);
  }
  if (verifiedLocation) {
    addCandidate("region", input.businessLocation?.businessState, "verified_geo", "verified", 390);
    addCandidate("country", input.businessLocation?.businessCountry, "verified_geo", "verified", 390);
  }
  if (secondaryDetailsConfirmed) {
    addCandidate("city", business.businessCity, "user_confirmed", "confirmed", 300);
    addCandidate("region", business.businessState, "user_confirmed", "confirmed", 300);
    addCandidate("country", business.businessCountry, "user_confirmed", "confirmed", 300);
  } else {
    addExcluded("city", "location", "Business.businessCity", [business.businessCity], "not_user_confirmed");
    addExcluded("region", "location", "Business.businessState", [business.businessState], "not_user_confirmed");
    addExcluded("country", "location", "Business.businessCountry", [business.businessCountry], "not_user_confirmed");
  }

  const selectedCity = selectCandidate(candidates.city);
  const selectedRegion = selectCandidate(candidates.region);
  const selectedCountry = selectCandidate(candidates.country);
  const conflicts = [
    conflictingTopCandidates("city", candidates.city),
    conflictingTopCandidates("region", candidates.region),
    conflictingTopCandidates("country", candidates.country),
  ].filter((conflict): conflict is CanonicalBusinessDataConflict => Boolean(conflict));

  // A business cannot be authoritative in two countries, so country signals are
  // compared across ALL sources and ranks — geocode, verified location, stored
  // profile, and any region name that implies a country. Rank-based selection
  // must never let a mis-geocoded address silently relocate the business to
  // another country (a real record with businessState="L8H 4S3" geocoded
  // "227 Kenilworth Ave N" to Tiffin, Ohio instead of Hamilton, Ontario).
  const countrySignals = new Map<
    string,
    { value: string; source: CanonicalFactSource }
  >();
  const addCountrySignal = (value: unknown, source: CanonicalFactSource) => {
    const cleaned = cleanString(value);
    if (!cleaned) return;
    const code = normalizeCountryCode(cleaned);
    if (code && !countrySignals.has(code)) {
      countrySignals.set(code, { value: cleaned, source });
    }
  };
  for (const candidate of candidates.country) {
    addCountrySignal(candidate.value, candidate.source);
  }
  addCountrySignal(business.businessCountry, "database");
  for (const candidate of candidates.region) {
    const implied = impliedCountryFromRegion(candidate.value);
    if (implied && !countrySignals.has(implied)) {
      countrySignals.set(implied, {
        value: candidate.value,
        source: candidate.source,
      });
    }
  }
  if (
    countrySignals.size > 1 &&
    !conflicts.some((conflict) => conflict.code === "CONFLICTING_COUNTRY")
  ) {
    const entries = [...countrySignals.values()];
    conflicts.push({
      code: "CONFLICTING_COUNTRY",
      field: "country",
      values: entries.map((entry) => entry.value),
      sources: entries.map((entry) => entry.source),
      blocking: true,
      message: `Conflicting authoritative country signals: ${entries
        .map((entry) => entry.value)
        .join(" vs ")}`,
    });
  }

  if (
    selectedCity &&
    selectedRegion &&
    REGION_NAMES.has(normalizeComparable(selectedCity.value)) &&
    normalizeComparable(selectedCity.value) !== normalizeComparable(selectedRegion.value)
  ) {
    conflicts.push({
      code: "LOCATION_LEVEL_MISMATCH",
      field: "city",
      values: [selectedCity.value, selectedRegion.value],
      sources: [selectedCity.source, selectedRegion.source],
      blocking: true,
      message: `City "${selectedCity.value}" is a state/province and conflicts with region "${selectedRegion.value}"`,
    });
  }

  const rawCity = cleanString(business.businessCity);
  const rawRegion = cleanString(business.businessState);
  const rawCountry = cleanString(business.businessCountry);
  if (
    !secondaryDetailsConfirmed &&
    !verifiedLocation &&
    !geoVerified &&
    rawCity &&
    rawRegion &&
    REGION_NAMES.has(normalizeComparable(rawCity)) &&
    normalizeRegionIdentityForCountry(rawCity, rawCountry) !==
      normalizeRegionIdentityForCountry(rawRegion, rawCountry) &&
    !conflicts.some((conflict) => conflict.code === "LOCATION_LEVEL_MISMATCH")
  ) {
    conflicts.push({
      code: "LOCATION_LEVEL_MISMATCH",
      field: "city",
      values: [rawCity, rawRegion],
      sources: ["legacy_inferred", "legacy_inferred"],
      blocking: true,
      message: `Unconfirmed city "${rawCity}" is a state/province and conflicts with region "${rawRegion}"`,
    });
  }

  const services = uniqueStrings([business.selectedServices]);
  addExcluded("service", "service", "WebsiteAnalysis.coreServices", [
    coreServices.topLevel,
    coreServices.subOfferings,
    effectiveServices.topLevel,
    effectiveServices.subOfferings,
    detectedServices.topLevel,
    detectedServices.subOfferings,
  ], "llm_derived_without_evidence");

  const audiences = secondaryDetailsConfirmed
    ? uniqueStrings([business.targetAudience])
    : [];
  if (!secondaryDetailsConfirmed) {
    addExcluded("audience", "audience", "Business.targetAudience", [business.targetAudience], "not_user_confirmed");
  }
  addExcluded("audience", "audience", "WebsiteAnalysis.businessInfo", [
    enhanced.targetAudience,
    enhanced.customerSegments,
  ], "llm_derived_without_evidence");

  const benefits: string[] = [];
  addExcluded("benefit", "benefit", "WebsiteAnalysis.businessInfo", [
    enhanced.valuePropositions,
    enhanced.uniqueSellingPoints,
    extractTextValues(business.competitiveAdvantages),
    extractTextValues(business.competitiveAdvantage),
  ], "llm_derived_without_evidence");

  const author = resolveBlogAuthor(business, services);
  const explicitAuthorName = cleanString(business.authorName);
  const credentials = explicitAuthorName
    ? uniqueStrings([business.authorJobTitle, business.authorExpertise])
    : [];
  addExcluded("credential", "credential", "WebsiteAnalysis.businessInfo", [
    extractTextValues(enhanced.credentials),
    extractTextValues(enhanced.certifications),
    extractTextValues(enhanced.awards),
    extractTextValues(websiteAnalysis.recognition),
  ], "llm_derived_without_evidence");

  const businessHours = gmbVerified ? extractBusinessHours(business) : [];
  if (!gmbVerified) {
    addExcluded("businessHours", "operation", "GoogleMyBusiness.hours", [
      extractBusinessHours(business),
    ], "not_user_confirmed");
  }
  const websiteOperatingFacts = uniqueStrings([
    usableScrapedPrice(input.scrapedFacts?.priceFrom),
    usableScrapedPrice(input.scrapedFacts?.priceRange),
    input.scrapedFacts?.groupSize,
    input.scrapedFacts?.leadTime,
    input.scrapedFacts?.foundingYear
      ? `Founded in ${input.scrapedFacts.foundingYear}`
      : null,
    input.scrapedFacts?.dietaryOptions,
  ]);
  const operatingFacts = uniqueStrings([websiteOperatingFacts, businessHours]);
  const reviews = gmbVerified ? extractReviews(business) : [];
  const rating = gmbVerified ? google.cachedAverageRating : null;
  const reviewCount = gmbVerified ? google.totalReviewCount : null;
  const reputationFacts = uniqueStrings([
    typeof rating === "number" ? `Average rating: ${rating}` : null,
    typeof reviewCount === "number" ? `Review count: ${reviewCount}` : null,
  ]);

  const verified = Boolean(
    (selectedCity?.verification === "verified" ||
      selectedRegion?.verification === "verified" ||
      selectedCountry?.verification === "verified") &&
      conflicts.every((conflict) => !conflict.blocking),
  );
  const address = verified
    ? cleanString(
        input.businessLocation?.formattedAddress ??
          input.businessLocation?.businessAddress ??
          geo.formattedAddress,
      )
    : null;
  const coordinates =
    verified && input.businessLocation?.coordinates
      ? input.businessLocation.coordinates
      : verified && typeof geo.latitude === "number" && typeof geo.longitude === "number"
        ? { lat: geo.latitude, lng: geo.longitude }
        : null;
  const websiteExtractedAt = cleanString(
    websiteAnalysis.updatedAt ?? websiteAnalysis.createdAt,
  );
  const confirmedDescription = secondaryDetailsConfirmed
    ? cleanString(business.businessDescription)
    : null;
  const confirmedPhone =
    (gmbVerified ? cleanString(google.businessPhone) : null) ??
    (secondaryDetailsConfirmed ? cleanString(business.businessPhone) : null);
  if (!secondaryDetailsConfirmed) {
    addExcluded("description", "identity", "Business.businessDescription", [business.businessDescription], "not_user_confirmed");
    addExcluded("phone", "contact", "Business.businessPhone", [business.businessPhone], "not_user_confirmed");
  }

  const provenance: CanonicalFactProvenance[] = [];
  const addProvenance = (args: {
    field: string;
    kind: CanonicalFactKind;
    value: string | null;
    source: CanonicalFactSource;
    verification: CanonicalVerification;
    sourceUrl?: string | null;
    extractedAt?: string | null;
  }) => {
    const value = args.value;
    if (!value) return;
    if (
      provenance.some(
        (entry) =>
          entry.field === args.field &&
          normalizeComparable(entry.value) === normalizeComparable(value),
      )
    ) return;
    provenance.push({
      id: factId(args.field, value, args.source),
      field: args.field,
      kind: args.kind,
      value,
      source: args.source,
      verification: args.verification,
      sourceUrl: args.sourceUrl ?? null,
      extractedAt: args.extractedAt ?? null,
    });
  };

  addProvenance({ field: "businessName", kind: "identity", value: cleanString(business.businessName), source: "user_confirmed", verification: "confirmed" });
  addProvenance({ field: "website", kind: "identity", value: websiteUrl, source: "user_confirmed", verification: "confirmed", sourceUrl: websiteUrl });
  addProvenance({ field: "description", kind: "identity", value: confirmedDescription, source: "user_confirmed", verification: "confirmed" });
  addProvenance({ field: "phone", kind: "contact", value: confirmedPhone, source: gmbVerified && cleanString(google.businessPhone) ? "gmb" : "user_confirmed", verification: gmbVerified && cleanString(google.businessPhone) ? "verified" : "confirmed" });
  if (selectedCity) addProvenance({ field: "city", kind: "location", value: selectedCity.value, source: selectedCity.source, verification: selectedCity.verification });
  if (selectedRegion) addProvenance({ field: "region", kind: "location", value: selectedRegion.value, source: selectedRegion.source, verification: selectedRegion.verification });
  if (selectedCountry) addProvenance({ field: "country", kind: "location", value: selectedCountry.value, source: selectedCountry.source, verification: selectedCountry.verification });
  addProvenance({ field: "address", kind: "location", value: address, source: "verified_geo", verification: "verified" });
  addProvenance({ field: "postalCode", kind: "location", value: verified ? cleanString(input.businessLocation?.postalCode ?? geo.postalCode) : null, source: "verified_geo", verification: "verified" });
  serviceAreas.forEach((value) => addProvenance({ field: "serviceArea", kind: "location", value, source: "user_selected", verification: "confirmed" }));
  uniqueStrings([business.selectedServices]).forEach((value) => addProvenance({ field: "service", kind: "service", value, source: "user_selected", verification: "confirmed" }));
  audiences.forEach((value) => addProvenance({ field: "audience", kind: "audience", value, source: "user_confirmed", verification: "confirmed" }));
  credentials.forEach((value) => addProvenance({ field: "credential", kind: "credential", value, source: "user_confirmed", verification: "confirmed" }));
  websiteOperatingFacts.forEach((value) => addProvenance({ field: "operation", kind: "operation", value, source: "website", verification: "extracted", sourceUrl: websiteUrl, extractedAt: websiteExtractedAt }));
  businessHours.forEach((value) => addProvenance({ field: "operation", kind: "operation", value, source: "gmb", verification: "verified" }));
  reviews.forEach((review) => addProvenance({ field: "review", kind: "review", value: review.text, source: "gmb", verification: "verified" }));
  reputationFacts.forEach((value) => addProvenance({ field: "reputation", kind: "reputation", value, source: "gmb", verification: "verified" }));

  const claims = provenance.map<CanonicalClaim>((fact) => ({
    id: `claim_${hashJson({ factId: fact.id, text: fact.value }).slice(0, 16)}`,
    type: claimTypeForKind(fact.kind),
    text: fact.value,
    classification: "business",
    factIds: [fact.id],
    sourceUrl: fact.sourceUrl,
    authority: authorityForSource(fact.source),
    evidenceExcerpt: fact.value,
    evidenceTags: evidenceTagsForFact(fact),
    sourceTitle: null,
    sourceContext: fact.value,
    sourceRelevance: null,
  }));

  const packetWithoutHash = {
    version: CANONICAL_BLOG_FACT_PACKET_VERSION,
    status: conflicts.some((conflict) => conflict.blocking) ? "blocked" : "ready",
    identity: {
      businessName: cleanString(business.businessName),
      website: websiteUrl,
      description: confirmedDescription,
    },
    contact: { phone: confirmedPhone },
    location: {
      verified,
      address,
      city: selectedCity?.value ?? null,
      region: selectedRegion?.value ?? null,
      country: selectedCountry?.value ?? null,
      postalCode: verified
        ? cleanString(input.businessLocation?.postalCode ?? geo.postalCode)
        : null,
      coordinates,
    },
    serviceAreas,
    services,
    audiences,
    approvedBenefits: benefits,
    credentials,
    operatingFacts,
    businessHours,
    reviews,
    reputationFacts,
    author,
    regulatedTopic: detectRegulatedTopic(business, services),
    provenance,
    excludedFacts,
    conflicts,
    claims,
  } as const;

  const packet: CanonicalBlogFactPacket = {
    ...packetWithoutHash,
    compiledAt,
    packetHash: hashJson(packetWithoutHash),
  };

  if (input.throwOnConflict !== false && packet.status === "blocked") {
    throw new BusinessDataConflictError(packet.conflicts, packet);
  }
  return packet;
}

export function serializeCanonicalBlogFacts(
  packet: CanonicalBlogFactPacket,
): string {
  return JSON.stringify({
    version: packet.version,
    packetHash: packet.packetHash,
    identity: packet.identity,
    contact: packet.contact,
    location: packet.location,
    serviceAreas: packet.serviceAreas,
    services: packet.services,
    audiences: packet.audiences,
    approvedBenefits: packet.approvedBenefits,
    credentials: packet.credentials,
    operatingFacts: packet.operatingFacts,
    businessHours: packet.businessHours,
    reviews: packet.reviews,
    reputationFacts: packet.reputationFacts,
    author: packet.author,
    regulatedTopic: packet.regulatedTopic,
    allowedClaims: packet.claims.map((claim) => ({
      id: claim.id,
      type: claim.type,
      text: claim.text,
      sourceUrl: claim.sourceUrl,
      authority: claim.authority,
      evidenceTags: claim.evidenceTags,
      sourceTitle: claim.sourceTitle,
      sourceContext: claim.sourceContext,
      sourceRelevance: claim.sourceRelevance,
    })),
  });
}

export function withCanonicalClaims(
  packet: CanonicalBlogFactPacket,
  claims: CanonicalClaim[],
): CanonicalBlogFactPacket {
  const { compiledAt: _compiledAt, packetHash: _packetHash, ...packetBody } =
    packet;
  return {
    ...packet,
    claims,
    packetHash: hashJson({ ...packetBody, claims }),
  };
}
