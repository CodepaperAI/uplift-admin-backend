import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  aggregateTrailingRevenueChurn,
  calculateGrowthEconomics,
} from "../command/growth-economics";

const d = (value: string | number) => new Prisma.Decimal(value);

describe("Command growth economics", () => {
  test("calculates CAC, margin-adjusted LTV and LTV:CAC exactly", () => {
    const result = calculateGrowthEconomics(
      {
        cad: {
          mrrMinor: d(100000),
          collectedMinor: d(100000),
          acquisitionCostMinor: d(20000),
          deliveryCostMinor: d(20000),
          salesCashMinor: d(30000),
          liveAccounts: 10,
          newCustomers: 2,
        },
      },
      { cad: "5" },
    );
    expect(result.cad?.cacMinor).toBe("25000");
    expect(result.cad?.monthlyArpuMinor).toBe("10000");
    expect(result.cad?.trailingRevenueChurnPercent).toBe("5");
    expect(result.cad?.ltvMinor).toBe("160000");
    expect(result.cad?.ltvToCac).toBe("6.40");
  });

  test("returns blockers rather than invented values for zero denominators", () => {
    const result = calculateGrowthEconomics(
      {
        usd: {
          mrrMinor: d(0),
          collectedMinor: d(0),
          acquisitionCostMinor: d(0),
          deliveryCostMinor: d(0),
          salesCashMinor: d(0),
          liveAccounts: 0,
          newCustomers: 0,
        },
      },
      {},
    );
    expect(result.usd?.cacMinor).toBeNull();
    expect(result.usd?.ltvMinor).toBeNull();
    expect(result.usd?.blockers).toContain(
      "no_positive_trailing_revenue_churn",
    );
  });

  test("uses total churned MRR over total opening MRR for the trailing window", () => {
    const result = aggregateTrailingRevenueChurn([
      {
        openingMrrMinorByCurrency: { cad: "10000", usd: "20000" },
        churnedMrrMinorByCurrency: { cad: "1000", usd: "0" },
      },
      {
        openingMrrMinorByCurrency: { cad: "9000", usd: "20000" },
        churnedMrrMinorByCurrency: { cad: "900", usd: "2000" },
      },
      {
        openingMrrMinorByCurrency: { cad: "8100", usd: "18000" },
        churnedMrrMinorByCurrency: { cad: "810", usd: "1800" },
      },
    ]);

    expect(result.openingMrrMinorByCurrency.cad).toBe("27100");
    expect(result.churnedMrrMinorByCurrency.cad).toBe("2710");
    expect(result.revenueChurnPercentByCurrency.cad).toBe("10.0000");
    expect(result.revenueChurnPercentByCurrency.usd).toBe("6.5517");
  });
});
