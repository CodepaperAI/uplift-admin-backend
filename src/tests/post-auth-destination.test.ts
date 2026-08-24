import { describe, expect, test } from "bun:test";

import {
  hasDashboardAccess,
  POST_AUTH_DASHBOARD_DESTINATION,
  POST_AUTH_PRIMARY_ONBOARDING_DESTINATION,
  resolvePostAuthDestination,
} from "../utils/post-auth-destination";

describe("post-auth destination", () => {
  test("returns the exact secondary resume route", () => {
    expect(
      resolvePostAuthDestination({
        id: "secondary-session-1",
        onboardingV2Flow: "website_secondary",
      }, true),
    ).toBe("/dashboard/websites/onboarding/secondary-session-1");
  });

  test("keeps a resumable primary onboarding flow canonical", () => {
    expect(
      resolvePostAuthDestination({
        id: "primary-session-1",
        onboardingV2Flow: "trial_primary",
      }, false),
    ).toBe(POST_AUTH_PRIMARY_ONBOARDING_DESTINATION);
  });

  test("opens dashboard for a primary flow after its durable job is accepted", () => {
    expect(
      resolvePostAuthDestination(
        {
          id: "primary-session-1",
          onboardingV2Flow: "trial_primary",
        },
        true,
      ),
    ).toBe(POST_AUTH_DASHBOARD_DESTINATION);
  });

  test("sends a new account directly to onboarding before dashboard renders", () => {
    expect(resolvePostAuthDestination(null, false)).toBe(
      POST_AUTH_PRIMARY_ONBOARDING_DESTINATION,
    );
  });

  test("sends a dashboard-ready account directly to dashboard home", () => {
    expect(resolvePostAuthDestination(null, true)).toBe(
      POST_AUTH_DASHBOARD_DESTINATION,
    );
  });
});

describe("dashboard access policy", () => {
  test("blocks a new account without a website", () => {
    expect(hasDashboardAccess({ onboarding: false, businesses: [] })).toBe(false);
  });

  test("allows an explicitly onboarded account", () => {
    expect(hasDashboardAccess({ onboarding: true, businesses: [] })).toBe(true);
  });

  test("allows an active website and a durable onboarding workflow", () => {
    expect(
      hasDashboardAccess({
        onboarding: false,
        businesses: [
          {
            businessWebsiteUrl: "https://example.com",
            isActive: true,
            websiteStatus: "active",
            onboardingFlow: null,
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasDashboardAccess({
        onboarding: false,
        businesses: [
          {
            businessWebsiteUrl: "https://example.com",
            isActive: false,
            websiteStatus: "pending",
            onboardingFlow: "trial_primary",
            onboardingStatus: "queued",
          },
        ],
      }),
    ).toBe(true);
  });

  test("does not unlock a provisional primary before its job is queued", () => {
    expect(
      hasDashboardAccess({
        onboarding: false,
        businesses: [
          {
            businessWebsiteUrl: "https://example.com",
            isActive: true,
            websiteStatus: "trial",
            onboardingFlow: "trial_primary",
            onboardingStatus: "idle",
          },
        ],
      }),
    ).toBe(false);
  });

  test("does not treat a placeholder business as dashboard-ready", () => {
    expect(
      hasDashboardAccess({
        onboarding: false,
        businesses: [
          {
            businessWebsiteUrl: "  ",
            isActive: true,
            websiteStatus: "active",
          },
        ],
      }),
    ).toBe(false);
  });
});
