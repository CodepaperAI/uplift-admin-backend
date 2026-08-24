import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import { aggregateCommandUnitEconomics } from "../command/unit-economics";

describe("Command leadership unit economics", () => {
  it("subtracts delivery cost from margin but keeps acquisition separate", () => {
    const result = aggregateCommandUnitEconomics({
      collectedMinorByCurrency: { cad: "100000" },
      costs: [
        { category: "delivery", currency: "cad", amountMinor: new Prisma.Decimal("20000") },
        { category: "system", currency: "cad", amountMinor: new Prisma.Decimal("5000") },
        { category: "acquisition", currency: "cad", amountMinor: new Prisma.Decimal("30000") },
      ],
    });
    expect(result).toEqual({
      cad: {
        collectedMinor: "100000",
        acquisitionCostMinor: "30000",
        deliveryCostMinor: "25000",
        grossProfitMinor: "75000",
        grossMarginPercent: "75.00",
      },
    });
  });

  it("never combines currencies", () => {
    const result = aggregateCommandUnitEconomics({
      collectedMinorByCurrency: { cad: "10000", usd: "5000" },
      costs: [
        { category: "delivery", currency: "usd", amountMinor: new Prisma.Decimal("1000") },
      ],
    });
    expect(result.cad?.grossProfitMinor).toBe("10000");
    expect(result.usd?.grossProfitMinor).toBe("4000");
  });
});
