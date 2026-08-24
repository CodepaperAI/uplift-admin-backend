import { describe, expect, it } from "bun:test";
import { resolveDashboardAccessFromUser } from "../utils/access-control.utils";

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

describe("resolveDashboardAccessFromUser", () => {
  it("does not grant subscription access from account-level subscription alone", () => {
    const result = resolveDashboardAccessFromUser({
      role: "USER",
      onboarding: false,
      Subscription: {
        status: "active",
        currentPeriodEnd: FUTURE,
      },
      business: [],
    });

    expect(result.hasAccess).toBe(false);
    expect(result.accessType).toBe("none");
  });

  it("grants subscription access from an active website subscription", () => {
    const result = resolveDashboardAccessFromUser({
      role: "USER",
      onboarding: true,
      Subscription: null,
      business: [
        {
          websiteSubscription: {
            status: "active",
            trialStatus: "converted",
            currentPeriodEnd: FUTURE,
          },
        },
      ],
    });

    expect(result.hasAccess).toBe(true);
    expect(result.accessType).toBe("subscription");
  });

  it("grants trial access from an active website trial", () => {
    const result = resolveDashboardAccessFromUser({
      role: "USER",
      onboarding: true,
      Subscription: null,
      business: [
        {
          websiteSubscription: {
            status: "trialing",
            trialStatus: "trialing",
            trialStartDate: new Date(),
            trialEndDate: FUTURE,
          },
        },
      ],
    });

    expect(result.hasAccess).toBe(true);
    expect(result.accessType).toBe("trial");
  });

  it("marks expired website trials as trial_expired", () => {
    const result = resolveDashboardAccessFromUser({
      role: "USER",
      onboarding: true,
      Subscription: null,
      business: [
        {
          websiteSubscription: {
            status: "expired",
            trialStatus: "expired",
            trialStartDate: new Date(PAST.getTime() - 7 * 24 * 60 * 60 * 1000),
            trialEndDate: PAST,
          },
        },
      ],
    });

    expect(result.hasAccess).toBe(false);
    expect(result.accessType).toBe("trial_expired");
  });
});
