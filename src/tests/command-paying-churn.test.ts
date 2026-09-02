import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  buildCohorts,
  buildCustomerPaymentHistories,
  monthsBetween,
  summariseChurn,
  type PayingInvoiceFact,
  type SubscriptionStateFact,
} from "../command/paying-churn";

const dec = (v: string | number) => new Prisma.Decimal(v);

function invoice(
  customer: string,
  paidAt: string,
  amount: string,
  subscription = "sub_1",
): PayingInvoiceFact {
  return {
    stripeCustomerId: customer,
    stripeSubscriptionId: subscription,
    amountPaidMinor: dec(amount),
    paidAt: new Date(paidAt),
    currency: "usd",
  };
}

function subscription(
  id: string,
  customer: string,
  status: string,
  monthly = "9900",
): SubscriptionStateFact {
  return {
    stripeSubscriptionId: id,
    stripeCustomerId: customer,
    status,
    monthlyRecurringMinor: dec(monthly),
    currency: "usd",
  };
}

describe("buildCustomerPaymentHistories", () => {
  test("keys on the customer, so re-subscribing is not a churn plus an arrival", () => {
    // A customer who cancelled one plan and bought another has not churned.
    const histories = buildCustomerPaymentHistories({
      invoices: [
        invoice("cus_1", "2026-03-10T12:00:00Z", "9900", "sub_old"),
        invoice("cus_1", "2026-06-10T12:00:00Z", "14900", "sub_new"),
      ],
      subscriptions: [
        subscription("sub_old", "cus_1", "canceled"),
        subscription("sub_new", "cus_1", "active", "14900"),
      ],
    });
    expect(histories).toHaveLength(1);
    expect(histories[0]?.state).toBe("paying");
    expect(histories[0]?.firstPaidMonth).toBe("2026-03");
  });

  test("dates the cohort from the first settled invoice", () => {
    const histories = buildCustomerPaymentHistories({
      invoices: [
        invoice("cus_1", "2026-05-20T12:00:00Z", "9900"),
        invoice("cus_1", "2026-04-02T12:00:00Z", "9900"),
      ],
      subscriptions: [subscription("sub_1", "cus_1", "active")],
    });
    expect(histories[0]?.firstPaidMonth).toBe("2026-04");
    expect(histories[0]?.paidInvoiceCount).toBe(2);
  });

  test("ignores unpaid and zero invoices", () => {
    // An issued invoice is not a payment, and a nil one is not either.
    const histories = buildCustomerPaymentHistories({
      invoices: [
        { ...invoice("cus_1", "2026-04-01T12:00:00Z", "9900"), paidAt: null },
        invoice("cus_1", "2026-05-01T12:00:00Z", "0"),
        invoice("cus_1", "2026-06-01T12:00:00Z", "9900"),
      ],
      subscriptions: [subscription("sub_1", "cus_1", "active")],
    });
    expect(histories[0]?.firstPaidMonth).toBe("2026-06");
    expect(histories[0]?.paidInvoiceCount).toBe(1);
  });

  test("a trial charge that lapsed is a payer but not a full-price payer", () => {
    // The distinction lifetime value turns on: this customer churned, and was
    // never worth ARPU. Counting them in the full-price curve would drag it down.
    const histories = buildCustomerPaymentHistories({
      invoices: [invoice("cus_1", "2026-04-01T12:00:00Z", "300")],
      subscriptions: [subscription("sub_1", "cus_1", "canceled", "9900")],
    });
    expect(histories[0]?.state).toBe("churned");
    expect(histories[0]?.reachedFullPrice).toBe(false);
  });

  test("a payment reaching half the plan price counts as full price", () => {
    const histories = buildCustomerPaymentHistories({
      invoices: [invoice("cus_1", "2026-04-01T12:00:00Z", "5000")],
      subscriptions: [subscription("sub_1", "cus_1", "active", "9900")],
    });
    expect(histories[0]?.reachedFullPrice).toBe(true);
  });

  test("falls back to renewals when there is no live plan to compare against", () => {
    // No subscription left means no plan price. Paying twice is something a
    // lapsed trial never does.
    const twice = buildCustomerPaymentHistories({
      invoices: [
        invoice("cus_1", "2026-04-01T12:00:00Z", "9900"),
        invoice("cus_1", "2026-05-01T12:00:00Z", "9900"),
      ],
      subscriptions: [],
    });
    expect(twice[0]?.reachedFullPrice).toBe(true);
    const once = buildCustomerPaymentHistories({
      invoices: [invoice("cus_2", "2026-04-01T12:00:00Z", "300")],
      subscriptions: [],
    });
    expect(once[0]?.reachedFullPrice).toBe(false);
  });

  test("a failing card is at risk, not churned and not paying", () => {
    const histories = buildCustomerPaymentHistories({
      invoices: [invoice("cus_1", "2026-04-01T12:00:00Z", "9900")],
      subscriptions: [subscription("sub_1", "cus_1", "past_due")],
    });
    expect(histories[0]?.state).toBe("at_risk");
  });

  test("an active subscription outranks a cancelled one on the same customer", () => {
    const histories = buildCustomerPaymentHistories({
      invoices: [invoice("cus_1", "2026-04-01T12:00:00Z", "9900")],
      subscriptions: [
        subscription("sub_a", "cus_1", "canceled"),
        subscription("sub_b", "cus_1", "active"),
      ],
    });
    expect(histories[0]?.state).toBe("paying");
  });
});

describe("monthsBetween", () => {
  test("counts whole months across a year boundary", () => {
    expect(monthsBetween("2025-11", "2026-02")).toBe(3);
    expect(monthsBetween("2026-09", "2026-09")).toBe(0);
  });
});

describe("buildCohorts", () => {
  test("groups by first paying month and ages each cohort", () => {
    const histories = buildCustomerPaymentHistories({
      invoices: [
        invoice("cus_1", "2026-03-10T12:00:00Z", "9900", "s1"),
        invoice("cus_2", "2026-03-12T12:00:00Z", "9900", "s2"),
        invoice("cus_3", "2026-07-01T12:00:00Z", "9900", "s3"),
      ],
      subscriptions: [
        subscription("s1", "cus_1", "active"),
        subscription("s2", "cus_2", "canceled"),
        subscription("s3", "cus_3", "active"),
      ],
    });
    const cohorts = buildCohorts({ histories, currentMonth: "2026-09" });
    expect(cohorts).toHaveLength(2);
    expect(cohorts[0]).toMatchObject({
      month: "2026-03",
      ageMonths: 6,
      customers: 2,
      paying: 1,
      churned: 1,
      retentionPercent: "50.00",
    });
    expect(cohorts[1]?.ageMonths).toBe(2);
  });
});

describe("summariseChurn", () => {
  test("sums survival across ages for a measured lower bound on lifetime", () => {
    const cohorts = [
      { month: "2026-07", ageMonths: 2, customers: 10, paying: 8, atRisk: 0, churned: 2, retentionPercent: "80.00" },
      { month: "2026-08", ageMonths: 1, customers: 10, paying: 9, atRisk: 0, churned: 1, retentionPercent: "90.00" },
    ];
    const histories = Array.from({ length: 20 }, (_, index) => ({
      state: index < 17 ? ("paying" as const) : ("churned" as const),
    })) as never;
    const summary = summariseChurn({ histories, cohorts });
    // Age 0 counts as a whole month, then 0.9 at age 1 and 0.8 at age 2.
    expect(summary.observedLifetimeMonths).toBe("2.7");
    expect(summary.oldestCohortAgeMonths).toBe(2);
  });

  test("weights the monthly rate by cohort size, not by age", () => {
    // The bug this exists for: taking the oldest cohort alone let three
    // customers set the rate that lifetime value divides by.
    const summary = summariseChurn({
      histories: Array.from({ length: 103 }, () => ({ state: "paying" as const })) as never,
      cohorts: [
        { month: "2026-03", ageMonths: 6, customers: 3, paying: 2, atRisk: 0, churned: 1, retentionPercent: "66.67" },
        { month: "2026-08", ageMonths: 1, customers: 100, paying: 94, atRisk: 0, churned: 6, retentionPercent: "94.00" },
      ],
    });
    // The hundred-customer cohort at 6% must dominate the three-customer one.
    expect(Number(summary.impliedMonthlyChurnPercent)).toBeCloseTo(6.1, 0);
    expect(Number(summary.impliedLifetimeMonths)).toBeGreaterThan(10);
  });

  test("ignores age-nought cohorts, which have had no month in which to churn", () => {
    const summary = summariseChurn({
      histories: Array.from({ length: 60 }, () => ({ state: "paying" as const })) as never,
      cohorts: [
        { month: "2026-09", ageMonths: 0, customers: 50, paying: 50, atRisk: 0, churned: 0, retentionPercent: "100.00" },
        { month: "2026-08", ageMonths: 1, customers: 10, paying: 8, atRisk: 0, churned: 2, retentionPercent: "80.00" },
      ],
    });
    // Including the newest group would report 20% churn as roughly 3%.
    expect(Number(summary.impliedMonthlyChurnPercent)).toBeCloseTo(20, 0);
  });

  test("treats a cohort with nobody left as total loss over its age", () => {
    const summary = summariseChurn({
      histories: Array.from({ length: 5 }, () => ({ state: "churned" as const })) as never,
      cohorts: [
        { month: "2026-06", ageMonths: 3, customers: 5, paying: 0, atRisk: 0, churned: 5, retentionPercent: "0.00" },
      ],
    });
    expect(summary.impliedMonthlyChurnPercent).toBe("100.0000");
  });

  test("compounds a single cohort's survival into a monthly rate", () => {
    const cohorts = [
      { month: "2026-03", ageMonths: 6, customers: 100, paying: 50, atRisk: 0, churned: 50, retentionPercent: "50.00" },
    ];
    const summary = summariseChurn({
      histories: Array.from({ length: 100 }, (_, i) => ({
        state: i < 50 ? ("paying" as const) : ("churned" as const),
      })) as never,
      cohorts,
    });
    // Half gone over six months compounds to about 10.9% a month.
    expect(Number(summary.impliedMonthlyChurnPercent)).toBeCloseTo(10.9, 1);
  });

  test("reports nothing rather than dividing by an empty book", () => {
    const summary = summariseChurn({ histories: [], cohorts: [] });
    expect(summary.observedLifetimeMonths).toBeNull();
    expect(summary.impliedMonthlyChurnPercent).toBeNull();
    expect(summary.payingCustomersEver).toBe(0);
  });

  test("does not claim a lifetime longer than it has observed", () => {
    // A business with one month of history cannot measure a two-month life.
    const cohorts = [
      { month: "2026-09", ageMonths: 0, customers: 5, paying: 5, atRisk: 0, churned: 0, retentionPercent: "100.00" },
    ];
    const summary = summariseChurn({
      histories: Array.from({ length: 5 }, () => ({ state: "paying" as const })) as never,
      cohorts,
    });
    expect(summary.observedLifetimeMonths).toBe("1.0");
    expect(summary.oldestCohortAgeMonths).toBe(0);
  });
});
