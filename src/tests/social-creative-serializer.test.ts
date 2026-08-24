import { describe, expect, test } from "bun:test";

import { serializeSocialCreativeRun } from "../controllers/social-creative.controller";

function runFixture(contentPlan: unknown) {
  return {
    id: "run-1",
    source: "MANUAL",
    estimatedBudgetUsd: "0.040000",
    actualCostUsd: null,
    contentPlan,
    posts: [
      {
        id: "post-1",
        platformCopy: { unsafe: true },
        assets: [],
      },
      {
        id: "post-2",
        platformCopy: { alsoUnsafe: true },
        assets: [],
      },
    ],
  };
}

describe("serializeSocialCreativeRun platform copy", () => {
  test("exposes the approved brand logo as a bounded public field", () => {
    const result = serializeSocialCreativeRun({
      ...runFixture({
        brandLogoUrl: "https://cdn.example.com/client-logo.png",
        brandReferences: [
          {
            role: "subject",
            url: "https://cdn.example.com/reference.png",
          },
        ],
      }),
      business: { businessName: "Origami Studios" },
    });

    expect(result.brandName).toBe("Origami Studios");
    expect(result.brandLogoUrl).toBe(
      "https://cdn.example.com/client-logo.png",
    );
  });

  test("does not expose unsafe brand logo URLs", () => {
    const result = serializeSocialCreativeRun(
      runFixture({
        brandReferences: [
          { role: "logo", url: "javascript:alert(1)" },
          { role: "logo", url: "https://user:secret@cdn.example.com/logo.png" },
        ],
      }),
    );

    expect(result.brandLogoUrl).toBeNull();
  });

  test("serializes weekday X as text-only noon and evening slots", () => {
    const result = serializeSocialCreativeRun({
      ...runFixture({}),
      source: "SCHEDULE",
      requestedPlatforms: ["instagram", "facebook", "linkedin", "x"],
      socialTopicPlan: {
        scheduledFor: new Date("2026-08-24T12:30:00.000Z"),
        timezone: "America/Toronto",
      },
      sourcePlan: { publishDate: "2026-08-24", publishTime: "07:30" },
    });

    expect(result.schedule).toBeNull();
    expect(result.scheduledFor).toBe("2026-08-24T12:30:00.000Z");
    expect(result.scheduleTimezone).toBe("America/Toronto");
    expect(result.requestedPlatforms).toEqual(["linkedin", "x"]);
    expect(result.imagePlatforms).toEqual(["linkedin"]);
    expect(result.platformSchedule).toEqual([
      {
        platform: "linkedin",
        slot: "primary",
        scheduledFor: "2026-08-24T12:30:00.000Z",
        mediaMode: "image",
      },
      {
        platform: "x",
        slot: "lunch",
        scheduledFor: "2026-08-24T16:00:00.000Z",
        mediaMode: "none",
      },
      {
        platform: "x",
        slot: "evening",
        scheduledFor: "2026-08-24T22:00:00.000Z",
        mediaMode: "none",
      },
    ]);
  });

  test("exposes only normalized supported copy on every post", () => {
    const result = serializeSocialCreativeRun(
      runFixture({
        language: "en",
        _usage: { responseId: "private-response" },
        platformCopy: {
          instagram: {
            caption: "  First line. #Legacy\r\nSecond line.  ",
            hashtags: [
              "#LocalSEO",
              "localseo",
              "SEO_Tips",
              "not valid",
              42,
            ],
            privatePrompt: "do not expose",
          },
          x: {
            caption: "A concise update for X.",
            hashtags: ["One", "Two", "Three"],
          },
          mastodon: {
            caption: "Unsupported platform copy.",
            hashtags: ["Private"],
          },
        },
      }),
    );

    const expected = {
      instagram: {
        caption: "First line.\nSecond line.",
        hashtags: [],
      },
      x: {
        caption: "A concise update for X.",
        hashtags: [],
      },
    };
    expect(result.contentPlan).toEqual({
      language: "en",
      platformCopy: expected,
    });
    expect(result.posts[0].platformCopy).toEqual(expected);
    expect(result.posts[1].platformCopy).toEqual(expected);
    expect(result.posts[0].platformCopy.instagram).not.toHaveProperty(
      "privatePrompt",
    );
    expect(result.contentPlan).not.toHaveProperty("_usage");
    expect(result).not.toHaveProperty("_usage");
  });

  test("exposes both sanitized X schedule variants without private plan data", () => {
    const result = serializeSocialCreativeRun(
      runFixture({
        _usage: { responseId: "private-response" },
        platformCopy: {
          x: { caption: "Base X caption.", hashtags: [] },
        },
        platformCopyVariants: {
          x: [
            {
              slot: "lunch",
              caption: "Lunch X caption. #RemoveMe",
              hashtags: ["RemoveMe"],
              privateReasoning: "never expose",
            },
            {
              slot: "evening",
              caption: "Evening X caption.",
              hashtags: [],
            },
          ],
          unknown: [
            { slot: "lunch", caption: "Unsupported.", hashtags: [] },
          ],
        },
      }),
    );

    const expectedVariants = {
      x: [
        { slot: "lunch", caption: "Lunch X caption.", hashtags: [] },
        { slot: "evening", caption: "Evening X caption.", hashtags: [] },
      ],
    };
    expect(result.contentPlan.platformCopyVariants).toEqual(expectedVariants);
    expect(result.posts[0].platformCopyVariants).toEqual(expectedVariants);
    expect(result.posts[1].platformCopyVariants).toEqual(expectedVariants);
    expect(result.contentPlan.platformCopyVariants.x[0]).not.toHaveProperty(
      "privateReasoning",
    );
    expect(result.contentPlan).not.toHaveProperty("_usage");
  });

  test("omits oversized and unknown platform copy instead of exposing raw data", () => {
    const result = serializeSocialCreativeRun(
      runFixture({
        topic: "Safe public plan data",
        _usage: { tokens: 999 },
        platformCopy: {
          x: {
            caption: "x".repeat(281),
            hashtags: [],
          },
          unknown: {
            caption: "This must not become public.",
            hashtags: ["Unknown"],
          },
        },
      }),
    );

    expect(result.contentPlan).toEqual({ topic: "Safe public plan data" });
    expect(result.posts[0]).not.toHaveProperty("platformCopy");
    expect(result.posts[1]).not.toHaveProperty("platformCopy");
  });

  test("omits malformed platform copy objects", () => {
    const stringCopy = serializeSocialCreativeRun(
      runFixture({ platformCopy: "not-an-object", _usage: { private: true } }),
    );
    const arrayCopy = serializeSocialCreativeRun(
      runFixture({ platformCopy: [{ caption: "not a map" }] }),
    );
    const malformedEntry = serializeSocialCreativeRun(
      runFixture({
        platformCopy: {
          instagram: { caption: "A valid caption", hashtags: "not-an-array" },
        },
      }),
    );

    expect(stringCopy.contentPlan).toEqual({});
    expect(arrayCopy.contentPlan).toEqual({});
    expect(malformedEntry.contentPlan).toEqual({});
    expect(stringCopy.posts[0]).not.toHaveProperty("platformCopy");
    expect(arrayCopy.posts[0]).not.toHaveProperty("platformCopy");
    expect(malformedEntry.posts[0]).not.toHaveProperty("platformCopy");
  });

  test("keeps legacy plans and posts free of the optional platformCopy field", () => {
    const result = serializeSocialCreativeRun(
      runFixture({ language: "en", slides: [{ caption: "Legacy caption" }] }),
    );

    expect(result.contentPlan).toEqual({
      language: "en",
      slides: [{ caption: "Legacy caption" }],
    });
    expect(result.posts[0]).not.toHaveProperty("platformCopy");
    expect(result.posts[1]).not.toHaveProperty("platformCopy");
  });
});
