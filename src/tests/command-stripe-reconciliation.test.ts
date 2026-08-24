import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { projectStripeSubscription } from "../command/stripe-reconciliation.service";

describe("Command Stripe reconciliation projection", () => {
  it("normalizes yearly recurring prices into monthly minor units", () => {
    const subscription = {
      status: "active",
      pause_collection: null,
      cancel_at_period_end: false,
      items: {
        data: [
          {
            quantity: 2,
            price: {
              id: "price_yearly",
              currency: "cad",
              unit_amount_decimal: "118800",
              recurring: { interval: "year", interval_count: 1 },
            },
            current_period_start: 1_786_500_000,
            current_period_end: 1_818_036_000,
          },
        ],
      },
    } as unknown as Stripe.Subscription;

    const projected = projectStripeSubscription(subscription);

    expect(projected.monthlyRecurringMinor.toString()).toBe("19800");
    expect(projected.stripePriceIds).toEqual(["price_yearly"]);
    expect(projected.currency).toBe("cad");
  });
});
