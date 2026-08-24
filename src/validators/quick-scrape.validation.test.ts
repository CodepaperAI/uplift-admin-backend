import { describe, expect, it } from "bun:test";
import {
  CONFIRM_SECONDARY_DETAILS,
  PATCH_ONBOARDING_V2_STATE,
  QUICK_BUSINESS_DETAILS,
  QUICK_SCRAPE,
} from "./quick-scrape.validation";

describe("QUICK_SCRAPE website URL validation", () => {
  it("accepts normalized URLs and bare domains", () => {
    expect(
      QUICK_SCRAPE.safeParse({
        userId: "user-1",
        websiteUrl: "https://palacioeventcentre.com/",
      }).success,
    ).toBe(true);
    expect(
      QUICK_SCRAPE.safeParse({
        userId: "user-1",
        websiteUrl: "example.co.uk",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed, credentialed, and non-public hosts", () => {
    for (const websiteUrl of [
      "not a website",
      "localhost",
      "https://example",
      "https://user:pass@example.com",
      "javascript:alert(1)",
    ]) {
      expect(
        QUICK_SCRAPE.safeParse({ userId: "user-1", websiteUrl }).success,
      ).toBe(false);
    }
  });
});

describe("onboarding phone validation", () => {
  const secondaryDetails = {
    businessAddress: "100 King Street West",
    businessCity: "Toronto",
    businessCountry: "Canada",
    businessName: "Example Inc.",
    businessState: "Ontario",
  };

  it("accepts omitted, null, and whitespace-only optional business phones", () => {
    expect(QUICK_BUSINESS_DETAILS.parse({}).businessPhone).toBeUndefined();
    expect(
      QUICK_BUSINESS_DETAILS.parse({ businessPhone: null }).businessPhone,
    ).toBeNull();
    expect(
      QUICK_BUSINESS_DETAILS.parse({ businessPhone: "   " }).businessPhone,
    ).toBeNull();
    expect(
      CONFIRM_SECONDARY_DETAILS.parse({
        ...secondaryDetails,
        businessPhone: "   ",
      }).businessPhone,
    ).toBeNull();
  });

  it("trims valid E.164 values consistently across secondary and v2 saves", () => {
    expect(
      CONFIRM_SECONDARY_DETAILS.parse({
        ...secondaryDetails,
        businessPhone: "  +14165550123  ",
      }).businessPhone,
    ).toBe("+14165550123");

    const v2 = PATCH_ONBOARDING_V2_STATE.parse({
      businessId: "26338194-2831-4525-b616-99bf6402d9da",
      businessDetails: { businessPhone: "  +14165550123  " },
    });
    expect(v2.businessDetails?.businessPhone).toBe("+14165550123");
  });

  it("rejects non-E.164 phone text on every user-provided business path", () => {
    for (const businessPhone of [
      "416-555-0123",
      "(416) 555-0123",
      "+0123456789",
      "+14165550123 ext 4",
      "call me",
    ]) {
      expect(
        QUICK_BUSINESS_DETAILS.safeParse({ businessPhone }).success,
      ).toBe(false);
      expect(
        CONFIRM_SECONDARY_DETAILS.safeParse({
          ...secondaryDetails,
          businessPhone,
        }).success,
      ).toBe(false);
    }
  });
});
