import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { NonRetriableError } from "inngest";

import { createSocialCreativeInngestFunctions } from "../inngest/social-creative";
import {
  planSocialCreativeRun,
  renderSocialCreativeAsset,
  SocialCreativePipelineError,
} from "../services/social-creative/pipeline";
import {
  checkpointSocialCreativeProviderResult,
  claimSocialCreativeAsset,
  createOrGetSocialCreativeRun,
  heartbeatSocialCreativeAsset,
  recordSocialCreativeTextUsage,
} from "../services/social-creative/repository";
import type { SocialCreativeBrandContext } from "../services/social-creative/types";

function providerPng(width = 1024, height = 1536): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

const baseRequest = {
  userId: "user-1",
  businessId: "business-1",
  topic: "Spring maintenance",
  kind: "single" as const,
  source: "MANUAL" as const,
  sourceBlogId: null,
  sourcePlanId: null,
  platforms: ["instagram" as const],
  idempotencyKey: "social-request-1",
  estimatedBudgetUsd: 0.063,
};

const existingRun = {
  id: "run-1",
  idempotencyKey: "social-request-1",
  correlationId: "social-creative:run-1",
  userId: "user-1",
  businessId: "business-1",
  topic: "Spring maintenance",
  kind: "single",
  source: "MANUAL",
  sourceBlogId: null,
  sourcePlanId: null,
  requestedPlatforms: ["instagram"],
  status: "PENDING",
};

function fakeInngestRegistration(
  dependencies: Parameters<typeof createSocialCreativeInngestFunctions>[1],
) {
  const registered: Array<{
    config: any;
    handler: (context: any) => Promise<any>;
  }> = [];
  const inngest = {
    createFunction: (config: any, handler: (context: any) => Promise<any>) => {
      const fn = { config, handler };
      registered.push(fn);
      return fn;
    },
  } as any;
  createSocialCreativeInngestFunctions(inngest, dependencies);
  return (id: string) => registered.find((fn) => fn.config.id === id)!;
}

function immediateStep(sent: any[]) {
  return {
    run: async (_id: string, fn: () => unknown) => fn(),
    sleep: async () => undefined,
    sendEvent: async (_id: string, payload: unknown) => {
      sent.push(payload);
      return { ids: ["event-1"] };
    },
  };
}

describe("social creative request idempotency", () => {
  test("rejects reuse of an idempotency key with different input", async () => {
    let createCalls = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => existingRun,
        create: async () => {
          createCalls += 1;
          return existingRun;
        },
      },
    } as unknown as PrismaClient;

    await expect(
      createOrGetSocialCreativeRun(
        { ...baseRequest, topic: "A different campaign" },
        prisma,
      ),
    ).rejects.toThrow("idempotency key request mismatch");
    expect(createCalls).toBe(0);
  });

  test("re-reads and returns the winning run after a P2002 create race", async () => {
    let reads = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => (++reads === 1 ? null : existingRun),
        create: async () => {
          throw { code: "P2002" };
        },
      },
    } as unknown as PrismaClient;

    const run = await createOrGetSocialCreativeRun(baseRequest, prisma);
    expect(run).toBe(existingRun as any);
    expect(reads).toBe(2);
  });
});

describe("social creative Inngest retry boundaries", () => {
  test("stops a queued asset at the generation kill switch and finalizes it", async () => {
    const sent: any[] = [];
    const failures: any[] = [];
    let renderCalls = 0;
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      generationEnabled: () => false,
      failAsset: async (input) => {
        failures.push(input);
      },
      render: async () => {
        renderCalls += 1;
        return {} as any;
      },
    });

    const result = await lookup("social-creative-render-asset").handler({
      event: { data: { assetId: "asset-1", runId: "run-1" } },
      step: immediateStep(sent),
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: "generation_disabled",
    });
    expect(renderCalls).toBe(0);
    expect(failures[0]).toMatchObject({
      assetId: "asset-1",
      code: "SOCIAL_CREATIVE_GENERATION_DISABLED",
    });
    expect(sent).toContainEqual({
      name: "social/creative.asset.completed",
      data: { assetId: "asset-1", runId: "run-1", success: false },
    });
  });

  test("marks non-transient work non-retriable but preserves transient provider retries", async () => {
    const nonTransient = new SocialCreativePipelineError(
      "bad request",
      "SOCIAL_CREATIVE_OPENAI_FAILED",
      "openai",
      false,
    );
    const transient = new SocialCreativePipelineError(
      "provider unavailable",
      "SOCIAL_CREATIVE_OPENAI_FAILED",
      "openai",
      true,
    );
    for (const [error, expectedName] of [
      [nonTransient, "NonRetriableError"],
      [transient, "SocialCreativePipelineError"],
    ] as const) {
      const sent: any[] = [];
      const lookup = fakeInngestRegistration({
        prisma: {} as PrismaClient,
        generationEnabled: () => true,
        render: async () => {
          throw error;
        },
      });
      try {
        await lookup("social-creative-render-asset").handler({
          event: { data: { assetId: "asset-1", runId: "run-1" } },
          step: immediateStep(sent),
          attempt: error === transient ? 2 : 0,
        });
        throw new Error("Expected asset handler to throw");
      } catch (caught) {
        expect((caught as Error).name).toBe(expectedName);
        if (error === nonTransient)
          expect(caught).toBeInstanceOf(NonRetriableError);
        else expect(caught).toBe(transient);
      }
      expect(sent).toHaveLength(1);
    }
  });

  test("defers immediately when another invocation owns the render lease", async () => {
    const sent: any[] = [];
    let renderCalls = 0;
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      generationEnabled: () => true,
      render: async () => {
        renderCalls += 1;
        return {
          assetId: "asset-1",
          imageUrl: null,
          rendered: false,
          state: "in_progress" as const,
        };
      },
    });

    const result = await lookup("social-creative-render-asset").handler({
      event: { data: { assetId: "asset-1", runId: "run-1" } },
      step: immediateStep(sent),
      attempt: 0,
    });

    expect(result).toEqual({
      assetId: "asset-1",
      runId: "run-1",
      state: "in_progress",
      deferred: true,
    });
    expect(renderCalls).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test("never emits a false completion while another worker still owns the render", async () => {
    const sent: any[] = [];
    let renderCalls = 0;
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      generationEnabled: () => true,
      render: async () => {
        renderCalls += 1;
        return {
          assetId: "asset-1",
          imageUrl: null,
          rendered: false,
          state: "in_progress" as const,
        };
      },
    });

    const result = await lookup("social-creative-render-asset").handler({
      event: { data: { assetId: "asset-1", runId: "run-1" } },
      step: immediateStep(sent),
      attempt: 2,
    });
    expect(result).toMatchObject({ state: "in_progress", deferred: true });
    expect(renderCalls).toBe(1);
    expect(sent).toHaveLength(0);
  });

  test("queues every finalization instead of dropping concurrent completion events", () => {
    const lookup = fakeInngestRegistration({ prisma: {} as PrismaClient });
    const finalize = lookup("social-creative-finalize").config;
    expect(finalize.singleton).toBeUndefined();
    expect(finalize.concurrency).toEqual({ limit: 1, key: "event.data.runId" });
  });

  test("dispatches prepared auto-publish attempts after finalization", async () => {
    const sent: any[] = [];
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      autoPublishEnabled: () => true,
      finalize: async () => ({
        runId: "run-1",
        total: 1,
        complete: 1,
        failed: 0,
        active: 0,
        status: "COMPLETE" as const,
        actualCostUsd: 0.05,
      }),
      prepareAutoPublish: async () => ({
        runId: "run-1",
        businessId: "business-1",
        status: "prepared" as const,
        mode: "SCHEDULE" as const,
        platforms: ["instagram"],
        attemptIds: ["attempt-1"],
      }),
    });

    const result = await lookup("social-creative-finalize").handler({
      event: { data: { runId: "run-1" } },
      step: immediateStep(sent),
    });

    expect(result.automaticPublishing).toEqual({
      status: "prepared",
      mode: "SCHEDULE",
      platforms: ["instagram"],
      queued: 1,
    });
    expect(sent).toEqual([
      [
        {
          id: "social-auto-publish:attempt-1",
          name: "social/publish.requested",
          data: {
            attemptId: "attempt-1",
            businessId: "business-1",
            runId: "run-1",
          },
        },
      ],
    ]);
  });

  test("finalizes content without preparing provider posts when auto publish is disabled", async () => {
    let prepareCalls = 0;
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      autoPublishEnabled: () => false,
      finalize: async () => ({
        runId: "run-disabled",
        total: 0,
        complete: 0,
        failed: 0,
        active: 0,
        status: "COMPLETE" as const,
        actualCostUsd: 0,
      }),
      prepareAutoPublish: async () => {
        prepareCalls += 1;
        throw new Error("automatic publishing must remain disabled");
      },
    });

    const result = await lookup("social-creative-finalize").handler({
      event: { data: { runId: "run-disabled" } },
      step: immediateStep([]),
    });

    expect(prepareCalls).toBe(0);
    expect(result.automaticPublishing).toEqual({
      status: "auto_publish_disabled",
      mode: null,
      platforms: [],
      queued: 0,
    });
  });

  test("requests a plain approval notification instead of publishing", async () => {
    const sent: any[] = [];
    const lookup = fakeInngestRegistration({
      prisma: {} as PrismaClient,
      autoPublishEnabled: () => true,
      finalize: async () => ({
        runId: "run-approval",
        total: 1,
        complete: 1,
        failed: 0,
        active: 0,
        status: "COMPLETE" as const,
        actualCostUsd: 0.05,
      }),
      prepareAutoPublish: async () => ({
        runId: "run-approval",
        businessId: "business-1",
        status: "approval_required" as const,
        mode: null,
        platforms: [],
        attemptIds: [],
      }),
    });

    await lookup("social-creative-finalize").handler({
      event: { data: { runId: "run-approval" } },
      step: immediateStep(sent),
    });

    expect(sent).toEqual([
      {
        id: "approval-ready-social:run-approval",
        name: "content/approval-ready",
        data: { kind: "social", contentId: "run-approval" },
      },
    ]);
  });

  test("redispatches stale rendering assets with a lease-specific event id", async () => {
    const sent: any[] = [];
    let recoveryQuery: any;
    const startedAt = new Date("2026-08-10T12:00:00.000Z");
    const updatedAt = new Date("2026-08-10T12:01:00.000Z");
    const lookup = fakeInngestRegistration({
      prisma: {
        socialCreativeAsset: {
          findMany: async (input: unknown) => {
            recoveryQuery = input;
            return [
              {
                id: "asset-1",
                startedAt,
                updatedAt,
                post: { run: { id: "run-1", businessId: "business-1" } },
              },
            ];
          },
        },
      } as unknown as PrismaClient,
      generationEnabled: () => true,
    });

    const result = await lookup(
      "social-creative-stale-render-recovery",
    ).handler({ step: immediateStep(sent) });

    expect(result).toEqual({ scanned: 1, redispatched: 1 });
    expect(recoveryQuery.where).toMatchObject({
      status: "RENDERING",
      post: { run: { status: { in: ["RENDERING", "FAILED"] } } },
    });
    expect(sent).toEqual([
      [
        {
          id: `social-creative-stale:asset-1:${updatedAt.getTime()}`,
          name: "social/creative.asset.requested",
          data: {
            assetId: "asset-1",
            runId: "run-1",
            businessId: "business-1",
          },
        },
      ],
    ]);
  });

  test("redispatches finalization when every asset is terminal but the run is still rendering", async () => {
    const sent: any[] = [];
    let recoveryQuery: any;
    const completedAt = new Date("2026-08-10T12:04:00.000Z");
    const lookup = fakeInngestRegistration({
      prisma: {
        socialCreativeRun: {
          findMany: async (input: unknown) => {
            recoveryQuery = input;
            return [
              {
                id: "run-terminal",
                posts: [{ assets: [{ updatedAt: completedAt }] }],
              },
            ];
          },
        },
      } as unknown as PrismaClient,
    });

    const result = await lookup(
      "social-creative-terminal-run-recovery",
    ).handler({ step: immediateStep(sent) });

    expect(result).toEqual({ scanned: 1, redispatched: 1 });
    expect(recoveryQuery.where).toEqual({
      status: "RENDERING",
      posts: {
        some: { assets: { some: {} } },
        none: {
          assets: {
            some: { status: { in: ["PENDING", "RENDERING"] } },
          },
        },
      },
    });
    expect(sent).toEqual([
      [
        {
          id: `social-creative-terminal-finalize:run-terminal:${completedAt.getTime()}`,
          name: "social/creative.finalize",
          data: { runId: "run-terminal" },
        },
      ],
    ]);
  });
});

describe("social creative render lease", () => {
  test("claims pending work and stale rendering work with one atomic update", async () => {
    const updates: any[] = [];
    const prisma = {
      socialCreativeAsset: {
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const staleBefore = new Date("2026-08-10T12:00:00.000Z");
    const claimedAt = new Date("2026-08-10T12:05:00.000Z");

    expect(
      await claimSocialCreativeAsset("asset-1", prisma, {
        staleBefore,
        claimedAt,
      }),
    ).toBe(true);
    expect(updates[0].where.id).toBe("asset-1");
    expect(updates[0].where.OR[0]).toEqual({
      status: { in: ["PENDING", "FAILED"] },
    });
    expect(updates[0].where.OR[1]).toEqual({
      status: "RENDERING",
      updatedAt: { lte: staleBefore },
    });
    expect(updates[0].data.status).toBe("RENDERING");
    expect(updates[0].data.startedAt).toEqual(claimedAt);
    expect(updates[0].data.attemptCount).toEqual({ increment: 1 });
  });

  test("heartbeats only the worker that still owns the render lease", async () => {
    const updates: any[] = [];
    const prisma = {
      socialCreativeAsset: {
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const leaseStartedAt = new Date("2026-08-10T12:00:00.000Z");
    const heartbeatAt = new Date("2026-08-10T12:01:00.000Z");

    expect(
      await heartbeatSocialCreativeAsset(
        "asset-1",
        leaseStartedAt,
        prisma,
        heartbeatAt,
      ),
    ).toBe(true);
    expect(updates[0]).toEqual({
      where: {
        id: "asset-1",
        status: "RENDERING",
        startedAt: leaseStartedAt,
      },
      data: { updatedAt: heartbeatAt },
    });
  });

  test("returns in-progress without regenerating when a fresh worker owns the asset", async () => {
    const rendering = socialAssetFixture({
      status: "RENDERING",
      startedAt: new Date("2026-08-10T12:04:30.000Z"),
    });
    let generationCalls = 0;
    const prisma = {
      socialCreativeAsset: {
        findUnique: async () => rendering,
        updateMany: async () => ({ count: 0 }),
      },
    } as unknown as PrismaClient;

    const result = await renderSocialCreativeAsset("asset-1", {
      prisma,
      now: () => new Date("2026-08-10T12:05:00.000Z"),
      generateImage: async () => {
        generationCalls += 1;
        throw new Error("must not generate");
      },
    });

    expect(result).toEqual({
      assetId: "asset-1",
      imageUrl: null,
      rendered: false,
      state: "in_progress",
    });
    expect(generationCalls).toBe(0);
  });
});

describe("social creative receipt recovery", () => {
  test("returns all prepared direct assets without invoking the legacy text planner", async () => {
    const receipts: any[] = [];
    let plannerCalls = 0;
    const usage = {
      responseId: "response-plan-1",
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      estimatedUsd: 0.001,
    };
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => ({
          ...existingRun,
          contentPlan: {
            language: "en",
            locale: "en-CA",
            slides: [],
            _usage: usage,
          },
          posts: [
            { assets: [{ id: "asset-complete", platform: "instagram" }] },
            { assets: [{ id: "asset-pending", platform: "instagram" }] },
          ],
        }),
        findUniqueOrThrow: async () => existingRun,
      },
      llmUsageEvent: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          receipts.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;

    const result = await planSocialCreativeRun("run-1", {
      prisma,
      planner: async () => {
        plannerCalls += 1;
        throw new Error("planner should not run");
      },
    });

    expect(result).toEqual({
      runId: "run-1",
      assetIds: ["asset-complete", "asset-pending"],
      planned: false,
    });
    expect(plannerCalls).toBe(0);
    expect(receipts).toHaveLength(0);
  });

  test("atomically checkpoints an image result with its usage receipt", async () => {
    const writes: string[] = [];
    let assetData: any;
    let receiptData: any;
    const prisma: any = {
      socialCreativeAsset: {
        update: async ({ data }: any) => {
          writes.push("asset");
          assetData = data;
        },
      },
      socialCreativeRun: {
        findUniqueOrThrow: async () => existingRun,
      },
      llmUsageEvent: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          writes.push("receipt");
          receiptData = data;
        },
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) => {
      writes.push("transaction");
      return callback(prisma);
    };

    await checkpointSocialCreativeProviderResult(
      {
        assetId: "asset-1",
        runId: "run-1",
        providerRequestId: "image-response-1",
        sha256: "a".repeat(64),
        estimatedUsd: 0.063,
        actualUsd: 0.041,
        metadata: {
          retryNumber: 0,
          pricingVersion: "openai-gpt-image-token-pricing-2026-08",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
          },
        },
      },
      prisma,
    );

    expect(writes).toEqual(["transaction", "asset", "receipt"]);
    expect(assetData.actualUsd).toBe(0.041);
    expect(receiptData).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(receiptData.metadata.pricingVersion).toContain("token-pricing");
  });

  test("treats a constrained receipt P2002 race as an idempotent success", async () => {
    let reads = 0;
    const prisma = {
      socialCreativeRun: { findUniqueOrThrow: async () => existingRun },
      llmUsageEvent: {
        findFirst: async () =>
          ++reads === 1 ? null : { id: "winning-receipt" },
        create: async () => {
          throw { code: "P2002" };
        },
      },
    } as unknown as PrismaClient;

    await expect(
      recordSocialCreativeTextUsage(
        {
          runId: "run-1",
          usage: {
            responseId: "response-plan-1",
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            estimatedUsd: 0.001,
          },
        },
        prisma,
      ),
    ).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  test("repairs a completed asset receipt without regenerating the paid image", async () => {
    const receipts: any[] = [];
    let generationCalls = 0;
    const asset = socialAssetFixture({
      status: "COMPLETE",
      imageUrl: "https://res.cloudinary.com/example/image/upload/final.jpg",
      providerRequestId: "image-response-1",
      estimatedUsd: 0.063,
    });
    const prisma = {
      socialCreativeAsset: { findUnique: async () => asset },
      socialCreativeRun: { findUniqueOrThrow: async () => existingRun },
      llmUsageEvent: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          receipts.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;

    const result = await renderSocialCreativeAsset("asset-1", {
      prisma,
      generateImage: async () => {
        generationCalls += 1;
        throw new Error("must not regenerate");
      },
    });

    expect(result).toMatchObject({ rendered: false, imageUrl: asset.imageUrl });
    expect(generationCalls).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].metadata.receiptRepair).toBe(true);
  });
});

describe("social creative post-provider failure classification", () => {
  test("records image-storage failure distinctly and makes it non-retriable", async () => {
    const background = providerPng();
    const pending = socialAssetFixture({ status: "PENDING" });
    const rendering = socialAssetFixture({
      status: "RENDERING",
      attemptCount: 1,
    });
    let reads = 0;
    const failureCodes: string[] = [];
    const prisma: any = {
      socialCreativeAsset: {
        findUnique: async () => (++reads === 1 ? pending : rendering),
        updateMany: async ({ data }: any) => {
          if (data.errorCode) failureCodes.push(data.errorCode);
          return { count: 1 };
        },
        update: async ({ data }: any) => {
          if (data.errorCode) failureCodes.push(data.errorCode);
          return rendering;
        },
      },
      socialCreativeRun: { findUniqueOrThrow: async () => existingRun },
      llmUsageEvent: {
        findFirst: async () => null,
        create: async () => ({}),
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) =>
      callback(prisma);

    await expect(
      renderSocialCreativeAsset("asset-1", {
        prisma,
        loadBrand: async () => brandFixture,
        approveBrandMark: async () => null,
        generateImage: async () => ({
          buffer: background,
          model: "gpt-image-2-2026-04-21",
          quality: null,
          sourceSize: "1024x1536",
          providerRequestId: "image-response-1",
          sha256: "a".repeat(64),
          estimatedUsd: 0.063,
          actualUsd: 0.041,
          pricingVersion: "openai-gpt-image-token-pricing-2026-08",
          usage: {
            inputTokens: 10,
            inputTextTokens: 10,
            inputImageTokens: 0,
            outputTokens: 20,
            outputImageTokens: 20,
            totalTokens: 30,
          },
          returned: {
            outputFormat: "png",
            mimeType: "image/png",
            width: 1024,
            height: 1536,
            source: "base64" as const,
          },
        }),
        upload: async () => {
          throw new Error("Image storage unavailable");
        },
      }),
    ).rejects.toMatchObject({
      code: "WEBSITE_CAMPAIGN_STORAGE_FAILED",
      stage: "storage",
      retryable: false,
    });
    expect(failureCodes).toContain("WEBSITE_CAMPAIGN_STORAGE_FAILED");
  });

  test("uploads and persists the exact provider bytes without a compositor", async () => {
    const providerBuffer = providerPng();
    const providerSha = createHash("sha256")
      .update(providerBuffer)
      .digest("hex");
    const pending = socialAssetFixture({ status: "PENDING" });
    const rendering = socialAssetFixture({
      status: "RENDERING",
      attemptCount: 1,
    });
    for (const fixture of [pending, rendering]) {
      (
        fixture.post.run as typeof fixture.post.run & { contentPlan: unknown }
      ).contentPlan = {
        brandReferences: [
          {
            url: "https://media.brand.dev/approved-logo.png",
            role: "logo",
          },
        ],
      };
    }
    let reads = 0;
    let uploadBytes: Uint8Array = new Uint8Array();
    let checkpointData: any;
    let completedData: any;
    const prisma: any = {
      socialCreativeAsset: {
        findUnique: async () => (++reads === 1 ? pending : rendering),
        updateMany: async ({ data }: any) => {
          if (data.status === "COMPLETE") completedData = data;
          return { count: 1 };
        },
        update: async ({ data }: any) => {
          if (data.providerRequestId) checkpointData = data;
          if (data.status === "COMPLETE") completedData = data;
          return rendering;
        },
      },
      socialCreativeRun: { findUniqueOrThrow: async () => existingRun },
      llmUsageEvent: {
        findFirst: async () => null,
        create: async () => ({}),
      },
    };
    prisma.$transaction = async (callback: (tx: any) => unknown) =>
      callback(prisma);

    const result = await renderSocialCreativeAsset("asset-1", {
      prisma,
      generateImage: async (input) => {
        expect(input.references).toEqual([
          {
            url: "https://media.brand.dev/approved-logo.png",
            role: "logo",
          },
        ]);
        return {
          buffer: providerBuffer,
          model: "gpt-image-2-2026-04-21",
          quality: null,
          sourceSize: "1024x1536",
          providerRequestId: "image-response-identity",
          sha256: providerSha,
          estimatedUsd: 0.041,
          actualUsd: 0.041,
          pricingVersion: "test",
          usage: null,
          requested: {
            quality: null,
            outputFormat: null,
            sourceSize: "auto",
            targetSize: "1024x1536",
          },
          returned: {
            outputFormat: "png",
            mimeType: "image/png",
            width: 1024,
            height: 1536,
            source: "base64",
          },
        };
      },
      upload: async (buffer) => {
        uploadBytes = buffer;
        return {
          url: "https://uplift-ai-images.b-cdn.net/social/asset-1.png",
          objectKey: "asset-1",
          provider: "bunny" as const,
          storageZone: "uplift-ai-images",
          checksumSha256: providerSha,
          bytes: buffer.length,
          format: "png",
        };
      },
    });

    expect(Buffer.from(uploadBytes).equals(providerBuffer)).toBe(true);
    expect(result).toMatchObject({
      rendered: true,
      providerOutputUnchanged: true,
      sha256: providerSha,
    });
    expect(completedData.finalArtifactSha256).toBe(providerSha);
    expect(checkpointData).toMatchObject({
      width: 1024,
      height: 1536,
      sourceSize: "1024x1536",
    });
    expect(completedData.compositorDiagnostics).toMatchObject({
      mode: "provider-direct",
      compositorApplied: false,
      resized: false,
      reencoded: false,
    });
  });

  test("resumes from the durable provider artifact without a second paid call", async () => {
    const background = providerPng();
    const sha256 = createHash("sha256").update(background).digest("hex");
    const failed = socialAssetFixture({
      status: "FAILED",
      providerRequestId: "image-response-1",
      providerArtifactSha256: sha256,
      providerArtifactUrl:
        "https://res.cloudinary.com/example/image/upload/provider/asset-1-source.png",
      estimatedUsd: 0.041,
      actualUsd: 0.041,
      attemptCount: 1,
    });
    let generationCalls = 0;
    let completed = false;
    const prisma: any = {
      socialCreativeAsset: {
        findUnique: async () => failed,
        updateMany: async ({ data }: any) => {
          if (data.status === "COMPLETE") completed = true;
          return { count: 1 };
        },
        update: async ({ data }: any) => {
          if (data.status === "COMPLETE") completed = true;
          return failed;
        },
      },
      socialCreativeRun: { findUniqueOrThrow: async () => existingRun },
      llmUsageEvent: {
        findFirst: async () => ({ id: "existing-image-receipt" }),
        create: async () => ({}),
      },
    };

    const result = await renderSocialCreativeAsset("asset-1", {
      prisma,
      loadBrand: async () => brandFixture,
      approveBrandMark: async () => null,
      generateImage: async () => {
        generationCalls += 1;
        throw new Error("must not regenerate");
      },
      fetchProviderArtifact: async () => background,
      upload: async () =>
        "https://uplift-ai-images.b-cdn.net/final/asset-1.jpg",
    });

    expect(result).toMatchObject({ rendered: true });
    expect(generationCalls).toBe(0);
    expect(completed).toBe(true);
  });
});

function socialAssetFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    postId: "post-1",
    platform: "instagram",
    slideIndex: 0,
    status: "PENDING",
    width: 1024,
    height: 1536,
    aspectRatio: "2:3",
    sourceSize: "auto",
    imageUrl: null,
    provider: "openai",
    model: "gpt-image-2-2026-04-21",
    quality: "provider-default",
    renderMode: "provider-direct",
    prompt: "A direct website campaign prompt",
    providerRequestId: null,
    providerArtifactSha256: null,
    providerArtifactUrl: null,
    finalArtifactSha256: null,
    estimatedUsd: null,
    actualUsd: null,
    cloudinaryPublicId: null,
    cloudinaryAccount: null,
    uploadMetadata: null,
    qualityResult: null,
    compositorDiagnostics: null,
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    post: {
      id: "post-1",
      headline: "Prepare Your Garden for Spring",
      supportingLine: "Start with a clean, clearly defined garden bed.",
      cta: "Review the steps",
      caption: "A practical spring garden checklist.",
      layoutFamily: "cinematic-editorial",
      run: {
        ...existingRun,
        id: "run-1",
        correlationId: "social-creative:run-1",
      },
    },
    ...overrides,
  };
}

const brandFixture: SocialCreativeBrandContext = {
  userId: "user-1",
  businessId: "business-1",
  businessName: "Example Landscaping",
  businessType: "Landscaping company",
  businessDescription: "Residential landscaping and garden maintenance.",
  websiteUrl: "https://example.com",
  phone: null,
  city: "Toronto",
  state: "Ontario",
  country: "Canada",
  language: "en",
  locale: "en-CA",
  tone: "professional",
  targetAudience: "Homeowners",
  services: ["Garden maintenance"],
  primaryColors: ["#22543d"],
  secondaryColors: [],
  fontFamily: "Montserrat",
  logoUrl: null,
  referenceImageUrls: [],
  recentCreativeHistory: [],
};
