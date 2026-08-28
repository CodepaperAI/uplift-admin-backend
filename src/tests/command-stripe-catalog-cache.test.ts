import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  deserializePlanDefinitions,
  deserializeSubscriptionBilling,
  serializeSubscriptionBilling,
  upliftPriceSetKey,
} from "../command/stripe-catalog-cache";
import type { UpliftSubscriptionPlanBilling } from "../command/stripe-discount-metrics";

function billing(
  overrides: Partial<UpliftSubscriptionPlanBilling> = {},
): UpliftSubscriptionPlanBilling {
  return {
    priceId: "price_monthly",
    currency: "cad",
    grossMonthlyMinor: new Prisma.Decimal(29900),
    netMonthlyMinor: new Prisma.Decimal(20930),
    discountMonthlyMinor: new Prisma.Decimal(8970),
    discounts: [
      {
        id: "di_1",
        label: "30% off",
        percentOff: 30,
        amountOffMinor: null,
        amountOffCurrency: null,
        amountOffByCurrency: {},
        appliesToProductIds: [],
        duration: "forever",
        durationInMonths: null,
      },
    ],
    ...overrides,
  };
}

describe("stripe catalog cache serialization", () => {
  it("returns Decimals, not the strings JSON turns them into", () => {
    const input = new Map([["sub_1", [billing()]]]);
    const roundTripped = deserializeSubscriptionBilling(
      JSON.parse(JSON.stringify(serializeSubscriptionBilling(input))),
    );
    const row = roundTripped?.get("sub_1")?.[0];
    expect(row).toBeDefined();
    // The whole reason this module exists: `typeof "29900" === "string"` would
    // pass every shape check and then break the first `.add()` downstream.
    expect(row!.grossMonthlyMinor instanceof Prisma.Decimal).toBe(true);
    expect(row!.netMonthlyMinor instanceof Prisma.Decimal).toBe(true);
    expect(row!.discountMonthlyMinor instanceof Prisma.Decimal).toBe(true);
  });

  it("preserves the exact minor amounts through a round trip", () => {
    const input = new Map([
      ["sub_1", [billing()]],
      [
        "sub_2",
        [
          billing({
            priceId: "price_annual",
            currency: "usd",
            grossMonthlyMinor: new Prisma.Decimal("104.9166"),
            netMonthlyMinor: new Prisma.Decimal("104.9166"),
            discountMonthlyMinor: new Prisma.Decimal(0),
            discounts: [],
          }),
        ],
      ],
    ]);
    const out = deserializeSubscriptionBilling(
      JSON.parse(JSON.stringify(serializeSubscriptionBilling(input))),
    );
    expect(out?.get("sub_1")?.[0]?.grossMonthlyMinor.toString()).toBe("29900");
    expect(out?.get("sub_2")?.[0]?.grossMonthlyMinor.toString()).toBe("104.9166");
    expect(out?.get("sub_2")?.[0]?.discountMonthlyMinor.toString()).toBe("0");
    expect(out?.size).toBe(2);
  });

  it("keeps discount detail intact", () => {
    const out = deserializeSubscriptionBilling(
      JSON.parse(
        JSON.stringify(serializeSubscriptionBilling(new Map([["sub_1", [billing()]]]))),
      ),
    );
    expect(out?.get("sub_1")?.[0]?.discounts[0]?.label).toBe("30% off");
    expect(out?.get("sub_1")?.[0]?.discounts[0]?.percentOff).toBe(30);
  });

  it("rejects a malformed entry instead of half-building a map", () => {
    // Every one of these would otherwise produce a Map that looks usable and
    // puts wrong money on the dashboard with no error anywhere.
    expect(deserializeSubscriptionBilling(null)).toBeNull();
    expect(deserializeSubscriptionBilling({})).toBeNull();
    expect(deserializeSubscriptionBilling({ entries: "nope" })).toBeNull();
    expect(deserializeSubscriptionBilling({ entries: [["sub_1"]] })).toBeNull();
    expect(
      deserializeSubscriptionBilling({ entries: [["sub_1", [{ priceId: 1 }]]] }),
    ).toBeNull();
    expect(
      deserializeSubscriptionBilling({
        entries: [
          [
            "sub_1",
            // A number where a serialised Decimal belongs — the shape an older
            // writer, or a hand-edited key, would leave behind.
            [{ ...billing(), grossMonthlyMinor: 29900 }],
          ],
        ],
      }),
    ).toBeNull();
  });

  it("rejects an unparseable Decimal rather than throwing out of the cache read", () => {
    expect(
      deserializeSubscriptionBilling({
        entries: [["sub_1", [{ ...billing(), grossMonthlyMinor: "not-a-number",
          netMonthlyMinor: "0", discountMonthlyMinor: "0" }]]],
      }),
    ).toBeNull();
  });
});

describe("plan definition deserialization", () => {
  it("accepts a well-formed list", () => {
    const parsed = deserializePlanDefinitions([
      {
        priceId: "price_1",
        name: "Uplift AI",
        billingPeriod: "Monthly",
        currency: "cad",
        unitAmountMinor: "29900",
      },
      {
        priceId: "price_2",
        name: "Uplift AI legacy plan",
        billingPeriod: "Recurring",
        currency: null,
        unitAmountMinor: null,
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed?.[1]?.unitAmountMinor).toBeNull();
  });

  it("rejects anything that is not that", () => {
    expect(deserializePlanDefinitions(null)).toBeNull();
    expect(deserializePlanDefinitions({})).toBeNull();
    expect(deserializePlanDefinitions([{ priceId: "price_1" }])).toBeNull();
    // A number here would format as "2990" in the UI and look plausible.
    expect(
      deserializePlanDefinitions([
        {
          priceId: "price_1",
          name: "Uplift AI",
          billingPeriod: "Monthly",
          currency: "cad",
          unitAmountMinor: 29900,
        },
      ]),
    ).toBeNull();
  });
});

describe("upliftPriceSetKey", () => {
  it("does not depend on discovery order", () => {
    expect(upliftPriceSetKey(["b", "a", "c"])).toBe(upliftPriceSetKey(["c", "a", "b"]));
  });

  it("separates different plan sets", () => {
    expect(upliftPriceSetKey(["a", "b"])).not.toBe(upliftPriceSetKey(["a"]));
  });

  it("names the empty set rather than producing an empty key", () => {
    // An empty string would collide with the key prefix and make one namespace
    // serve two different questions.
    expect(upliftPriceSetKey([])).toBe("none");
  });
});
