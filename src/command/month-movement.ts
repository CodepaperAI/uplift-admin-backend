import {
  COMMAND_TIME_ZONE,
  commandDayForDate,
  commandDays,
  commandDayRange,
  commandMonthRange,
  shiftCommandDay,
} from "./toronto-period";

/**
 * One month of "who arrived, and who left" — in people, not dollars.
 *
 * The panel used to answer this with new-versus-churned *MRR* derived from the
 * subscription event log, and that number was wrong in a way worth recording,
 * because the same trap is waiting for anyone who rebuilds it. Webhooks only
 * began delivering on 2026-08-18. The old aggregation decided a subscription
 * was new business when its *earliest row in the log* fell inside the month, so
 * on the day the log started every live subscription — March's included — began
 * looking like an August arrival. New MRR came out exactly equal to the entire
 * MRR book, and churn came out as zero because there was no prior state to
 * compare against.
 *
 * So the sources here are chosen for *coverage*, not convenience:
 *
 *  - Arrivals and departures are read from `Subscription`, the app's own table,
 *    which carries a real `startDate` for every row and predates the webhooks.
 *  - Where a Stripe `customer.subscription.created` / `.deleted` event exists it
 *    wins, because that is the provider's own timestamp for the event.
 *  - Payment failures come from the invoice table, which reconciliation fills
 *    from Stripe's own invoice list, so it also reaches back past the webhooks.
 *
 * Everything is counted in **distinct accounts**, and the month total is a
 * distinct count across the month rather than the sum of the daily bars. Three
 * failed retries for one customer is one customer in trouble, and a customer who
 * both failed a payment and then cancelled is one account lost, not two.
 */

/** Where a date came from, so the panel can say how much it can trust. */
export type MovementSource = "stripe_event" | "subscription_record";

export type MovementFact = {
  /**
   * The account this belongs to. Stripe's customer id where we have one — the
   * same key the roster counts by, so the two panels cannot disagree about how
   * many accounts a month gained.
   */
  accountKey: string;
  at: Date;
  source: MovementSource;
};

export type FailedInvoiceFact = {
  accountKey: string;
  stripeInvoiceId: string;
  at: Date;
};

export type MonthMovementDay = {
  date: string;
  newSubscribers: number;
  cancellations: number;
  paymentFailures: number;
  /** Distinct accounts in either churn bucket. Never their sum. */
  churned: number;
};

function tallyBySource(facts: readonly MovementFact[]): Record<MovementSource, number> {
  return facts.reduce(
    (totals, fact) => ({ ...totals, [fact.source]: totals[fact.source] + 1 }),
    { stripe_event: 0, subscription_record: 0 } as Record<MovementSource, number>,
  );
}

export function buildMonthMovement(input: {
  month: string;
  starts: readonly MovementFact[];
  cancellations: readonly MovementFact[];
  failedInvoices: readonly FailedInvoiceFact[];
  /**
   * Accounts known to have cancelled but carrying no usable date. Reported
   * rather than dropped: a churn chart that silently omits them reads as a
   * quieter month than it was.
   */
  undatedCancellations?: number;
  /** First day the webhook log has a real event, for the coverage note. */
  eventLogStartsOn?: string | null;
}): {
  period: { month: string; start: string; endExclusive: string; timeZone: string };
  days: MonthMovementDay[];
  totals: {
    newSubscribers: number;
    cancellations: number;
    paymentFailures: number;
    churned: number;
    failedInvoices: number;
    net: number;
  };
  coverage: {
    timeZone: string;
    newBySource: Record<MovementSource, number>;
    cancellationsBySource: Record<MovementSource, number>;
    undatedCancellations: number;
    eventLogStartsOn: string | null;
    /**
     * True when part of the month predates the webhook log, so the reader knows
     * the early days lean on the app's own table rather than on Stripe events.
     */
    monthStartsBeforeEventLog: boolean;
    outOfMonthFactsIgnored: number;
  };
} {
  const range = commandMonthRange(input.month);
  const firstDay = commandDayForDate(range.start);
  const lastDay = shiftCommandDay(commandDayForDate(range.end), -1);
  const days = commandDays(firstDay, lastDay);
  const dayIndex = new Set(days);

  const newByDay = new Map<string, Set<string>>();
  const cancelByDay = new Map<string, Set<string>>();
  const failByDay = new Map<string, Set<string>>();
  const newInMonth = new Set<string>();
  const cancelInMonth = new Set<string>();
  const failInMonth = new Set<string>();
  const failedInvoiceIds = new Set<string>();
  let outOfMonthFactsIgnored = 0;

  const place = (
    byDay: Map<string, Set<string>>,
    inMonth: Set<string>,
    at: Date,
    accountKey: string,
  ): boolean => {
    const day = commandDayForDate(at);
    if (!dayIndex.has(day)) {
      outOfMonthFactsIgnored += 1;
      return false;
    }
    const bucket = byDay.get(day) ?? new Set<string>();
    bucket.add(accountKey);
    byDay.set(day, bucket);
    inMonth.add(accountKey);
    return true;
  };

  const placedStarts: MovementFact[] = [];
  for (const fact of input.starts) {
    if (place(newByDay, newInMonth, fact.at, fact.accountKey)) placedStarts.push(fact);
  }
  const placedCancellations: MovementFact[] = [];
  for (const fact of input.cancellations) {
    if (place(cancelByDay, cancelInMonth, fact.at, fact.accountKey)) {
      placedCancellations.push(fact);
    }
  }
  for (const fact of input.failedInvoices) {
    if (place(failByDay, failInMonth, fact.at, fact.accountKey)) {
      failedInvoiceIds.add(fact.stripeInvoiceId);
    }
  }

  const series = days.map((date) => {
    const cancels = cancelByDay.get(date) ?? new Set<string>();
    const fails = failByDay.get(date) ?? new Set<string>();
    return {
      date,
      newSubscribers: (newByDay.get(date) ?? new Set()).size,
      cancellations: cancels.size,
      paymentFailures: fails.size,
      churned: new Set([...cancels, ...fails]).size,
    };
  });

  const churned = new Set([...cancelInMonth, ...failInMonth]).size;
  const eventLogStartsOn = input.eventLogStartsOn ?? null;

  return {
    period: {
      month: range.month,
      start: range.start.toISOString(),
      endExclusive: range.end.toISOString(),
      timeZone: range.timeZone,
    },
    days: series,
    totals: {
      newSubscribers: newInMonth.size,
      cancellations: cancelInMonth.size,
      paymentFailures: failInMonth.size,
      churned,
      failedInvoices: failedInvoiceIds.size,
      net: newInMonth.size - churned,
    },
    coverage: {
      timeZone: COMMAND_TIME_ZONE,
      newBySource: tallyBySource(placedStarts),
      cancellationsBySource: tallyBySource(placedCancellations),
      undatedCancellations: input.undatedCancellations ?? 0,
      eventLogStartsOn,
      monthStartsBeforeEventLog:
        eventLogStartsOn !== null && firstDay < eventLogStartsOn,
      outOfMonthFactsIgnored,
    },
  };
}

/** Guards the `?month=` parameter and returns the Toronto month it names. */
export function parseMovementMonth(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(trimmed)) return null;
  try {
    commandDayRange(`${trimmed}-01`, `${trimmed}-01`);
    return trimmed;
  } catch {
    return null;
  }
}
