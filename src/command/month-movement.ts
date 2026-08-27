import {
  COMMAND_TIME_ZONE,
  commandDayForDate,
  commandDays,
  commandDayRange,
  commandMonthForDate,
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
  /** What Stripe is still owed on this invoice, minor units. For the call list. */
  amountRemainingMinor?: string | null;
  currency?: string | null;
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

/** Inclusive month list, oldest first. */
export function commandMonthSpan(from: string, to: string): string[] {
  const parse = (month: string) => {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) throw new Error("Month must use YYYY-MM format");
    return Number(match[1]) * 12 + Number(match[2]) - 1;
  };
  const start = parse(from);
  const end = parse(to);
  if (end < start) throw new Error("Month range ends before it starts");
  if (end - start >= 120) throw new Error("Month range cannot exceed 120 months");
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const absolute = start + index;
    return `${Math.floor(absolute / 12)}-${String((absolute % 12) + 1).padStart(2, "0")}`;
  });
}

export type MovementHistoryMonth = {
  month: string;
  newSubscribers: number;
  cancellations: number;
  paymentFailures: number;
  /** Distinct accounts in either churn bucket. Never their sum. */
  churned: number;
  net: number;
  /**
   * Every account created that month, not only the ones that bought something.
   *
   * Sits beside `newSubscribers` because the pair is the month's conversion
   * story: 219 arrived and 10 took a plan is a different month from 12 arrived
   * and 10 took a plan, and the churn chart could not tell them apart.
   */
  signups: number;
  /**
   * Cash Stripe actually settled that month, by currency, in minor units.
   *
   * Subscription invoices *and* one-off invoices, which is what makes it
   * "revenue collected" rather than "subscription revenue" — a manually
   * invoiced retainer counts here and does not appear in MRR.
   *
   * Never summed across currencies: CAD and USD sit side by side because adding
   * them would invent an exchange rate.
   */
  collectedMinorByCurrency: Record<string, string>;
};

/** Sums of minor-unit amounts keyed by currency, as strings out. */
export type MinorByCurrency = Record<string, string>;

/**
 * The same arrivals and departures, bucketed by month instead of by day.
 *
 * Deliberately a second pass over the same facts rather than a roll-up of the
 * daily series: a customer who failed a payment on the 5th and cancelled on the
 * 20th is *one* account lost for the month, and summing two daily bars would
 * report two. The distinct-account rule has to be applied at whatever grain is
 * being displayed, which is why this cannot be derived from `days`.
 */
export function buildMovementHistory(input: {
  from: string;
  to: string;
  starts: readonly MovementFact[];
  cancellations: readonly MovementFact[];
  failedInvoices: readonly FailedInvoiceFact[];
  /** When each account was created, for the per-month signup count. */
  signups?: readonly { at: Date }[];
  /** Settled invoices, for the per-month collected figure. */
  collected?: readonly { at: Date; currency: string; amountMinor: string }[];
}): {
  range: { from: string; to: string; timeZone: string };
  months: MovementHistoryMonth[];
  totals: {
    newSubscribers: number;
    cancellations: number;
    paymentFailures: number;
    churned: number;
    net: number;
  };
} {
  const months = commandMonthSpan(input.from, input.to);
  const monthIndex = new Set(months);

  const collect = (
    facts: readonly { accountKey: string; at: Date }[],
  ): { byMonth: Map<string, Set<string>>; overall: Set<string> } => {
    const byMonth = new Map<string, Set<string>>();
    const overall = new Set<string>();
    for (const fact of facts) {
      const month = commandMonthForDate(fact.at);
      if (!monthIndex.has(month)) continue;
      const bucket = byMonth.get(month) ?? new Set<string>();
      bucket.add(fact.accountKey);
      byMonth.set(month, bucket);
      overall.add(fact.accountKey);
    }
    return { byMonth, overall };
  };

  const arrived = collect(input.starts);
  const cancelled = collect(input.cancellations);
  const failed = collect(input.failedInvoices);

  // Signups are counted per event, not per distinct account: two accounts on
  // one day are two signups. That is the opposite of the churn buckets above,
  // where three failed retries for one customer is one customer in trouble.
  const signupsByMonth = new Map<string, number>();
  for (const signup of input.signups ?? []) {
    const month = commandMonthForDate(signup.at);
    if (!monthIndex.has(month)) continue;
    signupsByMonth.set(month, (signupsByMonth.get(month) ?? 0) + 1);
  }

  // Summed as integers in minor units. These are amounts in cents, so there is
  // nothing to round and no float to drift.
  const collectedByMonth = new Map<string, Map<string, bigint>>();
  for (const entry of input.collected ?? []) {
    const month = commandMonthForDate(entry.at);
    if (!monthIndex.has(month)) continue;
    const currency = entry.currency.toLowerCase();
    const bucket = collectedByMonth.get(month) ?? new Map<string, bigint>();
    let amount: bigint;
    try {
      amount = BigInt(entry.amountMinor);
    } catch {
      // A malformed amount is skipped rather than crashing the panel, and it
      // cannot silently read as zero revenue for the month: every other
      // invoice in the month still counts.
      continue;
    }
    bucket.set(currency, (bucket.get(currency) ?? 0n) + amount);
    collectedByMonth.set(month, bucket);
  }

  const series = months.map((month) => {
    const cancels = cancelled.byMonth.get(month) ?? new Set<string>();
    const fails = failed.byMonth.get(month) ?? new Set<string>();
    const churned = new Set([...cancels, ...fails]).size;
    const newSubscribers = (arrived.byMonth.get(month) ?? new Set()).size;
    const collected = collectedByMonth.get(month) ?? new Map<string, bigint>();
    return {
      month,
      newSubscribers,
      cancellations: cancels.size,
      paymentFailures: fails.size,
      churned,
      net: newSubscribers - churned,
      signups: signupsByMonth.get(month) ?? 0,
      collectedMinorByCurrency: Object.fromEntries(
        [...collected.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([currency, amount]) => [currency, amount.toString()]),
      ),
    };
  });

  const churnedOverall = new Set([...cancelled.overall, ...failed.overall]).size;

  return {
    range: { from: months[0]!, to: months[months.length - 1]!, timeZone: COMMAND_TIME_ZONE },
    months: series,
    totals: {
      newSubscribers: arrived.overall.size,
      cancellations: cancelled.overall.size,
      paymentFailures: failed.overall.size,
      churned: churnedOverall,
      net: arrived.overall.size - churnedOverall,
    },
  };
}


/* -------------------------------------------------------------------------- */
/*  The churn call list                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Why this account is on the list.
 *
 * `both` is its own value rather than a cancellation that happens to have a
 * failed payment behind it, because the two need different opening lines: a card
 * that failed and then a cancellation is usually a billing problem wearing a
 * churn costume, and it is the most recoverable row on the page.
 */
export type ChurnReason = "cancelled" | "payment_failed" | "both";

/** What we know about the person behind an account key. */
export type ChurnIdentity = {
  stripeCustomerId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Which number that is. A business line means a receptionist may answer, and
   * the rep should know that before the call connects rather than after.
   */
  phoneSource?: "user" | "business" | null;
  businessName?: string | null;
  planName?: string | null;
  /** What they were paying, so the list can be worked by value. */
  mrrMinor?: string | null;
  currency?: string | null;
};

export type ChurnedAccount = ChurnIdentity & {
  accountKey: string;
  reason: ChurnReason;
  cancelledAt: string | null;
  paymentFailedAt: string | null;
  failedInvoiceCount: number;
  /** Sum of what is unpaid across this month's failed invoices, minor units. */
  amountOutstandingMinor: string | null;
  outstandingCurrency: string | null;
};

/** Highest recurring value first — the biggest loss is the first call. */
function byValueThenRecency(left: ChurnedAccount, right: ChurnedAccount): number {
  const value = (row: ChurnedAccount): bigint => {
    try {
      return BigInt(row.mrrMinor ?? "0");
    } catch {
      return 0n;
    }
  };
  const difference = value(right) - value(left);
  if (difference !== 0n) return difference > 0n ? 1 : -1;
  const at = (row: ChurnedAccount) => row.cancelledAt ?? row.paymentFailedAt ?? "";
  return at(right).localeCompare(at(left));
}

/**
 * Everyone who cancelled or missed a payment in one month, as a call list.
 *
 * The panel already counted these two things; a count is not something a rep can
 * act on. This is the same facts with a name, a number and an amount attached,
 * so "43 cancelled" becomes forty-three conversations someone can have today.
 *
 * One row per **account**, not per event, matching how the counts above are
 * made: an account that failed three retries and then cancelled is one person to
 * ring, and the row says so rather than appearing three times and overstating
 * the work. Accounts with no identity on record are still listed — a Stripe
 * customer id and an amount is enough to look someone up, and dropping them
 * would make the list quietly disagree with the count beside it.
 */
export function buildChurnCallList(input: {
  month: string;
  cancellations: readonly MovementFact[];
  failedInvoices: readonly FailedInvoiceFact[];
  identities?: ReadonlyMap<string, ChurnIdentity>;
}): {
  rows: ChurnedAccount[];
  totals: { cancelled: number; paymentFailed: number; both: number; accounts: number };
} {
  const inMonth = (at: Date) => commandMonthForDate(at) === input.month;

  /** Earliest event in the month wins: it is when the trouble started. */
  const cancelledAt = new Map<string, Date>();
  for (const fact of input.cancellations) {
    if (!inMonth(fact.at)) continue;
    const current = cancelledAt.get(fact.accountKey);
    if (!current || fact.at < current) cancelledAt.set(fact.accountKey, fact.at);
  }

  const failedAt = new Map<string, Date>();
  const failedCount = new Map<string, number>();
  const outstanding = new Map<string, Map<string, bigint>>();
  for (const fact of input.failedInvoices) {
    if (!inMonth(fact.at)) continue;
    const current = failedAt.get(fact.accountKey);
    if (!current || fact.at < current) failedAt.set(fact.accountKey, fact.at);
    failedCount.set(fact.accountKey, (failedCount.get(fact.accountKey) ?? 0) + 1);
    if (fact.amountRemainingMinor && fact.currency) {
      const currency = fact.currency.toLowerCase();
      const bucket = outstanding.get(fact.accountKey) ?? new Map<string, bigint>();
      try {
        bucket.set(currency, (bucket.get(currency) ?? 0n) + BigInt(fact.amountRemainingMinor));
        outstanding.set(fact.accountKey, bucket);
      } catch {
        // A malformed amount costs this row its total, not the whole list.
      }
    }
  }

  const keys = new Set([...cancelledAt.keys(), ...failedAt.keys()]);
  const rows: ChurnedAccount[] = [];
  for (const accountKey of keys) {
    const cancelled = cancelledAt.get(accountKey) ?? null;
    const failed = failedAt.get(accountKey) ?? null;
    const reason: ChurnReason =
      cancelled && failed ? "both" : cancelled ? "cancelled" : "payment_failed";
    // Only one currency is ever reported, because summing across them would
    // invent an exchange rate. Where an account somehow owes in two, the larger
    // is shown — the point of the number is to rank the call, not to reconcile.
    const owed = [...(outstanding.get(accountKey)?.entries() ?? [])].sort(
      ([, left], [, right]) => (right > left ? 1 : right < left ? -1 : 0),
    )[0];
    rows.push({
      ...(input.identities?.get(accountKey) ?? {}),
      accountKey,
      reason,
      cancelledAt: cancelled ? cancelled.toISOString() : null,
      paymentFailedAt: failed ? failed.toISOString() : null,
      failedInvoiceCount: failedCount.get(accountKey) ?? 0,
      amountOutstandingMinor: owed ? owed[1].toString() : null,
      outstandingCurrency: owed ? owed[0] : null,
    });
  }
  rows.sort(byValueThenRecency);

  return {
    rows,
    totals: {
      cancelled: rows.filter((row) => row.reason === "cancelled").length,
      paymentFailed: rows.filter((row) => row.reason === "payment_failed").length,
      both: rows.filter((row) => row.reason === "both").length,
      accounts: rows.length,
    },
  };
}

/** Earliest Toronto month any of these facts falls in. */
export function earliestFactMonth(
  facts: readonly { at: Date }[],
): string | null {
  const earliest = facts.reduce<Date | null>(
    (best, fact) => (best === null || fact.at < best ? fact.at : best),
    null,
  );
  return earliest ? commandMonthForDate(earliest) : null;
}
