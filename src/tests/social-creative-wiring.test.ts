import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import {
  listSocialCreativeRuns,
  mapSocialCreativeRequestError,
  serializeSocialCreativeRun,
} from "../controllers/social-creative.controller";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { estimateSocialCreativeImageBudget } from "../services/social-creative/pipeline";
import { shouldRetryScheduledSocialTopic } from "../inngest/social-creative";
import {
  listSocialCalendarForUser,
  listSocialCreativeRunsForUser,
} from "../services/social-creative/repository";

describe("social creative backend wiring", () => {
  test("budgets one independent provider-native image for every platform", () => {
    expect(
      estimateSocialCreativeImageBudget({
        kind: "single",
        platforms: ["instagram", "facebook", "linkedin", "x"],
      }),
    ).toBeCloseTo(0.164, 8);
  });

  test("wires the persisted weekly logo decision into planning and completion", () => {
    const pipeline = readFileSync(
      resolve(import.meta.dir, "../services/social-creative/pipeline.ts"),
      "utf8",
    );

    expect(pipeline).toContain("resolveScheduledSocialArtworkLogo");
    expect(pipeline).toContain("includeArtworkLogo &&");
    expect(pipeline).toContain('run.kind !== "carousel" || slideIndex === 0');
    expect(pipeline).toContain("brandLogoUrl: brand.logoUrl");
    expect(pipeline).toContain("markSocialArtworkLogoGenerated(run.id, prisma)");
  });

  test("retries a scheduled topic once before making the failure terminal", () => {
    expect(shouldRetryScheduledSocialTopic(0)).toBe(true);
    expect(shouldRetryScheduledSocialTopic(1)).toBe(false);
  });

  test("registers all four durable social creative event boundaries", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/social-creative.ts"),
      "utf8",
    );
    expect(source).toContain('event: "social/creative.requested"');
    expect(source).toContain('event: "social/creative.asset.requested"');
    expect(source).toContain('event: "social/creative.asset.completed"');
    expect(source).toContain('event: "social/creative.finalize"');
    expect(source).toContain('event: "social/topics.plan.requested"');
    expect(source).toContain('name: "social/topics.scan.requested"');
    expect(source).toContain('{ event: "social/topics.scan.requested" }');
    expect(source).toContain('cron: "15 * * * *"');
    expect(source).toContain('cron: "30 3 * * *"');
    expect(source).toContain('key: "event.data.businessId"');
    expect(source).toContain('key: "event.data.assetId"');
    expect(source).toContain("perBusinessImageConcurrency()");
    expect(source).toContain(
      "SOCIAL_CREATIVE_IMAGE_PER_BUSINESS_CONCURRENCY",
    );
    expect(source).toContain('timeouts: { finish: "12m" }');
    expect(source).toContain(
      'id: `social-creative-asset:${assetId}:${requestEventId}`',
    );
  });

  test("queues initial social planning immediately for entitled additional websites", () => {
    const onboardingSource = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );

    expect(onboardingSource).toContain(
      '"resolve-secondary-social-entitlement"',
    );
    expect(onboardingSource).toContain(
      '"trigger-secondary-social-topic-plan"',
    );
    expect(onboardingSource).toContain(
      '"resolve-finalized-secondary-social-entitlement"',
    );
    expect(onboardingSource).toContain(
      '"trigger-finalized-secondary-social-topic-plan"',
    );
    expect(onboardingSource).toContain(
      '"trigger-idempotent-secondary-social-topic-plan"',
    );
  });

  test("exposes an authenticated async API and reports provider configuration", () => {
    const routes = readFileSync(
      resolve(import.meta.dir, "../routes/social-creative.routes.ts"),
      "utf8",
    );
    const controller = readFileSync(
      resolve(import.meta.dir, "../controllers/social-creative.controller.ts"),
      "utf8",
    );
    expect(routes).toContain("SocialCreativeRouter.use(requireBackendAuth)");
    expect(routes).toContain('get("/runs", listSocialCreativeRuns)');
    expect(routes).toContain('get("/calendar", listSocialCalendar)');
    expect(routes).toContain(
      'post("/runs/:runId/retry-failed", retryFailedSocialCreativeAssets)',
    );
    expect(routes).toContain('post("/topics/plan", requestSocialTopicPlan)');
    expect(routes).toContain('post("/generate"');
    expect(controller).toContain('name: "social/creative.requested"');
    expect(controller).toContain("socialTopicPlanId");
    expect(controller).toContain("Social calendar topic not found");
    expect(controller).toContain("social-topic-run:${topicPlan.id}:${");
    expect(controller).toContain('"carousel-v1"');
    expect(controller).toContain(
      "publishingEnabled: Boolean(process.env.ZERNIO_API_KEY?.trim())",
    );
    expect(controller).not.toContain("publishPost");
  });

  test("does not leak ownership failures or treat idempotency conflicts as 500s", () => {
    expect(
      mapSocialCreativeRequestError(
        new Error("Business not found or ownership mismatch"),
      ),
    ).toEqual({ status: 404, message: "Business not found" });
    expect(
      mapSocialCreativeRequestError(
        new Error("Social creative idempotency key input mismatch"),
      ),
    ).toEqual({
      status: 409,
      message: "Social creative idempotency key conflict",
    });
    expect(mapSocialCreativeRequestError(new Error("provider failed"))).toBeNull();
  });

  test("returns a stable public run shape without internal source artifacts or receipts", () => {
    const result = serializeSocialCreativeRun({
      id: "run-1",
      estimatedBudgetUsd: "0.041000",
      actualCostUsd: "0.044000",
      contentPlan: { language: "en", slides: [], _usage: { responseId: "private" } },
      source: "SCHEDULE",
      sourcePlan: { publishDate: "2026-08-12", publishTime: "14:30" },
      business: { businessName: "LunchLink" },
      posts: [
        {
          id: "post-1",
          assets: [
            {
              id: "asset-1",
              imageUrl: "https://cdn.example/final.jpg",
              prompt: "internal prompt",
              providerArtifactUrl: "https://cdn.example/source.png",
              uploadMetadata: { private: true },
              estimatedUsd: "0.041000",
              actualUsd: "0.044000",
            },
          ],
        },
      ],
    });
    expect(result.contentPlan).toEqual({ language: "en", slides: [] });
    expect(result.contentSetId).toBe("run-1");
    expect(result.brandName).toBe("LunchLink");
    expect(result.schedule).toEqual({ date: "2026-08-12", time: "14:30" });
    expect(result).not.toHaveProperty("business");
    expect(result).not.toHaveProperty("sourcePlan");
    expect(result.posts[0].assets[0]).not.toHaveProperty("prompt");
    expect(result.posts[0].assets[0]).not.toHaveProperty("providerArtifactUrl");
    expect(result.posts[0].assets[0]).not.toHaveProperty("uploadMetadata");
    expect(result.posts[0].assets[0].actualUsd).toBe(0.044);
  });

  test("lists only runs for an owned business with a bounded cursor", async () => {
    const findManyInputs: unknown[] = [];
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-1",
          businessName: "LunchLink",
          socialAutomationSettings: null,
        }),
      },
      socialCreativeRun: {
        findFirst: async () => ({ id: "run-cursor" }),
        findMany: async (input: unknown) => {
          findManyInputs.push(input);
          return [{ id: "run-2" }, { id: "run-1" }];
        },
      },
    } as unknown as PrismaClient;
    const result = await listSocialCreativeRunsForUser(
      {
        businessId: "business-1",
        userId: "user-1",
        cursor: "run-cursor",
        limit: 1,
      },
      prisma,
    );
    expect(findManyInputs[0]).toMatchObject({
      where: { businessId: "business-1", userId: "user-1" },
      cursor: { id: "run-cursor" },
      skip: 1,
      take: 2,
    });
    expect(result.businessName).toBe("LunchLink");
    expect(result.items.map((item) => item.id)).toEqual(["run-2"]);
    expect(result.nextCursor).toBe("run-2");
  });

  test("fails closed before listing runs for an unowned business", async () => {
    let queriedRuns = false;
    const prisma = {
      business: { findFirst: async () => null },
      socialCreativeRun: {
        findMany: async () => {
          queriedRuns = true;
          return [];
        },
      },
    } as unknown as PrismaClient;
    await expect(
      listSocialCreativeRunsForUser(
        { businessId: "business-2", userId: "user-1", limit: 20 },
        prisma,
      ),
    ).rejects.toThrow("Business not found or ownership mismatch");
    expect(queriedRuns).toBe(false);
  });

  test("lists calendar topics only inside the owned business and date range", async () => {
    const findManyInputs: unknown[] = [];
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-1",
          businessName: "LunchLink",
          socialAutomationSettings: null,
        }),
      },
      socialTopicPlan: {
        findMany: async (input: unknown) => {
          findManyInputs.push(input);
          return [];
        },
      },
    } as unknown as PrismaClient;
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2026-09-01T00:00:00.000Z");
    const result = await listSocialCalendarForUser(
      { businessId: "business-1", userId: "user-1", from, to },
      prisma,
    );
    expect(findManyInputs[0]).toMatchObject({
      where: {
        businessId: "business-1",
        userId: "user-1",
        scheduledFor: { gte: from, lte: to },
      },
    });
    expect(result).toEqual({
      businessName: "LunchLink",
      initialization: null,
      items: [],
    });
  });

  test("rejects an unauthenticated list request before parsing scope", async () => {
    let statusCode = 0;
    let responseBody: unknown;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    };
    await listSocialCreativeRuns(
      { authUserId: undefined, query: {} } as unknown as AuthenticatedRequest,
      response as any,
    );
    expect(statusCode).toBe(401);
    expect(responseBody).toMatchObject({
      success: false,
      message: "Unauthorized",
    });
  });
});
