import { Prisma } from "@prisma/client";

/**
 * Lifetime value, and the assumptions it rests on.
 *
 * LTV is ARPU x gross margin x expected lifetime, and expected lifetime is one
 * divided by the monthly revenue churn rate. Every one of those inputs already
 * exists on the overview; the reason the panel could not show LTV is that the
 * whole `growthEconomics` block was discarded unless a commission run was
 * locked. That gate belongs to CAC, which needs the rep payouts a locked run
 * carries. LTV needs none of them.
 *
 * Two choices worth stating, because they are what make the number honest.
 *
 * **The margin comes from a trailing window, not the current month.** The
 * existing unit-economics block is a current-month view, which is correct for
 * what it is and useless here: on the second of the month it held two days and
 * $714 of collections, so an LTV built on it would swing wildly through the
 * first week and vanish entirely at each month boundary when collections were
 * briefly zero. LTV uses the same three months its own churn rate uses.
 *
 * **The implied lifetime is reported next to the value.** A 1.37% monthly churn
 * rate implies a customer life of six years, and a business with three months
 * of churn history has not earned a six-year projection. Showing the months
 * makes the extrapolation visible instead of burying it inside a dollar figure
 * that looks measured.
 */

export type LifetimeValueInput = {
  /** Recurring revenue for the currency, in minor units. */
  mrrMinor: Prisma.Decimal | string | number;
  /** Subscriptions the ARPU is spread across. */
  payingUnits: number;
  /** Cash collected over the trailing window, minor units. */
  collectedMinor: Prisma.Decimal | string | number;
  /** Cost of serving it over the same window, minor units. */
  deliveryCostMinor: Prisma.Decimal | string | number;
  /** Monthly revenue churn as a percent, e.g. "1.3682". */
  monthlyChurnPercent: string | null;
  /** How many months of history the churn rate was measured over. */
  churnWindowMonths: number;
};

export type LifetimeValue = {
  arpuMinor: string | null;
  grossMarginPercent: string | null;
  monthlyChurnPercent: string | null;
  /** 1 / churn rate, in months. */
  expectedLifetimeMonths: string | null;
  ltvMinor: string | null;
  /**
   * How far past its own evidence the lifetime projects.
   *
   * `expectedLifetimeMonths / churnWindowMonths`. At 24x, the number is an
   * extrapolation rather than a measurement, and the reader should know.
   */
  extrapolationFactor: string | null;
  /** Everything missing or nonsensical, named. Empty means the figure stands. */
  blockers: string[];
};

/** Anything unparseable becomes zero rather than throwing on a dashboard. */
function decimal(value: Prisma.Decimal | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return new Prisma.Decimal(0);
  }
  try {
    return new Prisma.Decimal(value);
  } catch {
    return new Prisma.Decimal(0);
  }
}

/**
 * A ceiling on the projected life, so a near-zero churn rate cannot print an
 * absurd number.
 *
 * Five years. A churn rate of 0.1% implies eighty-three years of customer life,
 * which is arithmetic rather than insight; past this the figure is reported as
 * capped and the blocker says why.
 */
export const MAX_LIFETIME_MONTHS = 60;

/** Beyond this multiple of its own history, the projection is extrapolation. */
export const EXTRAPOLATION_WARNING_FACTOR = 6;

export function calculateLifetimeValue(
  input: LifetimeValueInput,
): LifetimeValue {
  const blockers: string[] = [];

  const mrr = decimal(input.mrrMinor);
  const collected = decimal(input.collectedMinor);
  const delivery = decimal(input.deliveryCostMinor);

  const arpu =
    input.payingUnits > 0 ? mrr.div(input.payingUnits) : null;
  if (arpu === null) blockers.push("no_paying_units");

  // Gross margin over the trailing window. Nothing collected means no margin to
  // measure — not a margin of zero, which would report LTV as nought and read
  // as a finding rather than an absence.
  const grossMargin = collected.gt(0)
    ? collected.sub(delivery).div(collected)
    : null;
  if (grossMargin === null) blockers.push("no_collections_in_window");
  if (grossMargin && grossMargin.lte(0)) blockers.push("non_positive_margin");

  const churnPercent =
    input.monthlyChurnPercent === null
      ? null
      : decimal(input.monthlyChurnPercent);
  const churnRate = churnPercent ? churnPercent.div(100) : null;
  if (churnRate === null) blockers.push("no_churn_measurement");
  // Zero churn is not immortality, it is a window in which nobody happened to
  // leave. Dividing by it would print an infinite lifetime.
  if (churnRate && churnRate.lte(0)) blockers.push("no_churn_observed");

  let lifetimeMonths =
    churnRate && churnRate.gt(0) ? new Prisma.Decimal(1).div(churnRate) : null;
  if (lifetimeMonths && lifetimeMonths.gt(MAX_LIFETIME_MONTHS)) {
    lifetimeMonths = new Prisma.Decimal(MAX_LIFETIME_MONTHS);
    blockers.push("lifetime_capped");
  }

  const ltv =
    arpu && grossMargin && grossMargin.gt(0) && lifetimeMonths
      ? arpu.mul(grossMargin).mul(lifetimeMonths)
      : null;

  const extrapolation =
    lifetimeMonths && input.churnWindowMonths > 0
      ? lifetimeMonths.div(input.churnWindowMonths)
      : null;
  if (
    extrapolation &&
    extrapolation.gte(EXTRAPOLATION_WARNING_FACTOR) &&
    !blockers.includes("lifetime_capped")
  ) {
    blockers.push("projection_exceeds_history");
  }

  return {
    arpuMinor: arpu ? arpu.toFixed(4) : null,
    grossMarginPercent: grossMargin ? grossMargin.mul(100).toFixed(2) : null,
    monthlyChurnPercent: input.monthlyChurnPercent,
    expectedLifetimeMonths: lifetimeMonths ? lifetimeMonths.toFixed(1) : null,
    ltvMinor: ltv ? ltv.toFixed(4) : null,
    extrapolationFactor: extrapolation ? extrapolation.toFixed(1) : null,
    blockers,
  };
}

/** Plain-English reasons, so the panel does not have to know the codes. */
export const LIFETIME_VALUE_BLOCKER_TEXT: Record<string, string> = {
  no_paying_units: "No paying subscriptions to average across.",
  no_collections_in_window:
    "Nothing was collected in the trailing window, so there is no margin to measure.",
  non_positive_margin:
    "Delivery cost exceeded what was collected, so there is no positive margin to project.",
  no_churn_measurement: "Revenue churn has not been measured yet.",
  no_churn_observed:
    "No revenue churned in the trailing window. A lifetime cannot be projected from zero churn.",
  lifetime_capped: `Churn is low enough to imply more than ${MAX_LIFETIME_MONTHS} months of life, so the projection is capped there.`,
  projection_exceeds_history:
    "The projected lifetime is many times longer than the history it was measured from, so treat it as an estimate rather than a measurement.",
};

/**
 * A monthly churn rate derived from everything ever won and lost.
 *
 * The second of the two measurements the lifetime-value range is built from,
 * and the one worth planning against.
 *
 * The monthly measure this replaces reads 1.37% a month, which cannot be
 * reconciled with the account history: 81 subscriptions left in August against
 * an opening base of about 108. The monthly figure is computed from opening and
 * churned MRR per month, and churned MRR is under-captured — the Stripe event
 * log only begins on 2026-08-18, every earlier cancellation is inferred from
 * subscription records, seven have no date at all and fifty-two subscriptions
 * cannot be dated. So it understates, and lifetime value is one divided by it.
 *
 * This measure sidesteps all of that. It asks what share of the recurring
 * revenue ever won has since been lost, which needs no month attribution and no
 * event log, then spreads that loss geometrically across the months the
 * business has actually been earning. Compounding rather than dividing, because
 * losing 43% over six months is not 7.2% a month — survival multiplies.
 */
export function cumulativeMonthlyChurnPercent(input: {
  /** MRR on subscriptions that have ended, minor units. */
  churnedMinor: Prisma.Decimal | string | number;
  /** MRR still live, minor units. */
  liveMinor: Prisma.Decimal | string | number;
  /** Months the business has been earning recurring revenue. */
  monthsObserved: number;
}): string | null {
  const churned = decimal(input.churnedMinor);
  const live = decimal(input.liveMinor);
  const everWon = churned.add(live);
  if (everWon.lte(0) || input.monthsObserved <= 0) return null;
  // Nothing lost yet is a young book, not permanence. Reported as null so the
  // caller says "not measurable" rather than projecting an infinite life.
  if (churned.lte(0)) return null;
  const survivingShare = live.div(everWon).toNumber();
  // Everything ever won has churned. A rate cannot be spread across months from
  // that, and the honest answer is that no lifetime can be projected.
  if (survivingShare <= 0) return null;
  const monthlyRetention = Math.pow(survivingShare, 1 / input.monthsObserved);
  const monthlyChurn = 1 - monthlyRetention;
  if (!Number.isFinite(monthlyChurn) || monthlyChurn <= 0) return null;
  return (monthlyChurn * 100).toFixed(4);
}

export type LifetimeValueRange = {
  /** The conservative end, from cumulative churn. Plan against this one. */
  low: LifetimeValue | null;
  /** The optimistic end, from the monthly revenue-churn measurement. */
  high: LifetimeValue | null;
  /** Which measurement drove each end, so the spread can be interrogated. */
  basis: {
    lowChurnPercent: string | null;
    lowMethod: "cumulative_revenue_churn";
    highChurnPercent: string | null;
    highMethod: "monthly_revenue_churn";
    monthsObserved: number;
    marginMonth: string | null;
  };
};

/**
 * Lifetime value as a range, because a single figure would be a false precision.
 *
 * The two ends are two measurements of the same thing that disagree by a factor
 * of six. That disagreement is the honest content of this metric right now, and
 * collapsing it to one number — either one — would hide the only thing a reader
 * needs to know before spending against it.
 */
export function calculateLifetimeValueRange(input: {
  mrrMinor: Prisma.Decimal | string | number;
  payingUnits: number;
  collectedMinor: Prisma.Decimal | string | number;
  deliveryCostMinor: Prisma.Decimal | string | number;
  monthlyChurnPercent: string | null;
  cumulativeChurnPercent: string | null;
  monthsObserved: number;
  marginMonth: string | null;
}): LifetimeValueRange {
  const shared = {
    mrrMinor: input.mrrMinor,
    payingUnits: input.payingUnits,
    collectedMinor: input.collectedMinor,
    deliveryCostMinor: input.deliveryCostMinor,
    churnWindowMonths: Math.max(1, input.monthsObserved),
  };
  const low =
    input.cumulativeChurnPercent === null
      ? null
      : calculateLifetimeValue({
          ...shared,
          monthlyChurnPercent: input.cumulativeChurnPercent,
        });
  const high =
    input.monthlyChurnPercent === null
      ? null
      : calculateLifetimeValue({
          ...shared,
          monthlyChurnPercent: input.monthlyChurnPercent,
        });
  return {
    low,
    high,
    basis: {
      lowChurnPercent: input.cumulativeChurnPercent,
      lowMethod: "cumulative_revenue_churn",
      highChurnPercent: input.monthlyChurnPercent,
      highMethod: "monthly_revenue_churn",
      monthsObserved: input.monthsObserved,
      marginMonth: input.marginMonth,
    },
  };
}
