import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  changeStripeSubscriptionPlan,
  isSubscriptionDowngrade,
  isStripePaidIntroPeriod,
  releaseStripeSubscriptionPlanChange,
  scheduleStripeSubscriptionPlanChange,
  stripePaidIntroDates,
  stripePlanTargetPriceId,
} from "../services/stripe-plan-change.service";

function subscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: "sub_owned",
    status: "active",
    cancel_at_period_end: false,
    customer: "cus_owned",
    metadata: { userId: "user-owned", businessId: "business-owned" },
    schedule: null,
    trial_start: null,
    trial_end: null,
    items: {
      data: [
        {
          id: "si_owned",
          metadata: { businessId: "business-owned" },
          price: { id: "price_current" },
        } as unknown as Stripe.SubscriptionItem,
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  } as Stripe.Subscription;
}

describe("Stripe plan change service", () => {
  test("classifies feature and commitment reductions as renewal-date changes", () => {
    expect(
      isSubscriptionDowngrade({
        currentPlanTier: "SEO_SOCIAL",
        currentBillingPeriod: "monthly",
        targetPlanTier: "SEO",
        targetBillingPeriod: "monthly",
      }),
    ).toBe(true);
    expect(
      isSubscriptionDowngrade({
        currentPlanTier: "SEO_SOCIAL",
        currentBillingPeriod: "yearly",
        targetPlanTier: "SEO_SOCIAL",
        targetBillingPeriod: "monthly",
      }),
    ).toBe(true);
    expect(
      isSubscriptionDowngrade({
        currentPlanTier: "SEO",
        currentBillingPeriod: "monthly",
        targetPlanTier: "SEO_SOCIAL",
        targetBillingPeriod: "monthly",
      }),
    ).toBe(false);
    expect(
      isSubscriptionDowngrade({
        currentPlanTier: "SEO",
        currentBillingPeriod: "monthly",
        targetPlanTier: "SEO",
        targetBillingPeriod: "yearly",
      }),
    ).toBe(false);
  });

  test("schedules a downgrade after the paid phase without mutating current access", async () => {
    const phaseStart = Math.floor(Date.now() / 1000) - 60;
    const phaseEnd = phaseStart + 30 * 24 * 60 * 60;
    const schedule = {
      id: "sched_change",
      status: "active",
      metadata: {},
      current_phase: { start_date: phaseStart, end_date: phaseEnd },
      phases: [
        {
          start_date: phaseStart,
          end_date: phaseEnd,
          discounts: [],
          items: [
            {
              price: "price_social",
              quantity: 1,
              metadata: { businessId: "business-owned" },
              discounts: [],
              tax_rates: [],
            },
            {
              price: "price_other",
              quantity: 2,
              metadata: { businessId: "business-other" },
              discounts: [],
              tax_rates: [],
            },
          ],
        },
      ],
    } as unknown as Stripe.SubscriptionSchedule;
    const createCalls: Stripe.SubscriptionScheduleCreateParams[] = [];
    const updateCalls: Stripe.SubscriptionScheduleUpdateParams[] = [];
    const client = {
      subscriptionSchedules: {
        create: async (params: Stripe.SubscriptionScheduleCreateParams) => {
          createCalls.push(params);
          return schedule;
        },
        update: async (
          _id: string,
          params: Stripe.SubscriptionScheduleUpdateParams,
        ) => {
          updateCalls.push(params);
          return { ...schedule, metadata: params.metadata };
        },
      },
    } as unknown as Stripe;
    const targetPrice = {
      id: "price_seo",
      active: true,
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    } as Stripe.Price;

    const result = await scheduleStripeSubscriptionPlanChange(
      client,
      subscription(),
      {
        businessId: "business-owned",
        currentPriceId: "price_social",
        targetPrice,
        targetPlanTier: "SEO",
        targetBillingPeriod: "monthly",
      },
    );

    expect(createCalls).toEqual([{ from_subscription: "sub_owned" }]);
    expect(result.effectiveAt.getTime()).toBe(phaseEnd * 1000);
    expect(updateCalls[0]?.proration_behavior).toBe("none");
    expect(updateCalls[0]?.end_behavior).toBe("release");
    expect(updateCalls[0]?.phases?.[0]?.items).toEqual([
      {
        price: "price_social",
        quantity: 1,
        metadata: { businessId: "business-owned" },
      },
      {
        price: "price_other",
        quantity: 2,
        metadata: { businessId: "business-other" },
      },
    ]);
    expect(updateCalls[0]?.phases?.[1]?.items).toEqual([
      {
        price: "price_seo",
        quantity: 1,
        metadata: { businessId: "business-owned" },
      },
      {
        price: "price_other",
        quantity: 2,
        metadata: { businessId: "business-other" },
      },
    ]);
    expect(updateCalls[0]?.phases?.[1]?.proration_behavior).toBe("none");
    expect(updateCalls[0]?.phases?.[1]?.metadata).toMatchObject({
      planTier: "SEO",
      businessId: "business-owned",
    });
  });

  test("refuses to overwrite a schedule that is not owned by the plan manager", async () => {
    const existing = subscription({ schedule: "sched_external" });
    const client = {
      subscriptionSchedules: {
        retrieve: async () => ({
          id: "sched_external",
          status: "active",
          metadata: { kind: "external" },
          phases: [],
        }),
      },
    } as unknown as Stripe;

    await expect(
      scheduleStripeSubscriptionPlanChange(client, existing, {
        businessId: "business-owned",
        currentPriceId: "price_current",
        targetPrice: {
          id: "price_target",
          active: true,
          type: "recurring",
          recurring: { interval: "month", interval_count: 1 },
        } as Stripe.Price,
        targetPlanTier: "SEO",
        targetBillingPeriod: "monthly",
      }),
    ).rejects.toThrow("PLAN_CHANGE_SCHEDULE_CONFLICT");
  });

  test("releases only a managed schedule bound to the same website", async () => {
    const released: string[] = [];
    const client = {
      subscriptionSchedules: {
        retrieve: async () => ({
          id: "sched_owned",
          status: "active",
          metadata: {
            kind: "uplift_plan_change_v1",
            businessId: "business-owned",
            subscriptionId: "sub_owned",
          },
        }),
        release: async (id: string) => {
          released.push(id);
          return {};
        },
      },
    } as unknown as Stripe;

    await releaseStripeSubscriptionPlanChange(client, {
      scheduleId: "sched_owned",
      businessId: "business-owned",
      subscriptionId: "sub_owned",
    });
    expect(released).toEqual(["sched_owned"]);
  });

  test("uses the owned item, server-selected price, list price, and idempotency", async () => {
    const calls: Array<{
      id: string;
      params: Stripe.SubscriptionUpdateParams;
      options?: Stripe.RequestOptions;
    }> = [];
    const existing = subscription();
    const client = {
      subscriptions: {
        update: async (
          id: string,
          params: Stripe.SubscriptionUpdateParams,
          options?: Stripe.RequestOptions,
        ) => {
          calls.push({ id, params, options });
          return existing;
        },
      },
    } as unknown as Stripe;

    await changeStripeSubscriptionPlan(client, existing, {
      businessId: "business-owned",
      itemId: "si_owned",
      planTier: "SEO_SOCIAL",
      priceId: "price_server_selected",
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.id).toBe("sub_owned");
    expect(calls[0]?.params.items).toEqual([
      { id: "si_owned", price: "price_server_selected", discounts: [] },
    ]);
    expect(calls[0]?.params.discounts).toEqual([]);
    expect(calls[0]?.params.proration_behavior).toBe("always_invoice");
    expect(calls[0]?.params.metadata).toMatchObject({
      businessId: "business-owned",
      planTier: "SEO_SOCIAL",
      userId: "user-owned",
    });
    expect(calls[0]?.options?.idempotencyKey).toBe(
      "change-plan:sub_owned:si_owned:price_server_selected",
    );
  });

  test("changes an anchored paid-intro target without creating a proration", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const existing = subscription({
      metadata: {
        userId: "user-owned",
        businessId: "business-owned",
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: "one_time_fee_anchor_v2",
        paidIntroStartAt: String(nowSeconds - 60),
        paidIntroEndAt: String(nowSeconds + 3600),
        recurringPriceId: "price_current",
      },
    });
    const capturedParams: Stripe.SubscriptionUpdateParams[] = [];
    const client = {
      subscriptions: {
        update: async (_id: string, input: Stripe.SubscriptionUpdateParams) => {
          capturedParams.push(input);
          return subscription({ metadata: input.metadata as Stripe.Metadata });
        },
      },
    } as unknown as Stripe;

    expect(isStripePaidIntroPeriod(existing)).toBe(true);
    expect(stripePlanTargetPriceId(existing)).toBe("price_current");
    expect(stripePaidIntroDates(existing)?.end?.getTime()).toBe(
      (nowSeconds + 3600) * 1000,
    );
    await changeStripeSubscriptionPlan(client, existing, {
      businessId: "business-owned",
      itemId: "si_owned",
      planTier: "SEO_SOCIAL",
      priceId: "price_social",
    });

    expect(capturedParams[0]?.proration_behavior).toBe("none");
    expect(capturedParams[0]?.metadata).toMatchObject({
      recurringPriceId: "price_social",
      planTier: "SEO_SOCIAL",
    });
  });

  test("updates the future phase for a legacy paid-intro schedule", async () => {
    const existing = subscription({
      schedule: "sched_owned",
      metadata: {
        userId: "user-owned",
        businessId: "business-owned",
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: "recurring_schedule_v1",
        trialFeePriceId: "price_intro",
        recurringPriceId: "price_current",
      },
      items: {
        data: [
          {
            id: "si_owned",
            metadata: { businessId: "business-owned" },
            price: { id: "price_intro" },
          } as unknown as Stripe.SubscriptionItem,
        ],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    const subscriptionParams: Stripe.SubscriptionUpdateParams[] = [];
    const scheduleParams: Stripe.SubscriptionScheduleUpdateParams[] = [];
    const updated = subscription({
      ...existing,
      metadata: { ...existing.metadata, recurringPriceId: "price_social" },
    });
    const client = {
      subscriptions: {
        update: async (_id: string, input: Stripe.SubscriptionUpdateParams) => {
          subscriptionParams.push(input);
          return updated;
        },
      },
      prices: {
        retrieve: async () => ({
          id: "price_social",
          active: true,
          type: "recurring",
          recurring: { interval: "month", interval_count: 1 },
        }),
      },
      subscriptionSchedules: {
        retrieve: async () => ({
          id: "sched_owned",
          current_phase: { start_date: 100, end_date: 200 },
          phases: [
            {
              start_date: 100,
              end_date: 200,
              discounts: [],
              items: [{ price: "price_intro", quantity: 1, metadata: {} }],
            },
          ],
        }),
        update: async (
          _id: string,
          input: Stripe.SubscriptionScheduleUpdateParams,
        ) => {
          scheduleParams.push(input);
          return {};
        },
      },
    } as unknown as Stripe;

    await changeStripeSubscriptionPlan(client, existing, {
      businessId: "business-owned",
      itemId: "si_owned",
      planTier: "SEO_SOCIAL",
      priceId: "price_social",
    });

    expect(subscriptionParams[0]?.items).toBeUndefined();
    expect(subscriptionParams[0]?.metadata).toMatchObject({
      recurringPriceId: "price_social",
      planTier: "SEO_SOCIAL",
    });
    expect(scheduleParams[0]?.phases?.[1]?.items).toEqual([
      {
        price: "price_social",
        quantity: 1,
        metadata: { businessId: "business-owned" },
      },
    ]);
    expect(scheduleParams[0]?.proration_behavior).toBe("none");
  });
});
