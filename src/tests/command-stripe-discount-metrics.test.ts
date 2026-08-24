import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  projectUpliftSubscriptionPlanBilling,
  type ResolvedStripeDiscount,
} from "../command/stripe-discount-metrics";

function subscription(input: {
  amount: number;
  interval?: "month" | "year";
  priceId?: string;
  productId?: string;
  discountIds?: string[];
}): Stripe.Subscription {
  const discountIds = input.discountIds ?? [];
  return {
    id: "sub_test",
    discounts: discountIds,
    items: {
      data: [
        {
          id: "si_test",
          discounts: [],
          quantity: 1,
          price: {
            id: input.priceId ?? "price_uplift",
            currency: "usd",
            product: input.productId ?? "prod_uplift",
            unit_amount: input.amount,
            unit_amount_decimal: String(input.amount),
            recurring: {
              interval: input.interval ?? "month",
              interval_count: 1,
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function discount(
  overrides: Partial<ResolvedStripeDiscount> = {},
): ResolvedStripeDiscount {
  return {
    id: "di_test",
    label: "WELCOME20",
    percentOff: 20,
    amountOffMinor: null,
    amountOffCurrency: null,
    amountOffByCurrency: {},
    appliesToProductIds: [],
    duration: "forever",
    durationInMonths: null,
    ...overrides,
  };
}

describe("Uplift Stripe discount metrics", () => {
  test("shows list, discount, and net monthly revenue for a percent coupon", () => {
    const applied = discount();
    const [result] = projectUpliftSubscriptionPlanBilling({
      subscription: subscription({ amount: 9_900, discountIds: [applied.id] }),
      upliftPriceIds: new Set(["price_uplift"]),
      discountsById: new Map([[applied.id, applied]]),
    });

    expect(result?.grossMonthlyMinor.toFixed(2)).toBe("9900.00");
    expect(result?.discountMonthlyMinor.toFixed(2)).toBe("1980.00");
    expect(result?.netMonthlyMinor.toFixed(2)).toBe("7920.00");
    expect(result?.discounts.map((entry) => entry.label)).toEqual([
      "WELCOME20",
    ]);
  });

  test("normalizes an annual fixed coupon to monthly revenue", () => {
    const applied = discount({
      label: "SAVE120",
      percentOff: null,
      amountOffMinor: 12_000,
      amountOffCurrency: "usd",
    });
    const [result] = projectUpliftSubscriptionPlanBilling({
      subscription: subscription({
        amount: 99_000,
        interval: "year",
        discountIds: [applied.id],
      }),
      upliftPriceIds: new Set(["price_uplift"]),
      discountsById: new Map([[applied.id, applied]]),
    });

    expect(result?.grossMonthlyMinor.toFixed(2)).toBe("8250.00");
    expect(result?.discountMonthlyMinor.toFixed(2)).toBe("1000.00");
    expect(result?.netMonthlyMinor.toFixed(2)).toBe("7250.00");
  });

  test("does not apply a product-restricted coupon to another product", () => {
    const applied = discount({ appliesToProductIds: ["prod_other"] });
    const [result] = projectUpliftSubscriptionPlanBilling({
      subscription: subscription({ amount: 14_900, discountIds: [applied.id] }),
      upliftPriceIds: new Set(["price_uplift"]),
      discountsById: new Map([[applied.id, applied]]),
    });

    expect(result?.discountMonthlyMinor.toFixed(2)).toBe("0.00");
    expect(result?.netMonthlyMinor.toFixed(2)).toBe("14900.00");
    expect(result?.discounts).toEqual([]);
  });

  test("excludes unrelated Stripe products from Uplift plan revenue", () => {
    const result = projectUpliftSubscriptionPlanBilling({
      subscription: subscription({
        amount: 50_000,
        priceId: "price_agency",
        productId: "prod_agency",
      }),
      upliftPriceIds: new Set(["price_uplift"]),
      discountsById: new Map(),
    });

    expect(result).toEqual([]);
  });
});
