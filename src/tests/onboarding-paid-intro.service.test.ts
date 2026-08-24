import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";

import {
  ensureOnboardingV2PaidIntroSchedule,
  ensureOnboardingV2PaidIntroSubscription,
  getOnboardingV2PaidIntroPeriodDates,
  getOnboardingV2TargetPriceId,
  isOnboardingV2PaidIntroPeriod,
  ONBOARDING_V2_PAID_INTRO_MODE,
  updateOnboardingV2PaidIntroTarget,
} from "../services/onboarding-paid-intro.service";

const START = 1_800_000_000;
const END = START + 3 * 24 * 60 * 60;

function subscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: "sub_paid_intro",
    status: "active",
    schedule: null,
    trial_start: null,
    trial_end: null,
    metadata: {
      businessId: "business-1",
      checkoutFlow: "onboarding_v2_trial",
      paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
      paidIntroStartAt: String(START),
      paidIntroEndAt: String(END),
      planTier: "SEO",
      recurringPriceId: "price_seo_monthly",
      trialFeePriceId: "price_paid_intro",
    },
    items: {
      data: [
        {
          id: "si_seo_monthly",
          price: { id: "price_seo_monthly" },
        } as Stripe.SubscriptionItem,
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
    ...overrides,
  } as Stripe.Subscription;
}

function client() {
  const calls = {
    scheduleCreate: [] as Array<Record<string, unknown>>,
    scheduleUpdate: [] as Array<Record<string, unknown>>,
    subscriptionUpdate: [] as Array<Record<string, unknown>>,
  };
  const stripeClient = {
    prices: {
      retrieve: async (id: string) => ({ id }),
    },
    subscriptionSchedules: {
      create: async (payload: Record<string, unknown>) => {
        calls.scheduleCreate.push(payload);
        return { id: "sub_sched_1" };
      },
      retrieve: async () => ({ id: "sub_sched_1" }),
      update: async (_id: string, payload: Record<string, unknown>) => {
        calls.scheduleUpdate.push(payload);
        return { id: "sub_sched_1" };
      },
    },
    subscriptions: {
      update: async (_id: string, payload: Record<string, unknown>) => {
        calls.subscriptionUpdate.push(payload);
        const items = payload.items as Array<{ id: string; price: string }>;
        return subscription({
          metadata: payload.metadata as Stripe.Metadata,
          items: {
            data: [
              {
                id: items[0]!.id,
                price: { id: items[0]!.price },
              } as Stripe.SubscriptionItem,
            ],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        });
      },
    },
  } as unknown as Stripe;
  return { calls, stripeClient };
}

describe("onboarding paid introductory subscription", () => {
  it("recognizes the active paid intro and exposes its boundary", () => {
    const value = subscription();

    expect(isOnboardingV2PaidIntroPeriod(value)).toBe(true);
    expect(getOnboardingV2TargetPriceId(value.metadata)).toBe(
      "price_seo_monthly",
    );
    expect(getOnboardingV2PaidIntroPeriodDates(value)).toEqual({
      start: new Date(START * 1000),
      end: new Date(END * 1000),
    });
  });

  it("continues to recognize existing Stripe-trial paid intros", () => {
    const value = subscription({
      status: "trialing",
      trial_start: START,
      trial_end: END,
      metadata: {
        ...subscription().metadata,
        paidIntroMode: "one_time_fee_trial_v1",
        paidIntroStartAt: "",
        paidIntroEndAt: "",
      },
    });

    expect(isOnboardingV2PaidIntroPeriod(value)).toBe(true);
    expect(getOnboardingV2PaidIntroPeriodDates(value)).toEqual({
      start: new Date(START * 1000),
      end: new Date(END * 1000),
    });
  });

  it("creates an active subscription anchored after the paid intro", async () => {
    const calls: Array<{
      options?: Stripe.RequestOptions;
      payload: Stripe.SubscriptionCreateParams;
    }> = [];
    const checkoutSession = {
      id: "cs_paid_intro",
      mode: "payment",
      payment_status: "paid",
      customer: "cus_123",
      payment_intent: {
        id: "pi_123",
        created: START,
        latest_charge: {
          id: "ch_123",
          created: START,
        },
        payment_method: "pm_123",
        status: "succeeded",
      },
      metadata: {
        businessId: "business-1",
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: ONBOARDING_V2_PAID_INTRO_MODE,
        recurringPriceId: "price_seo_monthly",
        userId: "user-1",
      },
    } as unknown as Stripe.Checkout.Session;
    const stripeClient = {
      paymentIntents: { retrieve: async () => checkoutSession.payment_intent },
      subscriptions: {
        list: async () => ({ data: [] }),
        create: async (
          payload: Stripe.SubscriptionCreateParams,
          options?: Stripe.RequestOptions,
        ) => {
          calls.push({ options, payload });
          return subscription({
            metadata: payload.metadata as Stripe.Metadata,
          });
        },
      },
    } as unknown as Stripe;

    const created = await ensureOnboardingV2PaidIntroSubscription(
      stripeClient,
      checkoutSession,
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.payload.billing_cycle_anchor).toBe(END);
    expect(calls[0]?.payload.proration_behavior).toBe("none");
    expect(calls[0]?.payload.default_payment_method).toBe("pm_123");
    expect(calls[0]?.payload.trial_end).toBeUndefined();
    expect(calls[0]?.payload.items?.[0]?.price).toBe("price_seo_monthly");
    expect(
      (calls[0]?.payload.metadata as Record<string, string>).paidIntroMode,
    ).toBe("one_time_fee_anchor_v2");
    expect(created.status).toBe("active");
  });

  it("does not create a schedule for the one-time fee trial", async () => {
    const { calls, stripeClient } = client();

    const result = await ensureOnboardingV2PaidIntroSchedule(
      stripeClient,
      subscription(),
    );

    expect(result).toBeNull();
    expect(calls.scheduleCreate.length).toBe(0);
    expect(calls.scheduleUpdate.length).toBe(0);
  });

  it("changes the recurring plan during the trial without another charge", async () => {
    const { calls, stripeClient } = client();

    const updated = await updateOnboardingV2PaidIntroTarget(
      stripeClient,
      subscription(),
      {
        businessId: "business-1",
        planTier: "SEO_SOCIAL",
        priceId: "price_social_monthly",
      },
    );

    expect(calls.subscriptionUpdate.length).toBe(1);
    expect(calls.subscriptionUpdate[0]?.proration_behavior).toBe("none");
    expect(
      (calls.subscriptionUpdate[0]?.metadata as Record<string, string>)
        .recurringPriceId,
    ).toBe("price_social_monthly");
    expect(updated.items.data[0]?.price.id).toBe("price_social_monthly");
  });
});
