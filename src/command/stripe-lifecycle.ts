import { Prisma } from "@prisma/client";
import { commandDayForDate, commandDays, COMMAND_TIME_ZONE } from "./toronto-period";

/**
 * Daily subscription starts and cancellations, from the append-only event log.
 *
 * The whole difficulty here is that `CommandStripeSubscriptionEvent` holds two
 * kinds of row that look identical in the schema and mean different things:
 *
 *  - Real Stripe webhook facts, where `occurredAt` is `event.created` — the
 *    moment the thing actually happened.
 *  - Reconciliation snapshots (`reconciliation.subscription.snapshot`), written
 *    by `stripe-reconciliation.service.ts` with `occurredAt = new Date()` — the
 *    moment the *sync ran*. A subscription that started in June and was first
 *    seen by a reconciliation run today carries today's timestamp.
 *
 * So the rule this module enforces, and the reason it exists rather than the
 * caller filtering inline:
 *
 *   **Reconciliation rows are trusted for STATE and never for TIMING.**
 *
 * Ask "what is this subscription worth" and a reconciliation row is a fine
 * answer. Ask "when did it start" and it is not an answer at all. Treating the
 * earliest row as a start date is how you get a churn chart that reports a
 * two-year-old customer as new business, which is worse than reporting nothing.
 *
 * Coverage is returned rather than assumed. If webhooks were wired up in June,
 * no honest daily series reaches back past June, and the caller needs to say so
 * instead of drawing a flat line of zeros that reads as "nothing happened".
 */

export const RECONCILIATION_EVENT_TYPE = "reconciliation.subscription.snapshot";
export const SUBSCRIPTION_CREATED_EVENT = "customer.subscription.created";
export const SUBSCRIPTION_DELETED_EVENT = "customer.subscription.deleted";

/** True for rows whose `occurredAt` is a sync time rather than an event time. */
export function isReconciliationEvent(eventType: string): boolean {
  return eventType === RECONCILIATION_EVENT_TYPE;
}

/**
 * True when the row's `occurredAt` can be believed as "when this happened".
 * Deliberately a prefix test on Stripe's own namespace: any future
 * `customer.subscription.*` type carries `event.created` and is safe, while
 * anything we synthesise locally is not.
 */
export function carriesRealOccurrenceTime(eventType: string): boolean {
  return eventType.startsWith("customer.subscription.");
}

export type LifecycleEvent = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  eventType: string;
  status: string;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
  occurredAt: Date;
};

export type MinorByCurrency = Record<string, string>;

export type LifecycleDay = {
  date: string;
  started: { count: number; mrrMinorByCurrency: MinorByCurrency };
  canceled: { count: number; mrrMinorByCurrency: MinorByCurrency };
};

function addBucket(
  buckets: Map<string, Prisma.Decimal>,
  currency: string | null,
  amount: Prisma.Decimal,
): boolean {
  if (!currency) return false;
  buckets.set(
    currency,
    (buckets.get(currency) ?? new Prisma.Decimal(0)).add(amount),
  );
  return true;
}

function serialize(buckets: Map<string, Prisma.Decimal>): MinorByCurrency {
  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => [currency, amount.toFixed(4)]),
  );
}

/**
 * The value to record when a subscription ends.
 *
 * Stripe's `deleted` payload can report zero once the items are gone, which
 * would understate churned revenue to nothing. So the amount lost is the last
 * non-zero amount known at or before the cancellation — and reconciliation rows
 * are allowed to supply it, because that is a state question.
 */
function amountLost(
  history: readonly LifecycleEvent[],
  cancellation: LifecycleEvent,
): { amount: Prisma.Decimal; currency: string | null } {
  if (!cancellation.monthlyRecurringMinor.isZero()) {
    return {
      amount: cancellation.monthlyRecurringMinor,
      currency: cancellation.currency,
    };
  }
  const priorNonZero = history
    .filter(
      (event) =>
        event.occurredAt <= cancellation.occurredAt &&
        !event.monthlyRecurringMinor.isZero(),
    )
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .at(0);
  return priorNonZero
    ? {
        amount: priorNonZero.monthlyRecurringMinor,
        currency: priorNonZero.currency ?? cancellation.currency,
      }
    : { amount: new Prisma.Decimal(0), currency: cancellation.currency };
}

export function buildStripeLifecycle(input: {
  /** Every event in and around the range, both kinds. Filtering happens here. */
  events: readonly LifecycleEvent[];
  from: string;
  to: string;
  /** Live subscription ids, for the coverage report. */
  liveSubscriptionIds?: readonly string[];
  /**
   * Every subscription id that has a `created` event anywhere in the log.
   *
   * Supplied by the caller from a dedicated query rather than inferred from
   * `events`, because `events` is scoped to the requested range: inferring it
   * would report a subscription created last year as undatable simply because
   * the reader asked about this week.
   */
  subscriptionIdsWithCreatedEvent?: ReadonlySet<string>;
}) {
  const days = commandDays(input.from, input.to);
  const dayIndex = new Set(days);

  // Group the full history per subscription once. Both the timing decisions and
  // the state lookups below read from this.
  const history = new Map<string, LifecycleEvent[]>();
  for (const event of input.events) {
    const list = history.get(event.stripeSubscriptionId) ?? [];
    list.push(event);
    history.set(event.stripeSubscriptionId, list);
  }

  const startedBuckets = new Map<string, Map<string, Prisma.Decimal>>();
  const canceledBuckets = new Map<string, Map<string, Prisma.Decimal>>();
  const startedCounts = new Map<string, number>();
  const canceledCounts = new Map<string, number>();
  const totalStarted = new Map<string, Prisma.Decimal>();
  const totalCanceled = new Map<string, Prisma.Decimal>();

  let startedInRange = 0;
  let canceledInRange = 0;
  let unbucketedCurrencyCount = 0;
  let earliestRealEventAt: Date | null = null;
  const subscriptionsWithCreatedEvent = new Set<string>();
  let reconciliationOnlySubscriptions = 0;

  const bump = (
    map: Map<string, number>,
    key: string,
  ): void => void map.set(key, (map.get(key) ?? 0) + 1);

  const bucketFor = (
    store: Map<string, Map<string, Prisma.Decimal>>,
    day: string,
  ): Map<string, Prisma.Decimal> => {
    const existing = store.get(day);
    if (existing) return existing;
    const created = new Map<string, Prisma.Decimal>();
    store.set(day, created);
    return created;
  };

  for (const [, events] of history) {
    const real = events.filter((event) =>
      carriesRealOccurrenceTime(event.eventType),
    );
    if (real.length === 0) {
      reconciliationOnlySubscriptions += 1;
      continue;
    }
    for (const event of real) {
      if (earliestRealEventAt === null || event.occurredAt < earliestRealEventAt) {
        earliestRealEventAt = event.occurredAt;
      }
    }

    // Stripe can deliver the same logical event more than once under different
    // event ids, so a subscription's start is the earliest `created` it has —
    // not one row per delivery.
    const created = real
      .filter((event) => event.eventType === SUBSCRIPTION_CREATED_EVENT)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
      .at(0);
    if (created) {
      subscriptionsWithCreatedEvent.add(created.stripeSubscriptionId);
      const day = commandDayForDate(created.occurredAt);
      if (dayIndex.has(day)) {
        startedInRange += 1;
        bump(startedCounts, day);
        const placed =
          addBucket(
            bucketFor(startedBuckets, day),
            created.currency,
            created.monthlyRecurringMinor,
          ) &&
          addBucket(totalStarted, created.currency, created.monthlyRecurringMinor);
        if (!placed) unbucketedCurrencyCount += 1;
      }
    }

    const deleted = real
      .filter((event) => event.eventType === SUBSCRIPTION_DELETED_EVENT)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
      .at(0);
    if (deleted) {
      const day = commandDayForDate(deleted.occurredAt);
      if (dayIndex.has(day)) {
        canceledInRange += 1;
        bump(canceledCounts, day);
        const lost = amountLost(events, deleted);
        const placed =
          addBucket(
            bucketFor(canceledBuckets, day),
            lost.currency,
            lost.amount,
          ) && addBucket(totalCanceled, lost.currency, lost.amount);
        if (!placed) unbucketedCurrencyCount += 1;
      }
    }
  }

  const rows: LifecycleDay[] = days.map((date) => ({
    date,
    started: {
      count: startedCounts.get(date) ?? 0,
      mrrMinorByCurrency: serialize(
        startedBuckets.get(date) ?? new Map<string, Prisma.Decimal>(),
      ),
    },
    canceled: {
      count: canceledCounts.get(date) ?? 0,
      mrrMinorByCurrency: serialize(
        canceledBuckets.get(date) ?? new Map<string, Prisma.Decimal>(),
      ),
    },
  }));

  const live = input.liveSubscriptionIds ?? [];
  const datable = input.subscriptionIdsWithCreatedEvent ?? subscriptionsWithCreatedEvent;
  const liveWithCreatedEvent = live.filter((id) => datable.has(id)).length;
  const eventLogStartsOn =
    earliestRealEventAt === null ? null : commandDayForDate(earliestRealEventAt);

  return {
    days: rows,
    totals: {
      started: {
        count: startedInRange,
        mrrMinorByCurrency: serialize(totalStarted),
      },
      canceled: {
        count: canceledInRange,
        mrrMinorByCurrency: serialize(totalCanceled),
      },
    },
    coverage: {
      timeZone: COMMAND_TIME_ZONE,
      /** Toronto day of the oldest believable Stripe event, or null if none. */
      eventLogStartsOn,
      /** True when the caller asked for days the event log cannot speak to. */
      rangeStartsBeforeEventLog:
        eventLogStartsOn !== null && input.from < eventLogStartsOn,
      liveSubscriptions: live.length,
      liveWithCreatedEvent,
      /** Live subscriptions whose start date this endpoint cannot supply. */
      liveWithoutCreatedEvent: Math.max(0, live.length - liveWithCreatedEvent),
      /**
       * Subscriptions in the supplied window known only from reconciliation
       * snapshots. They have real state and no believable timing, so they are
       * absent from every day above. Scoped to what was fetched, unlike the
       * two counts before it, which are global.
       */
      reconciliationOnlySubscriptions,
      /** Events dropped from the money buckets for having no single currency. */
      unbucketedCurrencyCount,
    },
  };
}
