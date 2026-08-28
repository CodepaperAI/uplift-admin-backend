import { Prisma } from "@prisma/client";
import { estimateUsdFromTokens } from "../services/llm-usage.service";

/**
 * A month of model spend, priced the way the LLM usage page prices it.
 *
 * The pure half of the sync, kept separate so the arithmetic is testable without
 * a database.
 *
 * Two things make this less obvious than "sum the estimatedUsd column".
 *
 * First, `estimatedUsd` on the row is not what the panel reports. Its display
 * logic recomputes from tokens whenever a row has any, and falls back to the
 * stored value only for rows with none — image generation, mostly, which records
 * a price and no tokens. Summing the column would produce a number that matched
 * nothing on screen, and would price token rows at whatever the rate table said
 * when they were written rather than what it says now.
 *
 * Second, pricing is linear in tokens — rate x tokens / 1M — so summing tokens
 * per model and pricing once is exactly equal to pricing each row and summing,
 * minus a few rounding steps. That is what lets a month of forty thousand events
 * collapse to one grouped query returning a row per model.
 */

export type LlmModelTokenTotals = {
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type LlmMonthSpend = {
  /** Total USD for the month, to six decimal places. */
  totalUsd: Prisma.Decimal;
  /** USD priced from token counts, by model. */
  fromTokensUsd: Prisma.Decimal;
  /** USD taken from the stored estimate, for rows carrying no tokens. */
  fromStoredEstimateUsd: Prisma.Decimal;
  /** Whole cents, for a cost entry. */
  amountMinor: bigint;
};

/**
 * Cents, rounded half-up on the absolute value so a total never drifts by
 * direction. Model spend is always positive, but a rounding rule that depends on
 * sign is a trap left for whoever adds a refund.
 */
export function usdToMinor(total: Prisma.Decimal): bigint {
  const cents = total.mul(100);
  const rounded = cents.abs().add(new Prisma.Decimal("0.5")).floor();
  return BigInt(cents.isNegative() ? `-${rounded.toFixed(0)}` : rounded.toFixed(0));
}

export function rollUpLlmMonthSpend(input: {
  /** Per-model token sums for rows that carry tokens. */
  tokenTotals: readonly LlmModelTokenTotals[];
  /** Summed `estimatedUsd` for rows that carry none. */
  storedEstimateUsd?: Prisma.Decimal | string | number | null;
}): LlmMonthSpend {
  let fromTokensUsd = new Prisma.Decimal(0);
  for (const row of input.tokenTotals) {
    const priced = estimateUsdFromTokens(
      row.model,
      Math.max(0, row.inputTokens),
      Math.max(0, row.outputTokens),
    );
    if (!Number.isFinite(priced)) continue;
    fromTokensUsd = fromTokensUsd.add(new Prisma.Decimal(priced));
  }
  const fromStoredEstimateUsd =
    input.storedEstimateUsd === null || input.storedEstimateUsd === undefined
      ? new Prisma.Decimal(0)
      : new Prisma.Decimal(input.storedEstimateUsd);
  const totalUsd = fromTokensUsd.add(fromStoredEstimateUsd);
  return {
    totalUsd,
    fromTokensUsd,
    fromStoredEstimateUsd,
    amountMinor: usdToMinor(totalUsd),
  };
}

/**
 * What the cost entry says, so the page can be read without opening this file.
 *
 * Names the two components, because a reader comparing this against the LLM
 * usage page needs to know that the token half is repriced at current rates
 * while the image half is whatever was recorded at the time.
 */
export function describeLlmMonthSpend(input: {
  month: string;
  spend: LlmMonthSpend;
  modelCount: number;
}): string {
  return [
    `Model and image spend for ${input.month}, estimated.`,
    `${input.spend.fromTokensUsd.toFixed(2)} USD priced from token counts across`,
    `${input.modelCount} ${input.modelCount === 1 ? "model" : "models"} at current rates,`,
    `plus ${input.spend.fromStoredEstimateUsd.toFixed(2)} USD recorded per event for`,
    `calls that report no tokens. Synced from llm_usage_event, not an invoice.`,
  ].join(" ");
}

/** The stable id for a month's entry, so a re-run updates rather than duplicates. */
export const LLM_COST_SOURCE = "llm_usage";
export const LLM_COST_SOURCE_PREFIX = "llm-usage:";

export function llmCostSourceExternalId(month: string): string {
  return `${LLM_COST_SOURCE_PREFIX}${month}`;
}
