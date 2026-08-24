import { describe, expect, test } from "bun:test";

import {
  getSocialCreativeRetryEntitlementError,
} from "../controllers/social-creative.controller";
import {
  requireSocialTopicPlanningEntitlement,
} from "../services/social-topic-planner.service";
import {
  checkSiteFeatureAccess,
} from "../services/website-plan-entitlement.service";
import {
  resolveSiteAccessWhenPerSiteTrialsDisabled,
} from "../utils/access-control.utils";

describe("social entitlement enforcement", () => {
  test.each(["ADMIN", "SUPERADMIN"])(
    "%s keeps the platform bypass when per-site trials are disabled",
    (role) => {
      expect(resolveSiteAccessWhenPerSiteTrialsDisabled(role)).toMatchObject({
        hasAccess: true,
        accessType: "admin",
        isAdmin: true,
      });
    },
  );

  test("keeps the disabled-flag result unchanged for non-admin users", () => {
    expect(resolveSiteAccessWhenPerSiteTrialsDisabled("USER")).toEqual({
      hasAccess: true,
      accessType: "subscription",
    });
    expect(resolveSiteAccessWhenPerSiteTrialsDisabled(null)).toEqual({
      hasAccess: true,
      accessType: "subscription",
    });
  });

  test("never lets the disabled trial flag revive an inactive website", () => {
    expect(
      resolveSiteAccessWhenPerSiteTrialsDisabled("USER", {
        exists: true,
        isActive: false,
        websiteStatus: "canceled",
        removalStatus: "active",
      }),
    ).toEqual({
      hasAccess: false,
      accessType: "none",
      message: "Site is unavailable",
    });

    expect(
      resolveSiteAccessWhenPerSiteTrialsDisabled("ADMIN", {
        exists: false,
        isActive: false,
      }).hasAccess,
    ).toBe(false);
  });

  test.each(["ADMIN", "SUPERADMIN"])(
    "%s bypasses the tier check even when base access is reported as subscription",
    async (role) => {
      const access = await checkSiteFeatureAccess(
        "business-1",
        "social_generation",
        {
          checkSiteAccess: async () => ({
            hasAccess: true,
            accessType: "subscription",
          }),
          getBusinessPlanEntitlement: async () => ({
            planTier: "SEO",
            role,
          }),
        },
      );

      expect(access).toMatchObject({
        hasAccess: true,
        accessType: "admin",
        isAdmin: true,
        planTier: "SEO_SOCIAL",
      });
    },
  );

  test("preserves the non-admin SEO tier denial", async () => {
    const access = await checkSiteFeatureAccess(
      "business-1",
      "social_generation",
      {
        checkSiteAccess: async () => ({
          hasAccess: true,
          accessType: "subscription",
        }),
        getBusinessPlanEntitlement: async () => ({
          planTier: "SEO",
          role: "USER",
        }),
      },
    );

    expect(access).toMatchObject({
      hasAccess: false,
      accessType: "subscription",
      planTier: "SEO",
    });
  });

  test("preserves non-admin base access and SEO + Social tier decisions", async () => {
    let entitlementLookups = 0;
    const deniedBaseAccess = await checkSiteFeatureAccess(
      "business-1",
      "social_generation",
      {
        checkSiteAccess: async () => ({
          hasAccess: false,
          accessType: "trial_expired",
        }),
        getBusinessPlanEntitlement: async () => {
          entitlementLookups += 1;
          return { planTier: "SEO_SOCIAL", role: "USER" };
        },
      },
    );
    expect(deniedBaseAccess).toMatchObject({
      hasAccess: false,
      accessType: "trial_expired",
      planTier: null,
    });
    expect(entitlementLookups).toBe(0);

    const entitled = await checkSiteFeatureAccess(
      "business-1",
      "social_generation",
      {
        checkSiteAccess: async () => ({
          hasAccess: true,
          accessType: "subscription",
        }),
        getBusinessPlanEntitlement: async () => ({
          planTier: "SEO_SOCIAL",
          role: "USER",
        }),
      },
    );
    expect(entitled).toMatchObject({
      hasAccess: true,
      accessType: "subscription",
      planTier: "SEO_SOCIAL",
    });
  });

  test("topic planning delegates to the centralized feature entitlement", async () => {
    const calls: Array<[string, string]> = [];
    await expect(
      requireSocialTopicPlanningEntitlement(
        "business-1",
        async (businessId, feature) => {
          calls.push([businessId, feature]);
          return {
            hasAccess: false,
            message: "Upgrade to SEO + Social",
          };
        },
      ),
    ).rejects.toThrow("Upgrade to SEO + Social");
    expect(calls).toEqual([["business-1", "social_generation"]]);

    await expect(
      requireSocialTopicPlanningEntitlement("business-1", async () => ({
        hasAccess: true,
      })),
    ).resolves.toBeUndefined();
  });

  test("retry refuses dispatch when the owned run's business is not entitled", async () => {
    const calls: Array<[string, string]> = [];
    const error = await getSocialCreativeRetryEntitlementError(
      "business-1",
      async (businessId, feature) => {
        calls.push([businessId, feature]);
        return {
          hasAccess: false,
          message: "Upgrade to SEO + Social",
        };
      },
    );

    expect(error).toBe("Upgrade to SEO + Social");
    expect(calls).toEqual([["business-1", "social_generation"]]);
    expect(
      await getSocialCreativeRetryEntitlementError(
        "business-1",
        async () => ({ hasAccess: true }),
      ),
    ).toBeNull();
  });
});
