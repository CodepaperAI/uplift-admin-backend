import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";

import {
  isOnboardingV2TrialMetadata,
  ONBOARDING_V2_TRIAL_CHECKOUT_FLOW,
  resolveStripeWebsiteSubscriptionLifecycle,
  shouldFinalizeOnboardingV2TrialInvoice,
} from "../services/billing-subscription.service";

describe("onboarding-v2 Stripe trial lifecycle", () => {
  it("maps a Stripe trial to website and business trial state with exact dates", () => {
    const lifecycle = resolveStripeWebsiteSubscriptionLifecycle({
      status: "trialing",
      trial_start: 1_800_000_000,
      trial_end: 1_800_259_200,
    } as Pick<Stripe.Subscription, "status" | "trial_end" | "trial_start">);

    expect(lifecycle).toEqual({
      businessIsActive: true,
      businessWebsiteStatus: "trial",
      trialEndDate: new Date(1_800_259_200_000),
      trialStartDate: new Date(1_800_000_000_000),
      trialStatus: "trialing",
      websiteSubscriptionStatus: "trialing",
    });
  });

  it("maps the post-trial active subscription to converted paid state", () => {
    const lifecycle = resolveStripeWebsiteSubscriptionLifecycle({
      status: "active",
      trial_start: 1_800_000_000,
      trial_end: 1_800_259_200,
    } as Pick<Stripe.Subscription, "status" | "trial_end" | "trial_start">);

    expect(lifecycle.businessWebsiteStatus).toBe("active");
    expect(lifecycle.businessIsActive).toBe(true);
    expect(lifecycle.websiteSubscriptionStatus).toBe("active");
    expect(lifecycle.trialStatus).toBe("converted");
  });

  it("maps the one-time $3 charge plus Stripe trial to paid-trial state", () => {
    const lifecycle = resolveStripeWebsiteSubscriptionLifecycle({
      status: "trialing",
      trial_start: 1_800_000_000,
      trial_end: 1_800_259_200,
      metadata: {
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: "one_time_fee_trial_v1",
        trialFeePriceId: "price_paid_intro",
        recurringPriceId: "price_seo_monthly",
      },
      items: {
        data: [
          {
            id: "si_seo_monthly",
            price: { id: "price_seo_monthly" },
            current_period_start: 1_800_000_000,
            current_period_end: 1_800_259_200,
          },
        ],
      },
    } as unknown as Stripe.Subscription);

    expect(lifecycle).toEqual({
      businessIsActive: true,
      businessWebsiteStatus: "trial",
      trialEndDate: new Date(1_800_259_200_000),
      trialStartDate: new Date(1_800_000_000_000),
      trialStatus: "trialing",
      websiteSubscriptionStatus: "trialing",
    });
  });

  it("maps an active subscription with a future paid-intro anchor to paid-trial state", () => {
    const lifecycle = resolveStripeWebsiteSubscriptionLifecycle({
      status: "active",
      trial_start: null,
      trial_end: null,
      metadata: {
        checkoutFlow: "onboarding_v2_trial",
        paidIntroMode: "one_time_fee_anchor_v2",
        paidIntroStartAt: "1800000000",
        paidIntroEndAt: "1800259200",
        recurringPriceId: "price_seo_monthly",
      },
      items: {
        data: [
          {
            id: "si_seo_monthly",
            price: { id: "price_seo_monthly" },
          },
        ],
      },
    } as unknown as Stripe.Subscription);

    expect(lifecycle).toEqual({
      businessIsActive: true,
      businessWebsiteStatus: "trial",
      trialEndDate: new Date(1_800_259_200_000),
      trialStartDate: new Date(1_800_000_000_000),
      trialStatus: "trialing",
      websiteSubscriptionStatus: "trialing",
    });
  });

  it("does not convert the initial $3 fee and only converts the first recurring charge", () => {
    const metadata = {
      checkoutFlow: ONBOARDING_V2_TRIAL_CHECKOUT_FLOW,
    };
    const recurringCharge = {
      amountPaid: 9_900,
      billingReason: "subscription_cycle" as const,
      metadata,
      subscriptionStatus: "active" as const,
    };

    expect(isOnboardingV2TrialMetadata(metadata)).toBe(true);
    expect(
      isOnboardingV2TrialMetadata({ checkoutFlow: "legacy_checkout" }),
    ).toBe(false);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice({
        amountPaid: 0,
        billingReason: "subscription_cycle",
        metadata,
        subscriptionStatus: "active",
      }),
    ).toBe(false);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice({
        amountPaid: 300,
        billingReason: "subscription_create",
        metadata,
        subscriptionStatus: "trialing",
      }),
    ).toBe(false);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice(recurringCharge),
    ).toBe(true);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice({
        ...recurringCharge,
        alreadyConverted: true,
      }),
    ).toBe(false);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice({
        ...recurringCharge,
        metadata: { checkoutFlow: "legacy_checkout" },
      }),
    ).toBe(false);
    expect(
      shouldFinalizeOnboardingV2TrialInvoice({
        ...recurringCharge,
        subscriptionStatus: "trialing",
      }),
    ).toBe(false);
  });
});
