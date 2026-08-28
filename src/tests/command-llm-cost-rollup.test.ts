import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  describeLlmMonthSpend,
  llmCostSourceExternalId,
  rollUpLlmMonthSpend,
  usdToMinor,
} from "../command/llm-cost-rollup";
import { estimateUsdFromTokens } from "../services/llm-usage.service";

describe("usdToMinor", () => {
  it("rounds to whole cents", () => {
    expect(usdToMinor(new Prisma.Decimal("74.273685"))).toBe(BigInt(7427));
    expect(usdToMinor(new Prisma.Decimal("74.275"))).toBe(BigInt(7428));
    expect(usdToMinor(new Prisma.Decimal("0.004"))).toBe(BigInt(0));
    expect(usdToMinor(new Prisma.Decimal("0.005"))).toBe(BigInt(1));
  });

  it("handles zero and large totals", () => {
    expect(usdToMinor(new Prisma.Decimal(0))).toBe(BigInt(0));
    expect(usdToMinor(new Prisma.Decimal("123456.789"))).toBe(BigInt(12345679));
  });

  it("rounds away from zero for negatives too", () => {
    // Model spend is positive today; a sign-dependent rounding rule would be a
    // trap for whoever adds a credit or refund.
    expect(usdToMinor(new Prisma.Decimal("-0.005"))).toBe(BigInt(-1));
    expect(usdToMinor(new Prisma.Decimal("-74.273685"))).toBe(BigInt(-7427));
  });
});

describe("rollUpLlmMonthSpend", () => {
  it("prices per model from summed tokens and adds the stored estimate", () => {
    const tokenTotals = [
      { model: "gemini-2.5-flash", inputTokens: 149113, outputTokens: 7348497 },
      { model: "gpt-5.6-luna", inputTokens: 19798662, outputTokens: 3448989 },
    ];
    const expected = tokenTotals.reduce(
      (sum, row) =>
        sum.add(
          new Prisma.Decimal(
            estimateUsdFromTokens(row.model, row.inputTokens, row.outputTokens),
          ),
        ),
      new Prisma.Decimal(0),
    );
    const spend = rollUpLlmMonthSpend({
      tokenTotals,
      storedEstimateUsd: "25.379200",
    });
    expect(spend.fromTokensUsd.equals(expected)).toBe(true);
    expect(spend.fromStoredEstimateUsd.toFixed(6)).toBe("25.379200");
    expect(
      spend.totalUsd.equals(expected.add(new Prisma.Decimal("25.3792"))),
    ).toBe(true);
  });

  it("summing tokens then pricing equals pricing then summing", () => {
    // This equivalence is the whole reason a month of forty thousand events can
    // collapse to one grouped query. If the rate table ever stops being linear
    // in tokens, this test is what catches it.
    const rows = [
      { model: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 250_000 },
      { model: "gpt-5.6-luna", inputTokens: 3_000_000, outputTokens: 750_000 },
      { model: "gpt-5.6-luna", inputTokens: 500_000, outputTokens: 125_000 },
    ];
    const perRow = rows.reduce(
      (sum, row) =>
        sum +
        estimateUsdFromTokens(row.model, row.inputTokens, row.outputTokens),
      0,
    );
    const summedFirst = estimateUsdFromTokens(
      "gpt-5.6-luna",
      rows.reduce((n, r) => n + r.inputTokens, 0),
      rows.reduce((n, r) => n + r.outputTokens, 0),
    );
    expect(Math.abs(perRow - summedFirst)).toBeLessThan(0.000_01);
  });

  it("is zero when there is nothing to price", () => {
    const spend = rollUpLlmMonthSpend({ tokenTotals: [] });
    expect(spend.totalUsd.isZero()).toBe(true);
    expect(spend.amountMinor).toBe(BigInt(0));
  });

  it("treats a missing stored estimate as zero rather than throwing", () => {
    for (const stored of [null, undefined]) {
      const spend = rollUpLlmMonthSpend({ tokenTotals: [], storedEstimateUsd: stored });
      expect(spend.fromStoredEstimateUsd.isZero()).toBe(true);
    }
  });

  it("counts image-only spend, which reports no tokens at all", () => {
    // gpt-image-2 records a price and zero tokens; pricing it from tokens would
    // report the month's largest single line as nothing.
    const spend = rollUpLlmMonthSpend({
      tokenTotals: [{ model: "gpt-image-2", inputTokens: 0, outputTokens: 0 }],
      storedEstimateUsd: "25.3792",
    });
    expect(spend.amountMinor).toBe(BigInt(2538));
  });

  it("ignores negative token counts instead of crediting the month", () => {
    const spend = rollUpLlmMonthSpend({
      tokenTotals: [{ model: "gpt-5.6-luna", inputTokens: -5_000_000, outputTokens: -1 }],
    });
    expect(spend.totalUsd.isZero()).toBe(true);
  });

  it("prices an unknown model rather than dropping it", () => {
    // A model absent from the rate table falls back to a default rate, so new
    // models are under-described rather than free.
    const spend = rollUpLlmMonthSpend({
      tokenTotals: [
        { model: "some-model-shipped-yesterday", inputTokens: 2_000_000, outputTokens: 1_000_000 },
      ],
    });
    expect(spend.totalUsd.greaterThan(0)).toBe(true);
  });
});

describe("cost entry identity", () => {
  it("is stable per month, so a re-run updates rather than duplicates", () => {
    expect(llmCostSourceExternalId("2026-08")).toBe("llm-usage:2026-08");
    expect(llmCostSourceExternalId("2026-08")).toBe(
      llmCostSourceExternalId("2026-08"),
    );
    expect(llmCostSourceExternalId("2026-07")).not.toBe(
      llmCostSourceExternalId("2026-08"),
    );
  });
});

describe("describeLlmMonthSpend", () => {
  it("names both halves and says it is not an invoice", () => {
    const description = describeLlmMonthSpend({
      month: "2026-08",
      spend: rollUpLlmMonthSpend({
        tokenTotals: [{ model: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 0 }],
        storedEstimateUsd: "25.3792",
      }),
      modelCount: 1,
    });
    expect(description).toContain("2026-08");
    expect(description).toContain("25.38 USD recorded per event");
    expect(description).toContain("not an invoice");
  });

  it("uses the singular for one model", () => {
    const description = describeLlmMonthSpend({
      month: "2026-08",
      spend: rollUpLlmMonthSpend({ tokenTotals: [] }),
      modelCount: 1,
    });
    expect(description).toContain("1 model at current rates");
  });
});
