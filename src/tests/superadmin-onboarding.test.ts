import { describe, expect, test } from "bun:test";
import {
  buildAdminOnboardingBreakdown,
  type BusinessOnboardingInput,
  type QuickScrapeOnboardingInput,
} from "../utils/superadmin-onboarding.utils";

const now = new Date("2026-08-18T16:00:00.000Z");

function session(
  overrides: Partial<QuickScrapeOnboardingInput> = {},
): QuickScrapeOnboardingInput {
  return {
    id: "session-1",
    businessName: "Example Co",
    businessWebsiteUrl: "https://example.com",
    detectedServices: ["SEO", "Content"],
    selectedServices: ["SEO"],
    onboardingV2Flow: "trial_primary",
    onboardingV2Step: "website",
    onboardingV2QuestionIndex: 0,
    onboardingV2Status: "in_progress",
    onboardingV2LastSeenAt: "2026-08-18T15:00:00.000Z",
    onboardingV2GenerationStartedAt: null,
    onboardingV2BusinessId: null,
    onboardingV2BlogId: null,
    onboardingV2SocialRunId: null,
    onboardingV2BlogStatus: "idle",
    onboardingV2SocialStatus: "idle",
    onboardingV2GenerationError: null,
    onboardingV2CompletedAt: null,
    onboardingV2SelectedPlanTier: null,
    contactDetailsConfirmedAt: null,
    createdAt: "2026-08-18T14:00:00.000Z",
    updatedAt: "2026-08-18T15:00:00.000Z",
    ...overrides,
  };
}

function business(
  overrides: Partial<BusinessOnboardingInput> = {},
): BusinessOnboardingInput {
  return {
    id: "business-1",
    businessName: "Example Co",
    businessWebsiteUrl: "https://example.com",
    isPrimary: true,
    isActive: true,
    websiteStatus: "trial",
    onboardingFlow: "trial_primary",
    onboardingStatus: "idle",
    onboardingAttemptCount: 0,
    onboardingLastAttemptAt: null,
    onboardingCompletedAt: null,
    onboardingLastError: null,
    secondaryDetailsConfirmed: false,
    keywordGenerationStatus: "idle",
    keywordGenerationStartedAt: null,
    keywordGenerationCompletedAt: null,
    createdAt: "2026-08-18T14:00:00.000Z",
    updatedAt: "2026-08-18T14:00:00.000Z",
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildAdminOnboardingBreakdown>[0]> = {}) {
  return buildAdminOnboardingBreakdown({
    accountCreatedAt: "2026-08-18T14:00:00.000Z",
    accountOnboardingComplete: false,
    sessions: [],
    trial: null,
    businesses: [],
    now,
    ...overrides,
  });
}

describe("superadmin onboarding breakdown", () => {
  test("flags an older account that never started", () => {
    const result = build({
      accountCreatedAt: "2026-08-16T12:00:00.000Z",
    });
    expect(result.summary.state).toBe("not_started");
    expect(result.summary.currentStep).toBe("welcome");
    expect(result.summary.needsFollowUp).toBe(true);
  });

  test("shows the exact marketing question where an inactive user stopped", () => {
    const result = build({
      sessions: [
        session({
          onboardingV2Step: "questions",
          onboardingV2QuestionIndex: 3,
          onboardingV2LastSeenAt: "2026-08-17T10:00:00.000Z",
          createdAt: "2026-08-17T09:00:00.000Z",
          updatedAt: "2026-08-17T10:00:00.000Z",
        }),
      ],
    });
    expect(result.summary.state).toBe("in_progress");
    expect(result.summary.currentStepLabel).toBe("Marketing questions (4 of 6)");
    expect(result.summary.needsFollowUp).toBe(true);
    expect(result.summary.inactiveHours).toBe(30);
  });

  test("keeps a recent payment step out of the follow-up queue", () => {
    const result = build({
      sessions: [
        session({
          onboardingV2Status: "awaiting_payment",
          onboardingV2Step: "payment",
        }),
      ],
    });
    expect(result.summary.currentStepLabel).toBe("Payment");
    expect(result.summary.needsFollowUp).toBe(false);
  });

  test("marks a completed flow as 100 percent", () => {
    const result = build({
      accountOnboardingComplete: true,
      sessions: [
        session({
          onboardingV2Status: "completed",
          onboardingV2Step: "complete",
          onboardingV2CompletedAt: "2026-08-18T15:30:00.000Z",
        }),
      ],
    });
    expect(result.summary.state).toBe("completed");
    expect(result.summary.progressPercent).toBe(100);
    expect(result.summary.needsFollowUp).toBe(false);
  });

  test("prioritizes an unfinished additional website over a completed primary flow", () => {
    const result = build({
      accountOnboardingComplete: true,
      sessions: [
        session({
          id: "primary-complete",
          onboardingV2Status: "completed",
          onboardingV2CompletedAt: "2026-08-17T15:00:00.000Z",
        }),
        session({
          id: "secondary-active",
          onboardingV2Flow: "website_secondary",
          onboardingV2Step: "brand",
        }),
      ],
    });
    expect(result.summary.state).toBe("in_progress");
    expect(result.summary.flow).toBe("website_secondary");
    expect(result.summary.currentStep).toBe("brand");
  });

  test("failed business setup immediately needs follow-up", () => {
    const result = build({
      businesses: [
        business({
          onboardingStatus: "failed",
          onboardingLastError: { code: "KEYWORD_SETUP_FAILED", stage: "keywords", message: "private diagnostic" },
        }),
      ],
    });
    expect(result.summary.state).toBe("failed");
    expect(result.summary.needsFollowUp).toBe(true);
    expect(result.businesses[0]?.error).toEqual({
      code: "KEYWORD_SETUP_FAILED",
      stage: "keywords",
    });
  });
});
