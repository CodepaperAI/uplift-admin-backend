import { describe, expect, it } from "bun:test";
import {
  buildGoogleLocalPostPayload,
  normalizeGmbPostTypeForPublishing,
} from "../utils/google-my-business-local-post.utils";

describe("Google Business Profile LocalPost payload builder", () => {
  it("maps UPDATE posts to STANDARD with a LEARN_MORE CTA", () => {
    const result = buildGoogleLocalPostPayload({
      postType: "UPDATE",
      summary: "New spring service hours are now available.",
      callToAction: "https://example.com/services",
      businessWebsiteUrl: "https://example.com",
      defaultLocale: "en-CA",
    });

    expect(result.payload).toEqual({
      languageCode: "en-CA",
      summary: "New spring service hours are now available.",
      topicType: "STANDARD",
      callToAction: {
        actionType: "LEARN_MORE",
        url: "https://example.com/services",
      },
    });
    expect(result.effectivePostType).toBe("UPDATE");
    expect(result.warnings).toEqual([]);
  });

  it("maps PRODUCT aliases to STANDARD with a SHOP CTA", () => {
    const result = buildGoogleLocalPostPayload({
      postType: "PRODUCT",
      summary: "Highlighting our latest custom fragrance set.",
      callToAction: "https://example.com/products/fragrance-set",
      businessWebsiteUrl: "https://example.com",
      defaultLocale: "en-US",
    });

    expect(result.payload.topicType).toBe("STANDARD");
    expect(result.payload.callToAction).toEqual({
      actionType: "SHOP",
      url: "https://example.com/products/fragrance-set",
    });
    expect(result.effectivePostType).toBe("PRODUCT");
  });

  it("downgrades unsupported EVENT and OFFER posts to STANDARD", () => {
    const event = normalizeGmbPostTypeForPublishing("EVENT");
    const offer = normalizeGmbPostTypeForPublishing("OFFER");

    expect(event).toEqual({
      effectivePostType: "UPDATE",
      topicType: "STANDARD",
      warnings: [
        "EVENT posts were downgraded to STANDARD because the current product flow does not collect Google's required event fields yet.",
      ],
    });
    expect(offer).toEqual({
      effectivePostType: "UPDATE",
      topicType: "STANDARD",
      warnings: [
        "OFFER posts were downgraded to STANDARD because the current product flow does not collect Google's required offer fields yet.",
      ],
    });
  });

  it("filters invalid media and falls back to the business website URL when needed", () => {
    const result = buildGoogleLocalPostPayload({
      postType: "PRODUCT",
      summary: "Showcasing our featured product line.",
      callToAction: "Shop now",
      businessWebsiteUrl: "https://example.com",
      mediaUrls: [
        "https://cdn.example.com/hero.jpg",
        "not-a-url",
        "https://cdn.example.com/hero.jpg",
      ],
      defaultLocale: "bad-locale",
    });

    expect(result.payload.languageCode).toBe("en-US");
    expect(result.payload.callToAction).toEqual({
      actionType: "SHOP",
      url: "https://example.com/",
    });
    expect(result.payload.media).toEqual([
      {
        mediaFormat: "PHOTO",
        sourceUrl: "https://cdn.example.com/hero.jpg",
      },
    ]);
    expect(result.warnings).toEqual([
      "Destination URL was not a valid absolute URL, so the business website URL was used instead.",
      "One or more invalid media URLs were dropped before publishing.",
    ]);
  });

  it("never includes the internal title field in the outbound Google payload shape", () => {
    const result = buildGoogleLocalPostPayload({
      postType: "UPDATE",
      summary: "A standard update.",
      businessWebsiteUrl: "https://example.com",
    });

    expect("title" in result.payload).toBe(false);
  });
});
