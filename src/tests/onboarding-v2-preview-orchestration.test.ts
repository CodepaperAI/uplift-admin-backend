import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  buildOnboardingV2BrandAnalysisData,
  completeOnboardingTask,
  ensureOnboardingV2BrandAnalysis,
  functions,
  generateBlogTask,
  INNGEST_BLOG_GENERATION_CONCURRENCY,
  INNGEST_BLOG_GENERATION_PER_BUSINESS_CONCURRENCY,
  INNGEST_ONBOARDING_CONCURRENCY,
  INNGEST_ONBOARDING_PRIORITY_SECONDS,
  isOnboardingV2PreviewGenerationEnabled,
  onboardingV2BlogPreviewTask,
  onboardingV2PreviewIdempotencyKey,
  onboardingV2PreviewRequestedTask,
  onboardingV2SocialPreviewTask,
  ONBOARDING_V2_PREVIEW_GENERATION_FLAG,
  quickBlogGenerationTask,
  secondaryOnboardingV2CompleteTask,
  secondaryOnboardingV2InitializeTask,
  selectOnboardingV2PreviewTopic,
  websiteFinalizeSecondaryTask,
  websiteOnboardTask,
} from "../inngest/client";
import { loadSocialCreativeBrandContext } from "../services/social-creative/brand-context";
import {
  authorizeOnboardingSocialCreativeRun,
  finalizeSocialCreativeRun,
  parseOnboardingV2SocialIdempotencyKey,
  planSocialCreativeRun,
} from "../services/social-creative/pipeline";
import { prepareWebsiteCampaign } from "../services/social-creative/website-campaign";

const originalPreviewFlag = process.env[ONBOARDING_V2_PREVIEW_GENERATION_FLAG];

afterEach(() => {
  if (originalPreviewFlag === undefined) {
    delete process.env[ONBOARDING_V2_PREVIEW_GENERATION_FLAG];
  } else {
    process.env[ONBOARDING_V2_PREVIEW_GENERATION_FLAG] = originalPreviewFlag;
  }
});

describe("onboarding-v2 preview orchestration contract", () => {
  test("uses revision-stable keys and independently registered child jobs", () => {
    expect(onboardingV2PreviewIdempotencyKey("quick-1", 7, "blog")).toBe(
      "onboarding-v2:quick-1:r7:blog",
    );
    expect(onboardingV2PreviewIdempotencyKey("quick-1", 7, "social")).toBe(
      "onboarding-v2:quick-1:r7:social",
    );

    const tasks = [
      onboardingV2PreviewRequestedTask,
      onboardingV2BlogPreviewTask,
      onboardingV2SocialPreviewTask,
    ] as any[];
    for (const task of tasks) {
      expect(task.opts.singleton).toEqual({
        key: "event.data.quickBusinessId + ':' + event.data.revision",
        mode: "skip",
      });
      expect(task.opts.concurrency).toEqual([
        {
          scope: "env",
          key: '"uplift-onboarding"',
          limit: INNGEST_ONBOARDING_CONCURRENCY,
        },
        {
          scope: "fn",
          key: "event.data.quickBusinessId",
          limit: 1,
        },
      ]);
      expect(task.opts.priority).toEqual({
        run: String(INNGEST_ONBOARDING_PRIORITY_SECONDS),
      });
      expect(functions).toContain(task);
    }
    expect((onboardingV2PreviewRequestedTask as any).opts.triggers).toEqual([
      { event: "onboarding-v2/preview.requested" },
    ]);
    expect((onboardingV2BlogPreviewTask as any).opts.triggers).toEqual([
      { event: "onboarding-v2/blog-preview.requested" },
    ]);
    expect((onboardingV2SocialPreviewTask as any).opts.triggers).toEqual([
      { event: "onboarding-v2/social-preview.requested" },
    ]);
  });

  test("prioritizes a shared onboarding pool and caps ordinary blog generation", () => {
    const onboardingTasks = [
      [quickBlogGenerationTask, "event.data.businessId"],
      [completeOnboardingTask, "event.data.userId"],
      [secondaryOnboardingV2InitializeTask, "event.data.businessId"],
      [secondaryOnboardingV2CompleteTask, "event.data.businessId"],
      [websiteOnboardTask, "event.data.businessId"],
      [websiteFinalizeSecondaryTask, "event.data.businessId"],
    ] as const;

    for (const [task, customerKey] of onboardingTasks) {
      expect((task as any).opts.concurrency).toEqual([
        {
          scope: "env",
          key: '"uplift-onboarding"',
          limit: INNGEST_ONBOARDING_CONCURRENCY,
        },
        {
          scope: "fn",
          key: customerKey,
          limit: 1,
        },
      ]);
      expect((task as any).opts.priority).toEqual({
        run: String(INNGEST_ONBOARDING_PRIORITY_SECONDS),
      });
    }

    expect((generateBlogTask as any).opts.concurrency).toEqual([
      {
        scope: "env",
        key: '"uplift-blog-generation"',
        limit: INNGEST_BLOG_GENERATION_CONCURRENCY,
      },
      {
        scope: "fn",
        key: "event.data.businessId",
        limit: INNGEST_BLOG_GENERATION_PER_BUSINESS_CONCURRENCY,
      },
    ]);
    expect((generateBlogTask as any).opts.singleton).toEqual({
      key: "event.data.keywordId",
      mode: "skip",
    });
  });

  test("keeps the preview feature opt-in and derives deterministic context", () => {
    delete process.env[ONBOARDING_V2_PREVIEW_GENERATION_FLAG];
    expect(isOnboardingV2PreviewGenerationEnabled()).toBe(false);
    process.env[ONBOARDING_V2_PREVIEW_GENERATION_FLAG] = "true";
    expect(isOnboardingV2PreviewGenerationEnabled()).toBe(true);

    expect(
      selectOnboardingV2PreviewTopic({
        selectedServices: ["", "Office catering"],
        detectedServices: ["Lunch delivery"],
        businessType: "Caterer",
        businessName: "LunchLink",
      }),
    ).toBe("Office catering");
    expect(
      buildOnboardingV2BrandAnalysisData({
        brand: {
          colors: ["#123456", "#abcdef", "#fedcba"],
          typography: { primaryFont: "Inter" },
          logo: { url: "https://example.com/logo.png", alt: "Example" },
        },
      }),
    ).toMatchObject({
      primaryColors: ["#123456", "#abcdef"],
      secondaryColors: ["#fedcba"],
      fontFamily: "Inter",
      logoUrl: "https://example.com/logo.png",
      logoAltText: "Example",
      analysisVersion: "onboarding-v2-context-v1",
    });
  });

  test("normalizes the versioned Context.dev brand envelope and legacy backdrops safely", () => {
    const retrievedAt = "2026-08-09T14:30:00.000Z";
    expect(
      buildOnboardingV2BrandAnalysisData({
        schemaVersion: 2,
        primaryColors: ["#123456", "navy", "#abc"],
        secondaryColors: ["#fedcba"],
        fontFamily: "  Inter  ",
        logoUrl: "https://cdn.example.com/logo.svg",
        logoAltText: "Example logo",
        faviconUrl: "javascript:alert(1)",
        referenceImage: { url: "https://cdn.example.com/reference.jpg" },
        slogan: "  Built for careful teams  ",
        provenance: {
          identitySource: "context.dev.brand.retrieve",
          identityRetrievedAt: retrievedAt,
          identityDomain: "example.com",
          semanticSource: "context.dev.web.extract",
        },
      }),
    ).toEqual({
      primaryColors: ["#123456", "#abc"],
      secondaryColors: ["#fedcba"],
      fontFamily: "Inter",
      logoUrl: "https://cdn.example.com/logo.svg",
      logoAltText: "Example logo",
      faviconUrl: null,
      referenceImageUrl: "https://cdn.example.com/reference.jpg",
      analysisVersion: "onboarding-v2-context-dev-brand-v2",
      slogan: "Built for careful teams",
      identityRetrievedAt: new Date(retrievedAt),
    });

    expect(
      buildOnboardingV2BrandAnalysisData({
        brand: {
          colors: ["#010203", "invalid", "#aabbcc"],
          logos: [
            { type: "icon", url: "https://cdn.example.com/icon.png" },
            { type: "logo", url: "https://cdn.example.com/wordmark.png" },
          ],
          backdrops: [{ url: "https://cdn.example.com/backdrop.jpg" }],
          slogan: "Legacy slogan",
        },
      }),
    ).toMatchObject({
      primaryColors: ["#010203", "#aabbcc"],
      logoUrl: "https://cdn.example.com/wordmark.png",
      referenceImageUrl: "https://cdn.example.com/backdrop.jpg",
      analysisVersion: "onboarding-v2-context-v1",
      slogan: "Legacy slogan",
    });
  });

  test("refreshes an older partial BrandAnalysis from a trustworthy Context.dev snapshot", async () => {
    const existing = {
      id: "analysis-1",
      primaryColors: [],
      secondaryColors: [],
      fontFamily: null,
      logoUrl: null,
      logoAltText: null,
      faviconUrl: null,
      referenceImageUrl: null,
      analysisVersion: "3.0",
    };
    let upsertInput: any;
    let fallbackCalls = 0;
    const prisma = {
      brandAnalysis: {
        findUnique: async () => existing,
        upsert: async (input: any) => {
          upsertInput = input;
          return { id: existing.id };
        },
      },
    } as unknown as PrismaClient;

    const result = await ensureOnboardingV2BrandAnalysis(
      {
        businessId: "business-1",
        websiteUrl: "https://example.com",
        brandContext: {
          schemaVersion: 2,
          primaryColors: ["#123456"],
          secondaryColors: ["#abcdef"],
          fontFamily: "Inter",
          logoUrl: "https://cdn.example.com/logo.svg",
          referenceImageUrl: "https://cdn.example.com/hero.jpg",
          provenance: {
            identitySource: "context.dev.brand.retrieve",
            identityRetrievedAt: "2026-08-09T14:30:00.000Z",
          },
        },
      } as any,
      prisma,
      async () => {
        fallbackCalls += 1;
        return null as any;
      },
    );

    expect(result).toEqual({
      available: true,
      created: false,
      refreshed: true,
      id: "analysis-1",
    });
    expect(fallbackCalls).toBe(0);
    expect(upsertInput).toMatchObject({
      where: { businessId: "business-1" },
      update: {
        primaryColors: ["#123456"],
        secondaryColors: ["#abcdef"],
        fontFamily: "Inter",
        logoUrl: "https://cdn.example.com/logo.svg",
        referenceImageUrl: "https://cdn.example.com/hero.jpg",
        analysisVersion: "onboarding-v2-context-dev-brand-v2",
        lastAnalyzed: new Date("2026-08-09T14:30:00.000Z"),
      },
    });
  });

  test("does not rewrite the same Context.dev analysis version unless it is richer", async () => {
    const existing = {
      id: "analysis-2",
      primaryColors: ["#123456"],
      secondaryColors: ["#abcdef"],
      fontFamily: "Inter",
      logoUrl: "https://cdn.example.com/logo.svg",
      logoAltText: "Example logo",
      faviconUrl: null,
      referenceImageUrl: "https://cdn.example.com/hero.jpg",
      analysisVersion: "onboarding-v2-context-dev-brand-v2",
    };
    let writes = 0;
    const prisma = {
      brandAnalysis: {
        findUnique: async () => existing,
        upsert: async () => {
          writes += 1;
          return { id: existing.id };
        },
      },
    } as unknown as PrismaClient;

    const result = await ensureOnboardingV2BrandAnalysis(
      {
        businessId: "business-1",
        websiteUrl: "https://example.com",
        brandContext: {
          schemaVersion: 2,
          primaryColors: ["#123456"],
          secondaryColors: ["#abcdef"],
          fontFamily: "Inter",
          logoUrl: "https://cdn.example.com/logo.svg",
          logoAltText: "Example logo",
          referenceImageUrl: "https://cdn.example.com/hero.jpg",
          provenance: { identitySource: "context.dev.brand.retrieve" },
        },
      } as any,
      prisma,
    );

    expect(result).toEqual({
      available: true,
      created: false,
      refreshed: false,
      id: "analysis-2",
    });
    expect(writes).toBe(0);
  });

  test("fills missing fields from a richer snapshot without discarding existing values", async () => {
    const existing = {
      id: "analysis-3",
      primaryColors: ["#123456"],
      secondaryColors: ["#abcdef"],
      fontFamily: "Inter",
      logoUrl: "https://cdn.example.com/logo.svg",
      logoAltText: "Example logo",
      faviconUrl: null,
      referenceImageUrl: null,
      analysisVersion: "onboarding-v2-context-dev-brand-v2",
    };
    let upsertInput: any;
    const prisma = {
      brandAnalysis: {
        findUnique: async () => existing,
        upsert: async (input: any) => {
          upsertInput = input;
          return { id: existing.id };
        },
      },
    } as unknown as PrismaClient;

    const result = await ensureOnboardingV2BrandAnalysis(
      {
        businessId: "business-1",
        websiteUrl: "https://example.com",
        brandContext: {
          schemaVersion: 2,
          primaryColors: [],
          secondaryColors: [],
          fontFamily: "Inter",
          logoUrl: "https://cdn.example.com/logo.svg",
          referenceImageUrl: "https://cdn.example.com/new-hero.jpg",
          provenance: { identitySource: "context.dev.brand.retrieve" },
        },
      } as any,
      prisma,
    );

    expect(result.refreshed).toBe(true);
    expect(upsertInput.update).toMatchObject({
      primaryColors: ["#123456"],
      secondaryColors: ["#abcdef"],
      logoAltText: "Example logo",
      referenceImageUrl: "https://cdn.example.com/new-hero.jpg",
      analysisVersion: "onboarding-v2-context-dev-brand-v2",
    });
  });

  test("preserves an existing analysis when no usable Context snapshot is available", async () => {
    const existing = {
      id: "analysis-4",
      primaryColors: ["#123456"],
      secondaryColors: [],
      fontFamily: null,
      logoUrl: null,
      logoAltText: null,
      faviconUrl: null,
      referenceImageUrl: null,
      analysisVersion: "3.0",
    };
    let writes = 0;
    let fallbackCalls = 0;
    const prisma = {
      brandAnalysis: {
        findUnique: async () => existing,
        upsert: async () => {
          writes += 1;
          return { id: existing.id };
        },
      },
    } as unknown as PrismaClient;

    const result = await ensureOnboardingV2BrandAnalysis(
      {
        businessId: "business-1",
        websiteUrl: "https://example.com",
        brandContext: { primaryColors: ["not-a-color"] },
      } as any,
      prisma,
      async () => {
        fallbackCalls += 1;
        return null as any;
      },
    );

    expect(result).toEqual({
      available: true,
      created: false,
      refreshed: false,
      id: "analysis-4",
    });
    expect(writes).toBe(0);
    expect(fallbackCalls).toBe(0);
  });

  test("retains deterministic website analysis as the no-snapshot fallback", async () => {
    let upsertInput: any;
    let fallbackCalls = 0;
    const prisma = {
      brandAnalysis: {
        findUnique: async () => null,
        upsert: async (input: any) => {
          upsertInput = input;
          return { id: "analysis-fallback" };
        },
      },
    } as unknown as PrismaClient;

    const result = await ensureOnboardingV2BrandAnalysis(
      {
        businessId: "business-1",
        websiteUrl: "https://example.com",
        brandContext: null,
      } as any,
      prisma,
      async () => {
        fallbackCalls += 1;
        return {
          primaryColors: ["#112233"],
          secondaryColors: ["#ddeeff"],
          fontFamily: "Poppins",
          logoUrl: "https://cdn.example.com/fallback-logo.png",
          logoAltText: "Fallback logo",
          faviconUrl: null,
        } as any;
      },
    );

    expect(result).toEqual({
      available: true,
      created: true,
      refreshed: false,
      id: "analysis-fallback",
    });
    expect(fallbackCalls).toBe(1);
    expect(upsertInput.create).toMatchObject({
      businessId: "business-1",
      primaryColors: ["#112233"],
      logoUrl: "https://cdn.example.com/fallback-logo.png",
      analysisVersion: "onboarding-v2-deterministic-v1",
    });
  });

  test("preflights the unique blog key before paid work and keeps previews draft-only", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../utils/quick-blog-generator.ts"),
      "utf8",
    );
    const preflight = source.indexOf("where: { onboardingPreviewKey }");
    const llm = source.indexOf("const fastLLM = getLLMForBlogs()");
    const image = source.indexOf("generateProductionBlogImages({");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(llm);
    expect(preflight).toBeLessThan(image);
    expect(source).toContain("status: options.status ?? \"PUBLISH\"");
    expect(source).toContain("onboardingPreview: Boolean(onboardingPreviewKey)");
    expect(source).toContain("if (!options.suppressEmail)");
    expect(source).toContain("prisma.meta.deleteMany");
    expect(source).toContain("prisma.customField.deleteMany");
  });
});

describe("ONBOARDING social authorization", () => {
  test("accepts an advanced answer revision when the frozen generation revision matches", async () => {
    const prisma = {
      quickScrapeBusiness: {
        findUnique: async () => ({
          userId: "user-1",
          onboardingV2BusinessId: "business-1",
          onboardingV2AnswerRevision: 99,
          onboardingV2GenerationRevision: 4,
          onboardingV2Status: "in_progress",
          onboardingV2CompletedAt: null,
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      authorizeOnboardingSocialCreativeRun(
        {
          idempotencyKey: "onboarding-v2:quick-1:r4:social",
          userId: "user-1",
          businessId: "business-1",
          source: "ONBOARDING",
        },
        prisma,
      ),
    ).resolves.toEqual({ quickBusinessId: "quick-1", revision: 4 });
    expect(
      parseOnboardingV2SocialIdempotencyKey(
        "onboarding-v2:quick-1:r4:social",
      ),
    ).toEqual({ quickBusinessId: "quick-1", revision: 4 });
    expect(
      parseOnboardingV2SocialIdempotencyKey(
        "onboarding-v2:quick-1:r4:blog",
      ),
    ).toBeNull();
  });

  test("authorizes ONBOARDING before reusing a plan and does not require entitlement", async () => {
    let authorizationCalls = 0;
    let accessCalls = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => ({
          id: "run-1",
          idempotencyKey: "onboarding-v2:quick-1:r4:social",
          userId: "user-1",
          businessId: "business-1",
          source: "ONBOARDING",
          kind: "single",
          topic: "Office catering",
          requestedPlatforms: ["instagram"],
          contentPlan: { topic: "Office catering" },
          posts: [{ assets: [{ id: "asset-1", platform: "instagram" }] }],
        }),
      },
    } as unknown as PrismaClient;

    const result = await planSocialCreativeRun("run-1", {
      prisma,
      authorizeOnboarding: async () => {
        authorizationCalls += 1;
        return { quickBusinessId: "quick-1", revision: 4 };
      },
      checkAccess: async () => {
        accessCalls += 1;
        return { hasAccess: false, message: "no subscription" } as any;
      },
    });
    expect(result).toEqual({
      runId: "run-1",
      assetIds: ["asset-1"],
      planned: false,
    });
    expect(authorizationCalls).toBe(1);
    expect(accessCalls).toBe(0);
  });

  test("loads an inactive provisional business only through the matching snapshot", async () => {
    const businessWhere: any[] = [];
    const business = {
      id: "business-1",
      businessName: "LunchLink",
      businessType: "Workplace catering",
      businessDescription: "",
      businessWebsiteUrl: "https://lunchlink.example",
      businessPhone: null,
      businessCity: "Toronto",
      businessState: "Ontario",
      businessCountry: "Canada",
      defaultLanguage: "en",
      defaultLocale: "en-CA",
      contentTone: null,
      targetAudience: null,
      detectedServices: [],
      selectedServices: [],
      serviceAreaLocations: [],
      BrandAnalysis: {
        primaryColors: ["#123456"],
        secondaryColors: [],
        fontFamily: "Inter",
        logoUrl: null,
        referenceImageUrl: null,
      },
      Photos: [],
      websiteAnalysis: null,
      GoogleMyBusiness: null,
    };
    const prisma = {
      quickScrapeBusiness: {
        findUnique: async () => ({
          userId: "user-1",
          onboardingV2BusinessId: "business-1",
          onboardingV2GenerationRevision: 4,
          onboardingV2Status: "in_progress",
          onboardingV2CompletedAt: null,
          businessDescription: "Context.dev description",
          targetAudience: "Office managers",
          selectedServices: ["Team lunches"],
          detectedServices: [],
          brandContext: {
            brandVoice: ["Warm", "Concise"],
            keyMessages: ["Lunch without admin overhead"],
            socialContentAngles: ["Team lunch planning tips"],
          },
        }),
      },
      business: {
        findFirst: async ({ where }: any) => {
          businessWhere.push(where);
          return business;
        },
      },
      socialCreativePost: { findMany: async () => [] },
    } as unknown as PrismaClient;

    const context = await loadSocialCreativeBrandContext(
      {
        userId: "user-1",
        businessId: "business-1",
        onboardingPreview: { quickBusinessId: "quick-1", revision: 4 },
      },
      prisma,
    );
    expect(businessWhere[0]).toEqual({
      id: "business-1",
      userId: "user-1",
    });
    expect(context).toMatchObject({
      businessDescription: "Context.dev description",
      targetAudience: "Office managers",
      services: ["Team lunches"],
      tone: "Warm, Concise",
      brandVoice: "Warm, Concise",
      keyMessages: ["Lunch without admin overhead"],
      socialContentAngles: ["Team lunch planning tips"],
    });
    const campaign = await prepareWebsiteCampaign({
      context,
      socialTopic: "Office catering",
      platform: "linkedin",
      validatePublicUrl: async (url) => new URL(url),
    });
    expect(campaign.prompt).toContain("Warm, Concise");
    expect(campaign.prompt).toContain("Lunch without admin overhead");
    expect(campaign.prompt).toContain("Team lunch planning tips");

    await loadSocialCreativeBrandContext(
      { userId: "user-1", businessId: "business-1" },
      prisma,
    );
    expect(businessWhere[1]).toEqual({
      id: "business-1",
      userId: "user-1",
      isActive: true,
    });
  });

  test("mirrors terminal onboarding social status back to QuickScrapeBusiness", async () => {
    const quickUpdates: any[] = [];
    const run = {
      id: "run-1",
      idempotencyKey: "onboarding-v2:quick-1:r4:social",
      source: "ONBOARDING",
      userId: "user-1",
      businessId: "business-1",
      contentPlan: null,
      posts: [
        {
          assets: [
            { status: "COMPLETE", actualUsd: 0.04, estimatedUsd: 0.04 },
          ],
        },
      ],
    };
    const prisma = {
      socialCreativeRun: {
        findUniqueOrThrow: async () => run,
        update: async () => run,
        findUnique: async () => run,
      },
      quickScrapeBusiness: {
        updateMany: async (input: any) => {
          quickUpdates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    const result = await finalizeSocialCreativeRun("run-1", prisma);
    expect(result.status).toBe("COMPLETE");
    expect(quickUpdates[0]).toMatchObject({
      where: {
        id: "quick-1",
        userId: "user-1",
        onboardingV2BusinessId: "business-1",
        onboardingV2GenerationRevision: 4,
      },
      data: {
        onboardingV2SocialRunId: "run-1",
        onboardingV2SocialStatus: "complete",
      },
    });
  });
});
