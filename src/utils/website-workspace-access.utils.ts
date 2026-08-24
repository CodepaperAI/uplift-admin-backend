export const WEBSITE_WORKSPACE_ACCESS_REASONS = [
  "ready",
  "inactive",
  "removal_pending",
  "removed",
  "setup_pending",
  "setup_failed",
  "subscription_required",
  "subscription_inactive",
  "website_pending",
  "website_suspended",
  "website_canceled",
  "website_expired",
  "unavailable",
] as const;

export type WebsiteWorkspaceAccessReason =
  (typeof WEBSITE_WORKSPACE_ACCESS_REASONS)[number];

export type WebsiteWorkspaceAccessInput = {
  isActive?: boolean | null;
  isPrimary?: boolean | null;
  websiteStatus?: string | null;
  onboardingFlow?: string | null;
  onboardingStatus?: string | null;
  removalStatus?: string | null;
  websiteSubscription?: { status?: string | null } | null;
};

export type WebsiteWorkspaceAccessProjection = {
  canAccessWorkspace: boolean;
  canSelectWorkspace: boolean;
  reason: WebsiteWorkspaceAccessReason;
};

type WebsiteWorkspaceAccessOptions = {
  hasAdminAccess?: boolean;
};

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function denied(
  reason: Exclude<WebsiteWorkspaceAccessReason, "ready">,
): WebsiteWorkspaceAccessProjection {
  return {
    canAccessWorkspace: false,
    canSelectWorkspace: false,
    reason,
  };
}

/**
 * Canonical product-workspace access resolver.
 *
 * An owned Business record can remain available for billing, recovery and
 * audit history after its product workspace becomes unavailable. Callers must
 * therefore use this projection instead of treating ownership, `isActive`, or
 * a browser-selected ID as proof of current product access.
 */
export function resolveWebsiteWorkspaceAccess(
  website: WebsiteWorkspaceAccessInput,
  options: WebsiteWorkspaceAccessOptions = {},
): WebsiteWorkspaceAccessProjection {
  const removalStatus = normalized(website.removalStatus);
  if (removalStatus === "removed") return denied("removed");
  if (removalStatus && removalStatus !== "active") {
    return denied("removal_pending");
  }

  const websiteStatus = normalized(website.websiteStatus);
  if (websiteStatus === "canceled") return denied("website_canceled");
  if (websiteStatus === "suspended") return denied("website_suspended");
  if (websiteStatus === "pending") return denied("website_pending");
  if (websiteStatus === "failed") return denied("setup_failed");
  if (websiteStatus === "expired" && options.hasAdminAccess !== true) {
    return denied("website_expired");
  }

  if (!website.isActive) return denied("inactive");

  const subscriptionStatus = normalized(website.websiteSubscription?.status);
  if (
    options.hasAdminAccess !== true &&
    [
      "canceled",
      "expired",
      "suspended",
      "unpaid",
      "paused",
      "incomplete",
      "incomplete_expired",
    ].includes(subscriptionStatus)
  ) {
    return denied("subscription_inactive");
  }

  const onboardingStatus = normalized(website.onboardingStatus);
  if (website.onboardingFlow === "website_secondary") {
    if (onboardingStatus === "failed") return denied("setup_failed");
    if (onboardingStatus !== "completed") return denied("setup_pending");
    if (
      options.hasAdminAccess !== true &&
      subscriptionStatus !== "active" &&
      subscriptionStatus !== "trialing"
    ) {
      return denied("subscription_required");
    }
  } else if (
    website.onboardingFlow === "trial_primary" &&
    onboardingStatus !== "queued" &&
    onboardingStatus !== "running" &&
    onboardingStatus !== "completed" &&
    onboardingStatus !== "failed"
  ) {
    return denied("setup_pending");
  } else if (onboardingStatus === "awaiting_confirmation") {
    return denied("setup_pending");
  } else if (onboardingStatus === "failed") {
    return denied("setup_failed");
  }

  const canAccessWorkspace =
    websiteStatus === "active" ||
    websiteStatus === "trial" ||
    (options.hasAdminAccess === true && websiteStatus === "expired");
  if (!canAccessWorkspace) return denied("unavailable");

  return {
    canAccessWorkspace: true,
    // A currently selected primary workspace may remain visible while its
    // durable setup job runs, but another workspace cannot switch into that
    // intermediate state.
    canSelectWorkspace:
      onboardingStatus !== "queued" && onboardingStatus !== "running",
    reason: "ready",
  };
}

const HISTORICAL_DASHBOARD_REASONS = new Set<WebsiteWorkspaceAccessReason>([
  "ready",
  "subscription_inactive",
  "website_canceled",
  "website_expired",
]);

/**
 * Existing customer data remains readable after a subscription ends, while
 * paid product access stays closed. This is intentionally narrower than
 * ownership: removed, suspended, and unfinished workspaces are never exposed
 * through historical dashboard reads.
 */
export function canViewHistoricalDashboardData(
  website: WebsiteWorkspaceAccessInput,
  options: WebsiteWorkspaceAccessOptions = {},
): boolean {
  const access = resolveWebsiteWorkspaceAccess(website, options);
  return HISTORICAL_DASHBOARD_REASONS.has(access.reason);
}
