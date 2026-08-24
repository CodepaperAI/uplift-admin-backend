import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  aggregateGhlRevenue,
  normalizeGhlPaymentStatus,
} from "../command/ghl-payment-metrics";

describe("Command GHL payment metrics", () => {
  it("normalizes both documented string examples and defensive object statuses", () => {
    expect(normalizeGhlPaymentStatus("SUCCEEDED")).toBe("succeeded");
    expect(normalizeGhlPaymentStatus({ status: "Active" })).toBe("active");
    expect(normalizeGhlPaymentStatus({ value: "PAID" })).toBe("paid");
    expect(normalizeGhlPaymentStatus(null)).toBe("unknown");
  });

  it("separates recurring and one-time settled revenue and nets refunds", () => {
    const result = aggregateGhlRevenue(
      [
        { amount: new Prisma.Decimal("99.00"), amountRefunded: null, currency: "CAD", status: "succeeded", providerSubscriptionId: "ghl-sub" },
        { amount: new Prisma.Decimal("2500.00"), amountRefunded: new Prisma.Decimal("100"), currency: "cad", status: "paid", providerSubscriptionId: null },
        { amount: new Prisma.Decimal("500"), amountRefunded: null, currency: "cad", status: "failed", providerSubscriptionId: null },
      ],
      new Set(),
    );
    expect(result.byCurrency.cad).toEqual({
      recurring: "99",
      oneTime: "2400",
      collected: "2499",
    });
  });

  it("excludes subscriptions already represented by Stripe facts", () => {
    const result = aggregateGhlRevenue(
      [{ amount: new Prisma.Decimal("149"), amountRefunded: null, currency: "usd", status: "succeeded", providerSubscriptionId: "sub_known" }],
      new Set(["sub_known"]),
    );
    expect(result.excludedStripeDuplicates).toBe(1);
    expect(result.byCurrency).toEqual({});
  });
});
