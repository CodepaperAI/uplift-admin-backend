import { describe, expect, test } from "bun:test";

import {
  canViewHistoricalDashboardData,
  resolveWebsiteWorkspaceAccess,
} from "../utils/website-workspace-access.utils";

const readyWebsite = {
  isActive: true,
  isPrimary: true,
  websiteStatus: "active",
  onboardingFlow: "trial_primary",
  onboardingStatus: "completed",
  removalStatus: "active",
  websiteSubscription: { status: "active" },
};

describe("website workspace access projection", () => {
  test("keeps an owned canceled record out of product workspace access", () => {
    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        isActive: false,
        websiteStatus: "canceled",
        websiteSubscription: { status: "canceled" },
      }),
    ).toEqual({
      canAccessWorkspace: false,
      canSelectWorkspace: false,
      reason: "website_canceled",
    });
  });

  test("fails closed when billing is canceled but business flags are stale", () => {
    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        websiteSubscription: { status: "canceled" },
      }),
    ).toEqual({
      canAccessWorkspace: false,
      canSelectWorkspace: false,
      reason: "subscription_inactive",
    });
  });

  test("allows an active subscription scheduled to cancel at period end", () => {
    expect(resolveWebsiteWorkspaceAccess(readyWebsite)).toEqual({
      canAccessWorkspace: true,
      canSelectWorkspace: true,
      reason: "ready",
    });
  });

  test("tracks a running primary setup without allowing a new switch to it", () => {
    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        onboardingStatus: "running",
      }),
    ).toEqual({
      canAccessWorkspace: true,
      canSelectWorkspace: false,
      reason: "ready",
    });
  });

  test("keeps a provisional primary out until its background job is accepted", () => {
    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        onboardingStatus: "idle",
      }),
    ).toEqual({
      canAccessWorkspace: false,
      canSelectWorkspace: false,
      reason: "setup_pending",
    });
  });

  test("requires completed setup and entitlement for a secondary website", () => {
    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        onboardingFlow: "website_secondary",
        onboardingStatus: "running",
      }),
    ).toEqual({
      canAccessWorkspace: false,
      canSelectWorkspace: false,
      reason: "setup_pending",
    });

    expect(
      resolveWebsiteWorkspaceAccess({
        ...readyWebsite,
        onboardingFlow: "website_secondary",
        websiteSubscription: null,
      }),
    ).toEqual({
      canAccessWorkspace: false,
      canSelectWorkspace: false,
      reason: "subscription_required",
    });
  });

  test("admin bypass never overrides removal or setup safety", () => {
    expect(
      resolveWebsiteWorkspaceAccess(
        { ...readyWebsite, removalStatus: "removed" },
        { hasAdminAccess: true },
      ).reason,
    ).toBe("removed");
  });

  test("keeps historical dashboard data visible across the cancellation lifecycle", () => {
    expect(canViewHistoricalDashboardData(readyWebsite)).toBe(true);
    expect(
      canViewHistoricalDashboardData({
        ...readyWebsite,
        isActive: false,
        websiteStatus: "canceled",
        websiteSubscription: { status: "canceled" },
      }),
    ).toBe(true);
    expect(
      canViewHistoricalDashboardData({
        ...readyWebsite,
        isActive: false,
        websiteStatus: "expired",
        websiteSubscription: { status: "expired" },
      }),
    ).toBe(true);
  });

  test("does not expose historical data for removed or suspended workspaces", () => {
    expect(
      canViewHistoricalDashboardData({
        ...readyWebsite,
        removalStatus: "removed",
      }),
    ).toBe(false);
    expect(
      canViewHistoricalDashboardData({
        ...readyWebsite,
        websiteStatus: "suspended",
      }),
    ).toBe(false);
  });
});
