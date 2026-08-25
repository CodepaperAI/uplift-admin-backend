import { Prisma } from "@prisma/client";

/**
 * How each subscriber got here: through the cheap trial, or straight in.
 *
 * The product sells a low-priced trial that converts to the full plan, and "how
 * many came via the trial versus paid full price on day one" is a question about
 * *entry*, which nothing in the schema records. There is no `entryPath` column
 * and no trial flag that survives the conversion — once a trial converts, the
 * subscription looks identical to one that never had a trial.
 *
 * What does survive is the invoice history, so that is what this reads: the
 * first invoice a subscription ever settled, against what it now bills.
 *
 * Deliberately **no hardcoded prices.** A rule like "first invoice was $3"
 * silently stops working the day the trial is repriced, and worse, it keeps
 * returning a confident number while doing so. The test is relative — did they
 * start materially below what they now pay — so it holds for a $3 trial, a
 * $0.50 trial, and whatever the trial costs next quarter.
 *
 * Annual plans work out correctly without a special case: their first invoice is
 * the whole year, which is far *above* the monthly-equivalent recurring figure,
 * so they read as `direct` — which is what they are.
 */

/**
 * A first payment at or above this share of the recurring amount is the real
 * price, not an intro price. Below 1.0 rather than exactly 1.0 because
 * proration, tax lines and a few cents of coupon rounding routinely make a
 * genuine first payment land just under the sticker.
 */
export const FULL_PRICE_RATIO = 0.9;

export type EntryPath =
  /** First payment was the full price. No trial in front of it. */
  | "direct"
  /** Started on an intro price and has since paid the full price. */
  | "trial_converted"
  /** Started on an intro price and has not yet paid a full one. */
  | "trial_pending"
  /** Live subscription that has never settled an invoice. */
  | "no_payment_yet"
  /** No invoice history reached us, so any answer would be invented. */
  | "unknown";

export type InvoiceFact = {
  stripeSubscriptionId: string;
  currency: string;
  amountPaidMinor: Prisma.Decimal;
  /** Stripe's own reason. `subscription_create` marks the opening invoice. */
  billingReason: string | null;
  paidAt: Date | null;
  providerCreatedAt: Date;
};

export type EntryClassification = {
  path: EntryPath;
  /** What they actually paid first, so the UI can show it rather than assert. */
  firstPaidMinor: string | null;
  currency: string | null;
  /** Payments settled. A converted trial has at least two. */
  paidInvoiceCount: number;
};

/** Only settled invoices say anything about what someone paid. */
function isSettled(invoice: InvoiceFact): boolean {
  return invoice.amountPaidMinor.gt(0);
}

/**
 * The opening invoice.
 *
 * Prefers Stripe's `subscription_create` reason over date order: a backfilled
 * invoice can carry a `providerCreatedAt` that sorts oddly, while the billing
 * reason is set by Stripe at the moment the subscription is made.
 */
function openingInvoice(invoices: readonly InvoiceFact[]): InvoiceFact | null {
  const settled = invoices.filter(isSettled);
  if (settled.length === 0) return null;
  const byDate = [...settled].sort(
    (left, right) =>
      left.providerCreatedAt.getTime() - right.providerCreatedAt.getTime(),
  );
  return (
    byDate.find((invoice) => invoice.billingReason === "subscription_create") ??
    byDate[0]!
  );
}

export function classifyEntryPath(input: {
  invoices: readonly InvoiceFact[];
  /** What the subscription bills now, per period, in minor units. */
  recurringMinor: Prisma.Decimal;
}): EntryClassification {
  const settled = input.invoices.filter(isSettled);
  const opening = openingInvoice(input.invoices);

  if (input.invoices.length === 0) {
    return {
      path: "unknown",
      firstPaidMinor: null,
      currency: null,
      paidInvoiceCount: 0,
    };
  }
  if (opening === null) {
    return {
      path: "no_payment_yet",
      firstPaidMinor: null,
      currency: input.invoices[0]?.currency ?? null,
      paidInvoiceCount: 0,
    };
  }

  const base = {
    firstPaidMinor: opening.amountPaidMinor.toFixed(0),
    currency: opening.currency,
    paidInvoiceCount: settled.length,
  };

  // Nothing to compare against — a zero recurring amount means the subscription
  // carries no price we can call "full", so the honest answer is that we do not
  // know rather than a coin flip.
  if (input.recurringMinor.lte(0)) {
    return { ...base, path: "unknown" };
  }

  const fullPriceFloor = input.recurringMinor.mul(FULL_PRICE_RATIO);
  if (opening.amountPaidMinor.gte(fullPriceFloor)) {
    return { ...base, path: "direct" };
  }

  const laterFullPayment = settled.some(
    (invoice) =>
      invoice !== opening && invoice.amountPaidMinor.gte(fullPriceFloor),
  );
  return { ...base, path: laterFullPayment ? "trial_converted" : "trial_pending" };
}

export type EntryPathTotals = Record<EntryPath, number>;

export function emptyEntryPathTotals(): EntryPathTotals {
  return {
    direct: 0,
    trial_converted: 0,
    trial_pending: 0,
    no_payment_yet: 0,
    unknown: 0,
  };
}

/**
 * Counts entry paths across a set of subscriptions.
 *
 * Counting *subscriptions*, not accounts: an account that bought the trial once
 * and a second plan at full price took both routes, and collapsing that to one
 * label would have to throw one of them away.
 */
export function tallyEntryPaths(
  classifications: readonly EntryClassification[],
): EntryPathTotals {
  const totals = emptyEntryPathTotals();
  for (const classification of classifications) {
    totals[classification.path] += 1;
  }
  return totals;
}
