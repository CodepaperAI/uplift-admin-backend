import { describe, expect, it } from "bun:test";

import { websitePlanIncludesFeature } from "../services/website-plan-entitlement.service";

describe("website plan feature entitlements", () => {
  it("keeps SEO available to both product tiers", () => {
    expect(websitePlanIncludesFeature("SEO", "seo")).toBe(true);
    expect(websitePlanIncludesFeature("SEO_SOCIAL", "seo")).toBe(true);
  });

  it("allows recurring social features only on SEO + Social", () => {
    for (const feature of [
      "social_generation",
      "social_scheduling",
      "social_publishing",
    ] as const) {
      expect(websitePlanIncludesFeature("SEO", feature)).toBe(false);
      expect(websitePlanIncludesFeature("SEO_SOCIAL", feature)).toBe(true);
    }
  });

  it("treats missing legacy tier data as SEO-only", () => {
    expect(websitePlanIncludesFeature(null, "social_generation")).toBe(false);
    expect(websitePlanIncludesFeature(undefined, "social_generation")).toBe(
      false,
    );
  });
});
