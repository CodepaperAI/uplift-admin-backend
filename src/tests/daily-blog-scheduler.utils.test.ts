import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS,
  DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_RUN,
  getDailyBlogSchedulerEligibilityReason,
  hasDailyBlogGenerationAccess,
  prepareDailyBlogSchedulerBatch,
  type DailyBlogSchedulerAccessCandidate,
} from "../utils/daily-blog-scheduler.utils";

type TestCandidate = DailyBlogSchedulerAccessCandidate & {
  id: string;
};

const NOW = new Date("2026-07-16T02:00:00.000Z");

function makeCandidate(
  id: string,
  options: {
    businessId?: string | null;
    businessActive?: boolean;
    businessWebsiteStatus?: string;
    role?: string;
    websiteStatus?: string | null;
    websiteTrialStatus?: string;
    websiteTrialEndDate?: Date | null;
    userSubscriptionStatus?: string | null;
    userTrialStatus?: string | null;
    userTrialEndDate?: Date | null;
  } = {},
): TestCandidate {
  const businessId =
    options.businessId === undefined ? `business-${id}` : options.businessId;
  const websiteStatus = options.websiteStatus ?? null;

  return {
    id,
    userId: `user-${id}`,
    businessId,
    user: {
      role: options.role ?? "USER",
      trialStatus: options.userTrialStatus ?? "expired",
      trialEndDate: options.userTrialEndDate ?? null,
      Subscription: options.userSubscriptionStatus
        ? { status: options.userSubscriptionStatus }
        : null,
    },
    business:
      businessId === null
        ? null
        : {
            isActive: options.businessActive ?? true,
            websiteStatus: options.businessWebsiteStatus ?? "active",
            websiteSubscription: websiteStatus
              ? {
                  status: websiteStatus,
                  trialStatus: options.websiteTrialStatus ?? "none",
                  trialEndDate: options.websiteTrialEndDate ?? null,
                }
              : null,
          },
  };
}

describe("daily blog scheduler eligibility and batching", () => {
  test("defaults can keep up with the paid daily cohort and drain recent gaps", () => {
    expect(DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_RUN).toBe(250);
    expect(DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS).toBe(5);
  });

  test("filters expired candidates before applying the run cap", () => {
    const expired = Array.from({ length: 60 }, (_, index) =>
      makeCandidate(`expired-${index}`),
    );
    const eligible = Array.from({ length: 60 }, (_, index) =>
      makeCandidate(`eligible-${index}`, { websiteStatus: "active" }),
    );

    const batch = prepareDailyBlogSchedulerBatch(
      [...expired, ...eligible],
      {
        now: NOW,
        maxPerRun: 50,
        maxPerBusiness: 1,
      },
    );

    expect(batch.selected).toHaveLength(50);
    expect(
      batch.selected.every((candidate) =>
        candidate.id.startsWith("eligible-"),
      ),
    ).toBe(true);
    expect(batch.excludedNoAccess).toBe(60);
    expect(batch.eligibleCandidates).toBe(60);
    expect(batch.skippedByRunCap).toBe(10);
  });

  test("applies the per-business cap only after access filtering", () => {
    const candidates = [
      makeCandidate("expired", {
        businessId: "expired-business",
      }),
      makeCandidate("business-a-first", {
        businessId: "business-a",
        websiteStatus: "active",
      }),
      makeCandidate("business-a-second", {
        businessId: "business-a",
        websiteStatus: "active",
      }),
      makeCandidate("business-b", {
        businessId: "business-b",
        websiteStatus: "active",
      }),
    ];

    const batch = prepareDailyBlogSchedulerBatch(candidates, {
      now: NOW,
      maxPerRun: 50,
      maxPerBusiness: 1,
    });

    expect(batch.selected.map((candidate) => candidate.id)).toEqual([
      "business-a-first",
      "business-b",
    ]);
    expect(batch.excludedNoAccess).toBe(1);
    expect(batch.skippedByBusinessCap).toBe(1);
  });

  test("preserves every existing subscription and trial access path", () => {
    const future = new Date("2026-07-17T02:00:00.000Z");
    const accessCandidates = [
      makeCandidate("admin", { role: "ADMIN" }),
      makeCandidate("website", { websiteStatus: "active" }),
      makeCandidate("website-trial", {
        businessWebsiteStatus: "trial",
        websiteStatus: "trialing",
        websiteTrialStatus: "trialing",
        websiteTrialEndDate: future,
      }),
      makeCandidate("user-subscription", {
        userSubscriptionStatus: "active",
      }),
      makeCandidate("user-trial", {
        userTrialStatus: "active",
        userTrialEndDate: future,
      }),
    ];

    expect(
      accessCandidates.every((candidate) =>
        hasDailyBlogGenerationAccess(candidate, NOW),
      ),
    ).toBe(true);
    expect(hasDailyBlogGenerationAccess(makeCandidate("expired"), NOW)).toBe(
      false,
    );
    expect(
      getDailyBlogSchedulerEligibilityReason(
        makeCandidate("inactive", {
          businessActive: false,
          websiteStatus: "active",
        }),
        NOW,
      ),
    ).toBe("no_business");
    expect(
      getDailyBlogSchedulerEligibilityReason(
        makeCandidate("expired-website-trial", {
          businessWebsiteStatus: "trial",
          websiteStatus: "trialing",
          websiteTrialStatus: "trialing",
          websiteTrialEndDate: new Date("2026-07-15T02:00:00.000Z"),
        }),
        NOW,
      ),
    ).toBe("no_business");
    expect(
      getDailyBlogSchedulerEligibilityReason(
        makeCandidate("legacy", { businessId: null, role: "ADMIN" }),
        NOW,
      ),
    ).toBe("skipped_legacy_no_business_id");
  });
});
