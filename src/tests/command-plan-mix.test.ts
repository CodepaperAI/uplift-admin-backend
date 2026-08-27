import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  buildPlanMix,
  classify,
  findUpgradesFromSpans,
  hasSocial,
  type PlanMixEvent,
  type PlanMixSnapshot,
} from "../command/plan-mix";
import {
  RECONCILIATION_EVENT_TYPE,
  SUBSCRIPTION_CREATED_EVENT,
} from "../command/stripe-lifecycle";

const CORE = "price_core_monthly";
const CORE_YEAR = "price_core_annual";
const SOCIAL = "price_social_monthly";
const SOCIAL_YEAR = "price_social_annual";
const SOCIAL_IDS = new Set([SOCIAL, SOCIAL_YEAR]);

function snap(input: Partial<PlanMixSnapshot> & { id: string }): PlanMixSnapshot {
  return {
    stripeSubscriptionId: input.id,
    stripeCustomerId: input.stripeCustomerId ?? `cus_${input.id}`,
    status: input.status ?? "active",
    stripePriceIds: input.stripePriceIds ?? [CORE],
    monthlyRecurringMinor: input.monthlyRecurringMinor ?? new Prisma.Decimal("9900"),
    currency: input.currency ?? "usd",
  };
}

function ev(input: {
  id: string;
  type: string;
  at: string;
  prices: string[];
  customer?: string;
}): PlanMixEvent {
  return {
    stripeSubscriptionId: input.id,
    stripeCustomerId: input.customer ?? `cus_${input.id}`,
    eventType: input.type,
    stripePriceIds: input.prices,
    occurredAt: new Date(input.at),
  };
}

describe("classification", () => {
  test("a subscription carrying any social price is social", () => {
    expect(hasSocial([CORE], SOCIAL_IDS)).toBe(false);
    expect(hasSocial([SOCIAL], SOCIAL_IDS)).toBe(true);
    // An add-on sits alongside the core price rather than replacing it.
    expect(hasSocial([CORE, SOCIAL], SOCIAL_IDS)).toBe(true);
    expect(classify([CORE, SOCIAL], SOCIAL_IDS)).toBe("social");
    expect(classify([CORE_YEAR], SOCIAL_IDS)).toBe("core");
  });

  test("no prices at all classifies as core rather than throwing", () => {
    expect(classify([], SOCIAL_IDS)).toBe("core");
  });
});

describe("buildPlanMix", () => {
  const RANGE = { from: "2026-08-01", to: "2026-08-31" };

  test("splits the live base into core and social", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [],
      snapshots: [
        snap({ id: "a" }),
        snap({ id: "b" }),
        snap({ id: "c", stripePriceIds: [SOCIAL], monthlyRecurringMinor: new Prisma.Decimal("14900") }),
      ],
      events: [],
    });
    expect(mix.core.subscriptions).toBe(2);
    expect(mix.social.subscriptions).toBe(1);
    expect(mix.core.mrrMinorByCurrency).toEqual({ usd: "19800.0000" });
    expect(mix.social.mrrMinorByCurrency).toEqual({ usd: "14900.0000" });
  });

  test("counts customers distinctly from subscriptions", () => {
    // One account billing for two businesses is one customer, two subs.
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [],
      snapshots: [
        snap({ id: "a", stripeCustomerId: "cus_shared" }),
        snap({ id: "b", stripeCustomerId: "cus_shared" }),
      ],
      events: [],
    });
    expect(mix.core.subscriptions).toBe(2);
    expect(mix.core.customers).toBe(1);
  });

  test("separates upgrades inside the range from all time", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [
        { stripeSubscriptionId: "old_core", stripeCustomerId: "cus_old", stripePriceIds: [CORE], startedAt: new Date("2026-01-01T12:00:00.000Z") },
        { stripeSubscriptionId: "old", stripeCustomerId: "cus_old", stripePriceIds: [SOCIAL], startedAt: new Date("2026-03-05T12:00:00.000Z") },
        { stripeSubscriptionId: "new_core", stripeCustomerId: "cus_new", stripePriceIds: [CORE], startedAt: new Date("2026-02-01T12:00:00.000Z") },
        { stripeSubscriptionId: "new", stripeCustomerId: "cus_new", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-14T12:00:00.000Z") },
      ],
      snapshots: [
        snap({ id: "old", stripePriceIds: [SOCIAL] }),
        snap({ id: "new", stripePriceIds: [SOCIAL] }),
      ],
      events: [
        ev({ id: "old", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-01-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "old", type: "customer.subscription.updated", at: "2026-03-05T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "new", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-02-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "new", type: "customer.subscription.updated", at: "2026-08-14T12:00:00.000Z", prices: [SOCIAL] }),
      ],
    });
    expect(mix.upgrades.allTime).toBe(2);
    expect(mix.upgrades.inRange).toBe(1);
    expect(mix.upgrades.recent[0]?.stripeSubscriptionId).toBe("new");
  });

  test("says how many on social got there by upgrading", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [
        { stripeSubscriptionId: "prior_core", stripeCustomerId: "cus_upgraded", stripePriceIds: [CORE], startedAt: new Date("2026-06-01T12:00:00.000Z") },
        { stripeSubscriptionId: "upgraded", stripeCustomerId: "cus_upgraded", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-05T12:00:00.000Z") },
        { stripeSubscriptionId: "bornsocial", stripeCustomerId: "cus_bornsocial", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-06T12:00:00.000Z") },
      ],
      snapshots: [
        snap({ id: "upgraded", stripePriceIds: [SOCIAL] }),
        snap({ id: "bornsocial", stripePriceIds: [SOCIAL] }),
      ],
      events: [
        ev({ id: "upgraded", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "upgraded", type: "customer.subscription.updated", at: "2026-08-05T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "bornsocial", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-06T12:00:00.000Z", prices: [SOCIAL] }),
      ],
    });
    expect(mix.social.subscriptions).toBe(2);
    expect(mix.social.arrivedByUpgrade).toBe(1);
    expect(mix.social.arrivedOtherwise).toBe(1);
  });

  test("newest upgrade leads the recent list", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [
        { stripeSubscriptionId: "x_core", stripeCustomerId: "cus_x", stripePriceIds: [CORE], startedAt: new Date("2026-07-01T12:00:00.000Z") },
        { stripeSubscriptionId: "x", stripeCustomerId: "cus_x", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-03T12:00:00.000Z") },
        { stripeSubscriptionId: "y_core", stripeCustomerId: "cus_y", stripePriceIds: [CORE], startedAt: new Date("2026-07-01T12:00:00.000Z") },
        { stripeSubscriptionId: "y", stripeCustomerId: "cus_y", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-19T12:00:00.000Z") },
      ],
      snapshots: [],
      events: [
        ev({ id: "x", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-07-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "x", type: "customer.subscription.updated", at: "2026-08-03T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "y", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-07-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "y", type: "customer.subscription.updated", at: "2026-08-19T12:00:00.000Z", prices: [SOCIAL] }),
      ],
    });
    expect(mix.upgrades.recent.map((u) => u.stripeSubscriptionId)).toEqual(["y", "x"]);
  });

  test("reports how much of the base the log cannot speak for", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
      spans: [],
      snapshots: [snap({ id: "seen" }), snap({ id: "unseen" })],
      events: [
        ev({ id: "seen", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "unseen", type: RECONCILIATION_EVENT_TYPE, at: "2026-08-24T12:00:00.000Z", prices: [CORE] }),
      ],
    });
    expect(mix.coverage.liveSubscriptions).toBe(2);
    expect(mix.coverage.subscriptionsWithoutRealEvents).toBe(1);
  });

  test("survives an empty world", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: new Set<string>(),
      spans: [],
      snapshots: [],
      events: [],
    });
    expect(mix.core.subscriptions).toBe(0);
    expect(mix.social.subscriptions).toBe(0);
    expect(mix.upgrades.inRange).toBe(0);
    expect(mix.core.mrrMinorByCurrency).toEqual({});
  });
});

describe("findUpgradesFromSpans", () => {
  const span = (
    id: string,
    customer: string | null,
    prices: string[],
    startedAt: string | null,
  ) => ({
    stripeSubscriptionId: id,
    stripeCustomerId: customer,
    stripePriceIds: prices,
    startedAt: startedAt ? new Date(startedAt) : null,
  });

  test("an earlier core and a later social is an upgrade", () => {
    const found = findUpgradesFromSpans(
      [
        span("core", "cus_1", [CORE], "2026-03-01T12:00:00.000Z"),
        span("social", "cus_1", [SOCIAL], "2026-08-14T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.addedOn).toBe("2026-08-14");
    expect(found[0]?.stripeSubscriptionId).toBe("social");
  });

  test("counts a cancelled core plan, since dropping it and taking social is still moving up", () => {
    // The core subscription no longer exists; the upgrade still happened.
    const found = findUpgradesFromSpans(
      [
        span("dead_core", "cus_2", [CORE], "2026-03-01T12:00:00.000Z"),
        span("live_social", "cus_2", [SOCIAL], "2026-08-01T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toHaveLength(1);
  });

  test("a customer whose social plan is their oldest did not upgrade", () => {
    const found = findUpgradesFromSpans(
      [
        span("social", "cus_3", [SOCIAL], "2026-02-01T12:00:00.000Z"),
        span("core", "cus_3", [CORE], "2026-06-01T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toEqual([]);
  });

  test("core and social opened in the same instant is one purchase, not an upgrade", () => {
    const found = findUpgradesFromSpans(
      [
        span("core", "cus_4", [CORE], "2026-06-01T12:00:00.000Z"),
        span("social", "cus_4", [SOCIAL], "2026-06-01T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toEqual([]);
  });

  test("undated subscriptions are skipped rather than assumed", () => {
    const found = findUpgradesFromSpans(
      [
        span("core", "cus_5", [CORE], null),
        span("social", "cus_5", [SOCIAL], "2026-08-01T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toEqual([]);
  });

  test("a customer with only core, or only social, is not an upgrade", () => {
    expect(
      findUpgradesFromSpans(
        [span("a", "cus_6", [CORE], "2026-01-01T12:00:00.000Z")],
        SOCIAL_IDS,
      ),
    ).toEqual([]);
    expect(
      findUpgradesFromSpans(
        [span("b", "cus_7", [SOCIAL], "2026-01-01T12:00:00.000Z")],
        SOCIAL_IDS,
      ),
    ).toEqual([]);
  });

  test("takes the earliest social plan when a customer has several", () => {
    const found = findUpgradesFromSpans(
      [
        span("core", "cus_8", [CORE], "2026-01-01T12:00:00.000Z"),
        span("social_late", "cus_8", [SOCIAL], "2026-08-20T12:00:00.000Z"),
        span("social_first", "cus_8", [SOCIAL], "2026-05-05T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.stripeSubscriptionId).toBe("social_first");
  });

  test("subscriptions with no customer cannot be attributed", () => {
    expect(
      findUpgradesFromSpans(
        [
          span("core", null, [CORE], "2026-01-01T12:00:00.000Z"),
          span("social", null, [SOCIAL], "2026-08-01T12:00:00.000Z"),
        ],
        SOCIAL_IDS,
      ),
    ).toEqual([]);
  });

  test("newest upgrade leads", () => {
    const found = findUpgradesFromSpans(
      [
        span("c1", "cus_a", [CORE], "2026-01-01T12:00:00.000Z"),
        span("s1", "cus_a", [SOCIAL], "2026-05-01T12:00:00.000Z"),
        span("c2", "cus_b", [CORE], "2026-01-01T12:00:00.000Z"),
        span("s2", "cus_b", [SOCIAL], "2026-08-01T12:00:00.000Z"),
      ],
      SOCIAL_IDS,
    );
    expect(found.map((u) => u.stripeSubscriptionId)).toEqual(["s2", "s1"]);
  });
});

describe("upgrade coverage is reported against the source it uses", () => {
  test("counts undated spans and customers holding both plans", () => {
    const mix = buildPlanMix({
      from: "2026-08-01",
      to: "2026-08-31",
      socialPriceIds: SOCIAL_IDS,
      snapshots: [],
      events: [],
      spans: [
        { stripeSubscriptionId: "a", stripeCustomerId: "cus_both", stripePriceIds: [CORE], startedAt: new Date("2026-01-01T00:00:00.000Z") },
        { stripeSubscriptionId: "b", stripeCustomerId: "cus_both", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-10T00:00:00.000Z") },
        { stripeSubscriptionId: "c", stripeCustomerId: "cus_core", stripePriceIds: [CORE], startedAt: null },
      ],
    });
    expect(mix.coverage.spansConsidered).toBe(3);
    expect(mix.coverage.spansWithoutStartDate).toBe(1);
    // The number that decides whether an upgrade is even possible to find.
    expect(mix.coverage.customersOnBoth).toBe(1);
    expect(mix.upgrades.inRange).toBe(1);
  });

  test("zero customers on both plans means zero upgrades is a real answer", () => {
    // Not a coverage failure: nobody ever held both, so nobody moved up.
    const mix = buildPlanMix({
      from: "2026-08-01",
      to: "2026-08-31",
      socialPriceIds: SOCIAL_IDS,
      snapshots: [],
      events: [],
      spans: [
        { stripeSubscriptionId: "a", stripeCustomerId: "cus_1", stripePriceIds: [CORE], startedAt: new Date("2026-01-01T00:00:00.000Z") },
        { stripeSubscriptionId: "b", stripeCustomerId: "cus_2", stripePriceIds: [SOCIAL], startedAt: new Date("2026-08-10T00:00:00.000Z") },
      ],
    });
    expect(mix.coverage.customersOnBoth).toBe(0);
    expect(mix.coverage.spansWithoutStartDate).toBe(0);
    expect(mix.upgrades.allTime).toBe(0);
  });
});
