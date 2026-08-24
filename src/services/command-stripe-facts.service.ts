import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";

function timestamp(value: number | null | undefined): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return null;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

export function normalizeCommandAccountEmail(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.includes("@") ? normalized : null;
}

export function canMergeStripeCommandAccount(
  existingStripeCustomerId: string | null,
  incomingStripeCustomerId: string,
): boolean {
  return (
    existingStripeCustomerId === null ||
    existingStripeCustomerId === incomingStripeCustomerId
  );
}

async function projectStripeCommandAccount(
  tx: Prisma.TransactionClient,
  input: {
    stripeCustomerId: string | null;
    userId: string | null;
    businessId: string | null;
    providerName?: string | null;
    providerEmail?: string | null;
  },
): Promise<void> {
  if (!input.stripeCustomerId) return;
  const providerEmail = normalizeCommandAccountEmail(input.providerEmail);
  const user = input.userId
    ? await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, name: true },
      })
    : providerEmail
      ? await tx.user.findFirst({
          where: { email: { equals: providerEmail, mode: "insensitive" } },
          select: { id: true, email: true, name: true },
        })
    : null;
  const business = input.businessId
    ? await tx.business.findUnique({
        where: { id: input.businessId },
        select: {
          id: true,
          businessName: true,
          userId: true,
          SalesCustomerAssignment: {
            select: {
              salesperson: {
                select: { CommandRepProfile: { select: { id: true } } },
              },
            },
          },
        },
      })
    : user
      ? await tx.business.findFirst({
          where: { userId: user.id },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          select: {
            id: true,
            businessName: true,
            userId: true,
            SalesCustomerAssignment: {
              select: {
                salesperson: {
                  select: { CommandRepProfile: { select: { id: true } } },
                },
              },
            },
          },
        })
      : null;
  let normalizedEmail =
    normalizeCommandAccountEmail(user?.email) ?? providerEmail;
  const byProvider = await tx.commandAccount.findUnique({
    where: { stripeCustomerId: input.stripeCustomerId },
  });
  let existing = byProvider;
  if (
    existing &&
    normalizedEmail &&
    existing.normalizedEmail !== normalizedEmail
  ) {
    const emailOwner = await tx.commandAccount.findUnique({
      where: { normalizedEmail },
      select: { id: true },
    });
    if (emailOwner && emailOwner.id !== existing.id) {
      normalizedEmail = existing.normalizedEmail;
    }
  }
  if (!existing && normalizedEmail) {
    const emailMatch = await tx.commandAccount.findUnique({
      where: { normalizedEmail },
    });
    if (
      emailMatch &&
      canMergeStripeCommandAccount(
        emailMatch.stripeCustomerId,
        input.stripeCustomerId,
      )
    ) {
      existing = emailMatch;
    } else if (emailMatch) {
      normalizedEmail = null;
    }
  }
  const data = {
    name:
      business?.businessName?.trim() ||
      user?.name?.trim() ||
      input.providerName?.trim() ||
      normalizedEmail ||
      input.stripeCustomerId,
    normalizedEmail,
    stripeCustomerId: input.stripeCustomerId,
    ownerRepId:
      business?.SalesCustomerAssignment?.salesperson.CommandRepProfile?.id ??
      existing?.ownerRepId ??
      null,
    userId: user?.id ?? business?.userId ?? input.userId,
    businessId: business?.id ?? input.businessId,
  };
  if (existing) {
    await tx.commandAccount.update({ where: { id: existing.id }, data });
  } else {
    await tx.commandAccount.create({ data });
  }
}

export function shouldAdvanceCommandSubscriptionSnapshot(
  existingOccurredAt: Date | null,
  candidateOccurredAt: Date,
): boolean {
  return existingOccurredAt === null || existingOccurredAt <= candidateOccurredAt;
}

function stripeCustomerProfile(value: Stripe.Subscription["customer"]): {
  name: string | null;
  email: string | null;
} {
  if (typeof value === "string" || !value || "deleted" in value) {
    return { name: null, email: null };
  }
  return { name: value.name ?? null, email: value.email ?? null };
}

export function buildCommandInvoiceFact(input: {
  eventId: string;
  invoice: Stripe.Invoice;
  subscriptionId?: string | null;
  userId?: string | null;
  businessId?: string | null;
  source?: "webhook" | "reconciliation";
}) {
  const firstLine = input.invoice.lines.data[0];
  const paidAt = timestamp(input.invoice.status_transitions?.paid_at);

  return {
    stripeInvoiceId: input.invoice.id,
    lastStripeEventId: input.eventId,
    stripeCustomerId: objectId(input.invoice.customer),
    stripeSubscriptionId:
      input.subscriptionId ??
      objectId(
        (input.invoice as Stripe.Invoice & { subscription?: unknown })
          .subscription,
      ),
    userId: input.userId ?? null,
    businessId: input.businessId ?? null,
    status: input.invoice.status ?? "unknown",
    billingReason: input.invoice.billing_reason ?? null,
    collectionMethod: input.invoice.collection_method ?? null,
    amountDueMinor: new Prisma.Decimal(input.invoice.amount_due ?? 0),
    amountPaidMinor: new Prisma.Decimal(input.invoice.amount_paid ?? 0),
    amountRemainingMinor: new Prisma.Decimal(
      input.invoice.amount_remaining ?? 0,
    ),
    currency: (input.invoice.currency ?? "usd").toLowerCase(),
    attemptCount: input.invoice.attempt_count ?? 0,
    periodStart: timestamp(firstLine?.period?.start),
    periodEnd: timestamp(firstLine?.period?.end),
    paidAt,
    providerCreatedAt: timestamp(input.invoice.created) ?? new Date(0),
    hostedInvoiceUrl: input.invoice.hosted_invoice_url ?? null,
    invoicePdf: input.invoice.invoice_pdf ?? null,
    source: input.source ?? "webhook",
    lastSyncedAt: new Date(),
  };
}

export async function persistCommandInvoiceFact(input: {
  eventId: string;
  invoice: Stripe.Invoice;
  subscriptionId?: string | null;
  userId?: string | null;
  businessId?: string | null;
  source?: "webhook" | "reconciliation";
}): Promise<void> {
  const fact = buildCommandInvoiceFact(input);
  await prisma.$transaction(async (tx) => {
    await tx.commandStripeInvoice.upsert({
      where: { stripeInvoiceId: fact.stripeInvoiceId },
      create: fact,
      update: fact,
    });
    await projectStripeCommandAccount(tx, {
      stripeCustomerId: fact.stripeCustomerId,
      userId: fact.userId,
      businessId: fact.businessId,
      providerName: input.invoice.customer_name,
      providerEmail: input.invoice.customer_email,
    });
  });
  await invalidateCommandCache();
}

export function buildCommandSubscriptionFact(input: {
  event: Stripe.Event;
  subscription: Stripe.Subscription;
  userId?: string | null;
  businessId?: string | null;
}) {
  const firstItem = input.subscription.items.data[0] as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number | null;
        current_period_end?: number | null;
      })
    | undefined;

  const recurringItems = input.subscription.items.data.filter(
    (item) => item.price.recurring !== null,
  );
  const currencies = new Set(recurringItems.map((item) => item.price.currency));
  const monthlyRecurringMinor = recurringItems.reduce<Prisma.Decimal>((total, item) => {
    const recurring = item.price.recurring;
    if (!recurring) return total;
    const unitAmount = new Prisma.Decimal(
      String(item.price.unit_amount_decimal ?? item.price.unit_amount ?? 0),
    );
    const periodAmount = unitAmount.mul(item.quantity ?? 1);
    const intervalCount = new Prisma.Decimal(recurring.interval_count || 1);

    switch (recurring.interval) {
      case "day":
        return total.add(periodAmount.mul(365).div(12).div(intervalCount));
      case "week":
        return total.add(periodAmount.mul(52).div(12).div(intervalCount));
      case "month":
        return total.add(periodAmount.div(intervalCount));
      case "year":
        return total.add(periodAmount.div(12).div(intervalCount));
      default:
        return total;
    }
  }, new Prisma.Decimal(0));

  return {
    stripeEventId: input.event.id,
    eventType: input.event.type,
    stripeSubscriptionId: input.subscription.id,
    stripeCustomerId: objectId(input.subscription.customer),
    userId: input.userId ?? null,
    businessId: input.businessId ?? null,
    status: input.subscription.status,
    pauseCollectionBehavior:
      input.subscription.pause_collection?.behavior ?? null,
    cancelAtPeriodEnd: input.subscription.cancel_at_period_end,
    stripePriceIds: recurringItems.map((item) => item.price.id),
    monthlyRecurringMinor,
    currency:
      currencies.size === 1 ? (recurringItems[0]?.price.currency ?? null) : null,
    currentPeriodStart: timestamp(firstItem?.current_period_start),
    currentPeriodEnd: timestamp(firstItem?.current_period_end),
    occurredAt: timestamp(input.event.created) ?? new Date(),
    metadata: jsonValue(input.subscription.metadata),
  };
}

export async function persistCommandSubscriptionFact(input: {
  event: Stripe.Event;
  subscription: Stripe.Subscription;
  userId?: string | null;
  businessId?: string | null;
}): Promise<void> {
  const fact = buildCommandSubscriptionFact(input);
  const providerCustomer = stripeCustomerProfile(input.subscription.customer);
  await prisma.$transaction(async (tx) => {
    await tx.commandStripeSubscriptionEvent.createMany({
      data: [fact],
      skipDuplicates: true,
    });
    await projectStripeCommandAccount(tx, {
      stripeCustomerId: fact.stripeCustomerId,
      userId: fact.userId,
      businessId: fact.businessId,
      providerName: providerCustomer.name,
      providerEmail: providerCustomer.email,
    });
    const existing = await tx.commandStripeSubscriptionSnapshot.findUnique({
      where: { stripeSubscriptionId: fact.stripeSubscriptionId },
      select: { occurredAt: true },
    });
    if (
      !shouldAdvanceCommandSubscriptionSnapshot(
        existing?.occurredAt ?? null,
        fact.occurredAt,
      )
    ) {
      return;
    }
    await tx.commandStripeSubscriptionSnapshot.upsert({
      where: { stripeSubscriptionId: fact.stripeSubscriptionId },
      create: {
        stripeSubscriptionId: fact.stripeSubscriptionId,
        lastStripeEventId: fact.stripeEventId,
        eventType: fact.eventType,
        stripeCustomerId: fact.stripeCustomerId,
        userId: fact.userId,
        businessId: fact.businessId,
        status: fact.status,
        pauseCollectionBehavior: fact.pauseCollectionBehavior,
        cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
        stripePriceIds: fact.stripePriceIds,
        monthlyRecurringMinor: fact.monthlyRecurringMinor,
        currency: fact.currency,
        currentPeriodStart: fact.currentPeriodStart,
        currentPeriodEnd: fact.currentPeriodEnd,
        occurredAt: fact.occurredAt,
        metadata: fact.metadata,
      },
      update: {
        lastStripeEventId: fact.stripeEventId,
        eventType: fact.eventType,
        stripeCustomerId: fact.stripeCustomerId,
        userId: fact.userId,
        businessId: fact.businessId,
        status: fact.status,
        pauseCollectionBehavior: fact.pauseCollectionBehavior,
        cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
        stripePriceIds: fact.stripePriceIds,
        monthlyRecurringMinor: fact.monthlyRecurringMinor,
        currency: fact.currency,
        currentPeriodStart: fact.currentPeriodStart,
        currentPeriodEnd: fact.currentPeriodEnd,
        occurredAt: fact.occurredAt,
        metadata: fact.metadata,
      },
    });
  });
  await invalidateCommandCache();
}
