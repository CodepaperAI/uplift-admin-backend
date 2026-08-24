import type Stripe from "stripe";

const ANCHORED_PAID_INTRO_MODE = "one_time_fee_anchor_v2";
const STRIPE_TRIAL_PAID_INTRO_MODE = "one_time_fee_trial_v1";
const LEGACY_PAID_INTRO_MODE = "recurring_schedule_v1";
const MANAGED_PLAN_CHANGE_SCHEDULE = "uplift_plan_change_v1";

export type SubscriptionBillingPeriod = "monthly" | "yearly";
export type SubscriptionPlanTier = "SEO" | "SEO_SOCIAL";

type MetadataLike = Stripe.Metadata | Record<string, string | null | undefined> | null;
type PlanChangeStripeClient = Pick<
  Stripe,
  "prices" | "subscriptionSchedules" | "subscriptions"
>;

function metadataString(metadata: MetadataLike | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataTimestamp(metadata: MetadataLike | undefined, key: string) {
  const value = metadataString(metadata, key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function paidIntroMode(metadata: MetadataLike | undefined) {
  if (metadataString(metadata, "checkoutFlow") !== "onboarding_v2_trial") {
    return null;
  }
  const mode = metadataString(metadata, "paidIntroMode");
  return [
    ANCHORED_PAID_INTRO_MODE,
    STRIPE_TRIAL_PAID_INTRO_MODE,
    LEGACY_PAID_INTRO_MODE,
  ].includes(mode ?? "")
    ? mode
    : null;
}

export function stripePlanTargetPriceId(subscription: Stripe.Subscription) {
  return paidIntroMode(subscription.metadata)
    ? metadataString(subscription.metadata, "recurringPriceId")
    : null;
}

export function isStripePaidIntroPeriod(subscription: Stripe.Subscription) {
  const mode = paidIntroMode(subscription.metadata);
  if (!mode) return false;
  if (mode === ANCHORED_PAID_INTRO_MODE) {
    const end = metadataTimestamp(subscription.metadata, "paidIntroEndAt");
    return subscription.status === "active" && end !== null && Date.now() < end * 1000;
  }
  if (mode === STRIPE_TRIAL_PAID_INTRO_MODE) {
    return subscription.status === "trialing" && subscription.trial_end !== null;
  }
  if (subscription.status !== "active") return false;
  const introPriceId = metadataString(subscription.metadata, "trialFeePriceId");
  return Boolean(
    introPriceId &&
      subscription.items.data.some((item) => item.price.id === introPriceId),
  );
}

export function stripePaidIntroDates(subscription: Stripe.Subscription) {
  if (!isStripePaidIntroPeriod(subscription)) return null;
  const mode = paidIntroMode(subscription.metadata);
  if (mode === ANCHORED_PAID_INTRO_MODE) {
    const start = metadataTimestamp(subscription.metadata, "paidIntroStartAt");
    const end = metadataTimestamp(subscription.metadata, "paidIntroEndAt");
    return {
      start: start === null ? null : new Date(start * 1000),
      end: end === null ? null : new Date(end * 1000),
    };
  }
  if (mode === STRIPE_TRIAL_PAID_INTRO_MODE) {
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
  ) as (Stripe.SubscriptionItem & {
    current_period_start?: number | null;
    current_period_end?: number | null;
  }) | undefined;
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

function scheduleId(value: Stripe.Subscription["schedule"]) {
  return typeof value === "string" ? value : value?.id ?? null;
}

export function stripeSubscriptionScheduleId(subscription: Stripe.Subscription) {
  return scheduleId(subscription.schedule);
}

export function isSubscriptionDowngrade(input: {
  currentPlanTier: SubscriptionPlanTier;
  currentBillingPeriod: SubscriptionBillingPeriod;
  targetPlanTier: SubscriptionPlanTier;
  targetBillingPeriod: SubscriptionBillingPeriod;
}) {
  const removesSocial =
    input.currentPlanTier === "SEO_SOCIAL" && input.targetPlanTier === "SEO";
  const shortensCommitment =
    input.currentBillingPeriod === "yearly" &&
    input.targetBillingPeriod === "monthly";
  return removesSocial || shortensCommitment;
}

function priceId(value: string | Stripe.Price | Stripe.DeletedPrice) {
  return typeof value === "string" ? value : value.id;
}

function currentPhase(schedule: Stripe.SubscriptionSchedule) {
  const current = schedule.current_phase;
  const phase = current
    ? schedule.phases.find(
        (candidate) =>
          candidate.start_date === current.start_date &&
          candidate.end_date === current.end_date,
      )
    : schedule.phases[0];
  if (!phase) throw new Error("PAID_INTRO_SCHEDULE_INVALID");
  return phase;
}

function scheduleDiscounts(phase: Stripe.SubscriptionSchedule.Phase) {
  const discounts: Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] = [];
  for (const entry of phase.discounts) {
    const discount =
      typeof entry.discount === "string" ? entry.discount : entry.discount?.id;
    if (discount) {
      discounts.push({ discount });
      continue;
    }
    const promotionCode =
      typeof entry.promotion_code === "string"
        ? entry.promotion_code
        : entry.promotion_code?.id;
    if (promotionCode) {
      discounts.push({ promotion_code: promotionCode });
      continue;
    }
    const coupon =
      typeof entry.coupon === "string" ? entry.coupon : entry.coupon?.id;
    if (coupon) discounts.push({ coupon });
  }
  return discounts.length ? discounts : undefined;
}

function scheduleItems(phase: Stripe.SubscriptionSchedule.Phase) {
  return phase.items.map((item) => {
    const discounts = phaseItemDiscounts(item);
    const taxRates = phaseItemTaxRates(item);
    return {
      price: priceId(item.price),
      quantity: item.quantity ?? 1,
      ...(item.metadata && Object.keys(item.metadata).length
        ? { metadata: item.metadata }
        : {}),
      ...(discounts ? { discounts } : {}),
      ...(taxRates ? { tax_rates: taxRates } : {}),
    };
  });
}

function phaseItemDiscounts(item: Stripe.SubscriptionSchedule.Phase.Item) {
  const discounts: Stripe.SubscriptionScheduleUpdateParams.Phase.Item.Discount[] = [];
  for (const entry of item.discounts ?? []) {
    const discount =
      typeof entry.discount === "string" ? entry.discount : entry.discount?.id;
    if (discount) {
      discounts.push({ discount });
      continue;
    }
    const promotionCode =
      typeof entry.promotion_code === "string"
        ? entry.promotion_code
        : entry.promotion_code?.id;
    if (promotionCode) {
      discounts.push({ promotion_code: promotionCode });
      continue;
    }
    const coupon = typeof entry.coupon === "string" ? entry.coupon : entry.coupon?.id;
    if (coupon) discounts.push({ coupon });
  }
  return discounts.length ? discounts : undefined;
}

function phaseItemTaxRates(item: Stripe.SubscriptionSchedule.Phase.Item) {
  const taxRates = (item.tax_rates ?? []).map((taxRate) =>
    typeof taxRate === "string" ? taxRate : taxRate.id,
  );
  return taxRates.length ? taxRates : undefined;
}

function scheduledPhaseItems(
  phase: Stripe.SubscriptionSchedule.Phase,
  input: {
    businessId: string;
    currentPriceId: string;
    targetPriceId: string;
  },
) {
  const exactBusinessMatches = phase.items.filter(
    (item) => metadataString(item.metadata, "businessId") === input.businessId,
  );
  const currentPriceMatches = phase.items.filter(
    (item) => priceId(item.price) === input.currentPriceId,
  );
  const replaceByBusiness = exactBusinessMatches.length === 1;
  const replaceByPrice = !replaceByBusiness && currentPriceMatches.length === 1;
  const replaceOnlyItem =
    !replaceByBusiness && !replaceByPrice && phase.items.length === 1;
  let replaced = 0;
  const items = phase.items.map((item) => {
    const shouldReplace = replaceByBusiness
      ? metadataString(item.metadata, "businessId") === input.businessId
      : replaceByPrice
        ? priceId(item.price) === input.currentPriceId
        : replaceOnlyItem;
    if (shouldReplace) replaced += 1;
    const discounts = phaseItemDiscounts(item);
    const taxRates = phaseItemTaxRates(item);
    return {
      price: shouldReplace ? input.targetPriceId : priceId(item.price),
      quantity: item.quantity ?? 1,
      ...(item.metadata && Object.keys(item.metadata).length
        ? {
            metadata: shouldReplace
              ? { ...item.metadata, businessId: input.businessId }
              : item.metadata,
          }
        : shouldReplace
          ? { metadata: { businessId: input.businessId } }
          : {}),
      ...(discounts ? { discounts } : {}),
      ...(taxRates ? { tax_rates: taxRates } : {}),
    };
  });
  if (replaced !== 1) throw new Error("PLAN_CHANGE_ITEM_AMBIGUOUS");
  return items;
}

function targetDuration(price: Stripe.Price) {
  const recurring = price.recurring;
  if (!recurring || !["day", "week", "month", "year"].includes(recurring.interval)) {
    throw new Error("TARGET_PRICE_INTERVAL_INVALID");
  }
  return {
    interval: recurring.interval as "day" | "week" | "month" | "year",
    interval_count: recurring.interval_count,
  };
}

function assertManagedPlanSchedule(
  schedule: Stripe.SubscriptionSchedule,
  input: { businessId: string; subscriptionId: string },
) {
  if (
    metadataString(schedule.metadata, "kind") !== MANAGED_PLAN_CHANGE_SCHEDULE ||
    metadataString(schedule.metadata, "businessId") !== input.businessId ||
    metadataString(schedule.metadata, "subscriptionId") !== input.subscriptionId
  ) {
    throw new Error("PLAN_CHANGE_SCHEDULE_CONFLICT");
  }
}

export async function scheduleStripeSubscriptionPlanChange(
  client: PlanChangeStripeClient,
  subscription: Stripe.Subscription,
  input: {
    businessId: string;
    currentPriceId: string;
    targetPrice: Stripe.Price;
    targetPlanTier: SubscriptionPlanTier;
    targetBillingPeriod: SubscriptionBillingPeriod;
  },
) {
  if (subscription.status !== "active" || isStripePaidIntroPeriod(subscription)) {
    throw new Error("PLAN_CHANGE_SCHEDULE_UNAVAILABLE");
  }

  let schedule: Stripe.SubscriptionSchedule;
  const existingScheduleId = scheduleId(subscription.schedule);
  if (existingScheduleId) {
    schedule = await client.subscriptionSchedules.retrieve(existingScheduleId);
    assertManagedPlanSchedule(schedule, {
      businessId: input.businessId,
      subscriptionId: subscription.id,
    });
  } else {
    schedule = await client.subscriptionSchedules.create(
      { from_subscription: subscription.id },
      {
        idempotencyKey: `plan-change-schedule:${subscription.id}:${input.businessId}`,
      },
    );
  }

  const phase = currentPhase(schedule);
  const effectiveAt = new Date(phase.end_date * 1000);
  if (!Number.isFinite(effectiveAt.getTime()) || effectiveAt.getTime() <= Date.now()) {
    throw new Error("PLAN_CHANGE_EFFECTIVE_DATE_INVALID");
  }
  const discounts = scheduleDiscounts(phase);
  const currentMetadata = { ...subscription.metadata };
  const nextMetadata = {
    ...subscription.metadata,
    businessId: input.businessId,
    planTier: input.targetPlanTier,
  };
  const futureItems = scheduledPhaseItems(phase, {
    businessId: input.businessId,
    currentPriceId: input.currentPriceId,
    targetPriceId: input.targetPrice.id,
  });

  const updated = await client.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      metadata: {
        kind: MANAGED_PLAN_CHANGE_SCHEDULE,
        businessId: input.businessId,
        subscriptionId: subscription.id,
        targetPlanTier: input.targetPlanTier,
        targetBillingPeriod: input.targetBillingPeriod,
        targetPriceId: input.targetPrice.id,
        effectiveAt: String(Math.floor(effectiveAt.getTime() / 1000)),
      },
      proration_behavior: "none",
      phases: [
        {
          start_date: phase.start_date,
          end_date: phase.end_date,
          items: scheduleItems(phase),
          metadata: currentMetadata,
          proration_behavior: "none",
          ...(discounts ? { discounts } : {}),
        },
        {
          start_date: phase.end_date,
          duration: targetDuration(input.targetPrice),
          billing_cycle_anchor: "phase_start",
          items: futureItems,
          metadata: nextMetadata,
          proration_behavior: "none",
          ...(discounts ? { discounts } : {}),
        },
      ],
    },
    {
      idempotencyKey: `plan-change-phase:${subscription.id}:${input.businessId}:${input.targetPrice.id}:${phase.end_date}`,
    },
  );

  return { schedule: updated, effectiveAt };
}

export async function releaseStripeSubscriptionPlanChange(
  client: PlanChangeStripeClient,
  input: {
    scheduleId: string;
    businessId: string;
    subscriptionId: string;
  },
) {
  const schedule = await client.subscriptionSchedules.retrieve(input.scheduleId);
  assertManagedPlanSchedule(schedule, input);
  if (schedule.status === "active" || schedule.status === "not_started") {
    await client.subscriptionSchedules.release(
      schedule.id,
      {},
      { idempotencyKey: `release-plan-change:${schedule.id}` },
    );
  }
}

async function updateLegacyPaidIntroSchedule(
  client: PlanChangeStripeClient,
  subscription: Stripe.Subscription,
  targetPriceId: string,
) {
  const targetPrice = await client.prices.retrieve(targetPriceId);
  if (!targetPrice.active || targetPrice.type !== "recurring" || !targetPrice.recurring) {
    throw new Error("TARGET_PRICE_INVALID");
  }
  const interval = targetPrice.recurring.interval;
  if (!["day", "week", "month", "year"].includes(interval)) {
    throw new Error("TARGET_PRICE_INTERVAL_INVALID");
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
          paidIntroMode: ANCHORED_PAID_INTRO_MODE,
          recurringPriceId: targetPriceId,
        },
      },
      { idempotencyKey: `onboarding-v2-paid-intro:${subscription.id}` },
    );
  }
  const phase = currentPhase(schedule);
  const alreadyScheduled = schedule.phases.some(
    (candidate) =>
      candidate.start_date === phase.end_date &&
      candidate.items.some((item) => priceId(item.price) === targetPriceId),
  );
  if (alreadyScheduled) return;
  const discounts = scheduleDiscounts(phase);
  const metadata = {
    ...subscription.metadata,
    paidIntroMode: ANCHORED_PAID_INTRO_MODE,
    recurringPriceId: targetPriceId,
  };
  const businessId = metadataString(subscription.metadata, "businessId");
  await client.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      metadata: {
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: ANCHORED_PAID_INTRO_MODE,
        recurringPriceId: targetPriceId,
      },
      proration_behavior: "none",
      phases: [
        {
          start_date: phase.start_date,
          end_date: phase.end_date,
          items: scheduleItems(phase),
          metadata,
          proration_behavior: "none",
          ...(discounts ? { discounts } : {}),
        },
        {
          start_date: phase.end_date,
          duration: {
            interval: interval as "day" | "week" | "month" | "year",
            interval_count: targetPrice.recurring.interval_count,
          },
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

export async function changeStripeSubscriptionPlan(
  client: PlanChangeStripeClient,
  subscription: Stripe.Subscription,
  input: {
    businessId: string;
    itemId: string;
    planTier: "SEO" | "SEO_SOCIAL";
    priceId: string;
  },
) {
  const metadata = {
    ...subscription.metadata,
    businessId: input.businessId,
    planTier: input.planTier,
    ...(isStripePaidIntroPeriod(subscription)
      ? { recurringPriceId: input.priceId }
      : {}),
  };
  const mode = paidIntroMode(subscription.metadata);
  if (isStripePaidIntroPeriod(subscription) && mode === LEGACY_PAID_INTRO_MODE) {
    const updated = await client.subscriptions.update(
      subscription.id,
      { metadata },
      {
        idempotencyKey: `onboarding-v2-paid-intro-target:${subscription.id}:${input.priceId}`,
      },
    );
    await updateLegacyPaidIntroSchedule(client, updated, input.priceId);
    return updated;
  }

  return client.subscriptions.update(
    subscription.id,
    {
      items: [{ id: input.itemId, price: input.priceId, discounts: [] }],
      discounts: [],
      proration_behavior:
        isStripePaidIntroPeriod(subscription) || subscription.status === "trialing"
          ? "none"
          : "always_invoice",
      metadata,
    },
    {
      idempotencyKey: `change-plan:${subscription.id}:${input.itemId}:${input.priceId}`,
    },
  );
}
