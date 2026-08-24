import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  aggregateCostAnalytics,
  commandMonthSequence,
} from "../command/cost-analytics";

describe("Command cost analytics", () => {
  it("builds a stable six-month sequence across year boundaries", () => {
    expect(commandMonthSequence("2026-02", 6)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("separates buckets, categories, vendors, months, and currencies", () => {
    const result = aggregateCostAnalytics(
      [
        { category: "acquisition", costCategory: "Meta Ads", vendor: "Meta", amountMinor: new Prisma.Decimal(1000), currency: "cad", occurredAt: new Date("2026-08-12T16:00:00Z") },
        { category: "delivery", costCategory: "Hosting", vendor: "Vercel", amountMinor: new Prisma.Decimal(250), currency: "cad", occurredAt: new Date("2026-08-13T16:00:00Z") },
        { category: "system", costCategory: "CRM", vendor: "GHL", amountMinor: new Prisma.Decimal(50), currency: "usd", occurredAt: new Date("2026-07-12T16:00:00Z") },
      ],
      ["2026-07", "2026-08"],
    );
    expect(result.cad?.trend[1]).toEqual({
      month: "2026-08",
      acquisitionMinor: "1000",
      deliveryMinor: "250",
      totalMinor: "1250",
    });
    expect(result.cad?.breakdown).toEqual([
      { category: "Meta Ads", vendor: "Meta", bucket: "acquisition", amountMinor: "1000" },
      { category: "Hosting", vendor: "Vercel", bucket: "delivery", amountMinor: "250" },
    ]);
    expect(result.usd?.trend[0]).toEqual({
      month: "2026-07",
      acquisitionMinor: "0",
      deliveryMinor: "50",
      totalMinor: "50",
    });
    expect(result.usd?.breakdown).toEqual([]);
  });
});
