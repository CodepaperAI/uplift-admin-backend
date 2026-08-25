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
  test("paying the full price first is a full-price start", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 14900, at: "2026-08-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("full");
    expect(result.reachedFullPrice).toBe(true);
    expect(result.firstPaidMinor).toBe("14900");
    expect(result.paidInvoiceCount).toBe(1);
  });

  test("a token first payment followed by a full one is a converted trial", () => {
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 300, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
        invoice({ paid: 14900, at: "2026-07-08T12:00:00Z" }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("trial");
    expect(result.reachedFullPrice).toBe(true);
    expect(result.firstPaidMinor).toBe("300");
    expect(result.paidInvoiceCount).toBe(2);
  });

  test("a token first payment with no full one yet has not converted", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 300, at: "2026-08-20T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("trial");
    expect(result.reachedFullPrice).toBe(false);
  });

  test("half price is a coupon, not a trial", () => {
    // The case that made the first version of this wrong: 54 accounts in
    // production opened at USD 74.00 against a USD 149.00 plan. Reading those
    // as trials turned a 12-person funnel into a 90-person one.
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 7400, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
        invoice({ paid: 14900, at: "2026-08-01T12:00:00Z" }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("discount");
    expect(result.reachedFullPrice).toBe(true);
  });

  test("the cheapest real coupon still reads as a coupon", () => {
    // USD 22.00 against a USD 99.00 plan is 22% — the lowest coupon entry
    // production has, and it must stay on the far side of the token boundary.
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 2200, at: "2026-07-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: dec("9900"),
    });
    expect(result.route).toBe("discount");
    expect(result.reachedFullPrice).toBe(false);
  });

  test("every real trial amount reads as a trial, not just one price", () => {
    // The rule has to survive repricing the trial, so the $0.50 already live
    // and a $3.00 one classify identically against a $149 plan.
    for (const paid of [50, 100, 300, 1000]) {
      const result = classifyEntryPath({
        invoices: [
          invoice({ paid, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
          invoice({ paid: 14900, at: "2026-08-01T12:00:00Z" }),
        ],
        recurringMinor: MONTHLY_149,
      });
      expect(result.route).toBe("trial");
    }
  });

  test("a few cents under the sticker is still the full price", () => {
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
    expect(result.route).toBe("full");
  });

  test("an annual plan's opening invoice is not mistaken for anything else", () => {
    // The invoice is a whole year; the recurring figure is the monthly twelfth.
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 99000, at: "2026-05-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: dec("8250"),
    });
    expect(result.route).toBe("full");
  });

  test("an annual plan bought after a trial still reads as a converted trial", () => {
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 300, at: "2026-05-01T12:00:00Z", reason: "subscription_create" }),
        invoice({ paid: 99000, at: "2026-05-08T12:00:00Z" }),
      ],
      recurringMinor: dec("8250"),
    });
    expect(result.route).toBe("trial");
    expect(result.reachedFullPrice).toBe(true);
  });

  test("the opening invoice is Stripe's, not whichever sorted first", () => {
    const result = classifyEntryPath({
      invoices: [
        invoice({ paid: 14900, at: "2026-06-01T12:00:00Z" }),
        invoice({ paid: 300, at: "2026-07-01T12:00:00Z", reason: "subscription_create" }),
      ],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("trial");
    expect(result.firstPaidMinor).toBe("300");
  });

  test("unpaid invoices say nothing about what someone paid", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 0, at: "2026-08-24T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: MONTHLY_149,
    });
    expect(result.route).toBe("none");
    expect(result.firstPaidMinor).toBeNull();
  });

  test("no invoice history at all is unknown, never a guess", () => {
    const result = classifyEntryPath({ invoices: [], recurringMinor: MONTHLY_149 });
    expect(result.route).toBe("unknown");
    expect(result.paidInvoiceCount).toBe(0);
  });

  test("a subscription with no price cannot be judged against one", () => {
    const result = classifyEntryPath({
      invoices: [invoice({ paid: 300, at: "2026-08-01T12:00:00Z", reason: "subscription_create" })],
      recurringMinor: dec(0),
    });
    expect(result.route).toBe("unknown");
    // The amount is still reported — it is the classification that is unknown.
    expect(result.firstPaidMinor).toBe("300");
  });
});

describe("tallyEntryPaths", () => {
  test("splits each route by whether it reached full price", () => {
    const totals = tallyEntryPaths([
      { route: "trial", reachedFullPrice: true, firstPaidMinor: "300", currency: "usd", paidInvoiceCount: 2 },
      { route: "trial", reachedFullPrice: false, firstPaidMinor: "50", currency: "usd", paidInvoiceCount: 1 },
      { route: "discount", reachedFullPrice: true, firstPaidMinor: "7400", currency: "usd", paidInvoiceCount: 3 },
      { route: "discount", reachedFullPrice: false, firstPaidMinor: "7400", currency: "usd", paidInvoiceCount: 1 },
      { route: "full", reachedFullPrice: true, firstPaidMinor: "14900", currency: "usd", paidInvoiceCount: 1 },
      { route: "none", reachedFullPrice: false, firstPaidMinor: null, currency: "usd", paidInvoiceCount: 0 },
      { route: "unknown", reachedFullPrice: false, firstPaidMinor: null, currency: null, paidInvoiceCount: 0 },
    ]);
    expect(totals).toEqual({
      trialConverted: 1,
      trialPending: 1,
      discountConverted: 1,
      discountPending: 1,
      full: 1,
      none: 1,
      unknown: 1,
    });
  });
});
