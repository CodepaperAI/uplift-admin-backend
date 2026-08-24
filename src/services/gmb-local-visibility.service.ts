import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  getLocalMapsResultsFromDataForSEO,
  getLocalPackResultsFromDataForSEO,
  type DataForSEOLocalMapResult,
} from "../utils/dataforseo.utils";
import {
  GoogleMyBusinessService,
  type GoogleLocation,
} from "./google-my-business.service";
import { isDemoGmbConnection } from "./gmb-demo-data.service";
import { gmbAIService } from "./gmb-ai.service";
import { resolveEffectiveServices } from "../utils/effective-services.utils";
import {
  evaluatePublicRateLimit,
  type PublicRateLimitStore,
} from "../utils/public-rate-limit.utils";
import {
  isGoogleCategoryResourceId,
  resolveGoogleCategoryIds,
} from "../utils/gmb-category-resolver.utils";
import { backfillStructuredDataFromProfile } from "../lib/gmb-hours-backfill";
import { captureEditImpactBaseline } from "./gmb-edit-impact.service";

const RANK_SCAN_RATE_LIMIT_STORE: PublicRateLimitStore = new Map();
const RANK_SCAN_HOURLY_LIMIT = 3;
const RANK_SCAN_HOURLY_WINDOW_MS = 60 * 60 * 1000;
const RANK_SCAN_CADENCE_MS: Record<string, number> = {
  manual: 0,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export class GMBRankScanThrottledError extends Error {
  retryAfterSeconds: number;
  reason: "cadence" | "hourly_cap";

  constructor(reason: "cadence" | "hourly_cap", retryAfterSeconds: number, message: string) {
    super(message);
    this.name = "GMBRankScanThrottledError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type HealthGroup =
  | "completeness"
  | "reputation"
  | "engagement"
  | "visibility"
  | "conversion";

type HealthPriority = "high" | "medium" | "low";

export type GMBHealthSignals = {
  hasName: boolean;
  hasAddress: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  categoriesCount: number;
  hasRegularHours: boolean;
  hasSpecialHours: boolean;
  hasDescription: boolean;
  descriptionLength: number;
  serviceItemsCount: number;
  hasAttributes: boolean;
  averageRating: number | null;
  reviewCount: number;
  unansweredReviews: number;
  negativeUnansweredReviews: number;
  recentReviewCount: number;
  reviewResponseRate: number;
  recentPostCount: number;
  mediaAssetCount: number;
  // Number of GMBMediaAsset rows published to Google in the last 7 days.
  // Drives the "use real local photos" rule priority — if zero, the cadence
  // recommendation jumps to high.
  recentMediaPublishedCount: number;
  conversionActions30d: number;
  discoveryKeywordCount: number;
  rankScanCount30d: number;
  bestClientRank: number | null;
  competitorCount: number;
  attributionLinkCount: number;
  hasReviewLink: boolean;
  // Phase 2 ranking foundations: signals computed from the new structured
  // tables (GMBCategory / GMBBusinessHours / GMBAttribute / verification cols).
  verificationState: string | null;
  isVerified: boolean;
  hasPrimaryCategoryStructured: boolean;
  structuredCategoriesCount: number;
  weeklyHoursDaysCovered: number;
  structuredAttributesCount: number;
  timezoneSet: boolean;
};

export type GMBHealthItem = {
  checkKey: string;
  title: string;
  description: string;
  category: HealthGroup;
  status: "pass" | "warning" | "fail";
  priority: HealthPriority;
  scoreImpact: number;
  recommendedAction: string;
  evidenceJson?: Record<string, unknown>;
};

export type GMBHealthScoreResult = {
  score: number;
  completenessScore: number;
  reputationScore: number;
  engagementScore: number;
  visibilityScore: number;
  conversionScore: number;
  items: GMBHealthItem[];
  summary: string;
};

type HealthRule = {
  key: string;
  title: string;
  description: string;
  group: HealthGroup;
  priority: HealthPriority;
  maxPoints: number;
  points: number;
  recommendedAction: string;
  evidence?: Record<string, unknown>;
};

type ProfileFieldKey =
  | "businessName"
  | "description"
  | "phoneNumber"
  | "websiteUrl"
  | "address"
  | "categories"
  | "services"
  | "regularHours"
  | "specialHours";

type ProfileValue = string | string[] | null;

type ProfileServiceItemProposal = {
  displayName: string;
  description?: string;
};

type NormalizedGMBProfile = {
  syncedAt: string | null;
  businessName: string | null;
  description: string | null;
  phoneNumber: string | null;
  websiteUrl: string | null;
  address: string | null;
  categories: string[];
  services: string[];
  regularHours: string | null;
  specialHours: string | null;
};

type GMBProfileDiff = {
  field: ProfileFieldKey;
  label: string;
  currentValue: ProfileValue;
  proposedValue: ProfileValue;
  googleField: string | null;
  applySupported: boolean;
};

type GMBProfileReview = {
  currentProfile: NormalizedGMBProfile;
  diffs: GMBProfileDiff[];
};

type BusinessProfileProposal = {
  businessName: string;
  description: string;
  phoneNumber: string | null;
  websiteUrl: string;
  address: string | null;
  categories: string[];
  services: ProfileServiceItemProposal[];
};

const GROUP_WEIGHTS: Record<HealthGroup, number> = {
  completeness: 25,
  reputation: 25,
  engagement: 20,
  visibility: 20,
  conversion: 10,
};

const EMPTY_DISCOVERY_KEYWORDS: Array<{
  id: string;
  keyword: string;
  month: string;
  impressions: number;
  source: string;
}> = [];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function scoreStatus(points: number, maxPoints: number): "pass" | "warning" | "fail" {
  const ratio = maxPoints > 0 ? points / maxPoints : 0;
  if (ratio >= 0.95) {
    return "pass";
  }
  if (ratio >= 0.5) {
    return "warning";
  }
  return "fail";
}

function normalizeText(value?: string | null) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractDomain(url?: string | null) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

// Must match GOOGLE_PROFILE_DESCRIPTION_SAFE_LIMIT in gmb-ai.service.ts.
// Drives both the "description nearing 750-char limit" rule below and the
// deterministic trim used when proposing a fix.
const DESCRIPTION_RECOMMENDED_MAX = 700;

// Sentence-boundary-aware trim of an existing description so the "trim
// recommendation" proposes a real cut of what's currently on the profile,
// not an AI regeneration that may semantically drift. Same algorithm as
// GMBAIService.fitProfileDescription so AI-generated and trimmed text behave
// consistently.
export function trimDescriptionToRecommendedLimit(
  value: string,
  max = DESCRIPTION_RECOMMENDED_MAX,
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;

  const capped = normalized.slice(0, max);
  if (/[.!?]["')\]]?$/.test(capped)) return capped;

  const sentenceEnd = Math.max(
    capped.lastIndexOf("."),
    capped.lastIndexOf("!"),
    capped.lastIndexOf("?"),
  );
  if (sentenceEnd >= 180) return capped.slice(0, sentenceEnd + 1).trim();

  const wordEnd = capped.lastIndexOf(" ");
  const trimmed = wordEnd >= 180 ? capped.slice(0, wordEnd).trim() : capped.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function safeDate(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAddress(address?: GoogleLocation["storefrontAddress"]) {
  if (!address) {
    return null;
  }

  const parts = [
    ...(address.addressLines ?? []),
    address.locality,
    address.administrativeArea,
    address.postalCode,
    address.regionCode,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatBusinessAddress(business: {
  businessAddress?: string | null;
  businessCity?: string | null;
  businessState?: string | null;
  businessCountry?: string | null;
}) {
  return [
    business.businessAddress,
    business.businessCity,
    business.businessState,
    business.businessCountry,
  ]
    .filter(Boolean)
    .join(", ") || null;
}

function extractCategories(profile?: GoogleLocation | null): string[] {
  const primary = profile?.categories?.primaryCategory?.displayName;
  const additional =
    profile?.categories?.additionalCategories?.map((category) => category.displayName) ??
    [];

  return Array.from(
    new Set([...additional, primary].filter((value): value is string => Boolean(value))),
  );
}

function extractCategoryResourceIds(profile?: GoogleLocation | null): string[] {
  const categories = [
    profile?.categories?.primaryCategory,
    ...(profile?.categories?.additionalCategories ?? []),
  ];
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    const directName = category?.name?.trim();
    const ids = directName
      ? [directName]
      : category?.displayName
        ? resolveGoogleCategoryIds([category.displayName]).resolved
        : [];

    for (const id of ids) {
      if (isGoogleCategoryResourceId(id) && !seen.has(id)) {
        seen.add(id);
        resolved.push(id);
      }
    }
  }

  return resolved;
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeLabel(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isInternalGoogleServiceId(value: string | null | undefined) {
  return /^job_type_id:[a-z0-9_:-]+$/i.test(normalizeLabel(value ?? ""));
}

export function humanizeGoogleServiceTypeId(value: string | null | undefined) {
  const normalized = normalizeLabel(value ?? "");
  if (!isInternalGoogleServiceId(normalized)) return "";

  return normalized
    .replace(/^job_type_id:/i, "")
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim()
    .slice(0, 140);
}

function normalizeKey(value: string) {
  return normalizeLabel(value).toLowerCase();
}

function normalizeComparableText(value: string | null | undefined) {
  return normalizeLabel(value ?? "").toLowerCase();
}

function normalizeComparablePhone(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

function normalizeComparableUrl(value: string | null | undefined) {
  const raw = normalizeLabel(value ?? "");
  if (!raw) return "";

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${hostname}${pathname}${url.search}`.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

function uniqueLabels(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const label = normalizeLabel(value);
    if (!label) {
      continue;
    }

    const key = normalizeKey(label);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    labels.push(label);
  }

  return labels;
}

function mergeProfileLabels(
  current: string[],
  recommended: string[],
  limit = 10,
) {
  return uniqueLabels([...current, ...recommended]).slice(0, limit);
}

function hasMissingLabels(current: string[], recommended: string[]) {
  const currentKeys = new Set(current.map((value) => normalizeKey(value)));
  return recommended.some((value) => !currentKeys.has(normalizeKey(value)));
}

function normalizeServiceDisplayName(value: string) {
  return normalizeLabel(value).slice(0, 140);
}

function normalizeServiceDescription(value: string | null | undefined) {
  return normalizeLabel(value ?? "").slice(0, 250);
}

function parseServiceDisplayText(value: string): ProfileServiceItemProposal | null {
  const [rawName, ...descriptionParts] = value.split(/\s+\|\s+|\s+—\s+/);
  const displayName = normalizeServiceDisplayName(rawName ?? "");
  if (!displayName) return null;
  if (isInternalGoogleServiceId(displayName)) return null;

  const description = normalizeServiceDescription(descriptionParts.join(" | "));
  return {
    displayName,
    ...(description ? { description } : {}),
  };
}

function normalizeServiceProposal(value: unknown): ProfileServiceItemProposal | null {
  if (typeof value === "string") {
    return parseServiceDisplayText(value);
  }

  if (!isRecord(value)) {
    return null;
  }

  const freeForm = isRecord(value.freeFormServiceItem)
    ? value.freeFormServiceItem
    : null;
  const freeFormLabel = freeForm && isRecord(freeForm.label) ? freeForm.label : null;
  const structured = isRecord(value.structuredServiceItem)
    ? value.structuredServiceItem
    : null;

  const displayName = normalizeServiceDisplayName(
    typeof value.displayName === "string"
      ? value.displayName
      : typeof value.name === "string"
        ? value.name
        : typeof value.label === "string"
          ? value.label
          : typeof freeFormLabel?.displayName === "string"
            ? freeFormLabel.displayName
            : typeof structured?.displayName === "string"
              ? structured.displayName
              : "",
  );

  if (!displayName) return null;
  if (isInternalGoogleServiceId(displayName)) return null;

  const description = normalizeServiceDescription(
    typeof value.description === "string"
      ? value.description
      : typeof freeFormLabel?.description === "string"
        ? freeFormLabel.description
        : typeof structured?.description === "string"
          ? structured.description
          : "",
  );

  return {
    displayName,
    ...(description ? { description } : {}),
  };
}

function uniqueServiceProposals(values: unknown[], limit = 12) {
  const seen = new Set<string>();
  const services: ProfileServiceItemProposal[] = [];

  for (const value of values) {
    const service = normalizeServiceProposal(value);
    if (!service) continue;

    const key = normalizeKey(service.displayName);
    if (seen.has(key)) continue;
    seen.add(key);
    services.push(service);
  }

  return services.slice(0, limit);
}

function serviceProposalToDiffValue(service: ProfileServiceItemProposal) {
  return service.description
    ? `${service.displayName} | ${service.description}`
    : service.displayName;
}

function serviceProposalLabels(services: ProfileServiceItemProposal[]) {
  return services.map((service) => service.displayName);
}

function mergeProfileServices(
  current: string[],
  recommended: ProfileServiceItemProposal[],
  limit = 12,
) {
  return uniqueServiceProposals([...current, ...recommended], limit);
}

function hasMissingServiceLabels(
  current: string[],
  recommended: ProfileServiceItemProposal[],
) {
  const currentKeys = new Set(
    current
      .map((value) => normalizeServiceProposal(value)?.displayName)
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeKey(value)),
  );
  return recommended.some(
    (value) => !currentKeys.has(normalizeKey(value.displayName)),
  );
}

/**
 * Vertical-agnostic fallback used only when the AI proposal builder is
 * unavailable. Returns the businessType as a single category — better than
 * nothing, but the LLM-driven `gmbAIService.generateProfileProposal` is the
 * primary source for category suggestions across all business types.
 */
function fallbackCategorySuggestions(input: {
  businessType?: string | null;
  services: string[];
}) {
  const suggestions: Array<string | null | undefined> = [];
  if (input.businessType) {
    suggestions.push(input.businessType);
  }
  return uniqueLabels(suggestions).slice(0, 5);
}

/**
 * Vertical-agnostic fallback for service suggestions. Returns the caller's
 * own context services unchanged — used only when the AI proposal builder is
 * unavailable.
 */
function fallbackServiceSuggestions(input: {
  businessType?: string | null;
  services: string[];
}) {
  const suggestions = [...input.services];
  if (suggestions.length === 0 && input.businessType) {
    suggestions.push(input.businessType);
  }
  return uniqueServiceProposals(suggestions, 12);
}

function extractServiceLabels(profile?: GoogleLocation | null): string[] {
  const raw = profile?.serviceItems;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const freeForm = record.freeFormServiceItem as
        | { label?: { displayName?: string } }
        | undefined;
      const structured = record.structuredServiceItem as
        | { serviceTypeId?: string; displayName?: string }
        | undefined;

      return (
        freeForm?.label?.displayName ||
        structured?.displayName ||
        humanizeGoogleServiceTypeId(structured?.serviceTypeId) ||
        null
      );
    })
    .filter((value): value is string => Boolean(value));
}

function summarizeConfiguredValue(value: unknown, configuredLabel: string) {
  return hasObjectValue(value) ? configuredLabel : null;
}

function normalizeProfile(
  profile: GoogleLocation | null,
  syncedAt: Date | string | null,
): NormalizedGMBProfile {
  return {
    syncedAt:
      syncedAt instanceof Date
        ? syncedAt.toISOString()
        : syncedAt,
    businessName: profile?.title ?? null,
    description: profile?.profile?.description ?? null,
    phoneNumber: profile?.phoneNumbers?.primaryPhone ?? null,
    websiteUrl: profile?.websiteUri ?? null,
    address: formatAddress(profile?.storefrontAddress) ?? null,
    categories: extractCategories(profile),
    services: extractServiceLabels(profile),
    regularHours: summarizeConfiguredValue(profile?.regularHours, "Regular hours configured"),
    specialHours: summarizeConfiguredValue(profile?.specialHours, "Special hours configured"),
  };
}

function profileValueChanged(currentValue: ProfileValue, proposedValue: ProfileValue) {
  if (Array.isArray(currentValue) || Array.isArray(proposedValue)) {
    const current = Array.isArray(currentValue) ? currentValue : currentValue ? [currentValue] : [];
    const proposed = Array.isArray(proposedValue) ? proposedValue : proposedValue ? [proposedValue] : [];
    return current.join("|").toLowerCase() !== proposed.join("|").toLowerCase();
  }

  return (currentValue ?? "").trim().toLowerCase() !== (proposedValue ?? "").trim().toLowerCase();
}

const PROFILE_FIELD_META: Record<
  ProfileFieldKey,
  { label: string; googleField: string | null; applySupported: boolean }
> = {
  businessName: { label: "Business name", googleField: "title", applySupported: true },
  description: { label: "Business description", googleField: "profile.description", applySupported: true },
  phoneNumber: { label: "Phone number", googleField: "phoneNumbers.primaryPhone", applySupported: true },
  websiteUrl: { label: "Website URL", googleField: "websiteUri", applySupported: true },
  address: { label: "Address", googleField: "storefrontAddress", applySupported: false },
  categories: { label: "Categories", googleField: "categories", applySupported: true },
  services: { label: "Services", googleField: "serviceItems", applySupported: true },
  regularHours: { label: "Regular hours", googleField: "regularHours", applySupported: true },
  specialHours: { label: "Special hours", googleField: "specialHours", applySupported: true },
};

function buildProfileDiff(
  currentProfile: NormalizedGMBProfile,
  field: ProfileFieldKey,
  proposedValue: ProfileValue,
) {
  const currentValue = currentProfile[field] as ProfileValue;
  if (!proposedValue || !profileValueChanged(currentValue, proposedValue)) {
    return null;
  }

  const meta = PROFILE_FIELD_META[field];
  return {
    field,
    label: meta.label,
    currentValue,
    proposedValue,
    googleField: meta.googleField,
    applySupported: isDirectlyApplySupportedProfileValue(field, proposedValue),
  } satisfies GMBProfileDiff;
}

function isDirectlyApplySupportedProfileValue(
  field: ProfileFieldKey,
  proposedValue: ProfileValue,
) {
  const meta = PROFILE_FIELD_META[field];
  if (!meta.applySupported) return false;

  if (field === "categories") {
    if (!Array.isArray(proposedValue) || proposedValue.length === 0) {
      return false;
    }
    // Apply-supported when every category is either already in Google's
    // resource-ID form OR can be resolved to a known `gcid:*` ID via the
    // category resolver. Free-form display names that aren't in the resolver
    // surface as "Approval record only" so the user applies them manually.
    return proposedValue.every(
      (value) => isGoogleCategoryResourceId(value) || resolveGoogleCategoryIds([value]).resolved.length > 0,
    );
  }

  if (field === "services") {
    // Google's serviceItems field accepts `freeFormServiceItem` objects which
    // pair a display name with a category resource ID. We can build that
    // shape from string display names if a primary category is available in
    // the patch context — `getSupportedProfileUpdateFromPayload` performs
    // that resolution at apply time, so this check only validates the shape
    // of the proposal itself. The applied flag is still consistent with the
    // result: when no resolvable category exists, the apply step skips the
    // services patch and the diff falls back to "Approval record only" via
    // a runtime check in resolveServicesForApply.
    return (
      Array.isArray(proposedValue) &&
      proposedValue.length > 0 &&
      proposedValue.every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    );
  }

  if (field === "regularHours" || field === "specialHours") {
    return isRecord(proposedValue);
  }

  return typeof proposedValue === "string" && proposedValue.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProfileReview(payload: Record<string, unknown>): GMBProfileReview | null {
  const review = payload.profileReview;
  if (!isRecord(review) || !Array.isArray(review.diffs)) {
    return null;
  }

  return review as GMBProfileReview;
}

function hasObjectValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function createRule(
  rule: Omit<HealthRule, "points"> & { points: number },
): HealthRule {
  return {
    ...rule,
    points: clamp(rule.points, 0, rule.maxPoints),
  };
}

export function calculateGMBProfileHealthScore(
  signals: GMBHealthSignals,
): GMBHealthScoreResult {
  const rules: HealthRule[] = [
    createRule({
      key: "nap_website",
      title: "Complete core business details",
      description: "Name, address or service area, phone, and website should all be present.",
      group: "completeness",
      priority: "high",
      maxPoints: 4,
      points:
        Number(signals.hasName) +
        Number(signals.hasAddress) +
        Number(signals.hasPhone) +
        Number(signals.hasWebsite),
      recommendedAction: "Fill missing core profile fields before optimizing content.",
      evidence: {
        hasName: signals.hasName,
        hasAddress: signals.hasAddress,
        hasPhone: signals.hasPhone,
        hasWebsite: signals.hasWebsite,
      },
    }),
    createRule({
      key: "categories",
      title: "Use accurate primary and secondary categories",
      description: "Profiles need at least one exact category, with a few accurate secondary categories when available.",
      group: "completeness",
      priority: "high",
      maxPoints: 3,
      points:
        signals.categoriesCount >= 2
          ? 3
          : signals.categoriesCount === 1
            ? 2
            : 0,
      recommendedAction: "Compare GBP categories against top local competitors and add only accurate categories.",
      evidence: { categoriesCount: signals.categoriesCount },
    }),
    createRule({
      key: "description",
      title:
        signals.descriptionLength > DESCRIPTION_RECOMMENDED_MAX
          ? "Description nearing Google's 750-char limit"
          : "Add a useful business description",
      description:
        signals.descriptionLength > DESCRIPTION_RECOMMENDED_MAX
          ? `Profile descriptions over ${DESCRIPTION_RECOMMENDED_MAX} characters risk truncation. Trim to under ${DESCRIPTION_RECOMMENDED_MAX} before saving to keep messaging intact.`
          : "A profile description should explain services, location relevance, and differentiators without keyword stuffing.",
      group: "completeness",
      priority:
        signals.descriptionLength > DESCRIPTION_RECOMMENDED_MAX
          ? "high"
          : "medium",
      maxPoints: 2,
      points:
        signals.descriptionLength >= 250 &&
        signals.descriptionLength <= DESCRIPTION_RECOMMENDED_MAX
          ? 2
          : signals.hasDescription
            ? 1
            : 0,
      recommendedAction:
        signals.descriptionLength > DESCRIPTION_RECOMMENDED_MAX
          ? `Trim the description below ${DESCRIPTION_RECOMMENDED_MAX} characters.`
          : "Draft a concise, compliant profile description for approval.",
      evidence: { descriptionLength: signals.descriptionLength },
    }),
    createRule({
      key: "hours",
      title: "Maintain regular and special hours",
      description: "Regular hours and holiday/special hours reduce customer friction and prevent local visibility warnings.",
      group: "completeness",
      priority: "high",
      maxPoints: 2,
      points: Number(signals.hasRegularHours) + Number(signals.hasSpecialHours),
      recommendedAction: "Add or confirm business hours and upcoming holiday hours.",
      evidence: {
        hasRegularHours: signals.hasRegularHours,
        hasSpecialHours: signals.hasSpecialHours,
      },
    }),
    createRule({
      key: "services_attributes",
      title: "Publish services and relevant attributes",
      description: "Services and attributes help Google understand exact offerings and customer-fit signals.",
      group: "completeness",
      priority: "medium",
      maxPoints: 3,
      points:
        (signals.serviceItemsCount > 0 ? 2 : 0) +
        (signals.hasAttributes ? 1 : 0),
      recommendedAction: "Suggest predefined services and applicable attributes for approval.",
      evidence: {
        serviceItemsCount: signals.serviceItemsCount,
        hasAttributes: signals.hasAttributes,
      },
    }),
    createRule({
      key: "rating_quality",
      title: "Maintain a competitive rating",
      description: "Rating quality strongly affects customer choice in Maps and Local Pack results.",
      group: "reputation",
      priority: "high",
      maxPoints: 4,
      points:
        signals.averageRating === null
          ? 0
          : signals.averageRating >= 4.5
            ? 4
            : signals.averageRating >= 4
              ? 3
              : signals.averageRating >= 3.5
                ? 2
                : 1,
      recommendedAction: "Investigate negative themes and improve review response workflows.",
      evidence: { averageRating: signals.averageRating },
    }),
    createRule({
      key: "review_volume",
      title: "Build review volume steadily",
      description: "A consistent review base improves trust and helps the profile compete in crowded markets.",
      group: "reputation",
      priority: "medium",
      maxPoints: 4,
      points:
        signals.reviewCount >= 50
          ? 4
          : signals.reviewCount >= 25
            ? 3
            : signals.reviewCount >= 10
              ? 2
              : signals.reviewCount >= 1
                ? 1
                : 0,
      recommendedAction: "Launch a compliant review request campaign using the Google review link.",
      evidence: { reviewCount: signals.reviewCount },
    }),
    createRule({
      key: "unanswered_reviews",
      title: "Respond to reviews quickly",
      description: "Unanswered reviews, especially low-star reviews, weaken trust and should enter approval workflow.",
      group: "reputation",
      priority: signals.negativeUnansweredReviews > 0 ? "high" : "medium",
      maxPoints: 4,
      points:
        signals.unansweredReviews === 0
          ? 4
          : signals.unansweredReviews <= 2
            ? 2
            : 0,
      recommendedAction: "Generate review reply drafts for approval.",
      evidence: {
        unansweredReviews: signals.unansweredReviews,
        negativeUnansweredReviews: signals.negativeUnansweredReviews,
      },
    }),
    createRule({
      key: "review_velocity",
      title: "Keep review velocity healthy",
      description: "Recent reviews signal an active business and help customers trust current service quality.",
      group: "reputation",
      priority: "medium",
      maxPoints: 3,
      points:
        signals.recentReviewCount >= 4
          ? 3
          : signals.recentReviewCount >= 1
            ? 2
            : 0,
      recommendedAction: "Ask recent customers for honest feedback using a compliant request flow.",
      evidence: { recentReviewCount: signals.recentReviewCount },
    }),
    createRule({
      key: "review_response_rate",
      title: "Improve response coverage",
      description: "A high response rate shows the business is active and attentive.",
      group: "reputation",
      priority: "low",
      maxPoints: 2,
      points:
        signals.reviewResponseRate >= 0.85
          ? 2
          : signals.reviewResponseRate >= 0.5
            ? 1
            : 0,
      recommendedAction: "Use approval-first AI drafts to close the review response backlog.",
      evidence: { reviewResponseRate: signals.reviewResponseRate },
    }),
    createRule({
      key: "recent_posts",
      title: "Publish fresh Google posts",
      description: "Recent posts support engagement and let local searchers see timely offers, services, and updates.",
      group: "engagement",
      priority: "medium",
      maxPoints: 4,
      points:
        signals.recentPostCount >= 4
          ? 4
          : signals.recentPostCount >= 2
            ? 3
            : signals.recentPostCount === 1
              ? 2
              : 0,
      recommendedAction: "Create post drafts from blogs, services, discovery keywords, and seasonal prompts.",
      evidence: { recentPostCount: signals.recentPostCount },
    }),
    createRule({
      key: "media_assets",
      title:
        signals.recentMediaPublishedCount === 0
          ? "Refresh photos — none published in the last 7 days"
          : "Use real local photos",
      description:
        signals.recentMediaPublishedCount === 0
          ? "Profiles with weekly fresh photos out-rank stale ones on local pack. Upload at least one real business photo this week — exterior, food, team, or service in action."
          : "Fresh, real photos improve trust. Client photos should be prioritized over AI images.",
      group: "engagement",
      // Cadence beats library size for ranking. If nothing has been published
      // in 7 days the recommendation is high-priority regardless of the total
      // library count.
      priority: signals.recentMediaPublishedCount === 0 ? "high" : "medium",
      maxPoints: 4,
      points:
        signals.mediaAssetCount >= 10
          ? 4
          : signals.mediaAssetCount >= 5
            ? 3
            : signals.mediaAssetCount >= 1
              ? 2
              : 0,
      recommendedAction:
        signals.recentMediaPublishedCount === 0
          ? "Upload a fresh real business photo this week to keep the GBP feed active."
          : "Queue real business photos for review before publishing.",
      evidence: {
        mediaAssetCount: signals.mediaAssetCount,
        recentMediaPublishedCount: signals.recentMediaPublishedCount,
      },
    }),
    createRule({
      key: "profile_actions",
      title: "Drive profile actions",
      description: "Website clicks, calls, and direction requests show whether visibility is producing customer intent.",
      group: "engagement",
      priority: "medium",
      maxPoints: 4,
      points:
        signals.conversionActions30d >= 50
          ? 4
          : signals.conversionActions30d >= 15
            ? 3
            : signals.conversionActions30d >= 1
              ? 2
              : 0,
      recommendedAction: "Improve CTAs, service relevance, and post links with UTM tracking.",
      evidence: { conversionActions30d: signals.conversionActions30d },
    }),
    createRule({
      key: "discovery_keywords",
      title: "Use GBP discovery keywords",
      description: "Discovery keywords reveal the real searches Google associates with the profile.",
      group: "visibility",
      priority: "high",
      maxPoints: 5,
      points:
        signals.discoveryKeywordCount >= 20
          ? 5
          : signals.discoveryKeywordCount >= 5
            ? 4
            : signals.discoveryKeywordCount >= 1
              ? 3
              : 0,
      recommendedAction: "Sync monthly discovery keywords and convert gaps into posts, services, and pages.",
      evidence: { discoveryKeywordCount: signals.discoveryKeywordCount },
    }),
    createRule({
      key: "rank_scans",
      title: "Track Maps and Local Pack rankings",
      description: "Local rank scans show where the profile appears around the service area and who outranks it.",
      group: "visibility",
      priority: "high",
      maxPoints: 5,
      points:
        signals.rankScanCount30d > 0
          ? signals.bestClientRank !== null && signals.bestClientRank <= 3
            ? 5
            : 3
          : 0,
      recommendedAction: "Run DataForSEO local rank scans for priority services and locations.",
      evidence: {
        rankScanCount30d: signals.rankScanCount30d,
        bestClientRank: signals.bestClientRank,
      },
    }),
    createRule({
      key: "competitors",
      title: "Benchmark competitors",
      description: "Competitor snapshots explain category, review, rating, distance, content, service, and photo gaps.",
      group: "visibility",
      priority: "medium",
      maxPoints: 3,
      points:
        signals.competitorCount >= 5
          ? 3
          : signals.competitorCount >= 1
            ? 2
            : 0,
      recommendedAction: "Collect competitor snapshots from Maps scans and compare category/review/content gaps.",
      evidence: { competitorCount: signals.competitorCount },
    }),
    createRule({
      key: "conversion_basics",
      title: "Make conversion paths obvious",
      description: "Website, phone, review link, and tracked profile/post URLs make GBP traffic measurable.",
      group: "conversion",
      priority: "high",
      maxPoints: 4,
      points:
        Number(signals.hasWebsite) +
        Number(signals.hasPhone) +
        Number(signals.hasReviewLink) +
        (signals.attributionLinkCount > 0 ? 1 : 0),
      recommendedAction: "Create UTM-tagged profile, post, and campaign links.",
      evidence: {
        hasWebsite: signals.hasWebsite,
        hasPhone: signals.hasPhone,
        hasReviewLink: signals.hasReviewLink,
        attributionLinkCount: signals.attributionLinkCount,
      },
    }),
    // Phase 2 ranking foundations — checks driven by the structured tables
    // (GMBCategory, GMBBusinessHours, GMBAttribute) and verification columns.
    createRule({
      key: "verification_state",
      title:
        signals.verificationState === "SUSPENDED"
          ? "Profile is suspended"
          : signals.verificationState === "PENDING"
            ? "Verification is pending"
            : signals.verificationState === "DUPLICATE"
              ? "Listing flagged as duplicate"
              : signals.isVerified
                ? "Profile is verified"
                : "Profile is not verified",
      description:
        "Unverified or suspended profiles do not rank in Google Maps. Verification is the single biggest local-visibility prerequisite.",
      group: "visibility",
      priority: signals.isVerified ? "low" : "high",
      maxPoints: 6,
      points: signals.isVerified
        ? 6
        : signals.verificationState === "PENDING"
          ? 2
          : 0,
      recommendedAction:
        signals.verificationState === "SUSPENDED"
          ? "Open a reinstatement request in your Google Business Profile."
          : signals.verificationState === "DUPLICATE"
            ? "Resolve the duplicate in the Business Profile manager."
            : signals.verificationState === "PENDING"
              ? "Complete the pending verification step (enter the code Google sent)."
              : "Start verification from the Business Profile manager.",
      evidence: {
        verificationState: signals.verificationState,
        isVerified: signals.isVerified,
      },
    }),
    createRule({
      key: "primary_category_structured",
      title: signals.hasPrimaryCategoryStructured
        ? "Primary category is set"
        : "Primary category is missing",
      description:
        "Your primary category is the strongest signal Google uses to match your profile to local queries. One category, chosen precisely, outperforms multiple vague ones.",
      group: "completeness",
      priority: "high",
      maxPoints: 4,
      points: signals.hasPrimaryCategoryStructured ? 4 : 0,
      recommendedAction:
        "Pick a primary category in the Ranking Foundations card that matches your most-searched offering.",
      evidence: {
        hasPrimaryCategoryStructured: signals.hasPrimaryCategoryStructured,
        structuredCategoriesCount: signals.structuredCategoriesCount,
      },
    }),
    createRule({
      key: "weekly_hours_complete",
      title:
        signals.weeklyHoursDaysCovered === 7
          ? "Weekly hours are complete"
          : `Weekly hours cover only ${signals.weeklyHoursDaysCovered} of 7 days`,
      description:
        "Google ranks profiles with complete, consistent hours higher and reduces visibility when hours are missing. Every day needs an explicit open/closed/24-hour state.",
      group: "completeness",
      priority: "high",
      maxPoints: 4,
      points:
        signals.weeklyHoursDaysCovered >= 7
          ? 4
          : signals.weeklyHoursDaysCovered >= 5
            ? 3
            : signals.weeklyHoursDaysCovered >= 1
              ? 1
              : 0,
      recommendedAction:
        "Open the Hours tab in Ranking Foundations and fill in every day (use Closed for days you're not open).",
      evidence: { weeklyHoursDaysCovered: signals.weeklyHoursDaysCovered },
    }),
    createRule({
      key: "timezone_set",
      title: signals.timezoneSet ? "Timezone set" : "Timezone not set",
      description:
        "Hours rely on timezone for accurate display in Maps. Without it, DST transitions can briefly show wrong hours.",
      group: "completeness",
      priority: "low",
      maxPoints: 1,
      points: signals.timezoneSet ? 1 : 0,
      recommendedAction:
        "Run a profile sync — timezone is auto-derived from your address by Google.",
      evidence: { timezoneSet: signals.timezoneSet },
    }),
    createRule({
      key: "structured_attributes_present",
      title:
        signals.structuredAttributesCount === 0
          ? "No business attributes set"
          : `${signals.structuredAttributesCount} attribute${signals.structuredAttributesCount === 1 ? "" : "s"} configured`,
      description:
        "Attributes drive Maps filtering (wheelchair accessible, has wifi, online appointments). Profiles with more accurate attributes match more high-intent queries.",
      group: "completeness",
      priority: "medium",
      maxPoints: 2,
      points:
        signals.structuredAttributesCount >= 5
          ? 2
          : signals.structuredAttributesCount >= 1
            ? 1
            : 0,
      recommendedAction:
        "Open the Attributes tab in Ranking Foundations and answer the ones marked required for your primary category.",
      evidence: { structuredAttributesCount: signals.structuredAttributesCount },
    }),
  ];

  const groupTotals = Object.keys(GROUP_WEIGHTS).reduce(
    (acc, group) => {
      acc[group as HealthGroup] = { points: 0, maxPoints: 0 };
      return acc;
    },
    {} as Record<HealthGroup, { points: number; maxPoints: number }>,
  );

  for (const rule of rules) {
    groupTotals[rule.group].points += rule.points;
    groupTotals[rule.group].maxPoints += rule.maxPoints;
  }

  const groupScores = Object.entries(groupTotals).reduce(
    (acc, [group, total]) => {
      const weight = GROUP_WEIGHTS[group as HealthGroup];
      acc[group as HealthGroup] =
        total.maxPoints > 0
          ? Math.round((total.points / total.maxPoints) * weight)
          : 0;
      return acc;
    },
    {} as Record<HealthGroup, number>,
  );

  const score = clamp(
    Object.values(groupScores).reduce((sum, value) => sum + value, 0),
    0,
    100,
  );

  const items = rules.map((rule) => ({
    checkKey: rule.key,
    title: rule.title,
    description: rule.description,
    category: rule.group,
    status: scoreStatus(rule.points, rule.maxPoints),
    priority: rule.priority,
    scoreImpact: Math.max(0, rule.maxPoints - rule.points),
    recommendedAction: rule.recommendedAction,
    evidenceJson: rule.evidence,
  }));

  return {
    score,
    completenessScore: groupScores.completeness,
    reputationScore: groupScores.reputation,
    engagementScore: groupScores.engagement,
    visibilityScore: groupScores.visibility,
    conversionScore: groupScores.conversion,
    items,
    summary:
      score >= 85
        ? "Strong local visibility foundation with optimization opportunities."
        : score >= 65
          ? "Good base, but several approval-ready improvements can raise local visibility."
          : "Profile needs focused work across completeness, reputation, engagement, and visibility.",
  };
}

export function buildGmbUtmUrl(
  destinationUrl: string,
  params: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string | null;
  },
) {
  const url = new URL(destinationUrl);
  url.searchParams.set("utm_source", params.source ?? "google");
  url.searchParams.set("utm_medium", params.medium ?? "organic");
  url.searchParams.set("utm_campaign", params.campaign ?? "gbp");
  if (params.content) {
    url.searchParams.set("utm_content", params.content);
  }
  return url.toString();
}

export function calculateLocalResultMatchConfidence(params: {
  result: Pick<
    DataForSEOLocalMapResult,
    "title" | "placeId" | "cid" | "domain" | "url" | "address"
  >;
  businessName?: string | null;
  businessAddress?: string | null;
  businessWebsite?: string | null;
  placeId?: string | null;
  cid?: string | null;
}): { confidence: number; matchedBy: string | null } {
  const resultPlaceId = params.result.placeId?.toLowerCase();
  const placeId = params.placeId?.toLowerCase();
  if (resultPlaceId && placeId && resultPlaceId === placeId) {
    return { confidence: 1, matchedBy: "place_id" };
  }

  const resultCid = params.result.cid?.toLowerCase();
  const cid = params.cid?.toLowerCase();
  if (resultCid && cid && resultCid === cid) {
    return { confidence: 1, matchedBy: "cid" };
  }

  const resultDomain =
    params.result.domain?.replace(/^www\./, "").toLowerCase() ??
    extractDomain(params.result.url);
  const businessDomain = extractDomain(params.businessWebsite);
  if (resultDomain && businessDomain && resultDomain === businessDomain) {
    return { confidence: 0.86, matchedBy: "domain" };
  }

  const title = normalizeText(params.result.title);
  const businessName = normalizeText(params.businessName);
  const address = normalizeText(params.result.address);
  const businessAddress = normalizeText(params.businessAddress);
  const addressesCorroborate =
    !!address && !!businessAddress && shareStreetSignals(address, businessAddress);

  if (title && businessName && title === businessName) {
    // Exact normalized title equality. DataForSEO's organic-SERP local_pack
    // (the 3-pack) frequently omits place_id / cid / detailed address, so for
    // those items title is the only reliable identifier. The pack is already
    // geo-scoped to the searched lat/long, so an exact title match in a 3-item
    // result list is a strong signal it's the same business.
    if (addressesCorroborate) {
      return { confidence: 0.85, matchedBy: "name_address" };
    }
    return { confidence: 0.78, matchedBy: "exact_name" };
  }

  if (title && businessName && (title.includes(businessName) || businessName.includes(title))) {
    // Substring match (e.g. "Shawarma Moose - Toronto" vs "Shawarma Moose")
    // is only safe when corroborated by street-number + street-name tokens.
    // Without corroboration it stays fuzzy_name and is rejected by callers.
    if (addressesCorroborate) {
      return { confidence: 0.78, matchedBy: "name_address_partial" };
    }
    return { confidence: 0.55, matchedBy: "fuzzy_name" };
  }

  return { confidence: 0, matchedBy: null };
}

function shareStreetSignals(a: string, b: string): boolean {
  const sa = extractStreetSignals(a);
  const sb = extractStreetSignals(b);
  return (
    !!sa.number &&
    !!sa.word &&
    sa.number === sb.number &&
    sa.word === sb.word
  );
}

function extractStreetSignals(
  normalized: string,
): { number: string | null; word: string | null } {
  const tokens = normalized.split(" ").filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (/^\d/.test(t)) {
      for (let j = i + 1; j < tokens.length; j += 1) {
        const next = tokens[j] as string;
        if (/^[a-z]{2,}$/.test(next)) {
          return { number: t, word: next };
        }
      }
      return { number: t, word: null };
    }
  }
  return { number: null, word: null };
}

export class GMBLocalVisibilityService {
  constructor(private readonly gmbService = new GoogleMyBusinessService()) {}

  private async getConnectedGmb(businessId: string) {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      include: {
        business: {
          include: {
            GeoProfile: true,
            Photos: true,
          },
        },
      },
    });

    if (!gmb || !gmb.isActive || !gmb.locationId) {
      throw new Error("Google My Business not connected");
    }

    return gmb;
  }

  private async getCurrentProfileOverview(
    businessId: string,
  ): Promise<NormalizedGMBProfile> {
    const snapshot = await prisma.gMBProfileSnapshot.findFirst({
      where: { businessId },
      orderBy: { syncedAt: "desc" },
    });

    if (snapshot?.profileJson) {
      return normalizeProfile(
        snapshot.profileJson as GoogleLocation,
        snapshot.syncedAt,
      );
    }

    const gmb = await this.getConnectedGmb(businessId);
    const cachedCategories = stringArrayFromJson(gmb.cachedCategories);
    return normalizeProfile(
      {
        title: gmb.businessName ?? undefined,
        storefrontAddress: gmb.businessAddress
          ? { addressLines: [gmb.businessAddress] }
          : undefined,
        phoneNumbers: gmb.businessPhone
          ? { primaryPhone: gmb.businessPhone }
          : undefined,
        websiteUri: gmb.businessWebsite ?? undefined,
        categories: cachedCategories.length > 0
          ? {
              primaryCategory: { displayName: cachedCategories[0] },
              additionalCategories: cachedCategories
                .slice(1)
                .map((category) => ({ displayName: category })),
            }
          : undefined,
      },
      gmb.lastSyncAt,
    );
  }

  private async getBusinessProposal(businessId: string): Promise<BusinessProfileProposal> {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        businessName: true,
        businessType: true,
        businessDescription: true,
        businessWebsiteUrl: true,
        businessPhone: true,
        businessAddress: true,
        businessCity: true,
        businessState: true,
        businessCountry: true,
        targetAudience: true,
        detectedServices: true,
        selectedServices: true,
        servicesPriority: true,
        websiteAnalysis: {
          select: {
            coreServices: {
              select: {
                topLevel: true,
                subOfferings: true,
                industryFocus: true,
              },
            },
          },
        },
      },
    });

    if (!business) {
      throw new Error("Business not found");
    }

    const effectiveServices = resolveEffectiveServices({
      selectedServices: business.selectedServices,
      detectedServices: business.detectedServices,
      servicesPriority: business.servicesPriority,
      websiteAnalysis: business.websiteAnalysis,
    });
    const contextServices = uniqueLabels([
      ...effectiveServices.orderedPrimaryServices,
      ...effectiveServices.subOfferings,
      ...effectiveServices.industryFocus,
    ]).slice(0, 12);

    // Real searched queries from GBP insights. These are high-confidence
    // signals of what customers are actually typing when they find this
    // business, and feed the SEO-tuned description rules in the LLM prompt.
    const topDiscoveryKeywordRows = await prisma.gMBDiscoveryKeyword.findMany({
      where: { businessId },
      orderBy: { impressions: "desc" },
      take: 5,
      select: { keyword: true },
    });
    const topDiscoveryKeywords = topDiscoveryKeywordRows
      .map((row) => row.keyword)
      .filter(Boolean);

    // Use the AI-driven proposal builder so suggestions adapt to the actual
    // vertical (plumber, dentist, salon, restaurant, etc.) instead of being
    // hard-coded for one business type. Falls back to a generic shape when
    // the LLM is unavailable so the page still renders something useful.
    const aiProposal = await gmbAIService
      .generateProfileProposal({
        businessId,
        businessName: business.businessName,
        businessType: business.businessType,
        description: business.businessDescription,
        targetAudience: business.targetAudience,
        city: business.businessCity,
        state: business.businessState,
        country: business.businessCountry,
        websiteUrl: business.businessWebsiteUrl,
        contextServices,
        topDiscoveryKeywords,
      })
      .catch((error) => {
        console.error("AI profile proposal failed, using fallback:", error);
        return null;
      });

    const services = uniqueServiceProposals(
      [
        ...contextServices,
        ...(aiProposal?.services ?? []),
      ],
      12,
    );

    // Categories travel as display names through the diff so the UI compares
    // cleanly with Google's display-name responses and renders human-readable
    // values. Resource-ID resolution happens at apply time in
    // `getSupportedProfileUpdateFromPayload`, where each display name is
    // mapped to its `categories/gcid:*` ID before patching Google. Names not
    // in the resolver still surface as suggestions but are flagged
    // "Approval record only" (manual handling in Google).
    const aiCategories = uniqueLabels(aiProposal?.categories ?? []);
    const categories =
      aiCategories.length > 0
        ? aiCategories
        : fallbackCategorySuggestions({
            businessType: business.businessType,
            services: serviceProposalLabels(services),
          });

    const description =
      aiProposal?.description ||
      business.businessDescription ||
      this.buildGenericProfileDescription({
        businessName: business.businessName,
        businessType: business.businessType,
        city: business.businessCity,
        services: serviceProposalLabels(services),
      });

    return {
      businessName: business.businessName,
      description,
      phoneNumber: business.businessPhone,
      websiteUrl: business.businessWebsiteUrl,
      address: formatBusinessAddress(business),
      categories,
      services:
        services.length > 0
          ? services
          : fallbackServiceSuggestions({
              businessType: business.businessType,
              services: contextServices,
            }),
    };
  }

  private buildGenericProfileDescription(input: {
    businessName: string | null;
    businessType: string | null;
    city: string | null;
    services: string[];
  }): string {
    const name = input.businessName || "This business";
    const type = input.businessType || "local services";
    const cityClause = input.city ? ` in ${input.city}` : "";
    const servicesClause =
      input.services.length > 0
        ? ` Services include ${input.services.slice(0, 4).join(", ")}.`
        : "";
    return `${name} provides ${type}${cityClause}.${servicesClause} Contact us to learn how we can help.`.slice(
      0,
      720,
    );
  }

  private async persistLiveProfileSnapshot(
    businessId: string,
    gmb: {
      id: string;
      businessName?: string | null;
      businessAddress?: string | null;
      businessPhone?: string | null;
      businessWebsite?: string | null;
      placeId?: string | null;
    },
    profile: GoogleLocation,
  ) {
    const categories = extractCategories(profile);
    const snapshot = await prisma.gMBProfileSnapshot.create({
      data: {
        businessId,
        gmbId: gmb.id,
        profileJson: profile as Prisma.InputJsonValue,
        categoriesJson: categories as Prisma.InputJsonValue,
        servicesJson: (profile.serviceItems ?? null) as Prisma.InputJsonValue,
        hoursJson: (profile.regularHours ?? null) as Prisma.InputJsonValue,
        specialHoursJson: (profile.specialHours ?? null) as Prisma.InputJsonValue,
        moreHoursJson: (profile.moreHours ?? null) as Prisma.InputJsonValue,
        serviceAreaJson: (profile.serviceArea ?? null) as Prisma.InputJsonValue,
        attributesJson: (profile.attributes ?? null) as Prisma.InputJsonValue,
        googleUpdatesJson:
          ((profile as unknown as { googleUpdated?: unknown }).googleUpdated ??
            null) as Prisma.InputJsonValue,
      },
    });

    await prisma.googleMyBusiness.update({
      where: { businessId },
      data: {
        businessName: profile.title ?? gmb.businessName,
        businessAddress: formatAddress(profile.storefrontAddress) ?? gmb.businessAddress,
        businessPhone: profile.phoneNumbers?.primaryPhone ?? gmb.businessPhone,
        businessWebsite: profile.websiteUri ?? gmb.businessWebsite,
        cachedCategories: categories,
        placeId: profile.metadata?.placeId ?? gmb.placeId,
        lastSyncError: null,
      },
    });

    // Phase 1 ranking foundations: keep the structured hours/categories/
    // attributes tables in sync with the live Google profile. Tolerant parser;
    // never blocks the snapshot write.
    await backfillStructuredDataFromProfile(businessId, gmb.id, {
      regularHours: profile.regularHours,
      specialHours: profile.specialHours,
      categories: profile.categories,
      attributes: profile.attributes,
    }).catch((err) => {
      console.error(
        `[gmb-backfill] Failed to refresh structured tables for ${businessId}:`,
        err,
      );
    });

    await this.evaluateProfileMetadataAlerts(businessId, gmb.id, profile);

    return snapshot;
  }

  private async refreshProfileSnapshotFromLive(businessId: string) {
    const gmb = await this.getConnectedGmb(businessId);
    const profile = await this.gmbService.getProfileDetails(businessId);
    const snapshot = await this.persistLiveProfileSnapshot(businessId, gmb, profile);

    return {
      gmb,
      profile,
      snapshot,
      currentProfile: normalizeProfile(profile, snapshot.syncedAt),
    };
  }

  private async evaluateProfileMetadataAlerts(
    businessId: string,
    gmbId: string,
    profile: GoogleLocation,
  ) {
    const metadata = profile.metadata ?? {};
    const openInfo = profile.openInfo ?? {};

    if (openInfo.status === "CLOSED_PERMANENTLY") {
      await this.ensureAlert({
        businessId,
        gmbId,
        alertType: "gbp_closed_permanently",
        title: "Google profile is marked permanently closed",
        description:
          "Google has flagged this listing as permanently closed. Local-pack ranking will be suppressed until the status is corrected.",
        severity: "high",
        payloadJson: { openInfo: openInfo as unknown as Prisma.InputJsonValue },
      });
    }

    if (openInfo.status === "CLOSED_TEMPORARILY") {
      await this.ensureAlert({
        businessId,
        gmbId,
        alertType: "gbp_closed_temporarily",
        title: "Google profile is marked temporarily closed",
        description:
          "Google has flagged this listing as temporarily closed. Re-open as soon as the business resumes operations to recover ranking.",
        severity: "high",
        payloadJson: { openInfo: openInfo as unknown as Prisma.InputJsonValue },
      });
    }

    if (typeof metadata.duplicateLocation === "string" && metadata.duplicateLocation.length > 0) {
      await this.ensureAlert({
        businessId,
        gmbId,
        alertType: "gbp_duplicate_listing",
        title: "Duplicate Google listing detected",
        description:
          "Google identified this profile as a duplicate of another listing. Duplicates split ranking signal and confuse customers — request consolidation.",
        severity: "high",
        payloadJson: {
          duplicateLocation: metadata.duplicateLocation,
        },
      });
    }

    if (metadata.hasPendingEdits === true) {
      await this.ensureAlert({
        businessId,
        gmbId,
        alertType: "gbp_pending_edits",
        title: "Google has pending edits awaiting review",
        description:
          "Edits to this profile are pending Google review. Until they are accepted, customers may see stale information and ranking signals can be inconsistent.",
        severity: "medium",
        payloadJson: { hasPendingEdits: true },
      });
    }
  }

  private async maybeRefreshProfileSnapshot(businessId: string, forceRefresh = false) {
    const gmb = await this.getConnectedGmb(businessId);
    const latest = await prisma.gMBProfileSnapshot.findFirst({
      where: { businessId },
      orderBy: { syncedAt: "desc" },
    });

    const isFresh =
      latest && Date.now() - latest.syncedAt.getTime() < 12 * 60 * 60 * 1000;
    if (!forceRefresh && isFresh) {
      return latest;
    }

    try {
      const profile = await this.gmbService.getProfileDetails(businessId);
      return await this.persistLiveProfileSnapshot(businessId, gmb, profile);
    } catch (error) {
      await prisma.gMBAlert.create({
        data: {
          businessId,
          gmbId: gmb.id,
          alertType: "profile_sync_failed",
          title: "Google profile sync failed",
          description: error instanceof Error ? error.message : "Google profile sync failed",
          severity: "high",
          payloadJson: {
            source: "profile_snapshot",
          },
        },
      }).catch(() => undefined);

      if (latest) {
        return latest;
      }

      throw error;
    }
  }

  private async syncPerformanceMetrics(businessId: string, days = 90) {
    const gmb = await this.getConnectedGmb(businessId);
    const rows = await this.gmbService.getPerformanceDailyMetrics(businessId, days);

    for (const row of rows) {
      await prisma.gMBDailyMetric.upsert({
        where: {
          businessId_metricDate: {
            businessId,
            metricDate: new Date(`${row.date}T00:00:00.000Z`),
          },
        },
        update: {
          impressionsSearch: Math.round(row.impressionsSearch),
          impressionsMaps: Math.round(row.impressionsMaps),
          websiteClicks: Math.round(row.websiteClicks),
          callClicks: Math.round(row.callClicks),
          directionRequests: Math.round(row.directionRequests),
          bookings: Math.round(row.bookings),
          menuClicks: Math.round(row.menuClicks),
          foodOrders: Math.round(row.foodOrders),
          rawJson: row.raw as Prisma.InputJsonValue,
        },
        create: {
          businessId,
          gmbId: gmb.id,
          metricDate: new Date(`${row.date}T00:00:00.000Z`),
          impressionsSearch: Math.round(row.impressionsSearch),
          impressionsMaps: Math.round(row.impressionsMaps),
          websiteClicks: Math.round(row.websiteClicks),
          callClicks: Math.round(row.callClicks),
          directionRequests: Math.round(row.directionRequests),
          bookings: Math.round(row.bookings),
          menuClicks: Math.round(row.menuClicks),
          foodOrders: Math.round(row.foodOrders),
          rawJson: row.raw as Prisma.InputJsonValue,
        },
      });
    }

    return rows;
  }

  private async syncDiscoveryKeywords(businessId: string, months = 3) {
    const gmb = await this.getConnectedGmb(businessId);
    const keywords = await this.gmbService.getDiscoveryKeywordImpressions(
      businessId,
      months,
    );

    for (const keyword of keywords) {
      await prisma.gMBDiscoveryKeyword.upsert({
        where: {
          businessId_keyword_month: {
            businessId,
            keyword: keyword.keyword,
            month: new Date(keyword.month),
          },
        },
        update: {
          impressions: keyword.impressions,
          rawJson: (keyword.raw ?? null) as Prisma.InputJsonValue,
          source: "gbp_performance",
        },
        create: {
          businessId,
          gmbId: gmb.id,
          keyword: keyword.keyword,
          month: new Date(keyword.month),
          impressions: keyword.impressions,
          rawJson: (keyword.raw ?? null) as Prisma.InputJsonValue,
          source: "gbp_performance",
        },
      });
    }

    return keywords;
  }

  private async seedMediaAssetsFromBusinessPhotos(businessId: string) {
    const gmb = await this.getConnectedGmb(businessId);
    const photos = gmb.business.Photos ?? [];

    for (const photo of photos) {
      const existing = await prisma.gMBMediaAsset.findFirst({
        where: {
          businessId,
          OR: [{ businessPhotoId: photo.id }, { sourceUrl: photo.url }],
        },
        select: { id: true },
      });

      if (existing) {
        continue;
      }

      await prisma.gMBMediaAsset.create({
        data: {
          businessId,
          gmbId: gmb.id,
          businessPhotoId: photo.id,
          sourceUrl: photo.url,
          category: photo.category,
          status: "PENDING",
          caption: photo.altText,
        },
      });
    }
  }

  private async buildSignals(businessId: string): Promise<GMBHealthSignals> {
    const gmb = await this.getConnectedGmb(businessId);
    const latestSnapshot = await prisma.gMBProfileSnapshot.findFirst({
      where: { businessId },
      orderBy: { syncedAt: "desc" },
    });

    const profile = (latestSnapshot?.profileJson ?? {}) as GoogleLocation;
    const categories = Array.isArray(latestSnapshot?.categoriesJson)
      ? (latestSnapshot.categoriesJson as string[])
      : Array.isArray(gmb.cachedCategories)
        ? (gmb.cachedCategories as string[])
        : [];

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      reviews,
      recentPostCount,
      mediaAssetCount,
      recentMediaPublishedCount,
      metrics30d,
      discoveryKeywordCount,
      rankScans,
      competitorCount,
      attributionLinkCount,
      structuredHours,
      structuredCategories,
      structuredAttributeCount,
    ] = await Promise.all([
      prisma.gMBReview.findMany({
        where: { gmbId: gmb.id },
        select: {
          rating: true,
          isResponded: true,
          reviewDate: true,
        },
      }),
      prisma.gMBPost.count({
        where: {
          gmbId: gmb.id,
          publishedAt: { gte: thirtyDaysAgo },
          status: "PUBLISHED",
        },
      }),
      prisma.gMBMediaAsset.count({
        where: {
          businessId,
          status: { in: ["PENDING", "APPROVED", "PUBLISHED"] },
        },
      }),
      prisma.gMBMediaAsset.count({
        where: {
          businessId,
          status: "PUBLISHED",
          publishedAt: { gte: sevenDaysAgo },
        },
      }),
      prisma.gMBDailyMetric.findMany({
        where: {
          businessId,
          metricDate: { gte: thirtyDaysAgo },
        },
      }),
      prisma.gMBDiscoveryKeyword.count({ where: { businessId } }),
      prisma.gMBLocalRankScan.findMany({
        where: {
          businessId,
          requestedAt: { gte: thirtyDaysAgo },
          status: "COMPLETE",
        },
        include: {
          results: {
            where: { isClient: true },
            select: { position: true },
          },
        },
      }),
      prisma.gMBCompetitorSnapshot.count({ where: { businessId } }),
      prisma.gMBAttributionLink.count({ where: { businessId } }),
      prisma.gMBBusinessHours.findMany({
        where: { businessId },
        select: { dayOfWeek: true, isClosed: true, is24Hours: true, openTime: true },
      }),
      prisma.gMBCategory.findMany({
        where: { businessId },
        select: { isPrimary: true },
      }),
      prisma.gMBAttribute.count({ where: { businessId } }),
    ]);

    const reviewCount = reviews.length || gmb.totalReviewCount || 0;
    const averageRating =
      reviews.length > 0
        ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
        : gmb.cachedAverageRating ?? null;
    const unansweredReviews = reviews.filter((review) => !review.isResponded).length;
    const negativeUnansweredReviews = reviews.filter(
      (review) => !review.isResponded && review.rating <= 2,
    ).length;
    const recentReviewCount = reviews.filter(
      (review) => review.reviewDate >= ninetyDaysAgo,
    ).length;
    const reviewResponseRate =
      reviews.length > 0
        ? reviews.filter((review) => review.isResponded).length / reviews.length
        : 0;
    const conversionActions30d = metrics30d.reduce(
      (sum, day) => sum + day.websiteClicks + day.callClicks + day.directionRequests,
      0,
    );
    const clientRanks = rankScans.flatMap((scan) =>
      scan.results
        .map((result) => result.position)
        .filter((position): position is number => typeof position === "number"),
    );
    const bestClientRank =
      clientRanks.length > 0 ? Math.min(...clientRanks) : null;

    const distinctHoursDays = new Set(
      structuredHours
        .filter((row) => row.isClosed || row.is24Hours || row.openTime)
        .map((row) => row.dayOfWeek),
    );
    const hasPrimaryCategoryStructured = structuredCategories.some((c) => c.isPrimary);

    return {
      hasName: Boolean(profile.title ?? gmb.businessName),
      hasAddress: Boolean(
        formatAddress(profile.storefrontAddress) ??
          gmb.businessAddress ??
          profile.serviceArea,
      ),
      hasPhone: Boolean(profile.phoneNumbers?.primaryPhone ?? gmb.businessPhone),
      hasWebsite: Boolean(profile.websiteUri ?? gmb.businessWebsite),
      categoriesCount: categories.length,
      hasRegularHours: hasObjectValue(profile.regularHours ?? latestSnapshot?.hoursJson),
      hasSpecialHours: hasObjectValue(
        profile.specialHours ?? latestSnapshot?.specialHoursJson,
      ),
      hasDescription: Boolean(profile.profile?.description),
      descriptionLength: profile.profile?.description?.length ?? 0,
      serviceItemsCount: Array.isArray(profile.serviceItems)
        ? profile.serviceItems.length
        : Array.isArray(latestSnapshot?.servicesJson)
          ? latestSnapshot.servicesJson.length
          : 0,
      hasAttributes: hasObjectValue(profile.attributes ?? latestSnapshot?.attributesJson),
      averageRating:
        typeof averageRating === "number" ? Number(averageRating.toFixed(1)) : null,
      reviewCount,
      unansweredReviews,
      negativeUnansweredReviews,
      recentReviewCount,
      reviewResponseRate,
      recentPostCount,
      mediaAssetCount,
      recentMediaPublishedCount,
      conversionActions30d,
      discoveryKeywordCount,
      rankScanCount30d: rankScans.length,
      bestClientRank,
      competitorCount,
      attributionLinkCount,
      hasReviewLink: Boolean(profile.metadata?.newReviewUri ?? gmb.placeId),
      verificationState: gmb.verificationState ?? null,
      isVerified: gmb.verified === true,
      hasPrimaryCategoryStructured,
      structuredCategoriesCount: structuredCategories.length,
      weeklyHoursDaysCovered: distinctHoursDays.size,
      structuredAttributesCount: structuredAttributeCount,
      timezoneSet: typeof gmb.timezone === "string" && gmb.timezone.length > 0,
    };
  }

  private buildProfileReviewForHealthItem(
    item: GMBHealthItem,
    currentProfile: NormalizedGMBProfile,
    proposal: BusinessProfileProposal,
  ): GMBProfileReview | null {
    const diffs: Array<GMBProfileDiff | null> = [];

    if (item.checkKey === "nap_website") {
      diffs.push(
        buildProfileDiff(currentProfile, "businessName", proposal.businessName),
        buildProfileDiff(currentProfile, "address", proposal.address),
        buildProfileDiff(currentProfile, "phoneNumber", proposal.phoneNumber),
        buildProfileDiff(currentProfile, "websiteUrl", proposal.websiteUrl),
      );
    }

    if (item.checkKey === "description") {
      // If the current description is over the recommended max, the user wants
      // a trim of what's there now — not an AI regeneration that could swap
      // out the entire message. Propose a deterministic sentence-boundary
      // trim of the current text. Only fall back to the AI proposal when
      // there's nothing to trim (e.g. the description field is empty and we
      // need a draft).
      const currentDescription =
        typeof currentProfile.description === "string"
          ? currentProfile.description
          : "";
      const proposedDescription =
        currentDescription.length > DESCRIPTION_RECOMMENDED_MAX
          ? trimDescriptionToRecommendedLimit(currentDescription)
          : proposal.description;
      diffs.push(
        buildProfileDiff(currentProfile, "description", proposedDescription),
      );
    }

    if (item.checkKey === "categories") {
      const proposedCategories = mergeProfileLabels(
        currentProfile.categories,
        proposal.categories,
        8,
      );
      diffs.push(
        hasMissingLabels(currentProfile.categories, proposal.categories)
          ? buildProfileDiff(currentProfile, "categories", proposedCategories)
          : null,
      );
    }

    if (item.checkKey === "services_attributes") {
      const proposedServices = mergeProfileServices(
        currentProfile.services,
        proposal.services,
        12,
      );
      diffs.push(
        hasMissingServiceLabels(currentProfile.services, proposal.services)
          ? buildProfileDiff(
              currentProfile,
              "services",
              proposedServices.map(serviceProposalToDiffValue),
            )
          : null,
      );
    }

    if (item.checkKey === "hours") {
      diffs.push(
        buildProfileDiff(currentProfile, "regularHours", "Confirm regular hours in Google"),
        buildProfileDiff(currentProfile, "specialHours", "Confirm holiday or special hours"),
      );
    }

    const filteredDiffs = diffs.filter((diff): diff is GMBProfileDiff => Boolean(diff));
    if (filteredDiffs.length === 0) {
      return null;
    }

    return {
      currentProfile,
      diffs: filteredDiffs,
    };
  }

  private actionForHealthItem(
    item: GMBHealthItem,
    currentProfile: NormalizedGMBProfile,
    proposal: BusinessProfileProposal,
  ) {
    const actionTypeByKey: Record<string, string> = {
      nap_website: "profile_edit",
      categories: "category_update",
      description: "profile_description",
      hours: "hours_update",
      services_attributes: "services_attributes",
      rating_quality: "review_theme_analysis",
      review_volume: "review_campaign",
      unanswered_reviews: "review_reply",
      review_velocity: "review_campaign",
      review_response_rate: "review_reply",
      recent_posts: "post_draft",
      media_assets: "media_upload",
      profile_actions: "attribution",
      discovery_keywords: "content_opportunity",
      rank_scans: "rank_scan",
      competitors: "competitor_analysis",
      conversion_basics: "attribution",
    };

    const profileReview = this.buildProfileReviewForHealthItem(
      item,
      currentProfile,
      proposal,
    );

    return {
      // checkKey is the stable identity for de-dup and stale-action cleanup.
      // Title can mutate when rule wording changes (e.g. trim threshold copy),
      // so we never match on title alone. See upsertRecommendedActions.
      checkKey: item.checkKey,
      actionType: actionTypeByKey[item.checkKey] ?? "profile_optimization",
      title: item.recommendedAction,
      description: item.description,
      category: item.category,
      priority: item.priority,
      payloadJson: {
        checkKey: item.checkKey,
        evidence: item.evidenceJson ?? {},
        ...(profileReview ? { profileReview } : {}),
      },
    };
  }

  private async upsertRecommendedActions(
    businessId: string,
    items: GMBHealthItem[],
  ) {
    const gmb = await this.getConnectedGmb(businessId);
    const currentProfile = await this.getCurrentProfileOverview(businessId);
    const proposal = await this.getBusinessProposal(businessId);
    const candidates = items
      .filter((item) => item.status !== "pass")
      .sort((a, b) => b.scoreImpact - a.scoreImpact)
      .slice(0, 12)
      .map((item) => this.actionForHealthItem(item, currentProfile, proposal));

    const profileExpansionItems: GMBHealthItem[] = [
      {
        checkKey: "categories",
        title: "Add relevant Google profile categories",
        description:
          "Uplift found additional category opportunities from the business type, services, and website context. Review them before making manual Google category changes.",
        category: "completeness",
        status: "warning",
        priority: "medium",
        scoreImpact: 0,
        recommendedAction: "Review and add relevant Google categories.",
        evidenceJson: { source: "business_context" },
      },
      {
        checkKey: "services_attributes",
        title: "Add services to the Google profile",
        description:
          "Uplift found service offerings from the website and business context that are missing from the connected Google profile.",
        category: "completeness",
        status: "warning",
        priority: "medium",
        scoreImpact: 0,
        recommendedAction: "Review and add relevant Google services.",
        evidenceJson: { source: "business_context" },
      },
    ];

    for (const item of profileExpansionItems) {
      const candidate = this.actionForHealthItem(item, currentProfile, proposal);
      const review = getProfileReview(candidate.payloadJson);
      if (!review || review.diffs.length === 0) {
        continue;
      }

      const alreadyQueued = candidates.some(
        (existing) => existing.actionType === candidate.actionType,
      );
      if (!alreadyQueued) {
        candidates.push(candidate);
      }
    }

    // De-dup by payloadJson.checkKey — the stable identity from the rule
    // definition. Using title is fragile because rule wording mutates (e.g.
    // when a threshold flips priority or when we tune copy), which leaks
    // duplicate PENDING rows on every recompute.
    const candidateCheckKeys = new Set<string>();
    for (const candidate of candidates) {
      candidateCheckKeys.add(candidate.checkKey);

      const existing = await prisma.gMBActionRecommendation.findFirst({
        where: {
          businessId,
          source: "health_rules",
          status: { in: ["PENDING", "APPROVED"] },
          payloadJson: {
            path: ["checkKey"],
            equals: candidate.checkKey,
          },
        },
        select: { id: true },
      });

      if (existing) {
        await prisma.gMBActionRecommendation.update({
          where: { id: existing.id },
          data: {
            // Refresh title + everything else so the row reflects current
            // wording even when checkKey is stable.
            actionType: candidate.actionType,
            title: candidate.title,
            description: candidate.description,
            category: candidate.category,
            priority: candidate.priority,
            payloadJson: candidate.payloadJson as Prisma.InputJsonValue,
          },
        });
        continue;
      }

      await prisma.gMBActionRecommendation.create({
        data: {
          businessId,
          gmbId: gmb.id,
          actionType: candidate.actionType,
          title: candidate.title,
          description: candidate.description,
          category: candidate.category,
          priority: candidate.priority,
          payloadJson: candidate.payloadJson as Prisma.InputJsonValue,
          source: "health_rules",
        },
      });
    }

    // Stale-action sweep: any rule-generated PENDING row whose checkKey is no
    // longer in the candidate set means the underlying rule stopped firing
    // (e.g. the user applied a fix, or a threshold moved). Auto-dismiss so the
    // UI doesn't keep showing the obsolete recommendation forever.
    const existingHealthRuleRows = await prisma.gMBActionRecommendation.findMany({
      where: {
        businessId,
        source: "health_rules",
        status: "PENDING",
      },
      select: { id: true, payloadJson: true },
    });

    const now = new Date();
    for (const row of existingHealthRuleRows) {
      const payload =
        row.payloadJson && typeof row.payloadJson === "object"
          ? (row.payloadJson as Record<string, unknown>)
          : null;
      const checkKey =
        payload && typeof payload.checkKey === "string"
          ? (payload.checkKey as string)
          : null;
      if (!checkKey || candidateCheckKeys.has(checkKey)) continue;

      await prisma.gMBActionRecommendation.update({
        where: { id: row.id },
        data: {
          status: "DISMISSED",
          dismissedAt: now,
          payloadJson: {
            ...(payload ?? {}),
            dismissedReason: "auto_stale",
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async ensureAlert(params: {
    businessId: string;
    gmbId: string;
    alertType: string;
    title: string;
    description?: string;
    severity?: string;
    payloadJson?: Prisma.InputJsonValue;
  }) {
    const existing = await prisma.gMBAlert.findFirst({
      where: {
        businessId: params.businessId,
        alertType: params.alertType,
        status: "OPEN",
      },
      select: { id: true },
    });

    if (existing) {
      return;
    }

    await prisma.gMBAlert.create({
      data: {
        businessId: params.businessId,
        gmbId: params.gmbId,
        alertType: params.alertType,
        title: params.title,
        description: params.description,
        severity: params.severity ?? "medium",
        payloadJson: params.payloadJson,
      },
    });
  }

  private async generateDerivedAlerts(businessId: string, signals: GMBHealthSignals) {
    const gmb = await this.getConnectedGmb(businessId);

    if (gmb.lastSyncError) {
      await this.ensureAlert({
        businessId,
        gmbId: gmb.id,
        alertType: "gbp_token_or_sync_failure",
        title: "Google profile sync needs attention",
        description: gmb.lastSyncError,
        severity: "high",
      });
    }

    if (signals.negativeUnansweredReviews > 0) {
      await this.ensureAlert({
        businessId,
        gmbId: gmb.id,
        alertType: "unanswered_negative_reviews",
        title: "Unanswered negative reviews",
        description: `${signals.negativeUnansweredReviews} low-star review(s) still need approved replies.`,
        severity: "high",
      });
    }

    if (signals.recentReviewCount === 0 && signals.reviewCount > 0) {
      await this.ensureAlert({
        businessId,
        gmbId: gmb.id,
        alertType: "review_velocity_low",
        title: "No recent review activity",
        description: "No reviews were found in the last 90 days.",
        severity: "medium",
      });
    }

    if (!signals.hasSpecialHours) {
      await this.ensureAlert({
        businessId,
        gmbId: gmb.id,
        alertType: "missing_special_hours",
        title: "Special or holiday hours are missing",
        description: "Confirm upcoming holiday hours before customers see inaccurate availability.",
        severity: "low",
      });
    }
  }

  async getProfileHealth(businessId: string, forceRefresh = false) {
    const gmb = await this.getConnectedGmb(businessId);

    if (!forceRefresh) {
      const recentRun = await prisma.gMBProfileHealthRun.findFirst({
        where: {
          businessId,
          generatedAt: { gte: new Date(Date.now() - 60 * 1000) },
        },
        orderBy: { generatedAt: "desc" },
        include: { items: true },
      });

      if (recentRun) {
        const signals = await this.buildSignals(businessId);
        const actions = await this.getActions(businessId);
        const currentProfile = await this.getCurrentProfileOverview(businessId);
        return {
          run: recentRun,
          signals,
          actions: actions.actions,
          currentProfile,
        };
      }
    }

    if (isDemoGmbConnection(gmb)) {
      await this.seedMediaAssetsFromBusinessPhotos(businessId);
    } else {
      await this.maybeRefreshProfileSnapshot(businessId, forceRefresh);
      await Promise.allSettled([
        this.syncPerformanceMetrics(businessId, 90),
        this.syncDiscoveryKeywords(businessId, 3),
        this.seedMediaAssetsFromBusinessPhotos(businessId),
      ]);
    }

    const signals = await this.buildSignals(businessId);
    const score = calculateGMBProfileHealthScore(signals);

    const run = await prisma.gMBProfileHealthRun.create({
      data: {
        businessId,
        gmbId: gmb.id,
        score: score.score,
        completenessScore: score.completenessScore,
        reputationScore: score.reputationScore,
        engagementScore: score.engagementScore,
        visibilityScore: score.visibilityScore,
        conversionScore: score.conversionScore,
        summary: score.summary,
        source: "rules",
        items: {
          create: score.items.map((item) => ({
            checkKey: item.checkKey,
            title: item.title,
            description: item.description,
            category: item.category,
            status: item.status,
            priority: item.priority,
            scoreImpact: item.scoreImpact,
            recommendedAction: item.recommendedAction,
            evidenceJson: (item.evidenceJson ?? null) as Prisma.InputJsonValue,
          })),
        },
      },
      include: { items: true },
    });

    await this.upsertRecommendedActions(businessId, score.items);
    await this.generateDerivedAlerts(businessId, signals);

    const actions = await this.getActions(businessId);
    const currentProfile = await this.getCurrentProfileOverview(businessId);

    return {
      run,
      signals,
      actions: actions.actions,
      currentProfile,
    };
  }

  async getDiscoveryKeywords(
    businessId: string,
    options: { forceRefresh?: boolean; months?: number } = {},
  ) {
    const gmb = await this.getConnectedGmb(businessId);
    if (options.forceRefresh && !isDemoGmbConnection(gmb)) {
      await this.syncDiscoveryKeywords(businessId, options.months ?? 3);
    }

    const keywords = await prisma.gMBDiscoveryKeyword.findMany({
      where: { businessId },
      orderBy: [{ month: "desc" }, { impressions: "desc" }],
      take: 100,
    });

    return {
      keywords:
        keywords.length > 0
          ? keywords.map((keyword) => ({
              id: keyword.id,
              keyword: keyword.keyword,
              month: keyword.month.toISOString(),
              impressions: keyword.impressions,
              source: keyword.source,
            }))
          : EMPTY_DISCOVERY_KEYWORDS,
    };
  }

  async getMetricsTimeSeries(
    businessId: string,
    options: { forceRefresh?: boolean; days?: number } = {},
  ) {
    const days = options.days ?? 90;
    const gmb = await this.getConnectedGmb(businessId);
    if (options.forceRefresh && !isDemoGmbConnection(gmb)) {
      await this.syncPerformanceMetrics(businessId, days);
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    const rows = await prisma.gMBDailyMetric.findMany({
      where: {
        businessId,
        metricDate: { gte: since },
      },
      orderBy: { metricDate: "asc" },
    });

    return {
      metrics: rows.map((row) => ({
        id: row.id,
        date: row.metricDate.toISOString(),
        impressionsSearch: row.impressionsSearch,
        impressionsMaps: row.impressionsMaps,
        websiteClicks: row.websiteClicks,
        callClicks: row.callClicks,
        directionRequests: row.directionRequests,
        bookings: row.bookings,
        menuClicks: row.menuClicks,
        foodOrders: row.foodOrders,
      })),
    };
  }

  async getActions(businessId: string, status?: string) {
    const actions = await prisma.gMBActionRecommendation.findMany({
      where: {
        businessId,
        ...(status ? { status } : {}),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 100,
    });

    return { actions };
  }

  private buildProfileEditDiffs(
    currentProfile: NormalizedGMBProfile,
    businessData: Record<string, unknown>,
  ): GMBProfileDiff[] {
    const requested: Array<[ProfileFieldKey, unknown]> = [
      ["businessName", businessData.name],
      ["description", businessData.description],
      ["phoneNumber", businessData.phoneNumber],
      ["websiteUrl", businessData.websiteUrl],
      ["address", businessData.address],
      ["categories", businessData.categories],
      ["services", businessData.serviceItems],
      ["regularHours", businessData.businessHours],
    ];

    const diffs: GMBProfileDiff[] = [];

    for (const [field, value] of requested) {
      const proposedValue =
        field === "services" && Array.isArray(value)
          ? uniqueServiceProposals(value).map(serviceProposalToDiffValue)
          : Array.isArray(value)
            ? value.map((entry) =>
                typeof entry === "string" ? entry : JSON.stringify(entry),
              )
            : typeof value === "string"
              ? value
              : value === undefined || value === null
                ? null
                : JSON.stringify(value);
      const diff = buildProfileDiff(currentProfile, field, proposedValue);
      if (diff) {
        diffs.push(diff);
      }
    }

    return diffs;
  }

  private getSupportedProfileUpdateFromPayload(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const supported: Record<string, unknown> = {};
    const review = getProfileReview(payload);

    if (isRecord(payload.businessData)) {
      const businessData = payload.businessData;
      for (const key of ["name", "phoneNumber", "websiteUrl", "description"]) {
        if (typeof businessData[key] === "string" && businessData[key].trim()) {
          supported[key] = businessData[key].trim();
        }
      }
      if (Array.isArray(businessData.categories)) {
        const resolvedCategories = this.resolveCategoriesForApply(
          businessData.categories,
        );
        if (resolvedCategories.length > 0) {
          supported.categories = resolvedCategories;
        }
      }
      // serviceItems may already be in Google's structured form (e.g. when
      // the caller supplies them directly). String arrays are converted into
      // freeFormServiceItem shape using the resolved primary category below.
      if (
        Array.isArray(businessData.serviceItems) &&
        businessData.serviceItems.every((item) => this.isGoogleServiceItemPayload(item))
      ) {
        supported.serviceItems = businessData.serviceItems;
      }
      for (const key of [
        "regularHours",
        "specialHours",
        "serviceArea",
        "attributes",
        "labels",
      ]) {
        if (businessData[key] !== undefined && businessData[key] !== null) {
          supported[key] = businessData[key];
        }
      }
    }

    if (review) {
      for (const diff of review.diffs) {
        if (!diff.applySupported) continue;

        if (typeof diff.proposedValue === "string") {
          if (diff.field === "businessName") supported.name = diff.proposedValue;
          if (diff.field === "phoneNumber") supported.phoneNumber = diff.proposedValue;
          if (diff.field === "websiteUrl") supported.websiteUrl = diff.proposedValue;
          if (diff.field === "description") supported.description = diff.proposedValue;
        }

        if (Array.isArray(diff.proposedValue)) {
          if (diff.field === "categories") {
            const resolved = this.resolveCategoriesForApply(diff.proposedValue);
            if (resolved.length > 0) {
              supported.categories = resolved;
            }
          }
        }

        if (isRecord(diff.proposedValue)) {
          if (diff.field === "regularHours") supported.regularHours = diff.proposedValue;
          if (diff.field === "specialHours") supported.specialHours = diff.proposedValue;
        }
      }
    }

    // Service-items conversion runs last because it depends on the resolved
    // primary category — Google's freeFormServiceItem shape requires a
    // category gcid. Source order: explicit businessData.serviceItems
    // (already-structured) wins, otherwise we look at string-array diffs and
    // wrap each display name into a freeFormServiceItem.
    if (!Array.isArray(supported.serviceItems)) {
      const serviceItems = this.collectServiceItemProposals(
        payload,
        review,
      );
      if (serviceItems.length > 0) {
        const primaryGcid = this.resolvePrimaryCategoryGcid(supported, review);
        if (primaryGcid) {
          supported.serviceItems = serviceItems.map((service) => ({
            // Google's FreeFormServiceItem schema is `{ category, label }` —
            // NOT `categoryId`. Using the wrong field name made every services
            // patch fail with HTTP 400 "Unknown name 'categoryId' ... Cannot
            // find field." The category value is the resource name in
            // `categories/gcid:*` form, which Google accepts here.
            freeFormServiceItem: {
              category: primaryGcid,
              label: {
                displayName: service.displayName,
                ...(service.description
                  ? { description: service.description }
                  : {}),
                languageCode: "en",
              },
            },
          }));
        }
      }
    }

    return supported;
  }

  /**
   * Collect service display names/descriptions from the patch payload. Pulls
   * from both `businessData.serviceItems` and from the `services`
   * profileReview diff. Filters anything already in Google's object form.
   */
  private collectServiceItemProposals(
    payload: Record<string, unknown>,
    review: GMBProfileReview | null,
  ): ProfileServiceItemProposal[] {
    const seen = new Set<string>();
    const serviceItems: ProfileServiceItemProposal[] = [];

    const append = (value: unknown) => {
      const service = normalizeServiceProposal(value);
      if (!service) return;

      const key = normalizeKey(service.displayName);
      if (seen.has(key)) return;

      seen.add(key);
      serviceItems.push(service);
    };

    if (isRecord(payload.businessData)) {
      const items = payload.businessData.serviceItems;
      if (Array.isArray(items)) {
        for (const value of items) append(value);
      }
    }

    if (review) {
      for (const diff of review.diffs) {
        if (diff.field !== "services" || !diff.applySupported) continue;
        if (!Array.isArray(diff.proposedValue)) continue;
        for (const value of diff.proposedValue) {
          append(value);
        }
      }
    }

    return serviceItems;
  }

  private isGoogleServiceItemPayload(value: unknown) {
    if (!isRecord(value)) return false;
    return isRecord(value.freeFormServiceItem) || isRecord(value.structuredServiceItem);
  }

  /**
   * Resolve a primary `categories/gcid:*` ID to attach to freeFormServiceItem
   * entries. Source order:
   *   1. `supported.categories[0]` — the patch's own primary category
   *   2. The categories diff in the same review
   *   3. The current Google profile's first category, resolved via the static map
   * Returns null when no resolvable primary category exists, in which case
   * the services patch is skipped (diff stays as approval-only at runtime).
   */
  private resolvePrimaryCategoryGcid(
    supported: Record<string, unknown>,
    review: GMBProfileReview | null,
  ): string | null {
    if (Array.isArray(supported.categories) && supported.categories.length > 0) {
      const head = supported.categories[0];
      if (typeof head === "string" && isGoogleCategoryResourceId(head)) {
        return head;
      }
    }

    if (review) {
      for (const diff of review.diffs) {
        if (diff.field !== "categories" || !Array.isArray(diff.proposedValue)) continue;
        const resolved = this.resolveCategoriesForApply(diff.proposedValue);
        const head = resolved[0];
        if (head) return head;
        if (Array.isArray(diff.currentValue)) {
          const resolvedFromCurrent = this.resolveCategoriesForApply(diff.currentValue);
          const headFromCurrent = resolvedFromCurrent[0];
          if (headFromCurrent) return headFromCurrent;
        }
      }
    }

    return null;
  }

  /**
   * Convert a mixed array of category display names and Google resource IDs
   * into the resource-ID form Google's businessInformation.locations.patch
   * endpoint expects. Display names that aren't in the resolver are dropped
   * (rather than rejected by Google) so the patch still applies the known
   * categories — unresolved names remain visible in the diff for manual
   * handling.
   */
  private resolveCategoriesForApply(values: unknown[]): string[] {
    const stringValues = values.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const value of stringValues) {
      const trimmed = value.trim();
      if (isGoogleCategoryResourceId(trimmed)) {
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          resolved.push(trimmed);
        }
        continue;
      }
      const { resolved: resolvedIds } = resolveGoogleCategoryIds([trimmed]);
      for (const id of resolvedIds) {
        if (!seen.has(id)) {
          seen.add(id);
          resolved.push(id);
        }
      }
    }
    return resolved;
  }

  private verifySupportedProfileUpdate(
    supportedProfileUpdate: Record<string, unknown>,
    liveProfile: GoogleLocation,
  ): string[] {
    const currentProfile = normalizeProfile(liveProfile, null);
    const failures: string[] = [];

    if (
      typeof supportedProfileUpdate.name === "string" &&
      normalizeComparableText(currentProfile.businessName) !==
        normalizeComparableText(supportedProfileUpdate.name)
    ) {
      failures.push("business name");
    }

    if (
      typeof supportedProfileUpdate.description === "string" &&
      normalizeComparableText(currentProfile.description) !==
        normalizeComparableText(supportedProfileUpdate.description)
    ) {
      failures.push("description");
    }

    if (
      typeof supportedProfileUpdate.phoneNumber === "string" &&
      normalizeComparablePhone(currentProfile.phoneNumber) !==
        normalizeComparablePhone(supportedProfileUpdate.phoneNumber)
    ) {
      failures.push("phone number");
    }

    if (
      typeof supportedProfileUpdate.websiteUrl === "string" &&
      normalizeComparableUrl(currentProfile.websiteUrl) !==
        normalizeComparableUrl(supportedProfileUpdate.websiteUrl)
    ) {
      failures.push("website URL");
    }

    if (Array.isArray(supportedProfileUpdate.categories)) {
      const expectedCategoryIds = supportedProfileUpdate.categories.filter(
        (value): value is string => isGoogleCategoryResourceId(value),
      );
      if (expectedCategoryIds.length > 0) {
        const liveCategoryIds = new Set(extractCategoryResourceIds(liveProfile));
        const missingCategories = expectedCategoryIds.filter(
          (value) => !liveCategoryIds.has(value),
        );
        if (missingCategories.length > 0) {
          failures.push("categories");
        }
      }
    }

    if (Array.isArray(supportedProfileUpdate.serviceItems)) {
      const expectedServices = uniqueServiceProposals(
        supportedProfileUpdate.serviceItems,
      ).map((service) => normalizeKey(service.displayName));
      if (expectedServices.length > 0) {
        const liveServices = new Set(
          currentProfile.services.map((service) => normalizeKey(service)),
        );
        const missingServices = expectedServices.filter(
          (service) => !liveServices.has(service),
        );
        if (missingServices.length > 0) {
          failures.push("services");
        }
      }
    }

    return failures;
  }

  async approveAction(businessId: string, actionId: string) {
    const action = await prisma.gMBActionRecommendation.findFirst({
      where: {
        id: actionId,
        businessId,
        status: { in: ["PENDING", "APPROVED"] },
      },
    });

    if (!action) {
      throw new Error(
        "Action not found or already applied/dismissed",
      );
    }

    const blockingAlert = await prisma.gMBAlert.findFirst({
      where: {
        businessId,
        status: "OPEN",
        alertType: {
          in: [
            "gbp_closed_permanently",
            "gbp_closed_temporarily",
            "gbp_duplicate_listing",
          ],
        },
      },
      select: { alertType: true, title: true },
    });

    if (blockingAlert) {
      throw new Error(
        `Cannot apply changes to Google: ${blockingAlert.title}. Resolve the alert first.`,
      );
    }

    const payload = (action.payloadJson ?? {}) as Record<string, unknown>;
    const now = new Date();

    // Fire-and-forget rank-impact baseline capture. Skipped automatically for
    // action types that don't move rank (review_reply, media_upload).
    const fireImpactCapture = () =>
      void captureEditImpactBaseline({
        id: action.id,
        businessId: action.businessId,
        gmbId: action.gmbId,
        actionType: action.actionType,
      }).catch((err) =>
        console.error(`[gmb-edit-impact] baseline capture failed for ${action.id}:`, err),
      );

    if (
      action.actionType === "review_reply" &&
      typeof payload.reviewId === "string" &&
      typeof payload.response === "string"
    ) {
      try {
        await this.gmbService.respondToReview(
          businessId,
          payload.reviewId,
          payload.response,
        );

        fireImpactCapture();
        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "APPLIED",
            approvedAt: now,
            appliedAt: now,
            error: null,
          },
        });
      } catch (error) {
        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "FAILED",
            approvedAt: now,
            error: error instanceof Error ? error.message : "Failed to apply action",
          },
        });
      }
    }

    if (action.actionType === "services_attributes") {
      const patch = isRecord(payload.googleAttributePatch)
        ? payload.googleAttributePatch
        : null;
      const attributeMask = Array.isArray(patch?.attributeMask)
        ? patch.attributeMask.filter(
            (value): value is string =>
              typeof value === "string" &&
              /^[a-z0-9_]{1,160}$/i.test(value),
          ).slice(0, 100)
        : [];
      const attributes = Array.isArray(patch?.attributes)
        ? patch.attributes.filter(isRecord).filter((attribute) =>
            typeof attribute.name === "string" &&
            attributeMask.includes(attribute.name),
          ).slice(0, 100)
        : [];

      if (attributeMask.length > 0) {
        try {
          await this.gmbService.updateAttributes(businessId, {
            attributeMask,
            attributes,
          });
          fireImpactCapture();
          return prisma.gMBActionRecommendation.update({
            where: { id: action.id },
            data: {
              status: "APPLIED",
              approvedAt: now,
              appliedAt: now,
              error: null,
            },
          });
        } catch (error) {
          console.error("[gmb-action] Attribute update failed:", error);
          return prisma.gMBActionRecommendation.update({
            where: { id: action.id },
            data: {
              status: "FAILED",
              approvedAt: now,
              error: "Google did not accept the attribute update. Reconnect and try again.",
            },
          });
        }
      }
    }

    const supportedProfileUpdate = this.getSupportedProfileUpdateFromPayload(payload);
    const shouldApplyProfileUpdate =
      [
        "profile_edit",
        "profile_description",
        "category_update",
        "categories_update",
        "hours_update",
        "special_hours_update",
      ].includes(action.actionType) &&
      Object.keys(supportedProfileUpdate).length > 0;

    if (shouldApplyProfileUpdate) {
      try {
        await this.gmbService.updateBusinessInfo(
          businessId,
          supportedProfileUpdate,
        );

        const gmb = await this.getConnectedGmb(businessId);
        if (!isDemoGmbConnection(gmb)) {
          let liveProfile: GoogleLocation;
          try {
            ({ profile: liveProfile } = await this.refreshProfileSnapshotFromLive(
              businessId,
            ));
          } catch (refreshError) {
            const message =
              refreshError instanceof Error
                ? refreshError.message
                : "Unable to re-fetch the live Google profile";
            throw new Error(
              `Google accepted the update, but Uplift could not verify it from the live profile: ${message}`,
            );
          }

          const verificationFailures = this.verifySupportedProfileUpdate(
            supportedProfileUpdate,
            liveProfile,
          );
          if (verificationFailures.length > 0) {
            throw new Error(
              `Google accepted the update, but the live profile did not confirm the ${verificationFailures.join(
                ", ",
              )} change yet. Uplift did not mark this as applied to avoid showing stale data.`,
            );
          }
        }

        // Bust the AI proposal cache so the next read reflects the just-applied
        // Google patch instead of the pre-edit suggestion. Best-effort.
        await gmbAIService
          .invalidateProfileProposalCache(businessId)
          .catch(() => undefined);

        fireImpactCapture();
        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "APPLIED",
            approvedAt: now,
            appliedAt: now,
            error: null,
          },
        });
      } catch (error) {
        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "FAILED",
            approvedAt: now,
            error: error instanceof Error ? error.message : "Failed to apply profile update",
          },
        });
      }
    }

    if (
      action.actionType === "media_upload" &&
      typeof payload.mediaAssetId === "string"
    ) {
      try {
        const asset = await prisma.gMBMediaAsset.findFirst({
          where: { id: payload.mediaAssetId, businessId },
        });

        if (!asset) {
          throw new Error("Media asset not found for this business");
        }

        if (asset.status === "PUBLISHED") {
          // Already published — claim the action without re-uploading.
          fireImpactCapture();
          return prisma.gMBActionRecommendation.update({
            where: { id: action.id },
            data: {
              status: "APPLIED",
              approvedAt: now,
              appliedAt: now,
              error: null,
            },
          });
        }

        const result = await this.gmbService.uploadMedia(businessId, {
          sourceUrl: asset.sourceUrl,
          mediaFormat: asset.mediaType === "VIDEO" ? "VIDEO" : "PHOTO",
          category: asset.category,
          caption: asset.caption ?? undefined,
        });

        await prisma.gMBMediaAsset.update({
          where: { id: asset.id },
          data: {
            status: "PUBLISHED",
            approvedAt: now,
            publishedAt: now,
            googleUrl: result.googleUrl ?? result.name ?? null,
            error: null,
          },
        });

        fireImpactCapture();
        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "APPLIED",
            approvedAt: now,
            appliedAt: now,
            error: null,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to publish media to Google";

        if (typeof payload.mediaAssetId === "string") {
          await prisma.gMBMediaAsset.update({
            where: { id: payload.mediaAssetId },
            data: {
              status: "FAILED",
              error: message,
            },
          }).catch(() => undefined);
        }

        return prisma.gMBActionRecommendation.update({
          where: { id: action.id },
          data: {
            status: "FAILED",
            approvedAt: now,
            error: message,
          },
        });
      }
    }

    return prisma.gMBActionRecommendation.update({
      where: { id: action.id },
      data: {
        status: "APPROVED",
        approvedAt: now,
        error: null,
      },
    });
  }

  async dismissAction(businessId: string, actionId: string) {
    const action = await prisma.gMBActionRecommendation.findFirst({
      where: {
        id: actionId,
        businessId,
        status: { in: ["PENDING", "APPROVED"] },
      },
      select: { id: true },
    });

    if (!action) {
      throw new Error(
        "Action not found or already applied/dismissed",
      );
    }

    return prisma.gMBActionRecommendation.update({
      where: { id: action.id },
      data: {
        status: "DISMISSED",
        dismissedAt: new Date(),
      },
    });
  }

  async queueProfileEditAction(
    businessId: string,
    businessData: Record<string, unknown>,
  ) {
    const gmb = await this.getConnectedGmb(businessId);
    const currentProfile = await this.getCurrentProfileOverview(businessId);
    const diffs = this.buildProfileEditDiffs(currentProfile, businessData);
    const fields = Object.keys(businessData);
    const action = await prisma.gMBActionRecommendation.create({
      data: {
        businessId,
        gmbId: gmb.id,
        actionType: "profile_edit",
        title: "Review Google Business Profile updates",
        description:
          diffs.length > 0
            ? `Review ${diffs.length} proposed Google profile update${diffs.length === 1 ? "" : "s"} before publishing.`
            : fields.length > 0
              ? `Review requested changes to ${fields.join(", ")} before publishing to Google.`
            : "Review requested profile changes before publishing to Google.",
        category: "completeness",
        priority: "high",
        status: "PENDING",
        payloadJson: {
          businessData,
          requiresGooglePatch: diffs.some((diff) => diff.applySupported),
          profileReview: {
            currentProfile,
            diffs,
          },
        } as Prisma.InputJsonValue,
        source: "profile_edit_request",
      },
    });

    return {
      queued: true,
      action,
    };
  }

  async getMedia(businessId: string) {
    await this.seedMediaAssetsFromBusinessPhotos(businessId);

    const media = await prisma.gMBMediaAsset.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
    });

    return { media };
  }

  async queueMediaAsset(
    businessId: string,
    params: { sourceUrl: string; category?: string; caption?: string },
  ) {
    const gmb = await this.getConnectedGmb(businessId);
    const media = await prisma.gMBMediaAsset.create({
      data: {
        businessId,
        gmbId: gmb.id,
        sourceUrl: params.sourceUrl,
        category: params.category ?? "OTHER",
        caption: params.caption,
        status: "PENDING",
      },
    });

    await prisma.gMBActionRecommendation.create({
      data: {
        businessId,
        gmbId: gmb.id,
        actionType: "media_upload",
        title: "Approve photo for Google Business Profile",
        description: params.caption ?? "Review this photo before publishing it to the profile.",
        category: "engagement",
        priority: "medium",
        payloadJson: { mediaAssetId: media.id, sourceUrl: params.sourceUrl },
        source: "media_workflow",
      },
    });

    return { media };
  }

  private getRankScanKeywords(
    business: {
      selectedServices: string[];
      businessCity?: string | null;
      businessType?: string | null;
      GeoProfile?: { locality?: string | null } | null;
    },
    providedKeywords?: string[],
    discoveryKeywords?: Array<{ keyword: string }>,
  ) {
    const keywords = [
      ...(providedKeywords ?? []),
      ...((discoveryKeywords ?? []).map((keyword) => keyword.keyword)),
      ...(business.selectedServices ?? []).map((service) => {
        const city = business.businessCity ?? business.GeoProfile?.locality;
        return city ? `${service} ${city}` : service;
      }),
      business.businessType && business.businessCity
        ? `${business.businessType} ${business.businessCity}`
        : business.businessType,
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .map((value) => value.trim());

    return Array.from(new Set(keywords)).slice(0, 8);
  }

  async runRankScan(
    businessId: string,
    options: {
      keywords?: string[];
      locationCode?: number;
      latitude?: number | null;
      longitude?: number | null;
      forceRefresh?: boolean;
    } = {},
  ) {
    const gmb = await this.getConnectedGmb(businessId);

    if (!isDemoGmbConnection(gmb)) {
      const cadence = (gmb.rankScanCadence ?? "weekly") as keyof typeof RANK_SCAN_CADENCE_MS;
      const cadenceMs =
        RANK_SCAN_CADENCE_MS[cadence] ?? RANK_SCAN_CADENCE_MS.weekly ?? 0;

      if (cadenceMs > 0) {
        const lastScan = await prisma.gMBLocalRankScan.findFirst({
          where: { businessId },
          orderBy: { requestedAt: "desc" },
          select: { requestedAt: true },
        });

        if (lastScan) {
          const elapsed = Date.now() - lastScan.requestedAt.getTime();
          if (elapsed < cadenceMs) {
            const retryAfterSeconds = Math.max(
              Math.ceil((cadenceMs - elapsed) / 1000),
              1,
            );
            throw new GMBRankScanThrottledError(
              "cadence",
              retryAfterSeconds,
              `Rank scan cadence is ${cadence}. Try again in ${Math.ceil(retryAfterSeconds / 3600)} hour(s).`,
            );
          }
        }
      }

      const rateLimit = evaluatePublicRateLimit({
        store: RANK_SCAN_RATE_LIMIT_STORE,
        key: `rankscan:${businessId}`,
        limit: RANK_SCAN_HOURLY_LIMIT,
        windowMs: RANK_SCAN_HOURLY_WINDOW_MS,
        bypass: false,
      });

      if (!rateLimit.allowed) {
        throw new GMBRankScanThrottledError(
          "hourly_cap",
          rateLimit.retryAfterSeconds,
          `Rank scan hourly cap of ${RANK_SCAN_HOURLY_LIMIT} reached. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).`,
        );
      }
    }

    const discoveryKeywords = await prisma.gMBDiscoveryKeyword.findMany({
      where: { businessId },
      orderBy: { impressions: "desc" },
      take: 5,
      select: { keyword: true },
    });
    const keywords = this.getRankScanKeywords(
      gmb.business,
      options.keywords,
      discoveryKeywords,
    );

    const scans = [];
    for (const keyword of keywords) {
      const scan = await prisma.gMBLocalRankScan.create({
        data: {
          businessId,
          gmbId: gmb.id,
          keyword,
          locationCode: options.locationCode ?? 2840,
          locationLabel:
            gmb.business.businessCity ??
            gmb.business.GeoProfile?.locality ??
            gmb.business.businessAddress ??
            null,
          latitude: options.latitude ?? gmb.business.GeoProfile?.latitude ?? null,
          longitude: options.longitude ?? gmb.business.GeoProfile?.longitude ?? null,
          status: "PENDING",
          source: isDemoGmbConnection(gmb) ? "gmb_demo" : "dataforseo_maps",
        },
      });

      if (isDemoGmbConnection(gmb)) {
        await prisma.gMBLocalRankResult.createMany({
          data: [
            {
              scanId: scan.id,
              position: 1,
              rankAbsolute: 1,
              matchConfidence: 0.96,
              matchedBy: "place_id",
              title: gmb.businessName ?? gmb.business.businessName,
              domain: extractDomain(
                gmb.businessWebsite ?? gmb.business.businessWebsiteUrl,
              ),
              url: gmb.businessWebsite ?? gmb.business.businessWebsiteUrl,
              placeId: gmb.placeId,
              cid: `demo-cid-${businessId}`,
              rating: gmb.cachedAverageRating ?? 4.6,
              reviewCount: gmb.totalReviewCount ?? 5,
              categoriesJson: (gmb.cachedCategories ?? []) as Prisma.InputJsonValue,
              address: gmb.businessAddress ?? gmb.business.businessAddress,
              latitude: gmb.business.GeoProfile?.latitude ?? null,
              longitude: gmb.business.GeoProfile?.longitude ?? null,
              isClient: true,
              rawJson: { source: "gmb_demo" },
            },
            {
              scanId: scan.id,
              position: 2,
              rankAbsolute: 2,
              matchConfidence: 0,
              title: "North Star Local Services",
              domain: "northstarlocal.example",
              url: "https://northstarlocal.example",
              placeId: "demo-competitor-place-1",
              cid: "demo-competitor-cid-1",
              rating: 4.8,
              reviewCount: 126,
              categoriesJson: (gmb.cachedCategories ?? []) as Prisma.InputJsonValue,
              address: "85 King St W, Toronto, ON",
              latitude: 43.6487,
              longitude: -79.3817,
              isClient: false,
              rawJson: { source: "gmb_demo" },
            },
          ],
        });

        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "COMPLETE",
              completedAt: new Date(),
              rawJson: { source: "gmb_demo", resultCount: 2 },
            },
            include: { results: true },
          }),
        );
        continue;
      }

      try {
        const results = await getLocalMapsResultsFromDataForSEO({
          keyword,
          locationCode: options.locationCode ?? 2840,
          latitude: options.latitude ?? gmb.business.GeoProfile?.latitude,
          longitude: options.longitude ?? gmb.business.GeoProfile?.longitude,
          forceRefresh: options.forceRefresh,
        });

        for (const result of results) {
          const match = calculateLocalResultMatchConfidence({
            result,
            businessName: gmb.businessName ?? gmb.business.businessName,
            businessAddress: gmb.businessAddress ?? gmb.business.businessAddress,
            businessWebsite:
              gmb.businessWebsite ?? gmb.business.businessWebsiteUrl,
            placeId: gmb.placeId,
          });
          const isClient =
            match.confidence >= 0.75 && match.matchedBy !== "fuzzy_name";

          await prisma.gMBLocalRankResult.create({
            data: {
              scanId: scan.id,
              position: result.rankGroup,
              rankAbsolute: result.rankAbsolute,
              matchConfidence: match.confidence,
              matchedBy: match.matchedBy,
              title: result.title,
              domain: result.domain,
              url: result.url,
              placeId: result.placeId,
              cid: result.cid,
              rating: result.rating,
              reviewCount: result.reviewCount,
              categoriesJson: result.categories as Prisma.InputJsonValue,
              address: result.address,
              latitude: result.latitude,
              longitude: result.longitude,
              isClient,
              rawJson: result.raw as Prisma.InputJsonValue,
            },
          });

          if (!isClient && result.title) {
            await prisma.gMBCompetitorSnapshot.create({
              data: {
                businessId,
                gmbId: gmb.id,
                name: result.title,
                domain: result.domain,
                url: result.url,
                placeId: result.placeId,
                cid: result.cid,
                rating: result.rating,
                reviewCount: result.reviewCount,
                categoriesJson: result.categories as Prisma.InputJsonValue,
                strengthsJson: {
                  rating: result.rating,
                  reviewCount: result.reviewCount,
                  categories: result.categories,
                },
                weaknessesJson: {
                  clientGapReason: "Review, category, distance, service, photo, or website relevance gap needs review.",
                },
              },
            });
          }
        }

        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "COMPLETE",
              completedAt: new Date(),
              rawJson: { resultCount: results.length },
            },
            include: { results: true },
          }),
        );
      } catch (error) {
        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "FAILED",
              completedAt: new Date(),
              error: error instanceof Error ? error.message : "Rank scan failed",
            },
            include: { results: true },
          }),
        );

        await this.ensureAlert({
          businessId,
          gmbId: gmb.id,
          alertType: "dataforseo_rank_scan_failed",
          title: "Local rank scan failed",
          description: error instanceof Error ? error.message : "DataForSEO scan failed",
          severity: "medium",
        });
      }
    }

    return { scans };
  }

  async getRankScans(businessId: string) {
    const scans = await prisma.gMBLocalRankScan.findMany({
      where: { businessId, source: { not: "dataforseo_local_pack" } },
      include: { results: { orderBy: { position: "asc" }, take: 20 } },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });

    return { scans };
  }

  // Local Pack scans track the 3-pack of businesses Google shows at the top
  // of regular web search for local-intent queries. Distinct from Maps rank
  // (different SERP surface, different ranking algorithm). Shares the same
  // GMBLocalRankScan table; distinguished by `source` and a `pack_size <= 3`
  // contract on the result rows.
  async getLocalPackScans(businessId: string) {
    const scans = await prisma.gMBLocalRankScan.findMany({
      where: { businessId, source: "dataforseo_local_pack" },
      include: { results: { orderBy: { position: "asc" }, take: 5 } },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });

    return { scans };
  }

  async runLocalPackScan(
    businessId: string,
    options: {
      keywords?: string[];
      locationCode?: number;
      latitude?: number | null;
      longitude?: number | null;
      forceRefresh?: boolean;
    } = {},
  ) {
    const gmb = await this.getConnectedGmb(businessId);

    if (!isDemoGmbConnection(gmb)) {
      const cadence = (gmb.rankScanCadence ?? "weekly") as keyof typeof RANK_SCAN_CADENCE_MS;
      const cadenceMs =
        RANK_SCAN_CADENCE_MS[cadence] ?? RANK_SCAN_CADENCE_MS.weekly ?? 0;

      if (cadenceMs > 0) {
        const lastScan = await prisma.gMBLocalRankScan.findFirst({
          where: { businessId, source: "dataforseo_local_pack" },
          orderBy: { requestedAt: "desc" },
          select: { requestedAt: true },
        });

        if (lastScan) {
          const elapsed = Date.now() - lastScan.requestedAt.getTime();
          if (elapsed < cadenceMs) {
            const retryAfterSeconds = Math.max(
              Math.ceil((cadenceMs - elapsed) / 1000),
              1,
            );
            throw new GMBRankScanThrottledError(
              "cadence",
              retryAfterSeconds,
              `Local pack scan cadence is ${cadence}. Try again in ${Math.ceil(retryAfterSeconds / 3600)} hour(s).`,
            );
          }
        }
      }

      const rateLimit = evaluatePublicRateLimit({
        store: RANK_SCAN_RATE_LIMIT_STORE,
        key: `localpackscan:${businessId}`,
        limit: RANK_SCAN_HOURLY_LIMIT,
        windowMs: RANK_SCAN_HOURLY_WINDOW_MS,
        bypass: false,
      });

      if (!rateLimit.allowed) {
        throw new GMBRankScanThrottledError(
          "hourly_cap",
          rateLimit.retryAfterSeconds,
          `Local pack scan hourly cap of ${RANK_SCAN_HOURLY_LIMIT} reached. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).`,
        );
      }
    }

    const discoveryKeywords = await prisma.gMBDiscoveryKeyword.findMany({
      where: { businessId },
      orderBy: { impressions: "desc" },
      take: 5,
      select: { keyword: true },
    });
    const keywords = this.getRankScanKeywords(
      gmb.business,
      options.keywords,
      discoveryKeywords,
    );

    const scans = [];
    for (const keyword of keywords) {
      const scan = await prisma.gMBLocalRankScan.create({
        data: {
          businessId,
          gmbId: gmb.id,
          keyword,
          locationCode: options.locationCode ?? 2840,
          locationLabel:
            gmb.business.businessCity ??
            gmb.business.GeoProfile?.locality ??
            gmb.business.businessAddress ??
            null,
          latitude: options.latitude ?? gmb.business.GeoProfile?.latitude ?? null,
          longitude: options.longitude ?? gmb.business.GeoProfile?.longitude ?? null,
          status: "PENDING",
          source: isDemoGmbConnection(gmb) ? "gmb_demo_local_pack" : "dataforseo_local_pack",
        },
      });

      if (isDemoGmbConnection(gmb)) {
        // Demo mode: synthesize a 3-pack with the client in position 2.
        await prisma.gMBLocalRankResult.createMany({
          data: [1, 2, 3].map((position) => ({
            scanId: scan.id,
            position,
            rankAbsolute: position,
            matchConfidence: position === 2 ? 0.96 : 0,
            matchedBy: position === 2 ? "place_id" : null,
            title:
              position === 2
                ? (gmb.businessName ?? gmb.business.businessName ?? "Demo Business")
                : `Demo competitor ${position}`,
            domain: position === 2 ? extractDomain(gmb.businessWebsite ?? gmb.business.businessWebsiteUrl) : null,
            url: position === 2 ? (gmb.businessWebsite ?? gmb.business.businessWebsiteUrl) : null,
            placeId: position === 2 ? gmb.placeId : `demo-pack-place-${position}`,
            cid: position === 2 ? `demo-cid-${businessId}` : `demo-pack-cid-${position}`,
            rating: position === 2 ? (gmb.cachedAverageRating ?? 4.6) : 4.3 + position * 0.1,
            reviewCount: position === 2 ? (gmb.totalReviewCount ?? 5) : 40 + position * 25,
            categoriesJson: (gmb.cachedCategories ?? []) as Prisma.InputJsonValue,
            address: position === 2 ? gmb.businessAddress : null,
            isClient: position === 2,
            rawJson: { source: "gmb_demo_local_pack", packPosition: position },
          })),
        });

        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "COMPLETE",
              completedAt: new Date(),
              rawJson: { source: "gmb_demo_local_pack", resultCount: 3 },
            },
            include: { results: true },
          }),
        );
        continue;
      }

      try {
        const results = await getLocalPackResultsFromDataForSEO({
          keyword,
          locationCode: options.locationCode ?? 2840,
          latitude: options.latitude ?? gmb.business.GeoProfile?.latitude,
          longitude: options.longitude ?? gmb.business.GeoProfile?.longitude,
          forceRefresh: options.forceRefresh,
        });

        for (const result of results) {
          const match = calculateLocalResultMatchConfidence({
            result,
            businessName: gmb.businessName ?? gmb.business.businessName,
            businessAddress: gmb.businessAddress ?? gmb.business.businessAddress,
            businessWebsite:
              gmb.businessWebsite ?? gmb.business.businessWebsiteUrl,
            placeId: gmb.placeId,
          });
          const isClient =
            match.confidence >= 0.75 && match.matchedBy !== "fuzzy_name";

          await prisma.gMBLocalRankResult.create({
            data: {
              scanId: scan.id,
              position: result.rankGroup,
              rankAbsolute: result.rankAbsolute,
              matchConfidence: match.confidence,
              matchedBy: match.matchedBy,
              title: result.title,
              domain: result.domain,
              url: result.url,
              placeId: result.placeId,
              cid: result.cid,
              rating: result.rating,
              reviewCount: result.reviewCount,
              categoriesJson: result.categories as Prisma.InputJsonValue,
              address: result.address,
              latitude: result.latitude,
              longitude: result.longitude,
              isClient,
              rawJson: result.raw as Prisma.InputJsonValue,
            },
          });
        }

        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "COMPLETE",
              completedAt: new Date(),
              rawJson: { resultCount: results.length, packSize: results.length },
            },
            include: { results: true },
          }),
        );
      } catch (error) {
        scans.push(
          await prisma.gMBLocalRankScan.update({
            where: { id: scan.id },
            data: {
              status: "FAILED",
              completedAt: new Date(),
              error: error instanceof Error ? error.message : "Local pack scan failed",
            },
            include: { results: true },
          }),
        );

        await this.ensureAlert({
          businessId,
          gmbId: gmb.id,
          alertType: "dataforseo_local_pack_scan_failed",
          title: "Local pack scan failed",
          description: error instanceof Error ? error.message : "DataForSEO scan failed",
          severity: "medium",
        });
      }
    }

    return { scans };
  }

  async getCompetitors(businessId: string) {
    const gmb = await this.getConnectedGmb(businessId);
    const competitors = await prisma.gMBCompetitorSnapshot.findMany({
      where: { businessId },
      orderBy: [{ lastSeenAt: "desc" }, { reviewCount: "desc" }],
      take: 30,
    });

    return {
      competitors: competitors.map((competitor) => ({
        ...competitor,
        reasons: [
          competitor.rating && gmb.cachedAverageRating && competitor.rating > gmb.cachedAverageRating
            ? "Higher rating"
            : null,
          competitor.reviewCount && gmb.totalReviewCount && competitor.reviewCount > gmb.totalReviewCount
            ? "More reviews"
            : null,
          competitor.categoriesJson ? "Category overlap or gap available" : null,
          competitor.domain ? "Website relevance can be compared" : null,
        ].filter(Boolean),
      })),
    };
  }

  async getAttribution(businessId: string) {
    const gmb = await this.getConnectedGmb(businessId);
    const destination =
      gmb.businessWebsite ?? gmb.business.businessWebsiteUrl ?? "https://upliftai.co/";
    const surfaces = [
      { surface: "profile_website", content: "profile" },
      { surface: "post_cta", content: "post" },
      { surface: "review_campaign", content: "review_request" },
    ];

    for (const surface of surfaces) {
      const existing = await prisma.gMBAttributionLink.findFirst({
        where: {
          businessId,
          surface: surface.surface,
        },
        select: { id: true },
      });

      if (existing) {
        continue;
      }

      await prisma.gMBAttributionLink.create({
        data: {
          businessId,
          gmbId: gmb.id,
          surface: surface.surface,
          destinationUrl: destination,
          taggedUrl: buildGmbUtmUrl(destination, {
            campaign: "gbp",
            content: surface.content,
          }),
          campaign: "gbp",
          content: surface.content,
        },
      });
    }

    const [links, metrics] = await Promise.all([
      prisma.gMBAttributionLink.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
      }),
      this.getMetricsTimeSeries(businessId, { days: 30 }),
    ]);

    return {
      links,
      summary: metrics.metrics.reduce(
        (acc, row) => {
          acc.impressions += row.impressionsMaps + row.impressionsSearch;
          acc.websiteClicks += row.websiteClicks;
          acc.callClicks += row.callClicks;
          acc.directionRequests += row.directionRequests;
          return acc;
        },
        {
          impressions: 0,
          websiteClicks: 0,
          callClicks: 0,
          directionRequests: 0,
          websiteSessions: null as number | null,
          conversions: null as number | null,
        },
      ),
    };
  }

  async getGoogleUpdates(businessId: string) {
    const snapshot = await prisma.gMBProfileSnapshot.findFirst({
      where: { businessId },
      orderBy: { syncedAt: "desc" },
    });

    return {
      updates: snapshot?.googleUpdatesJson ?? [],
      syncedAt: snapshot?.syncedAt?.toISOString() ?? null,
    };
  }

  async getAlerts(businessId: string) {
    const alerts = await prisma.gMBAlert.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return { alerts };
  }

  async getReviewCampaigns(businessId: string) {
    const gmb = await this.getConnectedGmb(businessId);
    const reviewLink = gmb.placeId
      ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(gmb.placeId)}`
      : `https://www.google.com/search?q=${encodeURIComponent(
          `${gmb.businessName ?? gmb.business.businessName} reviews`,
        )}`;

    const existing = await prisma.gMBReviewCampaign.findFirst({
      where: { businessId },
      orderBy: { createdAt: "desc" },
    });

    if (!existing) {
      await prisma.gMBReviewCampaign.create({
        data: {
          businessId,
          gmbId: gmb.id,
          name: "Default review request campaign",
          reviewLink,
          emailSubject: `How was your experience with ${gmb.businessName ?? gmb.business.businessName}?`,
          emailBody:
            "Thank you for choosing us. If you have a moment, please share an honest review on Google. Your feedback helps other local customers make informed decisions.",
          status: "DRAFT",
        },
      });
    }

    const campaigns = await prisma.gMBReviewCampaign.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
    });

    return { campaigns };
  }

  async getPortfolio(userId: string) {
    const businesses = await prisma.business.findMany({
      where: {
        userId,
        isActive: true,
        GoogleMyBusiness: {
          isActive: true,
        },
      },
      select: {
        id: true,
        businessName: true,
        businessWebsiteUrl: true,
        GoogleMyBusiness: {
          select: {
            businessName: true,
            businessAddress: true,
            lastSyncAt: true,
            profileHealthRuns: {
              orderBy: { generatedAt: "desc" },
              take: 1,
            },
            actionRecommendations: {
              where: { status: "PENDING" },
              select: { id: true },
            },
            localRankScans: {
              orderBy: { requestedAt: "desc" },
              take: 5,
              include: {
                results: {
                  where: { isClient: true },
                  select: { position: true },
                },
              },
            },
            gmbReviews: {
              select: {
                isResponded: true,
                rating: true,
                reviewDate: true,
              },
            },
          },
        },
      },
    });

    return {
      locations: businesses.map((business) => {
        const gmb = business.GoogleMyBusiness;
        const latestHealth = gmb?.profileHealthRuns[0] ?? null;
        const clientRanks =
          gmb?.localRankScans.flatMap((scan) =>
            scan.results
              .map((result) => result.position)
              .filter((position): position is number => typeof position === "number"),
          ) ?? [];
        const unanswered = gmb?.gmbReviews.filter((review) => !review.isResponded).length ?? 0;

        return {
          businessId: business.id,
          businessName: gmb?.businessName ?? business.businessName,
          businessWebsiteUrl: business.businessWebsiteUrl,
          businessAddress: gmb?.businessAddress ?? null,
          healthScore: latestHealth?.score ?? null,
          actionBacklog: gmb?.actionRecommendations.length ?? 0,
          bestRank: clientRanks.length > 0 ? Math.min(...clientRanks) : null,
          unansweredReviews: unanswered,
          lastSyncAt: gmb?.lastSyncAt?.toISOString() ?? null,
        };
      }),
    };
  }
}

export const gmbLocalVisibilityService = new GMBLocalVisibilityService();
