import { Prisma } from "@prisma/client";
import { classifyEntryPath, type InvoiceFact } from "./entry-path";

/**
 * Today's signups, and whether anyone has actually paid.
 *
 * Built for a phone call: a rep opens this in the morning and works down it, so
 * every row carries the things you need to make contact — a number, an email,
 * the site they entered — and one unambiguous statement of where their money is.
 *
 * The payment state deliberately does **not** come from `User.trialStatus` or
 * `Subscription.status`. Measured against production, every one of today's 54
 * signups reads `trialStatus: "none"` and `subscriptionStatus: "expired"`,
 * including the ones who have paid: those fields track a legacy in-app trial
 * that the current Stripe checkout never touches. Reading them would tell the
 * team nobody had paid, every single day.
 *
 * So state is derived from Stripe — a live subscription, and what its first
 * settled invoice was against what it bills — reusing the same classifier the
 * subscriber roster uses, so the two can never disagree about who is on a trial.
 */

export type SignupPaymentState =
  /** Paid the full plan price at least once. A customer. */
  | "paid"
  /** Opened on a token charge and has not yet paid full price. */
  | "trial"
  /** Opened below full price on a coupon, not yet at full price. */
  | "discounted"
  /**
   * A live subscription with no settled invoice in our records yet.
   *
   * Named for what is known rather than guessed at. Measured on production
   * these are same-day signups that Stripe reports as `active` with a first
   * bill three days out — a window no established subscription has, since every
   * one of those renews in 31, 34 or 365 days. So it is an introductory period
   * whose charge has not reached the invoice table, not a failed card. Calling
   * it "unpaid" sent a rep to chase a payment that was never due.
   */
  | "pending"
  /** Subscribed and already ended. Signed up and cancelled the same day. */
  | "cancelled"
  /** No Stripe subscription at all. The bulk of any day's signups. */
  | "none";

export type SignupRow = {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  businessName: string | null;
  websiteUrl: string | null;
  signedUpAt: string;
  state: SignupPaymentState;
  /** What they actually paid first, so the state can be checked, not trusted. */
  firstPaidMinor: string | null;
  /** What the subscription bills now. */
  mrrMinor: string | null;
  currency: string | null;
  planName: string | null;
  /** True once they have built something — a signal they are engaged. */
  hasBusiness: boolean;
  /**
   * When Stripe bills them next, and how far off that is in days.
   *
   * Carried because it is the only thing that distinguishes a subscription
   * waiting on its first charge from one whose payment failed, and the two need
   * opposite responses. A window of a few days on a monthly plan is an
   * introductory period, not a broken card — every established subscription on
   * the book renews in 31, 34 or 365 days.
   */
  nextBillAt: string | null;
  daysToNextBill: number | null;
};

export type SignupSubscriptionFact = {
  userId: string | null;
  status: string;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
  stripeSubscriptionId: string;
  /** When Stripe next bills them. The first bill, for a brand-new signup. */
  currentPeriodEnd: Date | null;
};

const ENDED_STATUSES = new Set([
  "canceled",
  "cancelled",
  "incomplete_expired",
]);

/**
 * The subscription that decides a signup's state.
 *
 * A live one always wins over an ended one: someone who cancelled a first
 * attempt and immediately subscribed again is a customer, not a cancellation,
 * and reporting the cancellation would send a rep to talk them out of a purchase
 * they already made.
 */
function decidingSubscription(
  subscriptions: readonly SignupSubscriptionFact[],
): SignupSubscriptionFact | null {
  if (subscriptions.length === 0) return null;
  const live = subscriptions.filter(
    (subscription) => !ENDED_STATUSES.has(subscription.status),
  );
  const pool = live.length > 0 ? live : subscriptions;
  // Highest recurring amount, so a paid plan outranks a leftover trial row.
  return [...pool].sort((left, right) =>
    right.monthlyRecurringMinor.comparedTo(left.monthlyRecurringMinor),
  )[0]!;
}

export function buildDailySignups(input: {
  users: readonly {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    createdAt: Date;
  }[];
  businessesByUser: ReadonlyMap<
    string,
    { businessName: string; businessWebsiteUrl: string }[]
  >;
  subscriptionsByUser: ReadonlyMap<string, SignupSubscriptionFact[]>;
  invoicesBySubscription: ReadonlyMap<string, InvoiceFact[]>;
  planNameBySubscription?: ReadonlyMap<string, string | null>;
}): { rows: SignupRow[]; totals: Record<SignupPaymentState | "signups" | "reachable", number> } {
  const rows: SignupRow[] = input.users
    .map((user): SignupRow => {
      const businesses = input.businessesByUser.get(user.id) ?? [];
      const primary = businesses[0] ?? null;
      const subscription = decidingSubscription(
        input.subscriptionsByUser.get(user.id) ?? [],
      );

      const billAt = subscription?.currentPeriodEnd ?? null;
      const base = {
        userId: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        businessName: primary?.businessName ?? null,
        websiteUrl: primary?.businessWebsiteUrl ?? null,
        signedUpAt: user.createdAt.toISOString(),
        hasBusiness: businesses.length > 0,
        nextBillAt: billAt ? billAt.toISOString() : null,
        daysToNextBill: billAt
          ? Math.round(
              (billAt.getTime() - user.createdAt.getTime()) / 86_400_000,
            )
          : null,
      };

      if (!subscription) {
        return {
          ...base,
          state: "none",
          firstPaidMinor: null,
          mrrMinor: null,
          currency: null,
          planName: null,
        };
      }

      const entry = classifyEntryPath({
        invoices:
          input.invoicesBySubscription.get(subscription.stripeSubscriptionId) ?? [],
        recurringMinor: subscription.monthlyRecurringMinor,
      });
      const shared = {
        ...base,
        firstPaidMinor: entry.firstPaidMinor,
        mrrMinor: subscription.monthlyRecurringMinor.toFixed(0),
        currency: subscription.currency ?? entry.currency,
        planName:
          input.planNameBySubscription?.get(subscription.stripeSubscriptionId) ??
          null,
      };

      if (ENDED_STATUSES.has(subscription.status)) {
        return { ...shared, state: "cancelled" };
      }
      if (entry.route === "none" || entry.route === "unknown") {
        return { ...shared, state: "pending" };
      }
      if (entry.reachedFullPrice) return { ...shared, state: "paid" };
      return {
        ...shared,
        state: entry.route === "trial" ? "trial" : "discounted",
      };
    })
    // Newest first: a signup from twenty minutes ago is the one still warm.
    .sort((left, right) => right.signedUpAt.localeCompare(left.signedUpAt));

  const totals = {
    signups: rows.length,
    paid: 0,
    trial: 0,
    discounted: 0,
    pending: 0,
    cancelled: 0,
    none: 0,
    // Someone a rep can actually contact today. An email always exists, so this
    // counts the ones with a number, which is what a call list needs.
    reachable: 0,
  };
  for (const row of rows) {
    totals[row.state] += 1;
    if ((row.phone ?? "").trim() !== "") totals.reachable += 1;
  }
  return { rows, totals };
}
