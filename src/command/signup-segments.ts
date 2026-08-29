/**
 * The three things a rep wants to slice signups by: stage, plan, and country.
 *
 * All three are derived, because none of them is stored. There is no funnel
 * column, no plan tag, and no country on the user — so each is computed from
 * what the product does record, and each reports when it cannot tell.
 */

/**
 * Where someone is in the funnel.
 *
 * Deliberately five, not the four the funnel is usually described as. "Signed
 * up and never started a trial" and "started a subscription that has not been
 * billed yet" look identical if you only ask "have they paid" — and they need
 * opposite handling, since the first is a sales call and the second is a wait.
 */
export type SignupStage =
  /** Account exists, no subscription ever. Left before or at the trial screen. */
  | "signed_up"
  /** On the token trial charge, full price not yet billed. */
  | "trial"
  /** Has paid a real plan price — full or discounted. */
  | "active"
  /** Subscription exists, nothing billed yet. Usually an intro period. */
  | "unbilled"
  /** Had a subscription; it has ended. */
  | "churned"
  /**
   * Live subscription whose payment is failing — past due or unpaid.
   *
   * Kept apart from `churned` even though both count toward churn on the
   * signups page, because they need opposite calls: a cancellation is a
   * decision already made, a failed card is usually a card, and the second is
   * recoverable in a way the first is not.
   */
  | "payment_failed";

/** The product they are on, once they have a subscription at all. */
export type PlanTag =
  | "trial"
  | "core_monthly"
  | "core_annual"
  | "social_monthly"
  | "social_annual"
  | "other"
  /** No subscription, so no plan. */
  | "none";

export type SignupCountry = "india" | "rest_of_world" | "unknown";

/** The payment state the signups builder already derives. */
export type PaymentStateForStage =
  | "paid"
  | "trial"
  | "discounted"
  | "pending"
  | "cancelled"
  | "payment_failed"
  | "none";

/**
 * How short a first billing window has to be to mean "introductory period".
 *
 * Every established subscription on the book renews in 31, 34 or 365 days. So a
 * first bill a few days out is not a normal cycle — it is an opening window, and
 * it is the only thing separating a subscription waiting on its first charge
 * from one whose card has failed. Those need opposite responses from a rep.
 *
 * Seven rather than the three days observed, because the number to pick is the
 * gap between the shortest plausible intro window and the shortest real cycle,
 * and there is three and a half weeks of daylight in between.
 */
export const INTRO_PERIOD_MAX_DAYS = 7;

export function isIntroPeriod(daysToNextBill: number | null): boolean {
  return (
    daysToNextBill !== null &&
    daysToNextBill > 0 &&
    daysToNextBill <= INTRO_PERIOD_MAX_DAYS
  );
}

/**
 * The funnel stage for a payment state.
 *
 * `daysToNextBill` is required rather than optional on purpose. A `pending`
 * subscription is either mid-trial or mid-failure depending on it, and the two
 * were reported identically for as long as this took only the state: on
 * 2026-08-26, ten accounts on $99 and $149 plans — every one of them billing
 * three days out, with no invoice yet — were counted as neither paid nor
 * trialling, so a day with ten trials on it read as zero. An optional argument
 * would have let the next caller reintroduce that silently.
 */
export function stageFromPaymentState(
  state: PaymentStateForStage,
  daysToNextBill: number | null,
): SignupStage {
  switch (state) {
    case "none":
      return "signed_up";
    case "trial":
      return "trial";
    // A coupon is a real payment. From the funnel's point of view somebody
    // paying $74 a month is a customer, not a prospect; the discount is a
    // margin question and it stays visible in the plan tag and the amount.
    case "paid":
    case "discounted":
      return "active";
    // Live, nothing settled yet. A short window means the opening charge has
    // not come due; anything longer is a subscription that should have billed
    // and has not, which is a different conversation.
    case "pending":
      return isIntroPeriod(daysToNextBill) ? "trial" : "unbilled";
    case "cancelled":
      return "churned";
    case "payment_failed":
      return "payment_failed";
  }
}

export function classifyPlanTag(input: {
  stage: SignupStage;
  priceIds: readonly string[];
  socialPriceIds: ReadonlySet<string>;
  annualPriceIds: ReadonlySet<string>;
  hasSubscription: boolean;
}): PlanTag {
  if (!input.hasSubscription) return "none";
  // On the trial charge the plan they will convert *to* is not what they are
  // paying for yet, so the tag says trial and the plan shows once it bills.
  if (input.stage === "trial") return "trial";
  /**
   * One price decides the tag, and the same price decides its billing period.
   *
   * Reading "is it annual" across every price on the subscription gets a
   * multi-item subscription wrong: core-annual alongside social-monthly would
   * come out "social annual", which describes neither item. Social wins when
   * present because it is the higher tier, and its own period is then the one
   * reported.
   */
  const defining =
    input.priceIds.find((id) => input.socialPriceIds.has(id)) ??
    input.priceIds.find((id) => input.annualPriceIds.has(id)) ??
    null;
  // A price we do not recognise is reported as such rather than guessed into
  // the core bucket — that is how the whole SEO+Social line once disappeared.
  if (defining === null) return "other";
  const isSocial = input.socialPriceIds.has(defining);
  const isAnnual = input.annualPriceIds.has(defining);
  if (isSocial) return isAnnual ? "social_annual" : "social_monthly";
  return isAnnual ? "core_annual" : "core_monthly";
}

/**
 * India, or not India.
 *
 * Two sources in order of trust: the country on the business they built, then
 * the dialling code on their phone number. A business address is a statement
 * about where they trade; a phone number is a decent proxy and, in practice,
 * the only signal most signups leave. Anything with neither is `unknown` rather
 * than being swept into "rest of world", which would quietly inflate it.
 */
const INDIA_NAMES = new Set([
  "in",
  "ind",
  "india",
  "bharat",
  "republic of india",
]);

export function classifyCountry(input: {
  businessCountry?: string | null;
  phone?: string | null;
}): { country: SignupCountry; source: "business" | "phone" | null } {
  const declared = input.businessCountry?.trim().toLowerCase();
  if (declared) {
    return {
      country: INDIA_NAMES.has(declared) ? "india" : "rest_of_world",
      source: "business",
    };
  }

  const digits = (input.phone ?? "").replace(/[^\d+]/g, "");
  if (digits === "") return { country: "unknown", source: null };
  // Only an explicitly international number can be read for country. A bare
  // ten-digit number could be Toronto or Mumbai, and guessing would put real
  // Canadian customers in the India bucket.
  if (!digits.startsWith("+")) return { country: "unknown", source: null };
  return {
    country: digits.startsWith("+91") ? "india" : "rest_of_world",
    source: "phone",
  };
}

export const SIGNUP_STAGE_KEYS: SignupStage[] = [
  "signed_up",
  "trial",
  "active",
  "unbilled",
  "payment_failed",
  "churned",
];

export const PLAN_TAG_KEYS: PlanTag[] = [
  "trial",
  "core_monthly",
  "social_monthly",
  "core_annual",
  "social_annual",
  "other",
  "none",
];

export type SegmentTotals = {
  stage: Record<SignupStage, number>;
  plan: Record<PlanTag, number>;
  country: Record<SignupCountry, number>;
};

export function emptySegmentTotals(): SegmentTotals {
  return {
    stage: {
      signed_up: 0,
      trial: 0,
      active: 0,
      unbilled: 0,
      payment_failed: 0,
      churned: 0,
    },
    plan: {
      trial: 0,
      core_monthly: 0,
      core_annual: 0,
      social_monthly: 0,
      social_annual: 0,
      other: 0,
      none: 0,
    },
    country: { india: 0, rest_of_world: 0, unknown: 0 },
  };
}

export function tallySegments(
  rows: readonly {
    stage: SignupStage;
    planTag: PlanTag;
    country: SignupCountry;
  }[],
): SegmentTotals {
  const totals = emptySegmentTotals();
  for (const row of rows) {
    totals.stage[row.stage] += 1;
    totals.plan[row.planTag] += 1;
    totals.country[row.country] += 1;
  }
  return totals;
}
