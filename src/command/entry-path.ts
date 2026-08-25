import { Prisma } from "@prisma/client";

/**
 * How each subscriber got in: token trial, discounted first month, or full price.
 *
 * "How many came through the trial and converted, and how many paid full price
 * on day one" is a question about *entry*, and nothing in the schema records it.
 * There is no entry column and no trial flag that survives conversion — once a
 * trial converts, the subscription is indistinguishable from one that never had
 * one. What survives is the invoice history, so that is what this reads: the
 * first invoice a subscription ever settled, against what it bills now.
 *
 * **Three routes, not two.** The first cut of this had only "started below full
 * price" versus "paid full price", and measured against production it was
 * wrong in a way that mattered: it reported 90 trials. The actual opening
 * payments are 54 accounts at USD 74.00 — half of USD 149.00, a coupon — and 12
 * at USD 0.50 with exactly one at USD 3.00. A half-price first month is not a
 * trial, and folding the two together turned a 12-person trial funnel into a
 * 90-person one.
 *
 * So a trial is a **token** charge: a nominal amount taken to verify a card,
 * a few percent of the price at most. A coupon leaves a substantial fraction of
 * the price behind. The boundary is relative rather than an amount, so it holds
 * across currencies and survives repricing either one.
 *
 * Whether they reached full price is kept as a separate flag rather than
 * doubling the route list. "Trial that converted" and "still on the intro
 * price" are the same route at two stages, and the caller usually wants to
 * group by one or the other, not by their product.
 *
 * Annual plans need no special case: their opening invoice is a whole year, far
 * above the monthly-equivalent recurring figure, so they read as full price.
 */

/**
 * At or above this share of the recurring amount, the first payment *is* the
 * price. Below 1.0 because proration, tax lines and a few cents of coupon
 * rounding routinely put a genuine first payment just under sticker.
 */
export const FULL_PRICE_RATIO = 0.9;

/**
 * At or below this share, the first payment is a token — a card check, not a
 * price. Production sits either side of this by a wide margin: real trials are
 * 0.3%–2% of the plan, and the cheapest coupon entry is 22%.
 */
export const TOKEN_PRICE_RATIO = 0.1;

export type EntryRoute =
  /** Opening payment was a token charge — a trial. */
  | "trial"
  /** Opening payment was reduced but substantial — a coupon. */
  | "discount"
  /** Opening payment was the full price. */
  | "full"
  /** Live subscription that has never settled an invoice. */
  | "none"
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
  route: EntryRoute;
  /**
   * True once a payment at (or effectively at) the full price has settled. For
   * a trial or a discount this is the conversion; for `full` it is true from the
   * first payment.
   */
  reachedFullPrice: boolean;
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
      route: "unknown",
      reachedFullPrice: false,
      firstPaidMinor: null,
      currency: null,
      paidInvoiceCount: 0,
    };
  }
  if (opening === null) {
    return {
      route: "none",
      reachedFullPrice: false,
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

  // Nothing to compare against — a zero recurring amount means there is no
  // price we can call "full", so the honest answer is that we do not know.
  if (input.recurringMinor.lte(0)) {
    return { ...base, route: "unknown", reachedFullPrice: false };
  }

  const fullPriceFloor = input.recurringMinor.mul(FULL_PRICE_RATIO);
  const tokenCeiling = input.recurringMinor.mul(TOKEN_PRICE_RATIO);
  const reachedFullPrice = settled.some((invoice) =>
    invoice.amountPaidMinor.gte(fullPriceFloor),
  );

  if (opening.amountPaidMinor.gte(fullPriceFloor)) {
    return { ...base, route: "full", reachedFullPrice: true };
  }
  return {
    ...base,
    route: opening.amountPaidMinor.lte(tokenCeiling) ? "trial" : "discount",
    reachedFullPrice,
  };
}

export type EntryPathTotals = {
  /** Token opening that has since paid full price — the converted funnel. */
  trialConverted: number;
  /** Token opening, still on it. */
  trialPending: number;
  /** Coupon opening that has since paid full price. */
  discountConverted: number;
  /** Coupon opening, still discounted. */
  discountPending: number;
  /** Paid the full price from the first invoice. */
  full: number;
  /** Live, never settled an invoice. */
  none: number;
  unknown: number;
};

export function emptyEntryPathTotals(): EntryPathTotals {
  return {
    trialConverted: 0,
    trialPending: 0,
    discountConverted: 0,
    discountPending: 0,
    full: 0,
    none: 0,
    unknown: 0,
  };
}

/**
 * Counts entry routes across a set of subscriptions.
 *
 * Counting *subscriptions*, not accounts: an account that bought the trial once
 * and a second plan at full price took both routes, and collapsing that to one
 * label would have to throw one of them away.
 */
export function tallyEntryPaths(
  classifications: readonly EntryClassification[],
): EntryPathTotals {
  const totals = emptyEntryPathTotals();
  for (const entry of classifications) {
    if (entry.route === "trial") {
      if (entry.reachedFullPrice) totals.trialConverted += 1;
      else totals.trialPending += 1;
    } else if (entry.route === "discount") {
      if (entry.reachedFullPrice) totals.discountConverted += 1;
      else totals.discountPending += 1;
    } else if (entry.route === "full") {
      totals.full += 1;
    } else if (entry.route === "none") {
      totals.none += 1;
    } else {
      totals.unknown += 1;
    }
  }
  return totals;
}
