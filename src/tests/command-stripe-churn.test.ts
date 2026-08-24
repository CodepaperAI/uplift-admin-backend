import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { aggregateStripeMonthlyMovement } from "../command/stripe-churn";

const period = {
  start: new Date("2026-08-01T04:00:00.000Z"),
  end: new Date("2026-09-01T04:00:00.000Z"),
};

function fact(input: {
  subscription: string;
  customer: string;
  status: string;
  amount?: string;
  at: string;
  paused?: boolean;
}) {
  return {
    stripeSubscriptionId: input.subscription,
    stripeCustomerId: input.customer,
    status: input.status,
    pauseCollectionBehavior: input.paused ? "keep_as_draft" : null,
    monthlyRecurringMinor: new Prisma.Decimal(input.amount ?? "9900"),
    currency: "cad",
    occurredAt: new Date(input.at),
  };
}

describe("Stripe monthly movement", () => {
  test("uses opening MRR and cancellation facts for revenue churn", () => {
    const result = aggregateStripeMonthlyMovement(
      [
        fact({ subscription: "sub-1", customer: "cus-1", status: "active", at: "2026-07-10T12:00:00Z" }),
        fact({ subscription: "sub-1", customer: "cus-1", status: "canceled", at: "2026-08-20T12:00:00Z" }),
        fact({ subscription: "sub-2", customer: "cus-2", status: "active", at: "2026-07-11T12:00:00Z" }),
      ],
      period,
    );
    expect(result.openingMrrMinorByCurrency.cad).toBe("19800.0000");
    expect(result.churnedMrrMinorByCurrency.cad).toBe("9900.0000");
    expect(result.revenueChurnPercentByCurrency.cad).toBe("50.00");
    expect(result.logoChurnPercent).toBe("50.00");
  });

  test("does not label a pause as churn", () => {
    const result = aggregateStripeMonthlyMovement(
      [
        fact({ subscription: "sub-1", customer: "cus-1", status: "active", at: "2026-07-10T12:00:00Z" }),
        fact({ subscription: "sub-1", customer: "cus-1", status: "active", paused: true, at: "2026-08-20T12:00:00Z" }),
      ],
      period,
    );
    expect(result.churnedMrrMinorByCurrency).toEqual({});
    expect(result.churnedAccounts).toBe(0);
  });

  test("counts only subscriptions first seen in the month as new MRR", () => {
    const result = aggregateStripeMonthlyMovement(
      [
        fact({ subscription: "sub-new", customer: "cus-new", status: "trialing", amount: "14900", at: "2026-08-12T16:00:00Z" }),
        fact({ subscription: "sub-old", customer: "cus-old", status: "active", at: "2026-07-01T16:00:00Z" }),
      ],
      period,
    );
    expect(result.newMrrMinorByCurrency.cad).toBe("14900.0000");
  });
});
