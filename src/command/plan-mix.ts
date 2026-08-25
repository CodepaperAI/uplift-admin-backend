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
 * The upgrade question is a different shape. "Did this customer move up"
 * cannot be answered from current state — a subscription on the social price
 * looks identical whether it started there or moved there last week.
 *
 * It is answered by ordering start dates per customer: an earlier core
 * subscription and a later social one is an upgrade, whether Stripe was asked
 * to change a price or to end one subscription and open another. Production
 * does the latter, so following subscription ids reports zero upgrades forever.
 *
 * The event log is deliberately NOT the source. Only about 80 of 200 live
 * subscriptions carry a datable Stripe event, so asking the log answers "cannot
 * tell" for most of the base. Start dates come from the created event where one
 * exists and the subscription record where it does not, and between them cover
 * nearly everyone. The log is still read for one thing — reporting how much of
 * the base has no datable history, so the coverage is stated rather than
 * implied.
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

export function buildPlanMix(input: {
  snapshots: readonly PlanMixSnapshot[];
  /** Every event for the subscriptions above, both kinds. Filtered here. */
  events: readonly PlanMixEvent[];
  /**
   * Every subscription the customer has ever held, live or cancelled, with a
   * start date. Cancelled ones matter: dropping core in March and taking
   * social in August is still an upgrade.
   */
  spans: readonly SubscriptionSpan[];
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

  const bySubscription = new Map<string, PlanMixEvent[]>();
  for (const event of input.events) {
    const subs = bySubscription.get(event.stripeSubscriptionId) ?? [];
    subs.push(event);
    bySubscription.set(event.stripeSubscriptionId, subs);
  }

  // Ordering of start dates, not transitions in the log — see the note on
  // SubscriptionSpan for why the log cannot answer this for most of the base.
  const allUpgrades = findUpgradesFromSpans(input.spans, socialPriceIds);

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

/**
 * A subscription reduced to what the upgrade question needs: whose it is, what
 * it is, and when it began.
 *
 * Deliberately not the event log. Only 82 of 207 live subscriptions carry a
 * datable Stripe event, so asking the log "did this customer move up" answers
 * "cannot tell" for most of the base. Start dates survive that gap: they come
 * from the created event where one exists and from the subscription record
 * where it does not, which between them cover almost everyone.
 */
export type SubscriptionSpan = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  stripePriceIds: string[];
  /** When it began. Null when neither source can date it. */
  startedAt: Date | null;
};

/**
 * Customers who were on core first and are on social now.
 *
 * The test is ordering, not mechanism: an earlier core subscription and a later
 * social one is an upgrade whether Stripe was asked to change a price, or to
 * end one subscription and open another. A customer whose social subscription
 * is their oldest is not an upgrade — they arrived on the bigger plan.
 *
 * Cancelled core subscriptions count. Someone who dropped core in March and
 * took social in August upgraded, even though only one of the two is live.
 */
export function findUpgradesFromSpans(
  spans: readonly SubscriptionSpan[],
  socialPriceIds: ReadonlySet<string>,
): SocialUpgrade[] {
  const byCustomer = new Map<string, SubscriptionSpan[]>();
  for (const span of spans) {
    if (!span.stripeCustomerId) continue;
    const list = byCustomer.get(span.stripeCustomerId) ?? [];
    list.push(span);
    byCustomer.set(span.stripeCustomerId, list);
  }

  const upgrades: SocialUpgrade[] = [];
  for (const [customerId, list] of byCustomer) {
    const dated = list.filter(
      (span): span is SubscriptionSpan & { startedAt: Date } =>
        span.startedAt !== null,
    );
    const core = dated.filter(
      (span) => !hasSocial(span.stripePriceIds, socialPriceIds),
    );
    const social = dated.filter((span) =>
      hasSocial(span.stripePriceIds, socialPriceIds),
    );
    if (core.length === 0 || social.length === 0) continue;

    const firstCore = core.reduce((earliest, span) =>
      span.startedAt < earliest.startedAt ? span : earliest,
    );
    const firstSocial = social.reduce((earliest, span) =>
      span.startedAt < earliest.startedAt ? span : earliest,
    );
    // Strictly later, so a core and a social opened in the same instant — one
    // checkout buying both — is not read as an upgrade.
    if (firstSocial.startedAt <= firstCore.startedAt) continue;

    upgrades.push({
      stripeSubscriptionId: firstSocial.stripeSubscriptionId,
      stripeCustomerId: customerId,
      addedOn: commandDayForDate(firstSocial.startedAt),
      addedAt: firstSocial.startedAt.toISOString(),
    });
  }
  upgrades.sort((left, right) => right.addedAt.localeCompare(left.addedAt));
  return upgrades;
}
