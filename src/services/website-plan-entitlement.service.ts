import type { WebsitePlanTier } from "@prisma/client";

import { prisma } from "../config/db.config";
import {
  checkSiteAccess,
  type SiteAccessStatus,
} from "../utils/access-control.utils";
import {
  isPlatformStaffSubscriptionBypassRole,
} from "../utils/platform-role.utils";

export const WEBSITE_PLAN_TIERS = ["SEO", "SEO_SOCIAL"] as const;

export type WebsitePlanFeature =
  | "seo"
  | "social_generation"
  | "social_scheduling"
  | "social_publishing";

export type WebsiteFeatureAccessStatus = SiteAccessStatus & {
  feature: WebsitePlanFeature;
  planTier: WebsitePlanTier | null;
};

type BusinessPlanEntitlement = {
  planTier: WebsitePlanTier | null;
  role: string;
};

type WebsitePlanEntitlementDependencies = {
  checkSiteAccess?: (businessId: string) => Promise<SiteAccessStatus>;
  getBusinessPlanEntitlement?: (
    businessId: string,
  ) => Promise<BusinessPlanEntitlement | null>;
};

async function getBusinessPlanEntitlement(
  businessId: string,
): Promise<BusinessPlanEntitlement | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      User: { select: { role: true } },
      websiteSubscription: { select: { planTier: true } },
    },
  });
  if (!business) return null;
  return {
    planTier: business.websiteSubscription?.planTier ?? null,
    role: business.User.role,
  };
}

export function websitePlanIncludesFeature(
  planTier: WebsitePlanTier | null | undefined,
  feature: WebsitePlanFeature,
): boolean {
  if (feature === "seo") return true;
  return planTier === "SEO_SOCIAL";
}

export async function checkSiteFeatureAccess(
  businessId: string,
  feature: WebsitePlanFeature,
  dependencies: WebsitePlanEntitlementDependencies = {},
): Promise<WebsiteFeatureAccessStatus> {
  const siteAccess = await (
    dependencies.checkSiteAccess ?? checkSiteAccess
  )(businessId);
  if (!siteAccess.hasAccess) {
    return { ...siteAccess, feature, planTier: null };
  }

  if (siteAccess.accessType === "admin") {
    return { ...siteAccess, feature, planTier: "SEO_SOCIAL" };
  }

  const businessEntitlement = await (
    dependencies.getBusinessPlanEntitlement ?? getBusinessPlanEntitlement
  )(businessId);
  if (
    businessEntitlement &&
    isPlatformStaffSubscriptionBypassRole(businessEntitlement.role)
  ) {
    return {
      ...siteAccess,
      accessType: "admin",
      isAdmin: true,
      feature,
      planTier: "SEO_SOCIAL",
      message: "Admin user - full access",
    };
  }

  const planTier = businessEntitlement?.planTier ?? "SEO";
  if (!websitePlanIncludesFeature(planTier, feature)) {
    return {
      hasAccess: false,
      accessType: siteAccess.accessType,
      feature,
      planTier,
      message: "Upgrade to SEO + Social to generate recurring social content.",
    };
  }

  return { ...siteAccess, feature, planTier };
}
