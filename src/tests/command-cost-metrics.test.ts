import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import { aggregateCostMetrics } from "../command/cost-metrics";

describe("Command cost metrics", () => {
  it("subtracts delivery costs only from gross margin", () => {
    const summary = aggregateCostMetrics(
      [
        {
          category: "delivery",
          amountMinor: new Prisma.Decimal(2000),
          currency: "cad",
        },
        {
          category: "acquisition",
          amountMinor: new Prisma.Decimal(3000),
          currency: "cad",
        },
      ],
      [
        {
          amountPaidMinor: new Prisma.Decimal(10000),
          currency: "cad",
        },
      ],
    );

    expect(summary.cad?.grossProfitMinor).toBe("8000");
    expect(summary.cad?.grossMarginPercent).toBe("80");
    expect(summary.cad?.acquisitionCostMinor).toBe("3000");
  });

  it("never combines different currencies", () => {
    const summary = aggregateCostMetrics(
      [
        {
          category: "delivery",
          amountMinor: new Prisma.Decimal(1000),
          currency: "usd",
        },
        {
          category: "system",
          amountMinor: new Prisma.Decimal(250),
          currency: "usd",
        },
      ],
      [
        {
          amountPaidMinor: new Prisma.Decimal(5000),
          currency: "cad",
        },
      ],
    );
    expect(summary.cad?.grossProfitMinor).toBe("5000");
    expect(summary.usd?.grossProfitMinor).toBe("-1250");
  });
});
