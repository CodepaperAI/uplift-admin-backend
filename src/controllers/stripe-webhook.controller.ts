import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import Stripe from "stripe";

import { prisma } from "../config/db.config";
import { isStripeConfigured, stripe } from "../config/stripe.config";
import {
  recordBillingLedgerEvent,
  type BillingEventPayload,
} from "./billing-internal.controller";
import { ensureAddWebsiteOnboardingQueued } from "../services/add-website-onboarding.service";
import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  releaseFailedStripeWebhookEvent,
  WebsiteRemovalSyncBlockedError,
} from "../utils/stripe-webhook-safety";
import { recordRewardfulConversionPreparedForUser } from "../services/billing-rewardful.service";
import {
  ensureOnboardingV2PaidIntroSchedule,
  ensureOnboardingV2PaidIntroSubscription,
} from "../services/onboarding-paid-intro.service";
import {
  cancelAllWebsiteSubscriptions,
  convertTrialToSubscription,
  createOrUpdateSubscription,
  getStripeMetadataBusinessIds,
  isOnboardingV2TrialMetadata,
  shouldFinalizeOnboardingV2TrialInvoice,
  syncAddWebsiteSubscription,
  syncWebsiteSubscriptions,
  updateWebsiteSubscriptionStatus,
} from "../services/billing-subscription.service";
import { dispatchInitialSocialPlanningForEligibleWebsites } from "../services/billing-social-initialization.service";
import {
  persistCommandInvoiceFact,
  persistCommandSubscriptionFact,
} from "../services/command-stripe-facts.service";
import { resolveStripeSessionBinding } from "../utils/stripe-session-binding";
import { invalidateTenantCache } from "../utils/tenant-response-cache";
import { invalidateSuperadminRevenueCache } from "../utils/superadmin-revenue-cache";

async function forwardBillingEventToBackend(
  payload: BillingEventPayload,
): Promise<{ success: boolean; error?: string }> {
  try {
    await recordBillingLedgerEvent(payload);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Billing ledger failed",
    };
  }
}

async function invalidateStripeEventTenantCache(
  event: Stripe.Event,
): Promise<void> {
  const object = event.data.object as unknown as {
    id?: string;
    customer?: unknown;
    metadata?: Stripe.Metadata | null;
    subscription?: unknown;
  };
  const metadata = normalizeMetadata(object.metadata);
  const subscriptionId =
    event.type.startsWith("customer.subscription.") &&
    typeof object.id === "string"
      ? object.id
      : getStripeObjectId(object.subscription);
  const customerId = getStripeCustomerId(object.customer);

  const [accountBySubscription, accountByCustomer, websiteSubscriptions] =
    await Promise.all([
      subscriptionId
        ? prisma.subscription.findUnique({
            where: { stripeSubscriptionId: subscriptionId },
            select: { userId: true },
          })
        : null,
      customerId
        ? prisma.subscription.findUnique({
            where: { stripeCustomerId: customerId },
            select: { userId: true },
          })
        : null,
      subscriptionId
        ? prisma.websiteSubscription.findMany({
            where: { stripeSubscriptionId: subscriptionId },
            select: {
              businessId: true,
              business: { select: { userId: true } },
            },
          })
        : [],
    ]);
  const userIds = new Set(
    [
      metadata.userId,
      accountBySubscription?.userId,
      accountByCustomer?.userId,
      ...websiteSubscriptions.map((entry) => entry.business.userId),
    ].filter((value): value is string => Boolean(value)),
  );
  const businessIds = new Set([
    ...getStripeMetadataBusinessIds(metadata),
    ...websiteSubscriptions.map((entry) => entry.businessId),
  ]);

  await Promise.all(
    Array.from(userIds).flatMap((userId) => [
      invalidateTenantCache(userId),
      ...Array.from(businessIds).map((businessId) =>
        invalidateTenantCache(userId, businessId),
      ),
    ]),
  );
}

async function syncWebhookWebsiteSubscription(
  input: Parameters<typeof syncAddWebsiteSubscription>[0],
): Promise<Awaited<ReturnType<typeof syncAddWebsiteSubscription>> | null> {
  try {
    return await syncAddWebsiteSubscription(input);
  } catch (error) {
    if (error instanceof WebsiteRemovalSyncBlockedError) {
      console.log(
        `[Stripe Webhook] Ignored billing activation for removal-protected business ${error.businessId} (${error.removalStatus})`,
      );
      return null;
    }
    throw error;
  }
}

async function reconcileSocialInitializationAfterBillingSync(
  userId: string,
): Promise<void> {
  const results =
    await dispatchInitialSocialPlanningForEligibleWebsites(userId);
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    console.warn(
      `[Stripe Webhook] Social initialization will be retried for ${failed.length} website(s) belonging to user ${userId}`,
    );
  }
}

function normalizeMetadata(
  metadata?: Stripe.Metadata | null,
): Record<string, string> {
  if (!metadata) return {};

  return Object.entries(metadata).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (typeof value === "string" && value.length > 0) {
        acc[key] = value;
      }
      return acc;
    },
    {},
  );
}

function mergeMetadata(
  ...records: Array<Record<string, string> | Stripe.Metadata | null | undefined>
): Record<string, string> {
  return records.reduce<Record<string, string>>((acc, record) => {
    return {
      ...acc,
      ...normalizeMetadata(record as Stripe.Metadata | undefined),
    };
  }, {});
}

function isSecondaryOnboardingV2Metadata(
  ...records: Array<Record<string, string> | Stripe.Metadata | null | undefined>
): boolean {
  const metadata = mergeMetadata(...records);
  return (
    metadata.onboardingMode === "onboarding_v2" &&
    Boolean(metadata.quickScrapeBusinessId)
  );
}

function getInvoiceTaxAmount(invoice: Stripe.Invoice): number {
  const invoiceWithTax = invoice as Stripe.Invoice & { tax?: number | null };
  if (typeof invoiceWithTax.tax === "number") {
    return invoiceWithTax.tax;
  }

  return (invoice.total_taxes ?? []).reduce(
    (sum, entry) => sum + (entry.amount ?? 0),
    0,
  );
}

function getStripeChargeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return null;
}

function getStripeObjectId(value: unknown): string | null {
  return getStripeChargeId(value);
}

function getStripeCustomerId(value: unknown): string | null {
  return getStripeObjectId(value);
}

function getInvoicePeriodStart(invoice: Stripe.Invoice): string | null {
  const firstLine = invoice.lines.data[0];
  const start = firstLine?.period?.start;
  return typeof start === "number"
    ? new Date(start * 1000).toISOString()
    : null;
}

function getInvoicePeriodEnd(invoice: Stripe.Invoice): string | null {
  const firstLine = invoice.lines.data[0];
  const end = firstLine?.period?.end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

async function finalizeOnboardingV2TrialPayment(params: {
  invoice: Stripe.Invoice;
  metadata: Record<string, string>;
  subscription: Stripe.Subscription;
  userId: string;
}): Promise<boolean> {
  if (
    !shouldFinalizeOnboardingV2TrialInvoice({
      amountPaid: params.invoice.amount_paid,
      billingReason: params.invoice.billing_reason,
      metadata: params.metadata,
      subscriptionStatus: params.subscription.status,
    })
  ) {
    return false;
  }

  const existingAnalytics = await prisma.trialAnalytics.findUnique({
    where: { userId: params.userId },
    select: { converted: true, convertedAt: true },
  });
  if (
    !shouldFinalizeOnboardingV2TrialInvoice({
      alreadyConverted: existingAnalytics?.converted ?? false,
      amountPaid: params.invoice.amount_paid,
      billingReason: params.invoice.billing_reason,
      metadata: params.metadata,
      subscriptionStatus: params.subscription.status,
    })
  ) {
    return false;
  }

  const businessIds = getStripeMetadataBusinessIds(params.metadata);
  await convertTrialToSubscription(
    params.userId,
    businessIds.length > 0 ? businessIds : undefined,
  );

  const now = new Date();
  await prisma.trialAnalytics.upsert({
    where: { userId: params.userId },
    create: {
      userId: params.userId,
      checkoutStarted: true,
      checkoutCompletedAt: now,
      converted: true,
      convertedAt: now,
      trialOutcome: "converted",
    },
    update: {
      checkoutCompletedAt: now,
      converted: true,
      convertedAt: existingAnalytics?.convertedAt ?? now,
      trialOutcome: "converted",
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  });
  const stripeCustomerId =
    typeof params.subscription.customer === "string"
      ? params.subscription.customer
      : params.subscription.customer.id;
  await recordRewardfulConversionPreparedForUser({
    conversionEmail: user?.email ?? null,
    stripeCustomerId,
    stripeSubscriptionId: params.subscription.id,
    userId: params.userId,
  });

  console.log(
    `✅ [Stripe Webhook] Onboarding-v2 trial converted after paid invoice ${params.invoice.id} for user ${params.userId}`,
  );
  return true;
}

async function forwardInvoiceToSettlementLedger(params: {
  event: Stripe.Event;
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  metadata?: Record<string, string>;
}): Promise<void> {
  const mergedMetadata = mergeMetadata(
    params.subscription.metadata,
    params.invoice.metadata,
    params.metadata,
  );

  const result = await forwardBillingEventToBackend({
    eventType: "invoice.paid",
    stripeEventId: params.event.id,
    stripeInvoiceId: params.invoice.id,
    stripeSubscriptionId: params.subscription.id,
    stripeChargeId: getStripeChargeId(
      (params.invoice as Stripe.Invoice & { charge?: unknown }).charge,
    ),
    amountPaidCents: params.invoice.amount_paid ?? 0,
    subtotalCents:
      params.invoice.amount_paid ??
      (params.invoice as Stripe.Invoice & { total?: number | null }).total ??
      params.invoice.subtotal ??
      0,
    discountAmountCents: 0,
    taxAmountCents: getInvoiceTaxAmount(params.invoice),
    currency: params.invoice.currency ?? "usd",
    metadata: mergedMetadata,
    periodStart: getInvoicePeriodStart(params.invoice),
    periodEnd: getInvoicePeriodEnd(params.invoice),
  });

  if (!result.success) {
    throw new Error(
      result.error ?? "Failed to forward invoice to billing ledger",
    );
  }
}

async function forwardChargeSettlementEvent(params: {
  eventType:
    "charge.refunded" | "charge.dispute.created" | "charge.dispute.closed";
  event: Stripe.Event;
  charge: Stripe.Charge;
  metadata?: Record<string, string>;
}): Promise<void> {
  let invoice: Stripe.Invoice | null = null;
  const invoiceRef = ((
    params.charge as Stripe.Charge & {
      invoice?: string | Stripe.Invoice | null;
    }
  ).invoice ?? null) as string | Stripe.Invoice | null;

  if (invoiceRef) {
    invoice =
      typeof invoiceRef === "string"
        ? await stripe.invoices.retrieve(invoiceRef)
        : invoiceRef;
  }

  let subscription: Stripe.Subscription | null = null;
  const subscriptionRef =
    (
      invoice as
        | (Stripe.Invoice & {
            subscription?: string | Stripe.Subscription | null;
          })
        | null
    )?.subscription ??
    (
      params.charge as Stripe.Charge & {
        subscription?: string | Stripe.Subscription | null;
      }
    ).subscription ??
    null;

  if (subscriptionRef) {
    subscription =
      typeof subscriptionRef === "string"
        ? await stripe.subscriptions.retrieve(subscriptionRef)
        : subscriptionRef;
  }

  const mergedMetadata = mergeMetadata(
    subscription?.metadata,
    invoice?.metadata,
    params.charge.metadata,
    params.metadata,
  );

  const amountBase =
    params.eventType === "charge.dispute.created"
      ? params.charge.amount
      : params.charge.amount_refunded || params.charge.amount || 0;

  const result = await forwardBillingEventToBackend({
    eventType: params.eventType,
    stripeEventId: params.event.id,
    stripeInvoiceId: invoice?.id ?? null,
    stripeSubscriptionId: subscription?.id ?? null,
    stripeChargeId: params.charge.id,
    amountPaidCents: amountBase,
    subtotalCents: amountBase,
    discountAmountCents: 0,
    taxAmountCents: 0,
    currency: params.charge.currency ?? "usd",
    metadata: mergedMetadata,
    periodStart: invoice ? getInvoicePeriodStart(invoice) : null,
    periodEnd: invoice ? getInvoicePeriodEnd(invoice) : null,
  });

  if (!result.success) {
    throw new Error(
      result.error ?? "Failed to forward charge settlement event",
    );
  }

  await processChargeBillingEvent({
    eventType: params.eventType,
    event: params.event,
    charge: params.charge,
    invoice,
    subscription,
    metadata: mergedMetadata,
  });
}

async function forwardCreditNoteToSettlementLedger(
  event: Stripe.Event,
  creditNote: Stripe.CreditNote,
): Promise<void> {
  const invoiceRef = creditNote.invoice;
  const invoice =
    typeof invoiceRef === "string"
      ? await stripe.invoices.retrieve(invoiceRef)
      : invoiceRef;
  const subscriptionRef = (
    invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    }
  ).subscription;
  const subscription =
    typeof subscriptionRef === "string"
      ? await stripe.subscriptions.retrieve(subscriptionRef)
      : subscriptionRef;

  const mergedMetadata = mergeMetadata(
    subscription?.metadata,
    invoice.metadata,
    creditNote.metadata,
  );
  const amount =
    (creditNote as Stripe.CreditNote & { subtotal?: number | null }).subtotal ??
    creditNote.total ??
    0;

  const result = await forwardBillingEventToBackend({
    eventType: "credit_note.created",
    stripeEventId: event.id,
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscription?.id ?? null,
    stripeChargeId: null,
    amountPaidCents: amount,
    subtotalCents: amount,
    discountAmountCents: 0,
    taxAmountCents: 0,
    currency: creditNote.currency ?? invoice.currency ?? "usd",
    metadata: mergedMetadata,
    periodStart: getInvoicePeriodStart(invoice),
    periodEnd: getInvoicePeriodEnd(invoice),
  });

  if (!result.success) {
    throw new Error(
      result.error ?? "Failed to forward credit note to billing ledger",
    );
  }
}

type StripeBillingAccessAction =
  | "none"
  | "canceled_full_refund"
  | "tracked_partial_refund"
  | "tracked_dispute"
  | "tracked_credit_note";

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function getLatestRefundId(charge: Stripe.Charge): string | null {
  const refunds = charge.refunds?.data ?? [];
  return refunds.length > 0 ? (refunds[refunds.length - 1]?.id ?? null) : null;
}

function isChargeFullyRefunded(charge: Stripe.Charge): boolean {
  return charge.amount > 0 && (charge.amount_refunded ?? 0) >= charge.amount;
}

async function resolveBillingUserId(params: {
  metadata: Record<string, string>;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  businessIds?: string[];
}): Promise<string | null> {
  const [accountBySubscription, websitesBySubscription, accountByCustomer, businesses] =
    await Promise.all([
      params.stripeSubscriptionId
        ? prisma.subscription.findUnique({
            where: { stripeSubscriptionId: params.stripeSubscriptionId },
            select: { userId: true },
          })
        : null,
      params.stripeSubscriptionId
        ? prisma.websiteSubscription.findMany({
            where: { stripeSubscriptionId: params.stripeSubscriptionId },
            select: { business: { select: { userId: true } } },
          })
        : [],
      params.stripeCustomerId
        ? prisma.subscription.findUnique({
            where: { stripeCustomerId: params.stripeCustomerId },
            select: { userId: true },
          })
        : null,
      params.businessIds?.length
        ? prisma.business.findMany({
            where: { id: { in: params.businessIds } },
            select: { userId: true },
          })
        : [],
    ]);
  const candidates = new Set(
    [
      params.metadata.userId,
      accountBySubscription?.userId,
      accountByCustomer?.userId,
      ...websitesBySubscription.map((entry) => entry.business.userId),
      ...businesses.map((entry) => entry.userId),
    ].filter((value): value is string => Boolean(value)),
  );
  if (candidates.size > 1) {
    throw new Error("STRIPE_BILLING_OWNERSHIP_CONFLICT");
  }
  return candidates.values().next().value ?? null;
}

async function resolveBillingBusinessIds(params: {
  metadata: Record<string, string>;
  stripeSubscriptionId: string | null;
  userId: string | null;
}): Promise<string[]> {
  const fromMetadata = getStripeMetadataBusinessIds(params.metadata);
  const resolved = new Set(fromMetadata);

  if (params.stripeSubscriptionId) {
    const websiteSubscriptions = await prisma.websiteSubscription.findMany({
      where: {
        stripeSubscriptionId: params.stripeSubscriptionId,
        ...(params.userId ? { business: { userId: params.userId } } : {}),
      },
      select: { businessId: true },
    });
    for (const subscription of websiteSubscriptions) {
      resolved.add(subscription.businessId);
    }
  }

  return Array.from(resolved);
}

async function persistCommandInvoiceFromWebhook(params: {
  event: Stripe.Event;
  invoice: Stripe.Invoice;
  subscription?: Stripe.Subscription | null;
}): Promise<void> {
  const stripeSubscriptionId =
    params.subscription?.id ??
    getStripeObjectId(
      (params.invoice as Stripe.Invoice & { subscription?: unknown })
        .subscription,
    );
  const stripeCustomerId =
    getStripeCustomerId(params.invoice.customer) ??
    getStripeCustomerId(params.subscription?.customer);
  const metadata = mergeMetadata(
    params.subscription?.metadata,
    params.invoice.metadata,
  );
  const metadataBusinessIds = getStripeMetadataBusinessIds(metadata);
  const userId = await resolveBillingUserId({
    metadata,
    stripeCustomerId,
    stripeSubscriptionId,
    businessIds: metadataBusinessIds,
  });
  const businessIds = await resolveBillingBusinessIds({
    metadata,
    stripeSubscriptionId,
    userId,
  });

  await persistCommandInvoiceFact({
    eventId: params.event.id,
    invoice: params.invoice,
    subscriptionId: stripeSubscriptionId,
    userId,
    businessId: businessIds[0] ?? null,
  });
}

async function cancelAccessForFullRefund(params: {
  userId: string | null;
  stripeSubscriptionId: string | null;
  businessIds: string[];
  subscriptionType?: string | null;
  now?: Date;
}): Promise<StripeBillingAccessAction> {
  if (!params.userId) {
    console.warn(
      `[Stripe Webhook] Full refund received but no user could be resolved for subscription ${params.stripeSubscriptionId ?? "unknown"}`,
    );
    return "none";
  }

  const now = params.now ?? new Date();
  const scopedBusinessIds = Array.from(new Set(params.businessIds));
  const isScopedWebsiteRefund =
    params.subscriptionType === "add_website" && scopedBusinessIds.length > 0;

  if (!isScopedWebsiteRefund) {
    await prisma.subscription.updateMany({
      where: {
        OR: [
          ...(params.stripeSubscriptionId
            ? [{ stripeSubscriptionId: params.stripeSubscriptionId }]
            : []),
          { userId: params.userId },
        ],
      },
      data: {
        status: "canceled",
        stripeStatus: "canceled",
        canceledAt: now,
        cancelAtPeriodEnd: false,
        stripeCancelAtPeriodEnd: false,
        currentPeriodEnd: now,
        stripeCurrentPeriodEnd: now,
        websiteCount: 0,
      },
    });
  }

  await cancelAllWebsiteSubscriptions(
    params.userId,
    params.stripeSubscriptionId ?? "",
    scopedBusinessIds,
  );

  await prisma.websiteSubscription.updateMany({
    where: {
      business: { userId: params.userId },
      OR: [
        ...(params.stripeSubscriptionId
          ? [{ stripeSubscriptionId: params.stripeSubscriptionId }]
          : []),
        ...(scopedBusinessIds.length > 0
          ? [{ businessId: { in: scopedBusinessIds } }]
          : []),
      ],
    },
    data: {
      status: "canceled",
      currentPeriodEnd: now,
    },
  });

  console.log(
    `[Stripe Webhook] Full refund canceled Uplift access for user ${params.userId}, subscription=${params.stripeSubscriptionId ?? "unknown"}, businesses=${scopedBusinessIds.length}`,
  );

  return "canceled_full_refund";
}

async function recordStripeBillingEvent(params: {
  event: Stripe.Event;
  eventType: string;
  stripeObjectId?: string | null;
  stripeObjectType?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeInvoiceId?: string | null;
  stripeChargeId?: string | null;
  stripeRefundId?: string | null;
  userId?: string | null;
  businessId?: string | null;
  amountCents?: number | null;
  refundedAmountCents?: number | null;
  currency?: string | null;
  refundStatus?: string | null;
  refundReason?: string | null;
  accessAction: StripeBillingAccessAction;
  metadata?: Record<string, string>;
  payload?: unknown;
}): Promise<void> {
  try {
    await prisma.stripeBillingEvent.create({
      data: {
        stripeEventId: params.event.id,
        eventType: params.eventType,
        stripeObjectId: params.stripeObjectId ?? null,
        stripeObjectType: params.stripeObjectType ?? null,
        stripeCustomerId: params.stripeCustomerId ?? null,
        stripeSubscriptionId: params.stripeSubscriptionId ?? null,
        stripeInvoiceId: params.stripeInvoiceId ?? null,
        stripeChargeId: params.stripeChargeId ?? null,
        stripeRefundId: params.stripeRefundId ?? null,
        userId: params.userId ?? null,
        businessId: params.businessId ?? null,
        amountCents: params.amountCents ?? null,
        refundedAmountCents: params.refundedAmountCents ?? null,
        currency: params.currency ?? "usd",
        refundStatus: params.refundStatus ?? null,
        refundReason: params.refundReason ?? null,
        accessAction: params.accessAction,
        metadata: params.metadata ? toJsonValue(params.metadata) : undefined,
        payload: params.payload ? toJsonValue(params.payload) : undefined,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(
        `[Stripe Webhook] Stripe billing event ${params.event.id} already recorded, skipping`,
      );
      return;
    }
    throw error;
  }
}

async function processChargeBillingEvent(params: {
  eventType:
    "charge.refunded" | "charge.dispute.created" | "charge.dispute.closed";
  event: Stripe.Event;
  charge: Stripe.Charge;
  invoice: Stripe.Invoice | null;
  subscription: Stripe.Subscription | null;
  metadata: Record<string, string>;
}): Promise<void> {
  const stripeSubscriptionId = params.subscription?.id ?? null;
  const stripeCustomerId =
    getStripeCustomerId(params.charge.customer) ??
    getStripeCustomerId(params.subscription?.customer) ??
    null;
  const metadataBusinessIds = getStripeMetadataBusinessIds(params.metadata);
  const userId = await resolveBillingUserId({
    metadata: params.metadata,
    stripeCustomerId,
    stripeSubscriptionId,
    businessIds: metadataBusinessIds,
  });
  const businessIds = await resolveBillingBusinessIds({
    metadata: params.metadata,
    stripeSubscriptionId,
    userId,
  });

  let accessAction: StripeBillingAccessAction =
    params.eventType === "charge.refunded"
      ? isChargeFullyRefunded(params.charge)
        ? await cancelAccessForFullRefund({
            userId,
            stripeSubscriptionId,
            businessIds,
            subscriptionType: params.metadata.type ?? null,
          })
        : "tracked_partial_refund"
      : "tracked_dispute";

  if (params.eventType === "charge.dispute.closed") {
    accessAction = "tracked_dispute";
  }

  await recordStripeBillingEvent({
    event: params.event,
    eventType: params.eventType,
    stripeObjectId: params.charge.id,
    stripeObjectType: "charge",
    stripeCustomerId,
    stripeSubscriptionId,
    stripeInvoiceId: params.invoice?.id ?? null,
    stripeChargeId: params.charge.id,
    stripeRefundId: getLatestRefundId(params.charge),
    userId,
    businessId: businessIds[0] ?? null,
    amountCents: params.charge.amount,
    refundedAmountCents: params.charge.amount_refunded ?? null,
    currency: params.charge.currency ?? "usd",
    refundStatus:
      params.eventType === "charge.refunded"
        ? isChargeFullyRefunded(params.charge)
          ? "full"
          : "partial"
        : null,
    accessAction,
    metadata: params.metadata,
    payload: {
      chargeId: params.charge.id,
      amount: params.charge.amount,
      amountRefunded: params.charge.amount_refunded,
      paid: params.charge.paid,
      status: params.charge.status,
      invoiceId: params.invoice?.id ?? null,
      subscriptionId: stripeSubscriptionId,
      businessIds,
    },
  });
}

async function processRefundBillingEvent(
  event: Stripe.Event,
  refund: Stripe.Refund,
): Promise<void> {
  const chargeRef = refund.charge;
  const chargeId = typeof chargeRef === "string" ? chargeRef : chargeRef?.id;
  const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;

  let invoice: Stripe.Invoice | null = null;
  const invoiceRef = ((
    charge as
      (Stripe.Charge & { invoice?: string | Stripe.Invoice | null }) | null
  )?.invoice ?? null) as string | Stripe.Invoice | null;
  if (invoiceRef) {
    invoice =
      typeof invoiceRef === "string"
        ? await stripe.invoices.retrieve(invoiceRef)
        : invoiceRef;
  }

  let subscription: Stripe.Subscription | null = null;
  const subscriptionRef = (
    invoice as
      | (Stripe.Invoice & {
          subscription?: string | Stripe.Subscription | null;
        })
      | null
  )?.subscription;
  if (subscriptionRef) {
    subscription =
      typeof subscriptionRef === "string"
        ? await stripe.subscriptions.retrieve(subscriptionRef)
        : subscriptionRef;
  }

  const metadata = mergeMetadata(
    subscription?.metadata,
    invoice?.metadata,
    charge?.metadata,
    refund.metadata,
  );
  const stripeSubscriptionId = subscription?.id ?? null;
  const stripeCustomerId =
    getStripeCustomerId(refund.destination_details) ??
    getStripeCustomerId(charge?.customer) ??
    getStripeCustomerId(subscription?.customer) ??
    null;
  const metadataBusinessIds = getStripeMetadataBusinessIds(metadata);
  const userId = await resolveBillingUserId({
    metadata,
    stripeCustomerId,
    stripeSubscriptionId,
    businessIds: metadataBusinessIds,
  });
  const businessIds = await resolveBillingBusinessIds({
    metadata,
    stripeSubscriptionId,
    userId,
  });
  const isFullRefund = charge ? isChargeFullyRefunded(charge) : false;
  const accessAction = isFullRefund
    ? await cancelAccessForFullRefund({
        userId,
        stripeSubscriptionId,
        businessIds,
        subscriptionType: metadata.type ?? null,
      })
    : "tracked_partial_refund";

  await recordStripeBillingEvent({
    event,
    eventType: event.type,
    stripeObjectId: refund.id,
    stripeObjectType: "refund",
    stripeCustomerId,
    stripeSubscriptionId,
    stripeInvoiceId: invoice?.id ?? null,
    stripeChargeId: charge?.id ?? chargeId ?? null,
    stripeRefundId: refund.id,
    userId,
    businessId: businessIds[0] ?? null,
    amountCents: refund.amount,
    refundedAmountCents: charge?.amount_refunded ?? refund.amount,
    currency: refund.currency ?? charge?.currency ?? "usd",
    refundStatus: refund.status ?? (isFullRefund ? "full" : "partial"),
    refundReason: refund.reason ?? null,
    accessAction,
    metadata,
    payload: {
      refundId: refund.id,
      amount: refund.amount,
      status: refund.status,
      reason: refund.reason,
      chargeId: charge?.id ?? chargeId ?? null,
      chargeAmount: charge?.amount ?? null,
      chargeAmountRefunded: charge?.amount_refunded ?? null,
      invoiceId: invoice?.id ?? null,
      subscriptionId: stripeSubscriptionId,
      businessIds,
    },
  });
}

async function processCreditNoteBillingEvent(
  event: Stripe.Event,
  creditNote: Stripe.CreditNote,
): Promise<void> {
  const invoiceRef = creditNote.invoice;
  const invoice =
    typeof invoiceRef === "string"
      ? await stripe.invoices.retrieve(invoiceRef)
      : invoiceRef;
  const subscriptionRef = (
    invoice as Stripe.Invoice & {
      subscription?: string | Stripe.Subscription | null;
    }
  ).subscription;
  const subscription =
    typeof subscriptionRef === "string"
      ? await stripe.subscriptions.retrieve(subscriptionRef)
      : subscriptionRef;
  const metadata = mergeMetadata(
    subscription?.metadata,
    invoice.metadata,
    creditNote.metadata,
  );
  const stripeSubscriptionId = subscription?.id ?? null;
  const stripeCustomerId =
    getStripeCustomerId(creditNote.customer) ??
    getStripeCustomerId(subscription?.customer) ??
    null;
  const metadataBusinessIds = getStripeMetadataBusinessIds(metadata);
  const userId = await resolveBillingUserId({
    metadata,
    stripeCustomerId,
    stripeSubscriptionId,
    businessIds: metadataBusinessIds,
  });
  const businessIds = await resolveBillingBusinessIds({
    metadata,
    stripeSubscriptionId,
    userId,
  });
  const amount =
    (creditNote as Stripe.CreditNote & { subtotal?: number | null }).subtotal ??
    creditNote.total ??
    0;

  await recordStripeBillingEvent({
    event,
    eventType: event.type,
    stripeObjectId: creditNote.id,
    stripeObjectType: "credit_note",
    stripeCustomerId,
    stripeSubscriptionId,
    stripeInvoiceId: invoice.id,
    stripeChargeId: null,
    userId,
    businessId: businessIds[0] ?? null,
    amountCents: amount,
    refundedAmountCents: amount,
    currency: creditNote.currency ?? invoice.currency ?? "usd",
    accessAction: "tracked_credit_note",
    metadata,
    payload: {
      creditNoteId: creditNote.id,
      amount,
      status: creditNote.status,
      invoiceId: invoice.id,
      subscriptionId: stripeSubscriptionId,
      businessIds,
    },
  });
}

export async function handleStripeWebhook(request: Request, response: Response) {
  const body = request.rawBody;
  const rawSignature = request.headers["stripe-signature"];
  const signature = Array.isArray(rawSignature)
    ? rawSignature[0]
    : rawSignature;

  if (!signature || typeof body !== "string") {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET is not set");
    return response.status(503).json({ error: "Service unavailable" });
  }

  if (!isStripeConfigured) {
    return response.status(503).json({ error: "Service unavailable" });
  }

  let event: Stripe.Event;

  try {
    // Stripe's Bun runtime uses WebCrypto, whose HMAC provider is async-only.
    // Verify the exact captured raw body before parsing or claiming the event.
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
    );
  } catch {
    // Invalid signatures are expected hostile traffic. Keep the response and
    // operational log generic so provider details and stack traces never leak.
    console.warn("[Stripe Webhook] Signature verification rejected");
    return response.status(401).json({ error: "Unauthorized" });
  }

  console.log(
    `[Stripe Webhook] Received event: ${event.type}, ID: ${event.id}`,
  );

  const eventClaim = await claimStripeWebhookEvent(
    prisma.stripeWebhookEvent,
    event.id,
  );
  if (eventClaim.status === "duplicate") {
    console.log(
      `[Stripe Webhook] Event ${event.id} already processed or in progress, skipping`,
    );
    return response.status(200).json({ received: true, duplicate: true });
  }
  if (eventClaim.status === "in_progress") {
    response.setHeader(
      "Retry-After",
      String(Math.min(eventClaim.retryAfterSeconds, 30)),
    );
    return response.status(503).json({ error: "Event is still processing" });
  }
  if (eventClaim.status === "untracked") {
    console.error(
      `[Stripe Webhook] Idempotency claim unavailable (${eventClaim.errorCode ?? "unknown"}); refusing untracked processing`,
    );
    response.setHeader("Retry-After", "5");
    return response.status(503).json({ error: "Service unavailable" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        const isPaidIntroPayment =
          session.mode === "payment" &&
          isOnboardingV2TrialMetadata(session.metadata);
        const initialBinding = resolveStripeSessionBinding(
          session.metadata,
          null,
        );
        if (isPaidIntroPayment && !initialBinding) {
          throw new Error(
            `Paid introductory checkout ${session.id} is missing its ownership binding`,
          );
        }
        if (
          isPaidIntroPayment &&
          (session.amount_total === 0 || !session.payment_intent)
        ) {
          // A legacy 100%-discounted paid-intro Checkout has no reusable card,
          // so it cannot safely create the promised recurring subscription.
          // Acknowledge it as terminal instead of retrying forever; the client
          // verification route directs the customer through a fresh v3
          // Checkout Session that requires the $3 PaymentIntent.
          console.warn(
            `[Stripe Webhook] Paid introductory checkout ${session.id} did not collect a payment method; provisioning was skipped`,
          );
          break;
        }
        if (
          (session.mode === "subscription" && session.subscription) ||
          isPaidIntroPayment
        ) {
          const subscription = isPaidIntroPayment
            ? await ensureOnboardingV2PaidIntroSubscription(stripe, session)
            : await stripe.subscriptions.retrieve(
                session.subscription as string,
                {
                  expand: ["customer"],
                },
              );

          const binding = resolveStripeSessionBinding(
            session.metadata,
            subscription.metadata,
          );
          if (!binding) {
            console.error(
              `[Stripe Webhook] Checkout ownership metadata was missing or inconsistent. Session ID: ${session.id}, Subscription ID: ${subscription.id}`,
            );
            throw new Error(
              `Invalid ownership metadata for checkout session ${session.id}`,
            );
          }
          const userId = binding.userId;
          const checkoutType = binding.type;
          const businessId = binding.businessId;

          const customerId =
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer.id;

          if (checkoutType === "add_website" && businessId) {
            // add_website: never call account-level createOrUpdateSubscription
            try {
              const hasCompletedInitialPayment =
                session.payment_status === "paid" ||
                (session.payment_status === "no_payment_required" &&
                  subscription.status === "active");
              if (!hasCompletedInitialPayment) {
                throw new Error(
                  `Add-website checkout ${session.id} completed without an accepted initial payment state (${session.payment_status})`,
                );
              }

              const syncResult = await syncWebhookWebsiteSubscription({
                userId,
                businessId,
                stripeSubscription: subscription,
                agencyId:
                  session.metadata?.agencyId || subscription.metadata?.agencyId,
                agencyPricingConfigId:
                  session.metadata?.agencyPricingConfigId ||
                  subscription.metadata?.agencyPricingConfigId,
              });

              if (!syncResult) break;

              console.log(
                `[Stripe Webhook] WebsiteSubscription upserted for business ${businessId}: periodStart=${syncResult.currentPeriodStart?.toISOString() ?? "null"}, periodEnd=${syncResult.currentPeriodEnd?.toISOString() ?? "null"}, websiteStatus=${syncResult.websiteStatus}`,
              );
              await reconcileSocialInitializationAfterBillingSync(userId);

              if (
                !isSecondaryOnboardingV2Metadata(
                  session.metadata,
                  subscription.metadata,
                )
              ) {
                const onboardingQueueResult =
                  await ensureAddWebsiteOnboardingQueued({
                    businessId,
                    stripeSubscriptionId: subscription.id,
                  });
                console.log(
                  `[Stripe Webhook] Additional website onboarding ${onboardingQueueResult.alreadyQueued ? "was already queued" : onboardingQueueResult.queued ? "queued" : "was not configured"} for business ${businessId}`,
                );
              } else {
                console.log(
                  `[Stripe Webhook] Payment synced for secondary onboarding-v2 business ${businessId}; completion remains client-confirmed`,
                );
              }

              console.log(
                `✅ [Stripe Webhook] Website subscription created for business ${businessId}, subscription ID: ${subscription.id}`,
              );
            } catch (error) {
              console.error(
                `❌ [Stripe Webhook] Failed to create website subscription for business ${businessId}:`,
                error,
              );
              // CRITICAL: Re-throw to trigger retry
              throw error;
            }
            break;
          }

          // Account-level subscription (not add_website)
          if (
            isOnboardingV2TrialMetadata(session.metadata) ||
            isOnboardingV2TrialMetadata(subscription.metadata)
          ) {
            await ensureOnboardingV2PaidIntroSchedule(stripe, subscription);
          }

          await createOrUpdateSubscription(userId, customerId, subscription);
          console.log(
            `✅ [Stripe Webhook] Subscription updated successfully for user ${userId} (checkout.session.completed), status: ${subscription.status}, subscription ID: ${subscription.id}`,
          );

          const websiteResult = await syncWebsiteSubscriptions(
            userId,
            subscription,
          );
          console.log(
            `✅ [Stripe Webhook] Website subscriptions synced for user ${userId}: created=${websiteResult.created}, updated=${websiteResult.updated}`,
          );
          await reconcileSocialInitializationAfterBillingSync(userId);

          try {
            const hasActiveBusiness = await prisma.business.findFirst({
              where: {
                userId,
                isActive: true,
                websiteStatus: "active",
                removalStatus: "active",
              },
              select: { id: true },
            });
            if (hasActiveBusiness) {
              await prisma.user.update({
                where: { id: userId },
                data: { onboarding: true },
              });
              console.log(
                `✅ [Stripe Webhook] Set onboarding=true for user ${userId}`,
              );
            } else {
              console.log(
                `⏭️ [Stripe Webhook] Skipped onboarding=true for user ${userId} — no active business yet (background task will set it)`,
              );
            }
          } catch (onboardingError) {
            console.error(
              `⚠️ [Stripe Webhook] Failed to set onboarding for user ${userId}:`,
              onboardingError,
            );
          }

          const isOnboardingV2TrialCheckout =
            isOnboardingV2TrialMetadata(session.metadata) ||
            isOnboardingV2TrialMetadata(subscription.metadata);
          if (!isOnboardingV2TrialCheckout) {
            try {
              const convertedBusinessIds = getStripeMetadataBusinessIds(
                subscription.metadata,
              );
              await convertTrialToSubscription(
                userId,
                convertedBusinessIds.length > 0
                  ? convertedBusinessIds
                  : undefined,
              );
            } catch (trialError) {
              console.error(
                `⚠️ [Stripe Webhook] Failed to convert trial for user ${userId}:`,
                trialError,
              );
            }
          }

          // Non-critical: email - continue even if fails
          try {
            const backendUrl =
              process.env.NEXT_PUBLIC_BACKEND_URL ||
              process.env.BACKEND_URL ||
              "http://localhost:3001";
            const internalSecret =
              process.env.INTERNAL_TRANSACTIONAL_EMAIL_SECRET?.trim();
            if (
              !internalSecret ||
              Buffer.byteLength(internalSecret, "utf8") < 32
            ) {
              throw new Error("Internal email authentication is unavailable");
            }
            const response = await fetch(
              `${backendUrl}/api/v1/email/subscription`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Internal-Secret": internalSecret,
                },
                body: JSON.stringify({ userId }),
              },
            );
            if (!response.ok) {
              console.error(
                `⚠️ [Stripe Webhook] Failed to send subscription email for user ${userId}:`,
                await response.text(),
              );
            } else {
              console.log(
                `✅ [Stripe Webhook] Subscription email sent successfully for user ${userId}`,
              );
            }
          } catch (emailError) {
            console.error(
              `⚠️ [Stripe Webhook] Failed to send subscription email for user ${userId}:`,
              emailError,
            );
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.paused":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;

        const subscriptionType = subscription.metadata?.type;
        const businessIds = getStripeMetadataBusinessIds(
          subscription.metadata,
        );
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        const userId = await resolveBillingUserId({
          metadata: normalizeMetadata(subscription.metadata),
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          businessIds,
        });

        if (!userId) {
          console.error(
            `[Stripe Webhook] No userId found in subscription metadata. Subscription ID: ${subscription.id}`,
          );
          // CRITICAL: Re-throw to trigger retry
          throw new Error(
            `No userId found in metadata for subscription ${subscription.id}`,
          );
        }

        await persistCommandSubscriptionFact({
          event,
          subscription,
          userId,
          businessId: businessIds[0] ?? null,
        });

        if (subscriptionType === "add_website") {
          if (businessIds.length === 0) {
            throw new Error(
              `No businessId found in metadata for add_website subscription ${subscription.id}`,
            );
          }

          for (const businessId of businessIds) {
            const syncResult = await syncWebhookWebsiteSubscription({
              userId,
              businessId,
              stripeSubscription: subscription,
              subscriptionItem: subscription.items.data[0] ?? null,
              agencyId: subscription.metadata?.agencyId,
              agencyPricingConfigId:
                subscription.metadata?.agencyPricingConfigId ?? null,
            });

            if (!syncResult) continue;

            if (
              syncResult.websiteStatus === "active" &&
              !isSecondaryOnboardingV2Metadata(subscription.metadata)
            ) {
              await ensureAddWebsiteOnboardingQueued({
                businessId,
                stripeSubscriptionId: subscription.id,
              });
            }

            console.log(
              `✅ [Stripe Webhook] Recovered add_website sync for business ${businessId} (${event.type}): op=${syncResult.operation}, end=${syncResult.currentPeriodEnd?.toISOString() ?? "null"}`,
            );
          }
          await reconcileSocialInitializationAfterBillingSync(userId);
          break;
        }

        // Checkout normally creates this schedule before we reach a
        // subscription webhook. Re-running the idempotent reconciler here
        // covers a lost checkout callback/browser return and prevents the
        // three-day introductory price from renewing a second time.
        if (isOnboardingV2TrialMetadata(subscription.metadata)) {
          await ensureOnboardingV2PaidIntroSchedule(stripe, subscription);
        }

        // CRITICAL: createOrUpdateSubscription must succeed - re-throw on error
        await createOrUpdateSubscription(userId, customerId, subscription);
        console.log(
          `✅ [Stripe Webhook] Subscription updated successfully for user ${userId} (${event.type}), status: ${subscription.status}, subscription ID: ${subscription.id}`,
        );

        // CRITICAL: syncWebsiteSubscriptions must succeed - re-throw on error
        const websiteResult = await syncWebsiteSubscriptions(
          userId,
          subscription,
        );
        console.log(
          `✅ [Stripe Webhook] Website subscriptions synced for user ${userId} (${event.type}): created=${websiteResult.created}, updated=${websiteResult.updated}, canceled=${websiteResult.canceled}`,
        );
        await reconcileSocialInitializationAfterBillingSync(userId);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;

        const subscriptionType = subscription.metadata?.type;
        const businessIds = getStripeMetadataBusinessIds(subscription.metadata);
        const customerId = getStripeCustomerId(subscription.customer);
        const userId = await resolveBillingUserId({
          metadata: normalizeMetadata(subscription.metadata),
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          businessIds,
        });

        if (!userId) {
          console.error(
            `[Stripe Webhook] No userId found in subscription metadata. Subscription ID: ${subscription.id}`,
          );
          break;
        }

        await persistCommandSubscriptionFact({
          event,
          subscription,
          userId,
          businessId: businessIds[0] ?? null,
        });

        if (subscriptionType !== "add_website") {
          try {
            await prisma.subscription.update({
              where: { userId },
              data: {
                status: "canceled",
                stripeStatus: "canceled",
                canceledAt: new Date(),
                cancelAtPeriodEnd: false,
                stripeCancelAtPeriodEnd: false,
              },
            });
            console.log(
              `✅ [Stripe Webhook] Subscription canceled successfully for user ${userId}`,
            );
          } catch (error) {
            console.error(
              `❌ [Stripe Webhook] Failed to cancel subscription for user ${userId}:`,
              error,
            );
            console.error(
              `   Error details:`,
              error instanceof Error ? error.stack : JSON.stringify(error),
            );
          }
        }

        try {
          const canceledCount = await cancelAllWebsiteSubscriptions(
            userId,
            subscription.id,
            businessIds,
          );
          console.log(
            `✅ [Stripe Webhook] Canceled ${canceledCount} website subscriptions for user ${userId}`,
          );
        } catch (websiteError) {
          console.error(
            `⚠️ [Stripe Webhook] Failed to cancel website subscriptions for user ${userId}:`,
            websiteError,
          );
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;

        const subscriptionId = (
          invoice as { subscription?: string | Stripe.Subscription }
        ).subscription;

        if (subscriptionId) {
          const subscriptionIdString =
            typeof subscriptionId === "string"
              ? subscriptionId
              : subscriptionId.id;

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionIdString);
          await persistCommandInvoiceFromWebhook({
            event,
            invoice,
            subscription,
          });
          const mergedMetadata = mergeMetadata(
            subscription.metadata,
            invoice.metadata,
          );

          if (subscription.metadata?.type === "add_website") {
            const addWebsiteBusinessIds =
              getStripeMetadataBusinessIds(mergedMetadata);
            const addWebsiteBusinessId = addWebsiteBusinessIds[0] ?? null;
            const addWebsiteUserId = await resolveBillingUserId({
              metadata: mergedMetadata,
              stripeCustomerId: getStripeCustomerId(subscription.customer),
              stripeSubscriptionId: subscription.id,
              businessIds: addWebsiteBusinessIds,
            });

            if (addWebsiteBusinessId && addWebsiteUserId) {
              const syncResult = await syncWebhookWebsiteSubscription({
                userId: addWebsiteUserId,
                businessId: addWebsiteBusinessId,
                stripeSubscription: subscription,
                agencyId: mergedMetadata.agencyId ?? undefined,
                agencyPricingConfigId:
                  mergedMetadata.agencyPricingConfigId ?? undefined,
              });

              if (syncResult) {
                if (
                  syncResult.websiteStatus === "active" &&
                  !isSecondaryOnboardingV2Metadata(
                    mergedMetadata,
                    subscription.metadata,
                  )
                ) {
                  await ensureAddWebsiteOnboardingQueued({
                    businessId: addWebsiteBusinessId,
                    stripeSubscriptionId: subscription.id,
                  });
                }
                console.log(
                  `✅ [Stripe Webhook] Updated add_website WebsiteSubscription for business ${addWebsiteBusinessId}: start=${syncResult.currentPeriodStart?.toISOString() ?? "null"}, end=${syncResult.currentPeriodEnd?.toISOString() ?? "null"} (invoice.payment_succeeded)`,
                );
              }
            } else {
              const renewItem = subscription.items.data[0] as
                | (Stripe.SubscriptionItem & {
                    current_period_end?: number | null;
                    current_period_start?: number | null;
                  })
                | undefined;
              const renewInvoiceLine =
                typeof invoice.lines?.data?.[0] === "object"
                  ? invoice.lines.data[0]
                  : null;
              const renewPeriodEnd: number | undefined =
                renewItem?.current_period_end ??
                renewInvoiceLine?.period?.end ??
                undefined;
              const renewPeriodStart: number | undefined =
                renewItem?.current_period_start ??
                renewInvoiceLine?.period?.start ??
                undefined;

              await prisma.websiteSubscription.updateMany({
                where: {
                  stripeSubscriptionId: subscriptionIdString,
                  business: { removalStatus: "active" },
                },
                data: {
                  status: "active",
                  agencyId: mergedMetadata.agencyId ?? undefined,
                  agencyPricingConfigId:
                    mergedMetadata.agencyPricingConfigId ?? undefined,
                  currentPeriodStart: renewPeriodStart
                    ? new Date(renewPeriodStart * 1000)
                    : undefined,
                  currentPeriodEnd: renewPeriodEnd
                    ? new Date(renewPeriodEnd * 1000)
                    : undefined,
                },
              });

              await prisma.business.updateMany({
                where: {
                  removalStatus: "active",
                  websiteSubscription: {
                    is: {
                      stripeSubscriptionId: subscriptionIdString,
                    },
                  },
                },
                data: {
                  websiteStatus: "active",
                  isActive: true,
                },
              });

              console.log(
                `✅ [Stripe Webhook] Updated add_website WebsiteSubscription period dates for subscription ${subscriptionIdString}: start=${renewPeriodStart}, end=${renewPeriodEnd} (invoice.payment_succeeded fallback)`,
              );
            }
            await forwardInvoiceToSettlementLedger({
              event,
              invoice,
              subscription,
              metadata: mergedMetadata,
            });
            break;
          }

          const userId = await resolveBillingUserId({
            metadata: mergedMetadata,
            stripeCustomerId: getStripeCustomerId(subscription.customer),
            stripeSubscriptionId: subscriptionIdString,
            businessIds: getStripeMetadataBusinessIds(mergedMetadata),
          });
          if (!userId) {
            console.error(
              `[Stripe Webhook] No userId found in subscription metadata or DB. Subscription ID: ${subscriptionIdString}`,
            );
            throw new Error(
              `No userId found for subscription ${subscriptionIdString}`,
            );
          }

          const customerId =
            typeof subscription.customer === "string"
              ? subscription.customer
              : (subscription.customer as Stripe.Customer).id;

          await createOrUpdateSubscription(userId, customerId, subscription);
          console.log(
            `✅ [Stripe Webhook] Subscription updated successfully for user ${userId} (invoice.payment_succeeded), status: ${subscription.status}, subscription ID: ${subscription.id}, invoice ID: ${invoice.id}`,
          );

          const websiteResult = await syncWebsiteSubscriptions(
            userId,
            subscription,
          );
          console.log(
            `✅ [Stripe Webhook] Website subscriptions synced for user ${userId} (invoice.payment_succeeded): created=${websiteResult.created}, updated=${websiteResult.updated}`,
          );
          await reconcileSocialInitializationAfterBillingSync(userId);
          await finalizeOnboardingV2TrialPayment({
            invoice,
            metadata: mergedMetadata,
            subscription,
            userId,
          });
          await forwardInvoiceToSettlementLedger({
            event,
            invoice,
            subscription,
            metadata: mergedMetadata,
          });
        } else {
          await persistCommandInvoiceFromWebhook({ event, invoice });
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;

        const subscriptionId = (
          invoice as { subscription?: string | Stripe.Subscription }
        ).subscription;

        if (subscriptionId) {
          const subscriptionIdString =
            typeof subscriptionId === "string"
              ? subscriptionId
              : subscriptionId.id;

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionIdString);
          await persistCommandInvoiceFromWebhook({
            event,
            invoice,
            subscription,
          });
          const billingBusinessIds = getStripeMetadataBusinessIds(
            subscription.metadata,
          );
          const billingUserId = await resolveBillingUserId({
            metadata: normalizeMetadata(subscription.metadata),
            stripeCustomerId: getStripeCustomerId(subscription.customer),
            stripeSubscriptionId: subscriptionIdString,
            businessIds: billingBusinessIds,
          });
          if (!billingUserId) {
            throw new Error(
              `No billing owner found for subscription ${subscriptionIdString}`,
            );
          }

          if (subscription.metadata?.type === "add_website") {
            const newStatus =
              invoice.attempt_count && invoice.attempt_count >= 3
                ? "unpaid"
                : "past_due";
            await prisma.websiteSubscription.updateMany({
              where: {
                stripeSubscriptionId: subscriptionIdString,
                business: { userId: billingUserId },
              },
              data: { status: newStatus },
            });
            if (billingBusinessIds.length > 0) {
              await prisma.business.updateMany({
                where: {
                  id: { in: billingBusinessIds },
                  userId: billingUserId,
                },
                data: {
                  websiteStatus:
                    newStatus === "past_due" ? "past_due" : "suspended",
                  isActive: false,
                },
              });
            }
            console.log(
              `[Stripe Webhook] Updated add_website WebsiteSubscription(s) to ${newStatus} for subscription ${subscriptionIdString} (no account-level change)`,
            );
            break;
          }

          const userId = billingUserId;

          const newStatus =
            invoice.attempt_count && invoice.attempt_count >= 3
              ? "unpaid"
              : "past_due";

          try {
            await prisma.subscription.update({
              where: { userId },
              data: {
                status: newStatus,
                stripeStatus: newStatus,
              },
            });
            console.log(
              `✅ [Stripe Webhook] Subscription status updated to ${newStatus} for user ${userId}`,
            );
          } catch (error) {
            console.error(
              `❌ [Stripe Webhook] Failed to update subscription status for user ${userId} (invoice.payment_failed):`,
              error,
            );
            throw error;
          }

          try {
            await updateWebsiteSubscriptionStatus(userId, newStatus, {
              stripeSubscriptionId: subscriptionIdString,
              businessIds: getStripeMetadataBusinessIds(subscription.metadata),
            });
            console.log(
              `✅ [Stripe Webhook] Website subscription statuses updated to ${newStatus} for user ${userId}`,
            );
          } catch (websiteError) {
            console.error(
              `⚠️ [Stripe Webhook] Failed to update website subscription statuses for user ${userId}:`,
              websiteError,
            );
          }
        } else {
          await persistCommandInvoiceFromWebhook({ event, invoice });
        }
        break;
      }

      case "invoice.payment_action_required": {
        const invoice = event.data.object as Stripe.Invoice;

        const subscriptionId = (
          invoice as { subscription?: string | Stripe.Subscription }
        ).subscription;

        if (subscriptionId) {
          const subscriptionIdString =
            typeof subscriptionId === "string"
              ? subscriptionId
              : subscriptionId.id;

          const subscription =
            await stripe.subscriptions.retrieve(subscriptionIdString);
          await persistCommandInvoiceFromWebhook({
            event,
            invoice,
            subscription,
          });
          const billingBusinessIds = getStripeMetadataBusinessIds(
            subscription.metadata,
          );
          const billingUserId = await resolveBillingUserId({
            metadata: normalizeMetadata(subscription.metadata),
            stripeCustomerId: getStripeCustomerId(subscription.customer),
            stripeSubscriptionId: subscriptionIdString,
            businessIds: billingBusinessIds,
          });
          if (!billingUserId) {
            throw new Error(
              `No billing owner found for subscription ${subscriptionIdString}`,
            );
          }

          if (subscription.metadata?.type === "add_website") {
            await prisma.websiteSubscription.updateMany({
              where: {
                stripeSubscriptionId: subscriptionIdString,
                business: { userId: billingUserId },
              },
              data: { status: "incomplete" },
            });
            if (billingBusinessIds.length > 0) {
              await prisma.business.updateMany({
                where: {
                  id: { in: billingBusinessIds },
                  userId: billingUserId,
                },
                data: {
                  websiteStatus: "suspended",
                  isActive: false,
                },
              });
            }
            console.log(
              `[Stripe Webhook] Updated add_website WebsiteSubscription(s) to incomplete for subscription ${subscriptionIdString} (invoice.payment_action_required)`,
            );
            break;
          }

          const userId = billingUserId;

          try {
            await prisma.subscription.update({
              where: { userId },
              data: {
                status: "incomplete",
                stripeStatus: "incomplete",
              },
            });
            console.log(
              `✅ [Stripe Webhook] Subscription status updated to incomplete for user ${userId}`,
            );
          } catch (error) {
            console.error(
              `❌ [Stripe Webhook] Failed to update subscription status for user ${userId} (invoice.payment_action_required):`,
              error,
            );
            console.error(
              `   Error details:`,
              error instanceof Error ? error.stack : JSON.stringify(error),
            );
          }

          try {
            await updateWebsiteSubscriptionStatus(userId, "incomplete", {
              stripeSubscriptionId: subscriptionIdString,
              businessIds: getStripeMetadataBusinessIds(subscription.metadata),
            });
            console.log(
              `✅ [Stripe Webhook] Website subscription statuses updated to incomplete for user ${userId}`,
            );
          } catch (websiteError) {
            console.error(
              `⚠️ [Stripe Webhook] Failed to update website subscription statuses for user ${userId}:`,
              websiteError,
            );
          }
        } else {
          await persistCommandInvoiceFromWebhook({ event, invoice });
        }
        break;
      }

      case "customer.subscription.trial_will_end": {
        const subscription = event.data.object as Stripe.Subscription;

        const userId = await resolveBillingUserId({
          metadata: normalizeMetadata(subscription.metadata),
          stripeCustomerId: getStripeCustomerId(subscription.customer),
          stripeSubscriptionId: subscription.id,
          businessIds: getStripeMetadataBusinessIds(subscription.metadata),
        });

        if (!userId) {
          console.error(
            `[Stripe Webhook] No userId found in subscription metadata. Subscription ID: ${subscription.id}`,
          );
          break;
        }

        console.log(`[Stripe Webhook] Trial ending soon for user ${userId}`);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        await forwardChargeSettlementEvent({
          eventType: "charge.refunded",
          event,
          charge,
        });
        break;
      }

      case "refund.created":
      case "refund.updated": {
        const refund = event.data.object as Stripe.Refund;
        await processRefundBillingEvent(event, refund);
        break;
      }

      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        const charge = await stripe.charges.retrieve(String(dispute.charge));
        await forwardChargeSettlementEvent({
          eventType:
            event.type === "charge.dispute.created"
              ? "charge.dispute.created"
              : "charge.dispute.closed",
          event,
          charge,
          metadata: normalizeMetadata(dispute.metadata),
        });
        break;
      }

      case "credit_note.created": {
        const creditNote = event.data.object as Stripe.CreditNote;
        await forwardCreditNoteToSettlementLedger(event, creditNote);
        await processCreditNoteBillingEvent(event, creditNote);
        break;
      }

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    await invalidateStripeEventTenantCache(event).catch((error) => {
      console.error("[Stripe Webhook] Cache invalidation failed", error);
    });
    await invalidateSuperadminRevenueCache().catch((error) => {
      console.error("[Stripe Webhook] Revenue cache invalidation failed", error);
    });
    const completed = await completeStripeWebhookEvent(
      prisma.stripeWebhookEvent,
      event.id,
    );
    if (!completed) {
      throw new Error("Webhook event completion could not be recorded");
    }
    return response.status(200).json({ received: true });
  } catch (error) {
    console.error(
      `[Stripe Webhook] Error processing webhook event ${event.type}:`,
      error,
    );
    console.error(
      `   Error details:`,
      error instanceof Error ? error.stack : JSON.stringify(error),
    );
    if (eventClaim.status === "claimed") {
      const released = await releaseFailedStripeWebhookEvent(
        prisma.stripeWebhookEvent,
        event.id,
        error,
      );
      if (!released) {
        console.error(
          `[Stripe Webhook] Failed to release event claim ${event.id}; manual replay may be required`,
        );
      }
    }
    return response.status(500).json({ error: "Webhook processing failed" });
  }
}
