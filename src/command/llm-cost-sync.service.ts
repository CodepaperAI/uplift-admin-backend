import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { commandMonthRange } from "./toronto-period";
import {
  LLM_COST_SOURCE,
  describeLlmMonthSpend,
  llmCostSourceExternalId,
  rollUpLlmMonthSpend,
} from "./llm-cost-rollup";

/**
 * Records model spend as a cost entry, one per month.
 *
 * The spend was already tracked — every call writes an `llm_usage_event` and the
 * LLM usage page reports it — but it lived outside the cost ledger, so it never
 * reached gross margin, the profit-and-loss table, or anything else that reads
 * costs. It is the clearest delivery cost the business has: it scales directly
 * with blogs generated and images produced.
 *
 * Written as ledger entries rather than computed on the fly, deliberately.
 * Everything downstream — the per-currency summary, the cost trend, the category
 * rollup, unit economics — already reads `CommandCostEntry`, so materialising
 * means one source of truth and no second cost pipeline to keep in step. It also
 * follows the pattern Meta ads already uses for provider-sourced costs.
 *
 * Idempotent on `sourceExternalId`, which is `llm-usage:<month>`. Re-running
 * updates the month in place; it never appends. A month whose spend drops to
 * zero has its entry soft-deleted rather than left behind at a stale figure.
 *
 * Currency is USD because that is what the rate table is denominated in. It is
 * also, as it happens, the first real cost against the currency most Uplift
 * revenue arrives in.
 */

export type LlmCostSyncMonthResult = {
  month: string;
  totalUsd: string;
  amountMinor: string;
  modelCount: number;
  eventCount: number;
  action: "created" | "updated" | "unchanged" | "removed" | "skipped";
};

/** Rows carrying tokens are priced from them; rows without use the stored estimate. */
const HAS_TOKENS: Prisma.LlmUsageEventWhereInput = {
  OR: [{ inputTokens: { gt: 0 } }, { outputTokens: { gt: 0 } }],
};
const HAS_NO_TOKENS: Prisma.LlmUsageEventWhereInput = {
  AND: [
    { OR: [{ inputTokens: null }, { inputTokens: { lte: 0 } }] },
    { OR: [{ outputTokens: null }, { outputTokens: { lte: 0 } }] },
  ],
};

export async function syncLlmUsageCostsForMonth(input: {
  month: string;
  actorUserId?: string | null;
}): Promise<LlmCostSyncMonthResult> {
  const range = commandMonthRange(input.month);
  const inMonth = { gte: range.start, lt: range.end };

  /**
   * Three aggregates, no rows.
   *
   * A month is tens of thousands of events and the answer is one number, so
   * nothing here transfers a row: the token sums come back one per model, the
   * stored estimate as a single sum, and the count as a count. The LLM usage
   * page reads rows because it also needs their JSON metadata; this does not.
   */
  const [tokenGroups, storedEstimate, eventCount] = await Promise.all([
    prisma.llmUsageEvent.groupBy({
      by: ["model"],
      where: { createdAt: inMonth, ...HAS_TOKENS },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.llmUsageEvent.aggregate({
      where: { createdAt: inMonth, ...HAS_NO_TOKENS },
      _sum: { estimatedUsd: true },
    }),
    prisma.llmUsageEvent.count({ where: { createdAt: inMonth } }),
  ]);

  const spend = rollUpLlmMonthSpend({
    tokenTotals: tokenGroups.map((row) => ({
      model: row.model,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    })),
    storedEstimateUsd: storedEstimate._sum.estimatedUsd,
  });

  const sourceExternalId = llmCostSourceExternalId(input.month);
  const existing = await prisma.commandCostEntry.findUnique({
    where: { sourceExternalId },
    select: { id: true, amountMinor: true, deletedAt: true, description: true },
  });

  const base = {
    month: input.month,
    totalUsd: spend.totalUsd.toFixed(6),
    amountMinor: spend.amountMinor.toString(),
    modelCount: tokenGroups.length,
    eventCount,
  };

  if (spend.amountMinor === BigInt(0)) {
    // Nothing spent, or nothing recorded. An entry left at last month's figure
    // would be worse than no entry, so retire it and report that we did.
    if (existing && existing.deletedAt === null) {
      await prisma.commandCostEntry.update({
        where: { sourceExternalId },
        data: { deletedAt: new Date(), updatedByUserId: input.actorUserId ?? null },
      });
      return { ...base, action: "removed" };
    }
    return { ...base, action: "skipped" };
  }

  const amountMinor = new Prisma.Decimal(spend.amountMinor.toString());
  const description = describeLlmMonthSpend({
    month: input.month,
    spend,
    modelCount: tokenGroups.length,
  });
  const fields = {
    category: "delivery",
    costCategory: "LLM and AI",
    vendor: "AI providers",
    amountMinor,
    currency: "usd",
    description,
    // `range.start` is the Toronto month boundary as an instant, so this lands
    // inside the month it is for. A naive `new Date("2026-08-01")` would be
    // 2026-07-31 in Toronto and file August's spend against July.
    occurredAt: range.start,
  };

  const unchanged =
    existing !== null &&
    existing.deletedAt === null &&
    existing.amountMinor.equals(amountMinor) &&
    existing.description === description;

  await prisma.commandCostEntry.upsert({
    where: { sourceExternalId },
    create: { ...fields, source: LLM_COST_SOURCE, sourceExternalId },
    update: { ...fields, deletedAt: null, updatedByUserId: input.actorUserId ?? null },
  });

  return {
    ...base,
    action: !existing ? "created" : unchanged ? "unchanged" : "updated",
  };
}

export async function syncLlmUsageCosts(input: {
  months: readonly string[];
  actorUserId?: string | null;
}): Promise<LlmCostSyncMonthResult[]> {
  const results: LlmCostSyncMonthResult[] = [];
  // Sequential on purpose: each month is three cheap aggregates, and running a
  // year of them at once would occupy the whole connection pool for no gain.
  for (const month of input.months) {
    results.push(
      await syncLlmUsageCostsForMonth({ month, actorUserId: input.actorUserId }),
    );
  }
  return results;
}
