import { describe, expect, test } from "bun:test";

import {
  hasActiveBlogGenerationAccess,
  isBlogGenerationBusinessLifecycleActive,
} from "../utils/blog-generation-access.utils";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const USER = {
  role: "USER",
  trialStatus: "expired",
  trialStartDate: null,
  trialEndDate: null,
  Subscription: null,
};

describe("blog generation access", () => {
  test("accepts current website paid and trial entitlements", () => {
    expect(
      hasActiveBlogGenerationAccess({
        user: USER,
        websiteSubscription: {
          status: "active",
          trialStatus: "none",
          trialStartDate: null,
          trialEndDate: null,
        },
        now: NOW,
      }),
    ).toBe(true);

    const paidIntro = {
      status: "trialing",
      trialStatus: "trialing",
      trialStartDate: new Date("2026-08-15T00:00:00.000Z"),
      trialEndDate: new Date("2026-08-20T00:00:00.000Z"),
    };
    expect(
      hasActiveBlogGenerationAccess({
        user: USER,
        websiteSubscription: paidIntro,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      isBlogGenerationBusinessLifecycleActive({
        isActive: true,
        websiteStatus: "trial",
        websiteSubscription: paidIntro,
        now: NOW,
      }),
    ).toBe(true);
  });

  test("rejects expired trials even when stale subscription status says active", () => {
    const expired = {
      status: "active",
      trialStatus: "trialing",
      trialStartDate: new Date("2026-08-10T00:00:00.000Z"),
      trialEndDate: new Date("2026-08-16T00:00:00.000Z"),
    };
    expect(
      hasActiveBlogGenerationAccess({
        user: USER,
        websiteSubscription: expired,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isBlogGenerationBusinessLifecycleActive({
        isActive: true,
        websiteStatus: "trial",
        websiteSubscription: expired,
        now: NOW,
      }),
    ).toBe(false);
  });
});
