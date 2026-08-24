import { describe, expect, test } from "bun:test";

import {
  failQueuedProductionBlogGeneration,
  getProductionBlogGenerationStatuses,
  queueProductionBlogGenerationRun,
} from "../services/blog-pipeline-v2/generation-status";

describe("backend-owned blog generation status", () => {
  test("queues a failed run again without losing its durable checkpoint", async () => {
    let update: any = null;
    const prisma = {
      blogGenerationRun: {
        findUnique: async () => ({
          status: "FAILED",
          updatedAt: new Date(),
          metadata: {
            state: "failed",
            checkpoint: { draft: { title: "Existing draft" } },
          },
        }),
        updateMany: async (input: any) => {
          update = input.data;
          return { count: 1 };
        },
      },
    };

    await expect(
      queueProductionBlogGenerationRun({
        keywordId: "keyword-1",
        userId: "user-1",
        businessId: "business-1",
        prisma: prisma as any,
      }),
    ).resolves.toEqual({ alreadyProcessing: false, status: "queued" });
    expect(update.status).toBe("QUEUED");
    expect(update.completedAt).toBeNull();
    expect(update.errorCode).toBeNull();
    expect(update.metadata.checkpoint).toEqual({
      draft: { title: "Existing draft" },
    });
  });

  test("allows only one dispatch claim across simultaneous first requests", async () => {
    type Run = {
      correlationId: string;
      status: string;
      metadata: Record<string, unknown>;
      updatedAt: Date;
    };
    let run: Run | null = null;
    const prisma = {
      blogGenerationRun: {
        findUnique: async () => {
          await Promise.resolve();
          return run ? { ...run } : null;
        },
        create: async (input: any) => {
          await Promise.resolve();
          if (run) throw { code: "P2002" };
          run = {
            correlationId: input.data.correlationId,
            status: input.data.status,
            metadata: input.data.metadata,
            updatedAt: new Date(),
          };
          return run;
        },
        updateMany: async () => {
          throw new Error("an active winner must not be reclaimed");
        },
      },
    };

    const results = await Promise.all([
      queueProductionBlogGenerationRun({
        keywordId: "keyword-1",
        userId: "user-1",
        businessId: "business-1",
        prisma: prisma as any,
      }),
      queueProductionBlogGenerationRun({
        keywordId: "keyword-1",
        userId: "user-1",
        businessId: "business-1",
        prisma: prisma as any,
      }),
    ]);
    expect(
      results.filter((result) => result.alreadyProcessing === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.alreadyProcessing === true),
    ).toHaveLength(1);
  });

  test("does not enqueue a second event while the same run is active", async () => {
    const prisma = {
      blogGenerationRun: {
        findUnique: async () => ({
          status: "RUNNING",
          metadata: {},
          updatedAt: new Date(),
        }),
        create: async () => {
          throw new Error("create should not run");
        },
        updateMany: async () => {
          throw new Error("update should not run");
        },
      },
    };
    await expect(
      queueProductionBlogGenerationRun({
        keywordId: "keyword-1",
        userId: "user-1",
        businessId: "business-1",
        prisma: prisma as any,
      }),
    ).resolves.toEqual({ alreadyProcessing: true, status: "running" });
  });

  test("returns terminal and active status for every keyword in one backend read", async () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const prisma = {
      plan: {
        findMany: async () => [
          { id: "ready", blogId: "blog-1", blog: { slug: "ready-blog" } },
          { id: "queued", blogId: null, blog: null },
          { id: "running", blogId: null, blog: null },
          { id: "failed", blogId: null, blog: null },
          { id: "idle", blogId: null, blog: null },
        ],
      },
      blogGenerationRun: {
        findMany: async () => [
          {
            correlationId: "staged-v3-production-v1:queued",
            status: "QUEUED",
            blogId: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            errorCode: null,
          },
          {
            correlationId: "staged-v3-production-v1:running",
            status: "RUNNING",
            blogId: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            errorCode: null,
          },
          {
            correlationId: "staged-v3-production-v1:failed",
            status: "FAILED",
            blogId: null,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            errorCode: "PROVIDER_FAILED",
          },
        ],
      },
    };

    const statuses = await getProductionBlogGenerationStatuses({
      userId: "user-1",
      businessId: "business-1",
      includeUnassignedPrimaryPlans: false,
      prisma: prisma as any,
    });
    expect(statuses.map((item) => [item.keywordId, item.status])).toEqual([
      ["ready", "completed"],
      ["queued", "queued"],
      ["running", "running"],
      ["failed", "failed"],
      ["idle", "idle"],
    ]);
    expect(statuses.find((item) => item.keywordId === "failed")).toMatchObject({
      canRetry: true,
      errorCode: "PROVIDER_FAILED",
    });
  });

  test("turns a stale active record into a visible retry state", async () => {
    const stale = new Date(Date.now() - 31 * 60_000);
    const prisma = {
      plan: {
        findMany: async () => [
          { id: "stalled", blogId: null, blog: null },
        ],
      },
      blogGenerationRun: {
        findMany: async () => [
          {
            correlationId: "staged-v3-production-v1:stalled",
            status: "RUNNING",
            blogId: null,
            createdAt: stale,
            updatedAt: stale,
            completedAt: null,
            errorCode: null,
          },
        ],
      },
    };
    await expect(
      getProductionBlogGenerationStatuses({
        userId: "user-1",
        businessId: "business-1",
        includeUnassignedPrimaryPlans: false,
        prisma: prisma as any,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        keywordId: "stalled",
        status: "failed",
        canRetry: true,
        errorCode: "BLOG_GENERATION_STALLED",
      }),
    ]);
  });

  test("marks only a still-queued run failed when enqueueing fails", async () => {
    let request: any = null;
    const prisma = {
      blogGenerationRun: {
        updateMany: async (input: any) => {
          request = input;
          return { count: 1 };
        },
      },
    };
    await failQueuedProductionBlogGeneration({
      keywordId: "keyword-1",
      message: "queue offline",
      prisma: prisma as any,
    });
    expect(request.where).toEqual({
      correlationId: "staged-v3-production-v1:keyword-1",
      status: "QUEUED",
    });
    expect(request.data).toMatchObject({
      status: "FAILED",
      errorCode: "BLOG_GENERATION_ENQUEUE_FAILED",
    });
  });
});
