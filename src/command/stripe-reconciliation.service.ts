import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { projectCommandAccount } from "./account-projection.service";
import Stripe from "stripe";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";

type SubscriptionProjection = {
  status: string;
  pauseCollectionBehavior: string | null;
  cancelAtPeriodEnd: boolean;
  stripePriceIds: string[];
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

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

function customerProfile(value: Stripe.Subscription["customer"]): {
  id: string | null;
  name: string | null;
  email: string | null;
} {
  const id = objectId(value);
  if (typeof value === "string" || !value || "deleted" in value) {
    return { id, name: null, email: null };
  }
  return { id, name: value.name ?? null, email: value.email ?? null };
}

export function projectStripeSubscription(
  subscription: Stripe.Subscription,
): SubscriptionProjection {
  const recurringItems = subscription.items.data.filter(
    (item) => item.price.recurring !== null,
  );
  const currencies = new Set(recurringItems.map((item) => item.price.currency));
  const monthlyRecurringMinor = recurringItems.reduce((total, item) => {
    const recurring = item.price.recurring;
    if (!recurring) return total;
    const providerAmount =
      item.price.unit_amount_decimal ?? item.price.unit_amount ?? 0;
    const amount = new Prisma.Decimal(String(providerAmount)).mul(
      item.quantity ?? 1,
    );
    const intervalCount = new Prisma.Decimal(recurring.interval_count || 1);
    switch (recurring.interval) {
      case "day":
        return total.add(amount.mul(365).div(12).div(intervalCount));
      case "week":
        return total.add(amount.mul(52).div(12).div(intervalCount));
      case "month":
        return total.add(amount.div(intervalCount));
      case "year":
        return total.add(amount.div(12).div(intervalCount));
      default:
        return total;
    }
  }, new Prisma.Decimal(0));
  const firstItem = subscription.items.data[0] as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number | null;
        current_period_end?: number | null;
      })
    | undefined;

  return {
    status: subscription.status,
    pauseCollectionBehavior: subscription.pause_collection?.behavior ?? null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    stripePriceIds: recurringItems.map((item) => item.price.id).sort(),
    monthlyRecurringMinor,
    currency:
      currencies.size === 1 ? (recurringItems[0]?.price.currency ?? null) : null,
    currentPeriodStart: timestamp(firstItem?.current_period_start),
    currentPeriodEnd: timestamp(firstItem?.current_period_end),
  };
}

function sameSubscriptionProjection(
  existing: SubscriptionProjection,
  projected: SubscriptionProjection,
): boolean {
  return (
    existing.status === projected.status &&
    existing.pauseCollectionBehavior === projected.pauseCollectionBehavior &&
    existing.cancelAtPeriodEnd === projected.cancelAtPeriodEnd &&
    existing.stripePriceIds.join("|") === projected.stripePriceIds.join("|") &&
    existing.monthlyRecurringMinor.eq(projected.monthlyRecurringMinor) &&
    existing.currency === projected.currency &&
    existing.currentPeriodStart?.getTime() ===
      projected.currentPeriodStart?.getTime() &&
    existing.currentPeriodEnd?.getTime() === projected.currentPeriodEnd?.getTime()
  );
}

function stateKey(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = objectId(
    (invoice as Stripe.Invoice & { subscription?: unknown }).subscription,
  );
  if (legacy) return legacy;
  return objectId(
    (
      invoice as Stripe.Invoice & {
        parent?: { subscription_details?: { subscription?: unknown } } | null;
      }
    ).parent?.subscription_details?.subscription,
  );
}

export async function reconcileCommandStripeFacts(stripe: Stripe) {
  const run = await prisma.commandProviderSyncRun.create({
    data: { provider: "stripe", mode: "nightly_reconciliation" },
    select: { id: true },
  });
  let inspected = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const corrections: Array<Record<string, unknown>> = [];

  try {
    const [accountSubscriptions, websiteSubscriptions, latestFacts] =
      await Promise.all([
        prisma.subscription.findMany({
          where: { stripeSubscriptionId: { not: null } },
          select: { stripeSubscriptionId: true, userId: true },
        }),
        prisma.websiteSubscription.findMany({
          where: { stripeSubscriptionId: { not: null } },
          select: {
            stripeSubscriptionId: true,
            businessId: true,
            business: { select: { userId: true } },
          },
        }),
        prisma.commandStripeSubscriptionSnapshot.findMany(),
      ]);
    const accountBySubscription = new Map(
      accountSubscriptions.flatMap((item) =>
        item.stripeSubscriptionId
          ? [[item.stripeSubscriptionId, item.userId] as const]
          : [],
      ),
    );
    const websiteBySubscription = new Map(
      websiteSubscriptions.flatMap((item) =>
        item.stripeSubscriptionId
          ? [
              [
                item.stripeSubscriptionId,
                { businessId: item.businessId, userId: item.business.userId },
              ] as const,
            ]
          : [],
      ),
    );
    const latestBySubscription = new Map(
      latestFacts.map((item) => [item.stripeSubscriptionId, item]),
    );

    for await (const subscription of stripe.subscriptions.list({
      status: "all",
      limit: 100,
      expand: ["data.customer"],
    })) {
      inspected += 1;
      const projected = projectStripeSubscription(subscription);
      const customer = customerProfile(subscription.customer);
      const stripeCustomerId = customer.id;
      await projectCommandAccount({
        stripeCustomerId,
        name: customer.name,
        email: customer.email,
        userId:
          subscription.metadata.userId ||
          accountBySubscription.get(subscription.id) ||
          websiteBySubscription.get(subscription.id)?.userId ||
          null,
        businessId:
          subscription.metadata.businessId ||
          websiteBySubscription.get(subscription.id)?.businessId ||
          null,
      });
      const existing = latestBySubscription.get(subscription.id);
      if (existing && sameSubscriptionProjection(existing, projected)) {
        unchanged += 1;
        continue;
      }

      const website = websiteBySubscription.get(subscription.id);
      const userId =
        subscription.metadata.userId ||
        accountBySubscription.get(subscription.id) ||
        website?.userId ||
        null;
      const businessId =
        subscription.metadata.businessId || website?.businessId || null;
      const fingerprint = stateKey({
        ...projected,
        monthlyRecurringMinor: projected.monthlyRecurringMinor.toString(),
      });

      const stripeEventId = `reconcile:subscription:${subscription.id}:${fingerprint}`;
      const occurredAt = new Date();
      const snapshot = {
        lastStripeEventId: stripeEventId,
        eventType: "reconciliation.subscription.snapshot",
        stripeCustomerId,
        userId,
        businessId,
        ...projected,
        occurredAt,
        metadata: subscription.metadata,
      };
      await prisma.$transaction(async (tx) => {
        await tx.commandStripeSubscriptionEvent.createMany({
          data: [{
            stripeEventId,
            eventType: snapshot.eventType,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: snapshot.stripeCustomerId,
            userId: snapshot.userId,
            businessId: snapshot.businessId,
            status: snapshot.status,
            pauseCollectionBehavior: snapshot.pauseCollectionBehavior,
            cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
            stripePriceIds: snapshot.stripePriceIds,
            monthlyRecurringMinor: snapshot.monthlyRecurringMinor,
            currency: snapshot.currency,
            currentPeriodStart: snapshot.currentPeriodStart,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            occurredAt: snapshot.occurredAt,
            metadata: snapshot.metadata,
          }],
          skipDuplicates: true,
        });
        await tx.commandStripeSubscriptionSnapshot.upsert({
          where: { stripeSubscriptionId: subscription.id },
          create: {
            stripeSubscriptionId: subscription.id,
            ...snapshot,
          },
          update: snapshot,
        });
      });
      if (existing) {
        updated += 1;
        if (corrections.length < 200) {
          corrections.push({
            type: "subscription",
            stripeSubscriptionId: subscription.id,
            fromStatus: existing.status,
            toStatus: projected.status,
          });
        }
      } else {
        created += 1;
      }
    }

    const existingInvoices = await prisma.commandStripeInvoice.findMany({
      select: {
        stripeInvoiceId: true,
        status: true,
        amountPaidMinor: true,
        amountRemainingMinor: true,
      },
    });
    const invoiceById = new Map(
      existingInvoices.map((invoice) => [invoice.stripeInvoiceId, invoice]),
    );

    for await (const invoice of stripe.invoices.list({ limit: 100 })) {
      inspected += 1;
      const subscriptionId = invoiceSubscriptionId(invoice);
      const website = subscriptionId
        ? websiteBySubscription.get(subscriptionId)
        : null;
      const userId =
        invoice.metadata?.userId ||
        (subscriptionId ? accountBySubscription.get(subscriptionId) : null) ||
        website?.userId ||
        null;
      const businessId =
        invoice.metadata?.businessId || website?.businessId || null;
      const firstLine = invoice.lines.data[0];
      const fact = {
        lastStripeEventId: `reconcile:invoice:${invoice.id}:${stateKey({
          status: invoice.status,
          amountPaid: invoice.amount_paid,
          amountRemaining: invoice.amount_remaining,
        })}`,
        stripeCustomerId: objectId(invoice.customer),
        stripeSubscriptionId: subscriptionId,
        userId,
        businessId,
        status: invoice.status ?? "unknown",
        billingReason: invoice.billing_reason ?? null,
        collectionMethod: invoice.collection_method ?? null,
        amountDueMinor: new Prisma.Decimal(invoice.amount_due ?? 0),
        amountPaidMinor: new Prisma.Decimal(invoice.amount_paid ?? 0),
        amountRemainingMinor: new Prisma.Decimal(invoice.amount_remaining ?? 0),
        currency: (invoice.currency ?? "usd").toLowerCase(),
        attemptCount: invoice.attempt_count ?? 0,
        periodStart: timestamp(firstLine?.period?.start),
        periodEnd: timestamp(firstLine?.period?.end),
        paidAt: timestamp(invoice.status_transitions?.paid_at),
        providerCreatedAt: timestamp(invoice.created) ?? new Date(0),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
        source: "reconciliation",
        lastSyncedAt: new Date(),
      };
      await projectCommandAccount({
        stripeCustomerId: fact.stripeCustomerId,
        name: invoice.customer_name,
        email: invoice.customer_email,
        userId,
        businessId,
      });
      const existing = invoiceById.get(invoice.id);
      const hasChange =
        !existing ||
        existing.status !== fact.status ||
        !existing.amountPaidMinor.eq(fact.amountPaidMinor) ||
        !existing.amountRemainingMinor.eq(fact.amountRemainingMinor);

      await prisma.commandStripeInvoice.upsert({
        where: { stripeInvoiceId: invoice.id },
        create: { stripeInvoiceId: invoice.id, ...fact },
        update: fact,
      });
      if (!existing) created += 1;
      else if (hasChange) {
        updated += 1;
        if (corrections.length < 200) {
          corrections.push({
            type: "invoice",
            stripeInvoiceId: invoice.id,
            fromStatus: existing.status,
            toStatus: fact.status,
          });
        }
      } else unchanged += 1;
    }

    const result = { inspected, created, updated, unchanged, corrections };
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        ...result,
        corrections: corrections as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        inspected,
        created,
        updated,
        unchanged,
        corrections: corrections as Prisma.InputJsonValue,
        error: message.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    throw error;
  } finally {
    await invalidateCommandCache();
  }
}
