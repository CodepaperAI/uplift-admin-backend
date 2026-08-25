import { Prisma } from "@prisma/client";
import { carriesRealOccurrenceTime } from "./stripe-lifecycle";
import { commandDayForDate } from "./toronto-period";

/**
 * Who is on the core plan, who added social, and who upgraded to it recently.
 *
 * The admin's plan chart was built from the billing endpoint's configured
 * prices, which only ever knew the two core prices. Every SEO + Social
 * subscription therefore fell into "not on a listed plan — no backend entry",
 * so the entire social product read as a data gap rather than as a product.
 * Classification here comes from the Stripe product name instead, which is the
 * same source the Command plan table already reads correctly.
 *
 * The upgrade question is a different shape. "Did this customer add social"
 * cannot be answered from current state — a subscription on the social price
 * looks identical whether it started there or moved there last week. It is a
 * transition, so it comes from the event log, and the same rule applies as
 * everywhere else in this codebase: reconciliation snapshots carry the sync
 * clock, so only real Stripe events can date a change.
 */

export type PlanClass = "core" | "social";

export type PlanMixSnapshot = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  status: string;
  stripePriceIds: string[];
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
};

export type PlanMixEvent = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  eventType: string;
  stripePriceIds: string[];
  occurredAt: Date;
};

export function hasSocial(
  priceIds: readonly string[],
  socialPriceIds: ReadonlySet<string>,
): boolean {
  return priceIds.some((priceId) => socialPriceIds.has(priceId));
}

export function classify(
  priceIds: readonly string[],
  socialPriceIds: ReadonlySet<string>,
): PlanClass {
  return hasSocial(priceIds, socialPriceIds) ? "social" : "core";
}

function serialize(buckets: Map<string, Prisma.Decimal>): Record<string, string> {
  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => [currency, amount.toFixed(4)]),
  );
}

export type SocialUpgrade = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  /** Toronto day the social price first appeared on the subscription. */
  addedOn: string;
  addedAt: string;
};

/**
 * The moment a customer first appeared on social, when they did not start there.
 *
 * Takes every event belonging to one customer, across all of their
 * subscriptions, because the move is not necessarily a price change on a single
 * subscription — ending one and starting another is the same upgrade to
 * everyone except a query that follows subscription ids. Production does it
 * that way, which is why the subscription-level version of this reported zero
 * upgrades against a base that plainly had them.
 *
 * Returns null when the customer's earliest datable event is already social:
 * that is a new customer buying the bigger plan, not an existing one moving up,
 * and the two are worth different amounts of attention.
 */
export function findSocialUpgrade(
  events: readonly PlanMixEvent[],
  socialPriceIds: ReadonlySet<string>,
): SocialUpgrade | null {
  const real = events
    .filter((event) => carriesRealOccurrenceTime(event.eventType))
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

  const first = real.at(0);
  if (!first) return null;
  // Already on social the first time the log can see them: either they bought
  // it outright or they moved before the log begins. Not claimed as an upgrade.
  if (hasSocial(first.stripePriceIds, socialPriceIds)) return null;

  const arrival = real.find((event) =>
    hasSocial(event.stripePriceIds, socialPriceIds),
  );
  if (!arrival) return null;

  return {
    stripeSubscriptionId: arrival.stripeSubscriptionId,
    stripeCustomerId: arrival.stripeCustomerId,
    addedOn: commandDayForDate(arrival.occurredAt),
    addedAt: arrival.occurredAt.toISOString(),
  };
}

export function buildPlanMix(input: {
  snapshots: readonly PlanMixSnapshot[];
  /** Every event for the subscriptions above, both kinds. Filtered here. */
  events: readonly PlanMixEvent[];
  socialPriceIds: ReadonlySet<string>;
  from: string;
  to: string;
}) {
  const { socialPriceIds } = input;

  const counts: Record<PlanClass, { subscriptions: number; customers: Set<string> }> = {
    core: { subscriptions: 0, customers: new Set() },
    social: { subscriptions: 0, customers: new Set() },
  };
  const mrr: Record<PlanClass, Map<string, Prisma.Decimal>> = {
    core: new Map(),
    social: new Map(),
  };

  for (const snapshot of input.snapshots) {
    const bucket = classify(snapshot.stripePriceIds, socialPriceIds);
    counts[bucket].subscriptions += 1;
    if (snapshot.stripeCustomerId) {
      counts[bucket].customers.add(snapshot.stripeCustomerId);
    }
    if (snapshot.currency) {
      mrr[bucket].set(
        snapshot.currency,
        (mrr[bucket].get(snapshot.currency) ?? new Prisma.Decimal(0)).add(
          snapshot.monthlyRecurringMinor,
        ),
      );
    }
  }

  // Grouped by customer, because that is the unit an upgrade happens to.
  const byCustomer = new Map<string, PlanMixEvent[]>();
  const bySubscription = new Map<string, PlanMixEvent[]>();
  for (const event of input.events) {
    const subs = bySubscription.get(event.stripeSubscriptionId) ?? [];
    subs.push(event);
    bySubscription.set(event.stripeSubscriptionId, subs);
    if (!event.stripeCustomerId) continue;
    const list = byCustomer.get(event.stripeCustomerId) ?? [];
    list.push(event);
    byCustomer.set(event.stripeCustomerId, list);
  }

  const allUpgrades: SocialUpgrade[] = [];
  for (const events of byCustomer.values()) {
    const upgrade = findSocialUpgrade(events, socialPriceIds);
    if (upgrade) allUpgrades.push(upgrade);
  }
  allUpgrades.sort((left, right) => right.addedAt.localeCompare(left.addedAt));

  const inRange = allUpgrades.filter(
    (upgrade) => upgrade.addedOn >= input.from && upgrade.addedOn <= input.to,
  );

  const live = input.snapshots.length;
  const socialSubs = counts.social.subscriptions;
  // Of everyone on social now, how many got there by upgrading — the rest
  // either started on it or moved before the log could date it.
  const upgradedCustomers = new Set(
    allUpgrades.flatMap((upgrade) =>
      upgrade.stripeCustomerId ? [upgrade.stripeCustomerId] : [],
    ),
  );
  const socialByUpgrade = [...counts.social.customers].filter((customerId) =>
    upgradedCustomers.has(customerId),
  ).length;

  return {
    core: {
      subscriptions: counts.core.subscriptions,
      customers: counts.core.customers.size,
      mrrMinorByCurrency: serialize(mrr.core),
    },
    social: {
      subscriptions: socialSubs,
      customers: counts.social.customers.size,
      mrrMinorByCurrency: serialize(mrr.social),
      /** Customers on social now who demonstrably moved there from core. */
      arrivedByUpgrade: socialByUpgrade,
      /** Customers on social with no datable move: bought it, or moved early. */
      arrivedOtherwise: Math.max(
        0,
        counts.social.customers.size - socialByUpgrade,
      ),
    },
    upgrades: {
      inRange: inRange.length,
      allTime: allUpgrades.length,
      recent: inRange,
    },
    coverage: {
      liveSubscriptions: live,
      /** Subscriptions the log holds no believable event for. */
      subscriptionsWithoutRealEvents: input.snapshots.filter((snapshot) => {
        const events = bySubscription.get(snapshot.stripeSubscriptionId) ?? [];
        return !events.some((event) => carriesRealOccurrenceTime(event.eventType));
      }).length,
      socialPriceIdCount: socialPriceIds.size,
    },
  };
}
