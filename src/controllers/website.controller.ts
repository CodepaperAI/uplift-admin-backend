import type { Request, Response } from "express";
import Stripe from "stripe";
import { z } from "zod";

import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";
import { inngest } from "../inngest/client";
import { searchPlaceCandidates } from "../services/business-geo-profile.service";
import {
  isBlockedAdultWebsiteUrl,
  UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE,
} from "../utils/adult-domain-blocklist.utils";
import {
  markBusinessOnboardingAwaitingConfirmation,
  markBusinessOnboardingFailed,
  markBusinessOnboardingQueued,
  serializeOnboardingError,
} from "../services/onboarding-state.service";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { compensateWebsiteOnboardFailure } from "../utils/website-onboard-compensation";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import {
  getActiveAgencyPricingConfigId,
  resolveAgencyAssignmentForRequest,
} from "../utils/agency-context.utils";
import { resolveSubscriptionPrice } from "../services/agency-pricing.service";
import {
  requestWebsiteRemoval,
  restoreWebsite as restoreRemovedWebsite,
  retryWebsiteRemoval as retryPendingWebsiteRemoval,
  serializeWebsiteRemovalLifecycle,
  WebsiteRemovalError,
} from "../services/website-removal.service";
import { CONFIRM_SECONDARY_DETAILS } from "../validators/quick-scrape.validation";
import { resolveWebsiteWorkspaceAccess } from "../utils/website-workspace-access.utils";
import { lockPrimaryWorkspaceSelection } from "../services/primary-workspace-reconciliation.service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
});

const CREATE_WEBSITE_SCHEMA = z
  .object({
    websiteUrl: z.string().url(),
    businessName: z.string().optional(),
  })
  .strict();

const UPDATE_WEBSITE_SCHEMA = z.object({
  businessId: z.string(),
  businessName: z.string().optional(),
  businessWebsiteUrl: z.string().url().optional(),
  isPrimary: z.boolean().optional(),
});

const WEBSITE_LIFECYCLE_SCHEMA = z
  .object({ businessId: z.string().uuid() })
  .strict();

const NORMALIZE_WEBSITE_URL = z.string().transform((url) => normalizeWebsiteUrl(url));

function rejectUnsupportedWebsiteUrl(res: Response, websiteUrl: string) {
  if (!isBlockedAdultWebsiteUrl(websiteUrl)) {
    return null;
  }

  return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
    code: "UNSUPPORTED_WEBSITE_CATEGORY",
  });
}

function getBillingIntervalFromPriceId(
  priceId: string | null | undefined,
): "monthly" | "yearly" {
  const yearlyPriceIds = new Set(
    [
      process.env.UPLIFT_YEARLY_PRICE_ID,
      process.env.WEBSITE_YEARLY_PRICE_ID,
    ].filter((value): value is string => Boolean(value)),
  );

  return priceId && yearlyPriceIds.has(priceId) ? "yearly" : "monthly";
}

function getRequestCorrelationId(
  req: Request | AuthenticatedRequest,
): string | undefined {
  if (
    "correlationId" in req &&
    typeof (req as { correlationId?: unknown }).correlationId === "string"
  ) {
    return (req as { correlationId: string }).correlationId;
  }

  return undefined;
}

export async function queueWebsiteOnboardingEvent(input: {
  businessId: string;
  userId: string;
  websiteUrl: string;
  correlationId?: string;
}) {
  const ids = await inngest.send({
    name: "website/onboard",
    data: {
      userId: input.userId,
      businessId: input.businessId,
      websiteUrl: input.websiteUrl,
      correlationId: input.correlationId,
    },
  });

  if (!ids?.ids?.length) {
    throw new Error("Failed to queue website onboarding");
  }

  await markBusinessOnboardingQueued(prisma, {
    businessId: input.businessId,
    flow: "website_secondary",
    correlationId: input.correlationId,
  });
}

export async function ensureSecondaryOnboardingV2Initialized(input: {
  businessId: string;
  correlationId?: string;
}) {
  const now = new Date();
  const state = await prisma.$transaction(async (tx) => {
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      include: { websiteSubscription: { select: { status: true } } },
    });
    if (!business || business.onboardingFlow !== "website_secondary") {
      throw new Error("Secondary website was not found");
    }
    if (
      !business.websiteSubscription ||
      !["active", "trialing"].includes(business.websiteSubscription.status)
    ) {
      throw new Error("Secondary website subscription is not active");
    }

    const candidates = getEquivalentWebsiteUrls(business.businessWebsiteUrl);
    let quickBusiness = await tx.quickScrapeBusiness.findFirst({
      where: {
        userId: business.userId,
        OR: [
          { onboardingV2BusinessId: business.id },
          { businessWebsiteUrl: { in: candidates } },
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
    if (
      quickBusiness &&
      quickBusiness.onboardingV2Flow !== "website_secondary"
    ) {
      throw new Error("Website is linked to another onboarding flow");
    }

    if (!quickBusiness) {
      const detectedServices = Array.isArray(business.detectedServices)
        ? business.detectedServices.filter(
            (service): service is string => typeof service === "string",
          )
        : [];
      quickBusiness = await tx.quickScrapeBusiness.create({
        data: {
          userId: business.userId,
          businessName: business.businessName || business.businessWebsiteUrl,
          businessType: business.businessType || "General",
          businessWebsiteUrl: business.businessWebsiteUrl,
          detectedServices,
          selectedServices: business.selectedServices,
          servicesPriority: business.servicesPriority ?? {},
          businessAddress: business.businessAddress,
          businessCity: business.businessCity,
          businessState: business.businessState,
          businessCountry: business.businessCountry,
          businessPhone: business.businessPhone,
          serviceArea: business.serviceArea,
          serviceAreaLocations: business.serviceAreaLocations,
          businessDescription: business.businessDescription,
          targetAudience: business.targetAudience,
          onboardingV2Flow: "website_secondary",
          onboardingV2Step: "website",
          onboardingV2Status: "in_progress",
          onboardingV2LastSeenAt: now,
          onboardingV2BusinessId: business.id,
        },
      });
    } else if (quickBusiness.onboardingV2BusinessId !== business.id) {
      quickBusiness = await tx.quickScrapeBusiness.update({
        where: { id: quickBusiness.id },
        data: {
          onboardingV2BusinessId: business.id,
          onboardingV2Flow: "website_secondary",
          onboardingV2LastSeenAt: now,
        },
      });
    }

    await tx.business.update({
      where: { id: business.id },
      data: {
        isPrimary: false,
        isActive: false,
        websiteStatus: "pending",
        onboardingFlow: "website_secondary",
        onboardingStatus: "awaiting_confirmation",
        onboardingLastAttemptAt: now,
        onboardingCorrelationId: input.correlationId ?? null,
      },
    });

    return {
      business,
      quickBusiness,
      scanRequired: quickBusiness.detectedServices.length === 0,
    };
  });

  if (state.scanRequired) {
    const queued = await inngest.send({
      id: `website-secondary-onboarding-v2-initialize:${state.business.id}:${state.quickBusiness.id}`,
      name: "website-secondary/onboarding-v2.initialize",
      data: {
        userId: state.business.userId,
        businessId: state.business.id,
        quickScrapeBusinessId: state.quickBusiness.id,
        correlationId: input.correlationId ?? null,
      },
    });
    if (!queued?.ids?.length) {
      throw new Error("Failed to queue secondary onboarding-v2 initialization");
    }
  }

  return {
    alreadyQueued: !state.scanRequired,
    businessId: state.business.id,
    quickScrapeBusinessId: state.quickBusiness.id,
    resumePath: `/dashboard/websites/onboarding/${state.quickBusiness.id}`,
  };
}

async function queueWebsiteFinalizeEvent(input: {
  businessId: string;
  userId: string;
  websiteUrl: string;
  correlationId?: string;
}) {
  const ids = await inngest.send({
    name: "website/finalize-secondary",
    data: {
      userId: input.userId,
      businessId: input.businessId,
      websiteUrl: input.websiteUrl,
      correlationId: input.correlationId,
    },
  });

  if (!ids?.ids?.length) {
    throw new Error("Failed to queue website finalization");
  }

  await markBusinessOnboardingQueued(prisma, {
    businessId: input.businessId,
    flow: "website_secondary",
    correlationId: input.correlationId,
  });
}

async function queueTrialPrimaryOnboardingEvent(input: {
  businessId: string;
  userId: string;
  websiteUrl: string;
  selectedServices?: unknown;
  servicesPriority?: unknown;
  detectedServices?: unknown;
  quickScrapeBusinessId?: string | null;
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

export async function createWebsite(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = CREATE_WEBSITE_SCHEMA.parse(body);
    const userId = authUserId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        Subscription: true,
        business: {
          where: { isActive: true },
        },
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    const normalizedUrl = NORMALIZE_WEBSITE_URL.parse(payload.websiteUrl);
    const unsupportedResponse = rejectUnsupportedWebsiteUrl(res, normalizedUrl);
    if (unsupportedResponse) {
      return unsupportedResponse;
    }

    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);
    const correlationId = getRequestCorrelationId(req);

    const existingWebsite = await prisma.business.findFirst({
      where: {
        userId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
        isActive: true,
      },
    });

    if (existingWebsite) {
      return sendError(res, "Website already exists for this user", 400);
    }

    // Calculate active websites count (needed for isFirstWebsite check)
    const activeWebsites = user.business.filter((b) => b.isActive).length;

    // Get subscription reference (needed for later updates)
    const subscription = user.Subscription;

    // Check for active subscription and website limits
    // Can be disabled via SKIP_SUBSCRIPTION_CHECK=true in .env for testing
    const skipSubscriptionCheck =
      process.env.SKIP_SUBSCRIPTION_CHECK === "true";

    if (!skipSubscriptionCheck) {
      const hasAccountSub =
        subscription &&
        (subscription.status === "active" || subscription.status === "trialing");

      let hasWebsiteLevelAccess = false;
      if (!hasAccountSub) {
        const now = new Date();
        const wsRecords = await prisma.websiteSubscription.findMany({
          where: {
            business: { userId, isActive: true },
          },
        });
        hasWebsiteLevelAccess = wsRecords.some(
          (ws) =>
            ws.status === "active" ||
            (ws.trialStatus === "trialing" && ws.trialEndDate && ws.trialEndDate > now),
        );
      }

      if (!hasAccountSub && !hasWebsiteLevelAccess) {
        console.log(
          `[createWebsite] SUBSCRIPTION_REQUIRED userId=${userId} (no active subscription or website trial)`,
        );
        return res.status(402).json({
          success: false,
          error: "SUBSCRIPTION_REQUIRED",
          message:
            "An active subscription is required to add a website. Please subscribe to continue.",
          canAddTrialSecondary: true,
          canBuySecondary: false,
        });
      }

      const maxWebsites: number = subscription?.maxWebsites ?? 1;
      if (activeWebsites >= maxWebsites) {
        const isTrialUser = subscription ? subscription.status === "trialing" : hasWebsiteLevelAccess;
        const isPaidUser =
          subscription
            ? subscription.status === "active" && Boolean(subscription.stripeSubscriptionId)
            : false;

        const canAddTrialSecondary = activeWebsites >= 1;
        const canBuySecondary = isPaidUser;

        console.log(
          `[createWebsite] WEBSITE_LIMIT_REACHED userId=${userId} isTrialUser=${isTrialUser} isPaidUser=${isPaidUser} canAddTrialSecondary=${canAddTrialSecondary} canBuySecondary=${canBuySecondary}`,
        );
        return res.status(402).json({
          success: false,
          error: "WEBSITE_LIMIT_REACHED",
          message: isTrialUser
            ? "You can add another website to your trial to explore its SEO potential."
            : "Subscribe to add another website and scale your SEO across all your properties.",
          canAddTrialSecondary,
          canBuySecondary,
        });
      }
    }

	    const isFirstWebsite = activeWebsites === 0;
      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);

	    const pendingBusiness = await prisma.business.create({
	      data: {
	        userId,
        businessName: payload.businessName || normalizedUrl,
        businessType: "",
        businessWebsiteUrl: normalizedUrl,
	        businessDescription: "",
	        websiteStatus: "pending",
	        isPrimary: isFirstWebsite,
	        isActive: true,
          onboardingFlow: "website_secondary",
          onboardingStatus: "idle",
          onboardingCorrelationId: correlationId ?? null,
          agencyId: agencyAssignment.agencyId,
          onboardedByUserId: userId,
          ownershipType: agencyAssignment.ownershipType,
	      },
	    });

    console.log(
      `✅ Pending business created for user ${userId}: ${pendingBusiness.id} (website: ${normalizedUrl})`,
    );

	    let createdStripeItemId: string | null = null;
      let billingInterval = getBillingIntervalFromPriceId(subscription?.stripePriceId);
      if (subscription?.stripeSubscriptionId) {
        try {
          const currentStripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripeSubscriptionId,
            {
              expand: ["items.data.price"],
            },
          );
          const recurringInterval =
            currentStripeSubscription.items.data[0]?.price.recurring?.interval;
          if (recurringInterval === "year") {
            billingInterval = "yearly";
          }
        } catch (intervalError) {
          console.warn(
            `[createWebsite] Failed to resolve billing interval from Stripe subscription ${subscription.stripeSubscriptionId}:`,
            intervalError,
          );
        }
      }
      const priceResolution = await resolveSubscriptionPrice(
        agencyAssignment.agencyId,
        billingInterval,
        {
          monthly: {
            stripePriceId:
              process.env.WEBSITE_PRICE_ID || process.env.UPLIFT_PLAN_PRICE_ID || "",
            priceCents: 9900,
          },
          yearly: {
            stripePriceId:
              process.env.WEBSITE_YEARLY_PRICE_ID ||
              process.env.UPLIFT_YEARLY_PRICE_ID ||
              "",
            priceCents: 99000,
          },
        },
      );
	    const websitePriceId = priceResolution.stripePriceId;
	    if (subscription && subscription.stripeSubscriptionId && websitePriceId) {
	      try {
	        const subscriptionItem = await stripe.subscriptionItems.create({
          subscription: subscription.stripeSubscriptionId,
          price: websitePriceId,
          quantity: 1,
        });
        createdStripeItemId = subscriptionItem.id;

	        await prisma.websiteSubscription.create({
	          data: {
	            businessId: pendingBusiness.id,
	            stripeSubscriptionId: subscription.stripeSubscriptionId,
	            stripeSubscriptionItemId: subscriptionItem.id,
	            stripePriceId: websitePriceId,
	            status: "active",
	            currentPeriodStart: new Date(),
	            currentPeriodEnd: subscription.stripeCurrentPeriodEnd || undefined,
              agencyId: agencyAssignment.agencyId,
              agencyPricingConfigId: priceResolution.agencyPricingConfigId,
	          },
	        });

        await prisma.business.update({
          where: { id: pendingBusiness.id },
          data: {
            stripeSubscriptionItemId: subscriptionItem.id,
          },
        });
      } catch (stripeError: unknown) {
        console.error("Stripe error creating subscription item:", stripeError);
      }
    }

    if (!skipSubscriptionCheck && subscription) {
      try {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            websiteCount: { increment: 1 },
          },
        });
      } catch (error: unknown) {
        console.error("Error updating subscription website count:", error);
      }
    }

    try {
      await queueWebsiteOnboardingEvent({
        userId,
        businessId: pendingBusiness.id,
        websiteUrl: normalizedUrl,
        correlationId,
      });
    } catch (queueError) {
      await markBusinessOnboardingFailed(prisma, {
        businessId: pendingBusiness.id,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_onboarding"),
      });
      await compensateWebsiteOnboardFailure({
        prisma,
        stripe,
        businessId: pendingBusiness.id,
        userId,
        stripeSubscriptionItemId: createdStripeItemId,
        decrementWebsiteCount: !skipSubscriptionCheck && !!subscription,
        markFailed: true,
      });
      console.error(
        `❌ Failed to queue background onboarding for business ${pendingBusiness.id}:`,
        queueError,
      );
      return sendError(
        res,
        "Failed to start website analysis. Please try again.",
        500,
      );
    }

    console.log(
      `✅ Background onboarding triggered for user ${userId}, business ${pendingBusiness.id}, website: ${normalizedUrl}`,
    );

    return sendSuccess(res, {
      message: "Website added! Analysis is running in the background. You'll receive an email when it's complete.",
      data: pendingBusiness,
      onboardingStatus: "queued",
    });
  } catch (error: any) {
    console.error("Error creating website:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to create website", 500, error);
  }
}

export async function listWebsites(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { includeInactive } = (req.body as { includeInactive?: boolean }) ?? {};
    const where: { userId: string; isActive?: boolean } = { userId: authUserId };
    if (!includeInactive) {
      where.isActive = true;
    }

    const [websites, owner] = await Promise.all([
      prisma.business.findMany({
        where,
        include: {
          websiteSubscription: true,
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      }),
      prisma.user.findUnique({
        where: { id: authUserId },
        select: { role: true },
      }),
    ]);

    const secondaryBusinessIds = websites
      .filter(
        (website) =>
          website.onboardingFlow === "website_secondary" &&
          website.onboardingStatus !== "completed" &&
          website.removalStatus === "active",
      )
      .map((website) => website.id);
    const secondarySessions = secondaryBusinessIds.length
      ? await prisma.quickScrapeBusiness.findMany({
          where: {
            userId: authUserId,
            onboardingV2Flow: "website_secondary",
            onboardingV2Status: { not: "completed" },
            onboardingV2BusinessId: { in: secondaryBusinessIds },
          },
          orderBy: [{ onboardingV2LastSeenAt: "desc" }, { updatedAt: "desc" }],
          select: {
            id: true,
            onboardingV2BusinessId: true,
            onboardingV2Step: true,
            onboardingV2Status: true,
          },
        })
      : [];
    const secondarySessionByBusinessId = new Map<
      string,
      (typeof secondarySessions)[number]
    >();
    for (const session of secondarySessions) {
      if (
        session.onboardingV2BusinessId &&
        !secondarySessionByBusinessId.has(session.onboardingV2BusinessId)
      ) {
        secondarySessionByBusinessId.set(
          session.onboardingV2BusinessId,
          session,
        );
      }
    }

    const isStaff = owner?.role === "ADMIN" || owner?.role === "SUPERADMIN";
    const serializedWebsites = websites.map((website) => {
      const secondarySession = secondarySessionByBusinessId.get(website.id);
      const hasOnboardingError = Boolean(website.onboardingLastError);
      const workspaceAccess = resolveWebsiteWorkspaceAccess(website, {
        hasAdminAccess: isStaff,
      });
      return {
        id: website.id,
        businessName: website.businessName,
        businessWebsiteUrl: website.businessWebsiteUrl,
        businessType: website.businessType,
        isPrimary: website.isPrimary,
        isActive: website.isActive,
        websiteStatus: website.websiteStatus,
        selectedServices: website.selectedServices,
        detectedServices: website.detectedServices,
        servicesPriority: website.servicesPriority,
        onboardingFlow: website.onboardingFlow,
        onboardingStatus: website.onboardingStatus,
        onboardingLastError: hasOnboardingError
          ? {
              code: "onboarding_failed",
              stage: "onboarding",
              message:
                "Website analysis could not be completed. Please retry.",
            }
          : null,
        secondaryDetailsConfirmed: website.secondaryDetailsConfirmed,
        createdAt: website.createdAt,
        websiteSubscription: website.websiteSubscription
          ? {
              status: website.websiteSubscription.status,
              planTier: website.websiteSubscription.planTier,
              currentPeriodEnd: website.websiteSubscription.currentPeriodEnd,
              trialStatus: website.websiteSubscription.trialStatus,
              trialEndDate: website.websiteSubscription.trialEndDate,
              isStripeBacked: Boolean(
                website.websiteSubscription.stripeSubscriptionId,
              ),
            }
          : null,
        // This backend-owned projection is the only browser contract for
        // deciding whether an owned record is a usable product workspace.
        // Billing/recovery screens may still use the record when this is false.
        workspaceAccess,
        // Provider IDs, operation keys, tenant IDs, and billing IDs are never
        // part of the ordinary browser-facing website projection.
        removal: serializeWebsiteRemovalLifecycle(website as any, { isStaff }),
        onboardingV2: secondarySession
          ? {
              quickBusinessId: secondarySession.id,
              step: secondarySession.onboardingV2Step,
              status: secondarySession.onboardingV2Status,
              resumePath: `/dashboard/websites/onboarding/${secondarySession.id}`,
            }
          : null,
      };
    });

    return sendSuccess(res, serializedWebsites, "Websites retrieved successfully");
  } catch (error: any) {
    console.error("Error listing websites:", error);
    return sendError(res, "Failed to retrieve websites", 500, error);
  }
}

export async function updateWebsite(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = UPDATE_WEBSITE_SCHEMA.parse(body);

    const updateData: Record<string, unknown> = {};
    if (payload.businessName !== undefined) {
      updateData.businessName = payload.businessName;
    }
    if (payload.businessWebsiteUrl !== undefined) {
      const normalizedBusinessWebsiteUrl = NORMALIZE_WEBSITE_URL.parse(
        payload.businessWebsiteUrl,
      );
      const unsupportedResponse = rejectUnsupportedWebsiteUrl(
        res,
        normalizedBusinessWebsiteUrl,
      );
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      updateData.businessWebsiteUrl = normalizedBusinessWebsiteUrl;
    }
    const updateResult = await prisma.$transaction(async (tx) => {
      if (payload.isPrimary) {
        await lockPrimaryWorkspaceSelection(tx, authUserId);
      }
      const business = await tx.business.findUnique({
        where: { id: payload.businessId },
        include: {
          websiteSubscription: { select: { status: true } },
          User: { select: { role: true } },
        },
      });
      if (!business || business.userId !== authUserId) {
        return { kind: "not_found" } as const;
      }
      if (payload.isPrimary) {
        const access = resolveWebsiteWorkspaceAccess(business, {
          hasAdminAccess:
            business.User.role === "ADMIN" ||
            business.User.role === "SUPERADMIN",
        });
        if (!access.canAccessWorkspace || !access.canSelectWorkspace) {
          return { kind: "unavailable", access } as const;
        }
        const previousPrimary = await tx.business.findFirst({
          where: { userId: authUserId, isPrimary: true },
          select: { id: true },
        });
        await tx.business.updateMany({
          where: { userId: authUserId, isPrimary: true },
          data: { isPrimary: false },
        });
        updateData.isPrimary = true;
        const updated = await tx.business.update({
          where: { id: payload.businessId },
          data: updateData,
        });
        return {
          kind: "updated",
          updated,
          previousBusinessId: previousPrimary?.id ?? null,
        } as const;
      }
      const updated = await tx.business.update({
        where: { id: payload.businessId },
        data: updateData,
      });
      return { kind: "updated", updated, previousBusinessId: null } as const;
    });

    if (updateResult.kind === "not_found") {
      return sendError(res, "Website not found or access denied", 404);
    }
    if (updateResult.kind === "unavailable") {
      console.warn("[workspace-access] primary update rejected", {
        userId: authUserId,
        businessId: payload.businessId,
        reason: updateResult.access.reason,
        correlationId: getRequestCorrelationId(req) ?? null,
      });
      return sendError(
        res,
        "Website is not available for selection",
        409,
        { code: "WORKSPACE_UNAVAILABLE", reason: updateResult.access.reason },
      );
    }
    if (
      payload.isPrimary &&
      updateResult.previousBusinessId !== payload.businessId
    ) {
      console.info("[workspace-access] primary website updated", {
        userId: authUserId,
        previousBusinessId: updateResult.previousBusinessId,
        selectedBusinessId: payload.businessId,
        correlationId: getRequestCorrelationId(req) ?? null,
      });
    }

    return sendSuccess(res, {
      message: "Website updated successfully",
      data: {
        id: updateResult.updated.id,
        businessName: updateResult.updated.businessName,
        businessWebsiteUrl: updateResult.updated.businessWebsiteUrl,
        businessType: updateResult.updated.businessType,
        isPrimary: updateResult.updated.isPrimary,
        isActive: updateResult.updated.isActive,
        websiteStatus: updateResult.updated.websiteStatus,
        onboardingFlow: updateResult.updated.onboardingFlow,
        onboardingStatus: updateResult.updated.onboardingStatus,
      },
    });
  } catch (error: any) {
    console.error("Error updating website:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to update website", 500, error);
  }
}

export async function deleteWebsite(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { businessId } = WEBSITE_LIFECYCLE_SCHEMA.parse(req.body);
    const result = await requestWebsiteRemoval(authUserId, businessId);
    const pending = result.removalStatus === "cancellation_pending";
    return sendSuccess(
      res,
      result,
      pending
        ? "Website removal is pending billing confirmation."
        : "Website removed successfully.",
      pending ? 202 : 200,
    );
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Business ID is invalid", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    if (error instanceof WebsiteRemovalError) {
      return sendError(res, error.message, error.statusCode, error);
    }
    console.error("Error requesting website removal:", error);
    return sendError(res, "Failed to remove website", 500, {
      code: "WEBSITE_REMOVAL_FAILED",
    });
  }
}

export async function retryWebsiteRemoval(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = WEBSITE_LIFECYCLE_SCHEMA.parse(req.body);
    const result = await retryPendingWebsiteRemoval(authUserId, businessId);
    const pending = result.removalStatus === "cancellation_pending";
    return sendSuccess(
      res,
      result,
      pending
        ? "Website removal is still pending billing confirmation."
        : "Website removal completed.",
      pending ? 202 : 200,
    );
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Business ID is invalid", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    if (error instanceof WebsiteRemovalError) {
      return sendError(res, error.message, error.statusCode, error);
    }
    console.error("Error retrying website removal:", error);
    return sendError(res, "Failed to retry website removal", 500, {
      code: "WEBSITE_REMOVAL_RETRY_FAILED",
    });
  }
}

export async function restoreWebsite(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = WEBSITE_LIFECYCLE_SCHEMA.parse(req.body);
    const result = await restoreRemovedWebsite(authUserId, businessId);
    return sendSuccess(
      res,
      result,
      result.requiresSubscription
        ? "Website recovered. Subscribe to reactivate it."
        : "Website restored successfully.",
    );
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return sendError(res, "Business ID is invalid", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    if (error instanceof WebsiteRemovalError) {
      return sendError(res, error.message, error.statusCode, error);
    }
    console.error("Error restoring website:", error);
    return sendError(res, "Failed to restore website", 500, {
      code: "WEBSITE_RESTORE_FAILED",
    });
  }
}

export async function switchWebsite(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { businessId } = req.body as { businessId?: string };

    if (!businessId) {
      return sendError(res, "Business ID is required", 400);
    }

    const switchResult = await prisma.$transaction(async (tx) => {
      await lockPrimaryWorkspaceSelection(tx, authUserId);
      // Re-read after acquiring the account lock. A concurrent billing event
      // may have changed entitlement after the browser rendered its switcher.
      const business = await tx.business.findUnique({
        where: { id: businessId },
        include: {
          websiteSubscription: { select: { status: true } },
          User: { select: { role: true } },
        },
      });
      if (!business || business.userId !== authUserId) {
        return { kind: "not_found" } as const;
      }

      const workspaceAccess = resolveWebsiteWorkspaceAccess(business, {
        hasAdminAccess:
          business.User.role === "ADMIN" || business.User.role === "SUPERADMIN",
      });
      // Re-selecting the current primary is idempotent, including while its
      // durable setup status is queued/running.
      if (business.isPrimary && workspaceAccess.canAccessWorkspace) {
        return { kind: "unchanged" } as const;
      }
      if (
        !workspaceAccess.canAccessWorkspace ||
        !workspaceAccess.canSelectWorkspace
      ) {
        return { kind: "unavailable", workspaceAccess } as const;
      }

      const previousPrimary = await tx.business.findFirst({
        where: { userId: authUserId, isPrimary: true },
        select: { id: true },
      });
      await tx.business.updateMany({
        where: { userId: authUserId, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.business.update({
        where: { id: businessId },
        data: { isPrimary: true },
      });
      return {
        kind: "switched",
        previousBusinessId: previousPrimary?.id ?? null,
      } as const;
    });

    if (switchResult.kind === "not_found") {
      return sendError(res, "Website not found or unauthorized", 404);
    }
    if (switchResult.kind === "unavailable") {
      console.warn("[workspace-access] website switch rejected", {
        userId: authUserId,
        businessId,
        reason: switchResult.workspaceAccess.reason,
        canAccessWorkspace:
          switchResult.workspaceAccess.canAccessWorkspace,
        canSelectWorkspace:
          switchResult.workspaceAccess.canSelectWorkspace,
        correlationId: getRequestCorrelationId(req) ?? null,
      });
      return sendError(
        res,
        "Website is not available for selection",
        409,
        {
          code: "WORKSPACE_UNAVAILABLE",
          reason: switchResult.workspaceAccess.reason,
        },
      );
    }

    if (switchResult.kind === "switched") {
      console.info("[workspace-access] primary website switched", {
        userId: authUserId,
        previousBusinessId: switchResult.previousBusinessId,
        selectedBusinessId: businessId,
        correlationId: getRequestCorrelationId(req) ?? null,
      });
    }

    return sendSuccess(res, {
      message:
        switchResult.kind === "unchanged"
          ? "Primary website already selected"
          : "Primary website switched successfully",
      data: { businessId },
    });
  } catch (error: any) {
    console.error("Error switching website:", error);
    return sendError(res, "Failed to switch website", 500, error);
  }
}

export async function retryWebsiteOnboarding(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };
    if (!businessId) {
      return sendError(res, "Business ID is required", 400);
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business || business.userId !== authUserId) {
      return sendError(res, "Website not found or unauthorized", 404);
    }

    if (business.onboardingStatus !== "failed") {
      return sendError(res, "Only failed onboarding runs can be retried", 400);
    }

    const inferredFlow =
      business.onboardingFlow ??
      (business.isPrimary && business.websiteStatus === "trial"
        ? "trial_primary"
        : "website_secondary");
    const correlationId = getRequestCorrelationId(req);

    await prisma.business.update({
      where: { id: businessId },
      data: {
        websiteStatus:
          inferredFlow === "trial_primary" ? "trial" : "pending",
      },
    });

    try {
      if (inferredFlow === "trial_primary") {
        await queueTrialPrimaryOnboardingEvent({
          businessId,
          userId: authUserId,
          websiteUrl: business.businessWebsiteUrl || "",
          selectedServices: business.selectedServices,
          servicesPriority: business.servicesPriority,
          detectedServices: business.detectedServices,
          correlationId,
        });
      } else {
        await queueWebsiteOnboardingEvent({
          userId: authUserId,
          businessId,
          websiteUrl: business.businessWebsiteUrl || "",
          correlationId,
        });
      }
    } catch (queueError) {
      await prisma.business.update({
        where: { id: businessId },
        data: {
          websiteStatus:
            inferredFlow === "trial_primary" ? "trial" : "failed",
        },
      });
      await markBusinessOnboardingFailed(prisma, {
        businessId,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_retry"),
      });
      return sendError(res, "Failed to queue retry. Please try again.", 500, queueError);
    }

    return sendSuccess(res, {
      message: "Website onboarding retry started",
      data: { businessId },
    });
  } catch (error: unknown) {
    console.error("Error retrying website onboarding:", error);
    return sendError(res, "Failed to retry website onboarding", 500, error);
  }
}

const CREATE_SECONDARY_SCHEMA = z
  .object({
    websiteUrl: z.string().url(),
  })
  .strict();

const SECONDARY_DETAILS_LOOKUP_SCHEMA = z.object({
  businessId: z.string().optional(),
  websiteUrl: z.string().url().optional(),
});

const SEARCH_SECONDARY_PLACES_SCHEMA = z.object({
  businessId: z.string().optional(),
  websiteUrl: z.string().url().optional(),
  query: z.string().trim().min(3, "Search query must be at least 3 characters"),
});

async function resolveOwnedSecondaryBusiness(input: {
  userId: string;
  businessId?: string;
  websiteUrl?: string;
}) {
  if (input.businessId) {
    const byId = await prisma.business.findFirst({
      where: {
        id: input.businessId,
        userId: input.userId,
        removalStatus: "active",
      },
      include: {
        websiteAnalysis: { select: { id: true } },
        websiteSubscription: true,
      },
    });

    if (byId) {
      return byId;
    }
  }

  if (!input.websiteUrl) {
    return null;
  }

  const normalizedUrl = NORMALIZE_WEBSITE_URL.parse(input.websiteUrl);
  const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);

  return prisma.business.findFirst({
    where: {
      userId: input.userId,
      removalStatus: "active",
      businessWebsiteUrl: { in: websiteUrlCandidates },
    },
    orderBy: { createdAt: "desc" },
    include: {
      websiteAnalysis: { select: { id: true } },
      websiteSubscription: true,
    },
  });
}

export async function createTrialSecondaryWebsite(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = CREATE_SECONDARY_SCHEMA.parse(body);
    const userId = authUserId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        Subscription: true,
        business: {
          where: { isActive: true },
          include: { websiteSubscription: true },
        },
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    const activeWebsites = user.business.length;

    if (activeWebsites < 1) {
      return sendError(
        res,
        "Create your first website before adding a secondary website.",
        400,
      );
    }

    const now = new Date();
    const accountTrialEnd =
      user.trialEndDate ?? user.Subscription?.currentPeriodEnd ?? null;
    const hasActiveAccountTrial =
      (user.Subscription?.status === "trialing" ||
        user.trialStatus === "active") &&
      (!accountTrialEnd || accountTrialEnd > now);
    const hasActiveWebsiteTrial = user.business.some(({ websiteSubscription }) =>
      Boolean(
        websiteSubscription &&
          (websiteSubscription.status === "trialing" ||
            websiteSubscription.trialStatus === "trialing") &&
          (!websiteSubscription.trialEndDate ||
            websiteSubscription.trialEndDate > now),
      ),
    );

    if (
      !PER_SITE_TRIALS_ENABLED ||
      user.Subscription?.status === "active" ||
      (!hasActiveAccountTrial && !hasActiveWebsiteTrial)
    ) {
      return res.status(402).json({
        success: false,
        error: "TRIAL_ONLY",
        message:
          "Add to trial is only available while your account trial is active.",
        timestamp: new Date().toISOString(),
      });
    }

    const normalizedUrl = NORMALIZE_WEBSITE_URL.parse(payload.websiteUrl);
    const unsupportedResponse = rejectUnsupportedWebsiteUrl(res, normalizedUrl);
    if (unsupportedResponse) {
      return unsupportedResponse;
    }

    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);
    const correlationId = getRequestCorrelationId(req);

    const existingWebsite = await prisma.business.findFirst({
      where: {
        userId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
        isActive: true,
      },
    });

    if (existingWebsite) {
      return sendError(res, "Website already exists for this user", 400);
    }

      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);
      const agencyPricingConfigId = await getActiveAgencyPricingConfigId(
        agencyAssignment.agencyId,
      );

	    const pendingBusiness = await prisma.business.create({
	      data: {
	        userId,
        businessName: payload.websiteUrl,
        businessType: "",
        businessWebsiteUrl: normalizedUrl,
	        businessDescription: "",
	        websiteStatus: "pending",
	        isPrimary: false,
	        isActive: true,
          onboardingFlow: "website_secondary",
          onboardingStatus: "idle",
          onboardingCorrelationId: correlationId ?? null,
          agencyId: agencyAssignment.agencyId,
          onboardedByUserId: userId,
          ownershipType: agencyAssignment.ownershipType,
	      },
	    });

    if (PER_SITE_TRIALS_ENABLED) {
      const trialStart: Date = new Date();
      const trialEnd: Date = new Date();
      trialEnd.setDate(trialEnd.getDate() + 7);
      await prisma.websiteSubscription.upsert({
        where: { businessId: pendingBusiness.id },
	        create: {
	          businessId: pendingBusiness.id,
	          status: "trialing",
	          trialStartDate: trialStart,
	          trialEndDate: trialEnd,
	          trialStatus: "trialing",
            agencyId: agencyAssignment.agencyId,
            agencyPricingConfigId: agencyPricingConfigId,
	        },
	        update: {
	          status: "trialing",
	          trialStartDate: trialStart,
	          trialEndDate: trialEnd,
	          trialStatus: "trialing",
            agencyId: agencyAssignment.agencyId,
            agencyPricingConfigId: agencyPricingConfigId,
	        },
	      });
	    }

    try {
      await queueWebsiteOnboardingEvent({
        userId,
        businessId: pendingBusiness.id,
        websiteUrl: normalizedUrl,
        correlationId,
      });
    } catch (queueError) {
      await prisma.business.update({
        where: { id: pendingBusiness.id },
        data: { websiteStatus: "failed" },
      });
      await markBusinessOnboardingFailed(prisma, {
        businessId: pendingBusiness.id,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_onboarding"),
      });
      console.error(
        `[createTrialSecondary] Failed to queue onboarding for business ${pendingBusiness.id}:`,
        queueError,
      );
      return sendError(
        res,
        "Failed to start website analysis. Please try again.",
        500,
      );
    }

    console.log(
      `[createTrialSecondary] userId=${userId} businessId=${pendingBusiness.id} website=${normalizedUrl} onboarding queued`,
    );

    return sendSuccess(res, {
      message: "Trial secondary website added. Analysis is running in the background.",
      data: pendingBusiness,
      onboardingStatus: "queued",
    });
  } catch (error: unknown) {
    console.error("Error creating trial secondary website:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to create trial secondary website", 500, error);
  }
}

export async function getSecondaryWebsiteDraft(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const payload = SECONDARY_DETAILS_LOOKUP_SCHEMA.parse(req.body);
    const business = await resolveOwnedSecondaryBusiness({
      userId: authUserId,
      businessId: payload.businessId,
      websiteUrl: payload.websiteUrl,
    });

    if (!business) {
      return sendError(res, "Website not found", 404);
    }

    if (business.onboardingFlow !== "website_secondary") {
      return sendError(
        res,
        "Only secondary website onboarding can be viewed here",
        400,
      );
    }

    return sendSuccess(
      res,
      {
        businessId: business.id,
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        businessPhone: business.businessPhone,
        businessAddress: business.businessAddress,
        businessCity: business.businessCity,
        businessState: business.businessState,
        businessCountry: business.businessCountry,
        websiteStatus: business.websiteStatus,
        onboardingFlow: business.onboardingFlow,
        onboardingStatus: business.onboardingStatus,
        onboardingLastError: business.onboardingLastError,
        secondaryDetailsConfirmed: business.secondaryDetailsConfirmed,
        hasWebsiteAnalysis: Boolean(business.websiteAnalysis),
      },
      "Secondary website draft retrieved successfully",
    );
  } catch (error: unknown) {
    console.error("Error getting secondary website draft:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to retrieve website details", 500, error);
  }
}

export async function confirmSecondaryWebsiteDetails(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const payload = CONFIRM_SECONDARY_DETAILS.parse(req.body);
    const business = await resolveOwnedSecondaryBusiness({
      userId: authUserId,
      businessId: payload.businessId,
      websiteUrl: payload.websiteUrl,
    });

    if (!business) {
      return sendError(res, "Website not found", 404);
    }

    if (business.onboardingFlow !== "website_secondary") {
      return sendError(
        res,
        "Only secondary website onboarding can be confirmed here",
        400,
      );
    }

    if (
      business.onboardingStatus === "queued" ||
      business.onboardingStatus === "running"
    ) {
      return sendError(
        res,
        "We’re still preparing this website. Please wait a moment and try again.",
        409,
      );
    }

    if (business.onboardingStatus === "completed") {
      return sendError(res, "This website has already finished setup", 400);
    }

    const correlationId = getRequestCorrelationId(req);

    await prisma.business.update({
      where: { id: business.id },
      data: {
        businessName: payload.businessName,
        businessAddress: payload.businessAddress,
        businessCity: payload.businessCity,
        businessState: payload.businessState,
        businessCountry: payload.businessCountry,
        businessPhone: payload.businessPhone ?? null,
        secondaryDetailsConfirmed: true,
        websiteStatus: "pending",
      },
    });

    try {
      if (business.websiteAnalysis) {
        await queueWebsiteFinalizeEvent({
          userId: authUserId,
          businessId: business.id,
          websiteUrl: business.businessWebsiteUrl,
          correlationId,
        });
      } else {
        await queueWebsiteOnboardingEvent({
          userId: authUserId,
          businessId: business.id,
          websiteUrl: business.businessWebsiteUrl,
          correlationId,
        });
      }
    } catch (queueError) {
      await markBusinessOnboardingAwaitingConfirmation(prisma, {
        businessId: business.id,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_confirmation_resume"),
      });
      return sendError(
        res,
        "Failed to resume website onboarding. Please try again.",
        500,
        queueError,
      );
    }

    return sendSuccess(
      res,
      {
        businessId: business.id,
        onboardingStatus: "queued",
      },
      "Website details confirmed. Finalizing onboarding now.",
    );
  } catch (error: unknown) {
    console.error("Error confirming secondary website details:", error);
    if (error instanceof z.ZodError) {
      return handleValidationError(res, error);
    }
    return sendError(res, "Failed to confirm website details", 500, error);
  }
}

export async function searchSecondaryWebsitePlaces(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const payload = SEARCH_SECONDARY_PLACES_SCHEMA.parse(req.body);
    const business = await resolveOwnedSecondaryBusiness({
      userId: authUserId,
      businessId: payload.businessId,
      websiteUrl: payload.websiteUrl,
    });

    if (!business) {
      return sendError(res, "Website not found", 404);
    }

    if (business.onboardingFlow !== "website_secondary") {
      return sendError(
        res,
        "Only secondary website onboarding can search places here",
        400,
      );
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
        country: business.businessCountry ?? undefined,
        city: business.businessCity ?? undefined,
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
      console.error("[Secondary Website Places Search] Google Places failed:", error);
      return sendSuccess(res, {
        candidates: [],
        unavailable: true,
        message: "Google Places search is temporarily unavailable.",
      });
    }
  } catch (error: unknown) {
    console.error("Error searching secondary website places:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to search business locations", 500, error);
  }
}

export async function createPaidSecondaryWebsite(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = req.body;
    const payload = CREATE_SECONDARY_SCHEMA.parse(body);
    const userId = authUserId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        business: true,
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    const normalizedUrl = NORMALIZE_WEBSITE_URL.parse(payload.websiteUrl);
    const unsupportedResponse = rejectUnsupportedWebsiteUrl(res, normalizedUrl);
    if (unsupportedResponse) {
      return unsupportedResponse;
    }

    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);
    const correlationId = getRequestCorrelationId(req);

    const existingWebsite = await prisma.business.findFirst({
      where: {
        userId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
      },
      include: { websiteSubscription: true },
    });

    if (existingWebsite) {
      const canResumePendingCheckout =
        existingWebsite.onboardingFlow === "website_secondary" &&
        existingWebsite.websiteStatus === "pending" &&
        !existingWebsite.isActive &&
        (!existingWebsite.websiteSubscription ||
          !["active", "trialing", "past_due", "unpaid", "incomplete"].includes(
            existingWebsite.websiteSubscription.status,
          ));

      if (canResumePendingCheckout) {
        console.log(
          `[createPaidSecondary] Reusing pending checkout business userId=${userId} businessId=${existingWebsite.id}`,
        );
        return sendSuccess(
          res,
          { businessId: existingWebsite.id },
          "Pending business reused. Complete checkout to start analysis.",
        );
      }

      return sendError(res, "Website already exists for this user", 400);
    }

    if (user.business.length < 1) {
      return sendError(
        res,
        "Create your first website through onboarding before adding another website.",
        400,
      );
    }

      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);
	    const pendingBusiness = await prisma.business.create({
	      data: {
	        userId,
        businessName: payload.websiteUrl,
        businessType: "",
        businessWebsiteUrl: normalizedUrl,
	        businessDescription: "",
	        websiteStatus: "pending",
	        isPrimary: false,
	        isActive: false,
          onboardingFlow: "website_secondary",
          onboardingStatus: "idle",
          onboardingCorrelationId: correlationId ?? null,
          agencyId: agencyAssignment.agencyId,
          onboardedByUserId: userId,
          ownershipType: agencyAssignment.ownershipType,
	      },
	    });

    console.log(
      `[createPaidSecondary] userId=${userId} businessId=${pendingBusiness.id} website=${normalizedUrl} (checkout to be completed by client)`,
    );

    return sendSuccess(
      res,
      { businessId: pendingBusiness.id },
      "Pending business created. Complete checkout to start analysis.",
    );
  } catch (error: unknown) {
    console.error("Error creating paid secondary website:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, error.issues);
    }
    return sendError(res, "Failed to create paid secondary website", 500, error);
  }
}

export async function triggerOnboarding(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) {
      return sendError(res, "Business ID is required", 400);
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business || business.userId !== authUserId) {
      return sendError(res, "Website not found or unauthorized", 404);
    }

    if (
      ["queued", "running", "awaiting_confirmation", "completed"].includes(
        business.onboardingStatus ?? "",
      )
    ) {
      return sendSuccess(res, {
        message: "Onboarding already queued",
        data: { businessId, alreadyQueued: true },
      });
    }

    if (
      business.onboardingStatus !== "idle" &&
      business.onboardingStatus !== "failed" &&
      business.websiteStatus !== "pending"
    ) {
      return sendError(
        res,
        "Onboarding can only be triggered for pending websites",
        400,
      );
    }

    const websiteUrl = business.businessWebsiteUrl || "";
    if (!websiteUrl) {
      return sendError(res, "Business has no website URL", 400);
    }

    const correlationId = getRequestCorrelationId(req);

    try {
      await queueWebsiteOnboardingEvent({
        userId: authUserId,
        businessId,
        websiteUrl,
        correlationId,
      });
    } catch (queueError) {
      await markBusinessOnboardingFailed(prisma, {
        businessId,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_onboarding"),
      });
      return sendError(
        res,
        "Failed to queue onboarding. Please try again.",
        500,
        queueError,
      );
    }

    console.log(
      `[triggerOnboarding] businessId=${businessId} userId=${authUserId} website/onboard queued`,
    );

    return sendSuccess(res, {
      message: "Onboarding queued",
      data: { businessId },
    });
  } catch (error: unknown) {
    console.error("Error triggering onboarding:", error);
    return sendError(res, "Failed to trigger onboarding", 500, error);
  }
}

export async function internalTriggerOnboarding(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) {
      sendError(res, "Business ID is required", 400);
      return;
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      sendError(res, "Website not found", 404);
      return;
    }

    if (
      business.onboardingFlow === "website_secondary" &&
      business.onboardingStatus !== "completed"
    ) {
      try {
        const initialized = await ensureSecondaryOnboardingV2Initialized({
          businessId,
          correlationId: getRequestCorrelationId(req),
        });
        sendSuccess(res, {
          businessId,
          alreadyQueued: initialized.alreadyQueued,
          onboardingMode: "onboarding_v2",
          onboardingId: initialized.quickScrapeBusinessId,
          quickScrapeBusinessId: initialized.quickScrapeBusinessId,
          provisionalBusinessId: businessId,
          resumePath: initialized.resumePath,
        });
        return;
      } catch (error) {
        sendError(res, "Failed to prepare additional website setup", 500, {
          code: "SECONDARY_ONBOARDING_V2_INITIALIZATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    if (
      ["queued", "running", "awaiting_confirmation", "completed"].includes(
        business.onboardingStatus ?? "",
      )
    ) {
      sendSuccess(res, {
        message: "Onboarding already queued",
        data: { businessId, alreadyQueued: true },
      });
      return;
    }

    if (
      business.onboardingStatus !== "idle" &&
      business.onboardingStatus !== "failed" &&
      business.websiteStatus !== "pending"
    ) {
      sendError(
        res,
        "Onboarding can only be triggered for pending websites",
        400,
      );
      return;
    }

    const websiteUrl = business.businessWebsiteUrl || "";
    if (!websiteUrl) {
      sendError(res, "Business has no website URL", 400);
      return;
    }

    const userId = business.userId;
    const correlationId = getRequestCorrelationId(req);

    try {
      await queueWebsiteOnboardingEvent({
        userId,
        businessId,
        websiteUrl,
        correlationId,
      });
    } catch (queueError) {
      await markBusinessOnboardingFailed(prisma, {
        businessId,
        correlationId,
        error: serializeOnboardingError(queueError, "queue_onboarding"),
      });
      sendError(res, "Failed to queue onboarding", 500, queueError);
      return;
    }

    console.log(
      `[internalTriggerOnboarding] businessId=${businessId} userId=${userId} website/onboard queued`,
    );

    sendSuccess(res, {
      message: "Onboarding queued",
      data: { businessId },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[internalTriggerOnboarding] Failed businessId=${(req.body as { businessId?: string }).businessId ?? "?"}:`,
      msg,
    );
    sendError(res, "Failed to trigger onboarding", 500, error);
  }
}
