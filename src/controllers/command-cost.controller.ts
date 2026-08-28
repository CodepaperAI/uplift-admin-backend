import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { aggregateCostMetrics } from "../command/cost-metrics";
import { COMMAND_COST_INPUT } from "../command/cost-input";
import {
  commandMonthRange,
  commandMonthsEndingAt,
  currentCommandMonth,
} from "../command/toronto-period";

/**
 * The window the cost trend shows, so a sync fills exactly what the
 * profit-and-loss table can display.
 */
const LLM_COST_DEFAULT_MONTHS = 6;
/** A ceiling, so one request cannot walk the entire event history. */
const LLM_COST_MAX_MONTHS = 24;
import { prisma } from "../config/db.config";
import { syncLlmUsageCosts } from "../command/llm-cost-sync.service";
import { inngest } from "../inngest/admin-client";
import { isProviderManagedCostSource } from "../command/cost-source-policy";
import {
  aggregateCostAnalytics,
  commandMonthSequence,
} from "../command/cost-analytics";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  invalidateCommandCache,
  readCommandCache,
  writeCommandCache,
} from "../utils/command-cache";

function requestedMonth(req: Request): string {
  return typeof req.query.month === "string"
    ? req.query.month
    : currentCommandMonth();
}

export async function getCommandCosts(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const period = commandMonthRange(requestedMonth(req));
    const cacheKey = `costs-v1:${period.month}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command costs");
      return;
    }
    const analyticsMonths = commandMonthSequence(period.month, 6);
    const analyticsStart = commandMonthRange(analyticsMonths[0]!).start;
    const [entries, invoices, metaAdsRun, analyticsEntries] = await Promise.all([
      prisma.commandCostEntry.findMany({
        where: {
          deletedAt: null,
          occurredAt: { gte: period.start, lt: period.end },
        },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      }),
      prisma.commandStripeInvoice.findMany({
        where: {
          status: "paid",
          paidAt: { gte: period.start, lt: period.end },
        },
        select: { amountPaidMinor: true, currency: true },
      }),
      prisma.commandProviderSyncRun.findFirst({
        where: { provider: "meta_ads" },
        orderBy: { startedAt: "desc" },
      }),
      prisma.commandCostEntry.findMany({
        where: {
          deletedAt: null,
          occurredAt: { gte: analyticsStart, lt: period.end },
        },
        select: {
          category: true,
          costCategory: true,
          vendor: true,
          amountMinor: true,
          currency: true,
          occurredAt: true,
        },
      }),
    ]);
    const payload = {
        period,
        summaryByCurrency: aggregateCostMetrics(entries, invoices),
        analyticsByCurrency: aggregateCostAnalytics(
          analyticsEntries,
          analyticsMonths,
        ),
        entries: entries.map((entry) => ({
          ...entry,
          amountMinor: entry.amountMinor.toString(),
        })),
        integrations: {
          metaAds: {
            configured:
              Boolean(process.env.META_ADS_ACCESS_TOKEN?.trim()) &&
              Boolean(process.env.META_AD_ACCOUNT_ID?.trim()) &&
              Boolean(process.env.META_GRAPH_API_VERSION?.trim()),
            syncEnabled:
              process.env.COMMAND_META_ADS_SYNC_ENABLED === "true",
            lastRun: metaAdsRun,
          },
          googleAds: {
            configured: false,
            syncEnabled: false,
            manualFallback: true,
          },
        },
      };
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command costs");
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes("YYYY-MM") ? 400 : 500;
    sendError(res, "Failed to load Command costs", status, error);
  }
}

export async function createCommandCost(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_COST_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid cost entry", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  try {
    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.commandCostEntry.create({
        data: {
          ...parsed.data,
          amountMinor: new Prisma.Decimal(parsed.data.amountMinor),
          currency: parsed.data.currency.toLowerCase(),
          source: "manual",
          createdByUserId: req.authUserId,
          updatedByUserId: req.authUserId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.cost.create",
          targetType: "command_cost_entry",
          targetId: created.id,
          before: Prisma.JsonNull,
          after: {
            category: created.category,
            costCategory: created.costCategory,
            vendor: created.vendor,
            amountMinor: created.amountMinor.toString(),
            currency: created.currency,
            description: created.description,
            occurredAt: created.occurredAt,
          },
          details: {
            after: {
              category: created.category,
              costCategory: created.costCategory,
              vendor: created.vendor,
              amountMinor: created.amountMinor.toString(),
              currency: created.currency,
              description: created.description,
              occurredAt: created.occurredAt,
            },
          },
          ipAddress: req.ip,
        },
      });
      return created;
    });
    await invalidateCommandCache();
    sendSuccess(
      res,
      { ...entry, amountMinor: entry.amountMinor.toString() },
      "Cost entry created",
      201,
    );
  } catch (error) {
    sendError(res, "Failed to create cost entry", 500, error);
  }
}

export async function updateCommandCost(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_COST_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid cost entry", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  try {
    const existing = await prisma.commandCostEntry.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) {
      sendError(res, "Cost entry not found", 404);
      return;
    }
    if (isProviderManagedCostSource(existing.source)) {
      sendError(
        res,
        "Provider-imported costs are read-only. Add an audited manual correction instead.",
        409,
      );
      return;
    }
    const entry = await prisma.$transaction(async (tx) => {
      const updated = await tx.commandCostEntry.update({
        where: { id: existing.id },
        data: {
          ...parsed.data,
          amountMinor: new Prisma.Decimal(parsed.data.amountMinor),
          currency: parsed.data.currency.toLowerCase(),
          updatedByUserId: req.authUserId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.cost.update",
          targetType: "command_cost_entry",
          targetId: existing.id,
          before: {
            category: existing.category,
            costCategory: existing.costCategory,
            vendor: existing.vendor,
            amountMinor: existing.amountMinor.toString(),
            currency: existing.currency,
            description: existing.description,
            occurredAt: existing.occurredAt,
          },
          after: {
            category: updated.category,
            costCategory: updated.costCategory,
            vendor: updated.vendor,
            amountMinor: updated.amountMinor.toString(),
            currency: updated.currency,
            description: updated.description,
            occurredAt: updated.occurredAt,
          },
          details: {
            before: {
              category: existing.category,
              costCategory: existing.costCategory,
              vendor: existing.vendor,
              amountMinor: existing.amountMinor.toString(),
              currency: existing.currency,
              description: existing.description,
              occurredAt: existing.occurredAt,
            },
            after: {
              category: updated.category,
              costCategory: updated.costCategory,
              vendor: updated.vendor,
              amountMinor: updated.amountMinor.toString(),
              currency: updated.currency,
              description: updated.description,
              occurredAt: updated.occurredAt,
            },
          },
          ipAddress: req.ip,
        },
      });
      return updated;
    });
    await invalidateCommandCache();
    sendSuccess(
      res,
      { ...entry, amountMinor: entry.amountMinor.toString() },
      "Cost entry updated",
    );
  } catch (error) {
    sendError(res, "Failed to update cost entry", 500, error);
  }
}

export async function deleteCommandCost(
  req: Request,
  res: Response,
): Promise<void> {
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  try {
    const existing = await prisma.commandCostEntry.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) {
      sendError(res, "Cost entry not found", 404);
      return;
    }
    if (isProviderManagedCostSource(existing.source)) {
      sendError(
        res,
        "Provider-imported costs are read-only. Add an audited manual correction instead.",
        409,
      );
      return;
    }
    await prisma.$transaction([
      prisma.commandCostEntry.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), updatedByUserId: req.authUserId },
      }),
      prisma.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId,
          action: "command.cost.delete",
          targetType: "command_cost_entry",
          targetId: existing.id,
          before: {
            category: existing.category,
            costCategory: existing.costCategory,
            vendor: existing.vendor,
            amountMinor: existing.amountMinor.toString(),
            currency: existing.currency,
            description: existing.description,
            occurredAt: existing.occurredAt,
          },
          after: Prisma.JsonNull,
          details: {
            before: {
              category: existing.category,
              costCategory: existing.costCategory,
              vendor: existing.vendor,
              amountMinor: existing.amountMinor.toString(),
              currency: existing.currency,
              description: existing.description,
              occurredAt: existing.occurredAt,
            },
          },
          ipAddress: req.ip,
        },
      }),
    ]);
    await invalidateCommandCache();
    sendSuccess(res, { id: existing.id }, "Cost entry deleted");
  } catch (error) {
    sendError(res, "Failed to delete cost entry", 500, error);
  }
}

/**
 * Records model spend into the cost ledger for a range of months.
 *
 * Synchronous, unlike the Meta Ads sync beside it, because that one calls an
 * external API and this one is three grouped queries per month against a table
 * we own. Queueing it would add a round trip and a place for the result to get
 * lost, for no benefit.
 *
 * Defaults to the six months the cost trend displays, so the profit-and-loss
 * table fills in rather than reporting "not recorded" for every month before
 * costs were first kept by hand.
 */
export async function refreshCommandLlmCosts(
  req: Request,
  res: Response,
): Promise<void> {
  const requestedMonths = Array.isArray(req.body?.months)
    ? req.body.months.filter((value: unknown): value is string => typeof value === "string")
    : typeof req.body?.month === "string"
      ? [req.body.month]
      : commandMonthsEndingAt(currentCommandMonth(), LLM_COST_DEFAULT_MONTHS);
  if (requestedMonths.length === 0 || requestedMonths.length > LLM_COST_MAX_MONTHS) {
    sendError(
      res,
      `Request between 1 and ${LLM_COST_MAX_MONTHS} months`,
      400,
    );
    return;
  }
  try {
    for (const month of requestedMonths) commandMonthRange(month);
    const months = await syncLlmUsageCosts({
      months: requestedMonths,
      actorUserId: req.authUserId ?? null,
    });
    // Cost figures are cached, and a sync that leaves the panel showing the old
    // number reads as a sync that did not work.
    await invalidateCommandCache();
    sendSuccess(
      res,
      {
        months,
        totalsUsd: months
          .reduce((sum, month) => sum + Number(month.totalUsd), 0)
          .toFixed(2),
      },
      "LLM costs recorded",
    );
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes("YYYY-MM") ? 400 : 500;
    sendError(res, "Failed to record LLM costs", status, error);
  }
}

export async function requestCommandMetaAdsSync(
  req: Request,
  res: Response,
): Promise<void> {
  const month =
    typeof req.body?.month === "string"
      ? req.body.month
      : currentCommandMonth();
  try {
    commandMonthRange(month);
    const result = await inngest.send({
      name: "command/meta-ads.sync.requested",
      data: {
        month,
        requestedByUserId: req.authUserId,
        requestedAt: new Date().toISOString(),
      },
    });
    sendSuccess(
      res,
      { eventIds: result.ids, month },
      "Meta Ads sync queued",
      202,
    );
  } catch (error) {
    const status =
      error instanceof Error && error.message.includes("YYYY-MM") ? 400 : 500;
    sendError(res, "Failed to queue Meta Ads sync", status, error);
  }
}
