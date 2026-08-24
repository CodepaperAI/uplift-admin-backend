import type { Response } from "express";
import Stripe from "stripe";
import { z, ZodError } from "zod";

import { BRAND } from "../config/brand.config";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { handleValidationError, sendError, sendSuccess } from "../utils/response.utils";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "../utils/tenant-response-cache";
import { resolveSubscriptionPrice } from "../services/agency-pricing.service";
import {
  markInitialSocialTopicPlanFailed,
  markInitialSocialTopicPlanQueued,
} from "../services/social-topic-initialization.service";
import {
  changeStripeSubscriptionPlan,
  isSubscriptionDowngrade,
  isStripePaidIntroPeriod,
  releaseStripeSubscriptionPlanChange,
  scheduleStripeSubscriptionPlanChange,
  stripeSubscriptionScheduleId,
  stripePaidIntroDates,
  stripePlanTargetPriceId,
  type SubscriptionBillingPeriod,
  type SubscriptionPlanTier,
} from "../services/stripe-plan-change.service";

const REQUEST = z.object({ businessId: z.string().uuid().nullable().optional() }).strict();
const CANCEL_REQUEST = REQUEST.extend({
  cancelAtPeriodEnd: z.boolean().default(true),
}).strict();
const CHANGE_PLAN_REQUEST = REQUEST.extend({
  targetPlan: z.literal("yearly").optional(),
  targetBillingPeriod: z.enum(["monthly", "yearly"]).optional(),
  targetPlanTier: z.enum(["SEO", "SEO_SOCIAL"]).optional(),
}).strict();
const CANCEL_SCHEDULED_PLAN_CHANGE_REQUEST = REQUEST;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
    })
  : null;

const PORTAL_STATUSES = new Set([
  "trialing", "active", "past_due", "unpaid", "incomplete", "incomplete_expired",
]);
const PAYMENT_METHOD_STATUSES = new Set([
  "active", "past_due", "unpaid", "incomplete", "incomplete_expired",
]);
const MAX_INVOICE_PAGES = 2;
const INVOICES_PER_PAGE = 100;
export const BILLING_HISTORY_CACHE_NAMESPACE = "billing-history-v1";
export const SUBSCRIPTION_STATUS_CACHE_NAMESPACE =
  "billing-subscription-status-v2";

type InvoiceLineWithSubscriptionItem = Stripe.InvoiceLineItem & {
  subscription_item?: string | null;
  parent?: {
    subscription_item_details?: {
      subscription_item?: string | null;
    } | null;
  } | null;
};

type ExpandedCustomer = Stripe.Customer & {
  invoice_settings?: Stripe.Customer.InvoiceSettings & {
    default_payment_method?: string | Stripe.PaymentMethod | null;
  };
};

async function ownedBillingTarget(userId: string, businessId?: string | null) {
  return prisma.business.findFirst({
    where: businessId
      ? { id: businessId, userId }
      : {
          userId,
          websiteSubscription: {
            is: { stripeSubscriptionId: { not: null } },
          },
        },
    include: { websiteSubscription: true },
    orderBy: businessId ? undefined : [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

async function ownedBillingReadTarget(userId: string, businessId?: string | null) {
  return prisma.business.findFirst({
    where: businessId ? { id: businessId, userId } : { userId },
    include: { websiteSubscription: true },
    orderBy: businessId ? undefined : [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

type StripePeriod = Stripe.Subscription & {
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
};

function periodEnd(subscription: Stripe.Subscription): Date | null {
  const seconds = (subscription as StripePeriod).current_period_end;
  if (typeof seconds === "number") return new Date(seconds * 1000);
  const itemSeconds = (
    subscription.items.data[0] as Stripe.SubscriptionItem & {
      current_period_end?: number | null;
    }
  )?.current_period_end;
  return typeof itemSeconds === "number" ? new Date(itemSeconds * 1000) : null;
}

function itemPeriodDate(
  item: Stripe.SubscriptionItem,
  key: "current_period_start" | "current_period_end",
) {
  const seconds = (item as Stripe.SubscriptionItem & {
    current_period_start?: number | null;
    current_period_end?: number | null;
  })[key];
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

function websiteSubscriptionStatus(stripeStatus: Stripe.Subscription.Status) {
  if (stripeStatus === "active") return "active";
  if (stripeStatus === "trialing") return "trialing";
  if (stripeStatus === "past_due") return "past_due";
  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") {
    return "canceled";
  }
  return "suspended";
}

function websiteStatus(stripeStatus: Stripe.Subscription.Status) {
  if (stripeStatus === "trialing") return "trial";
  if (stripeStatus === "active") return "active";
  if (stripeStatus === "past_due") return "past_due";
  if (stripeStatus === "unpaid" || stripeStatus === "incomplete") return "suspended";
  return "canceled";
}

function assertStripeBinding(
  subscription: Stripe.Subscription,
  userId: string,
  businessId: string,
  subscriptionItemId?: string | null,
) {
  const metadataUserId = subscription.metadata?.userId?.trim();
  if (metadataUserId && metadataUserId !== userId) {
    throw new Error("STRIPE_OWNERSHIP_MISMATCH");
  }
  if (subscriptionItemId) {
    const item = subscription.items.data.find(
      (candidate) => candidate.id === subscriptionItemId,
    );
    if (!item) throw new Error("STRIPE_OWNERSHIP_MISMATCH");
    const itemBusinessId = item?.metadata?.businessId?.trim();
    if (itemBusinessId && itemBusinessId !== businessId) {
      throw new Error("STRIPE_OWNERSHIP_MISMATCH");
    }
  }
}

export async function getBillingHistory(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = REQUEST.parse({
      businessId:
        typeof req.query.businessId === "string" ? req.query.businessId : undefined,
    });
    const cached = await readTenantCache<Record<string, unknown>>({
      namespace: BILLING_HISTORY_CACHE_NAMESPACE,
      userId: req.authUserId,
      businessId: businessId ?? null,
    });
    if (cached) return sendSuccess(res, cached);
    const target = await ownedBillingReadTarget(req.authUserId, businessId);
    if (businessId && !target) return sendError(res, "Business not found", 404);
    if (!target) {
      return sendSuccess(res, {
        selectedWebsiteId: null,
        canOpenBillingPortal: false,
        canManagePaymentMethod: false,
        paymentMethod: null,
        billingContact: null,
        invoices: [],
        emptyState: "unavailable",
      });
    }

    const websiteSubscription = target.websiteSubscription;
    if (!websiteSubscription?.stripeSubscriptionId) {
      return sendSuccess(res, {
        selectedWebsiteId: target.id,
        canOpenBillingPortal: false,
        canManagePaymentMethod: false,
        paymentMethod: null,
        billingContact: null,
        invoices: [],
        emptyState: billingEmptyState(target),
      });
    }
    if (!stripe) return sendError(res, "Billing is temporarily unavailable", 503);

    const [accountSubscription, liveSubscription] = await Promise.all([
      prisma.subscription.findUnique({
        where: { userId: req.authUserId },
        select: { stripeCustomerId: true, stripeSubscriptionId: true },
      }),
      stripe.subscriptions.retrieve(websiteSubscription.stripeSubscriptionId, {
        expand: ["default_payment_method"],
      }),
    ]);
    assertStripeBinding(
      liveSubscription,
      req.authUserId,
      target.id,
      websiteSubscription.stripeSubscriptionItemId,
    );
    const liveCustomerId =
      typeof liveSubscription.customer === "string"
        ? liveSubscription.customer
        : liveSubscription.customer.id;
    if (
      accountSubscription?.stripeCustomerId &&
      accountSubscription.stripeCustomerId !== liveCustomerId
    ) {
      return sendError(res, "Billing is not available for this website", 403);
    }

    const customerResult = await stripe.customers.retrieve(liveCustomerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if ("deleted" in customerResult && customerResult.deleted) {
      return sendError(res, "Billing is temporarily unavailable", 503);
    }
    const customer = customerResult as ExpandedCustomer;
    const [customerPaymentMethod, subscriptionPaymentMethod, invoiceList] =
      await Promise.all([
        resolvePaymentMethod(
          stripe,
          customer.invoice_settings?.default_payment_method,
        ),
        resolvePaymentMethod(stripe, liveSubscription.default_payment_method),
        listBoundedInvoices(
          stripe,
          liveCustomerId,
          websiteSubscription.stripeSubscriptionId,
        ),
      ]);

    const uniqueSubscription =
      accountSubscription?.stripeSubscriptionId !==
      websiteSubscription.stripeSubscriptionId;
    const invoices = invoiceList
      .filter((invoice) =>
        invoiceBelongsToTarget({
          invoice,
          businessId: target.id,
          subscriptionItemId: websiteSubscription.stripeSubscriptionItemId,
          subscriptionMetadata: liveSubscription.metadata,
          uniqueSubscription,
        }),
      )
      .map(invoiceSummary);
    const canManagePaymentMethod = PAYMENT_METHOD_STATUSES.has(
      liveSubscription.status,
    );

    const responsePayload = {
      selectedWebsiteId: target.id,
      canOpenBillingPortal: canManagePaymentMethod || invoices.length > 0,
      canManagePaymentMethod,
      paymentMethod:
        paymentMethodSummary(customerPaymentMethod) ??
        paymentMethodSummary(subscriptionPaymentMethod),
      billingContact: {
        name: customer.name ?? null,
        email: customer.email ?? null,
        addressLine: formatAddress(customer.address),
      },
      invoices,
      emptyState: invoices.length ? "unavailable" : billingEmptyState(target),
    };
    await writeTenantCache({
      namespace: BILLING_HISTORY_CACHE_NAMESPACE,
      userId: req.authUserId,
      businessId: businessId ?? null,
      value: responsePayload,
      ttlSeconds: 30,
    });
    return sendSuccess(res, responsePayload);
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[billing] history failed:", error);
    return sendError(res, "Billing history is temporarily unavailable", 503);
  }
}

function invoiceLineSubscriptionItemId(line: Stripe.InvoiceLineItem) {
  const typed = line as InvoiceLineWithSubscriptionItem;
  if (typeof typed.subscription_item === "string" && typed.subscription_item) {
    return typed.subscription_item;
  }
  const nested = typed.parent?.subscription_item_details?.subscription_item;
  return typeof nested === "string" && nested ? nested : null;
}

function metadataBusinessIds(metadata?: Stripe.Metadata | null) {
  if (!metadata) return [];
  return Array.from(
    new Set(
      [metadata.primaryBusinessId, metadata.businessId]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function invoiceBelongsToTarget(input: {
  invoice: Stripe.Invoice;
  businessId: string;
  subscriptionItemId?: string | null;
  subscriptionMetadata?: Stripe.Metadata | null;
  uniqueSubscription: boolean;
}) {
  if (input.subscriptionItemId) {
    const itemIds = input.invoice.lines.data
      .map(invoiceLineSubscriptionItemId)
      .filter((value): value is string => Boolean(value));
    if (itemIds.length) return itemIds.includes(input.subscriptionItemId);
  }
  const businessIds = metadataBusinessIds({
    ...(input.subscriptionMetadata ?? {}),
    ...(input.invoice.metadata ?? {}),
  } as Stripe.Metadata);
  if (businessIds.length) return businessIds.includes(input.businessId);
  return input.uniqueSubscription;
}

function isoTimestamp(value?: number | null) {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function invoiceSummary(invoice: Stripe.Invoice) {
  const firstLine = invoice.lines.data[0];
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    currency: invoice.currency ?? "usd",
    totalCents: invoice.total ?? invoice.subtotal ?? 0,
    amountPaidCents: invoice.amount_paid ?? 0,
    amountDueCents: invoice.amount_due ?? 0,
    createdAt: isoTimestamp(invoice.created),
    periodStart: isoTimestamp(firstLine?.period?.start),
    periodEnd: isoTimestamp(firstLine?.period?.end),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}

function formatAddress(address?: Stripe.Address | null) {
  if (!address) return null;
  const parts = [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(", "),
    [address.postal_code, address.country].filter(Boolean).join(", "),
  ]
    .map((part) => part?.trim())
    .filter(Boolean);
  return parts.length ? parts.join(" • ") : null;
}

async function resolvePaymentMethod(
  stripeClient: Stripe,
  reference?: string | Stripe.PaymentMethod | null,
) {
  if (!reference) return null;
  return typeof reference === "string"
    ? stripeClient.paymentMethods.retrieve(reference)
    : reference;
}

function paymentMethodSummary(paymentMethod: Stripe.PaymentMethod | null) {
  if (!paymentMethod || paymentMethod.type !== "card" || !paymentMethod.card) {
    return null;
  }
  return {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
    funding: paymentMethod.card.funding ?? null,
    country: paymentMethod.card.country ?? null,
  };
}

function billingEmptyState(target: NonNullable<Awaited<ReturnType<typeof ownedBillingTarget>>>) {
  const subscription = target.websiteSubscription;
  if (
    subscription?.trialStatus === "trialing" ||
    subscription?.status === "trialing" ||
    target.websiteStatus === "trial"
  ) {
    return "trial" as const;
  }
  return subscription?.stripeSubscriptionId
    ? ("no_history" as const)
    : ("not_subscribed" as const);
}

async function listBoundedInvoices(
  stripeClient: Stripe,
  customerId: string | null,
  subscriptionId: string,
) {
  const invoices: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_INVOICE_PAGES; pageNumber += 1) {
    const page = await stripeClient.invoices.list({
      ...(customerId ? { customer: customerId } : {}),
      subscription: subscriptionId,
      limit: INVOICES_PER_PAGE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    invoices.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) break;
  }
  return invoices;
}

type DisplaySubscriptionStatus =
  | "active"
  | "trialing"
  | "expired"
  | "none"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired";

type WebsiteEntitlementStatus =
  | "subscribed"
  | "not_subscribed"
  | "trial"
  | "expired";

function websiteEntitlementStatus(
  business: { websiteStatus: string | null },
  websiteSubscription: {
    status: string;
    trialStatus?: string | null;
    trialEndDate?: Date | null;
  } | null,
  account: {
    subscription: { currentPeriodEnd?: Date | null; status?: string | null } | null;
    user: {
      onboarding?: boolean | null;
      trialEndDate?: Date | null;
      trialStartDate?: Date | null;
      trialStatus?: string | null;
    } | null;
  },
): WebsiteEntitlementStatus {
  const legacyActiveAccount = Boolean(
    account.user?.onboarding &&
      !account.user?.trialStartDate &&
      !account.user?.trialStatus &&
      !account.subscription,
  );
  if (!websiteSubscription) {
    if (PER_SITE_TRIALS_ENABLED) {
      return legacyActiveAccount ? "subscribed" : "not_subscribed";
    }
    if (legacyActiveAccount || business.websiteStatus === "active") {
      return "subscribed";
    }
    if (business.websiteStatus === "trial") return "trial";
    if (business.websiteStatus === "expired") return "expired";
    return "not_subscribed";
  }

  const badStatuses = new Set([
    "past_due",
    "unpaid",
    "incomplete",
    "suspended",
    "canceled",
    "expired",
  ]);
  if (badStatuses.has(websiteSubscription.status)) {
    return websiteSubscription.status === "expired" ? "expired" : "not_subscribed";
  }
  const trialEnd = websiteSubscription.trialEndDate?.getTime() ?? null;
  const trialValid = trialEnd != null && trialEnd > Date.now();
  const trialExpired = trialEnd != null && trialEnd <= Date.now();

  if (PER_SITE_TRIALS_ENABLED) {
    if (
      websiteSubscription.trialStatus === "expired" ||
      websiteSubscription.status === "expired" ||
      ((websiteSubscription.trialStatus === "trialing" ||
        websiteSubscription.status === "trialing") &&
        trialExpired)
    ) {
      return "expired";
    }
    if (
      websiteSubscription.trialStatus === "trialing" &&
      (!websiteSubscription.trialEndDate || trialValid)
    ) {
      return "trial";
    }
    if (
      websiteSubscription.status === "active" &&
      websiteSubscription.trialStatus !== "trialing"
    ) {
      return "subscribed";
    }
    return legacyActiveAccount ? "subscribed" : "not_subscribed";
  }

  if (
    websiteSubscription.trialStatus === "expired" ||
    (websiteSubscription.trialStatus === "trialing" && trialExpired)
  ) {
    return "expired";
  }
  if (websiteSubscription.trialStatus === "trialing" && trialValid) return "trial";
  if (
    ["converted", "none"].includes(websiteSubscription.trialStatus ?? "") &&
    ["active", "trialing"].includes(websiteSubscription.status)
  ) {
    return "subscribed";
  }
  if (["active", "trialing"].includes(websiteSubscription.status)) {
    return "subscribed";
  }
  if (business.websiteStatus === "trial") return "trial";
  if (business.websiteStatus === "expired") return "expired";
  if (business.websiteStatus === "active") return "subscribed";
  return "not_subscribed";
}

function billingInterval(priceId?: string | null) {
  if (!priceId) return null;
  const yearlyIds = new Set(
    [process.env.UPLIFT_YEARLY_PRICE_ID, process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return yearlyIds.has(priceId) ? ("yearly" as const) : ("monthly" as const);
}

function stripeRecurringBillingInterval(price?: Stripe.Price | null) {
  if (!price?.recurring || price.recurring.interval_count !== 1) return null;
  if (price.recurring.interval === "year") return "yearly" as const;
  if (price.recurring.interval === "month") return "monthly" as const;
  return null;
}

function planTier(input: {
  database?: string | null;
  metadata?: string | null;
  priceId?: string | null;
}) {
  if (input.metadata === "SEO" || input.metadata === "SEO_SOCIAL") {
    return input.metadata;
  }
  const socialIds = new Set(
    [process.env.UPLIFT_SEO_SOCIAL_PRICE_ID, process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  if (input.priceId && socialIds.has(input.priceId)) return "SEO_SOCIAL" as const;
  return input.database === "SEO_SOCIAL" ? ("SEO_SOCIAL" as const) : ("SEO" as const);
}

function scheduledPlanChange(
  websiteSubscription: {
    scheduledPlanPriceId?: string | null;
    scheduledPlanTier?: string | null;
    scheduledBillingInterval?: string | null;
    scheduledPlanChangeAt?: Date | null;
  } | null,
  activePriceId?: string | null,
) {
  if (
    !websiteSubscription?.scheduledPlanPriceId ||
    websiteSubscription.scheduledPlanPriceId === activePriceId ||
    (websiteSubscription.scheduledPlanTier !== "SEO" &&
      websiteSubscription.scheduledPlanTier !== "SEO_SOCIAL") ||
    (websiteSubscription.scheduledBillingInterval !== "monthly" &&
      websiteSubscription.scheduledBillingInterval !== "yearly") ||
    !websiteSubscription.scheduledPlanChangeAt
  ) {
    return null;
  }
  return {
    planTier: websiteSubscription.scheduledPlanTier,
    billingInterval: websiteSubscription.scheduledBillingInterval,
    effectiveAt: websiteSubscription.scheduledPlanChangeAt,
  };
}

function stripeRuntimeState(
  subscription: Stripe.Subscription,
  itemId?: string | null,
) {
  const item = itemId
    ? subscription.items.data.find((candidate) => candidate.id === itemId)
    : subscription.items.data[0];
  const typedItem = item as
    | (Stripe.SubscriptionItem & { current_period_end?: number | null })
    | undefined;
  const typedSubscription = subscription as Stripe.Subscription & {
    current_period_end?: number | null;
    cancel_at_period_end?: boolean | null;
  };
  return {
    cancelAtPeriodEnd: Boolean(typedSubscription.cancel_at_period_end),
    currentPeriodEnd:
      typeof typedItem?.current_period_end === "number"
        ? new Date(typedItem.current_period_end * 1000)
        : typeof typedSubscription.current_period_end === "number"
          ? new Date(typedSubscription.current_period_end * 1000)
          : null,
    priceId: item?.price.id ?? null,
    billingInterval: stripeRecurringBillingInterval(item?.price),
    isPaidOnboardingTrial:
      subscription.metadata?.checkoutFlow === "onboarding_v2_trial",
    metadataPlanTier: subscription.metadata?.planTier ?? null,
  };
}

export async function getSubscriptionStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = REQUEST.parse({
      businessId:
        typeof req.query.businessId === "string" ? req.query.businessId : undefined,
    });
    const cached = await readTenantCache<Record<string, unknown>>({
      namespace: SUBSCRIPTION_STATUS_CACHE_NAMESPACE,
      userId: req.authUserId,
      businessId: businessId ?? null,
    });
    if (cached) return sendSuccess(res, cached);

    const [accountSubscription, businesses, user] = await Promise.all([
      prisma.subscription.findUnique({ where: { userId: req.authUserId } }),
      prisma.business.findMany({
        where: { userId: req.authUserId },
        include: { websiteSubscription: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      }),
      prisma.user.findUnique({
        where: { id: req.authUserId },
        select: {
          onboarding: true,
          trialEndDate: true,
          trialStartDate: true,
          trialStatus: true,
        },
      }),
    ]);
    if (businessId && !businesses.some((business) => business.id === businessId)) {
      return sendError(res, "Business not found", 404);
    }

    const websites = businesses.map((business) => {
      const ws = business.websiteSubscription;
      const subscriptionStatus = websiteEntitlementStatus(business, ws, {
        subscription: accountSubscription,
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
          subscriptionStatus === "subscribed" || subscriptionStatus === "trial",
        subscriptionStatus,
        websiteSubscription: ws
          ? {
              status: ws.status,
              currentPeriodEnd: ws.currentPeriodEnd,
              trialStatus: ws.trialStatus,
              trialEndDate: ws.trialEndDate,
              planTier: ws.planTier,
              isStripeBacked: Boolean(ws.stripeSubscriptionId),
              scheduledPlanChange: scheduledPlanChange(ws),
            }
          : null,
      };
    });
    const activeLike = websites.filter(
      (website) => !["suspended", "failed"].includes(website.websiteStatus),
    );
    const defaultWebsite =
      activeLike.find((website) => website.subscriptionStatus === "subscribed") ??
      activeLike.find((website) => website.subscriptionStatus === "trial") ??
      activeLike.find((website) => website.isPrimary) ??
      activeLike[0] ??
      websites.find((website) => website.isPrimary) ??
      websites[0] ??
      null;
    const requested = businessId
      ? websites.find((website) => website.id === businessId) ?? null
      : null;
    const selectedWebsite =
      requested &&
      !(
        requested.subscriptionStatus === "not_subscribed" &&
        ["suspended", "failed"].includes(requested.websiteStatus) &&
        defaultWebsite &&
        defaultWebsite.id !== requested.id
      )
        ? requested
        : defaultWebsite;
    const selectedBusiness = selectedWebsite
      ? businesses.find((business) => business.id === selectedWebsite.id) ?? null
      : null;
    const selectedWs = selectedBusiness?.websiteSubscription ?? null;

    let liveState: ReturnType<typeof stripeRuntimeState> | null = null;
    if (selectedWs?.stripeSubscriptionId && stripe) {
      try {
        const live = await stripe.subscriptions.retrieve(selectedWs.stripeSubscriptionId);
        assertStripeBinding(
          live,
          req.authUserId,
          selectedBusiness!.id,
          selectedWs.stripeSubscriptionItemId,
        );
        const liveCustomerId =
          typeof live.customer === "string" ? live.customer : live.customer.id;
        if (
          accountSubscription?.stripeCustomerId &&
          accountSubscription.stripeCustomerId !== liveCustomerId
        ) {
          throw new Error("STRIPE_OWNERSHIP_MISMATCH");
        }
        liveState = stripeRuntimeState(live, selectedWs.stripeSubscriptionItemId);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "STRIPE_OWNERSHIP_MISMATCH"
        ) {
          throw error;
        }
        console.warn("[billing] live subscription status unavailable:", error);
      }
    }

    const selectedPriceId = liveState?.priceId ?? selectedWs?.stripePriceId ?? null;
    const selectedEntitlement = selectedWebsite?.subscriptionStatus ?? "not_subscribed";
    const selectedStatus = selectedWs?.status ?? null;
    let displayStatus: DisplaySubscriptionStatus = "none";
    let displayCurrentPeriodEnd: Date | null = null;
    let displayTrialEndDate: Date | null = null;
    let displayBillingInterval: "monthly" | "yearly" | null = null;
    if (selectedEntitlement === "subscribed") {
      displayStatus = "active";
      displayCurrentPeriodEnd =
        liveState?.currentPeriodEnd ?? selectedWs?.currentPeriodEnd ?? null;
      displayBillingInterval =
        liveState?.billingInterval ?? billingInterval(selectedPriceId);
    } else if (selectedEntitlement === "trial") {
      displayStatus = "trialing";
      displayCurrentPeriodEnd = selectedWs?.trialEndDate ?? null;
      displayTrialEndDate = selectedWs?.trialEndDate ?? null;
      displayBillingInterval =
        liveState?.billingInterval ?? billingInterval(selectedPriceId);
    } else if (selectedEntitlement === "expired") {
      displayStatus = "expired";
    } else if (
      selectedStatus &&
      [
        "past_due",
        "unpaid",
        "canceled",
        "incomplete",
        "incomplete_expired",
      ].includes(selectedStatus)
    ) {
      displayStatus = selectedStatus as DisplaySubscriptionStatus;
    }

    const entitledCount = websites.filter(
      (website) =>
        website.subscriptionStatus === "subscribed" ||
        website.subscriptionStatus === "trial",
    ).length;
    const [monthlySeoPricing, yearlySeoPricing, monthlySocialPricing, yearlySocialPricing] = await Promise.all([
      resolveSubscriptionPrice(
        selectedBusiness?.agencyId ?? null,
        "monthly",
        planPriceDefaults("SEO"),
        "SEO",
      ),
      resolveSubscriptionPrice(
        selectedBusiness?.agencyId ?? null,
        "yearly",
        planPriceDefaults("SEO"),
        "SEO",
      ),
      resolveSubscriptionPrice(
        selectedBusiness?.agencyId ?? null,
        "monthly",
        planPriceDefaults("SEO_SOCIAL"),
        "SEO_SOCIAL",
      ),
      resolveSubscriptionPrice(
        selectedBusiness?.agencyId ?? null,
        "yearly",
        planPriceDefaults("SEO_SOCIAL"),
        "SEO_SOCIAL",
      ),
    ]);
    const responsePayload = {
      isActive:
        selectedEntitlement === "subscribed" || selectedEntitlement === "trial",
      status:
        selectedStatus ??
        (selectedEntitlement === "trial"
          ? "trialing"
          : selectedEntitlement === "subscribed"
            ? "active"
            : selectedEntitlement === "expired"
              ? "expired"
              : "none"),
      currentPeriodEnd: displayCurrentPeriodEnd,
      accountTrialEndDate:
        accountSubscription?.currentPeriodEnd ?? user?.trialEndDate ?? null,
      cancelAtPeriodEnd:
        liveState?.cancelAtPeriodEnd ??
        (selectedWs?.stripeSubscriptionId &&
        selectedWs.stripeSubscriptionId === accountSubscription?.stripeSubscriptionId
          ? accountSubscription.cancelAtPeriodEnd
          : false),
      planName: accountSubscription?.planName ?? BRAND.name,
      billingInterval:
        selectedEntitlement === "subscribed" || selectedEntitlement === "trial"
          ? liveState?.billingInterval ?? billingInterval(selectedPriceId)
          : null,
      displayStatus,
      displayCurrentPeriodEnd,
      displayTrialEndDate,
      displayBillingInterval,
      selectedWebsiteId: selectedWebsite?.id ?? null,
      isPaidOnboardingTrial: liveState?.isPaidOnboardingTrial ?? false,
      planTier: planTier({
        database: selectedWs?.planTier,
        metadata: liveState?.metadataPlanTier,
        priceId: selectedPriceId,
      }),
      scheduledPlanChange: scheduledPlanChange(selectedWs, selectedPriceId),
      websiteCount: accountSubscription?.websiteCount ?? entitledCount,
      maxWebsites: accountSubscription?.maxWebsites ?? 10,
      websites,
      planPricing: {
        SEO: {
          monthly: {
            priceCents: monthlySeoPricing.priceCents,
            currency: monthlySeoPricing.currency,
          },
          yearly: {
            priceCents: yearlySeoPricing.priceCents,
            currency: yearlySeoPricing.currency,
          },
        },
        SEO_SOCIAL: {
          monthly: {
            priceCents: monthlySocialPricing.priceCents,
            currency: monthlySocialPricing.currency,
          },
          yearly: {
            priceCents: yearlySocialPricing.priceCents,
            currency: yearlySocialPricing.currency,
          },
        },
      },
      socialUpgradePricing: {
        monthly: {
          priceCents: monthlySocialPricing.priceCents,
          currency: monthlySocialPricing.currency,
        },
        yearly: {
          priceCents: yearlySocialPricing.priceCents,
          currency: yearlySocialPricing.currency,
        },
      },
    };
    await writeTenantCache({
      namespace: SUBSCRIPTION_STATUS_CACHE_NAMESPACE,
      userId: req.authUserId,
      businessId: businessId ?? null,
      value: responsePayload,
      ttlSeconds: 30,
    });
    return sendSuccess(res, responsePayload);
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[billing] subscription status failed:", error);
    return sendError(res, "Subscription status is temporarily unavailable", 503);
  }
}

class BillingPlanChangeError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function planPriceDefaults(planTier: "SEO" | "SEO_SOCIAL") {
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

function stripePriceBillingPeriod(price: Stripe.Price): SubscriptionBillingPeriod {
  const recurring = price.recurring;
  if (
    price.type !== "recurring" ||
    !recurring ||
    recurring.interval_count !== 1 ||
    (recurring.interval !== "month" && recurring.interval !== "year")
  ) {
    throw new BillingPlanChangeError(503, "Billing is temporarily unavailable");
  }
  return recurring.interval === "year" ? "yearly" : "monthly";
}

const CLEAR_SCHEDULED_PLAN_CHANGE = {
  stripePlanScheduleId: null,
  scheduledPlanPriceId: null,
  scheduledPlanTier: null,
  scheduledBillingInterval: null,
  scheduledPlanChangeAt: null,
} as const;

function targetSubscriptionItem(
  subscription: Stripe.Subscription,
  businessId: string,
  storedItemId?: string | null,
) {
  if (storedItemId) {
    const stored = subscription.items.data.find((item) => item.id === storedItemId);
    if (!stored) throw new BillingPlanChangeError(403, "Billing change is unavailable");
    const boundBusinessId = stored.metadata?.businessId?.trim();
    if (boundBusinessId && boundBusinessId !== businessId) {
      throw new BillingPlanChangeError(403, "Billing change is unavailable");
    }
    return stored;
  }
  const byBusiness = subscription.items.data.find(
    (item) => item.metadata?.businessId?.trim() === businessId,
  );
  if (byBusiness) return byBusiness;
  if (subscription.items.data.length === 1) return subscription.items.data[0]!;
  throw new BillingPlanChangeError(403, "Billing change is unavailable");
}

async function initializeSocialPlan(userId: string, businessId: string) {
  try {
    const existing = await prisma.socialAutomationSettings.findUnique({
      where: { businessId },
      select: { initialPlanGeneratedAt: true },
    });
    if (existing?.initialPlanGeneratedAt) {
      return { status: "ready" as const, message: null };
    }
    await markInitialSocialTopicPlanQueued(prisma, businessId);
    const queued = await inngest.send({
      name: "social/topics.plan.requested",
      data: { userId, businessId, source: "INITIAL" },
    });
    if (!queued.ids?.length) throw new Error("Social planning was not queued");
    return { status: "queued" as const, message: null };
  } catch (error) {
    await markInitialSocialTopicPlanFailed(prisma, businessId, error).catch(
      (markError) => {
        console.error(
          `[billing] could not record social planning failure for ${businessId}`,
          markError,
        );
      },
    );
    console.error(`[billing] initial social planning failed for ${businessId}`, error);
    return {
      status: "failed" as const,
      message: "The plan changed successfully. Social planning will retry in the background.",
    };
  }
}

export async function changeSubscriptionPlan(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = CHANGE_PLAN_REQUEST.parse(req.body ?? {});
    const target = await ownedBillingTarget(req.authUserId, input.businessId);
    const websiteSubscription = target?.websiteSubscription;
    if (
      !target ||
      target.removalStatus !== "active" ||
      !websiteSubscription?.stripeSubscriptionId
    ) {
      return sendError(res, "Billing is not available for this website", 404);
    }
    if (!stripe) return sendError(res, "Billing is temporarily unavailable", 503);

    const [accountSubscription, existing] = await Promise.all([
      prisma.subscription.findUnique({
        where: { userId: req.authUserId },
        select: { stripeCustomerId: true, stripeSubscriptionId: true },
      }),
      stripe.subscriptions.retrieve(websiteSubscription.stripeSubscriptionId),
    ]);
    assertStripeBinding(
      existing,
      req.authUserId,
      target.id,
      websiteSubscription.stripeSubscriptionItemId,
    );
    const customerId =
      typeof existing.customer === "string" ? existing.customer : existing.customer.id;
    if (
      !accountSubscription?.stripeCustomerId ||
      accountSubscription.stripeCustomerId !== customerId
    ) {
      throw new BillingPlanChangeError(403, "Billing change is unavailable");
    }
    const currentItem = targetSubscriptionItem(
      existing,
      target.id,
      websiteSubscription.stripeSubscriptionItemId,
    );
    const currentSelectedPriceId =
      stripePlanTargetPriceId(existing) ?? currentItem.price.id;
    if (existing.status !== "active" && existing.status !== "trialing") {
      throw new BillingPlanChangeError(
        409,
        "The subscription cannot be changed in its current state",
      );
    }
    if (existing.cancel_at_period_end) {
      throw new BillingPlanChangeError(
        409,
        "Reactivate the subscription before changing its plan",
      );
    }

    const currentPrice =
      currentSelectedPriceId === currentItem.price.id
        ? currentItem.price
        : await stripe.prices.retrieve(currentSelectedPriceId);
    const currentBillingPeriod = stripePriceBillingPeriod(currentPrice);
    const currentPlanTier = planTier({
      database: websiteSubscription.planTier,
      metadata: existing.metadata?.planTier,
      priceId: currentSelectedPriceId,
    }) as SubscriptionPlanTier;
    const targetBillingPeriod =
      input.targetBillingPeriod ??
      (input.targetPlan === "yearly" ? "yearly" : currentBillingPeriod);
    const targetPlanTier = (input.targetPlanTier ??
      currentPlanTier) as SubscriptionPlanTier;
    if (
      targetPlanTier === currentPlanTier &&
      targetBillingPeriod === currentBillingPeriod
    ) {
      throw new BillingPlanChangeError(409, "The selected plan is already active");
    }

    const pricing = await resolveSubscriptionPrice(
      target.agencyId ?? null,
      targetBillingPeriod,
      planPriceDefaults(targetPlanTier),
      targetPlanTier,
    );
    if (!pricing.stripePriceId) {
      return sendError(res, "Billing is temporarily unavailable", 503);
    }
    const configuredPrice = await stripe.prices.retrieve(pricing.stripePriceId);
    if (
      !configuredPrice.active ||
      configuredPrice.type !== "recurring" ||
      configuredPrice.unit_amount !== pricing.priceCents ||
      configuredPrice.currency.toLowerCase() !== pricing.currency.toLowerCase() ||
      stripePriceBillingPeriod(configuredPrice) !== targetBillingPeriod
    ) {
      throw new BillingPlanChangeError(503, "Billing is temporarily unavailable");
    }

    const isDowngrade = isSubscriptionDowngrade({
      currentPlanTier,
      currentBillingPeriod,
      targetPlanTier,
      targetBillingPeriod,
    });
    if (isDowngrade) {
      if (existing.status !== "active" || isStripePaidIntroPeriod(existing)) {
        throw new BillingPlanChangeError(
          409,
          "This change will be available after the trial period ends",
        );
      }
      const scheduled = await scheduleStripeSubscriptionPlanChange(
        stripe,
        existing,
        {
          businessId: target.id,
          currentPriceId: currentItem.price.id,
          targetPrice: configuredPrice,
          targetPlanTier,
          targetBillingPeriod,
        },
      );
      await prisma.websiteSubscription.update({
        where: { id: websiteSubscription.id },
        data: {
          stripePlanScheduleId: scheduled.schedule.id,
          scheduledPlanPriceId: configuredPrice.id,
          scheduledPlanTier: targetPlanTier,
          scheduledBillingInterval: targetBillingPeriod,
          scheduledPlanChangeAt: scheduled.effectiveAt,
        },
      });
      await Promise.all([
        invalidateTenantCache(req.authUserId),
        invalidateTenantCache(req.authUserId, target.id),
      ]);
      return sendSuccess(
        res,
        {
          businessId: target.id,
          changeType: "scheduled",
          currentPlanTier,
          currentBillingPeriod,
          targetPlanTier,
          targetBillingPeriod,
          effectiveAt: scheduled.effectiveAt,
        },
        "Subscription change scheduled",
      );
    }

    const liveScheduleId = stripeSubscriptionScheduleId(existing);
    if (websiteSubscription.stripePlanScheduleId) {
      if (liveScheduleId !== websiteSubscription.stripePlanScheduleId) {
        throw new BillingPlanChangeError(409, "Billing change could not be completed");
      }
      await releaseStripeSubscriptionPlanChange(stripe, {
        scheduleId: websiteSubscription.stripePlanScheduleId,
        businessId: target.id,
        subscriptionId: existing.id,
      });
    } else if (liveScheduleId && !isStripePaidIntroPeriod(existing)) {
      throw new BillingPlanChangeError(
        409,
        "A billing change is already being managed for this subscription",
      );
    }

    const updated = await changeStripeSubscriptionPlan(stripe, existing, {
      businessId: target.id,
      itemId: currentItem.id,
      planTier: targetPlanTier,
      priceId: pricing.stripePriceId,
    });
    assertStripeBinding(
      updated,
      req.authUserId,
      target.id,
      websiteSubscription.stripeSubscriptionItemId,
    );
    const updatedItem = targetSubscriptionItem(updated, target.id, currentItem.id);
    const paidIntro = isStripePaidIntroPeriod(updated);
    const trialLike = paidIntro || updated.status === "trialing";
    const paidIntroDates = paidIntro ? stripePaidIntroDates(updated) : null;
    const currentPeriodStart =
      itemPeriodDate(updatedItem, "current_period_start") ??
      websiteSubscription.currentPeriodStart ??
      new Date();
    const currentPeriodEnd =
      itemPeriodDate(updatedItem, "current_period_end") ??
      periodEnd(updated) ??
      websiteSubscription.currentPeriodEnd;
    const subscriptionState = trialLike
      ? "trialing"
      : websiteSubscriptionStatus(updated.status);
    const businessState = trialLike ? "trial" : websiteStatus(updated.status);
    const deferSecondaryActivation =
      target.onboardingFlow === "website_secondary" &&
      target.onboardingStatus !== "completed" &&
      ["active", "trialing"].includes(subscriptionState);
    const syncedBusinessState = deferSecondaryActivation ? "pending" : businessState;
    const syncedBusinessActive = deferSecondaryActivation
      ? false
      : businessState === "active" || businessState === "trial";
    const cancelAtPeriodEnd = Boolean(updated.cancel_at_period_end);

    await prisma.$transaction(async (transaction) => {
      await transaction.websiteSubscription.update({
        where: { id: websiteSubscription.id },
        data: {
          stripeSubscriptionId: updated.id,
          stripeSubscriptionItemId: updatedItem.id,
          stripePriceId: pricing.stripePriceId,
          planTier: targetPlanTier,
          status: subscriptionState,
          trialStatus: trialLike ? "trialing" : "converted",
          ...(trialLike
            ? {
                trialStartDate:
                  paidIntroDates?.start ??
                  (typeof updated.trial_start === "number"
                    ? new Date(updated.trial_start * 1000)
                    : currentPeriodStart),
                trialEndDate:
                  paidIntroDates?.end ??
                  (typeof updated.trial_end === "number"
                    ? new Date(updated.trial_end * 1000)
                    : currentPeriodEnd),
              }
            : {}),
          currentPeriodStart,
          currentPeriodEnd,
          agencyId: pricing.agencyId ?? target.agencyId ?? null,
          agencyPricingConfigId: pricing.agencyPricingConfigId,
          ...CLEAR_SCHEDULED_PLAN_CHANGE,
        },
      });
      await transaction.business.update({
        where: { id: target.id },
        data: {
          stripeSubscriptionItemId: updatedItem.id,
          websiteStatus: syncedBusinessState,
          isActive: syncedBusinessActive,
          ...(deferSecondaryActivation ? { isPrimary: false } : {}),
        },
      });
      if (accountSubscription.stripeSubscriptionId === updated.id) {
        await transaction.subscription.updateMany({
          where: { userId: req.authUserId, stripeSubscriptionId: updated.id },
          data: {
            stripePriceId: pricing.stripePriceId,
            planName: `${BRAND.name} ${targetPlanTier === "SEO_SOCIAL" ? "SEO + Social" : "SEO"} ${targetBillingPeriod === "yearly" ? "Yearly" : "Monthly"}`,
            status: updated.status,
            stripeStatus: updated.status,
            cancelAtPeriodEnd,
            stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
            currentPeriodEnd,
            stripeCurrentPeriodEnd: currentPeriodEnd,
          },
        });
      }
      if (trialLike && updated.metadata?.checkoutFlow === "onboarding_v2_trial") {
        await transaction.user.update({
          where: { id: req.authUserId },
          data: {
            trialUsed: true,
            trialStatus: "active",
            trialStartDate: paidIntroDates?.start ?? currentPeriodStart,
            trialEndDate: paidIntroDates?.end ?? currentPeriodEnd,
          },
        });
      }
    });
    await Promise.all([
      invalidateTenantCache(req.authUserId),
      invalidateTenantCache(req.authUserId, target.id),
    ]);
    const socialInitialization =
      targetPlanTier === "SEO_SOCIAL"
        ? await initializeSocialPlan(req.authUserId, target.id)
        : null;
    return sendSuccess(
      res,
      {
        businessId: target.id,
        changeType: "immediate",
        currentPlanTier,
        currentBillingPeriod,
        billingInterval: targetBillingPeriod,
        planTier: targetPlanTier,
        currentPeriodEnd,
        effectiveAt: null,
        ...(socialInitialization ? { socialInitialization } : {}),
      },
      "Subscription plan changed",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof BillingPlanChangeError) {
      return sendError(res, error.publicMessage, error.status);
    }
    if (error instanceof Error && error.message === "STRIPE_OWNERSHIP_MISMATCH") {
      return sendError(res, "Billing change is unavailable", 403);
    }
    console.error("[billing] plan change failed:", error);
    return sendError(res, "Billing change could not be completed", 409);
  }
}

export async function cancelScheduledSubscriptionPlanChange(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = CANCEL_SCHEDULED_PLAN_CHANGE_REQUEST.parse(req.body ?? {});
    const target = await ownedBillingTarget(req.authUserId, input.businessId);
    const websiteSubscription = target?.websiteSubscription;
    if (
      !target ||
      !websiteSubscription?.stripeSubscriptionId ||
      !websiteSubscription.stripePlanScheduleId
    ) {
      return sendError(res, "No scheduled billing change was found", 404);
    }
    if (!stripe) return sendError(res, "Billing is temporarily unavailable", 503);

    const existing = await stripe.subscriptions.retrieve(
      websiteSubscription.stripeSubscriptionId,
    );
    assertStripeBinding(
      existing,
      req.authUserId,
      target.id,
      websiteSubscription.stripeSubscriptionItemId,
    );
    if (
      stripeSubscriptionScheduleId(existing) !==
      websiteSubscription.stripePlanScheduleId
    ) {
      throw new BillingPlanChangeError(409, "Billing change could not be completed");
    }
    await releaseStripeSubscriptionPlanChange(stripe, {
      scheduleId: websiteSubscription.stripePlanScheduleId,
      businessId: target.id,
      subscriptionId: existing.id,
    });
    await prisma.websiteSubscription.update({
      where: { id: websiteSubscription.id },
      data: CLEAR_SCHEDULED_PLAN_CHANGE,
    });
    await Promise.all([
      invalidateTenantCache(req.authUserId),
      invalidateTenantCache(req.authUserId, target.id),
    ]);
    return sendSuccess(
      res,
      { businessId: target.id, scheduledPlanChange: null },
      "Scheduled subscription change canceled",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof BillingPlanChangeError) {
      return sendError(res, error.publicMessage, error.status);
    }
    if (error instanceof Error && error.message === "STRIPE_OWNERSHIP_MISMATCH") {
      return sendError(res, "Billing change is unavailable", 403);
    }
    console.error("[billing] cancel scheduled plan change failed:", error);
    return sendError(res, "Billing change could not be completed", 409);
  }
}

async function updateBillingLifecycle(
  req: AuthenticatedRequest,
  res: Response,
  action: "cancel" | "reactivate",
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const parsed =
      action === "cancel"
        ? CANCEL_REQUEST.parse(req.body ?? {})
        : REQUEST.parse(req.body ?? {});
    const target = await ownedBillingTarget(req.authUserId, parsed.businessId);
    if (!target?.websiteSubscription?.stripeSubscriptionId) {
      return sendError(res, "Billing is not available for this website", 404);
    }
    if (!stripe) return sendError(res, "Billing is temporarily unavailable", 503);

    const existing = await stripe.subscriptions.retrieve(
      target.websiteSubscription.stripeSubscriptionId,
    );
    assertStripeBinding(
      existing,
      req.authUserId,
      target.id,
      target.websiteSubscription.stripeSubscriptionItemId,
    );

    if (action === "cancel" && target.websiteSubscription.stripePlanScheduleId) {
      const liveScheduleId = stripeSubscriptionScheduleId(existing);
      if (liveScheduleId !== target.websiteSubscription.stripePlanScheduleId) {
        throw new BillingPlanChangeError(409, "Billing change could not be completed");
      }
      await releaseStripeSubscriptionPlanChange(stripe, {
        scheduleId: target.websiteSubscription.stripePlanScheduleId,
        businessId: target.id,
        subscriptionId: existing.id,
      });
    }

    let updated: Stripe.Subscription;
    let cancelAtPeriodEnd = false;
    if (action === "reactivate") {
      updated = await stripe.subscriptions.update(existing.id, {
        cancel_at_period_end: false,
      });
    } else {
      cancelAtPeriodEnd = (parsed as z.infer<typeof CANCEL_REQUEST>)
        .cancelAtPeriodEnd;
      updated = cancelAtPeriodEnd
        ? await stripe.subscriptions.update(existing.id, {
            cancel_at_period_end: true,
          })
        : await stripe.subscriptions.cancel(existing.id);
    }

    assertStripeBinding(
      updated,
      req.authUserId,
      target.id,
      target.websiteSubscription.stripeSubscriptionItemId,
    );
    const end = periodEnd(updated);
    const businessState = websiteStatus(updated.status);
    const websiteSubscriptionState =
      updated.status === "trialing" ? "trialing" : businessState;

    await prisma.$transaction([
      prisma.websiteSubscription.update({
        where: { id: target.websiteSubscription.id },
        data: {
          status: websiteSubscriptionState,
          currentPeriodEnd: end,
          ...(action === "cancel" ? CLEAR_SCHEDULED_PLAN_CHANGE : {}),
        },
      }),
      prisma.business.update({
        where: { id: target.id },
        data: {
          websiteStatus: businessState,
          isActive: businessState === "active" || businessState === "trial",
        },
      }),
      prisma.subscription.updateMany({
        where: {
          userId: req.authUserId,
          stripeSubscriptionId: updated.id,
        },
        data: {
          status: updated.status,
          stripeStatus: updated.status,
          currentPeriodEnd: end,
          stripeCurrentPeriodEnd: end,
          cancelAtPeriodEnd,
          stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
          canceledAt:
            action === "cancel" && !cancelAtPeriodEnd ? new Date() : null,
        },
      }),
    ]);
    await Promise.all([
      invalidateTenantCache(req.authUserId),
      invalidateTenantCache(req.authUserId, target.id),
    ]);
    return sendSuccess(
      res,
      {
        businessId: target.id,
        status: updated.status,
        cancelAtPeriodEnd,
        currentPeriodEnd: end,
      },
      action === "cancel" ? "Subscription updated" : "Subscription reactivated",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof BillingPlanChangeError) {
      return sendError(res, error.publicMessage, error.status);
    }
    if (error instanceof Error && error.message === "STRIPE_OWNERSHIP_MISMATCH") {
      return sendError(res, "Billing change is unavailable", 403);
    }
    console.error(`[billing] ${action} failed:`, error);
    return sendError(res, "Billing change could not be completed", 409);
  }
}

function returnUrl() {
  return `${BRAND.frontendUrl.replace(/\/$/, "")}/dashboard/project/settings?tab=account`;
}

async function stripeCustomerForTarget(
  stripeClient: Stripe,
  target: NonNullable<Awaited<ReturnType<typeof ownedBillingTarget>>>,
) {
  const subscriptionId = target.websiteSubscription?.stripeSubscriptionId;
  if (!subscriptionId) return null;
  const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
  const customer = await stripeClient.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return null;
  return customerId;
}

async function createPortal(
  req: AuthenticatedRequest,
  res: Response,
  mode: "manage" | "payment_method",
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = REQUEST.parse(req.body ?? {});
    const target = await ownedBillingTarget(req.authUserId, businessId);
    if (!target) return sendError(res, "Business not found", 404);
    const subscription = target.websiteSubscription;
    if (!subscription?.stripeSubscriptionId) {
      return sendError(res, "Billing is not available for this website", 400);
    }
    const eligible = mode === "manage" ? PORTAL_STATUSES : PAYMENT_METHOD_STATUSES;
    if (!eligible.has(subscription.status)) {
      return sendError(res, "Billing is not available for this website", 400);
    }
    if (!stripe) return sendError(res, "Billing is temporarily unavailable", 503);

    const customerId = await stripeCustomerForTarget(stripe, target);
    if (!customerId) return sendError(res, "Billing is temporarily unavailable", 503);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl(),
      ...(mode === "payment_method"
        ? { flow_data: { type: "payment_method_update" as const } }
        : {}),
    });
    return sendSuccess(res, { url: portalSession.url }, "Billing session created");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error(`[billing-portal] ${mode} session failed:`, error);
    return sendError(res, "Billing is temporarily unavailable", 503);
  }
}

export function createBillingPortalSession(req: AuthenticatedRequest, res: Response) {
  return createPortal(req, res, "manage");
}

export function createPaymentMethodSession(req: AuthenticatedRequest, res: Response) {
  return createPortal(req, res, "payment_method");
}

export function cancelUserSubscription(req: AuthenticatedRequest, res: Response) {
  return updateBillingLifecycle(req, res, "cancel");
}

export function reactivateUserSubscription(req: AuthenticatedRequest, res: Response) {
  return updateBillingLifecycle(req, res, "reactivate");
}
