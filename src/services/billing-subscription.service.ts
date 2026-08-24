import { BRAND } from "../config/brand.config";
import { prisma } from "../config/db.config";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import Stripe from "stripe";
import { stripe } from "../config/stripe.config";
import { clearExistingCustomerDiscount } from "../utils/stripe-checkout-discount";
import {
  getOnboardingV2PaidIntroPeriodDates,
  getOnboardingV2TargetPriceId,
  isOnboardingV2PaidIntroPeriod,
} from "./onboarding-paid-intro.service";
import {
  parseWebsitePlanTier,
  resolveWebsitePlanTier,
  type WebsitePlanTier,
} from "../utils/website-plan-tier";
import {
  isRemovalLifecycleProtected,
  resolveSafeSubscriptionItemForBusiness,
  WebsiteRemovalSyncBlockedError,
} from "../utils/stripe-webhook-safety";
import { reconcilePrimaryWorkspaceSafely } from "./primary-workspace-reconciliation.service";

export interface WebsiteWithSubscription {
  id: string;
  businessName: string;
  businessWebsiteUrl: string;
  isPrimary: boolean;
  isActive: boolean;
  websiteStatus: string;
  isSubscribed: boolean;
  subscriptionStatus: "subscribed" | "not_subscribed" | "trial" | "expired";
  websiteSubscription: {
    status: string;
    currentPeriodEnd: Date | null;
    trialStatus?: string;
    trialEndDate?: Date | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionItemId?: string | null;
    stripePriceId?: string | null;
    planTier?: WebsitePlanTier;
  } | null;
}

export type SubscriptionDisplayStatus =
  | "active"
  | "trialing"
  | "expired"
  | "none"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired";

export interface SubscriptionStatus {
  isActive: boolean;
  status: string;
  currentPeriodEnd: Date | null;
  accountTrialEndDate: Date | null;
  cancelAtPeriodEnd: boolean;
  planName: string | null;
  billingInterval: "monthly" | "yearly" | null;
  displayStatus: SubscriptionDisplayStatus;
  displayCurrentPeriodEnd: Date | null;
  displayTrialEndDate: Date | null;
  displayBillingInterval: "monthly" | "yearly" | null;
  selectedWebsiteId: string | null;
  stripePriceId: string | null;
  isPaidOnboardingTrial: boolean;
  planTier: WebsitePlanTier;
  websiteCount?: number;
  maxWebsites?: number;
  websites?: WebsiteWithSubscription[];
}

type AccountSubscriptionState = {
  currentPeriodEnd?: Date | null;
  status?: string | null;
};

type UserTrialState = {
  onboarding?: boolean | null;
  trialEndDate?: Date | null;
  trialStartDate?: Date | null;
  trialStatus?: string | null;
};

type StripeSubscriptionPeriodFields = Stripe.Subscription & {
  current_period_end?: number | null;
  current_period_start?: number | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: number | null;
};

interface SyncAddWebsiteSubscriptionInput {
  userId: string;
  businessId: string;
  stripeSubscription: Stripe.Subscription;
  subscriptionItem?: Stripe.SubscriptionItem | null;
  agencyId?: string | null;
  agencyPricingConfigId?: string | null;
}

interface SyncAddWebsiteSubscriptionResult {
  businessId: string;
  operation: "created" | "updated";
  websiteStatus: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  stripeSubscriptionItemId: string | null;
  stripePriceId: string | null;
  planTier: WebsitePlanTier;
}

type StripeMetadataLike =
  | Record<string, string | null | undefined>
  | Stripe.Metadata
  | null
  | undefined;

export const ONBOARDING_V2_TRIAL_CHECKOUT_FLOW =
  "onboarding_v2_trial" as const;

export type StripeWebsiteSubscriptionLifecycle = {
  businessIsActive: boolean;
  businessWebsiteStatus: string;
  trialEndDate: Date | null;
  trialStartDate: Date | null;
  trialStatus: "converted" | "trialing";
  websiteSubscriptionStatus: string;
};

type StripeSubscriptionPeriodState = {
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  priceId: string | null;
};

type StripeSubscriptionRuntimeState = StripeSubscriptionPeriodState & {
  isPaidOnboardingTrial: boolean;
  metadataPlanTier: WebsitePlanTier | null;
};

export type WebsiteBillingTarget = {
  businessId: string | null;
  isPrimary: boolean;
  source: "website" | "account" | "none";
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
  stripePriceId: string | null;
  planTier: WebsitePlanTier;
  matchesAccountSubscription: boolean;
};

type UpdateWebsiteSubscriptionStatusOptions = {
  stripeSubscriptionId?: string | null;
  businessIds?: string[] | null;
};

function getAccountTrialEndDate(
  subscription: AccountSubscriptionState | null | undefined,
  user: UserTrialState | null | undefined,
): Date | null {
  return subscription?.currentPeriodEnd ?? user?.trialEndDate ?? null;
}

function getBillingIntervalFromPriceId(
  priceId: string | null | undefined,
  yearlyPriceId: string,
): "monthly" | "yearly" | null {
  if (!priceId) {
    return null;
  }

  const yearlyPriceIds = new Set(
    [yearlyPriceId, process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return yearlyPriceIds.has(priceId) ? "yearly" : "monthly";
}

export function getStripeMetadataBusinessIds(metadata: StripeMetadataLike): string[] {
  if (!metadata) {
    return [];
  }

  const businessIds = [
    typeof metadata.primaryBusinessId === "string"
      ? metadata.primaryBusinessId
      : null,
    typeof metadata.businessId === "string" ? metadata.businessId : null,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return Array.from(new Set(businessIds));
}

type StripeSubscriptionItemPeriodFields = Stripe.SubscriptionItem & {
  current_period_end?: number | null;
  current_period_start?: number | null;
};

function unixTimestampToDate(value?: number | null): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

export function isOnboardingV2TrialMetadata(
  metadata: StripeMetadataLike,
): boolean {
  return metadata?.checkoutFlow === ONBOARDING_V2_TRIAL_CHECKOUT_FLOW;
}

export function resolveStripeWebsiteSubscriptionLifecycle(
  stripeSubscription: Pick<
    Stripe.Subscription,
    "status" | "trial_end" | "trial_start"
  > &
    Partial<Pick<Stripe.Subscription, "items" | "metadata">>,
): StripeWebsiteSubscriptionLifecycle {
  const isPaidIntro = Boolean(
    stripeSubscription.items &&
      stripeSubscription.metadata &&
      isOnboardingV2PaidIntroPeriod(
        stripeSubscription as Pick<
          Stripe.Subscription,
          "items" | "metadata" | "status" | "trial_end" | "trial_start"
        >,
      ),
  );
  const isTrialing = stripeSubscription.status === "trialing" || isPaidIntro;
  const paidIntroDates = isPaidIntro
    ? getOnboardingV2PaidIntroPeriodDates(
        stripeSubscription as Pick<
          Stripe.Subscription,
          "items" | "metadata" | "status" | "trial_end" | "trial_start"
        >,
      )
    : null;
  const websiteSubscriptionStatus = isPaidIntro
    ? "trialing"
    : mapStripeStatusToWebsiteStatus(stripeSubscription.status);
  const businessWebsiteStatus = isPaidIntro
    ? "trial"
    : mapStripeStatusToBusinessWebsiteStatus(stripeSubscription.status);

  return {
    businessIsActive:
      businessWebsiteStatus === "active" || businessWebsiteStatus === "trial",
    businessWebsiteStatus,
    trialEndDate:
      paidIntroDates?.end ?? unixTimestampToDate(stripeSubscription.trial_end),
    trialStartDate:
      paidIntroDates?.start ??
      unixTimestampToDate(stripeSubscription.trial_start),
    trialStatus: isTrialing ? "trialing" : "converted",
    websiteSubscriptionStatus,
  };
}

export function shouldFinalizeOnboardingV2TrialInvoice(input: {
  alreadyConverted?: boolean;
  amountPaid: number | null | undefined;
  billingReason: Stripe.Invoice["billing_reason"];
  metadata: StripeMetadataLike;
  subscriptionStatus: Stripe.Subscription.Status;
}): boolean {
  return (
    !input.alreadyConverted &&
    isOnboardingV2TrialMetadata(input.metadata) &&
    (input.amountPaid ?? 0) > 0 &&
    input.billingReason === "subscription_cycle" &&
    input.subscriptionStatus === "active"
  );
}

function resolveStripeSubscriptionItem(
  stripeSubscription: Stripe.Subscription,
  options?: {
    stripeSubscriptionItemId?: string | null;
    businessId?: string | null;
  },
): StripeSubscriptionItemPeriodFields | null {
  const subscriptionItems = stripeSubscription.items.data as
    StripeSubscriptionItemPeriodFields[];

  if (options?.stripeSubscriptionItemId) {
    const matchedByItemId =
      subscriptionItems.find(
        (item) => item.id === options.stripeSubscriptionItemId,
      ) ?? null;
    if (matchedByItemId) {
      return matchedByItemId;
    }
  }

  if (options?.businessId) {
    const matchedByBusinessId =
      subscriptionItems.find(
        (item) => item.metadata?.businessId === options.businessId,
      ) ?? null;
    if (matchedByBusinessId) {
      return matchedByBusinessId;
    }
  }

  return subscriptionItems[0] ?? null;
}

function getStripeSubscriptionPeriodState(
  stripeSubscription: Stripe.Subscription,
  options?: {
    stripeSubscriptionItemId?: string | null;
    businessId?: string | null;
  },
): StripeSubscriptionPeriodState & {
  subscriptionItemId: string | null;
  canceledAt: Date | null;
} {
  const subscriptionWithPeriods =
    stripeSubscription as StripeSubscriptionPeriodFields & {
      billing_cycle_anchor?: number | null;
      start_date?: number | null;
      latest_invoice?: Stripe.Invoice | string | null;
    };
  const subscriptionItem = resolveStripeSubscriptionItem(
    stripeSubscription,
    options,
  );
  const latestInvoice =
    subscriptionWithPeriods.latest_invoice &&
    typeof subscriptionWithPeriods.latest_invoice === "object"
      ? (subscriptionWithPeriods.latest_invoice as Stripe.Invoice)
      : null;
  const firstInvoiceLine = latestInvoice?.lines?.data?.[0] ?? null;

  const currentPeriodStart =
    unixTimestampToDate(subscriptionItem?.current_period_start) ??
    unixTimestampToDate(firstInvoiceLine?.period?.start ?? null) ??
    unixTimestampToDate(subscriptionWithPeriods.start_date) ??
    unixTimestampToDate(subscriptionWithPeriods.billing_cycle_anchor) ??
    null;
  const currentPeriodEnd =
    unixTimestampToDate(subscriptionItem?.current_period_end) ??
    unixTimestampToDate(firstInvoiceLine?.period?.end ?? null) ??
    null;

  return {
    cancelAtPeriodEnd: Boolean(subscriptionWithPeriods.cancel_at_period_end),
    canceledAt: unixTimestampToDate(subscriptionWithPeriods.canceled_at),
    currentPeriodStart,
    currentPeriodEnd,
    priceId: subscriptionItem?.price.id ?? null,
    subscriptionItemId: subscriptionItem?.id ?? null,
  };
}

async function getStripeSubscriptionRuntimeState(
  stripeSubscriptionId: string | null | undefined,
  stripeSubscriptionItemId?: string | null,
): Promise<StripeSubscriptionRuntimeState | null> {
  if (!stripeSubscriptionId) {
    return null;
  }

  try {
    const liveSubscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
      {
        expand: ["latest_invoice"],
      },
    );
    const state = getStripeSubscriptionPeriodState(liveSubscription, {
      stripeSubscriptionItemId,
    });

    return {
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      currentPeriodStart: state.currentPeriodStart,
      currentPeriodEnd: state.currentPeriodEnd,
      isPaidOnboardingTrial: isOnboardingV2TrialMetadata(
        liveSubscription.metadata,
      ),
      metadataPlanTier: parseWebsitePlanTier(
        liveSubscription.metadata?.planTier,
      ),
      priceId:
        getOnboardingV2TargetPriceId(liveSubscription.metadata) ??
        state.priceId,
    };
  } catch (error) {
    console.warn(
      `[Subscription Status] Failed to retrieve live Stripe subscription ${stripeSubscriptionId}:`,
      error,
    );
    return null;
  }
}

export async function resolveWebsiteBillingTarget(
  userId: string,
  selectedBusinessId?: string | null,
): Promise<WebsiteBillingTarget> {
  const accountSubscription = await prisma.subscription.findUnique({
    where: { userId },
    select: {
      stripeSubscriptionId: true,
      stripePriceId: true,
    },
  });

  const selectedBusiness = selectedBusinessId
    ? await prisma.business.findFirst({
        where: { id: selectedBusinessId, userId },
        include: {
          websiteSubscription: {
            select: {
              stripeSubscriptionId: true,
              stripeSubscriptionItemId: true,
              stripePriceId: true,
              planTier: true,
            },
          },
        },
      })
    : await prisma.business.findFirst({
        where: { userId, isPrimary: true },
        include: {
          websiteSubscription: {
            select: {
              stripeSubscriptionId: true,
              stripeSubscriptionItemId: true,
              stripePriceId: true,
              planTier: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

  if (selectedBusinessId && !selectedBusiness) {
    throw new Error("Business not found");
  }

  const business = selectedBusiness;

  const websiteSubscription = business?.websiteSubscription ?? null;
  const websiteStripeSubscriptionId = websiteSubscription?.stripeSubscriptionId ?? null;
  const accountStripeSubscriptionId = accountSubscription?.stripeSubscriptionId ?? null;
  const matchesAccountSubscription = Boolean(
    websiteStripeSubscriptionId &&
      accountStripeSubscriptionId &&
      websiteStripeSubscriptionId === accountStripeSubscriptionId,
  );

  if (websiteStripeSubscriptionId) {
    return {
      businessId: business?.id ?? null,
      isPrimary: business?.isPrimary ?? false,
      source: "website",
      stripeSubscriptionId: websiteStripeSubscriptionId,
      stripeSubscriptionItemId:
        websiteSubscription?.stripeSubscriptionItemId ?? null,
      stripePriceId: websiteSubscription?.stripePriceId ?? null,
      planTier: websiteSubscription?.planTier ?? "SEO",
      matchesAccountSubscription,
    };
  }

  return {
    businessId: business?.id ?? null,
    isPrimary: business?.isPrimary ?? false,
    source: "none",
    stripeSubscriptionId: null,
    stripeSubscriptionItemId: null,
    stripePriceId: null,
    planTier: "SEO",
    matchesAccountSubscription: false,
  };
}

export function deriveWebsiteSubscriptionStatus(
  business: { websiteStatus: string | null },
  ws: {
    status: string;
    trialStatus?: string | null;
    trialEndDate?: Date | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionItemId?: string | null;
    stripePriceId?: string | null;
  } | null,
  account: {
    subscription: AccountSubscriptionState | null;
    user: UserTrialState | null;
  },
  options?: {
    perSiteTrialsEnabled?: boolean;
  },
): "subscribed" | "not_subscribed" | "trial" | "expired" {
  const perSiteTrialsEnabled =
    options?.perSiteTrialsEnabled ?? PER_SITE_TRIALS_ENABLED;
  const isLegacyActiveAccount = Boolean(
    account.user?.onboarding &&
      !account.user?.trialStartDate &&
      !account.user?.trialStatus &&
      !account.subscription,
  );

  if (!ws) {
    if (perSiteTrialsEnabled) {
      if (isLegacyActiveAccount) return "subscribed";
      return "not_subscribed";
    }

    if (isLegacyActiveAccount) return "subscribed";
    if (business.websiteStatus === "active") return "subscribed";
    if (business.websiteStatus === "trial") return "trial";
    if (business.websiteStatus === "expired") return "expired";
    return "not_subscribed";
  }

  const badStatuses = [
    "past_due",
    "unpaid",
    "incomplete",
    "suspended",
    "canceled",
    "expired",
  ];
  if (badStatuses.includes(ws.status)) {
    return ws.status === "expired" ? "expired" : "not_subscribed";
  }

  const trialEndValid =
    ws.trialEndDate && new Date(ws.trialEndDate) > new Date();
  const trialEndExpired =
    ws.trialEndDate && new Date(ws.trialEndDate) <= new Date();

  if (perSiteTrialsEnabled) {
    if (
      ws.trialStatus === "expired" ||
      ws.status === "expired" ||
      ((ws.trialStatus === "trialing" || ws.status === "trialing") &&
        trialEndExpired)
    ) {
      return "expired";
    }

    if (
      ws.trialStatus === "trialing" &&
      (!ws.trialEndDate || trialEndValid)
    ) {
      return "trial";
    }

    if (ws.status === "active" && ws.trialStatus !== "trialing") {
      return "subscribed";
    }

    if (isLegacyActiveAccount) {
      return "subscribed";
    }
    return "not_subscribed";
  }

  if (
    ws.trialStatus === "expired" ||
    (ws.trialStatus === "trialing" && trialEndExpired)
  ) {
    return "expired";
  }
  if (ws.trialStatus === "trialing" && trialEndValid) {
    return "trial";
  }
  if (ws.trialStatus === "converted" || ws.trialStatus === "none") {
    if (ws.status === "active" || ws.status === "trialing")
      return "subscribed";
  }
  if (ws.status === "active" || ws.status === "trialing") {
    return "subscribed";
  }

  if (business.websiteStatus === "trial") return "trial";
  if (business.websiteStatus === "expired") return "expired";
  if (business.websiteStatus === "active") return "subscribed";
  return "not_subscribed";
}

function getWebsiteSubscriptionStatus(
  business: { websiteStatus: string | null },
  ws: {
    status: string;
    trialStatus?: string | null;
    trialEndDate?: Date | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionItemId?: string | null;
    stripePriceId?: string | null;
  } | null,
  account: {
    subscription: AccountSubscriptionState | null;
    user: UserTrialState | null;
  },
): "subscribed" | "not_subscribed" | "trial" | "expired" {
  return deriveWebsiteSubscriptionStatus(business, ws, account);
}

export async function getSubscriptionStatus(
  userId: string,
  selectedBusinessId?: string | null,
): Promise<SubscriptionStatus | null> {
  try {
    const [subscription, businesses, user] = await Promise.all([
      prisma.subscription.findUnique({ where: { userId } }),
      prisma.business.findMany({
        where: { userId },
        include: { websiteSubscription: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          onboarding: true,
          trialEndDate: true,
          trialStartDate: true,
          trialStatus: true,
        },
      }),
    ]);

    const websites: WebsiteWithSubscription[] = businesses.map((business) => {
      const ws = business.websiteSubscription;
      const subscriptionStatus = getWebsiteSubscriptionStatus(business, ws, {
        subscription,
        user,
      });
      return {
        id: business.id,
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        isPrimary: business.isPrimary,
        isActive: business.isActive,
        websiteStatus: business.websiteStatus || "active",
        isSubscribed:
          subscriptionStatus === "subscribed" ||
          subscriptionStatus === "trial",
        subscriptionStatus,
        websiteSubscription: ws
          ? {
              status: ws.status,
              currentPeriodEnd: ws.currentPeriodEnd,
              trialStatus: ws.trialStatus,
              trialEndDate: ws.trialEndDate,
              stripeSubscriptionId: ws.stripeSubscriptionId,
              stripeSubscriptionItemId: ws.stripeSubscriptionItemId,
              stripePriceId: ws.stripePriceId,
              planTier: ws.planTier,
            }
          : null,
      };
    });

    const entitledWebsiteCount = websites.filter(
      (w) =>
        w.subscriptionStatus === "subscribed" ||
        w.subscriptionStatus === "trial",
    ).length;

    const websiteCount =
      subscription?.websiteCount ?? entitledWebsiteCount;
    const maxWebsites = subscription?.maxWebsites ?? 10;

    const yearlyPriceId = process.env.UPLIFT_YEARLY_PRICE_ID || "";
    const accountTrialEndDate = getAccountTrialEndDate(subscription, user);

    const isRetiredWebsite = (website: WebsiteWithSubscription) =>
      website.websiteStatus === "suspended" ||
      website.websiteStatus === "failed";
    const activeLikeWebsites = websites.filter(
      (website) => !isRetiredWebsite(website),
    );
    const defaultWebsite =
      activeLikeWebsites.find(
        (website) => website.subscriptionStatus === "subscribed",
      ) ??
      activeLikeWebsites.find(
        (website) => website.subscriptionStatus === "trial",
      ) ??
      activeLikeWebsites.find((website) => website.isPrimary) ??
      activeLikeWebsites[0] ??
      websites.find((website) => website.isPrimary) ??
      websites[0] ??
      null;
    const requestedWebsite =
      selectedBusinessId != null
        ? websites.find((website) => website.id === selectedBusinessId) ?? null
        : null;
    const shouldUseRequestedWebsite =
      requestedWebsite != null &&
      !(
        requestedWebsite.subscriptionStatus === "not_subscribed" &&
        isRetiredWebsite(requestedWebsite) &&
        defaultWebsite != null &&
        defaultWebsite.id !== requestedWebsite.id
      );
    const selectedWebsite = shouldUseRequestedWebsite
      ? requestedWebsite
      : defaultWebsite;

    const selectedPaidWebsite =
      selectedWebsite?.subscriptionStatus === "subscribed"
        ? selectedWebsite
        : null;
    const selectedTrialWebsite =
      selectedWebsite?.subscriptionStatus === "trial" ? selectedWebsite : null;
    const selectedExpiredWebsite =
      selectedWebsite?.subscriptionStatus === "expired" ? selectedWebsite : null;
    const selectedLiveStripeState = await getStripeSubscriptionRuntimeState(
      selectedWebsite?.websiteSubscription?.stripeSubscriptionId ?? null,
      selectedWebsite?.websiteSubscription?.stripeSubscriptionItemId,
    );
    const selectedPriceId =
      selectedLiveStripeState?.priceId ??
      selectedWebsite?.websiteSubscription?.stripePriceId ??
      null;
    const billingInterval: "monthly" | "yearly" | null =
      (selectedPaidWebsite || selectedTrialWebsite) && selectedPriceId
        ? getBillingIntervalFromPriceId(selectedPriceId, yearlyPriceId)
        : null;
    const isActive =
      selectedWebsite?.subscriptionStatus === "subscribed" ||
      selectedWebsite?.subscriptionStatus === "trial";

    let displayStatus: SubscriptionDisplayStatus = "none";
    let displayCurrentPeriodEnd: Date | null = null;
    let displayTrialEndDate: Date | null = null;
    let displayBillingInterval: "monthly" | "yearly" | null = null;
    const selectedWebsiteStatus = selectedWebsite?.websiteSubscription?.status ?? null;

    if (selectedPaidWebsite) {
      displayStatus = "active";
      displayCurrentPeriodEnd =
        selectedLiveStripeState?.currentPeriodEnd ??
        selectedPaidWebsite.websiteSubscription?.currentPeriodEnd ??
        null;
      displayBillingInterval = getBillingIntervalFromPriceId(
        selectedPriceId,
        yearlyPriceId,
      );
    } else if (selectedTrialWebsite) {
      const trialEndDate =
        selectedTrialWebsite.websiteSubscription?.trialEndDate ?? null;
      displayStatus = "trialing";
      displayCurrentPeriodEnd = trialEndDate;
      displayTrialEndDate = trialEndDate;
      displayBillingInterval = getBillingIntervalFromPriceId(
        selectedPriceId,
        yearlyPriceId,
      );
    } else if (selectedExpiredWebsite) {
      displayStatus = "expired";
      displayCurrentPeriodEnd = null;
    } else if (
      selectedWebsiteStatus === "past_due" ||
      selectedWebsiteStatus === "unpaid" ||
      selectedWebsiteStatus === "canceled" ||
      selectedWebsiteStatus === "incomplete" ||
      selectedWebsiteStatus === "incomplete_expired"
    ) {
      displayStatus = selectedWebsiteStatus;
    } else if (
      selectedWebsite?.subscriptionStatus === "subscribed" &&
      !selectedWebsite?.websiteSubscription
    ) {
      displayStatus = "active";
    } else if (
      selectedWebsiteStatus === "expired" ||
      selectedWebsite?.subscriptionStatus === "expired"
    ) {
      displayStatus = "expired";
    }

    return {
      isActive: !!isActive,
      status:
        selectedWebsiteStatus ??
        (selectedWebsite?.subscriptionStatus === "trial"
          ? "trialing"
          : selectedWebsite?.subscriptionStatus === "subscribed"
            ? "active"
            : selectedWebsite?.subscriptionStatus === "expired"
              ? "expired"
              : "none"),
      accountTrialEndDate,
      currentPeriodEnd: displayCurrentPeriodEnd,
      cancelAtPeriodEnd:
        selectedLiveStripeState?.cancelAtPeriodEnd ??
        (selectedWebsite?.websiteSubscription?.stripeSubscriptionId &&
        selectedWebsite.websiteSubscription.stripeSubscriptionId ===
          subscription?.stripeSubscriptionId
          ? subscription?.cancelAtPeriodEnd ?? false
          : false),
      planName: subscription?.planName ?? BRAND.name,
      billingInterval,
      displayStatus,
      displayCurrentPeriodEnd,
      displayTrialEndDate,
      displayBillingInterval,
      selectedWebsiteId: selectedWebsite?.id ?? null,
      stripePriceId: selectedPriceId,
      isPaidOnboardingTrial:
        selectedLiveStripeState?.isPaidOnboardingTrial ?? false,
      planTier: resolveWebsitePlanTier({
        databasePlanTier:
          selectedWebsite?.websiteSubscription?.planTier ?? null,
        stripeMetadataPlanTier:
          selectedLiveStripeState?.metadataPlanTier ?? null,
        stripePriceId: selectedLiveStripeState?.priceId ?? null,
      }),
      websiteCount,
      maxWebsites,
      websites,
    };
  } catch (error) {
    console.error("Error getting subscription status:", error);
    throw new Error("Failed to get subscription status");
  }
}

export async function createOrUpdateSubscription(
  userId: string,
  stripeCustomerId: string,
  stripeSubscription: Stripe.Subscription,
): Promise<void> {
  try {
    const subscriptionPeriodState = getStripeSubscriptionPeriodState(
      stripeSubscription,
    );

    const subscriptionData = {
      userId,
      planId:
        getOnboardingV2TargetPriceId(stripeSubscription.metadata) ??
        stripeSubscription.items.data[0]?.price.id ??
        null,
      planName: BRAND.name,
      status: stripeSubscription.status,
      startDate: new Date(stripeSubscription.created * 1000),
      currentPeriodEnd: subscriptionPeriodState.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptionPeriodState.cancelAtPeriodEnd,
      canceledAt: subscriptionPeriodState.canceledAt,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId:
        getOnboardingV2TargetPriceId(stripeSubscription.metadata) ??
        subscriptionPeriodState.priceId,
      stripeCurrentPeriodEnd: subscriptionPeriodState.currentPeriodEnd,
      stripeCancelAtPeriodEnd: subscriptionPeriodState.cancelAtPeriodEnd,
      stripeStatus: stripeSubscription.status,
    };

    const existingSubscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    const activeWebsiteCount = await prisma.websiteSubscription.count({
      where: {
        business: { userId, removalStatus: "active" },
        status: { in: ["active", "trialing"] },
      },
    });

    const websiteCount =
      existingSubscription?.websiteCount ?? activeWebsiteCount;
    const maxWebsites = existingSubscription?.maxWebsites ?? 10;

    await prisma.subscription.upsert({
      where: { userId },
      create: {
        ...subscriptionData,
        websiteCount,
        maxWebsites,
      },
      update: {
        ...subscriptionData,
        websiteCount,
      },
    });
  } catch (error) {
    console.error("Error creating/updating subscription:", error);
    throw new Error("Failed to create/update subscription");
  }
}

async function refreshSubscriptionWebsiteCount(userId: string): Promise<number> {
  const activeWebsiteCount = await prisma.websiteSubscription.count({
    where: {
      business: { userId, removalStatus: "active" },
      status: { in: ["active", "trialing"] },
    },
  });

  await prisma.subscription.updateMany({
    where: { userId },
    data: { websiteCount: activeWebsiteCount },
  });

  return activeWebsiteCount;
}

export async function cancelSubscription(
  userId: string,
  selectedBusinessId?: string | null,
  cancelAtPeriodEnd: boolean = true,
): Promise<void> {
  try {
    const target = await resolveWebsiteBillingTarget(userId, selectedBusinessId);

    if (!target.stripeSubscriptionId) {
      throw new Error(
        "Selected website does not have an active Stripe subscription",
      );
    }

    let updatedStripeSubscription: Stripe.Subscription;

    try {
      if (cancelAtPeriodEnd) {
        updatedStripeSubscription = await stripe.subscriptions.update(
          target.stripeSubscriptionId,
          {
          cancel_at_period_end: true,
          },
        );
      } else {
        updatedStripeSubscription = await stripe.subscriptions.cancel(
          target.stripeSubscriptionId,
        );
      }
    } catch (stripeError) {
      if (stripeError instanceof Error) {
        if (stripeError.message.includes("No such subscription")) {
          if (target.businessId) {
            await prisma.websiteSubscription.updateMany({
              where: { businessId: target.businessId },
              data: {
                status: "canceled",
              },
            });

            await prisma.business.update({
              where: { id: target.businessId },
              data: {
                websiteStatus: "canceled",
                isActive: false,
              },
            });

            await refreshSubscriptionWebsiteCount(userId);
            await reconcilePrimaryWorkspaceSafely(userId);
          }

          if (target.matchesAccountSubscription || target.source === "account") {
            await prisma.subscription.updateMany({
              where: { userId },
              data: {
                status: "canceled",
                stripeStatus: "canceled",
                canceledAt: new Date(),
                cancelAtPeriodEnd: false,
                stripeCancelAtPeriodEnd: false,
              },
            });
          }
          return;
        }
      }
      throw stripeError;
    }

    const updatedPeriodState = getStripeSubscriptionPeriodState(
      updatedStripeSubscription,
      {
        stripeSubscriptionItemId: target.stripeSubscriptionItemId,
        businessId: target.businessId,
      },
    );
    const websiteSubscriptionStatus = mapStripeStatusToWebsiteStatus(
      updatedStripeSubscription.status,
    );
    const businessWebsiteStatus = mapStripeStatusToBusinessWebsiteStatus(
      updatedStripeSubscription.status,
    );
    const currentPeriodEnd = updatedPeriodState.currentPeriodEnd;
    const canceledAt =
      updatedPeriodState.canceledAt ??
      (cancelAtPeriodEnd ? null : new Date());

    if (target.businessId) {
      await prisma.websiteSubscription.updateMany({
        where: { businessId: target.businessId },
        data: {
          status: websiteSubscriptionStatus,
          currentPeriodEnd,
        },
      });

      await prisma.business.update({
        where: { id: target.businessId },
        data: {
          websiteStatus: businessWebsiteStatus,
          isActive:
            businessWebsiteStatus === "active" ||
            businessWebsiteStatus === "trial",
        },
      });

      await refreshSubscriptionWebsiteCount(userId);
      await reconcilePrimaryWorkspaceSafely(userId);
    }

    if (target.matchesAccountSubscription || target.source === "account") {
      await prisma.subscription.updateMany({
        where: { userId },
        data: {
          cancelAtPeriodEnd,
          canceledAt,
          currentPeriodEnd,
          stripeCurrentPeriodEnd: currentPeriodEnd,
          stripeCancelAtPeriodEnd: Boolean(
            updatedPeriodState.cancelAtPeriodEnd,
          ),
          status: updatedStripeSubscription.status,
          stripeStatus: updatedStripeSubscription.status,
        },
      });
    }
  } catch (error) {
    console.error("Error canceling subscription:", error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to cancel subscription");
  }
}

export async function reactivateSubscription(
  userId: string,
  selectedBusinessId?: string | null,
): Promise<void> {
  try {
    const target = await resolveWebsiteBillingTarget(userId, selectedBusinessId);

    if (!target.stripeSubscriptionId) {
      throw new Error(
        "Selected website does not have an active Stripe subscription",
      );
    }

    let updatedStripeSubscription: Stripe.Subscription;

    try {
      updatedStripeSubscription = await stripe.subscriptions.update(
        target.stripeSubscriptionId,
        {
        cancel_at_period_end: false,
        },
      );
    } catch (stripeError) {
      if (stripeError instanceof Error) {
        if (stripeError.message.includes("No such subscription")) {
          throw new Error("Subscription no longer exists in Stripe");
        }
      }
      throw stripeError;
    }

    const updatedPeriodState = getStripeSubscriptionPeriodState(
      updatedStripeSubscription,
      {
        stripeSubscriptionItemId: target.stripeSubscriptionItemId,
        businessId: target.businessId,
      },
    );
    const websiteSubscriptionStatus = mapStripeStatusToWebsiteStatus(
      updatedStripeSubscription.status,
    );
    const businessWebsiteStatus = mapStripeStatusToBusinessWebsiteStatus(
      updatedStripeSubscription.status,
    );
    const currentPeriodEnd = updatedPeriodState.currentPeriodEnd;

    if (target.businessId) {
      await prisma.websiteSubscription.updateMany({
        where: { businessId: target.businessId },
        data: {
          status: websiteSubscriptionStatus,
          currentPeriodEnd,
        },
      });

      await prisma.business.update({
        where: { id: target.businessId },
        data: {
          websiteStatus: businessWebsiteStatus,
          isActive:
            businessWebsiteStatus === "active" ||
            businessWebsiteStatus === "trial",
        },
      });

      await refreshSubscriptionWebsiteCount(userId);
      await reconcilePrimaryWorkspaceSafely(userId);
    }

    if (target.matchesAccountSubscription || target.source === "account") {
      await prisma.subscription.updateMany({
        where: { userId },
        data: {
          cancelAtPeriodEnd: false,
          canceledAt: null,
          currentPeriodEnd,
          stripeCurrentPeriodEnd: currentPeriodEnd,
          stripeCancelAtPeriodEnd: false,
          status: updatedStripeSubscription.status,
          stripeStatus: updatedStripeSubscription.status,
        },
      });
    }
  } catch (error) {
    console.error("Error reactivating subscription:", error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to reactivate subscription");
  }
}

type StripeErrorLike = {
  type?: string;
  code?: string;
  param?: string;
  message?: string;
};

function isNoSuchStripeCustomerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const stripeError = error as Error & StripeErrorLike;
  const message = (stripeError.message || "").toLowerCase();

  if (
    stripeError.type === "StripeInvalidRequestError" &&
    stripeError.code === "resource_missing" &&
    (stripeError.param === "customer" || message.includes("no such customer"))
  ) {
    return true;
  }

  if (message.includes("no such customer")) {
    return true;
  }

  return false;
}

export async function getStripeCustomerId(
  userId: string,
  userEmail: string,
  metadata: Record<string, string> = {},
): Promise<string> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: { stripeCustomerId: true },
    });

    if (subscription?.stripeCustomerId) {
      try {
        const existingCustomer = await stripe.customers.retrieve(
          subscription.stripeCustomerId,
        );
        const isDeleted =
          "deleted" in existingCustomer && existingCustomer.deleted === true;
        if (!isDeleted) {
          if (Object.keys(metadata).length > 0) {
            await stripe.customers.update(subscription.stripeCustomerId, {
              metadata,
            });
          }
          return subscription.stripeCustomerId;
        }
      } catch (error: unknown) {
        if (!isNoSuchStripeCustomerError(error)) {
          throw error;
        }
      }
    }

    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: {
        userId,
        ...metadata,
      },
    });

    await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        stripeCustomerId: customer.id,
        status: "incomplete",
        startDate: new Date(),
      },
      update: {
        stripeCustomerId: customer.id,
      },
    });

    return customer.id;
  } catch (error) {
    console.error("Error getting/creating Stripe customer:", error);
    throw new Error("Failed to get Stripe customer");
  }
}

/**
 * Starts every new Checkout from the configured list price. Stripe can carry a
 * customer-level discount into newly-created subscriptions even when the
 * Checkout Session does not explicitly provide `discounts`. Remove that
 * inherited discount first; the hosted Checkout may then accept a promotion
 * code that the customer deliberately enters for this purchase.
 *
 * This fails closed: if Stripe cannot confirm or remove the discount, callers
 * must not create a Checkout Session with an uncertain price.
 */
export async function prepareStripeCustomerForFullPriceCheckout(
  userId: string,
  userEmail: string,
  metadata: Record<string, string> = {},
): Promise<{ customerId: string; removedExistingDiscount: boolean }> {
  const customerId = await getStripeCustomerId(userId, userEmail, metadata);
  const removedExistingDiscount = await clearExistingCustomerDiscount(
    customerId,
    stripe.customers,
  );

  return { customerId, removedExistingDiscount };
}

interface WebsiteSubscriptionSyncResult {
  synced: number;
  created: number;
  updated: number;
  canceled: number;
  skipped: number;
}

export async function syncWebsiteSubscriptions(
  userId: string,
  stripeSubscription: Stripe.Subscription,
): Promise<WebsiteSubscriptionSyncResult> {
  const result: WebsiteSubscriptionSyncResult = {
    synced: 0,
    created: 0,
    updated: 0,
    canceled: 0,
    skipped: 0,
  };

  try {
    const subscriptionItems = stripeSubscription.items.data;
    const stripeItemIds = new Set<string>(
      subscriptionItems.map((item) => item.id),
    );
    const syncedBusinessIds = new Set<string>();
    const metadataBusinessIds = getStripeMetadataBusinessIds(
      stripeSubscription.metadata,
    );
    const existingWebsiteSubscriptions =
      await prisma.websiteSubscription.findMany({
        where: {
          stripeSubscriptionId: stripeSubscription.id,
        },
      });
    const existingByBusinessId = new Map(
      existingWebsiteSubscriptions.map((subscription) => [
        subscription.businessId,
        subscription,
      ]),
    );

    const syncBusiness = async (
      businessId: string,
      subscriptionItem: Stripe.SubscriptionItem,
    ): Promise<void> => {
      try {
        const syncResult = await syncAddWebsiteSubscription({
          userId,
          businessId,
          stripeSubscription,
          subscriptionItem,
          agencyId: stripeSubscription.metadata?.agencyId,
          agencyPricingConfigId:
            stripeSubscription.metadata?.agencyPricingConfigId ?? null,
        });
        if (syncResult.operation === "created") {
          result.created++;
        } else {
          result.updated++;
        }
        result.synced++;
      } catch (error) {
        if (error instanceof WebsiteRemovalSyncBlockedError) {
          result.skipped++;
          console.log(
            `[WebsiteSubscription Sync] Skipped removal-protected business ${businessId} (${error.removalStatus})`,
          );
          return;
        }
        throw error;
      }
    };

    for (const item of subscriptionItems) {
      const businessId = item.metadata?.businessId;

      if (!businessId) {
        continue;
      }

      syncedBusinessIds.add(businessId);
      await syncBusiness(businessId, item);
    }

    for (const businessId of metadataBusinessIds) {
      if (syncedBusinessIds.has(businessId)) {
        continue;
      }

      const existingSubscription = existingByBusinessId.get(businessId);
      const subscriptionItem = resolveSafeSubscriptionItemForBusiness({
        businessId,
        existingSubscriptionItemId:
          existingSubscription?.stripeSubscriptionItemId,
        items: subscriptionItems,
      });
      syncedBusinessIds.add(businessId);
      if (!subscriptionItem) {
        result.skipped++;
        console.warn(
          `[WebsiteSubscription Sync] Skipped ambiguous item mapping for business ${businessId} on subscription ${stripeSubscription.id}`,
        );
        continue;
      }
      await syncBusiness(businessId, subscriptionItem);
    }

    for (const existingSub of existingWebsiteSubscriptions) {
      if (
        existingSub.stripeSubscriptionItemId &&
        !stripeItemIds.has(existingSub.stripeSubscriptionItemId)
      ) {
        await prisma.websiteSubscription.update({
          where: { id: existingSub.id },
          data: {
            status: "canceled",
          },
        });

        await prisma.business.updateMany({
          where: {
            id: existingSub.businessId,
            removalStatus: "active",
          },
          data: {
            websiteStatus: "canceled",
            isActive: false,
          },
        });

        result.canceled++;
        console.log(
          `[WebsiteSubscription Sync] Canceled subscription for business: ${existingSub.businessId}`,
        );
      }
    }

    await refreshSubscriptionWebsiteCount(userId);
    await reconcilePrimaryWorkspaceSafely(userId);

    console.log(
      `[WebsiteSubscription Sync] Completed for user ${userId}: synced=${result.synced}, created=${result.created}, updated=${result.updated}, canceled=${result.canceled}, skipped=${result.skipped}`,
    );

    return result;
  } catch (error) {
    console.error(
      `[WebsiteSubscription Sync] Error syncing website subscriptions for user ${userId}:`,
      error,
    );
    throw error;
  }
}

export async function syncAddWebsiteSubscription({
  userId,
  businessId,
  stripeSubscription,
  subscriptionItem,
  agencyId,
  agencyPricingConfigId,
}: SyncAddWebsiteSubscriptionInput): Promise<SyncAddWebsiteSubscriptionResult> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      userId: true,
      agencyId: true,
      removalStatus: true,
      isPrimary: true,
      isActive: true,
      websiteStatus: true,
      onboardingFlow: true,
      onboardingStatus: true,
    },
  });

  if (!business || business.userId !== userId) {
    throw new Error(
      `Business ${businessId} was not found for user ${userId} during add_website sync`,
    );
  }

  if (isRemovalLifecycleProtected(business.removalStatus)) {
    throw new WebsiteRemovalSyncBlockedError(
      businessId,
      business.removalStatus,
    );
  }

  const existingWebsiteSubscription =
    await prisma.websiteSubscription.findUnique({
      where: { businessId },
      select: {
        id: true,
        planTier: true,
        stripeSubscriptionItemId: true,
        scheduledPlanPriceId: true,
      },
    });
  const safeSubscriptionItem = resolveSafeSubscriptionItemForBusiness({
    businessId,
    existingSubscriptionItemId:
      existingWebsiteSubscription?.stripeSubscriptionItemId,
    items: stripeSubscription.items.data,
  });
  const resolvedSubscriptionItem =
    subscriptionItem?.id === safeSubscriptionItem?.id
      ? subscriptionItem
      : safeSubscriptionItem;

  if (!resolvedSubscriptionItem) {
    throw new Error(
      `Unable to safely resolve a Stripe subscription item for business ${businessId} on subscription ${stripeSubscription.id}`,
    );
  }

  const subscriptionPeriodState = getStripeSubscriptionPeriodState(
    stripeSubscription,
    {
      stripeSubscriptionItemId: resolvedSubscriptionItem.id,
      businessId,
    },
  );
  const lifecycle = resolveStripeWebsiteSubscriptionLifecycle(
    stripeSubscription,
  );
  const periodStart = subscriptionPeriodState.currentPeriodStart ?? new Date();
  const periodEnd = subscriptionPeriodState.currentPeriodEnd;

  const resolvedAgencyId =
    agencyId ?? stripeSubscription.metadata?.agencyId ?? business.agencyId ?? null;
  const resolvedAgencyPricingConfigId =
    agencyPricingConfigId ??
    stripeSubscription.metadata?.agencyPricingConfigId ??
    null;

  const planTier = resolveWebsitePlanTier({
    databasePlanTier: existingWebsiteSubscription?.planTier ?? null,
    stripeMetadataPlanTier: stripeSubscription.metadata?.planTier,
    stripePriceId: resolvedSubscriptionItem?.price.id ?? null,
  });
  const deferSecondaryOnboardingActivation =
    business.onboardingFlow === "website_secondary" &&
    business.onboardingStatus !== "completed" &&
    ["active", "trialing"].includes(lifecycle.websiteSubscriptionStatus);
  const syncedBusinessWebsiteStatus = deferSecondaryOnboardingActivation
    ? "pending"
    : lifecycle.businessWebsiteStatus;
  const syncedBusinessIsActive = deferSecondaryOnboardingActivation
    ? false
    : lifecycle.businessIsActive;
  const scheduledPlanWasApplied = Boolean(
    existingWebsiteSubscription?.scheduledPlanPriceId &&
      existingWebsiteSubscription.scheduledPlanPriceId ===
        resolvedSubscriptionItem.price.id,
  );

  await prisma.websiteSubscription.upsert({
    where: { businessId },
    create: {
      businessId,
      stripeSubscriptionId: stripeSubscription.id,
      stripeSubscriptionItemId: resolvedSubscriptionItem?.id || null,
      stripePriceId: resolvedSubscriptionItem?.price.id || null,
      planTier,
      status: lifecycle.websiteSubscriptionStatus,
      trialStatus: lifecycle.trialStatus,
      trialStartDate: lifecycle.trialStartDate,
      trialEndDate: lifecycle.trialEndDate,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      agencyId: resolvedAgencyId,
      agencyPricingConfigId: resolvedAgencyPricingConfigId,
    },
    update: {
      stripeSubscriptionId: stripeSubscription.id,
      stripeSubscriptionItemId: resolvedSubscriptionItem?.id || null,
      stripePriceId: resolvedSubscriptionItem?.price.id || null,
      planTier,
      status: lifecycle.websiteSubscriptionStatus,
      trialStatus: lifecycle.trialStatus,
      trialStartDate: lifecycle.trialStartDate ?? undefined,
      trialEndDate: lifecycle.trialEndDate ?? undefined,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      agencyId: resolvedAgencyId,
      agencyPricingConfigId: resolvedAgencyPricingConfigId,
      ...(scheduledPlanWasApplied
        ? {
            stripePlanScheduleId: null,
            scheduledPlanPriceId: null,
            scheduledPlanTier: null,
            scheduledBillingInterval: null,
            scheduledPlanChangeAt: null,
          }
        : {}),
    },
  });

  await prisma.business.update({
    where: { id: businessId },
    data: {
      stripeSubscriptionItemId: resolvedSubscriptionItem?.id || null,
      websiteStatus: syncedBusinessWebsiteStatus,
      isActive: syncedBusinessIsActive,
      ...(deferSecondaryOnboardingActivation ? { isPrimary: false } : {}),
    },
  });

  if (
    lifecycle.trialStatus === "trialing" &&
    isOnboardingV2TrialMetadata(stripeSubscription.metadata)
  ) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        trialUsed: true,
        trialStatus: "active",
        trialStartDate: lifecycle.trialStartDate ?? periodStart,
        trialEndDate: lifecycle.trialEndDate ?? periodEnd,
      },
    });
  }

  await refreshSubscriptionWebsiteCount(userId);
  await reconcilePrimaryWorkspaceSafely(userId);

  return {
    businessId,
    operation: existingWebsiteSubscription ? "updated" : "created",
    websiteStatus: syncedBusinessWebsiteStatus,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    stripeSubscriptionItemId: resolvedSubscriptionItem?.id || null,
    stripePriceId: resolvedSubscriptionItem?.price.id || null,
    planTier,
  };
}

export async function cancelAllWebsiteSubscriptions(
  userId: string,
  stripeSubscriptionId: string,
  businessIds?: string[] | null,
): Promise<number> {
  try {
    const scopedBusinessIds = Array.from(
      new Set((businessIds ?? []).filter(Boolean)),
    );
    const websiteSubscriptions = await prisma.websiteSubscription.findMany({
      where: {
        business: { userId },
        OR: [
          { stripeSubscriptionId },
          ...(scopedBusinessIds.length > 0
            ? [{ businessId: { in: scopedBusinessIds } }]
            : []),
        ],
      },
    });

    const resolvedBusinessIds = Array.from(
      new Set([
        ...scopedBusinessIds,
        ...websiteSubscriptions.map((webSub) => webSub.businessId),
      ]),
    );

    if (websiteSubscriptions.length > 0) {
      await prisma.websiteSubscription.updateMany({
        where: {
          id: { in: websiteSubscriptions.map((webSub) => webSub.id) },
        },
        data: {
          status: "canceled",
        },
      });
    }

    if (resolvedBusinessIds.length > 0) {
      await prisma.business.updateMany({
        where: {
          userId,
          id: { in: resolvedBusinessIds },
        },
        data: {
          websiteStatus: "canceled",
          isActive: false,
        },
      });
    }

    await refreshSubscriptionWebsiteCount(userId);
    await reconcilePrimaryWorkspaceSafely(userId);

    console.log(
      `[WebsiteSubscription] Canceled scoped website subscriptions for user ${userId}, count: ${websiteSubscriptions.length}, businesses=${resolvedBusinessIds.length}`,
    );

    return websiteSubscriptions.length;
  } catch (error) {
    console.error(
      `[WebsiteSubscription] Error canceling website subscriptions for user ${userId}:`,
      error,
    );
    throw error;
  }
}

export async function updateWebsiteSubscriptionStatus(
  userId: string,
  status: string,
  options?: UpdateWebsiteSubscriptionStatusOptions,
): Promise<void> {
  try {
    const websiteSubscriptionStatus = mapStripeStatusToWebsiteStatus(status);
    const businessWebsiteStatus = mapStripeStatusToBusinessWebsiteStatus(status);
    const scopedBusinessIds = Array.from(
      new Set((options?.businessIds ?? []).filter(Boolean)),
    );
    const scopeWhere =
      options?.stripeSubscriptionId || scopedBusinessIds.length > 0
        ? {
            business: {
              userId,
            },
            OR: [
              ...(options?.stripeSubscriptionId
                ? [{ stripeSubscriptionId: options.stripeSubscriptionId }]
                : []),
              ...(scopedBusinessIds.length > 0
                ? [{ businessId: { in: scopedBusinessIds } }]
                : []),
            ],
          }
        : {
            business: {
              userId,
            },
          };

    const websiteSubscriptions = await prisma.websiteSubscription.findMany({
      where: scopeWhere,
      select: {
        id: true,
        businessId: true,
        business: {
          select: {
            removalStatus: true,
          },
        },
      },
    });
    const mutableWebsiteSubscriptions = websiteSubscriptions.filter(
      (subscription) =>
        !isRemovalLifecycleProtected(subscription.business.removalStatus),
    );

    const resolvedBusinessIds = Array.from(
      new Set([
        ...scopedBusinessIds,
        ...mutableWebsiteSubscriptions.map(
          (subscription) => subscription.businessId,
        ),
      ]),
    );

    if (mutableWebsiteSubscriptions.length > 0) {
      await prisma.websiteSubscription.updateMany({
        where: {
          id: {
            in: mutableWebsiteSubscriptions.map(
              (subscription) => subscription.id,
            ),
          },
        },
        data: {
          status: websiteSubscriptionStatus,
        },
      });
    }

    if (resolvedBusinessIds.length > 0) {
      await prisma.business.updateMany({
        where: {
          userId,
          id: { in: resolvedBusinessIds },
          removalStatus: "active",
        },
        data: {
          websiteStatus: businessWebsiteStatus,
          isActive:
            businessWebsiteStatus === "active" ||
            businessWebsiteStatus === "trial",
        },
      });
    }

    await refreshSubscriptionWebsiteCount(userId);
    await reconcilePrimaryWorkspaceSafely(userId);

    console.log(
      `[WebsiteSubscription] Updated scoped website subscription statuses to ${websiteSubscriptionStatus} for user ${userId}`,
    );
  } catch (error) {
    console.error(
      `[WebsiteSubscription] Error updating website subscription status for user ${userId}:`,
      error,
    );
    throw error;
  }
}

function mapStripeStatusToWebsiteStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "suspended";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "suspended";
    default:
      return "suspended";
  }
}

function mapStripeStatusToBusinessWebsiteStatus(stripeStatus: string): string {
  if (stripeStatus === "trialing") {
    return "trial";
  }

  return mapStripeStatusToWebsiteStatus(stripeStatus);
}

export async function convertTrialToSubscription(
  userId: string,
  businessIds?: string[] | null,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      console.warn(`[Trial Conversion] User not found: ${userId}`);
      return;
    }

    if (user.trialStatus === "active") {
      const scopedBusinessIds = Array.from(
        new Set((businessIds ?? []).filter(Boolean)),
      );
      const businessScope =
        scopedBusinessIds.length > 0 ? { id: { in: scopedBusinessIds } } : {};

      await prisma.user.update({
        where: { id: userId },
        data: {
          trialStatus: "converted",
        },
      });

      await prisma.business.updateMany({
        where: {
          userId,
          websiteStatus: "trial",
          removalStatus: "active",
          ...businessScope,
        },
        data: {
          websiteStatus: "active",
        },
      });

      if (PER_SITE_TRIALS_ENABLED) {
        await prisma.websiteSubscription.updateMany({
          where: {
            business: { userId, removalStatus: "active" },
            ...(scopedBusinessIds.length > 0
              ? { businessId: { in: scopedBusinessIds } }
              : {}),
            trialStatus: "trialing",
          },
          data: {
            trialStatus: "converted",
            status: "active",
          },
        });
      }

      console.log(
        `✅ [Trial Conversion] User ${userId} trial converted to subscription`,
      );
    }
  } catch (error) {
    console.error(
      `[Trial Conversion] Error converting trial for user ${userId}:`,
      error,
    );
    throw error;
  }
}
