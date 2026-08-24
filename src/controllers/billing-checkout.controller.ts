import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import type { Response } from "express";
import Stripe from "stripe";
import { z, ZodError } from "zod";

import { BRAND } from "../config/brand.config";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { resolveSubscriptionPrice } from "../services/agency-pricing.service";
import {
  ensureSecondaryOnboardingV2Initialized,
  queueWebsiteOnboardingEvent,
} from "./website.controller";
import {
  resolveAgencyAssignmentForRequest,
  type AgencyAssignment,
} from "../utils/agency-context.utils";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";

const ONBOARDING_V2_TRIAL_DAYS = 3;
const ONBOARDING_V2_TRIAL_FEE_CENTS = 300;
const ONBOARDING_V2_PAID_INTRO_MODE = "one_time_fee_anchor_v2";
const CANONICAL_ONBOARDING_PATH = "dashboard/onboarding";
const REWARDFUL_METADATA_LIMIT = 500;
const REWARDFUL_RAW_LIMIT = 8_192;

const optionalAttributionString = z.string().trim().max(500).nullable().optional();
const rewardfulAttributionSchema = z
  .object({
    referralId: optionalAttributionString,
    via: optionalAttributionString,
    affiliateId: optionalAttributionString,
    affiliateToken: optionalAttributionString,
    affiliateName: optionalAttributionString,
    affiliateFirstName: optionalAttributionString,
    affiliateLastName: optionalAttributionString,
    campaignId: optionalAttributionString,
    campaignName: optionalAttributionString,
    couponId: optionalAttributionString,
    couponName: optionalAttributionString,
    landingUrl: z.string().trim().max(2_048).nullable().optional(),
    capturedAt: z.string().datetime({ offset: true }).nullable().optional(),
    raw: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const checkoutRequestSchema = z
  .object({
    checkoutFlow: z.literal("onboarding_v2_trial").optional(),
    planTier: z.enum(["SEO", "SEO_SOCIAL"]).optional(),
    billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
    quickScrapeBusinessId: z.string().uuid().optional(),
    successPath: z
      .enum([
        "/dashboard/home",
        "/dashboard/account",
        "/dashboard/onboarding",
        "/dashboard/onboarding-quick",
        "/dashboard/onboarding-v2",
      ])
      .optional(),
    rewardfulAttribution: rewardfulAttributionSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.checkoutFlow === "onboarding_v2_trial" && !value.planTier) {
      context.addIssue({
        code: "custom",
        path: ["planTier"],
        message: "Choose a supported plan",
      });
    }
    if (
      value.checkoutFlow === "onboarding_v2_trial" &&
      !value.quickScrapeBusinessId
    ) {
      context.addIssue({
        code: "custom",
        path: ["quickScrapeBusinessId"],
        message: "Onboarding context is required",
      });
    }
    if (value.rewardfulAttribution?.raw) {
      const serialized = JSON.stringify(value.rewardfulAttribution.raw);
      if (serialized.length > REWARDFUL_RAW_LIMIT) {
        context.addIssue({
          code: "custom",
          path: ["rewardfulAttribution", "raw"],
          message: "Attribution context is too large",
        });
      }
    }
  });

const addWebsiteCheckoutRequestSchema = z
  .object({
    businessId: z.string().uuid(),
    billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
    checkoutAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,100}$/)
      .optional(),
    quickScrapeBusinessId: z.string().uuid().optional(),
    onboardingMode: z.literal("onboarding_v2").optional(),
    planTier: z.enum(["SEO", "SEO_SOCIAL"]).default("SEO"),
    rewardfulAttribution: rewardfulAttributionSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.onboardingMode === "onboarding_v2" && !value.quickScrapeBusinessId) {
      context.addIssue({
        code: "custom",
        path: ["quickScrapeBusinessId"],
        message: "Onboarding context is required",
      });
    }
    if (value.rewardfulAttribution?.raw) {
      const serialized = JSON.stringify(value.rewardfulAttribution.raw);
      if (serialized.length > REWARDFUL_RAW_LIMIT) {
        context.addIssue({
          code: "custom",
          path: ["rewardfulAttribution", "raw"],
          message: "Attribution context is too large",
        });
      }
    }
  });

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
    })
  : null;

type CheckoutInput = z.infer<typeof checkoutRequestSchema>;
type PlanTier = "SEO" | "SEO_SOCIAL";
type BillingPeriod = "monthly" | "yearly";

class CheckoutError extends Error {
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

function cleanOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function formatStripeAmount(amount: number | null, currency: string): string {
  if (amount === null) return "the selected plan price";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);
}

function frontendOrigin(): string {
  try {
    const url = new URL(BRAND.frontendUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported frontend URL protocol");
    }
    return url.origin;
  } catch {
    throw new CheckoutError(503, "Checkout is temporarily unavailable");
  }
}

function planPriceDefaults(planTier: PlanTier) {
  const social = planTier === "SEO_SOCIAL";
  return {
    monthly: {
      stripePriceId: social
        ? process.env.UPLIFT_SEO_SOCIAL_PRICE_ID ?? ""
        : process.env.UPLIFT_PLAN_PRICE_ID ?? "",
      priceCents: social ? 14_900 : 9_900,
    },
    yearly: {
      stripePriceId: social
        ? process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID ?? ""
        : process.env.UPLIFT_YEARLY_PRICE_ID ?? "",
      priceCents: social ? 149_000 : 99_000,
    },
  };
}

function websitePlanPriceDefaults(planTier: PlanTier) {
  if (planTier === "SEO_SOCIAL") return planPriceDefaults(planTier);
  return {
    monthly: {
      stripePriceId:
        process.env.WEBSITE_PRICE_ID ?? process.env.UPLIFT_PLAN_PRICE_ID ?? "",
      priceCents: 9_900,
    },
    yearly: {
      stripePriceId:
        process.env.WEBSITE_YEARLY_PRICE_ID ??
        process.env.UPLIFT_YEARLY_PRICE_ID ??
        "",
      priceCents: 99_000,
    },
  };
}

function ownershipType(
  businessOwnership: string,
  agencySlug: string | null | undefined,
): "agency_managed" | "uplift_direct" {
  return businessOwnership === "agency_managed" ||
    (agencySlug && agencySlug !== "uplift-direct")
    ? "agency_managed"
    : "uplift_direct";
}

function buildServicesPriority(services: string[]): Record<string, number> {
  return services.reduce<Record<string, number>>((result, service, index) => {
    const cleaned = service.trim();
    if (cleaned) result[cleaned] = index + 1;
    return result;
  }, {});
}

function quickLocationData(
  quickBusiness: {
    businessPhone: string | null;
    businessAddress: string | null;
    businessCity: string | null;
    businessState: string | null;
    businessCountry: string | null;
    serviceArea: string | null;
    serviceAreaLocations: string[];
  },
  includeEmpty = false,
) {
  const strings = {
    businessPhone: cleanOptionalString(quickBusiness.businessPhone),
    businessAddress: cleanOptionalString(quickBusiness.businessAddress),
    businessCity: cleanOptionalString(quickBusiness.businessCity),
    businessState: cleanOptionalString(quickBusiness.businessState),
    businessCountry: cleanOptionalString(quickBusiness.businessCountry),
    serviceArea: cleanOptionalString(quickBusiness.serviceArea),
  };
  const serviceAreaLocations = quickBusiness.serviceAreaLocations
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 25);

  if (includeEmpty) return { ...strings, serviceAreaLocations };

  return {
    ...Object.fromEntries(
      Object.entries(strings).filter(([, value]) => value !== null),
    ),
    ...(serviceAreaLocations.length > 0 ? { serviceAreaLocations } : {}),
  };
}

function hasRewardfulIdentity(
  attribution: NonNullable<CheckoutInput["rewardfulAttribution"]>,
) {
  return Boolean(
    attribution.referralId ||
      attribution.via ||
      attribution.affiliateId ||
      attribution.affiliateToken ||
      attribution.campaignId ||
      attribution.couponId,
  );
}

function isReferralIdConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "P2002";
}

async function storeRewardfulAttribution(
  userId: string,
  userEmail: string,
  attribution: CheckoutInput["rewardfulAttribution"],
) {
  if (!attribution || !hasRewardfulIdentity(attribution)) return null;

  if (attribution.referralId) {
    const existing = await prisma.rewardfulAttribution.findUnique({
      where: { referralId: attribution.referralId },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) return null;
  }

  const capturedAt = attribution.capturedAt
    ? new Date(attribution.capturedAt)
    : new Date();
  const data = {
    referralId: cleanOptionalString(attribution.referralId),
    via: cleanOptionalString(attribution.via),
    affiliateId: cleanOptionalString(attribution.affiliateId),
    affiliateToken: cleanOptionalString(attribution.affiliateToken),
    affiliateName: cleanOptionalString(attribution.affiliateName),
    affiliateFirstName: cleanOptionalString(attribution.affiliateFirstName),
    affiliateLastName: cleanOptionalString(attribution.affiliateLastName),
    campaignId: cleanOptionalString(attribution.campaignId),
    campaignName: cleanOptionalString(attribution.campaignName),
    couponId: cleanOptionalString(attribution.couponId),
    couponName: cleanOptionalString(attribution.couponName),
    landingUrl: cleanOptionalString(attribution.landingUrl),
    capturedAt,
    conversionEmail: userEmail,
    lastSeenAt: new Date(),
    ...(attribution.raw
      ? { raw: attribution.raw as Prisma.InputJsonValue }
      : {}),
  };

  try {
    return await prisma.rewardfulAttribution.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  } catch (error) {
    // A referral is globally unique. A concurrent attribution collision is
    // optional marketing data and must never move the referral or block billing.
    if (!isReferralIdConflict(error)) throw error;
    return null;
  }
}

export async function persistRewardfulAttribution(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const attribution = rewardfulAttributionSchema.parse(req.body ?? {});
    if (!hasRewardfulIdentity(attribution)) {
      return sendSuccess(res, {
        persisted: false,
        skipped: true,
        reason: "missing-attribution",
      });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: { email: true },
    });
    if (!user?.email) return sendError(res, "Unauthorized", 401);

    const stored = await storeRewardfulAttribution(
      req.authUserId,
      user.email,
      attribution,
    );
    return sendSuccess(res, {
      persisted: Boolean(stored),
      attributionId: stored?.id ?? null,
    });
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[rewardful-attribution] persistence failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}

function rewardfulMetadataValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, REWARDFUL_METADATA_LIMIT)
    : null;
}

async function rewardfulMetadata(userId: string): Promise<Record<string, string>> {
  const attribution = await prisma.rewardfulAttribution.findUnique({
    where: { userId },
  });
  if (!attribution) return {};

  const metadata: Record<string, string> = { rewardfulAttribution: "true" };
  const fields: Array<[string, unknown]> = [
    ["rewardfulReferralId", attribution.referralId],
    ["rewardfulVia", attribution.via],
    ["rewardfulAffiliateId", attribution.affiliateId],
    ["rewardfulAffiliateToken", attribution.affiliateToken],
    ["rewardfulAffiliateName", attribution.affiliateName],
    ["rewardfulCampaignId", attribution.campaignId],
    ["rewardfulCampaignName", attribution.campaignName],
    ["rewardfulCouponId", attribution.couponId],
    ["rewardfulCouponName", attribution.couponName],
  ];
  for (const [key, value] of fields) {
    const cleaned = rewardfulMetadataValue(value);
    if (cleaned) metadata[key] = cleaned;
  }
  return metadata;
}

function isMissingStripeCustomer(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    param?: unknown;
    type?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    candidate.code === "resource_missing" && candidate.param === "customer"
  ) || message.includes("no such customer");
}

async function prepareStripeCustomer(
  stripeClient: Stripe,
  userId: string,
  email: string,
  metadata: Record<string, string>,
) {
  const account = await prisma.subscription.findUnique({
    where: { userId },
    select: { stripeCustomerId: true },
  });
  let customerId: string | null = null;

  if (account?.stripeCustomerId) {
    try {
      const existing = await stripeClient.customers.retrieve(
        account.stripeCustomerId,
      );
      if (!("deleted" in existing && existing.deleted)) {
        const boundUserId = existing.metadata?.userId?.trim();
        if (boundUserId && boundUserId !== userId) {
          throw new CheckoutError(403, "Checkout is unavailable");
        }
        await stripeClient.customers.update(account.stripeCustomerId, {
          email,
          metadata: { userId, ...metadata },
        });
        customerId = account.stripeCustomerId;
      }
    } catch (error) {
      if (error instanceof CheckoutError) throw error;
      if (!isMissingStripeCustomer(error)) throw error;
    }
  }

  if (!customerId) {
    const customer = await stripeClient.customers.create({
      email,
      metadata: { userId, ...metadata },
    });
    customerId = customer.id;
    await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        stripeCustomerId: customerId,
        status: "incomplete",
        startDate: new Date(),
      },
      update: { stripeCustomerId: customerId },
    });
  }

  const customer = await stripeClient.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) {
    throw new CheckoutError(503, "Checkout is temporarily unavailable");
  }
  if (customer.discount) {
    await stripeClient.customers.deleteDiscount(customerId);
    return { customerId, removedExistingDiscount: true };
  }
  return { customerId, removedExistingDiscount: false };
}

async function resolveCheckoutBusiness(
  req: AuthenticatedRequest,
  input: CheckoutInput,
  assignment: AgencyAssignment,
) {
  const userId = req.authUserId!;
  const onboardingTrial = input.checkoutFlow === "onboarding_v2_trial";

  if (input.quickScrapeBusinessId) {
    const quick = await prisma.quickScrapeBusiness.findFirst({
      where: { id: input.quickScrapeBusinessId, userId },
    });
    if (!quick) throw new CheckoutError(404, "Onboarding context was not found");
    if (
      onboardingTrial &&
      (!quick.onboardingV2LastSeenAt ||
        quick.onboardingV2Step !== "payment" ||
        quick.onboardingV2Status !== "awaiting_payment" ||
        quick.onboardingV2BlogStatus !== "complete" ||
        quick.onboardingV2SocialStatus !== "complete")
    ) {
      throw new CheckoutError(409, "Onboarding preview is not ready");
    }

    if (onboardingTrial) {
      await prisma.quickScrapeBusiness.update({
        where: { id: quick.id },
        data: { onboardingV2SelectedPlanTier: input.planTier! },
      });
    }

    const selectedServices = quick.selectedServices
      .map((service) => service.trim())
      .filter(Boolean)
      .slice(0, 100);
    const detectedServices = quick.detectedServices
      .map((service) => service.trim())
      .filter(Boolean)
      .slice(0, 100);
    const servicesPriority =
      quick.servicesPriority &&
      typeof quick.servicesPriority === "object" &&
      !Array.isArray(quick.servicesPriority)
        ? quick.servicesPriority
        : buildServicesPriority(selectedServices);
    const existing = quick.onboardingV2BusinessId
      ? await prisma.business.findFirst({
          where: {
            id: quick.onboardingV2BusinessId,
            userId,
            removalStatus: "active",
          },
        })
      : await prisma.business.findFirst({
          where: {
            userId,
            businessWebsiteUrl: quick.businessWebsiteUrl,
            removalStatus: "active",
          },
        });

    if (onboardingTrial && !existing) {
      throw new CheckoutError(409, "Onboarding workspace is unavailable");
    }
    if (existing) {
      return prisma.business.update({
        where: { id: existing.id },
        data: {
          agencyId: existing.agencyId ?? assignment.agencyId,
          ownershipType:
            existing.agencyId === null
              ? assignment.ownershipType
              : existing.ownershipType,
          onboardedByUserId: existing.onboardedByUserId ?? userId,
          selectedServices,
          servicesPriority,
          detectedServices,
          ...quickLocationData(quick),
        },
        include: { agency: { select: { slug: true, isActive: true } } },
      });
    }

    return prisma.business.create({
      data: {
        userId,
        businessName: quick.businessName || "My Business",
        businessType: quick.businessType || "General",
        businessWebsiteUrl: quick.businessWebsiteUrl,
        businessDescription: "",
        websiteStatus: "pending",
        isPrimary: true,
        isActive: true,
        selectedServices,
        servicesPriority,
        detectedServices,
        ...quickLocationData(quick, true),
        agencyId: assignment.agencyId,
        ownershipType: assignment.ownershipType,
        onboardedByUserId: userId,
      },
      include: { agency: { select: { slug: true, isActive: true } } },
    });
  }

  const primary = await prisma.business.findFirst({
    where: { userId, removalStatus: "active" },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    include: { agency: { select: { slug: true, isActive: true } } },
  });
  if (!primary) throw new CheckoutError(404, "Business context was not found");
  if (primary.agencyId) return primary;

  return prisma.business.update({
    where: { id: primary.id },
    data: {
      agencyId: assignment.agencyId,
      ownershipType: assignment.ownershipType,
      onboardedByUserId: primary.onboardedByUserId ?? userId,
    },
    include: { agency: { select: { slug: true, isActive: true } } },
  });
}

async function verifiedRecurringPrice(
  stripeClient: Stripe,
  priceId: string,
  expectedAmount: number,
  expectedCurrency: string,
  billingPeriod: BillingPeriod,
) {
  const price = await stripeClient.prices.retrieve(priceId);
  const expectedInterval = billingPeriod === "yearly" ? "year" : "month";
  if (
    !price.active ||
    price.type !== "recurring" ||
    price.unit_amount !== expectedAmount ||
    price.currency.toLowerCase() !== expectedCurrency.toLowerCase() ||
    price.recurring?.interval !== expectedInterval ||
    price.recurring.interval_count !== 1
  ) {
    throw new CheckoutError(503, "Checkout is temporarily unavailable");
  }
  return price;
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function subscriptionItemForBusiness(
  subscription: Stripe.Subscription,
  businessId: string,
  storedItemId?: string | null,
): Stripe.SubscriptionItem {
  if (storedItemId) {
    const stored = subscription.items.data.find((item) => item.id === storedItemId);
    if (!stored) throw new CheckoutError(403, "Checkout is unavailable");
    const boundBusinessId = stored.metadata?.businessId?.trim();
    if (boundBusinessId && boundBusinessId !== businessId) {
      throw new CheckoutError(403, "Checkout is unavailable");
    }
    return stored;
  }
  const metadataMatch = subscription.items.data.find(
    (item) => item.metadata?.businessId?.trim() === businessId,
  );
  if (metadataMatch) return metadataMatch;
  if (subscription.items.data.length === 1) return subscription.items.data[0]!;
  throw new CheckoutError(403, "Checkout is unavailable");
}

function subscriptionItemDate(
  item: Stripe.SubscriptionItem,
  key: "current_period_start" | "current_period_end",
): Date | null {
  const seconds = (item as Stripe.SubscriptionItem & {
    current_period_start?: number | null;
    current_period_end?: number | null;
  })[key];
  return typeof seconds === "number" ? new Date(seconds * 1_000) : null;
}

function addWebsitePlanTier(
  subscription: Stripe.Subscription,
  item: Stripe.SubscriptionItem,
): PlanTier {
  const metadataTier = subscription.metadata?.planTier;
  if (metadataTier === "SEO" || metadataTier === "SEO_SOCIAL") {
    return metadataTier;
  }
  return [
    process.env.UPLIFT_SEO_SOCIAL_PRICE_ID,
    process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID,
  ].includes(item.price.id)
    ? "SEO_SOCIAL"
    : "SEO";
}

function assertAddWebsiteSubscriptionBinding(input: {
  subscription: Stripe.Subscription;
  userId: string;
  businessId: string;
  customerId: string;
}) {
  const { subscription, userId, businessId, customerId } = input;
  if (
    subscription.metadata?.userId?.trim() !== userId ||
    subscription.metadata?.businessId?.trim() !== businessId ||
    subscription.metadata?.type?.trim() !== "add_website" ||
    subscriptionCustomerId(subscription) !== customerId
  ) {
    throw new CheckoutError(403, "Checkout is unavailable");
  }
}

async function syncAddWebsiteSubscriptionOnBackend(input: {
  subscription: Stripe.Subscription;
  userId: string;
  business: {
    id: string;
    agencyId: string | null;
    onboardingFlow: "trial_primary" | "website_secondary" | null;
    onboardingStatus: string;
    removalStatus: string;
    stripeSubscriptionItemId: string | null;
  };
  agencyPricingConfigId?: string | null;
}) {
  const { subscription, userId, business } = input;
  if (business.removalStatus !== "active") {
    throw new CheckoutError(409, "Website billing is unavailable");
  }
  const existing = await prisma.websiteSubscription.findUnique({
    where: { businessId: business.id },
    select: {
      stripeSubscriptionItemId: true,
      planTier: true,
    },
  });
  const item = subscriptionItemForBusiness(
    subscription,
    business.id,
    existing?.stripeSubscriptionItemId ?? business.stripeSubscriptionItemId,
  );
  const planTier = addWebsitePlanTier(subscription, item);
  const status = subscription.status === "trialing"
    ? "trialing"
    : subscription.status === "active"
      ? "active"
      : subscription.status === "past_due"
        ? "past_due"
        : subscription.status === "canceled" ||
            subscription.status === "incomplete_expired"
          ? "canceled"
          : "suspended";
  const currentPeriodStart = subscriptionItemDate(item, "current_period_start");
  const currentPeriodEnd = subscriptionItemDate(item, "current_period_end");
  const trialStartDate =
    typeof subscription.trial_start === "number"
      ? new Date(subscription.trial_start * 1_000)
      : null;
  const trialEndDate =
    typeof subscription.trial_end === "number"
      ? new Date(subscription.trial_end * 1_000)
      : null;
  const deferSecondaryActivation =
    business.onboardingFlow === "website_secondary" &&
    business.onboardingStatus !== "completed" &&
    ["active", "trialing"].includes(status);
  const businessStatus = deferSecondaryActivation
    ? "pending"
    : status === "trialing"
      ? "trial"
      : status;
  const pricingConfigId = input.agencyPricingConfigId
    ? (
        await prisma.agencyPricingConfig.findFirst({
          where: {
            id: input.agencyPricingConfigId,
            agencyId: business.agencyId ?? "",
            isActive: true,
            planTier,
            agency: { isActive: true },
          },
          select: { id: true },
        })
      )?.id ?? null
    : null;

  await prisma.$transaction(async (transaction) => {
    await transaction.websiteSubscription.upsert({
      where: { businessId: business.id },
      create: {
        businessId: business.id,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionItemId: item.id,
        stripePriceId: item.price.id,
        planTier,
        status,
        trialStatus: subscription.status === "trialing" ? "trialing" : "converted",
        trialStartDate,
        trialEndDate,
        currentPeriodStart: currentPeriodStart ?? new Date(),
        currentPeriodEnd,
        agencyId: business.agencyId,
        agencyPricingConfigId: pricingConfigId,
      },
      update: {
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionItemId: item.id,
        stripePriceId: item.price.id,
        planTier,
        status,
        trialStatus: subscription.status === "trialing" ? "trialing" : "converted",
        trialStartDate,
        trialEndDate,
        currentPeriodStart: currentPeriodStart ?? new Date(),
        currentPeriodEnd,
        agencyId: business.agencyId,
        agencyPricingConfigId: pricingConfigId,
      },
    });
    await transaction.business.update({
      where: { id: business.id },
      data: {
        stripeSubscriptionItemId: item.id,
        websiteStatus: businessStatus,
        isActive:
          !deferSecondaryActivation &&
          (status === "active" || status === "trialing"),
        ...(deferSecondaryActivation ? { isPrimary: false } : {}),
      },
    });
    const websiteCount = await transaction.websiteSubscription.count({
      where: {
        business: { userId, removalStatus: "active" },
        status: { in: ["active", "trialing"] },
      },
    });
    await transaction.subscription.updateMany({
      where: { userId },
      data: { websiteCount },
    });
  });

  return { planTier, websiteStatus: businessStatus };
}

async function queueRecoveredWebsiteOnboarding(input: {
  userId: string;
  business: {
    id: string;
    businessWebsiteUrl: string;
    onboardingFlow: "trial_primary" | "website_secondary" | null;
    onboardingStatus: string;
  };
  isSecondaryOnboardingV2: boolean;
}) {
  if (input.isSecondaryOnboardingV2) {
    const initialized = await ensureSecondaryOnboardingV2Initialized({
      businessId: input.business.id,
    });
    return {
      alreadyQueued: initialized.alreadyQueued,
      queued: true,
      quickScrapeBusinessId: initialized.quickScrapeBusinessId,
    };
  }
  if (["queued", "running", "awaiting_confirmation", "completed"].includes(
    input.business.onboardingStatus,
  )) {
    return { alreadyQueued: true, queued: false };
  }
  await queueWebsiteOnboardingEvent({
    userId: input.userId,
    businessId: input.business.id,
    websiteUrl: input.business.businessWebsiteUrl,
  });
  return { alreadyQueued: false, queued: true };
}

export async function createPrimaryCheckoutSession(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = checkoutRequestSchema.parse(req.body ?? {});
    if (!stripe) return sendError(res, "Checkout is temporarily unavailable", 503);

    const onboardingTrial = input.checkoutFlow === "onboarding_v2_trial";
    if (
      onboardingTrial &&
      process.env.ONBOARDING_V2_STRIPE_TRIAL_ENABLED !== "true"
    ) {
      return sendError(res, "Checkout is temporarily unavailable", 503);
    }
    const paidTrialPriceId =
      process.env.ONBOARDING_V2_PAID_TRIAL_PRICE_ID?.trim() ?? "";
    if (onboardingTrial && !paidTrialPriceId) {
      return sendError(res, "Checkout is temporarily unavailable", 503);
    }

    const [
      user,
      existingSubscription,
      existingWebsiteSubscriptions,
      assignment,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.authUserId },
        select: { email: true, trialUsed: true },
      }),
      prisma.subscription.findUnique({
        where: { userId: req.authUserId },
        select: { stripeSubscriptionId: true },
      }),
      prisma.websiteSubscription.findMany({
        where: {
          business: { userId: req.authUserId },
          stripeSubscriptionId: { not: null },
        },
        select: { stripeSubscriptionId: true },
        take: 25,
      }),
      resolveAgencyAssignmentForRequest(req),
    ]);
    if (!user?.email) return sendError(res, "Unauthorized", 401);
    const knownStripeSubscriptionIds = Array.from(
      new Set(
        [
          existingSubscription?.stripeSubscriptionId,
          ...existingWebsiteSubscriptions.map(
            (subscription) => subscription.stripeSubscriptionId,
          ),
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    for (const stripeSubscriptionId of knownStripeSubscriptionIds) {
      try {
        const liveSubscription = await stripe.subscriptions.retrieve(
          stripeSubscriptionId,
        );
        const boundUserId = liveSubscription.metadata?.userId?.trim();
        if (boundUserId && boundUserId !== req.authUserId) {
          throw new CheckoutError(403, "Checkout is unavailable");
        }
        if (["active", "trialing"].includes(liveSubscription.status)) {
          return sendError(res, "An active subscription already exists", 409);
        }
      } catch (error) {
        if (error instanceof CheckoutError) throw error;
        const candidate = error as { code?: unknown; message?: unknown };
        const missing =
          candidate.code === "resource_missing" ||
          (typeof candidate.message === "string" &&
            candidate.message.toLowerCase().includes("no such subscription"));
        if (!missing) throw error;
      }
    }
    if (onboardingTrial && user.trialUsed) {
      return sendError(res, "The introductory checkout is unavailable", 409);
    }

    await storeRewardfulAttribution(
      req.authUserId,
      user.email,
      input.rewardfulAttribution,
    );
    const business = await resolveCheckoutBusiness(req, input, assignment);
    const planTier: PlanTier = input.planTier ?? "SEO";
    const pricing = await resolveSubscriptionPrice(
      business.agencyId,
      input.billingPeriod,
      planPriceDefaults(planTier),
      planTier,
    );
    if (!pricing.stripePriceId) {
      throw new CheckoutError(503, "Checkout is temporarily unavailable");
    }

    const recurringPrice = await verifiedRecurringPrice(
      stripe,
      pricing.stripePriceId,
      pricing.priceCents,
      pricing.currency,
      input.billingPeriod,
    );
    let paidTrialPrice: Stripe.Price | null = null;
    if (onboardingTrial) {
      paidTrialPrice = await stripe.prices.retrieve(paidTrialPriceId);
      if (
        !paidTrialPrice.active ||
        paidTrialPrice.type !== "one_time" ||
        paidTrialPrice.unit_amount !== ONBOARDING_V2_TRIAL_FEE_CENTS ||
        paidTrialPrice.currency !== recurringPrice.currency ||
        paidTrialPrice.livemode !== recurringPrice.livemode
      ) {
        throw new CheckoutError(503, "Checkout is temporarily unavailable");
      }
    }

    const agencyOwnership = ownershipType(
      business.ownershipType,
      business.agency?.isActive ? business.agency.slug : null,
    );
    const metadata: Record<string, string> = {
      userId: req.authUserId,
      businessId: business.id,
      primaryBusinessId: business.id,
      planTier,
      ownershipType: agencyOwnership,
    };
    if (business.agencyId) metadata.agencyId = business.agencyId;
    if (pricing.agencyPricingConfigId) {
      metadata.agencyPricingConfigId = pricing.agencyPricingConfigId;
    }
    if (onboardingTrial) {
      metadata.type = "onboarding_v2_trial";
      metadata.checkoutFlow = "onboarding_v2_trial";
      metadata.quickScrapeBusinessId = input.quickScrapeBusinessId!;
      metadata.trialDays = String(ONBOARDING_V2_TRIAL_DAYS);
      metadata.trialFeeAmountCents = String(ONBOARDING_V2_TRIAL_FEE_CENTS);
      metadata.trialFeePriceId = paidTrialPriceId;
      metadata.recurringPriceId = pricing.stripePriceId;
      metadata.paidIntroMode = ONBOARDING_V2_PAID_INTRO_MODE;
    }
    const affiliateMetadata = await rewardfulMetadata(req.authUserId);
    Object.assign(metadata, affiliateMetadata);

    const { customerId } = await prepareStripeCustomer(
      stripe,
      req.authUserId,
      user.email,
      affiliateMetadata,
    );
    const baseUrl = frontendOrigin();
    const successPath = onboardingTrial
      ? CANONICAL_ONBOARDING_PATH
      : (input.successPath ?? "/dashboard/home").replace(/^\//, "");
    const successUrl = `${baseUrl}/${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/${successPath}?canceled=true`;
    const checkoutPayload = {
      customer: customerId,
      ...(affiliateMetadata.rewardfulReferralId
        ? { client_reference_id: affiliateMetadata.rewardfulReferralId }
        : {}),
      mode: onboardingTrial ? "payment" : "subscription",
      payment_method_types: ["card"],
      // The paid-intro flow must collect a reusable card through its $3
      // PaymentIntent. A 100% promotion makes Checkout complete at $0 without
      // creating either a PaymentIntent or payment method, so the recurring
      // subscription cannot be provisioned safely.
      allow_promotion_codes: !onboardingTrial,
      line_items: [
        {
          price: onboardingTrial ? paidTrialPriceId : pricing.stripePriceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      ...(onboardingTrial
        ? {
            payment_intent_data: {
              metadata,
              setup_future_usage: "off_session" as const,
            },
            custom_text: {
              submit: {
                message: `$3 is charged today for your 3-day paid trial. Your selected ${planTier === "SEO_SOCIAL" ? "SEO + Social" : "SEO"} plan then starts automatically at ${formatStripeAmount(recurringPrice.unit_amount, recurringPrice.currency)}/${input.billingPeriod === "yearly" ? "year" : "month"} unless canceled.`,
              },
            },
          }
        : { subscription_data: { metadata } }),
    } satisfies Stripe.Checkout.SessionCreateParams;
    const priceFingerprint = crypto
      .createHash("sha256")
      .update(`${pricing.stripePriceId}:${paidTrialPriceId}`)
      .digest("hex")
      .slice(0, 16);
    const session = await stripe.checkout.sessions.create(
      checkoutPayload,
      onboardingTrial
        ? {
            // v3 intentionally invalidates any v2 Checkout Session that could
            // have completed at $0 before paid-intro promotions were disabled.
            idempotencyKey: `onboarding-v2-paid-intro-v3:${input.quickScrapeBusinessId}:${planTier}:${input.billingPeriod}:${priceFingerprint}`,
          }
        : {
            idempotencyKey: `primary-checkout-v2:${req.authUserId}:${business.id}:${planTier}:${input.billingPeriod}:${Math.floor(Date.now() / 600_000)}`,
          },
    );
    if (!session.url) {
      throw new CheckoutError(503, "Checkout is temporarily unavailable");
    }
    try {
      const checkoutUrl = new URL(session.url);
      if (checkoutUrl.protocol !== "https:") {
        throw new Error("Stripe returned a non-HTTPS checkout URL");
      }
    } catch {
      throw new CheckoutError(503, "Checkout is temporarily unavailable");
    }

    await Promise.all([
      prisma.rewardfulAttribution.updateMany({
        where: { userId: req.authUserId },
        data: {
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: customerId,
          lastSeenAt: new Date(),
        },
      }),
      prisma.trialAnalytics
        .upsert({
          where: { userId: req.authUserId },
          create: { userId: req.authUserId, checkoutStarted: true },
          update: { checkoutStarted: true },
        })
        .catch(() => null),
    ]);

    return sendSuccess(res, { url: session.url }, "Checkout session created");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof CheckoutError) {
      return sendError(res, error.publicMessage, error.status);
    }
    console.error("[billing] checkout session failed", error);
    return sendError(res, "Checkout is temporarily unavailable", 503);
  }
}

function isMissingStripeSubscription(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "resource_missing" ||
    (typeof candidate.message === "string" &&
      candidate.message.toLowerCase().includes("no such subscription"))
  );
}

function checkoutSessionCustomerId(session: Stripe.Checkout.Session): string | null {
  if (!session.customer) return null;
  return typeof session.customer === "string"
    ? session.customer
    : session.customer.id;
}

function secureStripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function createAddWebsiteCheckoutSession(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = addWebsiteCheckoutRequestSchema.parse(req.body ?? {});

    const [user, assignment] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.authUserId },
        select: { email: true },
      }),
      resolveAgencyAssignmentForRequest(req),
    ]);
    if (!user?.email) return sendError(res, "Unauthorized", 401);

    let business = await prisma.business.findFirst({
      where: {
        id: input.businessId,
        userId: req.authUserId,
        removalStatus: "active",
      },
      include: {
        agency: { select: { slug: true, isActive: true } },
        websiteSubscription: true,
      },
    });
    if (!business) return sendError(res, "Website not found", 404);

    const secondary = input.onboardingMode === "onboarding_v2";
    if (secondary) {
      const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
        where: {
          id: input.quickScrapeBusinessId,
          userId: req.authUserId,
          onboardingV2BusinessId: business.id,
          onboardingV2Flow: "website_secondary",
          onboardingV2Status: { not: "completed" },
        },
        select: { id: true },
      });
      if (
        !quickBusiness ||
        business.isPrimary ||
        business.onboardingFlow !== "website_secondary"
      ) {
        return sendError(res, "Onboarding context was not found", 404);
      }
    }

    if (!business.agencyId) {
      business = await prisma.business.update({
        where: { id: business.id },
        data: {
          agencyId: assignment.agencyId,
          ownershipType: assignment.ownershipType,
          onboardedByUserId: business.onboardedByUserId ?? req.authUserId,
        },
        include: {
          agency: { select: { slug: true, isActive: true } },
          websiteSubscription: true,
        },
      });
    }
    if (!stripe) return sendError(res, "Checkout is temporarily unavailable", 503);

    await storeRewardfulAttribution(
      req.authUserId,
      user.email,
      input.rewardfulAttribution,
    );
    const affiliateMetadata = await rewardfulMetadata(req.authUserId);
    const { customerId, removedExistingDiscount } = await prepareStripeCustomer(
      stripe,
      req.authUserId,
      user.email,
      affiliateMetadata,
    );
    const existingWebsiteSubscription = business.websiteSubscription;
    if (
      existingWebsiteSubscription &&
      !existingWebsiteSubscription.stripeSubscriptionId &&
      ["active", "trialing", "incomplete", "past_due", "paused", "unpaid"].includes(
        existingWebsiteSubscription.status,
      )
    ) {
      throw new CheckoutError(
        409,
        "This website has billing state requiring recovery",
        "SUBSCRIPTION_REQUIRES_RECOVERY",
      );
    }
    if (existingWebsiteSubscription?.stripeSubscriptionId) {
      try {
        const live = await stripe.subscriptions.retrieve(
          existingWebsiteSubscription.stripeSubscriptionId,
        );
        assertAddWebsiteSubscriptionBinding({
          subscription: live,
          userId: req.authUserId,
          businessId: business.id,
          customerId,
        });
        if (["active", "trialing"].includes(live.status)) {
          const synced = await syncAddWebsiteSubscriptionOnBackend({
            subscription: live,
            userId: req.authUserId,
            business,
            agencyPricingConfigId:
              existingWebsiteSubscription.agencyPricingConfigId,
          });
          if (secondary) {
            return sendSuccess(res, {
              recovered: true,
              businessId: business.id,
              quickScrapeBusinessId: input.quickScrapeBusinessId,
              onboardingMode: "onboarding_v2",
              planTier: synced.planTier,
              onboardingQueued: false,
              resumePath: `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
            });
          }
          if (["idle", "failed"].includes(business.onboardingStatus)) {
            try {
              const queued = await queueRecoveredWebsiteOnboarding({
                userId: req.authUserId,
                business,
                isSecondaryOnboardingV2: false,
              });
              const recoveryUrl = new URL(
                "/dashboard/account",
                frontendOrigin(),
              );
              recoveryUrl.searchParams.set("website_added", "true");
              recoveryUrl.searchParams.set("business_id", business.id);
              return sendSuccess(res, {
                recovered: true,
                businessId: business.id,
                planTier: synced.planTier,
                onboardingAlreadyQueued: queued.alreadyQueued,
                onboardingQueued: queued.queued,
                url: recoveryUrl.toString(),
              });
            } catch {
              throw new CheckoutError(
                503,
                "The subscription is active, but setup is temporarily unavailable",
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
          throw new CheckoutError(409, "This website is already subscribed");
        }
        if (["incomplete", "past_due", "paused", "unpaid"].includes(live.status)) {
          throw new CheckoutError(
            409,
            "This website has a subscription requiring payment recovery",
            "SUBSCRIPTION_REQUIRES_RECOVERY",
          );
        }
      } catch (error) {
        if (error instanceof CheckoutError) throw error;
        if (!isMissingStripeSubscription(error)) throw error;
        await prisma.websiteSubscription.update({
          where: { businessId: business.id },
          data: { status: "canceled" },
        });
      }
    }

    const recentSessions = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 100,
    });
    const relatedSessions = recentSessions.data.filter((session) =>
      session.metadata?.userId === req.authUserId &&
      session.metadata?.type === "add_website" &&
      session.metadata?.businessId === business.id &&
      (secondary
        ? session.metadata?.onboardingMode === "onboarding_v2" &&
          session.metadata?.quickScrapeBusinessId === input.quickScrapeBusinessId
        : session.metadata?.onboardingMode !== "onboarding_v2"),
    );
    const completed = relatedSessions.find(
      (session) =>
        session.status === "complete" &&
        ["paid", "no_payment_required"].includes(session.payment_status),
    );
    if (completed) {
      const completedSession = await stripe.checkout.sessions.retrieve(
        completed.id,
        { expand: ["subscription"] },
      );
      if (
        completedSession.metadata?.userId !== req.authUserId ||
        completedSession.metadata?.businessId !== business.id ||
        completedSession.metadata?.type !== "add_website" ||
        checkoutSessionCustomerId(completedSession) !== customerId
      ) {
        throw new CheckoutError(403, "Checkout is unavailable");
      }
      const completedSubscription =
        typeof completedSession.subscription === "string"
          ? await stripe.subscriptions.retrieve(completedSession.subscription)
          : completedSession.subscription;
      const paymentAccepted =
        completedSession.payment_status === "paid" ||
        (completedSession.payment_status === "no_payment_required" &&
          completedSubscription?.status === "active");
      if (completedSubscription && paymentAccepted) {
        assertAddWebsiteSubscriptionBinding({
          subscription: completedSubscription,
          userId: req.authUserId,
          businessId: business.id,
          customerId,
        });
        const synced = await syncAddWebsiteSubscriptionOnBackend({
          subscription: completedSubscription,
          userId: req.authUserId,
          business,
          agencyPricingConfigId:
            completedSession.metadata?.agencyPricingConfigId ?? null,
        });
        if (secondary) {
          const recoveryUrl = new URL(
            `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
            frontendOrigin(),
          );
          recoveryUrl.searchParams.set("session_id", completedSession.id);
          return sendSuccess(res, {
            recovered: true,
            sessionId: completedSession.id,
            businessId: business.id,
            quickScrapeBusinessId: input.quickScrapeBusinessId,
            onboardingMode: "onboarding_v2",
            planTier: synced.planTier,
            onboardingQueued: false,
            resumePath: `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
            url: recoveryUrl.toString(),
          });
        }
        try {
          const queued = await queueRecoveredWebsiteOnboarding({
            userId: req.authUserId,
            business,
            isSecondaryOnboardingV2: false,
          });
          const recoveryUrl = new URL("/dashboard/account", frontendOrigin());
          recoveryUrl.searchParams.set("website_added", "true");
          recoveryUrl.searchParams.set("business_id", business.id);
          recoveryUrl.searchParams.set("session_id", completedSession.id);
          return sendSuccess(res, {
            recovered: true,
            sessionId: completedSession.id,
            businessId: business.id,
            planTier: synced.planTier,
            onboardingAlreadyQueued: queued.alreadyQueued,
            onboardingQueued: queued.queued,
            url: recoveryUrl.toString(),
          });
        } catch {
          throw new CheckoutError(
            503,
            "Payment was verified, but setup is temporarily unavailable",
            "ADD_WEBSITE_ONBOARDING_QUEUE_FAILED",
            {
              businessId: business.id,
              retryable: true,
              sessionId: completedSession.id,
              subscriptionSynced: true,
            },
            3,
          );
        }
      }
      throw new CheckoutError(
        409,
        "This checkout is still being confirmed",
        "SUBSCRIPTION_PROCESSING",
        {
          sessionId: completed.id,
          verificationRequired: true,
          ...(secondary
            ? {
                businessId: business.id,
                quickScrapeBusinessId: input.quickScrapeBusinessId,
                onboardingMode: "onboarding_v2",
                resumePath: `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
              }
            : {}),
        },
      );
    }

    const pricing = await resolveSubscriptionPrice(
      business.agencyId,
      input.billingPeriod,
      websitePlanPriceDefaults(input.planTier),
      input.planTier,
    );
    if (!pricing.stripePriceId) {
      throw new CheckoutError(503, "Checkout is temporarily unavailable");
    }
    await verifiedRecurringPrice(
      stripe,
      pricing.stripePriceId,
      pricing.priceCents,
      pricing.currency,
      input.billingPeriod,
    );
    const priceFingerprint = crypto
      .createHash("sha256")
      .update(pricing.stripePriceId)
      .digest("hex")
      .slice(0, 16);

    const matchingOpen = relatedSessions.find(
      (session) =>
        !removedExistingDiscount &&
        session.status === "open" &&
        session.metadata?.billingPeriod === input.billingPeriod &&
        session.metadata?.planTier === input.planTier &&
        session.metadata?.priceFingerprint === priceFingerprint &&
        Boolean(secureStripeCheckoutUrl(session.url)),
    );
    const reusableUrl = matchingOpen
      ? secureStripeCheckoutUrl(matchingOpen.url)
      : null;
    if (matchingOpen && reusableUrl) {
      return sendSuccess(res, {
        reused: true,
        sessionId: matchingOpen.id,
        url: reusableUrl,
        ...(secondary
          ? {
              businessId: business.id,
              quickScrapeBusinessId: input.quickScrapeBusinessId,
              onboardingMode: "onboarding_v2",
              resumePath: `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
            }
          : {}),
      });
    }
    await Promise.all(
      relatedSessions
        .filter((session) => session.status === "open")
        .map((session) => stripe.checkout.sessions.expire(session.id)),
    );

    const checkoutAttemptId = input.checkoutAttemptId ?? crypto.randomUUID();
    const metadata: Record<string, string> = {
      userId: req.authUserId,
      businessId: business.id,
      ownershipType: ownershipType(
        business.ownershipType,
        business.agency?.isActive ? business.agency.slug : null,
      ),
      type: "add_website",
      billingPeriod: input.billingPeriod,
      checkoutAttemptId,
      planTier: input.planTier,
      priceFingerprint,
      ...(business.agencyId ? { agencyId: business.agencyId } : {}),
      ...(pricing.agencyPricingConfigId
        ? { agencyPricingConfigId: pricing.agencyPricingConfigId }
        : {}),
      ...(secondary
        ? {
            onboardingMode: "onboarding_v2",
            quickScrapeBusinessId: input.quickScrapeBusinessId!,
          }
        : {}),
      ...affiliateMetadata,
    };
    const baseUrl = frontendOrigin();
    const successUrl = secondary
      ? `${baseUrl}/dashboard/websites/onboarding/${input.quickScrapeBusinessId}?session_id={CHECKOUT_SESSION_ID}`
      : `${baseUrl}/dashboard/account?website_added=true&business_id=${business.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = secondary
      ? `${baseUrl}/dashboard/websites/onboarding/${input.quickScrapeBusinessId}?canceled=true`
      : `${baseUrl}/dashboard/account?website_checkout_canceled=true&business_id=${business.id}`;
    const checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        ...(affiliateMetadata.rewardfulReferralId
          ? { client_reference_id: affiliateMetadata.rewardfulReferralId }
          : {}),
        mode: "subscription",
        payment_method_collection: "always",
        payment_method_types: ["card"],
        allow_promotion_codes: true,
        line_items: [{ price: pricing.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        subscription_data: { metadata },
      },
      {
        idempotencyKey: `add-website-v2:${business.id}:${input.planTier}:${input.billingPeriod}:${checkoutAttemptId}:${priceFingerprint}`,
      },
    );
    const checkoutUrl = secureStripeCheckoutUrl(checkoutSession.url);
    if (!checkoutUrl) {
      throw new CheckoutError(503, "Checkout is temporarily unavailable");
    }
    await prisma.rewardfulAttribution.updateMany({
      where: { userId: req.authUserId },
      data: {
        stripeCheckoutSessionId: checkoutSession.id,
        stripeCustomerId: customerId,
        lastSeenAt: new Date(),
      },
    });
    return sendSuccess(res, {
      url: checkoutUrl,
      sessionId: checkoutSession.id,
      ...(secondary
        ? {
            businessId: business.id,
            quickScrapeBusinessId: input.quickScrapeBusinessId,
            onboardingMode: "onboarding_v2",
            resumePath: `/dashboard/websites/onboarding/${input.quickScrapeBusinessId}`,
          }
        : {}),
    }, "Checkout session created");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof CheckoutError) {
      if (error.retryAfterSeconds) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      return res.status(error.status).json({
        success: false,
        message: error.publicMessage,
        data: {
          ...(error.code ? { code: error.code } : {}),
          ...(error.details ?? {}),
        },
        timestamp: new Date().toISOString(),
      });
    }
    console.error("[billing] add-website checkout failed", error);
    return sendError(res, "Checkout is temporarily unavailable", 503);
  }
}
