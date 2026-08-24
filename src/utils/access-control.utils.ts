import { prisma } from "../config/db.config";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import { isPlatformStaffSubscriptionBypassRole } from "./platform-role.utils";

export interface AccessStatus {
  hasAccess: boolean;
  accessType: "subscription" | "trial" | "trial_expired" | "legacy" | "admin" | "none";
  isAdmin?: boolean;
  daysLeft?: number;
  message?: string;
  subscription?: {
    status: string;
    currentPeriodEnd?: Date | null;
  };
  trial?: {
    status: string;
    startDate?: Date | null;
    endDate?: Date | null;
    daysLeft: number;
  };
}

export interface SiteAccessStatus {
  hasAccess: boolean;
  accessType: "subscription" | "trial" | "trial_expired" | "admin" | "none";
  isAdmin?: boolean;
  daysLeft?: number;
  message?: string;
}

type DashboardAccessUser = {
  role: string;
  onboarding?: boolean | null;
  trialStartDate?: Date | null;
  trialEndDate?: Date | null;
  trialStatus?: string | null;
  Subscription?: {
    status: string;
    currentPeriodEnd?: Date | null;
  } | null;
  business: Array<{
    websiteSubscription: {
      status: string;
      trialStartDate?: Date | null;
      trialEndDate?: Date | null;
      trialStatus?: string | null;
      currentPeriodEnd?: Date | null;
    } | null;
  }>;
};

function hasPaidWebsiteSubscription(
  websiteSubscription: DashboardAccessUser["business"][number]["websiteSubscription"],
): boolean {
  if (!websiteSubscription || websiteSubscription.status !== "active") {
    return false;
  }

  if (
    websiteSubscription.trialStatus === "trialing" ||
    websiteSubscription.trialStatus === "expired"
  ) {
    return false;
  }

  return true;
}

function getWebsiteWithActiveSubscription(
  businesses: DashboardAccessUser["business"],
) {
  return (
    businesses.find((business) =>
      hasPaidWebsiteSubscription(business.websiteSubscription),
    )?.websiteSubscription ?? null
  );
}

function getWebsiteWithActiveTrial(
  businesses: DashboardAccessUser["business"],
  now: Date,
) {
  return (
    businesses.find((business) => {
      const ws = business.websiteSubscription;
      return Boolean(
        ws &&
          ws.trialStatus === "trialing" &&
          ws.trialEndDate &&
          ws.trialEndDate > now,
      );
    })?.websiteSubscription ?? null
  );
}

function hasExpiredWebsiteTrial(
  businesses: DashboardAccessUser["business"],
  now: Date,
): boolean {
  return businesses.some((business) => {
    const ws = business.websiteSubscription;
    return Boolean(
      ws &&
        (ws.trialStatus === "expired" ||
          ws.status === "expired" ||
          ((ws.trialStatus === "trialing" || ws.status === "trialing") &&
            ws.trialEndDate &&
            ws.trialEndDate <= now)),
    );
  });
}

export function resolveDashboardAccessFromUser(
  user: DashboardAccessUser | null,
): AccessStatus {
  if (!user) {
    return {
      hasAccess: false,
      accessType: "none",
      message: "User not found",
    };
  }

  if (isPlatformStaffSubscriptionBypassRole(user.role)) {
    return {
      hasAccess: true,
      accessType: "admin",
      isAdmin: true,
      message: "Admin user - full access",
    };
  }

  const now = new Date();
  const paidWebsiteSubscription = getWebsiteWithActiveSubscription(user.business);

  if (paidWebsiteSubscription) {
    return {
      hasAccess: true,
      accessType: "subscription",
      subscription: {
        status: paidWebsiteSubscription.status,
        currentPeriodEnd: paidWebsiteSubscription.currentPeriodEnd ?? null,
      },
    };
  }

  const activeWebsiteTrial = getWebsiteWithActiveTrial(user.business, now);

  if (activeWebsiteTrial?.trialEndDate) {
    const daysLeft = Math.ceil(
      (activeWebsiteTrial.trialEndDate.getTime() - now.getTime()) /
        (1000 * 60 * 60 * 24),
    );

    return {
      hasAccess: true,
      accessType: "trial",
      daysLeft,
      trial: {
        status: "active",
        startDate: activeWebsiteTrial.trialStartDate ?? null,
        endDate: activeWebsiteTrial.trialEndDate,
        daysLeft,
      },
    };
  }

  if (hasExpiredWebsiteTrial(user.business, now)) {
    return {
      hasAccess: false,
      accessType: "trial_expired",
      message: "Your 7-day trial has ended. Subscribe to continue using UpliftAI.",
    };
  }

  if (!user.trialStartDate && user.onboarding === true) {
    return {
      hasAccess: true,
      accessType: "legacy",
      message: "Legacy user - grandfathered access",
    };
  }

  return {
    hasAccess: false,
    accessType: "none",
    message: "No active subscription or trial. Please subscribe or start a trial.",
  };
}

export async function isAdminUser(userId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return (
      user !== null &&
      user !== undefined &&
      isPlatformStaffSubscriptionBypassRole(user.role)
    );
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

export async function checkDashboardAccess(
  userId: string
): Promise<AccessStatus> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        Subscription: true,
        business: {
          where: { isActive: true },
          include: { websiteSubscription: true },
        },
      },
    });
    return resolveDashboardAccessFromUser(user);
  } catch (error) {
    console.error("Error checking dashboard access:", error);
    return {
      hasAccess: false,
      accessType: "none",
      message: "Error checking access",
    };
  }
}

export function resolveSiteAccessWhenPerSiteTrialsDisabled(
  role: string | null | undefined,
  website?: {
    exists: boolean;
    isActive: boolean;
    websiteStatus?: string | null;
    removalStatus?: string | null;
    onboardingStatus?: string | null;
  },
): SiteAccessStatus {
  if (website) {
    const websiteStatus = website.websiteStatus?.toLowerCase() ?? "";
    const removalStatus = website.removalStatus?.toLowerCase() ?? "";
    const onboardingStatus = website.onboardingStatus?.toLowerCase() ?? "";
    if (
      !website.exists ||
      !website.isActive ||
      (removalStatus && removalStatus !== "active") ||
      ["canceled", "suspended", "failed"].includes(websiteStatus) ||
      onboardingStatus === "failed"
    ) {
      return {
        hasAccess: false,
        accessType: "none",
        message: "Site is unavailable",
      };
    }
  }

  if (role && isPlatformStaffSubscriptionBypassRole(role)) {
    return {
      hasAccess: true,
      accessType: "admin",
      isAdmin: true,
      message: "Admin user - full access",
    };
  }
  return { hasAccess: true, accessType: "subscription" };
}

export async function checkSiteAccess(
  businessId: string,
): Promise<SiteAccessStatus> {
  if (!PER_SITE_TRIALS_ENABLED) {
    try {
      const businessOwner = await prisma.business.findUnique({
        where: { id: businessId },
        select: {
          isActive: true,
          websiteStatus: true,
          removalStatus: true,
          onboardingStatus: true,
          User: { select: { role: true } },
        },
      });
      return resolveSiteAccessWhenPerSiteTrialsDisabled(
        businessOwner?.User.role,
        businessOwner
          ? {
              exists: true,
              isActive: businessOwner.isActive,
              websiteStatus: businessOwner.websiteStatus,
              removalStatus: businessOwner.removalStatus,
              onboardingStatus: businessOwner.onboardingStatus,
            }
          : {
              exists: false,
              isActive: false,
            },
      );
    } catch (error) {
      console.error("Error checking site admin bypass:", error);
      return {
        hasAccess: false,
        accessType: "none",
        message: "Error checking access",
      };
    }
  }

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: {
        websiteSubscription: true,
        User: {
          select: {
            role: true,
            Subscription: true,
          },
        },
      },
    });

    if (!business || !business.isActive) {
      return { hasAccess: false, accessType: "none", message: "Site not found or inactive" };
    }

    if (isPlatformStaffSubscriptionBypassRole(business.User.role)) {
      return {
        hasAccess: true,
        accessType: "admin",
        isAdmin: true,
        message: "Admin user - full access",
      };
    }

    const ws = business.websiteSubscription;
    const userSub = business.User.Subscription;

    if (ws) {
      if (ws.status === "active" || (ws.status === "active" && ws.trialStatus === "converted")) {
        return { hasAccess: true, accessType: "subscription" };
      }

      if (ws.trialStatus === "trialing" && ws.trialEndDate && ws.trialEndDate > new Date()) {
        const daysLeft: number = Math.ceil(
          (ws.trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        return { hasAccess: true, accessType: "trial", daysLeft };
      }

      if (ws.trialStatus === "expired" || (ws.trialStatus === "trialing" && ws.trialEndDate && ws.trialEndDate <= new Date())) {
        return {
          hasAccess: false,
          accessType: "trial_expired",
          message: "This site's trial has ended. Subscribe to continue.",
        };
      }

      if (ws.status === "canceled" || ws.status === "suspended") {
        return { hasAccess: false, accessType: "none", message: "Site subscription is inactive" };
      }
    }

    if (userSub?.status === "active") {
      return { hasAccess: true, accessType: "subscription" };
    }

    if (userSub?.status === "trialing") {
      if (!userSub.currentPeriodEnd || userSub.currentPeriodEnd > new Date()) {
        const daysLeft =
          userSub.currentPeriodEnd != null
            ? Math.ceil(
                (userSub.currentPeriodEnd.getTime() - Date.now()) /
                  (1000 * 60 * 60 * 24),
              )
            : undefined;
        return { hasAccess: true, accessType: "trial", daysLeft };
      }

      return {
        hasAccess: false,
        accessType: "trial_expired",
        message: "This site's trial has ended. Subscribe to continue.",
      };
    }

    if (business.websiteStatus === "trial") {
      return { hasAccess: true, accessType: "trial" };
    }

    if (business.websiteStatus === "expired") {
      return {
        hasAccess: false,
        accessType: "trial_expired",
        message: "This site's trial has ended. Subscribe to continue.",
      };
    }

    return { hasAccess: false, accessType: "none", message: "No entitlement for this site" };
  } catch (error) {
    console.error("Error checking site access:", error);
    return { hasAccess: false, accessType: "none", message: "Error checking access" };
  }
}

export const TRIAL_FEATURE_LIMITS: Record<string, boolean | number> = {
  blogGeneration: false,
  viewExistingBlogs: true,
  viewKeywords: true,
  editKeywords: false,
  viewBacklinks: true,
  publishingIntegrations: false,
  apiAccess: false,
  maxWebsites: 1,
  googleMyBusiness: true,
  businessSettings: true,
};

export function canAccessFeature(
  accessStatus: AccessStatus | SiteAccessStatus,
  feature: string
): boolean {
  if (accessStatus.accessType === "admin") {
    return true;
  }

  if (accessStatus.accessType === "subscription" || ("accessType" in accessStatus && accessStatus.accessType === "legacy")) {
    return true;
  }

  if (accessStatus.accessType === "trial") {
    return Boolean(TRIAL_FEATURE_LIMITS[feature]);
  }

  return false;
}
