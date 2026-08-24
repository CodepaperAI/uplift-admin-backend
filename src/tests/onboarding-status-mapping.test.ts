import { describe, expect, test } from "bun:test";

import { websiteOnboardingState } from "../controllers/onboarding.controller";

describe("onboarding status mapping", () => {
  test.each([
    ["queued", "active", "queued"],
    ["running", "active", "processing"],
    ["failed", "active", "failed"],
    ["completed", "trial", "trial"],
    ["completed", "active", "completed"],
    [null, "pending", "queued"],
    [null, "processing", "processing"],
    [null, "active", "completed"],
    [null, "trial", "trial"],
    [null, "trialing", "trial"],
    [null, "failed", "failed"],
    [null, "expired", "expired"],
    [null, "canceled", "failed"],
    [null, "cancelled", "failed"],
    [null, "converted", "completed"],
    [null, null, "none"],
    ["idle", "unknown", "none"],
  ] as const)(
    "maps onboarding=%s website=%s to %s",
    (onboardingStatus, websiteStatus, expected) => {
      expect(websiteOnboardingState(onboardingStatus, websiteStatus)).toBe(
        expected,
      );
    },
  );
});
