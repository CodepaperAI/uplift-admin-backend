import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  classifyEntryPath,
  tallyEntryPaths,
  FULL_PRICE_RATIO,
  type InvoiceFact,
} from "../command/entry-path";

const dec = (value: string | number) => new Prisma.Decimal(value);

function invoice(input: {
  paid: string | number;
  at: string;
  reason?: string | null;
  currency?: string;
}): InvoiceFact {
  return {
    stripeSubscriptionId: "sub_1",
    currency: input.currency ?? "usd",
    amountPaidMinor: dec(input.paid),
    billingReason: input.reason === undefined ? "subscription_cycle" : input.reason,
    paidAt: new Date(input.at),
    providerCreatedAt: new Date(input.at),
  };
}

const MONTHLY_149 = dec("14900");

describe("classifyEntryPath", () => {
  test("paying the full price first is a direct start", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 14900, at: "2026-08-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("direct");
    expect(result.firstPaidMinor).toBe("14900");
    expect(result.paidInvoiceCount).toBe(1);
  });

  test("a cheap first payment followed by a full one is a converted trial", () => {
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 300, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
        invoice({ paid: 14900, at: "2026-07-08T12:00:00Z" }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("trial_converted");
    // The amount they actually started on is reported, not assumed.
    expect(result.firstPaidMinor).toBe("300");
    expect(result.paidInvoiceCount).toBe(2);
  });

  test("a cheap first payment with no full one yet is still pending", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 300, at: "2026-08-20T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("trial_pending");
  });

  test("any trial price classifies, not just one hardcoded number", () => {
    // The rule has to survive repricing the trial, so $0.50 and $3 both read
    // the same way against a $149 plan.
    for (const paid of [50, 100, 300, 999]) {
      const result = classifyEntryPath({
        invoices: [
          invoice({ paid, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
          invoice({ paid: 14900, at: "2026-08-01T12:00:00Z" }),
        ],
        recurringMinor: MONTHLY_149,
      });
      expect(result.path).toBe("trial_converted");
    }
  });

  test("a few cents under the sticker is still the full price", () => {
    // Coupon rounding and tax lines routinely land just below; that is a real
    // first payment, not a trial.
    const result = classifyEntryPath({
      invoices: [
        invoice({
          paid: Math.ceil(14900 * FULL_PRICE_RATIO),
          at: "2026-08-01T12:00:00Z",
          reason: "subscription_create",
        }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("direct");
  });

  test("an annual plan's opening invoice is not mistaken for a trial", () => {
    // The invoice is a whole year; the recurring figure is the monthly twelfth.
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 99000, at: "2026-05-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: dec("8250"),
    });
    expect(result.path).toBe("direct");
  });

  test("an annual plan bought after a trial still reads as converted", () => {
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 300, at: "2026-05-01T12:00:00Z", reason: "subscription_create" }),
        invoice({ paid: 99000, at: "2026-05-08T12:00:00Z" }),
      ],
      recurringMinor: dec("8250"),
    });
    expect(result.path).toBe("trial_converted");
  });

  test("the opening invoice is Stripe's, not whichever sorted first", () => {
    // A backfilled row can carry an odd creation time; the billing reason is
    // set by Stripe when the subscription is made, so it wins.
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 14900, at: "2026-06-01T12:00:00Z" }),
        invoice({ paid: 300, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("trial_converted");
    expect(result.firstPaidMinor).toBe("300");
  });

  test("unpaid invoices say nothing about what someone paid", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 0, at: "2026-08-24T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.path).toBe("no_payment_yet");
    expect(result.firstPaidMinor).toBeNull();
  });

  test("no invoice history at all is unknown, never a guess", () => {
    const result = classifyEntryPath({ invoices: [], recurringMinor: MONTHLY_149 });
    expect(result.path).toBe("unknown");
    expect(result.paidInvoiceCount).toBe(0);
  });

  test("a subscription with no price cannot be judged against one", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 300, at: "2026-08-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: dec(0),
    });
    expect(result.path).toBe("unknown");
    // The amount is still reported — it is the classification that is unknown.
    expect(result.firstPaidMinor).toBe("300");
  });
});

describe("tallyEntryPaths", () => {
  test("counts every path and leaves the rest at zero", () => {
    const totals = tallyEntryPaths([
      { path: "direct", firstPaidMinor: "14900", currency: "usd", paidInvoiceCount: 1 },
      { path: "direct", firstPaidMinor: "14900", currency: "usd", paidInvoiceCount: 3 },
      { path: "trial_converted", firstPaidMinor: "300", currency: "usd", paidInvoiceCount: 2 },
      { path: "no_payment_yet", firstPaidMinor: null, currency: "usd", paidInvoiceCount: 0 },
    ]);
    expect(totals).toEqual({
      direct: 2,
      trial_converted: 1,
      trial_pending: 0,
      no_payment_yet: 1,
      unknown: 0,
    });
  });
});
