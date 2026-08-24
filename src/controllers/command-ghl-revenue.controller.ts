import type { Request, Response } from "express";
import { aggregateGhlRevenue } from "../command/ghl-payment-metrics";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import {
  commandMonthRange,
  currentCommandMonth,
} from "../command/toronto-period";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import { inngest } from "../inngest/admin-client";

function requestedMonth(req: Request): string {
  return typeof req.query.month === "string"
    ? req.query.month
    : currentCommandMonth();
}

export async function getCommandGhlRevenue(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const period = commandMonthRange(requestedMonth(req));
    const { page, pageSize, skip } = parseCommandPagination({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    const cacheKey = `ghl-revenue-v1:${period.month}:${page}:${pageSize}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command GHL revenue");
      return;
    }
    const transactionWhere = {
      isActive: true,
      fulfilledAt: { gte: period.start, lt: period.end },
    } as const;
    const [
      transactions,
      transactionRows,
      transactionTotal,
      stripeSubscriptions,
      subscriptionStatusGroups,
      lastSync,
    ] = await Promise.all([
      prisma.commandGhlPaymentTransaction.findMany({
        where: transactionWhere,
        select: {
          amount: true,
          amountRefunded: true,
          currency: true,
          status: true,
          providerSubscriptionId: true,
        },
      }),
      prisma.commandGhlPaymentTransaction.findMany({
        where: transactionWhere,
        orderBy: [{ fulfilledAt: "desc" }, { ghlTransactionId: "asc" }],
        skip,
        take: pageSize,
      }),
      prisma.commandGhlPaymentTransaction.count({ where: transactionWhere }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: { stripeSubscriptionId: true },
      }),
      prisma.commandGhlPaymentSubscription.groupBy({
        by: ["status"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.commandProviderSyncRun.findFirst({
        where: { provider: "ghl_payments" },
        orderBy: { startedAt: "desc" },
      }),
    ]);
    const stripeSubscriptionIdSet = new Set(
      stripeSubscriptions.map((row) => row.stripeSubscriptionId),
    );
    const summary = aggregateGhlRevenue(
      transactions,
      stripeSubscriptionIdSet,
    );
    const payload = {
        period,
        paymentSync: {
          configured: Boolean(
            process.env.GHL_COMMAND_READ_TOKEN?.trim() &&
              process.env.GHL_COMMAND_LOCATION_ID?.trim(),
          ),
          enabled:
            process.env.COMMAND_GHL_PAYMENTS_SYNC_ENABLED?.trim().toLowerCase() ===
            "true",
        },
        summary,
        subscriptionStatusCounts: Object.fromEntries(
          subscriptionStatusGroups.map((row) => [
            row.status,
            row._count._all,
          ]),
        ),
        lastSync,
        pagination: commandPaginationResult({
          page,
          pageSize,
          total: transactionTotal,
        }),
        transactions: transactionRows.map((transaction) => ({
          ...transaction,
          amount: transaction.amount?.toString() ?? null,
          amountRefunded: transaction.amountRefunded?.toString() ?? null,
          revenueKind: transaction.providerSubscriptionId
            ? "recurring"
            : "one_time",
          excludedAsStripeDuplicate: transaction.providerSubscriptionId
            ? stripeSubscriptionIdSet.has(transaction.providerSubscriptionId)
            : false,
        })),
      };
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command GHL revenue");
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes("YYYY-MM") ? 400 : 500;
    sendError(res, "Failed to load GHL revenue", status, error);
  }
}

export async function requestCommandGhlPaymentSync(
  req: Request,
  res: Response,
): Promise<void> {
  if (
    !process.env.GHL_COMMAND_READ_TOKEN?.trim() ||
    !process.env.GHL_COMMAND_LOCATION_ID?.trim()
  ) {
    sendError(res, "GHL payment connection is not configured", 409);
    return;
  }
  if (
    process.env.COMMAND_GHL_PAYMENTS_SYNC_ENABLED?.trim().toLowerCase() !==
    "true"
  ) {
    sendError(res, "GHL payment sync is not enabled", 409);
    return;
  }
  try {
    const result = await inngest.send({
      name: "command/ghl.payments.sync.requested",
      data: {
        requestedByUserId: req.authUserId,
        requestedAt: new Date().toISOString(),
      },
    });
    sendSuccess(
      res,
      { eventIds: result.ids },
      "GHL payment sync queued",
      202,
    );
  } catch (error) {
    sendError(res, "Failed to queue GHL payment sync", 500, error);
  }
}
