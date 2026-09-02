import { Prisma } from "@prisma/client";
import { commandMonthForDate } from "./toronto-period";

/**
 * Churn among customers who actually paid, measured from invoices.
 *
 * Built because the existing monthly churn series cannot be trusted and
 * lifetime value is one divided by it. That series reads 1.37% a month, which
 * cannot be squared with 81 subscriptions leaving in August against an opening
 * base of about 108: it is derived from monthly churned MRR, the Stripe event
 * log only begins on 2026-08-18, earlier cancellations are inferred from
 * subscription records, seven carry no date and fifty-two subscriptions cannot
 * be dated at all.
 *
 * This measurement touches none of that. A settled invoice is a fact with a
 * date and an amount, and a subscription's current status is a fact about now.
 * From those two alone: when each customer started paying, and whether they are
 * still paying today. No month attribution, no event log, nothing inferred.
 *
 * Cohort survival rather than a monthly rate, because a monthly average is
 * flattered by growth — a base that doubled last month makes any absolute
 * number of departures look small. Survival asks the question that matters for
 * lifetime value directly: of the customers who started paying N months ago,
 * how many are still here?
 *
 * Two populations are reported, and the gap between them is the point. Anyone
 * who settled an invoice is a payer; someone whose largest settled invoice
 * reached most of their plan's monthly price is a *full-price* payer. A trial
 * charge of a few dollars that lapsed is a payer who churned but was never
 * worth ARPU, so including them inflates churn and drags lifetime value down.
 * Lifetime value should read the full-price curve; the difference between the
 * two curves is how much of the apparent churn is trial washout.
 */

/** How much of a plan's monthly price a payment must reach to count as full. */
export const FULL_PRICE_SHARE = 0.5;

export type PayingInvoiceFact = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  amountPaidMinor: Prisma.Decimal;
  paidAt: Date | null;
  currency: string;
};

export type SubscriptionStateFact = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  status: string;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
};

/** Currently collecting. `past_due` is not paying, it is failing to. */
const PAYING_STATUSES = new Set(["active"]);
/** Live but not collecting. Reported apart, because it may still recover. */
const AT_RISK_STATUSES = new Set(["past_due", "unpaid"]);

export type CustomerPaymentHistory = {
  stripeCustomerId: string;
  firstPaidAt: Date;
  firstPaidMonth: string;
  lastPaidAt: Date;
  paidInvoiceCount: number;
  largestPaidMinor: Prisma.Decimal;
  currency: string;
  /** Largest monthly price across the customer's subscriptions. */
  planMonthlyMinor: Prisma.Decimal;
  reachedFullPrice: boolean;
  state: "paying" | "at_risk" | "churned";
};

/**
 * One row per customer who has ever settled an invoice.
 *
 * Keyed on the customer rather than the subscription, because a customer who
 * cancelled one plan and bought another has not churned, and counting
 * subscriptions would record them as one departure and one arrival.
 */
export function buildCustomerPaymentHistories(input: {
  invoices: readonly PayingInvoiceFact[];
  subscriptions: readonly SubscriptionStateFact[];
}): CustomerPaymentHistory[] {
  const planMonthlyByCustomer = new Map<string, Prisma.Decimal>();
  const statusesByCustomer = new Map<string, Set<string>>();
  for (const subscription of input.subscriptions) {
    if (!subscription.stripeCustomerId) continue;
    const current =
      planMonthlyByCustomer.get(subscription.stripeCustomerId) ??
      new Prisma.Decimal(0);
    if (subscription.monthlyRecurringMinor.gt(current)) {
      planMonthlyByCustomer.set(
        subscription.stripeCustomerId,
        subscription.monthlyRecurringMinor,
      );
    }
    const statuses =
      statusesByCustomer.get(subscription.stripeCustomerId) ?? new Set<string>();
    statuses.add(subscription.status);
    statusesByCustomer.set(subscription.stripeCustomerId, statuses);
  }

  const accumulator = new Map<
    string,
    {
      firstPaidAt: Date;
      lastPaidAt: Date;
      count: number;
      largest: Prisma.Decimal;
      currency: string;
    }
  >();
  for (const invoice of input.invoices) {
    if (!invoice.stripeCustomerId || !invoice.paidAt) continue;
    if (invoice.amountPaidMinor.lte(0)) continue;
    const existing = accumulator.get(invoice.stripeCustomerId);
    if (!existing) {
      accumulator.set(invoice.stripeCustomerId, {
        firstPaidAt: invoice.paidAt,
        lastPaidAt: invoice.paidAt,
        count: 1,
        largest: invoice.amountPaidMinor,
        currency: invoice.currency,
      });
      continue;
    }
    if (invoice.paidAt < existing.firstPaidAt) existing.firstPaidAt = invoice.paidAt;
    if (invoice.paidAt > existing.lastPaidAt) existing.lastPaidAt = invoice.paidAt;
    existing.count += 1;
    if (invoice.amountPaidMinor.gt(existing.largest)) {
      existing.largest = invoice.amountPaidMinor;
    }
  }

  return [...accumulator.entries()]
    .map(([stripeCustomerId, totals]) => {
      const statuses = statusesByCustomer.get(stripeCustomerId) ?? new Set();
      const paying = [...statuses].some((status) => PAYING_STATUSES.has(status));
      const atRisk = [...statuses].some((status) => AT_RISK_STATUSES.has(status));
      const planMonthly =
        planMonthlyByCustomer.get(stripeCustomerId) ?? new Prisma.Decimal(0);
      return {
        stripeCustomerId,
        firstPaidAt: totals.firstPaidAt,
        firstPaidMonth: commandMonthForDate(totals.firstPaidAt),
        lastPaidAt: totals.lastPaidAt,
        paidInvoiceCount: totals.count,
        largestPaidMinor: totals.largest,
        currency: totals.currency,
        planMonthlyMinor: planMonthly,
        /**
         * Whether any single payment reached most of the plan's monthly price.
         *
         * A customer with no live subscription has no plan price to compare
         * against, so their invoice count stands in: more than one settled
         * invoice means they renewed at least once, which no lapsed trial does.
         */
        reachedFullPrice: planMonthly.gt(0)
          ? totals.largest.gte(planMonthly.mul(FULL_PRICE_SHARE))
          : totals.count > 1,
        state: paying ? "paying" : atRisk ? "at_risk" : "churned",
      } satisfies CustomerPaymentHistory;
    })
    .sort((left, right) => left.firstPaidAt.getTime() - right.firstPaidAt.getTime());
}

export type CohortRow = {
  month: string;
  ageMonths: number;
  customers: number;
  paying: number;
  atRisk: number;
  churned: number;
  /** Still collecting, as a share of the cohort. */
  retentionPercent: string;
};

/** Whole months between two Toronto month keys. */
export function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

export function buildCohorts(input: {
  histories: readonly CustomerPaymentHistory[];
  currentMonth: string;
}): CohortRow[] {
  const byMonth = new Map<string, CustomerPaymentHistory[]>();
  for (const history of input.histories) {
    const bucket = byMonth.get(history.firstPaidMonth) ?? [];
    bucket.push(history);
    byMonth.set(history.firstPaidMonth, bucket);
  }
  return [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, members]) => {
      const paying = members.filter((m) => m.state === "paying").length;
      const atRisk = members.filter((m) => m.state === "at_risk").length;
      return {
        month,
        ageMonths: monthsBetween(month, input.currentMonth),
        customers: members.length,
        paying,
        atRisk,
        churned: members.length - paying - atRisk,
        retentionPercent: ((paying * 100) / members.length).toFixed(2),
      };
    });
}

export type ChurnSummary = {
  payingCustomersEver: number;
  stillPaying: number;
  atRisk: number;
  churned: number;
  /** Share of everyone who ever paid that is still collecting. */
  overallRetentionPercent: string | null;
  /**
   * Months of paying life actually observed, summing survival across cohort
   * ages. A measured lower bound: it cannot see past the oldest cohort.
   */
  observedLifetimeMonths: string | null;
  /**
   * The monthly rate the cohorts imply, weighted by how many customers each
   * holds.
   *
   * Read from every cohort rather than the oldest one. The oldest cohort here
   * holds three customers, so taking its survival alone let three people set
   * the rate that lifetime value divides by.
   */
  impliedMonthlyChurnPercent: string | null;
  /**
   * Lifetime implied by that rate, which sees past the observation window.
   *
   * `observedLifetimeMonths` is a hard floor and badly truncated — retention is
   * still above half at the oldest ages, so most of the remaining life falls
   * outside what can be observed. This extends it at the measured rate, and is
   * the figure lifetime value should use.
   */
  impliedLifetimeMonths: string | null;
  /** How far the observation reaches. Lifetime cannot exceed this yet. */
  oldestCohortAgeMonths: number;
};

/**
 * The summary lifetime value needs, and what it can honestly claim.
 *
 * `observedLifetimeMonths` sums survival over cohort ages, which is the area
 * under the retention curve — the standard estimate, and here a genuine lower
 * bound rather than a projection, because it stops at the oldest cohort instead
 * of extrapolating a tail. A business eight months old cannot measure a
 * twelve-month life, and saying so is the point.
 *
 * `impliedMonthlyChurnPercent` compounds the oldest cohort's survival back to a
 * monthly rate, for comparison with the series this replaces.
 *
 * A cohort's survival is read now, not tracked through time, so age and cohort
 * quality are entangled: March's customers differ from August's in more ways
 * than age. It is still a far better instrument than a monthly average of an
 * incomplete event log.
 */
export function summariseChurn(input: {
  histories: readonly CustomerPaymentHistory[];
  cohorts: readonly CohortRow[];
}): ChurnSummary {
  const total = input.histories.length;
  const stillPaying = input.histories.filter((h) => h.state === "paying").length;
  const atRisk = input.histories.filter((h) => h.state === "at_risk").length;
  if (total === 0) {
    return {
      payingCustomersEver: 0,
      stillPaying: 0,
      atRisk: 0,
      churned: 0,
      overallRetentionPercent: null,
      observedLifetimeMonths: null,
      impliedMonthlyChurnPercent: null,
      impliedLifetimeMonths: null,
      oldestCohortAgeMonths: 0,
    };
  }

  // Survival at each age, taken from the cohort that is exactly that old.
  const survivalByAge = new Map<number, number>();
  for (const cohort of input.cohorts) {
    if (cohort.customers === 0) continue;
    survivalByAge.set(cohort.ageMonths, cohort.paying / cohort.customers);
  }
  const oldest = Math.max(0, ...input.cohorts.map((c) => c.ageMonths));

  /**
   * Area under the curve, one month per step.
   *
   * Age nought counts as a whole month of life: a customer who paid once and
   * left was still a customer for that month, and starting the sum at age one
   * would price them at nothing.
   */
  let lifetime = 0;
  let lastKnown = 1;
  for (let age = 0; age <= oldest; age += 1) {
    const observed = survivalByAge.get(age);
    // A month with no cohort of that exact age carries the previous survival
    // forward rather than dropping to zero, which would understate the area.
    if (observed !== undefined) lastKnown = observed;
    lifetime += age === 0 ? 1 : lastKnown;
  }

  /**
   * The monthly rate, weighted by cohort size.
   *
   * Each cohort with any age gives its own rate — one minus its survival taken
   * to the power of one over its age — and the average is weighted by the
   * customers behind it. Age-nought cohorts are skipped: they have had no month
   * in which to churn, so including them would report a rate of zero for the
   * newest and largest group.
   */
  let weightedChurn = 0;
  let weight = 0;
  for (const cohort of input.cohorts) {
    if (cohort.ageMonths <= 0 || cohort.customers === 0) continue;
    const survival = cohort.paying / cohort.customers;
    // A cohort with nobody left cannot be raised to a fractional power in a way
    // that means anything: its rate is total loss over its age.
    const rate =
      survival > 0 ? 1 - Math.pow(survival, 1 / cohort.ageMonths) : 1;
    weightedChurn += rate * cohort.customers;
    weight += cohort.customers;
  }
  const impliedMonthlyChurn = weight > 0 ? weightedChurn / weight : null;
  const impliedLifetime =
    impliedMonthlyChurn !== null && impliedMonthlyChurn > 0
      ? 1 / impliedMonthlyChurn
      : null;

  return {
    payingCustomersEver: total,
    stillPaying,
    atRisk,
    churned: total - stillPaying - atRisk,
    overallRetentionPercent: ((stillPaying * 100) / total).toFixed(2),
    observedLifetimeMonths: lifetime.toFixed(1),
    impliedMonthlyChurnPercent:
      impliedMonthlyChurn !== null && Number.isFinite(impliedMonthlyChurn)
        ? (impliedMonthlyChurn * 100).toFixed(4)
        : null,
    impliedLifetimeMonths:
      impliedLifetime !== null && Number.isFinite(impliedLifetime)
        ? impliedLifetime.toFixed(1)
        : null,
    oldestCohortAgeMonths: oldest,
  };
}
