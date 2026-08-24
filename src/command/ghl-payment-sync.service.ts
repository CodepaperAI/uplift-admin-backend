import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  GhlReadOnlyClient,
  type GhlPaymentSubscription,
  type GhlPaymentTransaction,
} from "./ghl-readonly.client";
import { normalizeGhlPaymentStatus } from "./ghl-payment-metrics";
import { projectCommandAccount } from "./account-projection.service";
import { invalidateCommandCache } from "../utils/command-cache";

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function decimal(value: number | string | undefined): Prisma.Decimal | null {
  if (value === undefined || value === "") return null;
  try {
    return new Prisma.Decimal(String(value));
  } catch {
    return null;
  }
}

function subscriptionData(
  item: GhlPaymentSubscription,
  locationId: string,
) {
  return {
    providerSubscriptionId: item.subscriptionId ?? null,
    locationId: item.altId ?? locationId,
    contactId: item.contactId ?? null,
    contactName: item.contactName ?? null,
    contactEmail: item.contactEmail ?? null,
    amount: decimal(item.amount),
    currency: item.currency?.toLowerCase() ?? null,
    status: normalizeGhlPaymentStatus(item.status),
    liveMode: item.liveMode ?? null,
    entityType: item.entityType ?? null,
    entityId: item.entityId ?? null,
    entitySourceType: item.entitySourceType ?? null,
    entitySourceName: item.entitySourceName ?? null,
    entitySourceId: item.entitySourceId ?? null,
    paymentProviderType: item.paymentProviderType?.toLowerCase() ?? null,
    paymentProviderAccountId: item.paymentProviderConnectedAccount ?? null,
    providerCreatedAt: date(item.createdAt),
    providerUpdatedAt: date(item.updatedAt),
    isActive: true,
    lastSyncedAt: new Date(),
  };
}

function transactionData(item: GhlPaymentTransaction, locationId: string) {
  return {
    locationId: item.altId ?? locationId,
    contactId: item.contactId ?? null,
    contactName: item.contactName ?? null,
    contactEmail: item.contactEmail ?? null,
    amount: decimal(item.amount),
    amountRefunded: decimal(item.amountRefunded),
    currency: item.currency?.toLowerCase() ?? null,
    status: normalizeGhlPaymentStatus(item.status),
    liveMode: item.liveMode ?? null,
    providerSubscriptionId: item.subscriptionId ?? null,
    chargeId: item.chargeId ?? null,
    entityType: item.entityType ?? null,
    entityId: item.entityId ?? null,
    entitySourceType: item.entitySourceType ?? null,
    entitySourceSubType: item.entitySourceSubType ?? null,
    entitySourceName: item.entitySourceName ?? null,
    entitySourceId: item.entitySourceId ?? null,
    paymentProviderType: item.paymentProviderType?.toLowerCase() ?? null,
    paymentProviderAccountId: item.paymentProviderConnectedAccount ?? null,
    fulfilledAt: date(item.fulfilledAt),
    providerCreatedAt: date(item.createdAt),
    providerUpdatedAt: date(item.updatedAt),
    isActive: true,
    lastSyncedAt: new Date(),
  };
}

export async function syncCommandGhlPayments(
  client: GhlReadOnlyClient,
  locationId: string,
) {
  const run = await prisma.commandProviderSyncRun.create({
    data: { provider: "ghl_payments", mode: "hourly_read_sync" },
    select: { id: true },
  });
  let inspected = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    const [existingSubscriptions, existingTransactions] = await Promise.all([
      prisma.commandGhlPaymentSubscription.findMany({
        select: { ghlSubscriptionRecordId: true },
      }),
      prisma.commandGhlPaymentTransaction.findMany({
        select: { ghlTransactionId: true },
      }),
    ]);
    const existingSubscriptionIds = new Set(
      existingSubscriptions.map((row) => row.ghlSubscriptionRecordId),
    );
    const existingTransactionIds = new Set(
      existingTransactions.map((row) => row.ghlTransactionId),
    );
    const seenSubscriptionIds = new Set<string>();
    const seenTransactionIds = new Set<string>();

    for (let offset = 0; offset < 1_000_000; offset += 100) {
      const page = await client.paymentSubscriptionsPage(offset);
      for (const item of page.data) {
        if (!item._id) continue;
        inspected += 1;
        seenSubscriptionIds.add(item._id);
        const data = subscriptionData(item, locationId);
        await prisma.commandGhlPaymentSubscription.upsert({
          where: { ghlSubscriptionRecordId: item._id },
          create: { ghlSubscriptionRecordId: item._id, ...data },
          update: data,
        });
        await projectCommandAccount({
          ghlContactId: item.contactId,
          name: item.contactName,
          email: item.contactEmail,
        });
        if (existingSubscriptionIds.has(item._id)) updated += 1;
        else created += 1;
      }
      if (offset + page.data.length >= page.totalCount) break;
      if (page.data.length === 0) {
        throw new Error("GHL payment subscription pagination did not advance");
      }
    }

    for (let offset = 0; offset < 1_000_000; offset += 100) {
      const page = await client.paymentTransactionsPage(offset);
      for (const item of page.data) {
        if (!item._id) continue;
        inspected += 1;
        seenTransactionIds.add(item._id);
        const data = transactionData(item, locationId);
        await prisma.commandGhlPaymentTransaction.upsert({
          where: { ghlTransactionId: item._id },
          create: { ghlTransactionId: item._id, ...data },
          update: data,
        });
        await projectCommandAccount({
          ghlContactId: item.contactId,
          name: item.contactName,
          email: item.contactEmail,
        });
        if (existingTransactionIds.has(item._id)) updated += 1;
        else created += 1;
      }
      if (offset + page.data.length >= page.totalCount) break;
      if (page.data.length === 0) {
        throw new Error("GHL payment transaction pagination did not advance");
      }
    }

    const [subscriptionsDeactivated, transactionsDeactivated] =
      await Promise.all([
        prisma.commandGhlPaymentSubscription.updateMany({
          where: {
            isActive: true,
            ...(seenSubscriptionIds.size > 0
              ? {
                  ghlSubscriptionRecordId: {
                    notIn: [...seenSubscriptionIds],
                  },
                }
              : {}),
          },
          data: { isActive: false },
        }),
        prisma.commandGhlPaymentTransaction.updateMany({
          where: {
            isActive: true,
            ...(seenTransactionIds.size > 0
              ? { ghlTransactionId: { notIn: [...seenTransactionIds] } }
              : {}),
          },
          data: { isActive: false },
        }),
      ]);
    updated += subscriptionsDeactivated.count + transactionsDeactivated.count;
    unchanged = Math.max(0, inspected - created - updated);
    const result = { inspected, created, updated, unchanged };
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: { status: "completed", ...result, completedAt: new Date() },
    });
    await invalidateCommandCache();
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
        error: message.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    throw error;
  }
}
