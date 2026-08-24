import type Stripe from "stripe";

export const ONBOARDING_V2_PAID_INTRO_MODE = "one_time_fee_anchor_v2" as const;

const STRIPE_TRIAL_ONBOARDING_V2_PAID_INTRO_MODE =
  "one_time_fee_trial_v1" as const;

const LEGACY_ONBOARDING_V2_PAID_INTRO_MODE = "recurring_schedule_v1" as const;

type StripeMetadataLike =
  | Record<string, string | null | undefined>
  | Stripe.Metadata
  | null
  | undefined;

type PaidIntroStripeClient = Pick<
  Stripe,
  "prices" | "subscriptionSchedules" | "subscriptions"
>;

type PaidIntroProvisioningStripeClient = Pick<
  Stripe,
  "paymentIntents" | "subscriptions"
>;

const PAID_INTRO_SECONDS = 3 * 24 * 60 * 60;

function metadataString(
  metadata: StripeMetadataLike,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function priceId(price: string | Stripe.Price | Stripe.DeletedPrice): string {
  return typeof price === "string" ? price : price.id;
}

function objectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function metadataTimestamp(
  metadata: StripeMetadataLike,
  key: string,
): number | null {
  const value = metadataString(metadata, key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isAnchoredOnboardingV2PaidIntroMetadata(
  metadata: StripeMetadataLike,
): boolean {
  return (
    metadataString(metadata, "checkoutFlow") === "onboarding_v2_trial" &&
    metadataString(metadata, "paidIntroMode") === ONBOARDING_V2_PAID_INTRO_MODE
  );
}

function phaseDiscounts(
  discounts: Stripe.SubscriptionSchedule.Phase.Discount[],
): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] | undefined {
  const normalized: Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] =
    [];
  for (const entry of discounts) {
    const discount = objectId(entry.discount);
    if (discount) {
      normalized.push({ discount });
      continue;
    }
    const promotionCode = objectId(entry.promotion_code);
    if (promotionCode) {
      normalized.push({ promotion_code: promotionCode });
      continue;
    }
    const coupon = objectId(entry.coupon);
    if (coupon) normalized.push({ coupon });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function isOnboardingV2PaidIntroMetadata(
  metadata: StripeMetadataLike,
): boolean {
  const mode = metadataString(metadata, "paidIntroMode");
  return (
    metadataString(metadata, "checkoutFlow") === "onboarding_v2_trial" &&
    (mode === ONBOARDING_V2_PAID_INTRO_MODE ||
      mode === STRIPE_TRIAL_ONBOARDING_V2_PAID_INTRO_MODE ||
      mode === LEGACY_ONBOARDING_V2_PAID_INTRO_MODE)
  );
}

function isLegacyOnboardingV2PaidIntroMetadata(
  metadata: StripeMetadataLike,
): boolean {
  return (
    metadataString(metadata, "checkoutFlow") === "onboarding_v2_trial" &&
    metadataString(metadata, "paidIntroMode") ===
      LEGACY_ONBOARDING_V2_PAID_INTRO_MODE
  );
}

export function getOnboardingV2TargetPriceId(
  metadata: StripeMetadataLike,
): string | null {
  return isOnboardingV2PaidIntroMetadata(metadata)
    ? metadataString(metadata, "recurringPriceId")
    : null;
}

export function isOnboardingV2PaidIntroPeriod(
  subscription: Pick<
    Stripe.Subscription,
    "items" | "metadata" | "status" | "trial_end" | "trial_start"
  >,
): boolean {
  if (!isOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    return false;
  }

  if (isAnchoredOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    const paidIntroEndAt = metadataTimestamp(
      subscription.metadata,
      "paidIntroEndAt",
    );
    return (
      subscription.status === "active" &&
      paidIntroEndAt != null &&
      Math.floor(Date.now() / 1000) < paidIntroEndAt
    );
  }

  if (!isLegacyOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    return subscription.status === "trialing" && subscription.trial_end != null;
  }

  if (subscription.status !== "active") return false;

  const introPriceId = metadataString(subscription.metadata, "trialFeePriceId");
  return Boolean(
    introPriceId &&
    subscription.items.data.some((item) => item.price.id === introPriceId),
  );
}

export function getOnboardingV2PaidIntroPeriodDates(
  subscription: Pick<
    Stripe.Subscription,
    "items" | "metadata" | "status" | "trial_end" | "trial_start"
  >,
): { start: Date | null; end: Date | null } | null {
  if (!isOnboardingV2PaidIntroPeriod(subscription)) return null;

  if (isAnchoredOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    const start = metadataTimestamp(subscription.metadata, "paidIntroStartAt");
    const end = metadataTimestamp(subscription.metadata, "paidIntroEndAt");
    return {
      start: start == null ? null : new Date(start * 1000),
      end: end == null ? null : new Date(end * 1000),
    };
  }

  if (!isLegacyOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    return {
      start:
        typeof subscription.trial_start === "number"
          ? new Date(subscription.trial_start * 1000)
          : null,
      end:
        typeof subscription.trial_end === "number"
          ? new Date(subscription.trial_end * 1000)
          : null,
    };
  }

  const introPriceId = metadataString(subscription.metadata, "trialFeePriceId");
  const item = subscription.items.data.find(
    (candidate) => candidate.price.id === introPriceId,
  ) as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number | null;
        current_period_end?: number | null;
      })
    | undefined;

  return {
    start:
      typeof item?.current_period_start === "number"
        ? new Date(item.current_period_start * 1000)
        : null,
    end:
      typeof item?.current_period_end === "number"
        ? new Date(item.current_period_end * 1000)
        : null,
  };
}

function paidIntroPaymentIntent(
  value: string | Stripe.PaymentIntent | null,
): Stripe.PaymentIntent | null {
  return value && typeof value !== "string" ? value : null;
}

function paidIntroStartTimestamp(paymentIntent: Stripe.PaymentIntent): number {
  const latestCharge = paymentIntent.latest_charge;
  if (
    latestCharge &&
    typeof latestCharge !== "string" &&
    typeof latestCharge.created === "number"
  ) {
    return latestCharge.created;
  }
  return paymentIntent.created;
}

/**
 * Creates the post-intro recurring subscription after the one-time $3 Checkout
 * payment. The first invoice is anchored three days in the future with no
 * proration, so Stripe keeps the subscription active instead of labelling it
 * as a free trial in Checkout, invoices, and the customer portal.
 */
export async function ensureOnboardingV2PaidIntroSubscription(
  client: PaidIntroProvisioningStripeClient,
  checkoutSession: Stripe.Checkout.Session,
): Promise<Stripe.Subscription> {
  if (
    checkoutSession.mode !== "payment" ||
    !isAnchoredOnboardingV2PaidIntroMetadata(checkoutSession.metadata)
  ) {
    throw new Error("Checkout session is not a paid introductory payment");
  }
  if (checkoutSession.payment_status !== "paid") {
    throw new Error("The paid introductory payment has not completed");
  }

  const customerId = objectId(checkoutSession.customer);
  const recurringPriceId = metadataString(
    checkoutSession.metadata,
    "recurringPriceId",
  );
  if (!customerId || !recurringPriceId) {
    throw new Error("Paid introductory subscription configuration is missing");
  }

  const existingSubscriptions = await client.subscriptions.list({
    customer: customerId,
    limit: 100,
    status: "all",
  });
  const existing = existingSubscriptions.data.find(
    (subscription) =>
      metadataString(subscription.metadata, "paidIntroCheckoutSessionId") ===
      checkoutSession.id,
  );
  if (existing) return existing;

  const expandedPaymentIntent = paidIntroPaymentIntent(
    checkoutSession.payment_intent,
  );
  const paymentIntent = expandedPaymentIntent
    ? expandedPaymentIntent
    : typeof checkoutSession.payment_intent === "string"
      ? await client.paymentIntents.retrieve(checkoutSession.payment_intent, {
          expand: ["latest_charge"],
        })
      : null;
  if (!paymentIntent || paymentIntent.status !== "succeeded") {
    throw new Error("Paid introductory PaymentIntent is not available");
  }

  const paymentMethodId = objectId(paymentIntent.payment_method);
  if (!paymentMethodId) {
    throw new Error("Paid introductory payment method is missing");
  }

  const paidIntroStartAt = paidIntroStartTimestamp(paymentIntent);
  const paidIntroEndAt = paidIntroStartAt + PAID_INTRO_SECONDS;
  const metadata = {
    ...normalizeMetadataForStripe(checkoutSession.metadata),
    paidIntroCheckoutSessionId: checkoutSession.id,
    paidIntroEndAt: String(paidIntroEndAt),
    paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
    paidIntroStartAt: String(paidIntroStartAt),
  };
  const businessId = metadataString(metadata, "businessId");

  return client.subscriptions.create(
    {
      billing_cycle_anchor: paidIntroEndAt,
      collection_method: "charge_automatically",
      customer: customerId,
      default_payment_method: paymentMethodId,
      items: [
        {
          price: recurringPriceId,
          quantity: 1,
          ...(businessId ? { metadata: { businessId } } : {}),
        },
      ],
      metadata,
      payment_behavior: "error_if_incomplete",
      proration_behavior: "none",
    },
    {
      idempotencyKey: `onboarding-v2-paid-intro-subscription:${checkoutSession.id}`,
    },
  );
}

function normalizeMetadataForStripe(
  metadata: StripeMetadataLike,
): Record<string, string> {
  if (!metadata) return {};
  return Object.entries(metadata).reduce<Record<string, string>>(
    (result, [key, value]) => {
      if (typeof value === "string" && value.length > 0) result[key] = value;
      return result;
    },
    {},
  );
}

function scheduleId(value: Stripe.Subscription["schedule"]): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function targetDuration(
  price: Stripe.Price,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Duration {
  if (!price.recurring) {
    throw new Error("The selected post-trial Stripe price must be recurring");
  }
  const interval = price.recurring.interval;
  if (
    interval !== "day" &&
    interval !== "week" &&
    interval !== "month" &&
    interval !== "year"
  ) {
    throw new Error("The selected post-trial Stripe interval is unsupported");
  }
  return {
    interval: interval as "day" | "week" | "month" | "year",
    interval_count: price.recurring.interval_count,
  };
}

function currentPhaseFor(
  schedule: Stripe.SubscriptionSchedule,
): Stripe.SubscriptionSchedule.Phase {
  const current = schedule.current_phase;
  const phase = current
    ? schedule.phases.find(
        (candidate) =>
          candidate.start_date === current.start_date &&
          candidate.end_date === current.end_date,
      )
    : schedule.phases[0];
  if (!phase) {
    throw new Error("Stripe did not create a current paid-intro phase");
  }
  return phase;
}

function phaseItems(
  phase: Stripe.SubscriptionSchedule.Phase,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] {
  return phase.items.map((item) => ({
    price: priceId(item.price),
    quantity: item.quantity ?? 1,
    ...(item.metadata && Object.keys(item.metadata).length > 0
      ? { metadata: item.metadata }
      : {}),
  }));
}

function hasCorrectFuturePhase(
  schedule: Stripe.SubscriptionSchedule,
  currentEnd: number,
  targetPriceId: string,
): boolean {
  return schedule.phases.some(
    (phase) =>
      phase.start_date === currentEnd &&
      phase.items.some((item) => priceId(item.price) === targetPriceId),
  );
}

/**
 * Converts the charged $3 / three-day subscription created by Checkout into a
 * two-phase schedule. The second phase begins at the exact paid-intro boundary
 * and uses the plan the customer selected before Checkout.
 */
export async function ensureOnboardingV2PaidIntroSchedule(
  client: PaidIntroStripeClient,
  subscription: Stripe.Subscription,
): Promise<Stripe.SubscriptionSchedule | null> {
  // New checkouts already contain the selected recurring plan with a Stripe
  // trial and charge the $3 one-time line item immediately. Only historical
  // recurring-intro subscriptions need the schedule reconciler below.
  if (
    !isLegacyOnboardingV2PaidIntroMetadata(subscription.metadata) ||
    !isOnboardingV2PaidIntroPeriod(subscription)
  ) {
    return null;
  }

  const targetPriceId = getOnboardingV2TargetPriceId(subscription.metadata);
  if (!targetPriceId) {
    throw new Error("The selected post-trial Stripe price is missing");
  }

  const targetPrice = await client.prices.retrieve(targetPriceId);
  if (!targetPrice.active || targetPrice.type !== "recurring") {
    throw new Error("The selected post-trial Stripe price is not active");
  }

  let schedule: Stripe.SubscriptionSchedule;
  const existingScheduleId = scheduleId(subscription.schedule);
  if (existingScheduleId) {
    schedule = await client.subscriptionSchedules.retrieve(existingScheduleId);
  } else {
    schedule = await client.subscriptionSchedules.create(
      {
        from_subscription: subscription.id,
        metadata: {
          checkoutFlow: "onboarding_v2_trial",
          paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
          recurringPriceId: targetPriceId,
        },
      },
      { idempotencyKey: `onboarding-v2-paid-intro:${subscription.id}` },
    );
  }

  const currentPhase = currentPhaseFor(schedule);
  if (hasCorrectFuturePhase(schedule, currentPhase.end_date, targetPriceId)) {
    return schedule;
  }

  const discounts = phaseDiscounts(currentPhase.discounts);
  const metadata = {
    ...subscription.metadata,
    paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
    recurringPriceId: targetPriceId,
  };
  const businessId = metadataString(subscription.metadata, "businessId");

  return client.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      metadata: {
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
        recurringPriceId: targetPriceId,
      },
      proration_behavior: "none",
      phases: [
        {
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date,
          items: phaseItems(currentPhase),
          metadata,
          proration_behavior: "none",
          ...(discounts ? { discounts } : {}),
        },
        {
          start_date: currentPhase.end_date,
          duration: targetDuration(targetPrice),
          billing_cycle_anchor: "phase_start",
          items: [
            {
              price: targetPriceId,
              quantity: 1,
              ...(businessId ? { metadata: { businessId } } : {}),
            },
          ],
          metadata: { ...metadata, paidIntroCompleted: "true" },
          proration_behavior: "none",
          ...(discounts ? { discounts } : {}),
        },
      ],
    },
    {
      idempotencyKey: `onboarding-v2-paid-intro-phase:${subscription.id}:${targetPriceId}`,
    },
  );
}

export async function updateOnboardingV2PaidIntroTarget(
  client: PaidIntroStripeClient,
  subscription: Stripe.Subscription,
  input: { priceId: string; planTier: string; businessId: string },
): Promise<Stripe.Subscription> {
  if (!isOnboardingV2PaidIntroPeriod(subscription)) {
    throw new Error("Subscription is not in its paid introductory period");
  }

  if (!isLegacyOnboardingV2PaidIntroMetadata(subscription.metadata)) {
    const currentItem = subscription.items.data[0];
    if (!currentItem) {
      throw new Error("The selected recurring subscription item is missing");
    }
    return client.subscriptions.update(
      subscription.id,
      {
        items: [
          {
            id: currentItem.id,
            price: input.priceId,
            discounts: [],
          },
        ],
        discounts: [],
        proration_behavior: "none",
        metadata: {
          ...subscription.metadata,
          businessId: input.businessId,
          planTier: input.planTier,
          recurringPriceId: input.priceId,
        },
      },
      {
        idempotencyKey: `onboarding-v2-paid-intro-target:${subscription.id}:${input.priceId}`,
      },
    );
  }

  const updated = await client.subscriptions.update(
    subscription.id,
    {
      metadata: {
        ...subscription.metadata,
        businessId: input.businessId,
        planTier: input.planTier,
        recurringPriceId: input.priceId,
      },
    },
    {
      idempotencyKey: `onboarding-v2-paid-intro-target:${subscription.id}:${input.priceId}`,
    },
  );
  await ensureOnboardingV2PaidIntroSchedule(client, updated);
  return updated;
}
