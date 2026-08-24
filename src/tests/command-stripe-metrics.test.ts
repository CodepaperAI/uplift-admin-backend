import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  aggregateStripeSubscriberCounts,
  aggregatePaidToDate,
  aggregateStripeMrr,
  isMrrEligibleSubscription,
} from "../command/stripe-metrics";

function subscription(
  stripeSubscriptionId: string,
  status: string,
  stripeCustomerId: string,
  amount: string,
  pauseCollectionBehavior: string | null = null,
) {
  return {
    stripeSubscriptionId,
    stripeCustomerId,
    userId: null,
    businessId: null,
    status,
    pauseCollectionBehavior,
    monthlyRecurringMinor: new Prisma.Decimal(amount),
    currency: "cad",
  };
}

describe("Command Stripe metrics", () => {
  it("separates accounts, subscriptions, settled paying, and trialing", () => {
    const facts = [
      subscription("sub_trial", "trialing", "cus_1", "100"),
      subscription("sub_paid", "active", "cus_1", "200"),
      subscription("sub_due", "past_due", "cus_2", "300"),
      subscription("sub_paused", "active", "cus_3", "400", "void"),
      subscription("sub_canceled", "canceled", "cus_4", "500"),
    ];
    expect(
      aggregateStripeSubscriberCounts(
        facts,
        new Set(["sub_paid", "sub_due", "sub_paused"]),
      ),
    ).toEqual({
      accounts: 3,
      subscriptions: 4,
      paying: 2,
      trialing: 1,
      pastDue: 1,
      paused: 1,
    });
  });
  it("includes trialing, active, and past_due but excludes unpaid, canceled, and paused", () => {
    expect(
      isMrrEligibleSubscription({
        status: "past_due",
        pauseCollectionBehavior: null,
      }),
    ).toBe(true);
    expect(
      isMrrEligibleSubscription({
        status: "active",
        pauseCollectionBehavior: "void",
      }),
    ).toBe(false);
    expect(
      isMrrEligibleSubscription({
        status: "unpaid",
        pauseCollectionBehavior: null,
      }),
    ).toBe(false);
  });

  it("keeps currencies separate and labels ARR as exactly MRR times twelve", () => {
    const result = aggregateStripeMrr([
      {
        stripeSubscriptionId: "sub_cad",
        stripeCustomerId: "cus_1",
        userId: "user_1",
        businessId: null,
        status: "active",
        pauseCollectionBehavior: null,
        monthlyRecurringMinor: new Prisma.Decimal("9900"),
        currency: "cad",
      },
      {
        stripeSubscriptionId: "sub_usd",
        stripeCustomerId: "cus_2",
        userId: "user_2",
        businessId: null,
        status: "trialing",
        pauseCollectionBehavior: null,
        monthlyRecurringMinor: new Prisma.Decimal("14900"),
        currency: "usd",
      },
    ]);

    expect(result.byCurrency).toEqual({ cad: "9900", usd: "14900" });
    expect(result.arrByCurrency).toEqual({ cad: "118800", usd: "178800" });
  });

  it("uses only settled Stripe invoice amount_paid for paid-to-date", () => {
    const result = aggregatePaidToDate([
      {
        amountPaidMinor: new Prisma.Decimal(14900),
        currency: "cad",
        status: "paid",
        paidAt: new Date(),
      },
      {
        amountPaidMinor: new Prisma.Decimal(300),
        currency: "cad",
        status: "open",
        paidAt: null,
      },
    ]);

    expect(result).toEqual({ cad: "14900" });
  });
});
