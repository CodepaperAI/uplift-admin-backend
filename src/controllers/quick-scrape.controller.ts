import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError, type z } from "zod";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { logOnboardingAlert, logOnboardingStage } from "../utils/onboarding-logger";
import {
  normalizeOnboardingServiceList,
  quickScrapeServices,
} from "../utils/quick-scrape.utils";
import { searchPlaceCandidates } from "../services/business-geo-profile.service";
import {
  isBlockedAdultWebsiteUrl,
  UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE,
} from "../utils/adult-domain-blocklist.utils";
import {
  BEGIN_SECONDARY_ONBOARDING_V2,
  COMPLETE_SECONDARY_ONBOARDING_V2,
  GET_ONBOARDING_V2_PREVIEW,
  GET_ONBOARDING_V2_STATE,
  mergeOnboardingV2Author,
  mergeOnboardingV2Answers,
  PATCH_ONBOARDING_V2_STATE,
  QUICK_BUSINESS_DETAILS,
  QUICK_SCRAPE,
  SAVE_BUSINESS_DETAILS,
  SAVE_SERVICES,
  SEARCH_QUICK_PLACES,
  START_ONBOARDING_V2_GENERATION,
  UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE,
  UPLOAD_ONBOARDING_V2_BRAND_LOGO,
} from "../validators/quick-scrape.validation";
import { TrialAnalyticsService } from "../services/trial-analytics.service";
import {
  OnboardingV2AuthorImageValidationError,
  safeOnboardingV2AuthorImageName,
  uploadOnboardingV2AuthorImage,
} from "../services/onboarding-v2-author-image.service";
import {
  canonicalizeRemoteOnboardingV2BrandLogo,
  OnboardingV2BrandLogoValidationError,
  serializeOnboardingV2BrandLogo,
  uploadOnboardingV2BrandLogo,
} from "../services/onboarding-v2-brand-logo.service";
import { serializeSocialCreativeRun } from "./social-creative.controller";
import { resolveOnboardingV2PersistedStep } from "../utils/onboarding-v2-state.utils";
import { resolveOnboardingWebsiteIdentityUrl } from "../utils/onboarding-scrape.utils";

type QuickBusinessDetails = z.infer<typeof QUICK_BUSINESS_DETAILS>;
const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanE164Phone(value: unknown): string | null {
  const phone = cleanOptionalString(value);
  return phone && E164_PHONE_PATTERN.test(phone) ? phone : null;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function buildBusinessDetailsData(
  details: QuickBusinessDetails,
  options: { markConfirmed?: boolean } = {},
) {
  const businessName = cleanOptionalString(details.businessName);
  const businessType = cleanOptionalString(details.businessType);
  return {
    ...(businessName ? { businessName } : {}),
    ...(businessType ? { businessType } : {}),
    businessAddress: cleanOptionalString(details.businessAddress),
    businessCity: cleanOptionalString(details.businessCity),
    businessState: cleanOptionalString(details.businessState),
    businessCountry: cleanOptionalString(details.businessCountry),
    businessPhone: cleanOptionalString(details.businessPhone),
    serviceArea: cleanOptionalString(details.serviceArea),
    serviceAreaLocations: cleanStringList(details.serviceAreaLocations),
    businessLocationMode: cleanOptionalString(details.businessLocationMode),
    confirmedPlaceId: cleanOptionalString(details.confirmedPlaceId),
    ...(options.markConfirmed
      ? { contactDetailsConfirmedAt: new Date() }
      : {}),
  };
}

function serializeQuickBusinessDetails(quickBusiness: {
  businessName?: string | null;
  businessType?: string | null;
  businessAddress?: string | null;
  businessCity?: string | null;
  businessState?: string | null;
  businessCountry?: string | null;
  businessPhone?: string | null;
  serviceArea?: string | null;
  serviceAreaLocations?: string[] | null;
  businessLocationMode?: string | null;
  confirmedPlaceId?: string | null;
}, fallbackBusinessPhone?: string | null) {
  const businessPhone =
    fallbackBusinessPhone !== undefined
      ? cleanE164Phone(fallbackBusinessPhone) ?? ""
      : cleanOptionalString(quickBusiness.businessPhone) ?? "";

  return {
    businessName: quickBusiness.businessName ?? "",
    businessType: quickBusiness.businessType ?? "",
    businessAddress: quickBusiness.businessAddress ?? "",
    businessCity: quickBusiness.businessCity ?? "",
    businessState: quickBusiness.businessState ?? "",
    businessCountry: quickBusiness.businessCountry ?? "",
    businessPhone,
    serviceArea: quickBusiness.serviceArea ?? "",
    serviceAreaLocations: Array.isArray(quickBusiness.serviceAreaLocations)
      ? quickBusiness.serviceAreaLocations
      : [],
    businessLocationMode: quickBusiness.businessLocationMode ?? "unknown",
    confirmedPlaceId: quickBusiness.confirmedPlaceId ?? "",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function serializeOnboardingV2State(
  quickBusiness: any,
  options: {
    signupPhone?: string | null;
    paymentStatus?: string | null;
  } = {},
) {
  const flow = quickBusiness.onboardingV2Flow ?? "trial_primary";
  const paymentStatus = options.paymentStatus ?? null;
  const detectedServices = normalizeOnboardingServiceList(
    quickBusiness.detectedServices,
    10,
  );
  const selectedServices = normalizeOnboardingServiceList(
    quickBusiness.selectedServices,
    25,
  );
  return {
    businessId: quickBusiness.id,
    flow,
    websiteUrl: quickBusiness.businessWebsiteUrl,
    businessName: quickBusiness.businessName,
    businessType: quickBusiness.businessType,
    businessDescription: quickBusiness.businessDescription ?? "",
    targetAudience: quickBusiness.targetAudience ?? "",
    brandContext: quickBusiness.brandContext ?? null,
    detectedServices,
    selectedServices,
    servicesPriority: quickBusiness.servicesPriority ?? {},
    businessDetails: serializeQuickBusinessDetails(
      quickBusiness,
      options.signupPhone,
    ),
    step: quickBusiness.onboardingV2Step,
    questionIndex: quickBusiness.onboardingV2QuestionIndex,
    answers: asRecord(quickBusiness.onboardingV2Answers),
    answerRevision: quickBusiness.onboardingV2AnswerRevision,
    status: quickBusiness.onboardingV2Status,
    lastSeenAt: quickBusiness.onboardingV2LastSeenAt,
    generationStartedAt: quickBusiness.onboardingV2GenerationStartedAt,
    generationRevision: quickBusiness.onboardingV2GenerationRevision,
    provisionalBusinessId: quickBusiness.onboardingV2BusinessId,
    blogId: quickBusiness.onboardingV2BlogId,
    socialRunId: quickBusiness.onboardingV2SocialRunId,
    blogStatus: quickBusiness.onboardingV2BlogStatus,
    socialStatus: quickBusiness.onboardingV2SocialStatus,
    generationError: quickBusiness.onboardingV2GenerationError ?? null,
    author: quickBusiness.onboardingV2Author ?? null,
    completedAt: quickBusiness.onboardingV2CompletedAt,
    ...(flow === "website_secondary"
      ? {
          paymentStatus,
          paymentRequired: !["active", "trialing"].includes(
            paymentStatus ?? "",
          ),
        }
      : {}),
    createdAt: quickBusiness.createdAt,
    updatedAt: quickBusiness.updatedAt,
  };
}

function onboardingV2GenerationEnabled(): boolean {
  return process.env.ONBOARDING_V2_PREVIEW_GENERATION_ENABLED === "true";
}

function firstAnswer(answers: Record<string, unknown>, key: string): string | null {
  const value = answers[key];
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  return value[0];
}

function answerList(answers: Record<string, unknown>, key: string): string[] {
  const value = answers[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mapAudienceAnswer(value: string | null): string | null {
  return (
    {
      local: "Local customers",
      business: "Business clients",
      both: "Local customers and business clients",
      online: "Online audience",
    } as Record<string, string>
  )[value ?? ""] ?? null;
}

function mapPublishingFrequency(value: string | null): string | null {
  return (
    { p3: "3_per_week", p5: "5_per_week", p7: "daily", p10: "10_per_week" } as Record<
      string,
      string
    >
  )[value ?? ""] ?? null;
}

function mapServiceArea(value: string | null, fallback: string | null): string | null {
  return (
    { nearby: "local", regional: "regional", national: "national" } as Record<
      string,
      string
    >
  )[value ?? ""] ?? fallback;
}

export async function quickScrape(req: AuthenticatedRequest, res: Response) {
  try {
    const body = req.body;
    const payload = QUICK_SCRAPE.parse(body);
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    const normalizedUrl = normalizeWebsiteUrl(payload.websiteUrl);
    if (isBlockedAdultWebsiteUrl(normalizedUrl)) {
      return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
        code: "UNSUPPORTED_WEBSITE_CATEGORY",
      });
    }

    // Context.dev is primary; ScraperAPI and Puppeteer recover provider misses.
    const result = await quickScrapeServices(normalizedUrl);

    if (!result.success) {
      console.error("[Quick Scrape] Scrape failed:", result.error);
      return sendError(
        res,
        result.error || "Failed to scrape website",
        400
      );
    }

    console.log("[Quick Scrape] Scrape successful", {
      source: result.extractionSource,
      confidence: result.extractionConfidence,
      serviceCount: result.detectedServices.length,
      hasBrandContext: Boolean(result.brandContext),
      hasContactDetails: Boolean(
        result.businessPhone ||
          result.businessAddress ||
          result.businessCity ||
          result.businessCountry,
      ),
    });

    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);

    let quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: {
        userId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
      },
    });

    if (!quickBusiness) {
      quickBusiness = await prisma.quickScrapeBusiness.create({
        data: {
          userId,
          businessName: result.businessName || "My Business",
          businessType: result.businessType || "General",
          businessWebsiteUrl: normalizedUrl,
          detectedServices: result.detectedServices || [],
          selectedServices: [],
          businessAddress: result.businessAddress || null,
          businessCity: result.businessCity || null,
          businessState: result.businessState || null,
          businessCountry: result.businessCountry || null,
          businessPhone: result.businessPhone || null,
          serviceArea: result.serviceArea || null,
          serviceAreaLocations: result.serviceAreaLocations || [],
          businessLocationMode: result.businessLocationMode || "unknown",
          businessDescription: result.businessDescription || null,
          targetAudience: result.targetAudience || null,
          brandContext: result.brandContext
            ? (result.brandContext as Prisma.InputJsonValue)
            : undefined,
        },
      });

      console.log("[Quick Scrape] Created new quick scrape business:", quickBusiness.id);
    } else {
      // Update existing quick scrape business
      quickBusiness = await prisma.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data: {
          businessName: result.businessName || quickBusiness.businessName,
          businessType: result.businessType || quickBusiness.businessType,
          detectedServices: result.detectedServices || [],
          businessAddress: result.businessAddress || quickBusiness.businessAddress,
          businessCity: result.businessCity || quickBusiness.businessCity,
          businessState: result.businessState || quickBusiness.businessState,
          businessCountry: result.businessCountry || quickBusiness.businessCountry,
          businessPhone: result.businessPhone || quickBusiness.businessPhone,
          serviceArea: result.serviceArea || quickBusiness.serviceArea,
          serviceAreaLocations:
            result.serviceAreaLocations && result.serviceAreaLocations.length > 0
              ? result.serviceAreaLocations
              : quickBusiness.serviceAreaLocations,
          businessLocationMode:
            result.businessLocationMode || quickBusiness.businessLocationMode,
          businessDescription:
            result.businessDescription || quickBusiness.businessDescription,
          targetAudience: result.targetAudience || quickBusiness.targetAudience,
          brandContext: result.brandContext
            ? (result.brandContext as Prisma.InputJsonValue)
            : undefined,
        },
      });

      console.log("[Quick Scrape] Updated existing quick scrape business:", quickBusiness.id);
    }

    setImmediate(() => {
      TrialAnalyticsService.trackQuickScrapeCompleted(userId);
    });

    logOnboardingStage(req, {
      stage: "quick_scrape_saved",
      userId,
      quickScrapeBusinessId: quickBusiness.id,
      websiteUrl: normalizedUrl,
    });

    return sendSuccess(
      res,
      {
        businessId: quickBusiness.id,
        businessName: result.businessName,
        businessType: result.businessType,
        businessDescription: result.businessDescription || "",
        targetAudience: result.targetAudience || "",
        detectedServices: result.detectedServices,
        brandContext: result.brandContext || null,
        context: result.brandContext || null,
        businessDetails: {
          ...serializeQuickBusinessDetails(quickBusiness, user.phone),
          extractionSource: result.extractionSource,
          extractionConfidence: result.extractionConfidence,
        },
      },
      "Quick scrape completed successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      console.error("[Quick Scrape] Validation error:", JSON.stringify(error.issues, null, 2));
      return handleValidationError(res, error);
    }

    console.error("[Quick Scrape] Unexpected error:", error);
    console.error("[Quick Scrape] Error stack:", error instanceof Error ? error.stack : "No stack trace");
    return sendError(res, "Failed to perform quick scrape", 500, error);
  }
}

export async function saveBusinessDetails(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = SAVE_BUSINESS_DETAILS.parse(req.body);
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: {
        id: payload.businessId,
        userId,
      },
    });

    if (!quickBusiness) {
      logOnboardingAlert("ownership_rejected", {
        userId,
        businessId: payload.businessId,
        correlationId: "correlationId" in req ? (req as { correlationId?: string }).correlationId : undefined,
        message: "Quick scrape business not found or does not belong to you",
      });
      return sendError(res, "Quick scrape business not found or does not belong to you", 403);
    }

    const updatedBusiness = await prisma.quickScrapeBusiness.update({
      where: { id: quickBusiness.id },
      data: buildBusinessDetailsData(payload.businessDetails, {
        markConfirmed: true,
      }),
    });

    logOnboardingStage(req, {
      stage: "business_details_confirmed",
      userId,
      quickScrapeBusinessId: updatedBusiness.id,
    });

    return sendSuccess(
      res,
      {
        businessId: updatedBusiness.id,
        businessDetails: serializeQuickBusinessDetails(updatedBusiness),
      },
      "Business details saved successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("[Save Business Details] Error:", error);
    return sendError(res, "Failed to save business details", 500, error);
  }
}

export async function searchQuickPlaces(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = SEARCH_QUICK_PLACES.parse(req.body);
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: {
        id: payload.businessId,
        userId,
      },
      select: {
        id: true,
        businessCity: true,
        businessCountry: true,
      },
    });

    if (!quickBusiness) {
      return sendError(res, "Quick scrape business not found or does not belong to you", 403);
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return sendSuccess(res, {
        candidates: [],
        unavailable: true,
        message: "Google Places search is not configured yet.",
      });
    }

    try {
      const candidates = await searchPlaceCandidates(payload.query, {
        country: quickBusiness.businessCountry ?? undefined,
        city: quickBusiness.businessCity ?? undefined,
      });

      return sendSuccess(res, {
        candidates: candidates.map((candidate) => ({
          placeId: candidate.id,
          name: candidate.displayName,
          formattedAddress: candidate.formattedAddress,
          location: candidate.location,
          types: candidate.types,
        })),
      });
    } catch (error) {
      console.error("[Quick Places Search] Google Places failed:", error);
      return sendSuccess(res, {
        candidates: [],
        unavailable: true,
        message: "Google Places search is temporarily unavailable.",
      });
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("[Quick Places Search] Error:", error);
    return sendError(res, "Failed to search business locations", 500, error);
  }
}

export async function saveSelectedServices(req: AuthenticatedRequest, res: Response) {
  try {
    const body = req.body;
    const payload = SAVE_SERVICES.parse(body);
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: {
        id: payload.businessId,
        userId,
      },
    });

    if (!quickBusiness) {
      logOnboardingAlert("ownership_rejected", {
        userId,
        businessId: payload.businessId,
        correlationId: "correlationId" in req ? (req as { correlationId?: string }).correlationId : undefined,
        message: "Quick scrape business not found or does not belong to you",
      });
      return sendError(res, "Quick scrape business not found or does not belong to you", 403);
    }

    console.log("[Save Services] Found quick scrape business:", quickBusiness.id);

    // Update quick scrape business with selected services
    const updatedBusiness = await prisma.quickScrapeBusiness.update({
      where: { id: quickBusiness.id },
      data: {
        selectedServices: payload.selectedServices,
        servicesPriority: payload.servicesPriority || {},
      },
    });

    console.log("[Save Services] Updated quick scrape business with services:", updatedBusiness.selectedServices);

    setImmediate(() => {
      TrialAnalyticsService.trackServicesSelected(userId);
    });

    logOnboardingStage(req, {
      stage: "services_saved",
      userId,
      quickScrapeBusinessId: updatedBusiness.id,
    });

    return sendSuccess(
      res,
      { business: updatedBusiness },
      "Services saved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("[Save Services] Error:", error);
    return sendError(res, "Failed to save services", 500, error);
  }
}

class SecondaryOnboardingV2ConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecondaryOnboardingV2ConflictError";
  }
}

export function resolveSecondaryOnboardingScanTransition(
  existing: { onboardingV2Step?: string | null } | null,
): { nextStep: string; resumed: boolean } {
  const existingStep = existing?.onboardingV2Step?.trim() || "website";
  const resumed = existingStep !== "website" && existingStep !== "welcome";
  return {
    nextStep: resumed ? existingStep : "services",
    resumed,
  };
}

export async function beginSecondaryOnboardingV2(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = BEGIN_SECONDARY_ONBOARDING_V2.parse(req.body);
    const normalizedUrl = normalizeWebsiteUrl(payload.websiteUrl);
    if (isBlockedAdultWebsiteUrl(normalizedUrl)) {
      return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
        code: "UNSUPPORTED_WEBSITE_CATEGORY",
      });
    }

    const canonicalWebsiteUrl =
      await resolveOnboardingWebsiteIdentityUrl(normalizedUrl);
    if (isBlockedAdultWebsiteUrl(canonicalWebsiteUrl)) {
      return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
        code: "UNSUPPORTED_WEBSITE_CATEGORY",
      });
    }

    const activePrimary = await prisma.business.findFirst({
      where: {
        userId,
        isPrimary: true,
        isActive: true,
        websiteStatus: { in: ["active", "trial"] },
        removalStatus: "active",
      },
      select: { id: true },
    });
    if (!activePrimary) {
      return sendError(
        res,
        "Finish your primary website setup before adding another website",
        409,
        { code: "PRIMARY_WEBSITE_REQUIRED" },
      );
    }

    const scrape = await quickScrapeServices(canonicalWebsiteUrl);
    if (!scrape.success) {
      return sendError(
        res,
        scrape.error || "Failed to scan website",
        400,
        { code: "SECONDARY_WEBSITE_SCAN_FAILED" },
      );
    }

    const websiteUrlCandidates = Array.from(
      new Set([
        ...getEquivalentWebsiteUrls(normalizedUrl),
        ...getEquivalentWebsiteUrls(canonicalWebsiteUrl),
      ]),
    );
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      let quickBusiness = await tx.quickScrapeBusiness.findFirst({
        where: {
          userId,
          businessWebsiteUrl: { in: websiteUrlCandidates },
        },
      });

      if (
        quickBusiness &&
        quickBusiness.onboardingV2Flow !== "website_secondary"
      ) {
        throw new SecondaryOnboardingV2ConflictError(
          "WEBSITE_ONBOARDING_ALREADY_EXISTS",
          "This website already belongs to another onboarding flow.",
        );
      }
      if (quickBusiness?.onboardingV2Status === "completed") {
        throw new SecondaryOnboardingV2ConflictError(
          "WEBSITE_ALREADY_ONBOARDED",
          "This website has already completed onboarding.",
        );
      }
      const scanTransition = resolveSecondaryOnboardingScanTransition(
        quickBusiness,
      );

      const scrapedData = {
        businessName:
          scrape.businessName || quickBusiness?.businessName || "My Business",
        businessType:
          scrape.businessType || quickBusiness?.businessType || "General",
        detectedServices: scrape.detectedServices || [],
        businessAddress:
          scrape.businessAddress || quickBusiness?.businessAddress || null,
        businessCity:
          scrape.businessCity || quickBusiness?.businessCity || null,
        businessState:
          scrape.businessState || quickBusiness?.businessState || null,
        businessCountry:
          scrape.businessCountry || quickBusiness?.businessCountry || null,
        businessPhone:
          scrape.businessPhone || quickBusiness?.businessPhone || null,
        serviceArea: scrape.serviceArea || quickBusiness?.serviceArea || null,
        serviceAreaLocations:
          scrape.serviceAreaLocations?.length
            ? scrape.serviceAreaLocations
            : quickBusiness?.serviceAreaLocations || [],
        businessLocationMode:
          scrape.businessLocationMode ||
          quickBusiness?.businessLocationMode ||
          "unknown",
        businessDescription:
          scrape.businessDescription ||
          quickBusiness?.businessDescription ||
          null,
        targetAudience:
          scrape.targetAudience || quickBusiness?.targetAudience || null,
        brandContext: scrape.brandContext
          ? (scrape.brandContext as Prisma.InputJsonValue)
          : undefined,
      };

      if (quickBusiness) {
        quickBusiness = await tx.quickScrapeBusiness.update({
          where: { id: quickBusiness.id },
          data: {
            ...scrapedData,
            onboardingV2Flow: "website_secondary",
            onboardingV2Step: scanTransition.nextStep,
            onboardingV2LastSeenAt: now,
          },
        });
      } else {
        quickBusiness = await tx.quickScrapeBusiness.create({
          data: {
            userId,
            businessWebsiteUrl: canonicalWebsiteUrl,
            selectedServices: [],
            ...scrapedData,
            onboardingV2Flow: "website_secondary",
            onboardingV2Step: "services",
            onboardingV2Status: "in_progress",
            onboardingV2LastSeenAt: now,
          },
        });
      }

      let business = quickBusiness.onboardingV2BusinessId
        ? await tx.business.findFirst({
            where: { id: quickBusiness.onboardingV2BusinessId, userId },
          })
        : null;
      if (!business) {
        business = await tx.business.findFirst({
          where: {
            userId,
            businessWebsiteUrl: { in: websiteUrlCandidates },
          },
          orderBy: { createdAt: "desc" },
        });
      }

      if (
        business &&
        (business.isPrimary ||
          business.onboardingFlow !== "website_secondary" ||
          business.onboardingStatus === "completed" ||
          business.removalStatus !== "active")
      ) {
        throw new SecondaryOnboardingV2ConflictError(
          "WEBSITE_ALREADY_EXISTS",
          "This website already exists in your account.",
        );
      }

      const businessData = {
        businessName: scrapedData.businessName,
        businessType: scrapedData.businessType,
        businessDescription:
          scrapedData.businessDescription || `${scrapedData.businessName} website`,
        businessWebsiteUrl: canonicalWebsiteUrl,
        businessAddress: scrapedData.businessAddress,
        businessCity: scrapedData.businessCity,
        businessState: scrapedData.businessState,
        businessCountry: scrapedData.businessCountry,
        businessPhone: scrapedData.businessPhone,
        serviceArea: scrapedData.serviceArea,
        serviceAreaLocations: scrapedData.serviceAreaLocations,
        detectedServices: scrapedData.detectedServices,
        isPrimary: false,
        isActive: false,
        websiteStatus: "pending",
        onboardingFlow: "website_secondary" as const,
        onboardingStatus: "awaiting_confirmation" as const,
        onboardingLastAttemptAt: now,
      };

      business = business
        ? await tx.business.update({
            where: { id: business.id },
            data: businessData,
          })
        : await tx.business.create({
            data: {
              userId,
              ...businessData,
              selectedServices: [],
              servicesPriority: {},
            },
          });

      if (quickBusiness.onboardingV2BusinessId !== business.id) {
        quickBusiness = await tx.quickScrapeBusiness.update({
          where: { id: quickBusiness.id },
          data: { onboardingV2BusinessId: business.id },
        });
      }

      return {
        business,
        quickBusiness,
        resumed: scanTransition.resumed,
      };
    });
    const paymentStatus = await getOnboardingV2PaymentStatus(
      result.quickBusiness,
    );

    return sendSuccess(
      res,
      {
        state: serializeOnboardingV2State(result.quickBusiness, {
          paymentStatus,
        }),
        onboardingId: result.quickBusiness.id,
        provisionalBusinessId: result.business.id,
        resumed: result.resumed,
        paymentRequired: !["active", "trialing"].includes(
          paymentStatus ?? "",
        ),
      },
      result.resumed
        ? "Additional website onboarding resumed"
        : "Additional website scan completed",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof SecondaryOnboardingV2ConflictError) {
      return sendError(res, error.message, 409, { code: error.code });
    }
    console.error("[Onboarding v2 secondary] Failed to begin", error);
    return sendError(res, "Failed to start additional website onboarding", 500, error);
  }
}

async function findOwnedOnboardingV2State(
  userId: string,
  businessId?: string,
) {
  if (businessId) {
    const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: { id: businessId, userId },
    });
    if (!quickBusiness) return null;

    if (quickBusiness.onboardingV2Flow === "website_secondary") {
      if (!quickBusiness.onboardingV2BusinessId) return null;
      const linkedBusiness = await prisma.business.findFirst({
        where: {
          id: quickBusiness.onboardingV2BusinessId,
          userId,
          onboardingFlow: "website_secondary",
          removalStatus: "active",
        },
        select: { id: true },
      });
      if (!linkedBusiness) return null;
    }

    return quickBusiness;
  }

  return prisma.quickScrapeBusiness.findFirst({
    where: {
      userId,
      onboardingV2Flow: "trial_primary",
      onboardingV2Status: { not: "completed" },
      onboardingV2LastSeenAt: { not: null },
    },
    orderBy: [{ onboardingV2LastSeenAt: "desc" }, { updatedAt: "desc" }],
  });
}

async function getOnboardingV2PaymentStatus(quickBusiness: {
  onboardingV2Flow?: string | null;
  onboardingV2BusinessId?: string | null;
}): Promise<string | null> {
  if (
    quickBusiness.onboardingV2Flow !== "website_secondary" ||
    !quickBusiness.onboardingV2BusinessId
  ) {
    return null;
  }

  const subscription = await prisma.websiteSubscription.findUnique({
    where: { businessId: quickBusiness.onboardingV2BusinessId },
    select: { status: true },
  });
  return subscription?.status ?? null;
}

export async function getOnboardingV2State(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = GET_ONBOARDING_V2_STATE.parse(req.query);
    const quickBusiness = await findOwnedOnboardingV2State(
      userId,
      payload.businessId,
    );
    if (payload.businessId && !quickBusiness) {
      return sendError(res, "Onboarding state not found", 404);
    }
    const signupPhone = quickBusiness
      ? (
          await prisma.user.findUnique({
            where: { id: userId },
            select: { phone: true },
          })
        )?.phone
      : null;
    const paymentStatus = quickBusiness
      ? await getOnboardingV2PaymentStatus(quickBusiness)
      : null;
    return sendSuccess(res, {
      state: quickBusiness
        ? serializeOnboardingV2State(quickBusiness, {
            signupPhone,
            paymentStatus,
          })
        : null,
    });
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2 state] Failed to load state", error);
    return sendError(res, "Failed to load onboarding state", 500, error);
  }
}

export async function listSecondaryOnboardingV2Sessions(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);

    const quickBusinesses = await prisma.quickScrapeBusiness.findMany({
      where: {
        userId,
        onboardingV2Flow: "website_secondary",
        onboardingV2Status: { not: "completed" },
        onboardingV2BusinessId: { not: null },
      },
      orderBy: [{ onboardingV2LastSeenAt: "desc" }, { updatedAt: "desc" }],
    });
    const linkedBusinessIds = quickBusinesses
      .map((quickBusiness) => quickBusiness.onboardingV2BusinessId)
      .filter((id): id is string => Boolean(id));
    const businesses = linkedBusinessIds.length
      ? await prisma.business.findMany({
          where: {
            id: { in: linkedBusinessIds },
            userId,
            isPrimary: false,
            onboardingFlow: "website_secondary",
            onboardingStatus: { not: "completed" },
            removalStatus: "active",
          },
          include: { websiteSubscription: { select: { status: true } } },
        })
      : [];
    const businessById = new Map(businesses.map((business) => [business.id, business]));

    const sessions = quickBusinesses.flatMap((quickBusiness) => {
      const linkedBusinessId = quickBusiness.onboardingV2BusinessId;
      const business = linkedBusinessId
        ? businessById.get(linkedBusinessId)
        : undefined;
      if (!business) return [];
      const paymentStatus = business.websiteSubscription?.status ?? null;
      return [
        {
          onboardingId: quickBusiness.id,
          provisionalBusinessId: business.id,
          websiteUrl: quickBusiness.businessWebsiteUrl,
          businessName:
            quickBusiness.businessName ||
            business.businessName ||
            quickBusiness.businessWebsiteUrl,
          step: quickBusiness.onboardingV2Step,
          status: quickBusiness.onboardingV2Status,
          completionStatus: business.onboardingStatus,
          blogStatus: quickBusiness.onboardingV2BlogStatus,
          socialStatus: quickBusiness.onboardingV2SocialStatus,
          paymentStatus,
          paymentRequired: !["active", "trialing"].includes(
            paymentStatus ?? "",
          ),
          updatedAt: quickBusiness.updatedAt,
          resumePath: `/dashboard/websites/onboarding/${quickBusiness.id}`,
        },
      ];
    });

    return sendSuccess(res, { sessions }, "Additional website sessions retrieved");
  } catch (error) {
    console.error("[Onboarding v2 secondary] Failed to list sessions", error);
    return sendError(res, "Failed to load additional website setup", 500, error);
  }
}

export async function completeSecondaryOnboardingV2(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = COMPLETE_SECONDARY_ONBOARDING_V2.parse(req.body);
    const correlationId =
      "correlationId" in req && typeof req.correlationId === "string"
        ? req.correlationId
        : null;

    const claim = await prisma.$transaction(async (tx) => {
      const quickBusiness = await tx.quickScrapeBusiness.findFirst({
        where: {
          id: payload.quickScrapeBusinessId,
          userId,
          onboardingV2Flow: "website_secondary",
        },
      });
      if (!quickBusiness?.onboardingV2BusinessId) {
        return { kind: "not_found" as const };
      }
      const business = await tx.business.findFirst({
        where: {
          id: quickBusiness.onboardingV2BusinessId,
          userId,
          onboardingFlow: "website_secondary",
          removalStatus: "active",
        },
        include: { websiteSubscription: true },
      });
      if (!business) return { kind: "not_found" as const };
      if (
        quickBusiness.onboardingV2Status === "completed" ||
        business.onboardingStatus === "completed"
      ) {
        return { kind: "existing" as const, quickBusiness, business };
      }
      if (
        business.onboardingStatus === "queued" ||
        business.onboardingStatus === "running"
      ) {
        return { kind: "existing" as const, quickBusiness, business };
      }
      if (
        quickBusiness.onboardingV2BlogStatus !== "complete" ||
        quickBusiness.onboardingV2SocialStatus !== "complete" ||
        !quickBusiness.onboardingV2BlogId ||
        !quickBusiness.onboardingV2SocialRunId
      ) {
        return { kind: "preview_required" as const };
      }
      if (
        !business.websiteSubscription ||
        !["active", "trialing"].includes(business.websiteSubscription.status)
      ) {
        return { kind: "payment_required" as const };
      }
      if (business.isActive || business.websiteStatus !== "pending") {
        return { kind: "invalid_business_state" as const };
      }

      const updatedBusiness = await tx.business.update({
        where: { id: business.id },
        data: {
          isPrimary: false,
          isActive: false,
          websiteStatus: "pending",
          onboardingStatus: "queued",
          onboardingAttemptCount: { increment: 1 },
          onboardingLastAttemptAt: new Date(),
          onboardingCompletedAt: null,
          onboardingCorrelationId: correlationId,
          onboardingLastError: Prisma.DbNull,
        },
      });
      return {
        kind: "claimed" as const,
        quickBusiness,
        business: updatedBusiness,
        planTier: business.websiteSubscription.planTier,
      };
    });

    if (claim.kind === "not_found") {
      return sendError(res, "Additional website onboarding was not found", 404);
    }
    if (claim.kind === "preview_required") {
      return sendError(res, "Complete the blog and social preview first", 409, {
        code: "SECONDARY_ONBOARDING_PREVIEW_REQUIRED",
      });
    }
    if (claim.kind === "payment_required") {
      return sendError(res, "Subscribe this website before completing setup", 402, {
        code: "SECONDARY_ONBOARDING_PAYMENT_REQUIRED",
      });
    }
    if (claim.kind === "invalid_business_state") {
      return sendError(res, "Additional website setup is not in a completable state", 409, {
        code: "SECONDARY_ONBOARDING_STATE_CONFLICT",
      });
    }
    if (claim.kind === "existing") {
      return sendSuccess(res, {
        accepted: true,
        alreadyQueued: true,
        onboardingId: claim.quickBusiness.id,
        provisionalBusinessId: claim.business.id,
      });
    }

    try {
      const queued = await inngest.send({
        id: `website-secondary-onboarding-v2-complete:${claim.quickBusiness.id}:attempt:${claim.business.onboardingAttemptCount}`,
        name: "website-secondary/onboarding-v2.complete",
        data: {
          userId,
          businessId: claim.business.id,
          quickScrapeBusinessId: claim.quickBusiness.id,
          planTier: claim.planTier,
          correlationId,
        },
      });
      if (!queued?.ids?.length) throw new Error("Inngest did not accept the event");
    } catch (queueError) {
      await prisma.business.updateMany({
        where: {
          id: claim.business.id,
          userId,
          onboardingStatus: "queued",
          onboardingAttemptCount: claim.business.onboardingAttemptCount,
        },
        data: {
          onboardingStatus: "awaiting_confirmation",
          onboardingLastError: {
            code: "queue_failed",
            stage: "secondary_onboarding_v2_complete",
            message:
              queueError instanceof Error ? queueError.message : String(queueError),
          },
        },
      });
      return sendError(res, "Could not queue additional website completion", 503, {
        code: "SECONDARY_ONBOARDING_QUEUE_FAILED",
        retryable: true,
      });
    }

    return sendSuccess(
      res,
      {
        accepted: true,
        alreadyQueued: false,
        onboardingId: claim.quickBusiness.id,
        provisionalBusinessId: claim.business.id,
      },
      "Additional website completion queued",
      202,
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2 secondary] Failed to complete", error);
    return sendError(res, "Failed to complete additional website onboarding", 500, error);
  }
}

export async function patchOnboardingV2State(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = PATCH_ONBOARDING_V2_STATE.parse(req.body);
    const quickBusiness = await findOwnedOnboardingV2State(userId, payload.businessId);
    if (!quickBusiness) return sendError(res, "Onboarding state not found", 404);
    if (quickBusiness.onboardingV2Status === "completed") {
      return sendError(res, "Completed onboarding state cannot be changed", 409);
    }

    const merged = mergeOnboardingV2Answers(
      quickBusiness.onboardingV2Answers,
      payload.answers,
    );
    const persistedStep = resolveOnboardingV2PersistedStep({
      currentStep: quickBusiness.onboardingV2Step,
      currentStatus: quickBusiness.onboardingV2Status,
      requestedStep: payload.step,
      requestedStatus: payload.status,
    });
    const existingBrandContext = asRecord(quickBusiness.brandContext);
    let brandContext: Record<string, unknown> | null = null;
    if (payload.brand) {
      const requestedLogoUrl = payload.brand.logoUrl.trim();
      let canonicalLogoUrl = "";
      let brandLogo: Record<string, unknown> | null = null;
      if (requestedLogoUrl) {
        const existingBrandLogo = asRecord(existingBrandContext.brandLogo);
        const canReuseCanonicalLogo =
          existingBrandLogo.provider === "bunny" &&
          existingBrandLogo.canonicalMimeType === "image/png" &&
          existingBrandLogo.url === requestedLogoUrl;
        if (canReuseCanonicalLogo) {
          canonicalLogoUrl = requestedLogoUrl;
          brandLogo = existingBrandLogo;
        } else {
          let upload;
          try {
            upload = await canonicalizeRemoteOnboardingV2BrandLogo({
              logoUrl: requestedLogoUrl,
              quickBusinessId: quickBusiness.id,
              userId,
            });
          } catch (error) {
            if (error instanceof OnboardingV2BrandLogoValidationError) {
              return sendError(res, error.message, error.statusCode, {
                code: error.code,
                message: error.message,
              });
            }
            console.error("[Onboarding v2] Bunny brand logo upload failed", error);
            return sendError(
              res,
              "Brand logo storage is temporarily unavailable",
              503,
              {
                code: "ONBOARDING_V2_BRAND_LOGO_STORAGE_FAILED",
                message: "The brand logo was not saved. Please retry.",
                details: { retryable: true },
              },
            );
          }
          canonicalLogoUrl = upload.url;
          brandLogo = serializeOnboardingV2BrandLogo(upload, "confirmed_url");
        }
      }
      brandContext = {
        ...existingBrandContext,
        ...payload.brand,
        logoUrl: canonicalLogoUrl,
        brandLogo,
        brandConfirmedAt: new Date().toISOString(),
        brandConfirmation: {
          version: 2,
          source: "user",
        },
      };
    }
    const data: Prisma.QuickScrapeBusinessUncheckedUpdateInput = {
      onboardingV2LastSeenAt: new Date(),
      ...(persistedStep !== quickBusiness.onboardingV2Step
        ? { onboardingV2Step: persistedStep }
        : {}),
      ...(payload.questionIndex !== undefined
        ? { onboardingV2QuestionIndex: payload.questionIndex }
        : {}),
      ...(payload.answers
        ? { onboardingV2Answers: merged.answers as Prisma.InputJsonValue }
        : {}),
      ...(merged.changed
        ? {
            onboardingV2AnswerRevision: {
              increment: 1,
            },
          }
        : {}),
      ...(payload.status ? { onboardingV2Status: payload.status } : {}),
      ...(payload.status ? { onboardingV2CompletedAt: null } : {}),
      ...(payload.businessDetails
        ? buildBusinessDetailsData(payload.businessDetails, {
            markConfirmed: payload.step === "author" || payload.step === "review",
          })
        : {}),
      ...(payload.selectedServices
        ? { selectedServices: payload.selectedServices }
        : {}),
      ...(payload.servicesPriority
        ? { servicesPriority: payload.servicesPriority as Prisma.InputJsonValue }
        : {}),
      ...(brandContext
        ? { brandContext: brandContext as Prisma.InputJsonValue }
        : {}),
      ...(payload.author
        ? {
            onboardingV2Author: mergeOnboardingV2Author(
              quickBusiness.onboardingV2Author,
              payload.author,
            ) as Prisma.InputJsonValue,
          }
        : {}),
    };

    const updated = await prisma.$transaction(async (tx) => {
      const updatedQuickBusiness = await tx.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data,
      });
      if (updatedQuickBusiness.onboardingV2BusinessId) {
        const provisional = await tx.business.findFirst({
          where: {
            id: updatedQuickBusiness.onboardingV2BusinessId,
            userId,
            websiteStatus: "pending",
            isActive: false,
          },
          select: { id: true },
        });
        if (provisional) {
          const {
            userId: _userId,
            isActive: _isActive,
            websiteStatus: _websiteStatus,
            onboardingFlow: _onboardingFlow,
            onboardingStatus: _onboardingStatus,
            ...canonicalData
          } = buildProvisionalBusinessData(updatedQuickBusiness, userId);
          await tx.business.update({
            where: { id: provisional.id },
            data: canonicalData,
          });
          if (payload.brand) {
            await tx.brandAnalysis.updateMany({
              where: { businessId: provisional.id },
              data: {
                logoUrl: cleanOptionalString(brandContext?.logoUrl),
                logoAltText: cleanOptionalString(payload.brand.logoAltText),
                lastAnalyzed: new Date(),
              },
            });
          }
        }
      }
      return updatedQuickBusiness;
    });
    const paymentStatus = await getOnboardingV2PaymentStatus(updated);
    return sendSuccess(
      res,
      { state: serializeOnboardingV2State(updated, { paymentStatus }) },
      "Onboarding state saved",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2 state] Failed to save state", error);
    return sendError(res, "Failed to save onboarding state", 500, error);
  }
}

export async function uploadOnboardingV2AuthorImageController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE.parse(req.body);
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      return sendError(res, "Author image is required", 400, {
        code: "ONBOARDING_V2_AUTHOR_IMAGE_REQUIRED",
        message: "Send one author image in the multipart field named image.",
      });
    }

    const quickBusiness = await findOwnedOnboardingV2State(
      userId,
      payload.businessId,
    );
    if (!quickBusiness) return sendError(res, "Onboarding state not found", 404);
    if (quickBusiness.onboardingV2Status === "completed") {
      return sendError(res, "Completed onboarding state cannot be changed", 409);
    }

    let upload;
    try {
      upload = await uploadOnboardingV2AuthorImage({
        buffer: file.buffer,
        declaredMimeType: file.mimetype,
        quickBusinessId: quickBusiness.id,
        userId,
      });
    } catch (error) {
      if (error instanceof OnboardingV2AuthorImageValidationError) {
        return sendError(res, error.message, error.statusCode, {
          code: error.code,
          message: error.message,
        });
      }
      console.error("[Onboarding v2] Bunny author image upload failed", error);
      return sendError(res, "Author image storage is temporarily unavailable", 503, {
        code: "ONBOARDING_V2_AUTHOR_IMAGE_STORAGE_FAILED",
        message:
          "The author image was not saved. Please retry the upload.",
        details: { retryable: true },
      });
    }

    const imageName = safeOnboardingV2AuthorImageName(file.originalname);
    const author = {
      ...asRecord(quickBusiness.onboardingV2Author),
      imageName,
      imageUrl: upload.url,
    };
    const updated = await prisma.$transaction(async (tx) => {
      const updatedQuickBusiness = await tx.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data: {
          onboardingV2Author: author as Prisma.InputJsonValue,
          onboardingV2LastSeenAt: new Date(),
        },
      });
      if (quickBusiness.onboardingV2BusinessId) {
        const provisional = await tx.business.findFirst({
          where: {
            id: quickBusiness.onboardingV2BusinessId,
            userId,
            websiteStatus: "pending",
            isActive: false,
          },
          select: { id: true },
        });
        if (provisional) {
          await tx.business.update({
            where: { id: provisional.id },
            data: { authorImage: upload.url },
          });
        }
      }
      return updatedQuickBusiness;
    });
    const signupPhone =
      cleanOptionalString(updated.businessPhone) === null
        ? (
            await prisma.user.findUnique({
              where: { id: userId },
              select: { phone: true },
            })
          )?.phone
        : null;
    const paymentStatus = await getOnboardingV2PaymentStatus(updated);

    return sendSuccess(
      res,
      {
        state: serializeOnboardingV2State(updated, {
          signupPhone,
          paymentStatus,
        }),
        author,
        image: {
          url: upload.url,
          name: imageName,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          width: upload.width,
          height: upload.height,
          provider: upload.provider,
          objectKey: upload.objectKey,
          checksumSha256: upload.checksumSha256,
        },
      },
      "Author image uploaded successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2] Failed to persist author image", error);
    return sendError(res, "Failed to save author image", 500, error);
  }
}

export async function uploadOnboardingV2BrandLogoController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = UPLOAD_ONBOARDING_V2_BRAND_LOGO.parse(req.body);
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      return sendError(res, "Brand logo is required", 400, {
        code: "ONBOARDING_V2_BRAND_LOGO_REQUIRED",
        message: "Send one brand logo in the multipart field named image.",
      });
    }

    const quickBusiness = await findOwnedOnboardingV2State(
      userId,
      payload.businessId,
    );
    if (!quickBusiness) return sendError(res, "Onboarding state not found", 404);
    if (quickBusiness.onboardingV2Status === "completed") {
      return sendError(res, "Completed onboarding state cannot be changed", 409);
    }

    let upload;
    try {
      upload = await uploadOnboardingV2BrandLogo({
        buffer: file.buffer,
        declaredMimeType: file.mimetype,
        quickBusinessId: quickBusiness.id,
        userId,
      });
    } catch (error) {
      if (error instanceof OnboardingV2BrandLogoValidationError) {
        return sendError(res, error.message, error.statusCode, {
          code: error.code,
          message: error.message,
        });
      }
      console.error("[Onboarding v2] Bunny brand logo upload failed", error);
      return sendError(res, "Brand logo storage is temporarily unavailable", 503, {
        code: "ONBOARDING_V2_BRAND_LOGO_STORAGE_FAILED",
        message: "The brand logo was not saved. Please retry.",
        details: { retryable: true },
      });
    }

    const logo = serializeOnboardingV2BrandLogo(upload, "user_upload");
    const brandContext = {
      ...asRecord(quickBusiness.brandContext),
      logoUrl: upload.url,
      brandLogo: logo,
    };
    const updated = await prisma.$transaction(async (tx) => {
      const updatedQuickBusiness = await tx.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data: {
          brandContext: brandContext as Prisma.InputJsonValue,
          onboardingV2LastSeenAt: new Date(),
        },
      });
      if (quickBusiness.onboardingV2BusinessId) {
        const provisional = await tx.business.findFirst({
          where: {
            id: quickBusiness.onboardingV2BusinessId,
            userId,
            websiteStatus: "pending",
            isActive: false,
          },
          select: { id: true },
        });
        if (provisional) {
          await tx.brandAnalysis.updateMany({
            where: { businessId: provisional.id },
            data: { logoUrl: upload.url, lastAnalyzed: new Date() },
          });
        }
      }
      return updatedQuickBusiness;
    });
    const paymentStatus = await getOnboardingV2PaymentStatus(updated);

    return sendSuccess(
      res,
      {
        state: serializeOnboardingV2State(updated, { paymentStatus }),
        logo,
      },
      "Brand logo uploaded successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2] Failed to persist brand logo", error);
    return sendError(res, "Failed to save brand logo", 500, error);
  }
}

function buildProvisionalBusinessData(quickBusiness: any, userId: string) {
  const answers = asRecord(quickBusiness.onboardingV2Answers);
  const author = asRecord(quickBusiness.onboardingV2Author);
  const selectedServices =
    quickBusiness.selectedServices.length > 0
      ? quickBusiness.selectedServices
      : quickBusiness.detectedServices;
  return {
    userId,
    businessName: quickBusiness.businessName || "My Business",
    businessType: quickBusiness.businessType || "General",
    businessDescription:
      quickBusiness.businessDescription ||
      `${quickBusiness.businessName || "This business"} website preview`,
    businessWebsiteUrl: quickBusiness.businessWebsiteUrl,
    businessPhone: quickBusiness.businessPhone,
    businessAddress: quickBusiness.businessAddress,
    businessCity: quickBusiness.businessCity,
    businessState: quickBusiness.businessState,
    businessCountry: quickBusiness.businessCountry,
    serviceArea: mapServiceArea(
      firstAnswer(answers, "a_reach"),
      quickBusiness.serviceArea,
    ),
    serviceAreaLocations: quickBusiness.serviceAreaLocations ?? [],
    targetAudience:
      mapAudienceAnswer(firstAnswer(answers, "a2_audience")) ||
      quickBusiness.targetAudience,
    contentTone: firstAnswer(answers, "a3_voice"),
    publishingFrequency: mapPublishingFrequency(
      firstAnswer(answers, "postsPerWeek"),
    ),
    preferredContentTypes: answerList(answers, "a5_content"),
    supportedLanguages: ["en"],
    exampleBlogUrls: [],
    detectedServices: quickBusiness.detectedServices,
    selectedServices,
    servicesPriority: quickBusiness.servicesPriority ?? {},
    authorName: cleanOptionalString(author.name),
    authorBio: cleanOptionalString(author.bio),
    authorJobTitle: cleanOptionalString(author.title),
    authorImage: cleanOptionalString(author.imageUrl),
    authorExpertise: cleanStringList(author.expertise),
    isActive: false,
    websiteStatus: "pending",
    onboardingFlow:
      quickBusiness.onboardingV2Flow === "website_secondary"
        ? ("website_secondary" as const)
        : ("trial_primary" as const),
    onboardingStatus: "idle" as const,
  };
}

export async function startOnboardingV2Generation(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!onboardingV2GenerationEnabled()) {
      return sendError(res, "Onboarding preview generation is disabled", 503, {
        code: "ONBOARDING_V2_PREVIEW_GENERATION_DISABLED",
      });
    }
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = START_ONBOARDING_V2_GENERATION.parse(req.body);

    const claim = await prisma.$transaction(async (tx) => {
      const quickBusiness = await tx.quickScrapeBusiness.findFirst({
        where: { id: payload.businessId, userId },
      });
      if (!quickBusiness) return { kind: "not_found" as const };
      if (quickBusiness.onboardingV2Status === "completed") {
        return { kind: "finalized" as const };
      }
      if (quickBusiness.onboardingV2BusinessId) {
        const linkedBusiness = await tx.business.findFirst({
          where: { id: quickBusiness.onboardingV2BusinessId, userId },
          select: {
            isActive: true,
            isPrimary: true,
            websiteStatus: true,
            onboardingFlow: true,
            removalStatus: true,
          },
        });
        if (
          quickBusiness.onboardingV2Flow === "website_secondary" &&
          (!linkedBusiness ||
            linkedBusiness.isPrimary ||
            linkedBusiness.onboardingFlow !== "website_secondary" ||
            linkedBusiness.removalStatus !== "active")
        ) {
          return { kind: "not_found" as const };
        }
        if (
          linkedBusiness &&
          (linkedBusiness.isActive || linkedBusiness.websiteStatus !== "pending")
        ) {
          return { kind: "finalized" as const };
        }
      }
      const services =
        quickBusiness.selectedServices.length > 0
          ? quickBusiness.selectedServices
          : quickBusiness.detectedServices;
      if (services.length === 0) return { kind: "services_required" as const };

      const generationStatuses = [
        quickBusiness.onboardingV2BlogStatus,
        quickBusiness.onboardingV2SocialStatus,
      ];
      const hasActiveWork = generationStatuses.some((status) =>
        ["queued", "running"].includes(status),
      );
      const allWorkComplete = generationStatuses.every(
        (status) => status === "complete",
      );
      if (
        quickBusiness.onboardingV2GenerationStartedAt &&
        (hasActiveWork || allWorkComplete)
      ) {
        return {
          kind: "existing" as const,
          state: quickBusiness,
          revision:
            quickBusiness.onboardingV2GenerationRevision ??
            quickBusiness.onboardingV2AnswerRevision,
        };
      }

      const retrying = Boolean(quickBusiness.onboardingV2GenerationStartedAt);
      const revision = retrying
        ? (quickBusiness.onboardingV2GenerationRevision ??
          quickBusiness.onboardingV2AnswerRevision)
        : quickBusiness.onboardingV2AnswerRevision;

      const claimed = await tx.quickScrapeBusiness.updateMany({
        where: {
          id: quickBusiness.id,
          userId,
          onboardingV2GenerationStartedAt:
            quickBusiness.onboardingV2GenerationStartedAt,
          onboardingV2GenerationRevision:
            quickBusiness.onboardingV2GenerationRevision,
        },
        data: {
          onboardingV2GenerationStartedAt: new Date(),
          onboardingV2GenerationRevision: revision,
          onboardingV2BlogStatus:
            quickBusiness.onboardingV2BlogStatus === "complete"
              ? "complete"
              : "queued",
          onboardingV2SocialStatus:
            quickBusiness.onboardingV2SocialStatus === "complete"
              ? "complete"
              : "queued",
          onboardingV2GenerationError: Prisma.DbNull,
          onboardingV2LastSeenAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        const state = await tx.quickScrapeBusiness.findUniqueOrThrow({
          where: { id: quickBusiness.id },
        });
        return { kind: "existing" as const, state, revision };
      }

      let business = quickBusiness.onboardingV2BusinessId
        ? await tx.business.findFirst({
            where: { id: quickBusiness.onboardingV2BusinessId, userId },
          })
        : null;
      if (!business) {
        const candidates = getEquivalentWebsiteUrls(quickBusiness.businessWebsiteUrl);
        business = await tx.business.findFirst({
          where: {
            userId,
            websiteStatus: "pending",
            businessWebsiteUrl: { in: candidates },
          },
          orderBy: { updatedAt: "desc" },
        });
      }
      if (!business) {
        const activeBusinessCount = await tx.business.count({
          where: { userId, isActive: true },
        });
        business = await tx.business.create({
          data: {
            ...buildProvisionalBusinessData(quickBusiness, userId),
            isPrimary: activeBusinessCount === 0,
          },
        });
      } else {
        business = await tx.business.update({
          where: { id: business.id },
          data: buildProvisionalBusinessData(quickBusiness, userId),
        });
      }

      const state = await tx.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data: { onboardingV2BusinessId: business.id },
      });
      return { kind: "claimed" as const, state, business, revision, retrying };
    });

    if (claim.kind === "not_found") {
      return sendError(res, "Onboarding state not found", 404);
    }
    if (claim.kind === "finalized") {
      return sendError(res, "Onboarding preview can no longer be regenerated", 409);
    }
    if (claim.kind === "services_required") {
      return sendError(
        res,
        "Confirm at least one service before starting preview generation",
        400,
        { code: "ONBOARDING_V2_SERVICES_REQUIRED" },
      );
    }
    if (claim.kind === "existing") {
      const paymentStatus = await getOnboardingV2PaymentStatus(claim.state);
      return sendSuccess(
        res,
        {
          state: serializeOnboardingV2State(claim.state, { paymentStatus }),
          queued: false,
          generationRevision: claim.revision,
        },
        "Onboarding preview generation is already queued",
        202,
      );
    }

    try {
      const sendResult = await inngest.send({
        id: claim.retrying
          ? `onboarding-v2-preview:${claim.state.id}:r${claim.revision}:retry:${claim.state.onboardingV2GenerationStartedAt?.getTime()}`
          : `onboarding-v2-preview:${claim.state.id}:r${claim.revision}`,
        name: "onboarding-v2/preview.requested",
        data: {
          quickBusinessId: claim.state.id,
          userId,
          businessId: claim.business.id,
          revision: claim.revision,
        },
      });
      if (!sendResult?.ids?.length) throw new Error("Inngest did not accept the event");
    } catch (error) {
      await prisma.quickScrapeBusiness.updateMany({
        where: {
          id: claim.state.id,
          userId,
          onboardingV2GenerationRevision: claim.revision,
        },
        data: {
          onboardingV2GenerationStartedAt: null,
          onboardingV2BlogStatus:
            claim.state.onboardingV2BlogStatus === "complete" ? "complete" : "failed",
          onboardingV2SocialStatus:
            claim.state.onboardingV2SocialStatus === "complete" ? "complete" : "failed",
          onboardingV2GenerationError: {
            queue: error instanceof Error ? error.message : String(error),
          },
        },
      });
      console.error("[Onboarding v2] Failed to queue preview generation", error);
      return sendError(res, "Failed to queue onboarding preview generation", 503, {
        code: "ONBOARDING_V2_QUEUE_FAILED",
      });
    }

    const paymentStatus = await getOnboardingV2PaymentStatus(claim.state);
    return sendSuccess(
      res,
      {
        state: serializeOnboardingV2State(claim.state, { paymentStatus }),
        queued: true,
        generationRevision: claim.revision,
      },
      "Onboarding preview generation queued",
      202,
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2] Failed to start preview generation", error);
    return sendError(res, "Failed to start onboarding preview generation", 500, error);
  }
}

function mapSocialStatus(status: string | undefined): string {
  if (status === "COMPLETE") return "complete";
  if (status === "FAILED" || status === "CANCELLED") return "failed";
  if (status === "PLANNING" || status === "RENDERING") return "running";
  return status === "PENDING" ? "queued" : "idle";
}

export async function getOnboardingV2Preview(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const payload = GET_ONBOARDING_V2_PREVIEW.parse(req.query);
    const quickBusiness = await findOwnedOnboardingV2State(userId, payload.businessId);
    if (!quickBusiness) return sendError(res, "Onboarding state not found", 404);

    const [blog, socialRun] = await Promise.all([
      quickBusiness.onboardingV2BlogId
        ? prisma.blog.findFirst({
            where: {
              id: quickBusiness.onboardingV2BlogId,
              userId,
              ...(quickBusiness.onboardingV2BusinessId
                ? { businessId: quickBusiness.onboardingV2BusinessId }
                : {}),
            },
            select: {
              id: true,
              title: true,
              slug: true,
              status: true,
              content: true,
              excerpt: true,
              featured_media: true,
              categories: true,
              tags: true,
              seoScore: true,
              authorName: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : null,
      quickBusiness.onboardingV2SocialRunId
        ? prisma.socialCreativeRun.findFirst({
            where: {
              id: quickBusiness.onboardingV2SocialRunId,
              userId,
              ...(quickBusiness.onboardingV2BusinessId
                ? { businessId: quickBusiness.onboardingV2BusinessId }
                : {}),
            },
            include: {
              posts: {
                orderBy: { slideIndex: "asc" },
                include: {
                  assets: {
                    orderBy: [{ slideIndex: "asc" }, { platform: "asc" }],
                  },
                },
              },
            },
          })
        : null,
    ]);

    const blogStatus = blog ? "complete" : quickBusiness.onboardingV2BlogStatus;
    const socialStatus = socialRun
      ? mapSocialStatus(socialRun.status)
      : quickBusiness.onboardingV2SocialStatus;
    const paymentStatus = await getOnboardingV2PaymentStatus(quickBusiness);
    return sendSuccess(res, {
      state: {
        ...serializeOnboardingV2State(quickBusiness, { paymentStatus }),
        blogStatus,
        socialStatus,
      },
      quickBusinessId: quickBusiness.id,
      generationRevision: quickBusiness.onboardingV2GenerationRevision,
      blog: {
        status: blogStatus,
        data: blog,
      },
      social: {
        status: socialStatus,
        data: socialRun ? serializeSocialCreativeRun(socialRun) : null,
      },
      errors: quickBusiness.onboardingV2GenerationError ?? null,
    });
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[Onboarding v2] Failed to load preview", error);
    return sendError(res, "Failed to load onboarding preview", 500, error);
  }
}
