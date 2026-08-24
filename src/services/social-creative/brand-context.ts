import type { PrismaClient } from "@prisma/client";
import { isIP } from "node:net";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  retrieveContextDevBrand,
  type ContextDevBrandProfile,
} from "../context-dev-brand.service";
import {
  canonicalizeRemoteDailySocialBrandLogo,
} from "../onboarding-v2-brand-logo.service";
import { getGmbReviewWindowStart } from "../../utils/gmb-review-window.utils";
import { assertPublicHttpUrl } from "./safe-fetch";
import type {
  SocialCreativeBrandContext,
  SocialCreativePositiveReview,
} from "./types";

type PersistedBrandAnalysis = {
  id: string;
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  logoAltText: string | null;
  faviconUrl: string | null;
  referenceImageUrl: string | null;
  analysisVersion: string;
  lastAnalyzed: Date;
  updatedAt: Date;
};

type VisualBrandIdentity = Omit<
  PersistedBrandAnalysis,
  "id" | "analysisVersion" | "lastAnalyzed" | "updatedAt"
> & {
  slogan: string | null;
};

export type SocialCreativeBrandContextDependencies = {
  canonicalizeDailyLogo?: typeof canonicalizeRemoteDailySocialBrandLogo;
  retrieveBrand?: typeof retrieveContextDevBrand;
  validateWebsiteUrl?: typeof assertPublicHttpUrl;
  now?: () => Date;
};

type GoogleReviewContext = {
  isActive?: boolean | null;
  isDemo?: boolean | null;
  accountId?: string | null;
  locationId?: string | null;
  lastSyncAt?: Date | null;
  gmbReviews?: Array<{
    rating: number;
    comment: string | null;
    reviewDate: Date;
  }>;
};

function reviewExcerpt(value: unknown, maximumLength = 180): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 12) return null;
  // Exclude contact details and links rather than reproducing customer PII in
  // a generated marketing image.
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(normalized) ||
    /\bhttps?:\/\//i.test(normalized) ||
    /(?:\+?\d[\d\s().-]{7,}\d)/.test(normalized)
  ) {
    return null;
  }
  if (normalized.length <= maximumLength) return normalized;
  const candidate = normalized.slice(0, maximumLength - 1);
  const boundary = candidate.lastIndexOf(" ");
  const excerpt = candidate.slice(0, boundary >= 80 ? boundary : candidate.length).trim();
  return `${excerpt}…`;
}

export function selectRecentPositiveGoogleReviews(
  gmb: GoogleReviewContext | null | undefined,
  now = new Date(),
): SocialCreativePositiveReview[] {
  const connectionReady = [
    gmb?.isActive === true,
    gmb?.isDemo === false,
    Boolean(gmb?.accountId?.trim()),
    Boolean(gmb?.locationId?.trim()),
    Boolean(gmb?.lastSyncAt),
  ].every(Boolean);
  if (!connectionReady) return [];

  const cutoff = getGmbReviewWindowStart(now);
  const seen = new Set<string>();
  const reviews: SocialCreativePositiveReview[] = [];
  const candidates = [...(gmb?.gmbReviews ?? [])].sort(
    (left, right) => right.reviewDate.getTime() - left.reviewDate.getTime(),
  );
  for (const review of candidates) {
    const reviewedAt = review.reviewDate.getTime();
    if (
      ![4, 5].includes(review.rating) ||
      !Number.isFinite(reviewedAt) ||
      review.reviewDate < cutoff ||
      reviewedAt > now.getTime() + 86_400_000
    ) {
      continue;
    }
    const excerpt = reviewExcerpt(review.comment);
    const dedupeKey = excerpt?.toLocaleLowerCase("en-US");
    if (!excerpt || !dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    reviews.push({
      excerpt,
      rating: review.rating as 4 | 5,
      reviewedAt: review.reviewDate.toISOString(),
      source: "google-business-profile",
    });
    if (reviews.length === 3) break;
  }
  return reviews;
}

const persistedBrandAnalysisSelect = {
  id: true,
  primaryColors: true,
  secondaryColors: true,
  fontFamily: true,
  logoUrl: true,
  logoAltText: true,
  faviconUrl: true,
  referenceImageUrl: true,
  analysisVersion: true,
  lastAnalyzed: true,
  updatedAt: true,
} as const;

function boundedString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function normalizedHexColors(...values: unknown[]): string[] {
  const colors: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const candidates = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value as Record<string, unknown>)
        : [value];
    for (const candidate of candidates) {
      const raw =
        typeof candidate === "string"
          ? candidate
          : candidate && typeof candidate === "object"
            ? (candidate as { hex?: unknown; value?: unknown }).hex ??
              (candidate as { value?: unknown }).value
            : null;
      if (typeof raw !== "string") continue;
      const color = raw.trim().toLowerCase();
      if (
        !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(
          color,
        ) ||
        seen.has(color)
      ) {
        continue;
      }
      seen.add(color);
      colors.push(color);
      if (colors.length === 12) return colors;
    }
  }
  return colors;
}

function normalizedPublicAssetUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const record = recordValue(candidate);
      const raw = boundedString(
        typeof candidate === "string"
          ? candidate
          : record.url ?? record.src ?? record.imageUrl,
        2_048,
      );
      if (!raw) continue;
      try {
        const url = new URL(raw);
        const hostname = url.hostname.toLowerCase();
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          isIP(hostname) !== 0 ||
          hostname === "localhost" ||
          hostname.endsWith(".localhost") ||
          hostname.endsWith(".local") ||
          /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(hostname) ||
          /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
          hostname === "::1"
        ) {
          continue;
        }
        url.hash = "";
        return url.toString();
      } catch {
        // Ignore malformed stored asset URLs.
      }
    }
  }
  return null;
}

function requiresDailyLogoCanonicalization(
  value: string | null,
): value is string {
  if (!value) return false;
  try {
    return !/\.(?:jpe?g|png|webp)$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

async function repairDailyLogoReference(
  input: {
    analysis: PersistedBrandAnalysis | null;
    businessId: string;
    logoUrl: string;
    userId: string;
  },
  prisma: PrismaClient,
  dependencies: SocialCreativeBrandContextDependencies,
): Promise<string> {
  const canonicalize =
    dependencies.canonicalizeDailyLogo ??
    canonicalizeRemoteDailySocialBrandLogo;
  const upload = await canonicalize({
    businessId: input.businessId,
    logoUrl: input.logoUrl,
    userId: input.userId,
  });
  const canonicalUrl = normalizedPublicAssetUrl(upload.url);
  if (!canonicalUrl) {
    throw new Error("Canonical daily social logo URL is invalid");
  }

  return persistDailyLogoReplacement(
    {
      analysis: input.analysis,
      businessId: input.businessId,
      currentLogoUrl: input.logoUrl,
      replacementLogoUrl: canonicalUrl,
    },
    prisma,
  );
}

async function persistDailyLogoReplacement(
  input: {
    analysis: PersistedBrandAnalysis | null;
    businessId: string;
    currentLogoUrl: string;
    replacementLogoUrl: string;
  },
  prisma: PrismaClient,
): Promise<string> {
  const replacementLogoUrl = normalizedPublicAssetUrl(
    input.replacementLogoUrl,
  );
  if (!replacementLogoUrl) {
    throw new Error("Canonical daily social logo URL is invalid");
  }

  if (!input.analysis) return replacementLogoUrl;

  const updated = await prisma.brandAnalysis.updateMany({
    where: {
      id: input.analysis.id,
      logoUrl: input.currentLogoUrl,
    },
    data: { logoUrl: replacementLogoUrl },
  });
  if (updated.count === 1) return replacementLogoUrl;

  // A concurrent settings change owns the newer value. Never overwrite it
  // with the logo that was current when this generation started.
  const latest = await prisma.brandAnalysis.findUnique({
    where: { businessId: input.businessId },
    select: persistedBrandAnalysisSelect,
  });
  const latestLogoUrl = visualIdentityFromBrandAnalysis(latest).logoUrl;
  if (!latestLogoUrl) {
    throw new Error("Approved daily social logo changed during preparation");
  }
  return latestLogoUrl;
}

function canonicalLogoFromCompletedOnboarding(value: unknown): string | null {
  const root = recordValue(value);
  const brandLogo = recordValue(root.brandLogo);
  if (
    brandLogo.provider !== "bunny" ||
    brandLogo.canonicalMimeType !== "image/png"
  ) {
    return null;
  }
  const rootLogoUrl = normalizedPublicAssetUrl(root.logoUrl);
  const metadataLogoUrl = normalizedPublicAssetUrl(brandLogo.url);
  return rootLogoUrl && rootLogoUrl === metadataLogoUrl ? rootLogoUrl : null;
}

async function loadCompletedOnboardingCanonicalLogo(
  input: { businessId: string; userId: string },
  prisma: PrismaClient,
): Promise<string | null> {
  const completed = await prisma.quickScrapeBusiness.findFirst({
    where: {
      userId: input.userId,
      onboardingV2BusinessId: input.businessId,
      onboardingV2Status: "completed",
      onboardingV2CompletedAt: { not: null },
    },
    orderBy: { onboardingV2CompletedAt: "desc" },
    select: { brandContext: true },
  });
  return canonicalLogoFromCompletedOnboarding(completed?.brandContext);
}

function emptyVisualIdentity(): VisualBrandIdentity {
  return {
    primaryColors: [],
    secondaryColors: [],
    fontFamily: null,
    logoUrl: null,
    logoAltText: null,
    faviconUrl: null,
    referenceImageUrl: null,
    slogan: null,
  };
}

function sameColorSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedColors = new Set(expected);
  return actual.every((color) => expectedColors.has(color));
}

function isSyntheticBrandAnalysis(value: unknown): boolean {
  const analysis = recordValue(value);
  const failedVersion = boundedString(analysis.analysisVersion, 160)
    ?.toLowerCase()
    .endsWith("-error") === true;
  if (failedVersion) return true;

  const primaryColors = normalizedHexColors(analysis.primaryColors);
  const secondaryColors = normalizedHexColors(analysis.secondaryColors);
  const fontFamily = boundedString(analysis.fontFamily, 160)?.toLowerCase();
  const hasRealAsset = Boolean(
    normalizedPublicAssetUrl(
      analysis.logoUrl,
      analysis.faviconUrl,
      analysis.referenceImageUrl,
    ),
  );
  return (
    !hasRealAsset &&
    sameColorSet(primaryColors, ["#000000", "#ffffff", "#007bff"]) &&
    sameColorSet(secondaryColors, ["#6c757d", "#28a745", "#dc3545"]) &&
    fontFamily === "arial, sans-serif"
  );
}

function visualIdentityFromBrandAnalysis(
  value: unknown,
): VisualBrandIdentity {
  // Failed analysis rows contain a synthetic palette/font so downstream
  // consumers have structurally valid data. They are not approved branding
  // and must not suppress or override a real provider identity.
  if (isSyntheticBrandAnalysis(value)) return emptyVisualIdentity();
  const analysis = recordValue(value);
  return {
    primaryColors: normalizedHexColors(analysis.primaryColors),
    secondaryColors: normalizedHexColors(analysis.secondaryColors),
    fontFamily: boundedString(analysis.fontFamily, 160),
    logoUrl: normalizedPublicAssetUrl(analysis.logoUrl),
    logoAltText: boundedString(analysis.logoAltText, 300),
    faviconUrl: normalizedPublicAssetUrl(analysis.faviconUrl),
    referenceImageUrl: normalizedPublicAssetUrl(analysis.referenceImageUrl),
    slogan: null,
  };
}

function visualIdentityFromWebsiteAnalysis(value: unknown): VisualBrandIdentity {
  const websiteAnalysis = recordValue(value);
  const design = recordValue(websiteAnalysis.design);
  const identity = recordValue(websiteAnalysis.brandIdentity);
  const colors = Array.isArray(design.colors) ? design.colors : [];
  const fonts = Array.isArray(design.fonts) ? design.fonts : [];
  const logos = Array.isArray(identity.logos) ? identity.logos : [];
  const primaryColors = normalizedHexColors(
    colors.filter((color) =>
      String(recordValue(color).type ?? "")
        .toLowerCase()
        .includes("primary"),
    ),
  );
  const secondaryColors = normalizedHexColors(
    colors.filter(
      (color) =>
        !String(recordValue(color).type ?? "")
          .toLowerCase()
          .includes("primary"),
    ),
  );
  const preferredLogo =
    logos.find((logo) =>
      /primary|main|logo/i.test(String(recordValue(logo).type ?? "")),
    ) ?? logos[0];
  return {
    ...emptyVisualIdentity(),
    primaryColors,
    secondaryColors,
    fontFamily: boundedString(recordValue(fonts[0]).family, 160),
    logoUrl: normalizedPublicAssetUrl(preferredLogo),
    slogan: boundedString(identity.tagline, 300),
  };
}

function visualIdentityFromOnboardingSnapshot(
  value: unknown,
): VisualBrandIdentity {
  const root = recordValue(value);
  const snapshot = recordValue(root.snapshot ?? root.data ?? root.context);
  const brand = recordValue(
    root.brand ?? root.brandIdentity ?? snapshot.brand ?? snapshot.brandIdentity,
  );
  const palette = recordValue(root.palette ?? brand.palette);
  const typography = recordValue(
    root.typography ?? root.fonts ?? brand.typography ?? brand.fonts,
  );
  const directPrimary = normalizedHexColors(
    root.primaryColors,
    brand.primaryColors,
    palette.primary,
  );
  const directSecondary = normalizedHexColors(
    root.secondaryColors,
    brand.secondaryColors,
    palette.secondary,
    palette.accent,
  );
  const combinedColors = normalizedHexColors(
    root.colors,
    brand.colors,
    palette,
  );
  const logos = [
    ...(Array.isArray(root.logos) ? root.logos : []),
    ...(Array.isArray(brand.logos) ? brand.logos : []),
  ];
  const preferredLogo =
    logos.find(
      (logo) => String(recordValue(logo).type ?? "").toLowerCase() === "logo",
    ) ?? logos[0];
  return {
    primaryColors:
      directPrimary.length > 0 ? directPrimary : combinedColors.slice(0, 2),
    secondaryColors:
      directSecondary.length > 0
        ? directSecondary
        : combinedColors.slice(2),
    fontFamily: boundedString(
      root.fontFamily ??
        brand.fontFamily ??
        typography.fontFamily ??
        typography.primaryFont ??
        typography.headingFont,
      160,
    ),
    logoUrl: normalizedPublicAssetUrl(
      root.logoUrl,
      root.logo_url,
      brand.logoUrl,
      brand.logo_url,
      root.logo,
      brand.logo,
      preferredLogo,
    ),
    logoAltText: boundedString(
      root.logoAltText ?? brand.logoAltText ?? recordValue(preferredLogo).alt,
      300,
    ),
    faviconUrl: normalizedPublicAssetUrl(
      root.faviconUrl,
      brand.faviconUrl,
    ),
    referenceImageUrl: normalizedPublicAssetUrl(
      root.referenceImageUrl,
      root.referenceImage,
      brand.referenceImageUrl,
      brand.referenceImage,
      root.backdrop,
      root.backdrops,
      brand.backdrop,
      brand.backdrops,
    ),
    slogan: boundedString(root.slogan ?? brand.slogan, 300),
  };
}

function mergeVisualIdentities(
  ...sources: VisualBrandIdentity[]
): VisualBrandIdentity {
  const merged = emptyVisualIdentity();
  for (const source of sources) {
    if (merged.primaryColors.length === 0 && source.primaryColors.length > 0) {
      merged.primaryColors = source.primaryColors;
    }
    if (
      merged.secondaryColors.length === 0 &&
      source.secondaryColors.length > 0
    ) {
      merged.secondaryColors = source.secondaryColors;
    }
    merged.fontFamily ??= source.fontFamily;
    merged.logoUrl ??= source.logoUrl;
    merged.logoAltText ??= source.logoAltText;
    merged.faviconUrl ??= source.faviconUrl;
    merged.referenceImageUrl ??= source.referenceImageUrl;
    merged.slogan ??= source.slogan;
  }
  return merged;
}

export function hasUsableSocialVisualIdentity(
  identity: Pick<
    VisualBrandIdentity,
    "fontFamily" | "logoUrl" | "primaryColors" | "secondaryColors"
  >,
): boolean {
  return Boolean(
    identity.logoUrl ||
      identity.fontFamily ||
      identity.primaryColors.length > 0 ||
      identity.secondaryColors.length > 0,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function providerBrandFields(
  profile: ContextDevBrandProfile,
  existing?: PersistedBrandAnalysis | null,
) {
  const normalizedExisting = visualIdentityFromBrandAnalysis(existing);
  return {
    primaryColors:
      normalizedExisting.primaryColors.length
        ? normalizedExisting.primaryColors
        : profile.primaryColors,
    secondaryColors:
      normalizedExisting.secondaryColors.length
        ? normalizedExisting.secondaryColors
        : profile.secondaryColors,
    fontFamily: normalizedExisting.fontFamily,
    logoUrl: normalizedExisting.logoUrl ?? profile.logoUrl,
    logoAltText: normalizedExisting.logoAltText ?? profile.logoAltText,
    faviconUrl: normalizedExisting.faviconUrl ?? profile.faviconUrl,
    referenceImageUrl:
      normalizedExisting.referenceImageUrl ?? profile.referenceImageUrl,
    analysisVersion:
      existing && !isSyntheticBrandAnalysis(existing)
        ? existing.analysisVersion
        : "context-dev-brand-v1",
    lastAnalyzed: new Date(profile.retrievedAt),
  };
}

function sameBrandAnalysis(
  existing: PersistedBrandAnalysis,
  fields: ReturnType<typeof providerBrandFields>,
): boolean {
  return (
    JSON.stringify(existing.primaryColors) ===
      JSON.stringify(fields.primaryColors) &&
    JSON.stringify(existing.secondaryColors) ===
      JSON.stringify(fields.secondaryColors) &&
    existing.fontFamily === fields.fontFamily &&
    existing.logoUrl === fields.logoUrl &&
    existing.logoAltText === fields.logoAltText &&
    existing.faviconUrl === fields.faviconUrl &&
    existing.referenceImageUrl === fields.referenceImageUrl
  );
}

export async function persistContextDevBrandForSocial(
  businessId: string,
  profile: ContextDevBrandProfile,
  prisma: PrismaClient = defaultPrisma,
): Promise<PersistedBrandAnalysis> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await prisma.brandAnalysis.findUnique({
      where: { businessId },
      select: persistedBrandAnalysisSelect,
    });
    const fields = providerBrandFields(profile, existing);
    if (!existing) {
      try {
        return await prisma.brandAnalysis.create({
          data: { businessId, ...fields },
          select: persistedBrandAnalysisSelect,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) continue;
        throw error;
      }
    }
    if (sameBrandAnalysis(existing, fields)) return existing;

    const updated = await prisma.brandAnalysis.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: fields,
    });
    if (updated.count === 1) {
      const persisted = await prisma.brandAnalysis.findUnique({
        where: { businessId },
        select: persistedBrandAnalysisSelect,
      });
      if (persisted) return persisted;
    }
  }
  throw new Error("Brand identity changed while social context was loading");
}

const contextDevBrandFallbackSingleflight = new Map<
  string,
  Promise<PersistedBrandAnalysis | null>
>();

async function loadContextDevBrandFallback(
  input: {
    businessId: string;
    websiteUrl: string;
    storedSupplementaryIdentity: VisualBrandIdentity;
  },
  prisma: PrismaClient,
  dependencies: SocialCreativeBrandContextDependencies,
): Promise<PersistedBrandAnalysis | null> {
  const existingRequest = contextDevBrandFallbackSingleflight.get(
    input.businessId,
  );
  if (existingRequest) return existingRequest;

  const request = (async () => {
    // Re-read after entering single-flight. Another request may have persisted
    // a complete analysis between the initial business load and this fallback.
    const current = await prisma.brandAnalysis.findUnique({
      where: { businessId: input.businessId },
      select: persistedBrandAnalysisSelect,
    });
    const currentIdentity = mergeVisualIdentities(
      visualIdentityFromBrandAnalysis(current),
      input.storedSupplementaryIdentity,
    );
    if (hasUsableSocialVisualIdentity(currentIdentity)) return current;

    const validatedWebsite = await (
      dependencies.validateWebsiteUrl ?? assertPublicHttpUrl
    )(input.websiteUrl);
    const profile = await (
      dependencies.retrieveBrand ?? retrieveContextDevBrand
    )(validatedWebsite.toString());
    if (!profile) return current;
    return persistContextDevBrandForSocial(
      input.businessId,
      profile,
      prisma,
    );
  })();

  contextDevBrandFallbackSingleflight.set(input.businessId, request);
  try {
    return await request;
  } finally {
    if (contextDevBrandFallbackSingleflight.get(input.businessId) === request) {
      contextDevBrandFallbackSingleflight.delete(input.businessId);
    }
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && "name" in item
          ? String((item as { name?: unknown }).name ?? "").trim()
          : "",
    )
    .filter(Boolean);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function localeLanguage(locale: string | null | undefined): string {
  return locale?.split(/[-_]/)[0]?.toLowerCase() || "en";
}

export async function loadSocialCreativeBrandContext(
  input: {
    businessId: string;
    userId: string;
    onboardingPreview?: { quickBusinessId: string; revision: number };
  },
  prisma: PrismaClient = defaultPrisma,
  dependencies: SocialCreativeBrandContextDependencies = {},
): Promise<SocialCreativeBrandContext> {
  const contextNow = dependencies.now?.() ?? new Date();
  const reviewWindowStart = getGmbReviewWindowStart(contextNow);
  let allowInactiveOnboardingBusiness = false;
  let onboardingQuickContext: {
    businessDescription: string | null;
    targetAudience: string | null;
    selectedServices: string[];
    detectedServices: string[];
    brandContext: unknown;
  } | null = null;
  if (input.onboardingPreview) {
    const quickBusiness = await prisma.quickScrapeBusiness.findUnique({
      where: { id: input.onboardingPreview.quickBusinessId },
      select: {
        userId: true,
        onboardingV2BusinessId: true,
        onboardingV2GenerationRevision: true,
        onboardingV2Status: true,
        onboardingV2CompletedAt: true,
        businessDescription: true,
        targetAudience: true,
        selectedServices: true,
        detectedServices: true,
        brandContext: true,
      },
    });
    allowInactiveOnboardingBusiness = Boolean(
      quickBusiness?.userId === input.userId &&
        quickBusiness.onboardingV2BusinessId === input.businessId &&
        quickBusiness.onboardingV2GenerationRevision ===
          input.onboardingPreview.revision &&
        quickBusiness.onboardingV2CompletedAt === null &&
        !["complete", "completed"].includes(
          quickBusiness.onboardingV2Status.trim().toLowerCase(),
        ),
    );
    if (!allowInactiveOnboardingBusiness) {
      throw new Error(
        "Onboarding social brand context does not match an unfinished owned onboarding state",
      );
    }
    onboardingQuickContext = quickBusiness;
  }
  const business = await prisma.business.findFirst({
    where: {
      id: input.businessId,
      userId: input.userId,
      ...(allowInactiveOnboardingBusiness ? {} : { isActive: true }),
    },
    include: {
      BrandAnalysis: true,
      Photos: { orderBy: [{ order: "asc" }, { createdAt: "desc" }], take: 4 },
      websiteAnalysis: {
        include: {
          brandIdentity: { include: { logos: true } },
          design: { include: { colors: true, fonts: true } },
          coreServices: true,
          contactInfo: true,
          businessInfo: true,
        },
      },
      GoogleMyBusiness: {
        select: {
          isActive: true,
          isDemo: true,
          accountId: true,
          locationId: true,
          lastSyncAt: true,
          verified: true,
          totalReviewCount: true,
          cachedAverageRating: true,
          gmbReviews: {
            where: {
              rating: { gte: 4 },
              comment: { not: null },
              reviewDate: { gte: reviewWindowStart },
            },
            orderBy: [{ reviewDate: "desc" }, { id: "asc" }],
            take: 10,
            select: {
              rating: true,
              comment: true,
              reviewDate: true,
            },
          },
        },
      },
      socialPromotionCampaign: {
        select: {
          enabled: true,
          title: true,
          information: true,
          preferredContent: true,
          startsOn: true,
          endsOn: true,
          imageUrl: true,
          documentName: true,
          documentText: true,
        },
      },
      socialCreativeReferences: {
        orderBy: [{ scope: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 6,
        select: { id: true, url: true, scope: true },
      },
    },
  });
  if (!business) throw new Error("Business not found or ownership mismatch");

  const websiteVisualIdentity = visualIdentityFromWebsiteAnalysis(
    business.websiteAnalysis,
  );
  const onboardingVisualIdentity = visualIdentityFromOnboardingSnapshot(
    onboardingQuickContext?.brandContext,
  );
  const storedSupplementaryIdentity = mergeVisualIdentities(
    websiteVisualIdentity,
    onboardingVisualIdentity,
  );
  let analysis = business.BrandAnalysis as PersistedBrandAnalysis | null;
  let visualIdentity = mergeVisualIdentities(
    visualIdentityFromBrandAnalysis(analysis),
    storedSupplementaryIdentity,
  );
  if (!hasUsableSocialVisualIdentity(visualIdentity)) {
    analysis = await loadContextDevBrandFallback(
      {
        businessId: business.id,
        websiteUrl: business.businessWebsiteUrl,
        storedSupplementaryIdentity,
      },
      prisma,
      dependencies,
    );
    visualIdentity = mergeVisualIdentities(
      visualIdentityFromBrandAnalysis(analysis),
      storedSupplementaryIdentity,
    );
  }
  if (
    !input.onboardingPreview &&
    requiresDailyLogoCanonicalization(visualIdentity.logoUrl)
  ) {
    const completedOnboardingLogoUrl =
      await loadCompletedOnboardingCanonicalLogo(
        { businessId: business.id, userId: input.userId },
        prisma,
      );
    const canonicalLogoUrl = completedOnboardingLogoUrl
      ? await persistDailyLogoReplacement(
          {
            analysis,
            businessId: business.id,
            currentLogoUrl: visualIdentity.logoUrl,
            replacementLogoUrl: completedOnboardingLogoUrl,
          },
          prisma,
        )
      : await repairDailyLogoReference(
          {
            analysis,
            businessId: business.id,
            logoUrl: visualIdentity.logoUrl,
            userId: input.userId,
          },
          prisma,
          dependencies,
        );
    visualIdentity = { ...visualIdentity, logoUrl: canonicalLogoUrl };
  }
  if (!hasUsableSocialVisualIdentity(visualIdentity)) {
    throw new Error("Approved business brand identity is required");
  }

  const recentPosts = await prisma.socialCreativePost.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { headline: true, archetype: true, layoutFamily: true },
  });
  const identity = business.websiteAnalysis?.brandIdentity;
  const coreServices = business.websiteAnalysis?.coreServices;
  const contactInfo = business.websiteAnalysis?.contactInfo;
  const businessInfo = business.websiteAnalysis?.businessInfo;
  const locale = business.defaultLocale?.trim() || "en-US";
  const persistedOnboardingBrand = recordValue(
    onboardingQuickContext?.brandContext,
  );
  const nestedOnboardingBrand = recordValue(
    persistedOnboardingBrand.brand ?? persistedOnboardingBrand.brandIdentity,
  );
  const onboardingBrandVoice =
    stringValue(
      persistedOnboardingBrand.brandVoice,
      persistedOnboardingBrand.toneOfVoice,
      nestedOnboardingBrand.brandVoice,
      nestedOnboardingBrand.toneOfVoice,
    ) ||
    unique([
      ...stringArray(persistedOnboardingBrand.brandVoice),
      ...stringArray(persistedOnboardingBrand.toneOfVoice),
      ...stringArray(nestedOnboardingBrand.brandVoice),
      ...stringArray(nestedOnboardingBrand.toneOfVoice),
    ])
      .join(", ")
      .slice(0, 300) ||
    null;
  const onboardingKeyMessages = unique([
    ...stringArray(persistedOnboardingBrand.keyMessages),
    ...stringArray(nestedOnboardingBrand.keyMessages),
  ]).slice(0, 12);
  const onboardingSocialContentAngles = unique([
    ...stringArray(persistedOnboardingBrand.socialContentAngles),
    ...stringArray(nestedOnboardingBrand.socialContentAngles),
  ]).slice(0, 12);
  const detectedServices = stringArray(business.detectedServices);
  const selectedServices = stringArray(business.selectedServices);
  const referenceImages = unique([
    visualIdentity.referenceImageUrl,
    ...business.Photos.map((photo) => photo.url),
  ])
    .slice(0, 4)
    .map((url, index) => {
      const photo = business.Photos.find((candidate) => candidate.url === url);
      return {
        id: photo?.id ?? `brand-analysis-${index + 1}`,
        url,
        role: "subject" as const,
        description: photo
          ? [
              photo.category?.toLowerCase().replaceAll("_", " ") || "business photo",
              photo.altText,
            ]
              .filter(Boolean)
              .join(": ")
          : "approved brand-analysis subject reference",
        provenance: photo ? ("business-photo" as const) : ("brand-analysis" as const),
      };
    });
  const verifiedActions = unique([
    business.businessWebsiteUrl,
    business.businessPhone,
    contactInfo?.bookingUrl,
    contactInfo?.contactUrl,
  ]).map((value) => ({
    type: value === business.businessPhone
      ? ("phone" as const)
      : value === contactInfo?.bookingUrl
        ? ("booking" as const)
        : value === contactInfo?.contactUrl
          ? ("contact" as const)
          : ("website" as const),
    label: value === business.businessPhone
      ? "Call"
      : value === contactInfo?.bookingUrl
        ? "Book"
        : value === contactInfo?.contactUrl
          ? "Contact"
          : "Visit website",
    value,
  }));
  const gmb = business.GoogleMyBusiness;
  const verifiedProof = gmb?.verified && gmb.cachedAverageRating && gmb.totalReviewCount
    ? {
        averageRating: gmb.cachedAverageRating,
        reviewCount: gmb.totalReviewCount,
      }
    : null;
  const recentPositiveReviews = selectRecentPositiveGoogleReviews(
    gmb,
    contextNow,
  );
  return {
    userId: input.userId,
    businessId: business.id,
    businessName: business.businessName,
    businessType: business.businessType,
    businessDescription:
      business.businessDescription ||
      onboardingQuickContext?.businessDescription ||
      "",
    websiteUrl: business.businessWebsiteUrl,
    phone: business.businessPhone,
    city: business.businessCity,
    state: business.businessState,
    country: business.businessCountry,
    language: business.defaultLanguage?.trim() || localeLanguage(locale),
    locale,
    tone:
      business.contentTone?.trim() || onboardingBrandVoice || "professional",
    targetAudience:
      business.targetAudience ||
      onboardingQuickContext?.targetAudience ||
      businessInfo?.targetAudience ||
      null,
    services: unique([
      ...(onboardingQuickContext?.selectedServices ?? []),
      ...(onboardingQuickContext?.detectedServices ?? []),
      ...selectedServices,
      ...detectedServices,
      ...(coreServices?.topLevel ?? []),
      ...(coreServices?.subOfferings ?? []),
    ]).slice(0, 20),
    // Do not invent a fallback palette for provider-direct generation. The
    // Studio websiteCampaign contract requires a stored brand identity.
    primaryColors: visualIdentity.primaryColors,
    secondaryColors: visualIdentity.secondaryColors,
    fontFamily: visualIdentity.fontFamily,
    logoUrl: visualIdentity.logoUrl,
    referenceImageUrls: referenceImages.map((reference) => reference.url),
    recentCreativeHistory: recentPosts,
    tagline: visualIdentity.slogan ?? identity?.tagline ?? null,
    serviceAreas: unique([
      business.businessCity,
      ...(business.serviceAreaLocations ?? []),
    ]).slice(0, 20),
    differentiators: unique([
      ...(businessInfo?.valuePropositions ?? []),
      ...(businessInfo?.uniqueSellingPoints ?? []),
    ]).slice(0, 12),
    customerPainPoints: unique(businessInfo?.customerPainPoints ?? []).slice(0, 12),
    verifiedActions,
    verifiedProof,
    recentPositiveReviews,
    promotion: business.socialPromotionCampaign,
    creativeReferenceImages: business.socialCreativeReferences,
    referenceImages,
    brandVoice: onboardingBrandVoice,
    keyMessages: onboardingKeyMessages,
    socialContentAngles: onboardingSocialContentAngles,
  };
}
