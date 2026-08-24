import { describe, expect, it } from "bun:test";
import {
  buildGmbUtmUrl,
  calculateGMBProfileHealthScore,
  calculateLocalResultMatchConfidence,
  humanizeGoogleServiceTypeId,
  trimDescriptionToRecommendedLimit,
} from "../services/gmb-local-visibility.service";

describe("GMB local visibility scoring", () => {
  it("scores a complete, active profile highly", () => {
    const result = calculateGMBProfileHealthScore({
      hasName: true,
      hasAddress: true,
      hasPhone: true,
      hasWebsite: true,
      categoriesCount: 3,
      hasRegularHours: true,
      hasSpecialHours: true,
      hasDescription: true,
      descriptionLength: 320,
      serviceItemsCount: 8,
      hasAttributes: true,
      averageRating: 4.8,
      reviewCount: 65,
      unansweredReviews: 0,
      negativeUnansweredReviews: 0,
      recentReviewCount: 5,
      reviewResponseRate: 0.95,
      recentPostCount: 4,
      mediaAssetCount: 12,
      recentMediaPublishedCount: 2,
      conversionActions30d: 75,
      discoveryKeywordCount: 30,
      rankScanCount30d: 2,
      bestClientRank: 2,
      competitorCount: 8,
      attributionLinkCount: 3,
      hasReviewLink: true,
      verificationState: "VERIFIED",
      isVerified: true,
      hasPrimaryCategoryStructured: true,
      structuredCategoriesCount: 3,
      weeklyHoursDaysCovered: 7,
      structuredAttributesCount: 6,
      timezoneSet: true,
    });

    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.items.every((item) => item.checkKey !== "q_and_a")).toBe(true);
  });

  it("flags approval-ready gaps for weak profiles", () => {
    const result = calculateGMBProfileHealthScore({
      hasName: true,
      hasAddress: false,
      hasPhone: false,
      hasWebsite: false,
      categoriesCount: 0,
      hasRegularHours: false,
      hasSpecialHours: false,
      hasDescription: false,
      descriptionLength: 0,
      serviceItemsCount: 0,
      hasAttributes: false,
      averageRating: 3.2,
      reviewCount: 2,
      unansweredReviews: 4,
      negativeUnansweredReviews: 1,
      recentReviewCount: 0,
      reviewResponseRate: 0,
      recentPostCount: 0,
      mediaAssetCount: 0,
      recentMediaPublishedCount: 0,
      conversionActions30d: 0,
      discoveryKeywordCount: 0,
      rankScanCount30d: 0,
      bestClientRank: null,
      competitorCount: 0,
      attributionLinkCount: 0,
      hasReviewLink: false,
      verificationState: null,
      isVerified: false,
      hasPrimaryCategoryStructured: false,
      structuredCategoriesCount: 0,
      weeklyHoursDaysCovered: 0,
      structuredAttributesCount: 0,
      timezoneSet: false,
    });

    expect(result.score).toBeLessThan(45);
    expect(result.items.some((item) => item.status === "fail")).toBe(true);
    expect(
      result.items.some((item) => item.checkKey === "unanswered_reviews"),
    ).toBe(true);
    expect(
      result.items.some((item) => item.checkKey === "verification_state"),
    ).toBe(true);
    expect(
      result.items.some((item) => item.checkKey === "primary_category_structured"),
    ).toBe(true);
  });
});

describe("GMB attribution links", () => {
  it("adds standardized GBP UTM parameters without dropping existing query params", () => {
    const url = buildGmbUtmUrl("https://example.com/services?ref=profile", {
      campaign: "gbp",
      content: "post",
    });

    expect(url).toContain("ref=profile");
    expect(url).toContain("utm_source=google");
    expect(url).toContain("utm_medium=organic");
    expect(url).toContain("utm_campaign=gbp");
    expect(url).toContain("utm_content=post");
  });
});

describe("GMB local result matching", () => {
  it("confirms matches by hard Google identifiers", () => {
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Example Dental",
        placeId: "place-123",
        cid: null,
        domain: null,
        url: null,
        address: null,
      },
      businessName: "Different Name",
      placeId: "place-123",
    });

    expect(match).toEqual({ confidence: 1, matchedBy: "place_id" });
  });

  it("does not treat a fuzzy name-only match as confirmed", () => {
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Example Dental Clinic",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: null,
      },
      businessName: "Example Dental",
      businessAddress: "10 King Street",
      businessWebsite: "https://exampledental.com",
    });

    expect(match.matchedBy).toBe("fuzzy_name");
    expect(match.confidence).toBeLessThan(0.75);
  });

  it("confirms exact title equality when local_pack omits ids and address", () => {
    // DataForSEO organic-SERP local_pack often returns only title + rank for
    // the 3-pack — no place_id, no cid, no detailed address. An exact
    // normalized title match in that geo-scoped 3-pack is still the same
    // business in practice.
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Shawarma Moose",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: null,
      },
      businessName: "Shawarma Moose",
      businessAddress: "898 College St",
      businessWebsite: "https://shawarmamoose.ca",
    });

    expect(match.matchedBy).toBe("exact_name");
    expect(match.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("does not promote substring-only title matches to exact_name", () => {
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Shawarma Moose Catering",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: null,
      },
      businessName: "Shawarma Moose",
    });

    expect(match.matchedBy).toBe("fuzzy_name");
    expect(match.confidence).toBeLessThan(0.75);
  });

  it("matches name_address when addresses share street number + street name despite formatting", () => {
    // Stored: short form. Returned: long form with directional, city, postal.
    // Old 18-char-prefix check would still pass here, but assert the new
    // token-based path keeps doing the right thing.
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Example Pizza",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: "898 College Street W, Toronto, ON M6H 1A1",
      },
      businessName: "Example Pizza",
      businessAddress: "898 College St",
    });

    expect(match.matchedBy).toBe("name_address");
    expect(match.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("promotes decorated-title containment to name_address_partial when addresses corroborate", () => {
    // Google sometimes returns the business with a decorated title like
    // "Shawarma Moose - Toronto" or "Shawarma Moose · College St". This used
    // to fall to fuzzy_name (rejected). With street-token corroboration it
    // now reaches the accept threshold.
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Shawarma Moose - Toronto",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: "898 College St W, Toronto, ON",
      },
      businessName: "Shawarma Moose",
      businessAddress: "898 College St",
    });

    expect(match.matchedBy).toBe("name_address_partial");
    expect(match.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("keeps containment-only match at fuzzy_name when addresses do not corroborate", () => {
    // Different street -> not safe to promote, even with name containment.
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Shawarma Moose Junction",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: "10 King Street E, Toronto, ON",
      },
      businessName: "Shawarma Moose",
      businessAddress: "898 College St",
    });

    expect(match.matchedBy).toBe("fuzzy_name");
    expect(match.confidence).toBeLessThan(0.75);
  });

  it("trims overlong description at the last sentence boundary under the limit", () => {
    const longDescription =
      "Shawarma Moose is a Toronto-based fast-casual shawarma and Turkish/Mediterranean spot known for the best shawarma in town. " +
      "The menu features authentic Middle Eastern staples like zesty chicken and beef shawarma, hearty bowls and plates, crunchy falafel, and specialty Saj wraps crafted with fresh ingredients. " +
      "Guests can dine in, grab a quick bite, or order online through a Square secured checkout for pickup or delivery. " +
      "Beyond the restaurant, Shawarma Moose focuses on Mediterranean and Greek catering for offices and events across Toronto and the GTA. " +
      "They offer flexible formats including individually packaged meal boxes, buffet style trays, sandwich platters, and warehouse staff catering, making it easy to feed teams at scale.";

    const trimmed = trimDescriptionToRecommendedLimit(longDescription);

    expect(trimmed.length).toBeLessThanOrEqual(700);
    expect(/[.!?]$/.test(trimmed)).toBe(true);
    expect(trimmed.startsWith("Shawarma Moose")).toBe(true);
  });

  it("leaves a short description untouched", () => {
    const short = "Short and snappy business description.";
    expect(trimDescriptionToRecommendedLimit(short)).toBe(short);
  });

  it("returns empty string on empty input", () => {
    expect(trimDescriptionToRecommendedLimit("")).toBe("");
    expect(trimDescriptionToRecommendedLimit("   ")).toBe("");
  });

  it("does not promote when only street name overlaps but street number differs", () => {
    // Two businesses on College St at different numbers must not be conflated
    // even if names contain each other.
    const match = calculateLocalResultMatchConfidence({
      result: {
        title: "Pizza Palace Cafe",
        placeId: null,
        cid: null,
        domain: null,
        url: null,
        address: "412 College Street, Toronto, ON",
      },
      businessName: "Pizza Palace",
      businessAddress: "898 College St",
    });

    expect(match.matchedBy).toBe("fuzzy_name");
    expect(match.confidence).toBeLessThan(0.75);
  });
});

describe("GMB service labels", () => {
  it("turns Google structured service IDs into readable labels", () => {
    expect(humanizeGoogleServiceTypeId("job_type_id:home_purchase")).toBe(
      "Home Purchase",
    );
    expect(humanizeGoogleServiceTypeId("job_type_id:rate_shopping")).toBe(
      "Rate Shopping",
    );
    expect(humanizeGoogleServiceTypeId("Commercial Mortgage")).toBe("");
  });
});
