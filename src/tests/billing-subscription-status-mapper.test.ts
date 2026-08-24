import { describe, expect, it } from "bun:test";
import { deriveWebsiteSubscriptionStatus } from "../services/billing-subscription.service";

describe("deriveWebsiteSubscriptionStatus", () => {
  const activeTrialAccount = {
    subscription: {
      status: "trialing",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    },
    user: {
      onboarding: true,
      trialStatus: "active",
      trialStartDate: new Date(Date.now() - 86400000),
      trialEndDate: new Date(Date.now() + 86400000),
    },
  } as const;

  const expiredTrialAccount = {
    subscription: {
      status: "trialing",
      currentPeriodEnd: new Date(Date.now() - 86400000),
    },
    user: {
      onboarding: true,
      trialStatus: "expired",
      trialStartDate: new Date(Date.now() - 7 * 86400000),
      trialEndDate: new Date(Date.now() - 86400000),
    },
  } as const;

  it("does not grant trial access from account-level trial state alone in per-site mode", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "active" },
        null,
        activeTrialAccount,
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("not_subscribed");
  });

  it("still allows explicit website-level trial rows in per-site mode", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "trial" },
        {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: new Date(Date.now() + 86400000),
          stripeSubscriptionId: null,
          stripeSubscriptionItemId: null,
          stripePriceId: null,
        },
        activeTrialAccount,
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("trial");
  });

  it("treats an active website subscription row as subscribed even without account-level paid status", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "active" },
        {
          status: "active",
          trialStatus: null,
          trialEndDate: null,
          stripeSubscriptionId: null,
          stripeSubscriptionItemId: null,
          stripePriceId: null,
        },
        activeTrialAccount,
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("subscribed");
  });

  it("shows subscribed when the website has explicit paid subscription evidence", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "active" },
        {
          status: "active",
          trialStatus: null,
          trialEndDate: null,
          stripeSubscriptionId: "sub_123",
          stripeSubscriptionItemId: "si_123",
          stripePriceId: "price_123",
        },
        activeTrialAccount,
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("subscribed");
  });

  it("does not infer expired state from account-level trial data when the website has no subscription row", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "active" },
        null,
        expiredTrialAccount,
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("not_subscribed");
  });

  it("keeps legacy grandfathered websites subscribed when there is no trial or subscription state", () => {
    expect(
      deriveWebsiteSubscriptionStatus(
        { websiteStatus: "active" },
        null,
        {
          subscription: null,
          user: {
            onboarding: true,
            trialStatus: null,
            trialStartDate: null,
            trialEndDate: null,
          },
        },
        { perSiteTrialsEnabled: true },
      ),
    ).toBe("subscribed");
  });
});
