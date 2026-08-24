import { describe, expect, it } from "bun:test";
import {
  buildDailyPaymentMetrics,
  buildDailyUserMetrics,
} from "../utils/superadmin-daily-metrics";

describe("superadmin daily user metrics", () => {
  it("returns exact current and previous windows with current status buckets", () => {
    const result = buildDailyUserMetrics({
      from: "2026-08-20",
      to: "2026-08-21",
      previousFrom: "2026-08-18",
      previousTo: "2026-08-19",
      users: [
        { createdAt: new Date("2026-08-18T14:00:00Z"), status: "expired" },
        { createdAt: new Date("2026-08-20T03:30:00Z"), status: "trial" },
        { createdAt: new Date("2026-08-20T15:00:00Z"), status: "paid" },
        { createdAt: new Date("2026-08-21T16:00:00Z"), status: "expired" },
      ],
    });

    expect(result.currentTotal).toBe(2);
    expect(result.previousTotal).toBe(2);
    expect(result.firstSignupDay).toBe("2026-08-18");
    expect(result.summary).toEqual({
      totalUsers: 4,
      totalPaid: 1,
      totalTrial: 1,
      totalExpired: 2,
    });
    expect(result.items).toEqual([
      {
        date: "2026-08-21",
        signups: 1,
        paidNow: 0,
        trialNow: 0,
        expiredNow: 1,
      },
      {
        date: "2026-08-20",
        signups: 1,
        paidNow: 1,
        trialNow: 0,
        expiredNow: 0,
      },
    ]);
  });
});

describe("superadmin daily payment metrics", () => {
  it("counts positive settled payments, currencies, and new subscriptions", () => {
    const result = buildDailyPaymentMetrics({
      from: "2026-08-20",
      to: "2026-08-21",
      payments: [
        {
          paidAt: new Date("2026-08-20T13:00:00Z"),
          amountPaidMinor: 9900,
          currency: "USD",
          billingReason: "subscription_create",
        },
        {
          paidAt: new Date("2026-08-20T17:00:00Z"),
          amountPaidMinor: 1200,
          currency: "cad",
          billingReason: "subscription_cycle",
        },
        {
          paidAt: new Date("2026-08-21T03:30:00Z"),
          amountPaidMinor: 9900,
          currency: "usd",
          billingReason: "subscription_cycle",
        },
        {
          paidAt: new Date("2026-08-21T15:00:00Z"),
          amountPaidMinor: 0,
          currency: "usd",
          billingReason: "subscription_create",
        },
      ],
    });

    expect(result.totalCount).toBe(3);
    expect(result.totalNewSubscriptions).toBe(1);
    expect(result.totalByCurrency).toEqual({ usd: 19_800, cad: 1_200 });
    expect(result.items[0]).toEqual({
      date: "2026-08-21",
      count: 0,
      newSubscriptionCount: 0,
      amountByCurrency: {},
    });
    expect(result.items[1]).toEqual({
      date: "2026-08-20",
      count: 3,
      newSubscriptionCount: 1,
      amountByCurrency: { usd: 19_800, cad: 1_200 },
    });
  });
});
