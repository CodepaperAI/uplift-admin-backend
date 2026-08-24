import type { Response } from "express";
import type Stripe from "stripe";
import { z, ZodError } from "zod";

import { prisma } from "../config/db.config";
import {
  isStripeConfigured,
  stripe,
} from "../config/stripe.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  convertTrialToSubscription,
  createOrUpdateSubscription,
  getStripeMetadataBusinessIds,
  isOnboardingV2TrialMetadata,
  resolveStripeWebsiteSubscriptionLifecycle,
  syncAddWebsiteSubscription,
  syncWebsiteSubscriptions,
} from "../services/billing-subscription.service";
import { recordRewardfulConversionPreparedForUser } from "../services/billing-rewardful.service";
import { dispatchInitialSocialPlanningForEligibleWebsites } from "../services/billing-social-initialization.service";
import {
  ensureOnboardingV2PaidIntroSchedule,
  ensureOnboardingV2PaidIntroSubscription,
} from "../services/onboarding-paid-intro.service";
import {
  queueWebsiteOnboardingEvent,
} from "./website.controller";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  isStripeCheckoutSessionId,
  resolveStripeSessionBinding,
} from "../utils/stripe-session-binding";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

const VERIFY_REQUEST = z
  .object({
    sessionId: z.string().refine(isStripeCheckoutSessionId),
    businessId: z.string().uuid().optional(),
    quickScrapeBusinessId: z.string().uuid().optional(),
    onboardingMode: z.literal("onboarding_v2").optional(),
  })
  .strict();

class VerificationError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
  }
}

function stripeObjectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function assertRequestedContext(
  requested: z.infer<typeof VERIFY_REQUEST>,
  binding: {
    businessId: string | null;
    quickScrapeBusinessId: string | null;
    onboardingMode: string | null;
  },
) {
  if (
    (requested.businessId &&
      requested.businessId !== binding.businessId) ||
    (requested.quickScrapeBusinessId &&
      requested.quickScrapeBusinessId !== binding.quickScrapeBusinessId) ||
    (requested.onboardingMode &&
      requested.onboardingMode !== binding.onboardingMode)
  ) {
    throw new VerificationError(
      403,
      "Unable to verify this checkout session",
    );
  }
}

async function assertCustomerBinding(input: {
  checkoutSession: Stripe.Checkout.Session;
  stripeSubscription: Stripe.Subscription;
  userId: string;
}) {
  const checkoutCustomerId = stripeObjectId(input.checkoutSession.customer);
  const subscriptionCustomerId = stripeObjectId(
    input.stripeSubscription.customer,
  );
  if (
    !checkoutCustomerId ||
    !subscriptionCustomerId ||
    checkoutCustomerId !== subscriptionCustomerId
  ) {
    throw new VerificationError(
      403,
      "Unable to verify this checkout session",
    );
  }

  const stored = await prisma.subscription.findUnique({
    where: { userId: input.userId },
    select: { stripeCustomerId: true },
  });
  if (
    stored?.stripeCustomerId &&
    stored.stripeCustomerId !== subscriptionCustomerId
  ) {
    throw new VerificationError(
      403,
      "Unable to verify this checkout session",
    );
  }

  const customer =
    typeof input.stripeSubscription.customer === "string"
      ? await stripe.customers.retrieve(subscriptionCustomerId)
      : input.stripeSubscription.customer;
  if ("deleted" in customer && customer.deleted) {
    throw new VerificationError(409, "Checkout is no longer available");
  }
  const customerUserId = customer.metadata?.userId?.trim();
  if (customerUserId && customerUserId !== input.userId) {
    throw new VerificationError(
      403,
      "Unable to verify this checkout session",
    );
  }
}

async function queueAddWebsiteOnboarding(input: {
  userId: string;
  business: {
    id: string;
    businessWebsiteUrl: string;
    onboardingStatus: string;
  };
  stripeSubscriptionId: string;
}) {
  if (
    ["queued", "running", "awaiting_confirmation", "completed"].includes(
      input.business.onboardingStatus,
    )
  ) {
    return { alreadyQueued: true, queued: false };
  }

  await queueWebsiteOnboardingEvent({
    userId: input.userId,
    businessId: input.business.id,
    websiteUrl: input.business.businessWebsiteUrl,
  });
  return { alreadyQueued: false, queued: true };
}

async function markOnboardingWhenActive(userId: string) {
  const activeBusiness = await prisma.business.findFirst({
    where: {
      userId,
      isActive: true,
      websiteStatus: "active",
      removalStatus: "active",
    },
    select: { id: true },
  });
  if (activeBusiness) {
    await prisma.user.update({
      where: { id: userId },
      data: { onboarding: true },
    });
  }
}

export async function verifyCheckoutSession(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = VERIFY_REQUEST.parse(req.body ?? {});
    if (!isStripeConfigured) {
      return sendError(res, "Billing is temporarily unavailable", 503);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: { email: true },
    });
    if (!user) return sendError(res, "Unauthorized", 401);

    const checkoutSession = await stripe.checkout.sessions.retrieve(
      input.sessionId,
      {
        expand: [
          "customer",
          "payment_intent",
          "payment_intent.latest_charge",
          "subscription",
          "subscription.customer",
        ],
      },
    );
    if (checkoutSession.status !== "complete") {
      throw new VerificationError(
        409,
        "Checkout is still being confirmed",
        "CHECKOUT_PROCESSING",
        { retryable: true },
        3,
      );
    }

    const initialBinding = resolveStripeSessionBinding(
      checkoutSession.metadata,
      null,
    );
    if (!initialBinding || initialBinding.userId !== req.authUserId) {
      throw new VerificationError(
        403,
        "Unable to verify this checkout session",
      );
    }
    assertRequestedContext(input, initialBinding);

    const paidIntroPayment =
      checkoutSession.mode === "payment" &&
      isOnboardingV2TrialMetadata(checkoutSession.metadata);
    if (paidIntroPayment && checkoutSession.payment_status !== "paid") {
      throw new VerificationError(
        402,
        "The introductory payment has not completed",
        "TRIAL_FEE_NOT_PAID",
      );
    }
    if (
      paidIntroPayment &&
      (checkoutSession.amount_total === 0 || !checkoutSession.payment_intent)
    ) {
      throw new VerificationError(
        422,
        "This checkout did not collect a payment method. Please start checkout again.",
        "PAID_INTRO_PAYMENT_METHOD_REQUIRED",
      );
    }

    const stripeSubscription = paidIntroPayment
      ? await ensureOnboardingV2PaidIntroSubscription(stripe, checkoutSession)
      : typeof checkoutSession.subscription === "string"
        ? await stripe.subscriptions.retrieve(checkoutSession.subscription, {
            expand: ["customer"],
          })
        : checkoutSession.subscription;
    if (!stripeSubscription) {
      throw new VerificationError(409, "Checkout is still being confirmed");
    }

    const binding = resolveStripeSessionBinding(
      checkoutSession.metadata,
      stripeSubscription.metadata,
    );
    if (!binding || binding.userId !== req.authUserId) {
      throw new VerificationError(
        403,
        "Unable to verify this checkout session",
      );
    }
    assertRequestedContext(input, binding);
    await assertCustomerBinding({
      checkoutSession,
      stripeSubscription,
      userId: req.authUserId,
    });

    const paidIntroCheckout =
      isOnboardingV2TrialMetadata(checkoutSession.metadata) ||
      isOnboardingV2TrialMetadata(stripeSubscription.metadata);
    if (paidIntroCheckout && checkoutSession.payment_status !== "paid") {
      throw new VerificationError(
        402,
        "The introductory payment has not completed",
        "TRIAL_FEE_NOT_PAID",
      );
    }
    const acceptedInitialPayment =
      checkoutSession.payment_status === "paid" ||
      (checkoutSession.payment_status === "no_payment_required" &&
        ["active", "trialing"].includes(stripeSubscription.status));
    if (!acceptedInitialPayment) {
      throw new VerificationError(
        402,
        "The checkout payment has not completed",
        "CHECKOUT_PAYMENT_INCOMPLETE",
      );
    }

    if (paidIntroCheckout) {
      try {
        await ensureOnboardingV2PaidIntroSchedule(stripe, stripeSubscription);
      } catch (error) {
        console.error("[billing-verify] paid-intro schedule failed", error);
        throw new VerificationError(
          503,
          "Payment was verified, but activation is still being configured",
          "PAID_INTRO_SCHEDULE_FAILED",
          { retryable: true },
          3,
        );
      }
    }

    if (binding.type === "add_website") {
      if (!binding.businessId) {
        throw new VerificationError(403, "Unable to verify this checkout session");
      }
      const business = await prisma.business.findFirst({
        where: {
          id: binding.businessId,
          userId: req.authUserId,
          removalStatus: "active",
        },
        select: {
          id: true,
          businessWebsiteUrl: true,
          onboardingStatus: true,
          onboardingFlow: true,
        },
      });
      if (!business) {
        throw new VerificationError(404, "Website was not found");
      }

      const secondary =
        binding.onboardingMode === "onboarding_v2" &&
        Boolean(binding.quickScrapeBusinessId);
      if (secondary) {
        const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
          where: {
            id: binding.quickScrapeBusinessId!,
            userId: req.authUserId,
            onboardingV2BusinessId: business.id,
            onboardingV2Flow: "website_secondary",
          },
          select: { id: true },
        });
        if (
          !quickBusiness ||
          business.onboardingFlow !== "website_secondary"
        ) {
          throw new VerificationError(
            404,
            "Onboarding context was not found",
          );
        }
      }

      const syncResult = await syncAddWebsiteSubscription({
        userId: req.authUserId,
        businessId: business.id,
        stripeSubscription,
        agencyId:
          checkoutSession.metadata?.agencyId ??
          stripeSubscription.metadata?.agencyId,
        agencyPricingConfigId:
          checkoutSession.metadata?.agencyPricingConfigId ??
          stripeSubscription.metadata?.agencyPricingConfigId,
      });
      await dispatchInitialSocialPlanningForEligibleWebsites(req.authUserId);

      let onboardingQueue = { alreadyQueued: false, queued: false };
      if (!secondary) {
        try {
          onboardingQueue = await queueAddWebsiteOnboarding({
            userId: req.authUserId,
            business,
            stripeSubscriptionId: stripeSubscription.id,
          });
        } catch (error) {
          console.error("[billing-verify] onboarding queue failed", error);
          throw new VerificationError(
            503,
            "Payment was verified, but setup is temporarily unavailable",
            "ADD_WEBSITE_ONBOARDING_QUEUE_FAILED",
            {
              businessId: business.id,
              retryable: true,
              subscriptionSynced: true,
            },
            3,
          );
        }
      }

      await markOnboardingWhenActive(req.authUserId).catch((error) => {
        console.error("[billing-verify] onboarding flag update failed", error);
      });
      await recordRewardfulConversionPreparedForUser({
        conversionEmail: user.email,
        stripeCustomerId: stripeObjectId(stripeSubscription.customer),
        stripeSubscriptionId: stripeSubscription.id,
        userId: req.authUserId,
      });
      await Promise.all([
        invalidateTenantCache(req.authUserId),
        invalidateTenantCache(req.authUserId, business.id),
      ]);

      return sendSuccess(res, {
        status: stripeSubscription.status,
        message: "Website subscription verified and synchronized",
        businessId: business.id,
        planTier: syncResult.planTier,
        ...(secondary
          ? {
              quickScrapeBusinessId: binding.quickScrapeBusinessId,
              onboardingMode: "onboarding_v2",
              resumePath:
                "/dashboard/websites/onboarding/" +
                binding.quickScrapeBusinessId,
            }
          : {}),
        onboardingAlreadyQueued: onboardingQueue.alreadyQueued,
        onboardingQueued: onboardingQueue.queued,
        rewardfulConversion: user.email ? { email: user.email } : null,
      });
    }

    const customerId = stripeObjectId(stripeSubscription.customer);
    if (!customerId) {
      throw new VerificationError(403, "Unable to verify this checkout session");
    }
    await createOrUpdateSubscription(
      req.authUserId,
      customerId,
      stripeSubscription,
    );

    try {
      await syncWebsiteSubscriptions(req.authUserId, stripeSubscription);
      await dispatchInitialSocialPlanningForEligibleWebsites(req.authUserId);
    } catch (error) {
      console.error("[billing-verify] website subscription sync failed", error);
      if (paidIntroCheckout) {
        throw new VerificationError(
          503,
          "Payment was verified, but activation is temporarily unavailable",
          "SUBSCRIPTION_SYNC_FAILED",
          { retryable: true },
          3,
        );
      }
      throw error;
    }
    await markOnboardingWhenActive(req.authUserId).catch((error) => {
      console.error("[billing-verify] onboarding flag update failed", error);
    });

    if (paidIntroCheckout) {
      const lifecycle =
        resolveStripeWebsiteSubscriptionLifecycle(stripeSubscription);
      const now = new Date();
      await prisma.trialAnalytics.upsert({
        where: { userId: req.authUserId },
        create: {
          userId: req.authUserId,
          checkoutStarted: true,
          checkoutCompletedAt: now,
          trialEnrolledAt: now,
        },
        update: {
          checkoutStarted: true,
          checkoutCompletedAt: now,
          trialEnrolledAt: now,
        },
      });
      await invalidateTenantCache(req.authUserId);
      return sendSuccess(res, {
        status: stripeSubscription.status,
        message: "Trial verified and synchronized",
        trial: {
          startDate: lifecycle.trialStartDate?.toISOString() ?? null,
          endDate: lifecycle.trialEndDate?.toISOString() ?? null,
        },
        rewardfulConversion: null,
      });
    }

    const convertedBusinessIds = getStripeMetadataBusinessIds(
      stripeSubscription.metadata,
    );
    await convertTrialToSubscription(
      req.authUserId,
      convertedBusinessIds.length > 0 ? convertedBusinessIds : undefined,
    );
    const now = new Date();
    await prisma.trialAnalytics.upsert({
      where: { userId: req.authUserId },
      create: {
        userId: req.authUserId,
        checkoutStarted: true,
        checkoutCompletedAt: now,
        converted: true,
        convertedAt: now,
        trialOutcome: "converted",
      },
      update: {
        checkoutCompletedAt: now,
        converted: true,
        convertedAt: now,
        trialOutcome: "converted",
      },
    });
    await recordRewardfulConversionPreparedForUser({
      conversionEmail: user.email,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSubscription.id,
      userId: req.authUserId,
    });
    await invalidateTenantCache(req.authUserId);

    return sendSuccess(res, {
      status: stripeSubscription.status,
      message: "Subscription verified and synchronized",
      rewardfulConversion: user.email ? { email: user.email } : null,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    if (error instanceof VerificationError) {
      if (error.retryAfterSeconds) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      return sendError(
        res,
        error.publicMessage,
        error.status,
        error.details ?? (error.code ? { code: error.code } : undefined),
      );
    }
    console.error("[billing-verify] checkout verification failed", error);
    return sendError(res, "Checkout verification failed", 500);
  }
}
