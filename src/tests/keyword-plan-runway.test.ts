import { describe, expect, it } from "bun:test";
import {
  countFutureUndeletedKeywordSlots,
  getLatestScheduledKeywordDate,
  hasPaidKeywordTopUpAccess,
  isStaleKeywordGeneration,
  resolveKeywordGenerationStaleMinutes,
  shouldQueueKeywordTopUp,
} from "../utils/keyword-plan-runway.utils";

describe("keyword runway helpers", () => {
  it("counts only today/future undeleted keyword slots", () => {
    const futureCount = countFutureUndeletedKeywordSlots(
      [
        { publishDate: "2026-03-01" },
        { publishDate: "2026-03-30" },
        { publishDate: "2026-04-01" },
        { publishDate: "2026-04-02", deletedAt: new Date("2026-03-29") },
      ],
      "2026-03-30"
    );

    expect(futureCount).toBe(2);
  });

  it("does not let 30 historical keywords block a new top-up", () => {
    const historicalPlans = Array.from({ length: 30 }, (_, index) => ({
      publishDate: `2026-01-${String(index + 1).padStart(2, "0")}`,
    }));

    const futureCount = countFutureUndeletedKeywordSlots(
      historicalPlans,
      "2026-03-30"
    );

    expect(futureCount).toBe(0);
    expect(getLatestScheduledKeywordDate(historicalPlans)).toBe("2026-01-30");
  });

  it("treats active website subscriptions as paid access, but excludes trialing sites", () => {
    expect(
      hasPaidKeywordTopUpAccess({
        role: "USER",
        websiteSubscription: {
          status: "active",
          trialStatus: "none",
        },
      })
    ).toBe(true);

    expect(
      hasPaidKeywordTopUpAccess({
        role: "USER",
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
        },
      })
    ).toBe(false);
  });

  it("keeps the legacy account-level subscription fallback and admin bypass", () => {
    expect(
      hasPaidKeywordTopUpAccess({
        role: "USER",
        websiteSubscription: null,
        accountSubscription: { status: "active" },
      })
    ).toBe(true);

    expect(
      hasPaidKeywordTopUpAccess({
        role: "ADMIN",
        websiteSubscription: null,
        accountSubscription: null,
      })
    ).toBe(true);
  });

  it("queues only when the runway is at or below the threshold and generation is idle", () => {
    expect(
      shouldQueueKeywordTopUp({
        futureKeywordCount: 7,
        keywordGenerationStatus: "completed",
        hasPaidAccess: true,
      })
    ).toBe(true);

    expect(
      shouldQueueKeywordTopUp({
        futureKeywordCount: 8,
        keywordGenerationStatus: "completed",
        hasPaidAccess: true,
      })
    ).toBe(false);

    expect(
      shouldQueueKeywordTopUp({
        futureKeywordCount: 3,
        keywordGenerationStatus: "processing",
        hasPaidAccess: true,
      })
    ).toBe(false);
  });

  it("detects stale pending or processing keyword generation locks", () => {
    const now = new Date("2026-06-04T12:00:00.000Z");

    expect(
      isStaleKeywordGeneration({
        keywordGenerationStatus: "processing",
        keywordGenerationStartedAt: "2026-06-04T09:59:59.000Z",
        now,
        staleMinutes: 120,
      })
    ).toBe(true);

    expect(
      isStaleKeywordGeneration({
        keywordGenerationStatus: "pending",
        updatedAt: "2026-06-04T11:00:00.000Z",
        now,
        staleMinutes: 120,
      })
    ).toBe(false);

    expect(
      isStaleKeywordGeneration({
        keywordGenerationStatus: "completed",
        keywordGenerationStartedAt: "2026-06-04T09:00:00.000Z",
        now,
        staleMinutes: 120,
      })
    ).toBe(false);
  });

  it("falls back to the default stale threshold for invalid env values", () => {
    expect(resolveKeywordGenerationStaleMinutes("15")).toBe(15);
    expect(resolveKeywordGenerationStaleMinutes("0")).toBe(35);
    expect(resolveKeywordGenerationStaleMinutes("nope")).toBe(35);
  });
});
