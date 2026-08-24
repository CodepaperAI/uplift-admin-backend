import { beforeEach, describe, expect, it, mock } from "bun:test";
import type Stripe from "stripe";

let websiteSubscriptionUpsert: Record<string, unknown> | null = null;
let businessUpdate: Record<string, unknown> | null = null;
let userUpdate: Record<string, unknown> | null = null;
let businessRemovalStatus = "active";
let businessOnboardingFlow: "trial_primary" | "website_secondary" | null = null;
let businessOnboardingStatus = "completed";
let existingWebsiteSubscriptionRecord: {
  id: string;
  planTier: "SEO" | "SEO_SOCIAL";
  stripeSubscriptionItemId: string | null;
  scheduledPlanPriceId: string | null;
} | null = null;

mock.module("../config/db.config", () => ({
  prisma: {
    business: {
      findUnique: async () => ({
        id: "business-1",
        userId: "user-1",
        agencyId: null,
        isActive: true,
        isPrimary: true,
        onboardingFlow: businessOnboardingFlow,
        onboardingStatus: businessOnboardingStatus,
        removalStatus: businessRemovalStatus,
        websiteStatus: "active",
      }),
      update: async (input: { data: Record<string, unknown> }) => {
        businessUpdate = input.data;
        return { id: "business-1" };
      },
    },
    subscription: {
      updateMany: async () => ({ count: 1 }),
    },
    user: {
      update: async (input: { data: Record<string, unknown> }) => {
        userUpdate = input.data;
        return { id: "user-1" };
      },
    },
    websiteSubscription: {
      count: async () => 1,
      findUnique: async () => existingWebsiteSubscriptionRecord,
      upsert: async (input: Record<string, unknown>) => {
        websiteSubscriptionUpsert = input;
        return { id: "website-subscription-1" };
      },
    },
  },
}));

describe("syncAddWebsiteSubscription Stripe trial persistence", () => {
  beforeEach(() => {
    websiteSubscriptionUpsert = null;
    businessUpdate = null;
    userUpdate = null;
    businessRemovalStatus = "active";
    businessOnboardingFlow = null;
    businessOnboardingStatus = "completed";
    existingWebsiteSubscriptionRecord = null;
  });

  it("persists website, business, and user trial lifecycle from Stripe", async () => {
    const { syncAddWebsiteSubscription } = await import("../services/billing-subscription.service");
    const trialStart = 1_800_000_000;
    const trialEnd = 1_800_259_200;
    const subscription = {
      created: trialStart,
      customer: "cus_1",
      id: "sub_trial",
      items: {
        data: [
          {
            current_period_end: trialEnd,
            current_period_start: trialStart,
            id: "si_trial",
            metadata: { businessId: "business-1" },
            price: { id: "price_monthly" },
          },
        ],
      },
      metadata: {
        businessId: "business-1",
        checkoutFlow: "onboarding_v2_trial",
        planTier: "SEO_SOCIAL",
        userId: "user-1",
      },
      status: "trialing",
      trial_end: trialEnd,
      trial_start: trialStart,
    } as unknown as Stripe.Subscription;

    const result = await syncAddWebsiteSubscription({
      userId: "user-1",
      businessId: "business-1",
      stripeSubscription: subscription,
    });

    const upsert = websiteSubscriptionUpsert as {
      create: Record<string, unknown>;
    };
    expect({
      status: upsert.create.status,
      trialStatus: upsert.create.trialStatus,
      trialStartDate: upsert.create.trialStartDate,
      trialEndDate: upsert.create.trialEndDate,
      planTier: upsert.create.planTier,
    }).toEqual({
      status: "trialing",
      trialStatus: "trialing",
      trialStartDate: new Date(trialStart * 1000),
      trialEndDate: new Date(trialEnd * 1000),
      planTier: "SEO_SOCIAL",
    });
    expect({
      websiteStatus: businessUpdate?.websiteStatus,
      isActive: businessUpdate?.isActive,
    }).toEqual({
      websiteStatus: "trial",
      isActive: true,
    });
    expect({
      trialUsed: userUpdate?.trialUsed,
      trialStatus: userUpdate?.trialStatus,
      trialStartDate: userUpdate?.trialStartDate,
      trialEndDate: userUpdate?.trialEndDate,
    }).toEqual({
      trialUsed: true,
      trialStatus: "active",
      trialStartDate: new Date(trialStart * 1000),
      trialEndDate: new Date(trialEnd * 1000),
    });
    expect(result.websiteStatus).toBe("trial");
    expect(result.planTier).toBe("SEO_SOCIAL");
  });

  it("does not reactivate a website while billing cancellation is pending", async () => {
    const { syncAddWebsiteSubscription } = await import("../services/billing-subscription.service");
    businessRemovalStatus = "cancellation_pending";
    const subscription = {
      created: 1_800_000_000,
      customer: "cus_1",
      id: "sub_pending_removal",
      items: {
        data: [
          {
            id: "si_pending_removal",
            metadata: { businessId: "business-1" },
            price: { id: "price_monthly" },
          },
        ],
      },
      metadata: {
        businessId: "business-1",
        userId: "user-1",
      },
      status: "active",
    } as unknown as Stripe.Subscription;

    let caughtError: unknown;
    try {
      await syncAddWebsiteSubscription({
        userId: "user-1",
        businessId: "business-1",
        stripeSubscription: subscription,
      });
    } catch (error) {
      caughtError = error;
    }

    const blockedError = caughtError as {
      businessId?: string;
      name?: string;
      removalStatus?: string;
    };
    expect(blockedError.name).toBe("WebsiteRemovalSyncBlockedError");
    expect(blockedError.businessId).toBe("business-1");
    expect(blockedError.removalStatus).toBe("cancellation_pending");
    expect(websiteSubscriptionUpsert).toBeNull();
    expect(businessUpdate).toBeNull();
  });

  it("keeps a paid secondary onboarding-v2 Business provisional until explicit completion", async () => {
    const { syncAddWebsiteSubscription } = await import("../services/billing-subscription.service");
    businessOnboardingFlow = "website_secondary";
    businessOnboardingStatus = "awaiting_confirmation";
    const subscription = {
      created: 1_800_000_000,
      customer: "cus_1",
      id: "sub_secondary_v2",
      items: {
        data: [
          {
            id: "si_secondary_v2",
            metadata: { businessId: "business-1" },
            price: { id: "price_monthly" },
          },
        ],
      },
      metadata: {
        businessId: "business-1",
        onboardingMode: "onboarding_v2",
        quickScrapeBusinessId: "onboarding-2",
        userId: "user-1",
      },
      status: "active",
    } as unknown as Stripe.Subscription;

    const result = await syncAddWebsiteSubscription({
      userId: "user-1",
      businessId: "business-1",
      stripeSubscription: subscription,
    });

    expect(businessUpdate?.isActive).toBe(false);
    expect(businessUpdate?.isPrimary).toBe(false);
    expect(businessUpdate?.websiteStatus).toBe("pending");
    expect(result.websiteStatus).toBe("pending");
  });

  it("refuses to guess a website item when a subscription has ambiguous siblings", async () => {
    const { syncAddWebsiteSubscription } = await import("../services/billing-subscription.service");
    const subscription = {
      created: 1_800_000_000,
      customer: "cus_1",
      id: "sub_ambiguous",
      items: {
        data: [
          {
            id: "si_first",
            metadata: {},
            price: { id: "price_first" },
          },
          {
            id: "si_second",
            metadata: {},
            price: { id: "price_second" },
          },
        ],
      },
      metadata: {
        businessId: "business-1",
        userId: "user-1",
      },
      status: "active",
    } as unknown as Stripe.Subscription;

    let error: unknown;
    try {
      await syncAddWebsiteSubscription({
        userId: "user-1",
        businessId: "business-1",
        stripeSubscription: subscription,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toContain(
      "Unable to safely resolve a Stripe subscription item",
    );
    expect(websiteSubscriptionUpsert).toBeNull();
    expect(businessUpdate).toBeNull();
  });

  it("clears the pending change projection when Stripe applies its target price", async () => {
    const { syncAddWebsiteSubscription } = await import("../services/billing-subscription.service");
    existingWebsiteSubscriptionRecord = {
      id: "website-subscription-1",
      planTier: "SEO_SOCIAL",
      stripeSubscriptionItemId: "si_owned",
      scheduledPlanPriceId: "price_seo_monthly",
    };
    const subscription = {
      created: 1_800_000_000,
      customer: "cus_1",
      id: "sub_scheduled_change",
      items: {
        data: [
          {
            id: "si_owned",
            metadata: { businessId: "business-1" },
            price: { id: "price_seo_monthly" },
          },
        ],
      },
      metadata: {
        businessId: "business-1",
        planTier: "SEO",
        userId: "user-1",
      },
      status: "active",
    } as unknown as Stripe.Subscription;

    await syncAddWebsiteSubscription({
      userId: "user-1",
      businessId: "business-1",
      stripeSubscription: subscription,
    });

    const update = (websiteSubscriptionUpsert as {
      update: Record<string, unknown>;
    }).update;
    expect(update).toMatchObject({
      planTier: "SEO",
      stripePlanScheduleId: null,
      scheduledPlanPriceId: null,
      scheduledPlanTier: null,
      scheduledBillingInterval: null,
      scheduledPlanChangeAt: null,
    });
  });
});
