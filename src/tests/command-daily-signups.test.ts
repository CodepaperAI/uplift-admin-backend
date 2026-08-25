import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  buildDailySignups,
  type SignupSubscriptionFact,
} from "../command/daily-signups";
import type { InvoiceFact } from "../command/entry-path";

const dec = (v: string | number) => new Prisma.Decimal(v);

function user(id: string, at = "2026-08-25T14:00:00Z", phone: string | null = "+15550001") {
  return { id, name: `User ${id}`, email: `${id}@example.invalid`, phone, createdAt: new Date(at) };
}

function sub(
  id: string,
  userId: string,
  status = "active",
  mrr = "14900",
  currentPeriodEnd: string | null = "2026-09-25T14:00:00Z",
): SignupSubscriptionFact {
  return {
    userId,
    status,
    monthlyRecurringMinor: dec(mrr),
    currency: "usd",
    stripeSubscriptionId: id,
    currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : null,
  };
}

function invoice(subId: string, paid: number, at = "2026-08-25T14:05:00Z"): InvoiceFact {
  return {
    stripeSubscriptionId: subId,
    currency: "usd",
    amountPaidMinor: dec(paid),
    billingReason: "subscription_create",
    paidAt: new Date(at),
    providerCreatedAt: new Date(at),
  };
}

const noBusinesses = new Map<string, { businessName: string; businessWebsiteUrl: string }[]>();

describe("buildDailySignups", () => {
  test("a signup with no subscription is the plain case", () => {
    const { rows, totals } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.state).toBe("none");
    expect(rows[0]?.firstPaidMinor).toBeNull();
    expect(totals).toMatchObject({ signups: 1, none: 1, paid: 0, reachable: 1 });
  });

  test("a token first payment is a trial, and the amount is carried", () => {
    const { rows, totals } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 300)]]]),
    });
    expect(rows[0]?.state).toBe("trial");
    expect(rows[0]?.firstPaidMinor).toBe("300");
    expect(rows[0]?.mrrMinor).toBe("14900");
    expect(totals.trial).toBe(1);
  });

  test("a trial that already paid full price counts as paid", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([
        ["sub_1", [invoice("sub_1", 300), invoice("sub_1", 14900, "2026-08-25T15:00:00Z")]],
      ]),
    });
    expect(rows[0]?.state).toBe("paid");
  });

  test("full price on the first invoice is paid, not a trial", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 14900)]]]),
    });
    expect(rows[0]?.state).toBe("paid");
  });

  test("a coupon entry is not reported as a trial", () => {
    const { rows, totals } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 7400)]]]),
    });
    expect(rows[0]?.state).toBe("discounted");
    expect(totals.trial).toBe(0);
  });

  test("a subscription with nothing settled is pending, not paid", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 0)]]]),
    });
    expect(rows[0]?.state).toBe("pending");
  });

  test("signed up and cancelled the same day reads as cancelled", () => {
    const { rows, totals } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1", "canceled")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 300)]]]),
    });
    expect(rows[0]?.state).toBe("cancelled");
    expect(totals.cancelled).toBe(1);
  });

  test("a live subscription outranks an abandoned one", () => {
    // Cancelled a first attempt then subscribed again the same day. Sending a
    // rep to save a cancellation they already replaced would be worse than
    // sending nobody.
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([
        ["u1", [sub("sub_dead", "u1", "canceled"), sub("sub_live", "u1", "active")]],
      ]),
      invoicesBySubscription: new Map([["sub_live", [invoice("sub_live", 14900)]]]),
    });
    expect(rows[0]?.state).toBe("paid");
  });

  test("the business name and site come through for the call", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: new Map([
        ["u1", [{ businessName: "Acme Roofing", businessWebsiteUrl: "https://acme.invalid" }]],
      ]),
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.businessName).toBe("Acme Roofing");
    expect(rows[0]?.websiteUrl).toBe("https://acme.invalid");
    expect(rows[0]?.hasBusiness).toBe(true);
  });

  test("newest signup first — the one still warm", () => {
    const { rows } = buildDailySignups({
      users: [
        user("early", "2026-08-25T09:00:00Z"),
        user("late", "2026-08-25T18:00:00Z"),
        user("middle", "2026-08-25T13:00:00Z"),
      ],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(rows.map((r) => r.userId)).toEqual(["late", "middle", "early"]);
  });

  test("reachable counts the ones with a number, not everyone", () => {
    const { totals } = buildDailySignups({
      users: [user("a", "2026-08-25T09:00:00Z", "+15550001"), user("b", "2026-08-25T10:00:00Z", null), user("c", "2026-08-25T11:00:00Z", "  ")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(totals.signups).toBe(3);
    expect(totals.reachable).toBe(1);
  });
});

describe("the first bill date", () => {
  test("a short window is carried so a trial is not read as a failed card", () => {
    // The production case: signed up today, Stripe says active, bills in three
    // days. No established subscription on the book renews in under 31 days.
    const { rows } = buildDailySignups({
      users: [user("u1", "2026-08-25T14:00:00Z")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([
        ["u1", [sub("sub_1", "u1", "active", "14900", "2026-08-28T14:00:00Z")]],
      ]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 0)]]]),
    });
    expect(rows[0]?.state).toBe("pending");
    expect(rows[0]?.daysToNextBill).toBe(3);
    expect(rows[0]?.nextBillAt).toBe("2026-08-28T14:00:00.000Z");
  });

  test("a normal monthly window comes through as a month", () => {
    const { rows } = buildDailySignups({
      users: [user("u1", "2026-08-25T14:00:00Z")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([
        ["u1", [sub("sub_1", "u1", "active", "14900", "2026-09-25T14:00:00Z")]],
      ]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 14900)]]]),
    });
    expect(rows[0]?.state).toBe("paid");
    expect(rows[0]?.daysToNextBill).toBe(31);
  });

  test("no subscription means no bill date to report", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.nextBillAt).toBeNull();
    expect(rows[0]?.daysToNextBill).toBeNull();
  });
});
