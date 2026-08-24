export const POST_AUTH_DASHBOARD_DESTINATION = "/dashboard/home" as const;
export const POST_AUTH_PRIMARY_ONBOARDING_DESTINATION =
  "/dashboard/onboarding" as const;

export type DashboardAccessBusiness = {
  businessWebsiteUrl?: string | null;
  isActive?: boolean | null;
  onboardingFlow?: string | null;
  onboardingStatus?: string | null;
  websiteStatus?: string | null;
};

const DASHBOARD_ACCESSIBLE_WEBSITE_STATUSES = new Set([
  "trial",
  "active",
  "expired",
]);

const DASHBOARD_ACCESSIBLE_ONBOARDING_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_confirmation",
  "completed",
  "failed",
]);

export function hasDashboardAccess(input: {
  onboarding: boolean | null | undefined;
  businesses: DashboardAccessBusiness[];
}): boolean {
  if (input.onboarding) return true;

  return input.businesses.some((business) => {
    if (!business.businessWebsiteUrl?.trim()) return false;
    if (
      business.onboardingFlow === "trial_primary" &&
      !DASHBOARD_ACCESSIBLE_ONBOARDING_STATUSES.has(
        business.onboardingStatus ?? "",
      )
    ) {
      return false;
    }
    if (
      business.onboardingStatus != null &&
      DASHBOARD_ACCESSIBLE_ONBOARDING_STATUSES.has(business.onboardingStatus)
    ) {
      return true;
    }

    return (
      business.isActive === true &&
      (business.websiteStatus == null ||
        DASHBOARD_ACCESSIBLE_WEBSITE_STATUSES.has(business.websiteStatus))
    );
  });
}

export function resolvePostAuthDestination(
  resumable:
    | {
        id: string;
        onboardingV2Flow: "trial_primary" | "website_secondary";
      }
    | null,
  dashboardAccess: boolean,
): string {
  if (resumable?.onboardingV2Flow === "website_secondary") {
    return `/dashboard/websites/onboarding/${encodeURIComponent(resumable.id)}`;
  }

  if (dashboardAccess) return POST_AUTH_DASHBOARD_DESTINATION;
  return POST_AUTH_PRIMARY_ONBOARDING_DESTINATION;
}
