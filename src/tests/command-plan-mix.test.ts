import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  buildPlanMix,
  classify,
  findSocialUpgrade,
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

describe("findSocialUpgrade", () => {
  test("finds the move from core to social", () => {
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s1", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "s1", type: "customer.subscription.updated", at: "2026-08-20T15:00:00.000Z", prices: [SOCIAL] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade?.addedOn).toBe("2026-08-20");
    expect(upgrade?.stripeSubscriptionId).toBe("s1");
  });

  test("a subscription created on social is not an upgrade", () => {
    // New customer buying the bigger plan is a different event from an
    // existing customer adding to theirs, and worth different attention.
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s2", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-01T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "s2", type: "customer.subscription.updated", at: "2026-08-10T12:00:00.000Z", prices: [SOCIAL] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade).toBeNull();
  });

  test("already social on the earliest datable row is not claimed as recent", () => {
    // No created event, so the change happened before the log can see it.
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s3", type: "customer.subscription.updated", at: "2026-08-01T12:00:00.000Z", prices: [SOCIAL] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade).toBeNull();
  });

  test("reconciliation snapshots cannot date an upgrade", () => {
    // The sync ran today; that is not when the customer upgraded.
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s4", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "s4", type: RECONCILIATION_EVENT_TYPE, at: "2026-08-24T21:00:00.000Z", prices: [SOCIAL] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade).toBeNull();
  });

  test("takes the first move, not a later repeat of the same state", () => {
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s5", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-05-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "s5", type: "customer.subscription.updated", at: "2026-06-10T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "s5", type: "customer.subscription.updated", at: "2026-08-01T12:00:00.000Z", prices: [SOCIAL] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade?.addedOn).toBe("2026-06-10");
  });

  test("a downgrade then re-upgrade reports the first upgrade", () => {
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s6", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-05-01T12:00:00.000Z", prices: [CORE] }),
        ev({ id: "s6", type: "customer.subscription.updated", at: "2026-06-01T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "s6", type: "customer.subscription.updated", at: "2026-07-01T12:00:00.000Z", prices: [CORE] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade?.addedOn).toBe("2026-06-01");
  });

  test("a core-only subscription has no upgrade", () => {
    expect(
      findSocialUpgrade(
        [ev({ id: "s7", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] })],
        SOCIAL_IDS,
      ),
    ).toBeNull();
  });

  test("no events at all yields nothing", () => {
    expect(findSocialUpgrade([], SOCIAL_IDS)).toBeNull();
  });

  test("orders by time even when the log arrives shuffled", () => {
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "s8", type: "customer.subscription.updated", at: "2026-08-20T12:00:00.000Z", prices: [SOCIAL] }),
        ev({ id: "s8", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade?.addedOn).toBe("2026-08-20");
  });
});

describe("buildPlanMix", () => {
  const RANGE = { from: "2026-08-01", to: "2026-08-31" };

  test("splits the live base into core and social", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
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
    expect(mix.upgrades.recent[0].stripeSubscriptionId).toBe("new");
  });

  test("says how many on social got there by upgrading", () => {
    const mix = buildPlanMix({
      ...RANGE,
      socialPriceIds: SOCIAL_IDS,
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
      snapshots: [],
      events: [],
    });
    expect(mix.core.subscriptions).toBe(0);
    expect(mix.social.subscriptions).toBe(0);
    expect(mix.upgrades.inRange).toBe(0);
    expect(mix.core.mrrMinorByCurrency).toEqual({});
  });
});

describe("upgrades are tracked per customer, not per subscription", () => {
  const CUST = "cus_mover";

  test("an upgrade done by cancelling and resubscribing is still an upgrade", () => {
    // This is how production actually moves someone from core to social: the
    // core subscription ends and a social one begins. Following subscription
    // ids finds two unrelated events and reports zero upgrades forever.
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "sub_core", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE], customer: CUST }),
        ev({ id: "sub_core", type: "customer.subscription.deleted", at: "2026-08-12T11:00:00.000Z", prices: [CORE], customer: CUST }),
        ev({ id: "sub_social", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-12T12:00:00.000Z", prices: [SOCIAL], customer: CUST }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade).not.toBeNull();
    expect(upgrade?.addedOn).toBe("2026-08-12");
    expect(upgrade?.stripeSubscriptionId).toBe("sub_social");
  });

  test("a brand new customer starting on social is still not an upgrade", () => {
    const upgrade = findSocialUpgrade(
      [
        ev({ id: "sub_new", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-12T12:00:00.000Z", prices: [SOCIAL], customer: "cus_new" }),
      ],
      SOCIAL_IDS,
    );
    expect(upgrade).toBeNull();
  });

  test("counts the customer once even when they hold several subscriptions", () => {
    const mix = buildPlanMix({
      from: "2026-08-01",
      to: "2026-08-31",
      socialPriceIds: SOCIAL_IDS,
      snapshots: [
        snap({ id: "sub_social_a", stripeCustomerId: CUST, stripePriceIds: [SOCIAL] }),
        snap({ id: "sub_social_b", stripeCustomerId: CUST, stripePriceIds: [SOCIAL] }),
      ],
      events: [
        ev({ id: "sub_core", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE], customer: CUST }),
        ev({ id: "sub_social_a", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-12T12:00:00.000Z", prices: [SOCIAL], customer: CUST }),
        ev({ id: "sub_social_b", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-13T12:00:00.000Z", prices: [SOCIAL], customer: CUST }),
      ],
    });
    // Two subscriptions, one customer, one upgrade.
    expect(mix.social.subscriptions).toBe(2);
    expect(mix.social.customers).toBe(1);
    expect(mix.upgrades.inRange).toBe(1);
    expect(mix.social.arrivedByUpgrade).toBe(1);
    expect(mix.social.arrivedOtherwise).toBe(0);
  });

  test("events with no customer id cannot be grouped and are skipped", () => {
    const mix = buildPlanMix({
      from: "2026-08-01",
      to: "2026-08-31",
      socialPriceIds: SOCIAL_IDS,
      snapshots: [snap({ id: "s", stripePriceIds: [SOCIAL] })],
      events: [
        { ...ev({ id: "s", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-01T12:00:00.000Z", prices: [CORE] }), stripeCustomerId: null },
        { ...ev({ id: "s", type: "customer.subscription.updated", at: "2026-08-05T12:00:00.000Z", prices: [SOCIAL] }), stripeCustomerId: null },
      ],
    });
    expect(mix.upgrades.inRange).toBe(0);
  });
});
