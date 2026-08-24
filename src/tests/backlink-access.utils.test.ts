import { describe, expect, it } from "bun:test";
import {
  getBusinessBacklinkServiceEligibility,
  getUserBacklinkServiceEligibility,
} from "../utils/backlink-access.utils";

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

describe("backlink service eligibility", () => {
  it("allows enabled users with an active paid website subscription", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: true,
      Subscription: null,
      business: [
        {
          isActive: true,
          websiteSubscription: {
            status: "active",
            trialStatus: "none",
            stripeSubscriptionId: "sub_123",
          },
        },
      ],
    });

    expect(result.eligible).toBe(true);
  });

  it("does not grant backlink access from account subscription alone", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: true,
      Subscription: {
        status: "active",
        currentPeriodEnd: futureDate,
      },
      business: [],
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("subscription_required");
  });

  it("blocks trialing website subscriptions", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: true,
      Subscription: null,
      business: [
        {
          isActive: true,
          websiteSubscription: {
            status: "trialing",
            trialStatus: "trialing",
            stripeSubscriptionId: "sub_trial",
          },
        },
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("subscription_required");
  });

  it("blocks expired and free users", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: true,
      Subscription: {
        status: "canceled",
        currentPeriodEnd: null,
      },
      business: [
        {
          isActive: true,
          websiteSubscription: {
            status: "expired",
            trialStatus: "expired",
            stripeSubscriptionId: "sub_expired",
          },
        },
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("subscription_required");
  });

  it("blocks staff/admin users without a paid subscription", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: true,
      Subscription: null,
      business: [],
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("subscription_required");
  });

  it("blocks paid users who manually disabled backlinks", () => {
    const result = getUserBacklinkServiceEligibility({
      backlinkEnabled: false,
      Subscription: {
        status: "active",
        currentPeriodEnd: futureDate,
      },
      business: [],
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("checks paid eligibility for the target business only", () => {
    const unpaidBusiness = getBusinessBacklinkServiceEligibility({
      isActive: true,
      websiteSubscription: {
        status: "trialing",
        trialStatus: "trialing",
      },
      User: {
        backlinkEnabled: true,
        Subscription: null,
      },
    });
    const accountPaidBusiness = getBusinessBacklinkServiceEligibility({
      isActive: true,
      websiteSubscription: {
        status: "trialing",
        trialStatus: "trialing",
      },
      User: {
        backlinkEnabled: true,
        Subscription: {
          status: "active",
          currentPeriodEnd: futureDate,
        },
      },
    });

    expect(unpaidBusiness.eligible).toBe(false);
    expect(accountPaidBusiness.eligible).toBe(false);
  });
});
