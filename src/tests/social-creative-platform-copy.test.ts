import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { planSocialCreativeRun } from "../services/social-creative/pipeline";
import {
  buildDeterministicSocialPlatformCopy,
  buildDeterministicSocialPlatformCopyVariants,
  formatSocialPlatformCopy,
  planSocialPlatformCopy,
  SOCIAL_PLATFORM_COPY_LIMITS,
  validateSocialPlatformCopy,
  type SocialPlatformCopyInput,
} from "../services/social-creative/platform-copy";
import type {
  SocialCreativeBrandContext,
  SocialPlatform,
} from "../services/social-creative/types";
import { WEBSITE_CAMPAIGN_PLATFORM_FORMATS } from "../services/social-creative/website-campaign";

const platforms: SocialPlatform[] = [
  "instagram",
  "facebook",
  "linkedin",
  "x",
];

const brand: SocialCreativeBrandContext = {
  userId: "user-1",
  businessId: "business-1",
  businessName: "LunchLink",
  businessType: "Workplace catering",
  businessDescription:
    "LunchLink coordinates workplace meals for teams in Toronto.",
  websiteUrl: "https://lunchlink.example/",
  phone: "+1 416 555 0100",
  city: "Toronto",
  state: "Ontario",
  country: "Canada",
  language: "en",
  locale: "en-CA",
  tone: "warm and practical",
  targetAudience: "Office managers coordinating team meals",
  services: ["Team lunches", "Recurring meal programs"],
  primaryColors: ["#063F2B"],
  secondaryColors: ["#F47721"],
  fontFamily: "Montserrat",
  logoUrl: "https://cdn.example.com/lunchlink.svg",
  referenceImageUrls: [],
  recentCreativeHistory: [],
  brandVoice: "Warm, concise, practical",
  keyMessages: ["One coordinated order can cover the whole team."],
  socialContentAngles: ["Planning team lunches"],
  verifiedActions: [
    {
      type: "website",
      label: "View services",
      value: "https://lunchlink.example/",
    },
  ],
};

function copyInput(
  overrides: Partial<SocialPlatformCopyInput> = {},
): SocialPlatformCopyInput {
  return {
    context: brand,
    platforms,
    topic: "Planning recurring team lunches",
    hook: "A practical way to plan recurring team lunches",
    cta: "View the meal programs",
    objective: "education",
    idempotencyKey: "social-creative:run-1:platform-copy:v1",
    ...overrides,
  };
}

function modelLinkedInCaption(): string {
  return [
    "Team lunches need a clearer coordination plan.",
    "Office managers coordinating recurring workplace meals have to bring the schedule, the group order, and the needs of the whole team into one practical process.",
    "LunchLink coordinates workplace meals for teams in Toronto, with team lunches and recurring meal programs grounded in one coordinated order for the workplace.",
    "A useful planning process starts with the recurring need, keeps the order connected to the team, and gives the office manager a clear service to review for each workplace meal.",
    "For office managers, that means the conversation can stay focused on planning the team lunch instead of treating every workplace meal as a separate arrangement.",
    "The service is designed for office managers coordinating team meals and for Toronto workplaces reviewing a practical recurring meal program for their teams.",
    "One coordinated order can cover the whole team, which is the key message LunchLink provides for recurring workplace meal planning.",
    "View the meal programs: https://lunchlink.example/",
  ].join("\n\n");
}

describe("social creative platform copy", () => {
  test("builds deterministic, distinct, bounded and grounded fallback copy", () => {
    const input = copyInput();
    const first = buildDeterministicSocialPlatformCopy(input);
    const second = buildDeterministicSocialPlatformCopy(input);
    expect(second).toEqual(first);

    const captions = new Set<string>();
    for (const platform of platforms) {
      const copy = first[platform]!;
      const limits = SOCIAL_PLATFORM_COPY_LIMITS[platform];
      expect(formatSocialPlatformCopy(copy).length).toBeLessThanOrEqual(
        limits.maxCharacters,
      );
      expect(copy.hashtags).toEqual([]);
      expect(copy.caption).toContain("team lunch");
      expect(copy.caption).toContain("https://lunchlink.example/");
      captions.add(copy.caption);
    }
    expect(captions.size).toBe(4);
    for (const copy of Object.values(first)) {
      expect(copy?.caption).not.toMatch(
        /^(?:service|featured service|audience|target audience|location|objective|hook|cta)\s*:/imu,
      );
    }
    expect(formatSocialPlatformCopy(first.x!).length).toBeLessThanOrEqual(280);
  });

  test("keeps Instagram hashtag-free with sparse brand context", () => {
    const sparseBrand: SocialCreativeBrandContext = {
      ...brand,
      businessName: "A",
      businessType: "",
      businessDescription: "",
      city: null,
      state: null,
      country: null,
      targetAudience: null,
      services: [],
      keyMessages: [],
      socialContentAngles: [],
      differentiators: [],
      verifiedActions: [],
    };
    const input = copyInput({
      context: sparseBrand,
      platforms: ["instagram"],
      topic: "SEO",
      hook: null,
      cta: null,
    });
    const copy = buildDeterministicSocialPlatformCopy(input).instagram!;

    expect(copy.hashtags).toEqual([]);
    expect(formatSocialPlatformCopy({
      ...copy,
      hashtags: ["LegacyTag"],
    })).toBe(copy.caption);
    expect(formatSocialPlatformCopy(copy).length).toBeLessThanOrEqual(1_800);
  });

  test("keeps a verified X URL whole or omits it when it cannot fit", () => {
    const equivalentUrl = validateSocialPlatformCopy(
      {
        x: {
          caption:
            "Planning recurring team lunches\n\nOne coordinated order can cover the team.\n\nhttps://lunchlink.example",
          hashtags: [],
        },
      },
      copyInput({ platforms: ["x"] }),
    ).x!;
    expect(equivalentUrl.caption).toContain("https://lunchlink.example");

    const preservedUrl = `https://lunchlink.example/${"team-lunch-planning-".repeat(4)}book`;
    const preservedInput = copyInput({
      context: {
        ...brand,
        websiteUrl: preservedUrl,
        verifiedActions: [
          { type: "booking", label: "Book", value: preservedUrl },
        ],
      },
      platforms: ["x"],
      hook: `A practical way to plan recurring team lunches ${"clearly ".repeat(40)}`,
    });
    const preserved = buildDeterministicSocialPlatformCopy(preservedInput).x!;
    expect(preserved.caption).toContain(preservedUrl);
    expect(preserved.caption.match(/https?:\/\/[^\s)]+/)?.[0]).toBe(preservedUrl);
    expect(formatSocialPlatformCopy(preserved).length).toBeLessThanOrEqual(280);

    const oversizedUrl = `https://lunchlink.example/${"team-lunch-planning-".repeat(20)}book`;
    const omittedInput = copyInput({
      context: {
        ...brand,
        websiteUrl: oversizedUrl,
        verifiedActions: [
          { type: "booking", label: "Book", value: oversizedUrl },
        ],
      },
      platforms: ["x"],
    });
    const omitted = buildDeterministicSocialPlatformCopy(omittedInput).x!;
    expect(omitted.caption).not.toContain("http");
    expect(formatSocialPlatformCopy(omitted).length).toBeLessThanOrEqual(280);
  });

  test("grounds promotion copy in supplied facts, duration, and extracted document text", async () => {
    const promotionBrand: SocialCreativeBrandContext = {
      ...brand,
      recentPositiveReviews: [
        {
          excerpt: "The team made our recurring lunches easy to coordinate.",
          rating: 5,
          reviewedAt: "2026-08-18T14:00:00.000Z",
          source: "google-business-profile",
        },
      ],
      promotion: {
        enabled: true,
        title: "August team lunch offer",
        information: "Save exactly 15% on an approved recurring meal program.",
        preferredContent: "Plan the team's August lunches before the deadline.",
        startsOn: "2026-08-19",
        endsOn: "2026-08-31",
        imageUrl: null,
        documentName: "offer.pdf",
        documentText:
          "The 15% offer applies only to recurring meal programs booked in advance.",
      },
    };
    const input = copyInput({
      context: promotionBrand,
      platforms: ["instagram", "x"],
      topic: "August team lunch offer",
      hook: null,
      cta: null,
    });
    const expected = buildDeterministicSocialPlatformCopy(input);
    const variants = buildDeterministicSocialPlatformCopyVariants(input, expected);
    expect(expected.instagram?.caption).toContain("15%");
    expect(expected.instagram?.caption).toContain(
      "2026-08-19 through 2026-08-31",
    );

    const requests: Array<Record<string, any>> = [];
    const result = await planSocialPlatformCopy(input, {
      client: {
        responses: {
          create: async (candidate) => {
            requests.push(candidate);
            return {
              id: "resp-promotion",
              status: "completed",
              output_text: JSON.stringify({
                platformCopy: expected,
                platformCopyVariants: variants,
              }),
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            };
          },
        },
      },
    });
    expect(result.source).toBe("gpt-5.6-luna");
    expect(requests[0]?.instructions).toContain(
      "make that promotion the primary subject",
    );
    const modelInput = JSON.parse(String(requests[0]?.input));
    expect(modelInput.grounding.promotion).toMatchObject({
      title: "August team lunch offer",
      startsOn: "2026-08-19",
      endsOn: "2026-08-31",
      documentName: "offer.pdf",
    });
    expect(modelInput.grounding.promotion.documentText).toContain(
      "applies only to recurring meal programs",
    );
    expect(modelInput.grounding.business.recentPositiveReviews).toEqual([
      {
        excerpt: "The team made our recurring lunches easy to coordinate.",
        rating: 5,
        reviewedAt: "2026-08-18T14:00:00.000Z",
        source: "google-business-profile",
      },
    ]);
    expect(requests[0]?.instructions).toContain(
      "never invent a reviewer identity",
    );
  });

  test("rejects hashtags, invalid platform shapes, unsupported facts, and over-limit copy", () => {
    const input = copyInput({ platforms: ["x"] });
    const sanitizedInlineHashtag = validateSocialPlatformCopy(
      {
        x: {
          caption:
            "Planning team lunches #TeamLunch\n\nA grounded team lunch detail.\n\nKeep the plan practical.",
          hashtags: [],
        },
      },
      input,
    ).x!;
    expect(sanitizedInlineHashtag.caption).toBe(
      "Planning team lunches\n\nA grounded team lunch detail.\n\nKeep the plan practical.",
    );
    expect(sanitizedInlineHashtag.caption).not.toContain("#");

    expect(() =>
      validateSocialPlatformCopy(
        {
          instagram: {
            caption:
              "A practical team lunch starts with a clear plan.\nService: Corporate catering.\n\nAudience: Office managers planning recurring events.",
            hashtags: [],
          },
        },
        copyInput({ platforms: ["instagram"] }),
      ),
    ).toThrow("exposes internal context labels");
    expect(() =>
      validateSocialPlatformCopy(
        {
          x: {
            caption: "Planning team lunches\n\nA grounded detail.\n\nA grounded point.",
            hashtags: ["TeamLunch"],
          },
        },
        input,
      ),
    ).toThrow("hashtags must be empty");
    expect(() =>
      validateSocialPlatformCopy(
        { x: { caption: "Planning team lunches in one line.", hashtags: [] } },
        input,
      ),
    ).toThrow("exactly three copy lines");
    expect(() =>
      validateSocialPlatformCopy(
        {
          x: {
            caption:
              "Planning team lunches\n\nA guaranteed 99% success rate.\n\nThe result is certain.",
            hashtags: [],
          },
        },
        input,
      ),
    ).toThrow(/unsupported claim|unsupported number/);
    expect(() =>
      validateSocialPlatformCopy(
        {
          x: {
            caption: `Planning team lunches ${"useful ".repeat(60)}`,
            hashtags: [],
          },
        },
        input,
      ),
    ).toThrow("exceeds 280");
    expect(() =>
      validateSocialPlatformCopy(
        {
          x: {
            caption:
              "Planning team lunches\n\nA useful operational detail.\n\nhttps://unverified.example/",
            hashtags: [],
          },
        },
        input,
      ),
    ).toThrow("unverified URL");

    const instagramInput = copyInput({ platforms: ["instagram"] });
    expect(() =>
      validateSocialPlatformCopy(
        {
          instagram: {
            caption: `${"Planning recurring team lunches clearly ".repeat(5)}\n\nUseful detail.`,
            hashtags: [],
          },
        },
        instagramInput,
      ),
    ).toThrow("opening line must be 125 characters or fewer");

    const linkedinInput = copyInput({ platforms: ["linkedin"] });
    expect(() =>
      validateSocialPlatformCopy(
        {
          linkedin: {
            caption:
              "Planning recurring team lunches requires far more words than this hook should contain\n\nUseful detail.",
            hashtags: [],
          },
        },
        linkedinInput,
      ),
    ).toThrow("hook must be 10 words or fewer");
    expect(() =>
      validateSocialPlatformCopy(
        {
          linkedin: {
            caption: "Team lunches work better.\nUseful grounded detail.",
            hashtags: [],
          },
        },
        linkedinInput,
      ),
    ).toThrow("paragraphs must be separated by blank lines");
    expect(() =>
      validateSocialPlatformCopy(
        {
          linkedin: {
            caption: "Team lunches need a plan.\n\nUseful grounded detail.",
            hashtags: [],
          },
        },
        linkedinInput,
      ),
    ).toThrow("at least 600 characters");
  });

  test("uses one idempotent GPT-5.6 Luna structured-output call for all platforms", async () => {
    const input = copyInput();
    const expected = buildDeterministicSocialPlatformCopy(input);
    const modelExpected = {
      ...expected,
      linkedin: {
        caption: modelLinkedInCaption(),
        hashtags: [],
      },
    };
    const expectedVariants = buildDeterministicSocialPlatformCopyVariants(
      input,
      expected,
    );
    const calls: Array<{ request: any; options: any }> = [];
    const result = await planSocialPlatformCopy(input, {
      client: {
        responses: {
          create: async (request, options) => {
            calls.push({ request, options });
            return {
              id: "resp-copy-1",
              status: "completed",
              output_text: JSON.stringify({
                platformCopy: modelExpected,
                platformCopyVariants: expectedVariants,
              }),
              usage: {
                input_tokens: 500,
                output_tokens: 200,
                total_tokens: 700,
              },
            };
          },
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.model).toBe("gpt-5.6-luna");
    expect(calls[0]?.request.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
    expect(calls[0]?.request.text.format.schema.properties.platformCopy.required).toEqual(
      platforms,
    );
    expect(calls[0]?.options).toEqual({ idempotencyKey: input.idempotencyKey });
    expect(calls[0]?.request.instructions).toContain(
      "grounding.business.language",
    );
    expect(calls[0]?.request.instructions).toContain(
      "grounding.business.locale",
    );
    expect(calls[0]?.request.instructions).toContain("Never use hashtags");
    expect(calls[0]?.request.instructions).toContain(
      "exactly three non-empty copy lines",
    );
    expect(calls[0]?.request.instructions).toContain(
      "Use a different formula and opening angle on every requested platform",
    );
    expect(calls[0]?.request.instructions).toContain(
      "Apply the swap test silently",
    );
    expect(calls[0]?.request.instructions).toContain(
      "Rewrite internally until every category is strong",
    );
    expect(
      calls[0]?.request.text.format.schema.properties.platformCopy.properties
        .instagram.properties.hashtags.maxItems,
    ).toBe(0);
    expect(
      calls[0]?.request.text.format.schema.properties.platformCopy.properties
        .linkedin.properties.caption.minLength,
    ).toBe(600);
    const requestInput = JSON.parse(String(calls[0]?.request.input));
    expect(requestInput.grounding.business.language).toBe("en");
    expect(requestInput.grounding.business.locale).toBe("en-CA");
    expect(result).toMatchObject({
      platformCopy: modelExpected,
      platformCopyVariants: expectedVariants,
      source: "gpt-5.6-luna",
      version: "social-platform-copy-v7-agent-testing-editorial",
      usage: {
        responseId: "resp-copy-1",
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
      },
    });
  });

  test("falls back deterministically when GPT-5.6 Luna fails or violates the contract", async () => {
    const input = copyInput();
    const expected = buildDeterministicSocialPlatformCopy(input);
    const failed = await planSocialPlatformCopy(input, {
      client: {
        responses: {
          create: async () => {
            throw new Error("provider unavailable");
          },
        },
      },
    });
    expect(failed).toMatchObject({
      platformCopy: expected,
      source: "deterministic-fallback",
      fallbackReason: "provider unavailable",
    });

    const invalid = await planSocialPlatformCopy(input, {
      client: {
        responses: {
          create: async () => ({
            id: "resp-invalid",
            status: "completed",
            output_text: JSON.stringify({
              platformCopy: Object.fromEntries(
                platforms.map((platform) => [
                  platform,
                  { caption: "Best guaranteed results", hashtags: [] },
                ]),
              ),
            }),
          }),
        },
      },
    });
    expect(invalid.platformCopy).toEqual(expected);
    expect(invalid.source).toBe("deterministic-fallback");
  });

  test("falls back per platform without discarding valid model copy", async () => {
    const input = copyInput();
    const expected = buildDeterministicSocialPlatformCopy(input);
    const expectedVariants = buildDeterministicSocialPlatformCopyVariants(
      input,
      expected,
    );
    const validInstagram = {
      caption:
        "Team lunches can be easier.\n\nLunchLink coordinates workplace meals for teams in Toronto.\n\nView the meal programs: https://lunchlink.example/",
      hashtags: [],
    };
    const result = await planSocialPlatformCopy(input, {
      client: {
        responses: {
          create: async () => ({
            id: "resp-mixed",
            status: "completed",
            output_text: JSON.stringify({
              platformCopy: {
                ...expected,
                instagram: validInstagram,
                linkedin: {
                  caption:
                    "This LinkedIn hook contains more than ten words and must use fallback copy\n\nTeam lunches remain grounded.",
                  hashtags: [],
                },
              },
              platformCopyVariants: expectedVariants,
            }),
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          }),
        },
      },
    });

    expect(result.source).toBe("mixed");
    expect(result.fallbackReason).toContain("linkedin hook");
    expect(result.platformCopy.instagram).toEqual(validInstagram);
    expect(result.platformCopy.linkedin).toEqual(expected.linkedin);
    expect(result.platformCopyVariants).toEqual(expectedVariants);
    expect(result.usage?.totalTokens).toBe(150);
  });

  test("persists platformCopy while preserving the shared caption fallback", async () => {
    let persistedContentPlan: any;
    const postCreates: any[] = [];
    const assetCreates: any[] = [];
    const run = {
      id: "run-1",
      idempotencyKey: "social-request-1",
      correlationId: "social-creative:run-1",
      userId: "user-1",
      businessId: "business-1",
      topic: "Planning recurring team lunches",
      kind: "single",
      source: "MANUAL",
      requestedPlatforms: platforms,
      contentPlan: null,
      posts: [],
      startedAt: null,
      socialTopicPlan: {
        hook: "A practical way to plan recurring team lunches",
        cta: "View the meal programs",
        objective: "education",
      },
    };
    const prisma: any = {
      socialCreativeRun: {
        findUnique: async () => run,
        update: async ({ data }: any) => {
          if (data.contentPlan) persistedContentPlan = data.contentPlan;
          return { ...run, ...data };
        },
      },
      socialCreativePost: {
        upsert: async ({ create }: any) => {
          postCreates.push(create);
          return { id: "post-1" };
        },
      },
      socialCreativeAsset: {
        upsert: async ({ create }: any) => {
          assetCreates.push(create);
          return { id: `asset-${create.platform}` };
        },
      },
      llmUsageEvent: {
        aggregate: async () => ({ _sum: { estimatedUsd: 0 } }),
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) =>
      callback(prisma);

    const result = await planSocialCreativeRun("run-1", {
      prisma: prisma as PrismaClient,
      checkAccess: async () => ({ hasAccess: true }) as any,
      loadBrand: async () => brand,
      prepareCampaign: async ({ platform }) => {
        const resolved = platform!;
        return {
          platform: resolved,
          format: WEBSITE_CAMPAIGN_PLATFORM_FORMATS[resolved],
          prompt: `image prompt for ${resolved}`,
        } as any;
      },
      planPlatformCopy: async () => {
        throw new Error("copy provider unavailable");
      },
      resolveArtworkLogo: async () => true,
    });

    const expected = buildDeterministicSocialPlatformCopy(copyInput());
    expect(result).toEqual({
      runId: "run-1",
      assetIds: platforms.map((platform) => `asset-${platform}`),
      planned: true,
    });
    expect(persistedContentPlan).toMatchObject({
      platformCopy: expected,
      platformCopySource: "deterministic-fallback",
      platformCopyVersion: "social-platform-copy-v7-agent-testing-editorial",
    });
    expect(postCreates).toHaveLength(1);
    expect(postCreates[0].caption).toBe(
      formatSocialPlatformCopy(expected.instagram!),
    );
    expect(assetCreates).toHaveLength(4);
  });

  test("plans weekday X copy without creating an image asset", async () => {
    let persistedContentPlan: any;
    let campaignCalls = 0;
    let copyTopic = "";
    let copyPromotion: SocialCreativeBrandContext["promotion"] = null;
    const assetCreates: any[] = [];
    const run = {
      id: "run-x-weekday",
      idempotencyKey: "social-request-x-weekday",
      correlationId: "social-creative:run-x-weekday",
      userId: "user-1",
      businessId: "business-1",
      topic: "Planning recurring team lunches",
      kind: "single",
      source: "SCHEDULE",
      requestedPlatforms: ["x"],
      contentPlan: null,
      posts: [],
      startedAt: null,
      socialTopicPlan: {
        hook: "A practical way to plan recurring team lunches",
        cta: "View the meal programs",
        objective: "education",
        scheduledFor: new Date("2026-08-20T12:30:00.000Z"),
        timezone: "America/Toronto",
      },
    };
    const prisma: any = {
      socialCreativeRun: {
        findUnique: async () => run,
        update: async ({ data }: any) => {
          if (data.contentPlan) persistedContentPlan = data.contentPlan;
          return { ...run, ...data };
        },
      },
      socialCreativePost: {
        upsert: async () => ({ id: "post-x-weekday" }),
      },
      socialCreativeAsset: {
        upsert: async ({ create }: any) => {
          assetCreates.push(create);
          return { id: "unexpected-asset" };
        },
      },
      llmUsageEvent: {
        aggregate: async () => ({ _sum: { estimatedUsd: 0 } }),
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) =>
      callback(prisma);

    const result = await planSocialCreativeRun("run-x-weekday", {
      prisma: prisma as PrismaClient,
      checkAccess: async () => ({ hasAccess: true }) as any,
      loadBrand: async () => ({
        ...brand,
        promotion: {
          enabled: true,
          title: "August team lunch offer",
          information: "Save exactly 15% on recurring meal programs.",
          preferredContent: null,
          startsOn: "2026-08-20",
          endsOn: "2026-08-25",
          imageUrl: "https://uplift-ai-images.b-cdn.net/offer.png",
          documentName: null,
          documentText: null,
        },
      }),
      prepareCampaign: async () => {
        campaignCalls += 1;
        throw new Error("weekday X must not request an image campaign");
      },
      planPlatformCopy: async (input) => {
        copyTopic = input.topic;
        copyPromotion = input.context.promotion;
        throw new Error("copy provider unavailable");
      },
    });

    expect(result).toEqual({
      runId: "run-x-weekday",
      assetIds: [],
      planned: true,
    });
    expect(campaignCalls).toBe(0);
    expect(assetCreates).toHaveLength(0);
    expect(copyTopic).toBe("August team lunch offer");
    expect(copyPromotion).toMatchObject({
      title: "August team lunch offer",
      imageUrl: "https://uplift-ai-images.b-cdn.net/offer.png",
    });
    expect(persistedContentPlan.platformCopyVariants.x).toHaveLength(2);
    expect(
      new Set(
        persistedContentPlan.platformCopyVariants.x.map(
          (variant: any) => variant.caption,
        ),
      ).size,
    ).toBe(2);
  });
});
