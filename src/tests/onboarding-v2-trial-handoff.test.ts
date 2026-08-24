import { describe, expect, it } from "bun:test";

import {
  buildTrialAnchorBusinessWhere,
  executeTrialOnboardingHandoff,
  getTrialOnboardingHandoffDecision,
  hasVerifiedOnboardingEntitlement,
} from "../controllers/trial.controller";

describe("onboarding-v2 trial handoff", () => {
  it("reuses the exact provisional Business before falling back to URL matching", () => {
    expect(
      buildTrialAnchorBusinessWhere({
        userId: "user-1",
        onboardingV2BusinessId: "preview-business-1",
        websiteUrlCandidates: ["https://example.com", "https://www.example.com"],
      }),
    ).toEqual({ id: "preview-business-1", userId: "user-1" });

    expect(
      buildTrialAnchorBusinessWhere({
        userId: "user-1",
        onboardingV2BusinessId: null,
        websiteUrlCandidates: ["https://example.com", "https://www.example.com"],
      }),
    ).toEqual({
      userId: "user-1",
      businessWebsiteUrl: {
        in: ["https://example.com", "https://www.example.com"],
      },
    });
  });

  it("requires a verified Stripe entitlement before the post-payment handoff", () => {
    expect(
      hasVerifiedOnboardingEntitlement({
        isPlatformStaff: false,
        websiteStripeSubscriptionId: null,
        websiteSubscriptionStatus: null,
      }),
    ).toBe(false);
    expect(
      hasVerifiedOnboardingEntitlement({
        isPlatformStaff: false,
        websiteStripeSubscriptionId: "sub_trial",
        websiteSubscriptionStatus: "trialing",
      }),
    ).toBe(true);
    expect(
      hasVerifiedOnboardingEntitlement({
        isPlatformStaff: false,
        websiteStripeSubscriptionId: "sub_paid",
        websiteSubscriptionStatus: "active",
      }),
    ).toBe(true);
    expect(
      hasVerifiedOnboardingEntitlement({
        accountStripeSubscriptionId: "sub_legacy",
        accountSubscriptionStatus: "active",
        isPlatformStaff: false,
      }),
    ).toBe(true);
    expect(
      hasVerifiedOnboardingEntitlement({
        isPlatformStaff: true,
      }),
    ).toBe(true);
  });

  it("keeps stable quick onboarding quick-blog generation", () => {
    expect(
      getTrialOnboardingHandoffDecision({
        selectedService: "Event catering",
        previewBlogId: null,
        hasOnboardingV2State: false,
        allowQuickBlog: true,
      }),
    ).toEqual({
      queueQuickBlog: true,
      recordOnboardingV2Handoff: false,
    });
  });

  it("reuses an onboarding-v2 preview blog instead of queueing a duplicate", () => {
    expect(
      getTrialOnboardingHandoffDecision({
        selectedService: "Event catering",
        previewBlogId: "preview-blog-id",
        hasOnboardingV2State: true,
        allowQuickBlog: true,
      }),
    ).toEqual({
      queueQuickBlog: false,
      recordOnboardingV2Handoff: true,
    });
  });

  it("never queues ancillary content or records the v2 handoff when full queueing fails", async () => {
    const calls: string[] = [];

    await expect(
      executeTrialOnboardingHandoff(
        {
          selectedService: "Event catering",
          previewBlogId: null,
          hasOnboardingV2State: true,
          allowQuickBlog: true,
        },
        {
          queueFullOnboarding: async () => {
            calls.push("full");
            throw new Error("queue unavailable");
          },
          queueQuickBlog: async () => {
            calls.push("quick-blog");
          },
          recordOnboardingV2Handoff: async () => {
            calls.push("handoff-v2");
          },
        },
      ),
    ).rejects.toThrow("queue unavailable");

    expect(calls).toEqual(["full"]);
  });

  it("queues the stable quick blog once, after the durable onboarding handoff", async () => {
    const calls: string[] = [];
    await executeTrialOnboardingHandoff(
      {
        selectedService: "Event catering",
        previewBlogId: null,
        hasOnboardingV2State: false,
        allowQuickBlog: true,
      },
      {
        queueFullOnboarding: async () => {
          calls.push("full");
        },
        queueQuickBlog: async () => {
          calls.push("quick-blog");
        },
        recordOnboardingV2Handoff: async () => {
          calls.push("handoff-v2");
        },
      },
    );

    expect(calls).toEqual(["full", "quick-blog"]);
  });

  it("records the v2 handoff after queue success and tolerates ancillary failure", async () => {
    const calls: string[] = [];
    const ancillaryErrors: unknown[] = [];
    await executeTrialOnboardingHandoff(
      {
        selectedService: "Event catering",
        previewBlogId: null,
        hasOnboardingV2State: true,
        allowQuickBlog: true,
      },
      {
        queueFullOnboarding: async () => {
          calls.push("full");
        },
        queueQuickBlog: async () => {
          calls.push("quick-blog");
          throw new Error("quick blog unavailable");
        },
        recordOnboardingV2Handoff: async () => {
          calls.push("handoff-v2");
        },
        onQuickBlogError: (error) => ancillaryErrors.push(error),
      },
    );

    expect(calls).toEqual(["full", "quick-blog", "handoff-v2"]);
    expect(ancillaryErrors).toHaveLength(1);
  });
});
