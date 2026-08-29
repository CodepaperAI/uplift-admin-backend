import { Prisma } from "@prisma/client";
import { classifyEntryPath, type InvoiceFact } from "./entry-path";
import {
  classifyCountry,
  classifyPlanTag,
  stageFromPaymentState,
  type PlanTag,
  type SignupCountry,
  type SignupStage,
} from "./signup-segments";

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
  /**
   * Live subscription whose payment is failing — Stripe `past_due` or `unpaid`.
   *
   * Its own state rather than folded into `paid`. These accounts had reached a
   * settled invoice at some point, so the entry-path classifier read them as
   * customers and the Active tile counted them as revenue that is arriving. It
   * is not arriving: the card is being declined right now. Counting a declining
   * card as active revenue is how a churn problem stays invisible until the
   * subscription is gone, and it is precisely who a rep should ring today.
   *
   * Distinct from `pending`, which is a subscription whose first charge has not
   * come due yet. That distinction is the whole reason `nextBillAt` is carried,
   * and it survives here: `pending` is waiting, this has already failed.
   */
  | "payment_failed"
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
  /** Funnel stage, plan and country — the three things a rep slices by. */
  stage: SignupStage;
  planTag: PlanTag;
  country: SignupCountry;
  /** Which source placed them, so a country can be trusted or questioned. */
  countrySource: "business" | "phone" | null;
};

export type SignupSubscriptionFact = {
  userId: string | null;
  status: string;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
  stripeSubscriptionId: string;
  /** When Stripe next bills them. The first bill, for a brand-new signup. */
  currentPeriodEnd: Date | null;
  /** Which Stripe prices the subscription carries, for the plan tag. */
  stripePriceIds?: string[];
};

const ENDED_STATUSES = new Set([
  "canceled",
  "cancelled",
  "incomplete_expired",
]);

/**
 * Stripe statuses that mean the money is not arriving.
 *
 * `past_due` is a renewal whose charge failed and is still being retried;
 * `unpaid` is one Stripe has stopped retrying. Neither is ended, so both stay
 * live for `decidingSubscription` — someone who re-subscribed after a failure
 * is still a customer, and the live row should win.
 */
const PAYMENT_FAILED_STATUSES = new Set(["past_due", "unpaid"]);

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
    {
      businessName: string;
      businessWebsiteUrl: string;
      businessCountry?: string | null;
    }[]
  >;
  socialPriceIds?: ReadonlySet<string>;
  annualPriceIds?: ReadonlySet<string>;
  subscriptionsByUser: ReadonlyMap<string, SignupSubscriptionFact[]>;
  invoicesBySubscription: ReadonlyMap<string, InvoiceFact[]>;
  planNameBySubscription?: ReadonlyMap<string, string | null>;
}): { rows: SignupRow[]; totals: Record<SignupPaymentState | "signups" | "reachable", number> } {
  const socialPriceIds = input.socialPriceIds ?? new Set<string>();
  const annualPriceIds = input.annualPriceIds ?? new Set<string>();

  const rows: SignupRow[] = input.users
    .map((user): SignupRow => {
      const businesses = input.businessesByUser.get(user.id) ?? [];
      const primary = businesses[0] ?? null;
      const subscription = decidingSubscription(
        input.subscriptionsByUser.get(user.id) ?? [],
      );

      /**
       * The payment state, decided first and once.
       *
       * It used to be returned from five separate branches, which meant every
       * field derived *from* it had to be repeated five times — and the next
       * field added would have been forgotten in one of them. Now the branches
       * only pick a state and the row is assembled once.
       */
      const entry = subscription
        ? classifyEntryPath({
            invoices:
              input.invoicesBySubscription.get(
                subscription.stripeSubscriptionId,
              ) ?? [],
            recurringMinor: subscription.monthlyRecurringMinor,
          })
        : null;
      const state: SignupPaymentState = !subscription
        ? "none"
        : ENDED_STATUSES.has(subscription.status)
          ? "cancelled"
          : // Checked before the entry path, deliberately. A failing card
            // usually belongs to someone who *has* paid before, so the entry
            // classifier would read them as a customer and the failure would
            // never surface.
            PAYMENT_FAILED_STATUSES.has(subscription.status)
            ? "payment_failed"
            : entry === null || entry.route === "none" || entry.route === "unknown"
              ? "pending"
              : entry.reachedFullPrice
                ? "paid"
                : entry.route === "trial"
                  ? "trial"
                  : "discounted";

      // The country of the first business they built, falling back to their
      // dialling code. A business with no country set is not an answer, so the
      // fallback still runs.
      const located = classifyCountry({
        businessCountry:
          businesses.find((business) => (business.businessCountry ?? "").trim())
            ?.businessCountry ?? null,
        phone: user.phone,
      });
      const billAt = subscription?.currentPeriodEnd ?? null;
      // Measured from signup, not from now: the question is how long a window
      // this subscription opened with, which does not change as the day passes.
      const daysToNextBill = billAt
        ? Math.round((billAt.getTime() - user.createdAt.getTime()) / 86_400_000)
        : null;
      const stage = stageFromPaymentState(state, daysToNextBill);

      return {
        userId: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        businessName: primary?.businessName ?? null,
        websiteUrl: primary?.businessWebsiteUrl ?? null,
        signedUpAt: user.createdAt.toISOString(),
        hasBusiness: businesses.length > 0,
        nextBillAt: billAt ? billAt.toISOString() : null,
        daysToNextBill,
        state,
        stage,
        planTag: classifyPlanTag({
          stage,
          priceIds: subscription?.stripePriceIds ?? [],
          socialPriceIds,
          annualPriceIds,
          hasSubscription: subscription !== null,
        }),
        country: located.country,
        countrySource: located.source,
        firstPaidMinor: entry?.firstPaidMinor ?? null,
        mrrMinor: subscription
          ? subscription.monthlyRecurringMinor.toFixed(0)
          : null,
        currency: subscription
          ? (subscription.currency ?? entry?.currency ?? null)
          : null,
        planName: subscription
          ? (input.planNameBySubscription?.get(
              subscription.stripeSubscriptionId,
            ) ?? null)
          : null,
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
    payment_failed: 0,
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
