import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  BLOG_PIPELINE_V2_COMPILER_VERSION,
  BLOG_PIPELINE_V2_PROMPT_VERSION,
  BLOG_PIPELINE_V2_TEXT_MODEL,
  BLOG_PIPELINE_V2_VERSION,
} from "./constants";

export type ProductionBlogGenerationStatus = {
  keywordId: string;
  status: "idle" | "queued" | "running" | "completed" | "failed";
  message: string;
  canRetry: boolean;
  blogId: string | null;
  blogSlug: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  errorCode: string | null;
};

const QUEUED_RUN_STALE_MS = 5 * 60_000;
const RUNNING_RUN_STALE_MS = 30 * 60_000;

function correlationId(keywordId: string): string {
  return `${BLOG_PIPELINE_V2_VERSION}:${keywordId}`;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isUniqueConstraintConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function activeRunStatus(run: {
  status: string;
  updatedAt: Date;
}): "queued" | "running" | null {
  const status = run.status.toUpperCase();
  if (status !== "QUEUED" && status !== "RUNNING") return null;
  const staleAfterMs =
    status === "QUEUED" ? QUEUED_RUN_STALE_MS : RUNNING_RUN_STALE_MS;
  if (Date.now() - run.updatedAt.getTime() >= staleAfterMs) return null;
  return status === "RUNNING" ? "running" : "queued";
}

export async function queueProductionBlogGenerationRun(input: {
  keywordId: string;
  userId: string;
  businessId: string;
  prisma?: PrismaClient;
}): Promise<{ alreadyProcessing: boolean; status: "queued" | "running" }> {
  const prisma = input.prisma ?? defaultPrisma;
  const id = correlationId(input.keywordId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await prisma.blogGenerationRun.findUnique({
      where: { correlationId: id },
      select: { status: true, metadata: true, updatedAt: true },
    });
    if (existing) {
      const activeStatus = activeRunStatus(existing);
      if (activeStatus) {
        return { alreadyProcessing: true, status: activeStatus };
      }
      const existingMetadata = metadataRecord(existing.metadata);
      const claimed = await prisma.blogGenerationRun.updateMany({
        where: {
          correlationId: id,
          status: existing.status,
          updatedAt: existing.updatedAt,
        },
        data: {
          userId: input.userId,
          businessId: input.businessId,
          blogId: null,
          provider: "openai",
          model: BLOG_PIPELINE_V2_TEXT_MODEL,
          promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
          compilerVersion: BLOG_PIPELINE_V2_COMPILER_VERSION,
          status: "QUEUED",
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          finalSaveStatus: null,
          metadata: json({
            ...existingMetadata,
            pipelineVersion: BLOG_PIPELINE_V2_VERSION,
            planId: input.keywordId,
            state: "queued",
            checkpoint: existingMetadata.checkpoint ?? {},
          }),
        },
      });
      if (claimed.count === 1) {
        return { alreadyProcessing: false, status: "queued" };
      }
      continue;
    }

    try {
      await prisma.blogGenerationRun.create({
        data: {
          correlationId: id,
          userId: input.userId,
          businessId: input.businessId,
          provider: "openai",
          model: BLOG_PIPELINE_V2_TEXT_MODEL,
          promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
          compilerVersion: BLOG_PIPELINE_V2_COMPILER_VERSION,
          status: "QUEUED",
          metadata: json({
            pipelineVersion: BLOG_PIPELINE_V2_VERSION,
            planId: input.keywordId,
            state: "queued",
            checkpoint: {},
          }),
        },
      });
      return { alreadyProcessing: false, status: "queued" };
    } catch (error) {
      if (!isUniqueConstraintConflict(error)) throw error;
    }
  }
  throw new Error("Blog generation state changed while queueing. Please retry.");
}

export async function failQueuedProductionBlogGeneration(input: {
  keywordId: string;
  message: string;
  prisma?: PrismaClient;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  await prisma.blogGenerationRun.updateMany({
    where: {
      correlationId: correlationId(input.keywordId),
      status: "QUEUED",
    },
    data: {
      status: "FAILED",
      finalSaveStatus: "FAILED",
      completedAt: new Date(),
      errorCode: "BLOG_GENERATION_ENQUEUE_FAILED",
      errorMessage: input.message.slice(0, 4_000),
    },
  });
}

export async function getProductionBlogGenerationStatuses(input: {
  userId: string;
  businessId: string;
  includeUnassignedPrimaryPlans: boolean;
  prisma?: PrismaClient;
}): Promise<ProductionBlogGenerationStatus[]> {
  const prisma = input.prisma ?? defaultPrisma;
  const plans = await prisma.plan.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      ...(input.includeUnassignedPrimaryPlans
        ? { OR: [{ businessId: input.businessId }, { businessId: null }] }
        : { businessId: input.businessId }),
    },
    select: {
      id: true,
      blogId: true,
      blog: { select: { slug: true } },
    },
  });
  const runs = plans.length
    ? await prisma.blogGenerationRun.findMany({
        where: {
          correlationId: { in: plans.map((plan) => correlationId(plan.id)) },
          userId: input.userId,
          businessId: input.businessId,
        },
        select: {
          correlationId: true,
          status: true,
          blogId: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          errorCode: true,
        },
      })
    : [];
  const runByCorrelationId = new Map(
    runs.map((run) => [run.correlationId, run]),
  );

  return plans.map((plan) => {
    const run = runByCorrelationId.get(correlationId(plan.id));
    const runStatus = run?.status.toUpperCase();
    const blogId = plan.blogId ?? run?.blogId ?? null;
    const runAgeMs = run ? Date.now() - run.updatedAt.getTime() : 0;
    const stalled =
      (runStatus === "QUEUED" && runAgeMs >= QUEUED_RUN_STALE_MS) ||
      ((runStatus === "RUNNING" || runStatus === "ACCEPTED") &&
        runAgeMs >= RUNNING_RUN_STALE_MS);
    const completed = Boolean(blogId);
    const failed = runStatus === "FAILED" || stalled;
    const queued = runStatus === "QUEUED" && !stalled;
    const running =
      (runStatus === "RUNNING" || runStatus === "ACCEPTED") && !stalled;
    const status: ProductionBlogGenerationStatus["status"] = completed
      ? "completed"
      : failed
        ? "failed"
        : running
          ? "running"
          : queued
            ? "queued"
            : "idle";
    const message =
      status === "completed"
        ? "Article ready"
        : status === "failed"
          ? stalled
            ? "Article generation stopped updating. Retry when you are ready."
            : "Article generation did not complete. Retry when you are ready."
          : status === "running"
            ? "Writing and preparing your article"
            : status === "queued"
              ? "Article generation is queued"
              : "Ready to generate";
    return {
      keywordId: plan.id,
      status,
      message,
      canRetry: status === "failed" || status === "idle",
      blogId,
      blogSlug: plan.blog?.slug ?? null,
      startedAt: run?.createdAt.toISOString() ?? null,
      completedAt: run?.completedAt?.toISOString() ?? null,
      updatedAt: run?.updatedAt.toISOString() ?? null,
      errorCode: failed
        ? stalled
          ? "BLOG_GENERATION_STALLED"
          : run?.errorCode ?? "BLOG_GENERATION_FAILED"
        : null,
    };
  });
}
