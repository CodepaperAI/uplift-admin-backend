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

describe("the funnel stage on a built row", () => {
  /**
   * The Aug 26 regression, end to end.
   *
   * 219 signups that day. Ten of them held $99 or $149 subscriptions that
   * Stripe reported as active, every one billing three days after signup, none
   * with an invoice recorded. The panel counted them as neither paid nor
   * trialling, so a day with ten trials on it showed zero — and a rep looking
   * at "awaiting first bill" would have gone chasing a payment that was not
   * due for three days.
   */
  test("a live subscription billing three days out is on a trial", () => {
    const { rows } = buildDailySignups({
      users: [user("u1", "2026-08-26T22:09:00Z")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([
        ["u1", [sub("sub_1", "u1", "active", "14900", "2026-08-29T22:09:00Z")]],
      ]),
      // The point of the case: nothing settled yet.
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.state).toBe("pending");
    expect(rows[0]?.daysToNextBill).toBe(3);
    expect(rows[0]?.stage).toBe("trial");
  });

  test("nothing settled on a normal monthly cycle is genuinely unbilled", () => {
    const { rows } = buildDailySignups({
      users: [user("u1", "2026-08-26T22:09:00Z")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([
        ["u1", [sub("sub_1", "u1", "active", "14900", "2026-09-26T22:09:00Z")]],
      ]),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.state).toBe("pending");
    expect(rows[0]?.daysToNextBill).toBe(31);
    // A month with nothing settled is a payment that should have happened.
    expect(rows[0]?.stage).toBe("unbilled");
  });

  test("a paid signup is active regardless of when it next bills", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map([["u1", [sub("sub_1", "u1")]]]),
      invoicesBySubscription: new Map([["sub_1", [invoice("sub_1", 14900)]]]),
    });
    expect(rows[0]?.state).toBe("paid");
    expect(rows[0]?.stage).toBe("active");
  });

  test("no subscription is the top of the funnel, not an unbilled one", () => {
    const { rows } = buildDailySignups({
      users: [user("u1")],
      businessesByUser: noBusinesses,
      subscriptionsByUser: new Map(),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.stage).toBe("signed_up");
    expect(rows[0]?.planTag).toBe("none");
  });
});

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

describe("payment_failed state", () => {
  const user = {
    id: "u1",
    name: "Ramesh",
    email: "ramesh@example.com",
    phone: "+14165550101",
    createdAt: new Date("2026-08-10T14:00:00.000Z"),
  };

  function build(status: string, invoices: InvoiceFact[]) {
    return buildDailySignups({
      users: [user],
      businessesByUser: new Map(),
      subscriptionsByUser: new Map([
        [
          "u1",
          [
            {
              userId: "u1",
              status,
              monthlyRecurringMinor: new Prisma.Decimal("9900"),
              currency: "usd",
              stripeSubscriptionId: "sub_1",
              currentPeriodEnd: new Date("2026-09-10T14:00:00.000Z"),
              stripePriceIds: ["price_core_m"],
            },
          ],
        ],
      ]),
      invoicesBySubscription: new Map([["sub_1", invoices]]),
    });
  }

  // A settled full-price opening invoice, so the entry classifier reads this
  // account as a paying customer. That is the whole point of the fixture: the
  // failure has to win over a genuine payment history.
  const settled: InvoiceFact[] = [
    {
      stripeSubscriptionId: "sub_1",
      currency: "usd",
      amountPaidMinor: new Prisma.Decimal("9900"),
      billingReason: "subscription_create",
      paidAt: new Date("2026-08-10T14:05:00.000Z"),
      providerCreatedAt: new Date("2026-08-10T14:05:00.000Z"),
    },
  ];

  test("a past_due subscription that has paid before is not counted as paid", () => {
    // The regression this exists for: the entry classifier sees a settled
    // full-price invoice and reads the account as a customer, so a card being
    // declined right now was counted as active revenue.
    const { rows, totals } = build("past_due", settled);
    expect(rows[0]?.state).toBe("payment_failed");
    expect(rows[0]?.stage).toBe("payment_failed");
    expect(totals.paid).toBe(0);
    expect(totals.payment_failed).toBe(1);
  });

  test("unpaid counts the same as past_due", () => {
    expect(build("unpaid", settled).rows[0]?.state).toBe("payment_failed");
  });

  test("a cancelled subscription still reads as cancelled, not payment_failed", () => {
    expect(build("canceled", settled).rows[0]?.state).toBe("cancelled");
  });

  test("an active subscription is unaffected", () => {
    const { rows, totals } = build("active", settled);
    expect(rows[0]?.state).toBe("paid");
    expect(totals.payment_failed).toBe(0);
  });

  test("a past_due subscription with no settled invoice is still payment_failed", () => {
    // Not `pending`. Pending means the first charge has not come due; this one
    // has already failed, and the two need opposite responses.
    expect(build("past_due", []).rows[0]?.state).toBe("payment_failed");
  });

  test("a live past_due row outranks an older cancelled one", () => {
    const { rows } = buildDailySignups({
      users: [user],
      businessesByUser: new Map(),
      subscriptionsByUser: new Map([
        [
          "u1",
          [
            {
              userId: "u1",
              status: "canceled",
              monthlyRecurringMinor: new Prisma.Decimal("9900"),
              currency: "usd",
              stripeSubscriptionId: "sub_old",
              currentPeriodEnd: null,
            },
            {
              userId: "u1",
              status: "past_due",
              monthlyRecurringMinor: new Prisma.Decimal("14900"),
              currency: "usd",
              stripeSubscriptionId: "sub_new",
              currentPeriodEnd: new Date("2026-09-10T14:00:00.000Z"),
            },
          ],
        ],
      ]),
      invoicesBySubscription: new Map(),
    });
    expect(rows[0]?.state).toBe("payment_failed");
  });
});
