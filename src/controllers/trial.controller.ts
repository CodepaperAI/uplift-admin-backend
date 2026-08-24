import type { Response } from "express";
import type { WebsitePlanTier } from "@prisma/client";
import { ZodError, type z } from "zod";
import { prisma } from "../config/db.config";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  markBusinessOnboardingFailed,
  markBusinessOnboardingQueued,
  serializeOnboardingError,
} from "../services/onboarding-state.service";
import { TrialAnalyticsService } from "../services/trial-analytics.service";
import {
  sendTopKeywordsEmail,
  sendWelcomeEmail,
} from "../services/trial-email.service";
import {
  fetchQuickKeywordsForTrial,
  predictRankingsForKeywords,
} from "../utils/quick-keywords.utils";
import {
  buildServicesPriorityFromOrder,
  resolveOrderedSelectedServices,
  resolveServicesPriorityMap,
} from "../utils/effective-services.utils";
import { logOnboardingAlert, logOnboardingStage } from "../utils/onboarding-logger";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  getActiveAgencyPricingConfigId,
  resolveAgencyAssignmentForRequest,
} from "../utils/agency-context.utils";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";
import {
  CHECK_TRIAL_STATUS,
  ENROLL_TRIAL,
  TRIGGER_COMPLETE_ONBOARDING,
} from "../validators/trial.validation";
import { QUICK_BUSINESS_DETAILS } from "../validators/quick-scrape.validation";
import { resolveDashboardAccessFromUser } from "../utils/access-control.utils";

type QuickBusinessDetails = z.infer<typeof QUICK_BUSINESS_DETAILS>;

type QuickBusinessServiceInput = {
  selectedServices?: string[] | null;
  servicesPriority?: unknown;
  detectedServices?: unknown;
};

type QuickBusinessLocationInput = {
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
  onboardingV2BusinessId?: string | null;
};

export function buildTrialAnchorBusinessWhere(input: {
  userId: string;
  onboardingV2BusinessId?: string | null;
  websiteUrlCandidates: string[];
}) {
  return input.onboardingV2BusinessId
    ? { id: input.onboardingV2BusinessId, userId: input.userId }
    : {
        userId: input.userId,
        businessWebsiteUrl: { in: input.websiteUrlCandidates },
      };
}

export function hasVerifiedOnboardingEntitlement(input: {
  accountStripeSubscriptionId?: string | null;
  accountSubscriptionStatus?: string | null;
  isPlatformStaff: boolean;
  websiteStripeSubscriptionId?: string | null;
  websiteSubscriptionStatus?: string | null;
}): boolean {
  if (input.isPlatformStaff) {
    return true;
  }

  const eligibleStatuses = new Set(["active", "trialing"]);
  const hasWebsiteEntitlement =
    Boolean(input.websiteStripeSubscriptionId) &&
    eligibleStatuses.has(input.websiteSubscriptionStatus ?? "");
  const hasLegacyAccountEntitlement =
    Boolean(input.accountStripeSubscriptionId) &&
    eligibleStatuses.has(input.accountSubscriptionStatus ?? "");

  return hasWebsiteEntitlement || hasLegacyAccountEntitlement;
}

function cleanOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function buildQuickBusinessDetailsUpdate(
  details: QuickBusinessDetails | undefined,
  fallbackPhone?: string,
) {
  if (!details) {
    const phone = cleanOptionalString(fallbackPhone);
    return phone
      ? {
          businessPhone: phone,
          contactDetailsConfirmedAt: new Date(),
        }
      : {};
  }

  const businessName = cleanOptionalString(details.businessName);
  const businessType = cleanOptionalString(details.businessType);
  return {
    ...(businessName ? { businessName } : {}),
    ...(businessType ? { businessType } : {}),
    businessAddress: cleanOptionalString(details.businessAddress),
    businessCity: cleanOptionalString(details.businessCity),
    businessState: cleanOptionalString(details.businessState),
    businessCountry: cleanOptionalString(details.businessCountry),
    businessPhone:
      cleanOptionalString(details.businessPhone) ??
      cleanOptionalString(fallbackPhone),
    serviceArea: cleanOptionalString(details.serviceArea),
    serviceAreaLocations: cleanStringList(details.serviceAreaLocations),
    businessLocationMode: cleanOptionalString(details.businessLocationMode),
    confirmedPlaceId: cleanOptionalString(details.confirmedPlaceId),
    contactDetailsConfirmedAt: new Date(),
  };
}

function buildBusinessLocationData(
  quickBusiness: QuickBusinessLocationInput,
  options: { includeEmpty?: boolean } = {},
) {
  const values: {
    businessPhone?: string | null;
    businessAddress?: string | null;
    businessCity?: string | null;
    businessState?: string | null;
    businessCountry?: string | null;
    serviceArea?: string | null;
    serviceAreaLocations?: string[];
  } = {};

  const stringFields = {
    businessPhone: cleanOptionalString(quickBusiness.businessPhone),
    businessAddress: cleanOptionalString(quickBusiness.businessAddress),
    businessCity: cleanOptionalString(quickBusiness.businessCity),
    businessState: cleanOptionalString(quickBusiness.businessState),
    businessCountry: cleanOptionalString(quickBusiness.businessCountry),
    serviceArea: cleanOptionalString(quickBusiness.serviceArea),
  };
  const serviceAreaLocations = cleanStringList(quickBusiness.serviceAreaLocations);

  if (options.includeEmpty) {
    return {
      ...stringFields,
      serviceAreaLocations,
    };
  }

  for (const [key, value] of Object.entries(stringFields)) {
    if (value) {
      values[key as keyof typeof stringFields] = value;
    }
  }

  if (serviceAreaLocations.length > 0) {
    values.serviceAreaLocations = serviceAreaLocations;
  }

  return values;
}

async function runBestEffortGeoSetup(input: {
  businessId: string;
  quickBusiness: QuickBusinessLocationInput;
  timeoutMs?: number;
}) {
  const hasAddress = Boolean(
    cleanOptionalString(input.quickBusiness.businessAddress) ||
      cleanOptionalString(input.quickBusiness.businessCity),
  );
  const confirmedPlaceId = cleanOptionalString(
    input.quickBusiness.confirmedPlaceId,
  );
  const serviceAreas = cleanStringList(input.quickBusiness.serviceAreaLocations);

  const task = (async () => {
    try {
      const { enrichGeoProfile, recomputeGeoProfileQuality } = await import(
        "../services/business-geo-profile.service"
      );
      if (confirmedPlaceId) {
        await enrichGeoProfile(input.businessId, confirmedPlaceId);
      } else if (hasAddress) {
        await enrichGeoProfile(input.businessId);
      }
      await recomputeGeoProfileQuality(input.businessId);
    } catch (error) {
      console.error("⚠️ Quick onboarding geo enrichment failed:", error);
    }

    if (serviceAreas.length > 0) {
      try {
        const { resolveAllServiceAreasForBusiness } = await import(
          "../services/service-area-geo.service"
        );
        await resolveAllServiceAreasForBusiness(input.businessId);
      } catch (error) {
        console.error("⚠️ Quick onboarding service-area resolution failed:", error);
      }
    }
  })();

  await Promise.race([
    task,
    new Promise<void>((resolve) =>
      setTimeout(resolve, input.timeoutMs ?? 1500),
    ),
  ]);
}

function resolveQuickBusinessServiceSelection(
  quickBusiness: QuickBusinessServiceInput,
) {
  const orderedSelectedServices = resolveOrderedSelectedServices(
    quickBusiness.selectedServices,
    quickBusiness.servicesPriority,
  );
  const explicitPriority = resolveServicesPriorityMap(
    quickBusiness.servicesPriority,
  );
  const servicesPriority =
    Object.keys(explicitPriority).length > 0
      ? explicitPriority
      : buildServicesPriorityFromOrder(orderedSelectedServices);
  const detectedServices = Array.isArray(quickBusiness.detectedServices)
    ? quickBusiness.detectedServices.filter(
        (service): service is string => typeof service === "string",
      )
    : [];

  return {
    selectedServices: orderedSelectedServices,
    servicesPriority,
    detectedServices,
  };
}

function getRequestCorrelationId(
  req: AuthenticatedRequest,
): string | undefined {
  if (
    "correlationId" in req &&
    typeof (req as { correlationId?: unknown }).correlationId === "string"
  ) {
    return (req as { correlationId: string }).correlationId;
  }

  return undefined;
}

async function queueTrialPrimaryOnboarding(input: {
  userId: string;
  businessId: string;
  websiteUrl: string;
  selectedServices: string[];
  servicesPriority: Record<string, number>;
  detectedServices: string[];
  quickScrapeBusinessId?: string | null;
  planTier?: WebsitePlanTier;
  correlationId?: string;
}) {
  const ids = await inngest.send({
    name: "trial/complete-onboarding",
    data: {
      userId: input.userId,
      businessId: input.businessId,
      websiteUrl: input.websiteUrl,
      selectedServices: input.selectedServices,
      servicesPriority: input.servicesPriority,
      detectedServices: input.detectedServices,
      quickScrapeBusinessId: input.quickScrapeBusinessId ?? null,
      planTier: input.planTier ?? "SEO",
      correlationId: input.correlationId,
    },
  });

  if (!ids?.ids?.length) {
    throw new Error("Failed to queue trial onboarding");
  }

  await markBusinessOnboardingQueued(prisma, {
    businessId: input.businessId,
    flow: "trial_primary",
    correlationId: input.correlationId,
  });
}

export function getTrialOnboardingHandoffDecision(input: {
  selectedService?: string | null;
  previewBlogId?: string | null;
  hasOnboardingV2State: boolean;
  allowQuickBlog: boolean;
}) {
  return {
    queueQuickBlog: Boolean(
      input.allowQuickBlog && input.selectedService && !input.previewBlogId,
    ),
    recordOnboardingV2Handoff: input.hasOnboardingV2State,
  };
}

export async function executeTrialOnboardingHandoff(
  input: {
    selectedService?: string | null;
    previewBlogId?: string | null;
    hasOnboardingV2State: boolean;
    allowQuickBlog: boolean;
  },
  deps: {
    queueFullOnboarding: () => Promise<void>;
    queueQuickBlog: () => Promise<void>;
    recordOnboardingV2Handoff: () => Promise<void>;
    onQuickBlogError?: (error: unknown) => void;
    onStateHandoffError?: (error: unknown) => void;
  },
) {
  const decision = getTrialOnboardingHandoffDecision(input);

  // This is intentionally the only throwing step. Callers must roll back a
  // trial/payment handoff when the durable full-onboarding event was not
  // accepted. Neither ancillary quick-blog generation nor state bookkeeping
  // is allowed to make an accepted full-onboarding handoff look unqueued.
  await deps.queueFullOnboarding();

  if (decision.queueQuickBlog) {
    try {
      await deps.queueQuickBlog();
    } catch (error) {
      deps.onQuickBlogError?.(error);
    }
  }

  if (decision.recordOnboardingV2Handoff) {
    try {
      await deps.recordOnboardingV2Handoff();
    } catch (error) {
      deps.onStateHandoffError?.(error);
    }
  }

  return decision;
}

async function upsertTrialAnchorBusiness(args: {
  userId: string;
  quickBusiness: {
    businessName: string | null;
    businessType: string | null;
    businessWebsiteUrl: string;
    selectedServices?: string[] | null;
    servicesPriority?: unknown;
    detectedServices?: unknown;
    businessAddress?: string | null;
    businessCity?: string | null;
    businessState?: string | null;
    businessCountry?: string | null;
    businessPhone?: string | null;
    serviceArea?: string | null;
    serviceAreaLocations?: string[] | null;
    businessLocationMode?: string | null;
    confirmedPlaceId?: string | null;
    onboardingV2BusinessId?: string | null;
  };
  agencyAssignment: Awaited<ReturnType<typeof resolveAgencyAssignmentForRequest>>;
  correlationId?: string;
  trialStartDate?: Date;
  trialEndDate?: Date;
  upsertTrialSubscription: boolean;
}) {
  const websiteUrl = normalizeWebsiteUrl(args.quickBusiness.businessWebsiteUrl);
  const websiteUrlCandidates = getEquivalentWebsiteUrls(websiteUrl);
  const {
    selectedServices,
    servicesPriority,
    detectedServices,
  } = resolveQuickBusinessServiceSelection(args.quickBusiness);
  const locationUpdateData = buildBusinessLocationData(args.quickBusiness);
  const locationCreateData = buildBusinessLocationData(args.quickBusiness, {
    includeEmpty: true,
  });

  const existingBusiness = await prisma.business.findFirst({
    // Prefer the exact inactive preview Business. URL fallback keeps records
    // created before the canonical flow compatible.
    where: buildTrialAnchorBusinessWhere({
      userId: args.userId,
      onboardingV2BusinessId: args.quickBusiness.onboardingV2BusinessId,
      websiteUrlCandidates,
    }),
  });

  const placeholderBusiness = await prisma.business.findFirst({
    where: {
      userId: args.userId,
      businessName: "My Business",
      businessWebsiteUrl: "",
    },
  });

  if (placeholderBusiness) {
    await prisma.business.delete({
      where: { id: placeholderBusiness.id },
    });
  }

  const resolvedAgencyId =
    existingBusiness?.agencyId ?? args.agencyAssignment.agencyId;
  const resolvedOwnershipType =
    existingBusiness?.agencyId != null
      ? existingBusiness.ownershipType === "agency_managed"
        ? "agency_managed"
        : "uplift_direct"
      : args.agencyAssignment.ownershipType;

  const tempBusiness = existingBusiness
    ? await prisma.business.update({
        where: { id: existingBusiness.id },
        data: {
          businessName: args.quickBusiness.businessName ?? websiteUrl,
          businessType: args.quickBusiness.businessType ?? "",
          websiteStatus: "trial",
          isActive: true,
          selectedServices,
          servicesPriority,
          detectedServices,
          ...locationUpdateData,
          onboardingFlow: "trial_primary",
          onboardingStatus: "idle",
          onboardingCorrelationId: args.correlationId ?? null,
          agencyId: resolvedAgencyId,
          ownershipType: resolvedOwnershipType,
          onboardedByUserId: existingBusiness.onboardedByUserId ?? args.userId,
        },
      })
    : await prisma.business.create({
        data: {
          userId: args.userId,
          businessName: args.quickBusiness.businessName ?? websiteUrl,
          businessType: args.quickBusiness.businessType ?? "",
          businessWebsiteUrl: websiteUrl,
          businessDescription: "",
          websiteStatus: "trial",
          isPrimary: true,
          isActive: true,
          selectedServices,
          servicesPriority,
          detectedServices,
          ...locationCreateData,
          onboardingFlow: "trial_primary",
          onboardingStatus: "idle",
          onboardingCorrelationId: args.correlationId ?? null,
          agencyId: resolvedAgencyId,
          ownershipType: resolvedOwnershipType,
          onboardedByUserId: args.userId,
        },
      });

  // Bust the GMB profile-proposal cache so the next read regenerates
  // with the new service list. Best-effort — never blocks the write.
  const { gmbAIService } = await import("../services/gmb-ai.service");
  await gmbAIService
    .invalidateProfileProposalCache(tempBusiness.id)
    .catch(() => undefined);

  if (
    args.upsertTrialSubscription &&
    PER_SITE_TRIALS_ENABLED &&
    args.trialStartDate &&
    args.trialEndDate
  ) {
    const agencyPricingConfigId =
      await getActiveAgencyPricingConfigId(resolvedAgencyId);

    await prisma.websiteSubscription.upsert({
      where: { businessId: tempBusiness.id },
      create: {
        businessId: tempBusiness.id,
        status: "trialing",
        trialStartDate: args.trialStartDate,
        trialEndDate: args.trialEndDate,
        trialStatus: "trialing",
        agencyId: resolvedAgencyId,
        agencyPricingConfigId,
      },
      update: {
        status: "trialing",
        trialStartDate: args.trialStartDate,
        trialEndDate: args.trialEndDate,
        trialStatus: "trialing",
        agencyId: resolvedAgencyId,
        agencyPricingConfigId,
      },
    });
  }

  return {
    tempBusiness,
    websiteUrl,
    selectedServices,
    servicesPriority,
    detectedServices,
  };
}

async function rollbackTrialEnrollmentAfterQueueFailure(args: {
  userId: string;
  businessId?: string;
  userBefore: {
    trialStartDate: Date | null;
    trialEndDate: Date | null;
    trialStatus: string | null;
    trialUsed: boolean;
    phone: string | null;
    Subscription: {
      planId: string | null;
      planName: string | null;
      status: string;
      startDate: Date;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
      canceledAt: Date | null;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      stripePriceId: string | null;
      stripeCurrentPeriodEnd: Date | null;
      stripeCancelAtPeriodEnd: boolean;
      stripeStatus: string | null;
      websiteCount: number;
      maxWebsites: number;
    } | null;
  };
}) {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: args.userId },
      data: {
        trialStartDate: args.userBefore.trialStartDate,
        trialEndDate: args.userBefore.trialEndDate,
        trialStatus: args.userBefore.trialStatus,
        trialUsed: args.userBefore.trialUsed,
        phone: args.userBefore.phone,
      },
    });

    if (args.userBefore.Subscription) {
      await tx.subscription.update({
        where: { userId: args.userId },
        data: {
          planId: args.userBefore.Subscription.planId,
          planName: args.userBefore.Subscription.planName,
          status: args.userBefore.Subscription.status,
          startDate: args.userBefore.Subscription.startDate,
          currentPeriodEnd: args.userBefore.Subscription.currentPeriodEnd,
          cancelAtPeriodEnd: args.userBefore.Subscription.cancelAtPeriodEnd,
          canceledAt: args.userBefore.Subscription.canceledAt,
          stripeCustomerId: args.userBefore.Subscription.stripeCustomerId,
          stripeSubscriptionId: args.userBefore.Subscription.stripeSubscriptionId,
          stripePriceId: args.userBefore.Subscription.stripePriceId,
          stripeCurrentPeriodEnd:
            args.userBefore.Subscription.stripeCurrentPeriodEnd,
          stripeCancelAtPeriodEnd:
            args.userBefore.Subscription.stripeCancelAtPeriodEnd,
          stripeStatus: args.userBefore.Subscription.stripeStatus,
          websiteCount: args.userBefore.Subscription.websiteCount,
          maxWebsites: args.userBefore.Subscription.maxWebsites,
        },
      });
    } else {
      await tx.subscription.deleteMany({
        where: {
          userId: args.userId,
          status: "trialing",
          stripeSubscriptionId: null,
        },
      });
    }

    if (args.businessId) {
      await tx.websiteSubscription.deleteMany({
        where: {
          businessId: args.businessId,
          status: "trialing",
          stripeSubscriptionId: null,
        },
      });
    }
  });
}

export async function enrollInTrial(req: AuthenticatedRequest, res: Response) {
  let rollbackContext: Parameters<
    typeof rollbackTrialEnrollmentAfterQueueFailure
  >[0] | null = null;

  try {
    const body = req.body;
    const payload = ENROLL_TRIAL.parse(body);
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
      return sendError(
        res,
        "Quick scrape business not found or does not belong to you",
        403,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { Subscription: true },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (user.trialUsed) {
      return sendError(
        res,
        "Trial already used. Please subscribe to continue.",
        400,
      );
    }

    if (user.Subscription && user.Subscription.status === "active") {
      return sendError(res, "You already have an active subscription", 400);
    }

    if (
      user.trialStatus === "active" &&
      user.trialEndDate &&
      user.trialEndDate > new Date()
    ) {
      return sendSuccess(
        res,
        {
          trialStartDate: user.trialStartDate,
          trialEndDate: user.trialEndDate,
          trialStatus: user.trialStatus,
          daysLeft: Math.ceil(
            (user.trialEndDate.getTime() - new Date().getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        },
        "Trial already active",
      );
    }

    const trialStartDate = new Date();
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 7);
    const correlationId = getRequestCorrelationId(req);
    const detailsUpdate = buildQuickBusinessDetailsUpdate(
      payload.businessDetails,
      payload.phone,
    );
    const confirmedQuickBusiness =
      Object.keys(detailsUpdate).length > 0
        ? await prisma.quickScrapeBusiness.update({
            where: { id: quickBusiness.id },
            data: detailsUpdate,
          })
        : quickBusiness;
    const confirmedPhone =
      confirmedQuickBusiness.businessPhone?.trim() || payload.phone;

    rollbackContext = {
      userId,
      userBefore: user,
    };

    const updatedUser = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: {
          trialStartDate,
          trialEndDate,
          trialStatus: "active",
          trialUsed: true,
          phone: confirmedPhone,
        },
      });

      const existingSubscription = await tx.subscription.findUnique({
        where: { userId },
      });

      if (!existingSubscription) {
        await tx.subscription.create({
          data: {
            userId,
            status: "trialing",
            stripeStatus: "trialing",
            planName: "Uplift Trial",
            websiteCount: 0,
            maxWebsites: 1,
            startDate: trialStartDate,
            currentPeriodEnd: trialEndDate,
          },
        });
      }

      return u;
    });

    if (confirmedQuickBusiness) {
      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);
      const {
        tempBusiness,
        websiteUrl,
        selectedServices,
        servicesPriority,
        detectedServices,
      } = await upsertTrialAnchorBusiness({
        userId,
        quickBusiness: confirmedQuickBusiness,
        agencyAssignment,
        correlationId,
        trialStartDate,
        trialEndDate,
        upsertTrialSubscription: true,
      });
      rollbackContext.businessId = tempBusiness.id;

      await runBestEffortGeoSetup({
        businessId: tempBusiness.id,
        quickBusiness: confirmedQuickBusiness,
        timeoutMs: 1500,
      });

      console.log(
        `🔄 [Trial] Trial persisted for user ${userId}, quickScrapeBusinessId: ${confirmedQuickBusiness.id}, businessId: ${tempBusiness.id}`,
      );

      const alreadyCompleted = await prisma.business.findFirst({
        where: {
          userId,
          businessWebsiteUrl: websiteUrl,
          isActive: true,
          websiteStatus: "active",
        },
        include: { websiteAnalysis: { select: { id: true } } },
      });
      if (alreadyCompleted?.websiteAnalysis) {
        console.log(
          `⏭️ [Trial] Existing completed onboarding detected for user ${userId}, queueing sync-only pass for quickScrapeBusinessId: ${quickBusiness.id}`,
        );
      }

      try {
        await executeTrialOnboardingHandoff(
          {
            selectedService: selectedServices[0] ?? null,
            previewBlogId: confirmedQuickBusiness.onboardingV2BlogId,
            hasOnboardingV2State: Boolean(
              confirmedQuickBusiness.onboardingV2LastSeenAt,
            ),
            allowQuickBlog: true,
          },
          {
            queueFullOnboarding: () =>
              queueTrialPrimaryOnboarding({
                userId,
                businessId: tempBusiness.id,
                websiteUrl,
                selectedServices,
                servicesPriority,
                detectedServices,
                quickScrapeBusinessId: confirmedQuickBusiness.id,
                correlationId,
              }),
            queueQuickBlog: async () => {
              await inngest.send({
                name: "trial/quick-blog",
                data: {
                  userId,
                  businessId: tempBusiness.id,
                  selectedService: selectedServices[0],
                },
              });
            },
            recordOnboardingV2Handoff: async () => {
              await prisma.quickScrapeBusiness.update({
                where: { id: confirmedQuickBusiness.id },
                data: {
                  onboardingV2Status: "preview_ready",
                  onboardingV2Step: "preview",
                  onboardingV2CompletedAt: null,
                  onboardingV2LastSeenAt: new Date(),
                },
              });
            },
            onQuickBlogError: (error) => {
              console.error(
                "❌ [Trial] Failed to trigger quick blog generation:",
                error,
              );
            },
            onStateHandoffError: (error) => {
              console.error(
                "⚠️ [Trial] Full onboarding queued, but onboarding-v2 handoff state could not be recorded:",
                error,
              );
            },
          },
        );
      } catch (queueError) {
        await markBusinessOnboardingFailed(prisma, {
          businessId: tempBusiness.id,
          correlationId,
          error: serializeOnboardingError(queueError, "queue_onboarding"),
        });
        await rollbackTrialEnrollmentAfterQueueFailure({
          userId,
          businessId: tempBusiness.id,
          userBefore: user,
        }).catch((rollbackError) => {
          console.error(
            `❌ [Trial] Failed to roll back trial activation after queue failure for user ${userId}:`,
            rollbackError,
          );
        });
        rollbackContext = null;
        console.error(
          `❌ [Trial] Complete onboarding event was not queued for user ${userId}, quickScrapeBusinessId: ${confirmedQuickBusiness.id}:`,
          queueError,
        );
        return sendError(
          res,
          "Failed to start onboarding process. Please try again.",
          500,
          queueError,
        );
      }

      logOnboardingStage(req, {
        stage: "complete_onboarding_queued",
        userId,
        businessId: tempBusiness.id,
        quickScrapeBusinessId: confirmedQuickBusiness.id,
        websiteUrl,
      });
    } else {
      console.warn(
        `⚠️ No quick scrape business found for trial user ${userId}, skipping onboarding analysis`,
      );
    }

    try {
      await inngest.send({
        name: "trial/started",
        data: {
          userId,
          trialEndDate: trialEndDate.toISOString(),
        },
      });
    } catch (inngestError) {
      console.error("Failed to send trial started event:", inngestError);
      // Don't fail the request if Inngest fails
    }

    const userEmail = updatedUser.email ?? "";
    const userName = (updatedUser.name ?? updatedUser.email?.split("@")[0]) ?? "";
    const businessServices = confirmedQuickBusiness
      ? resolveQuickBusinessServiceSelection(confirmedQuickBusiness).selectedServices
      : [];
    const businessType = confirmedQuickBusiness?.businessType || "";
    const businessName = confirmedQuickBusiness?.businessName || "";
    const businessCity = confirmedQuickBusiness?.businessCity || "";
    const businessCountry = confirmedQuickBusiness?.businessCountry || "";
    const isAdmin = isPlatformStaffSubscriptionBypassRole(updatedUser.role);

    if (!isAdmin) {
      setImmediate(async () => {
        try {
          await sendWelcomeEmail(userEmail, userName, trialEndDate);
          console.log(`✅ Welcome email sent to ${userEmail}`);

        if (businessServices.length > 0 && userId) {
          try {
            const quickKeywords = await fetchQuickKeywordsForTrial(
              businessServices,
              businessType,
              businessCity,
              businessCountry,
            );

            if (quickKeywords.length > 0) {
              await sendTopKeywordsEmail(
                userEmail,
                userName,
                businessName || "Your Business",
                quickKeywords,
              );
              console.log(
                `✅ Top keywords email sent to ${userEmail} with ${quickKeywords.length} keywords`,
              );
              TrialAnalyticsService.trackEmailSent(
                userId,
                "topKeywords",
              );
            } else {
              console.warn(
                `⚠️ No keywords found for ${userEmail}, skipping keywords email`,
              );
            }
          } catch (keywordError) {
            console.error(
              `❌ Failed to send keywords email to ${userEmail}:`,
              keywordError,
            );
          }
        }
      } catch (error) {
        console.error(
          `❌ Failed to send welcome email to ${userEmail}:`,
          error,
        );
      }
    });
    } else {
      console.log(`ℹ️ Skipping trial emails for admin user ${userEmail}`);
    }

    logOnboardingStage(req, {
      stage: "trial_enrolled",
      userId,
      businessId: confirmedQuickBusiness?.id,
      quickScrapeBusinessId: confirmedQuickBusiness?.id,
    });

    console.log(
      `✅ Trial enrolled for user ${userId}, expires: ${trialEndDate.toISOString()}`,
    );

    setImmediate(() => {
      const abTestVariant = req.body.abTestVariant || "control";
      const abTestGroup = req.body.abTestGroup || "trial_modal_v1";
      TrialAnalyticsService.trackTrialEnrolled(
        userId,
        abTestVariant,
        abTestGroup,
      );
      TrialAnalyticsService.trackEmailSent(userId, "welcome");
    });

    return sendSuccess(
      res,
      {
        trialStartDate: updatedUser.trialStartDate,
        trialEndDate: updatedUser.trialEndDate,
        trialStatus: updatedUser.trialStatus,
        daysLeft: 7,
        onboardingStatus: confirmedQuickBusiness ? "queued" : "skipped",
      },
      "Trial enrolled successfully",
    );
  } catch (error) {
    if (rollbackContext) {
      await rollbackTrialEnrollmentAfterQueueFailure(rollbackContext).catch(
        (rollbackError) => {
          console.error(
            `❌ [Trial] Failed to roll back trial activation after enroll failure for user ${rollbackContext?.userId}:`,
            rollbackError,
          );
        },
      );
    }

    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error enrolling in trial:", error);
    return sendError(res, "Failed to enroll in trial", 500, error);
  }
}

export async function triggerCompleteOnboardingAfterPayment(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const body = req.body;
    const payload = TRIGGER_COMPLETE_ONBOARDING.parse(body);
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
      return sendError(
        res,
        "Quick scrape business not found or does not belong to you",
        403,
      );
    }

    const detailsUpdate = buildQuickBusinessDetailsUpdate(
      payload.businessDetails,
    );
    const confirmedQuickBusiness =
      Object.keys(detailsUpdate).length > 0
        ? await prisma.quickScrapeBusiness.update({
            where: { id: quickBusiness.id },
            data: detailsUpdate,
          })
        : quickBusiness;

    const websiteUrl = normalizeWebsiteUrl(confirmedQuickBusiness.businessWebsiteUrl);
    const websiteUrlCandidates = getEquivalentWebsiteUrls(websiteUrl);
    const {
      selectedServices,
      servicesPriority,
      detectedServices,
    } = resolveQuickBusinessServiceSelection(confirmedQuickBusiness);

    const [entitlementUser, entitlementBusiness] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          role: true,
          Subscription: {
            select: {
              status: true,
              stripeSubscriptionId: true,
            },
          },
        },
      }),
      prisma.business.findFirst({
        where: buildTrialAnchorBusinessWhere({
          userId,
          onboardingV2BusinessId: confirmedQuickBusiness.onboardingV2BusinessId,
          websiteUrlCandidates,
        }),
        select: {
          websiteSubscription: {
            select: {
              status: true,
              stripeSubscriptionId: true,
              planTier: true,
            },
          },
        },
      }),
    ]);
    const isPlatformStaff = entitlementUser
      ? isPlatformStaffSubscriptionBypassRole(entitlementUser.role)
      : false;
    if (
      !hasVerifiedOnboardingEntitlement({
        accountStripeSubscriptionId:
          entitlementUser?.Subscription?.stripeSubscriptionId,
        accountSubscriptionStatus: entitlementUser?.Subscription?.status,
        isPlatformStaff,
        websiteStripeSubscriptionId:
          entitlementBusiness?.websiteSubscription?.stripeSubscriptionId,
        websiteSubscriptionStatus:
          entitlementBusiness?.websiteSubscription?.status,
      })
    ) {
      logOnboardingAlert("payment_entitlement_rejected", {
        userId,
        businessId: confirmedQuickBusiness.id,
        correlationId:
          "correlationId" in req
            ? (req as { correlationId?: string }).correlationId
            : undefined,
        message: "Verified Stripe entitlement is required",
      });
      return sendError(
        res,
        "Complete secure checkout before starting onboarding",
        402,
      );
    }

    const alreadyCompleted = await prisma.business.findFirst({
      where: {
        userId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
        isActive: true,
        websiteStatus: { in: ["active", "trial"] },
      },
      include: {
        websiteAnalysis: { select: { id: true } },
        websiteSubscription: { select: { id: true } },
      },
    });
    if (
      alreadyCompleted?.websiteAnalysis &&
      (alreadyCompleted.websiteStatus === "trial" ||
        alreadyCompleted.websiteSubscription != null)
    ) {
      console.log(
        `⏭️ [Trial] Existing completed onboarding detected for user ${userId}, queueing sync-only pass for quickScrapeBusinessId: ${confirmedQuickBusiness.id}`,
      );
    }

    const correlationId = getRequestCorrelationId(req);
    const agencyAssignment = await resolveAgencyAssignmentForRequest(req);
    const { tempBusiness } = await upsertTrialAnchorBusiness({
      userId,
      quickBusiness: confirmedQuickBusiness,
      agencyAssignment,
      correlationId,
      upsertTrialSubscription: false,
    });
    await runBestEffortGeoSetup({
      businessId: tempBusiness.id,
      quickBusiness: confirmedQuickBusiness,
      timeoutMs: 1500,
    });

    try {
      await executeTrialOnboardingHandoff(
        {
          selectedService: selectedServices[0] ?? null,
          previewBlogId: confirmedQuickBusiness.onboardingV2BlogId,
          hasOnboardingV2State: Boolean(
            confirmedQuickBusiness.onboardingV2LastSeenAt,
          ),
          allowQuickBlog: false,
        },
        {
          queueFullOnboarding: () =>
            queueTrialPrimaryOnboarding({
              userId,
              businessId: tempBusiness.id,
              websiteUrl,
              selectedServices,
              servicesPriority,
              detectedServices,
              quickScrapeBusinessId: confirmedQuickBusiness.id,
              planTier:
                entitlementBusiness?.websiteSubscription?.planTier ??
                confirmedQuickBusiness.onboardingV2SelectedPlanTier ??
                "SEO",
              correlationId,
            }),
          queueQuickBlog: async () => undefined,
          recordOnboardingV2Handoff: async () => {
            await prisma.quickScrapeBusiness.update({
              where: { id: confirmedQuickBusiness.id },
              data: {
                onboardingV2Status: "preview_ready",
                onboardingV2Step: "preview",
                onboardingV2CompletedAt: null,
                onboardingV2LastSeenAt: new Date(),
              },
            });
          },
          onStateHandoffError: (error) => {
            console.error(
              "⚠️ [Trial] Paid onboarding queued, but onboarding-v2 handoff state could not be recorded:",
              error,
            );
          },
        },
      );
    } catch (queueError) {
      await markBusinessOnboardingFailed(prisma, {
        businessId: tempBusiness.id,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_onboarding"),
      });
      console.error(
        `❌ [Trial] Complete onboarding event was not queued for user ${userId}, quickScrapeBusinessId: ${confirmedQuickBusiness.id}:`,
        queueError,
      );
      return sendError(
        res,
        "Failed to start onboarding process. Please try again.",
        500,
        queueError,
      );
    }

    logOnboardingStage(req, {
      stage: "complete_onboarding_queued",
      userId,
      businessId: tempBusiness.id,
      quickScrapeBusinessId: confirmedQuickBusiness.id,
      websiteUrl,
    });
    console.log(
      `✅ [Trial] Complete onboarding triggered after payment for user ${userId}, quickScrapeBusinessId: ${confirmedQuickBusiness.id}`,
    );

    return sendSuccess(
      res,
      {
        triggered: true,
        websiteUrl,
        businessId: tempBusiness.id,
        onboardingStatus: "queued",
      },
      "Complete onboarding started in background",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error triggering complete onboarding after payment:", error);
    return sendError(res, "Failed to trigger complete onboarding", 500, error);
  }
}

export async function checkTrialStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const body = req.body;
    CHECK_TRIAL_STATUS.parse(body);
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        Subscription: true,
        business: { where: { isActive: true }, include: { websiteSubscription: true } },
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    return sendSuccess(res, resolveDashboardAccessFromUser(user));
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Error checking trial status:", error);
    return sendError(res, "Failed to check trial status", 500, error);
  }
}

export async function getQuickKeywordsForTrial(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    if (!quickBusiness || (quickBusiness.selectedServices?.length ?? 0) === 0) {
      return sendSuccess(res, {
        keywords: [],
        businessName: quickBusiness?.businessName ?? "",
      });
    }

    const { selectedServices: businessServices } =
      resolveQuickBusinessServiceSelection(quickBusiness);
    const businessType = quickBusiness.businessType ?? "";

    const quickKeywords = await fetchQuickKeywordsForTrial(
      businessServices,
      businessType,
      undefined,
      undefined,
    );

    const topFive = quickKeywords.slice(0, 5).map((kw) => ({
      keyword: kw.keyword,
      searchVolume: kw.searchVolume ?? "N/A",
      difficulty: kw.difficulty ?? "N/A",
      currentRanking: kw.currentRanking ?? "Not ranked",
      expectedRanking: kw.expectedRanking ?? "5-15",
    }));

    return sendSuccess(res, {
      keywords: topFive,
      businessName: quickBusiness.businessName ?? "",
    });
  } catch (error) {
    console.error("Error getting quick keywords for trial:", error);
    return sendError(res, "Failed to get quick keywords for trial", 500, error);
  }
}

export async function getTopKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const business = await prisma.business.findFirst({
      where: {
        userId: userId,
        isActive: true,
      },
      orderBy: {
        isPrimary: "desc",
      },
    });

    if (!business) {
      return sendSuccess(res, { keywords: [] }, "No business found");
    }

    const topKeywords = await prisma.plan.findMany({
      where: {
        userId: userId,
        businessId: business.id,
        deletedAt: null,
      },
      orderBy: [{ keywordMonthlySearches: "desc" }, { createdAt: "asc" }],
      take: 5,
      select: {
        id: true,
        keyword: true,
        keywordSearchVolume: true,
        keywordDiffculty: true,
        keywordMonthlySearches: true,
      },
    });

    return sendSuccess(res, {
      keywords: topKeywords.map((kw) => ({
        id: kw.id,
        keyword: kw.keyword,
        searchVolume: kw.keywordSearchVolume || "N/A",
        difficulty: kw.keywordDiffculty || "N/A",
        monthlySearches: kw.keywordMonthlySearches || 0,
      })),
      businessName: business.businessName || "",
    });
  } catch (error) {
    console.error("Error getting top keywords:", error);
    return sendError(res, "Failed to get top keywords", 500, error);
  }
}

export async function testSendTopKeywordsEmail(req: AuthenticatedRequest, res: Response) {
  try {
    if (process.env.NODE_ENV !== "development") {
      return res.status(404).json({ success: false, error: "Not available" });
    }

    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user || !user.email) {
      return sendError(res, "User not found or has no email", 404);
    }

    const business = await prisma.business.findFirst({
      where: { userId, isActive: true },
      orderBy: { isPrimary: "desc" },
    });
    if (!business) {
      return sendError(res, "No business found for user", 400);
    }

    const topKeywords = await prisma.plan.findMany({
      where: {
        userId,
        businessId: business.id,
        deletedAt: null,
      },
      orderBy: [{ keywordMonthlySearches: "desc" }, { createdAt: "asc" }],
      take: 5,
      select: {
        keyword: true,
        keywordSearchVolume: true,
        keywordDiffculty: true,
      },
    });

    if (topKeywords.length === 0) {
      return sendError(res, "No keywords found for this business", 400);
    }

    const keywordsWithRankings = await predictRankingsForKeywords(
      topKeywords.map((kw) => ({
        keyword: kw.keyword,
        searchVolume: kw.keywordSearchVolume ?? "N/A",
        difficulty: kw.keywordDiffculty ?? "N/A",
      })),
      business.businessName ?? "your business",
    );

    await sendTopKeywordsEmail(
      user.email,
      user.name ?? "there",
      business.businessName ?? "your business",
      keywordsWithRankings.map((kw) => ({
        keyword: kw.keyword,
        searchVolume: kw.searchVolume,
        difficulty: kw.difficulty,
        currentRanking: kw.currentRanking,
        expectedRanking: kw.expectedRanking,
      })),
    );

    return sendSuccess(
      res,
      { sentTo: user.email, keywordCount: keywordsWithRankings.length },
      "Top keywords email sent",
    );
  } catch (error) {
    console.error("testSendTopKeywordsEmail error:", error);
    return sendError(res, "Failed to send test email", 500, error);
  }
}

export async function startQuickKeywords(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };

    let targetBusiness: { id: string; businessWebsiteUrl: string; websiteStatus: string | null } | null = null;

    if (businessId) {
      targetBusiness = await prisma.business.findFirst({
        where: { id: businessId, userId, isActive: true },
        select: { id: true, businessWebsiteUrl: true, websiteStatus: true },
      });
    } else {
      targetBusiness = await prisma.business.findFirst({
        where: { userId, isPrimary: true, isActive: true },
        select: { id: true, businessWebsiteUrl: true, websiteStatus: true },
      });

      if (!targetBusiness) {
        targetBusiness = await prisma.business.findFirst({
          where: { userId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true, businessWebsiteUrl: true, websiteStatus: true },
        });
      }
    }

    if (!targetBusiness && businessId) {
      const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
        where: { id: businessId, userId },
        select: { id: true },
      });

      if (quickBusiness) {
        return sendSuccess(
          res,
          {
            started: false,
            businessId: quickBusiness.id,
            reason:
              "Quick onboarding keywords stay in preview mode until trial or full onboarding creates your business profile.",
          },
          "Quick keyword preview is available before onboarding is completed",
        );
      }
    }

    if (!targetBusiness) {
      return sendError(res, "No active business found", 404);
    }

    const existingKeywords = await prisma.plan.count({
      where: { userId, businessId: targetBusiness.id, deletedAt: null },
    });

    if (existingKeywords > 0) {
      return sendSuccess(
        res,
        { started: false, businessId: targetBusiness.id, reason: "Keywords already exist" },
        "Keywords already generated for this business",
      );
    }

    await prisma.business.update({
      where: { id: targetBusiness.id },
      data: {
        keywordGenerationStatus: "pending",
        keywordGenerationStartedAt: null,
        keywordGenerationCompletedAt: null,
      },
    });

    await inngest.send({
      name: "keywords/generate",
      data: { userId, businessId: targetBusiness.id },
    });

    console.log(
      `✅ [Trial] Quick keywords generation started for user ${userId}, business ${targetBusiness.id}`,
    );

    return sendSuccess(
      res,
      { started: true, businessId: targetBusiness.id },
      "Keywords generation started",
    );
  } catch (error) {
    console.error("Error starting quick keywords generation:", error);
    return sendError(res, "Failed to start keywords generation", 500, error);
  }
}

export async function testQuickKeywordsForAllBusinessTypes(
  req: AuthenticatedRequest,
  res: Response,
) {
  if (process.env.NODE_ENV !== "development") {
    return sendError(res, "Only available in development mode", 403);
  }

  try {
    const testBusinesses = [
      {
        businessType: "Web Design Agency",
        services: ["Web Design", "Custom Software Development", "UI/UX Design"],
        businessCity: "Toronto",
        businessCountry: "Canada",
      },
      {
        businessType: "Restaurant",
        services: ["Catering", "Event Hosting", "Mediterranean Cuisine"],
        businessCity: "New York",
        businessCountry: "USA",
      },
      {
        businessType: "Law Firm",
        services: ["Personal Injury Law", "Family Law", "Estate Planning"],
        businessCity: "Los Angeles",
        businessCountry: "USA",
      },
      {
        businessType: "Dental Clinic",
        services: ["General Dentistry", "Cosmetic Dentistry", "Orthodontics"],
        businessCity: "Vancouver",
        businessCountry: "Canada",
      },
      {
        businessType: "Real Estate Agency",
        services: [
          "Residential Sales",
          "Commercial Leasing",
          "Property Management",
        ],
        businessCity: "Miami",
        businessCountry: "USA",
      },
      {
        businessType: "SaaS Company",
        services: [
          "Project Management Software",
          "Team Collaboration",
          "Analytics",
        ],
        businessCity: undefined,
        businessCountry: undefined,
      },
      {
        businessType: "E-commerce Store",
        services: [
          "Athletic Wear",
          "Fitness Equipment",
          "Nutrition Supplements",
        ],
        businessCity: undefined,
        businessCountry: undefined,
      },
    ];

    console.log(
      `🧪 [Test] Testing AI-first keyword generation for ${testBusinesses.length} business types...`,
    );

    const results = [];

    for (const testBiz of testBusinesses) {
      console.log(
        `\n🔍 Testing: ${testBiz.businessType} (${testBiz.businessCity || "Online"})`,
      );

      const keywords = await fetchQuickKeywordsForTrial(
        testBiz.services,
        testBiz.businessType,
        testBiz.businessCity,
        testBiz.businessCountry,
      );

      results.push({
        businessType: testBiz.businessType,
        services: testBiz.services,
        location: testBiz.businessCity
          ? `${testBiz.businessCity}, ${testBiz.businessCountry}`
          : "Online/Global",
        keywords: keywords.map((kw) => ({
          keyword: kw.keyword,
          searchVolume: kw.searchVolume,
          difficulty: kw.difficulty,
          expectedRanking: kw.expectedRanking,
        })),
      });

      console.log(
        `✅ Generated ${keywords.length} keywords for ${testBiz.businessType}`,
      );
    }

    return sendSuccess(
      res,
      { results, totalTested: testBusinesses.length },
      "AI-first keyword generation tested successfully",
    );
  } catch (error) {
    console.error("testQuickKeywordsForAllBusinessTypes error:", error);
    return sendError(res, "Failed to run test", 500, error);
  }
}
