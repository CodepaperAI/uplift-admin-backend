import { Prisma } from "@prisma/client";

import { prisma } from "../config/db.config";

export const BLOG_WRITER_PROMPT_VERSION = "qwen-grounded-v3";

export type BlogGenerationRunStatus =
  | "RUNNING"
  | "ACCEPTED"
  | "BLOCKED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "SHADOWED";

function json(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorFields(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorCode:
        "code" in error && typeof error.code === "string"
          ? error.code
          : error.name || "GENERATION_ERROR",
      errorMessage: error.message.slice(0, 4000),
    };
  }
  return {
    errorCode: "GENERATION_ERROR",
    errorMessage: String(error).slice(0, 4000),
  };
}

async function bestEffort<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    // Generation remains fail-closed even if observability storage is not yet
    // migrated. The warning makes a missing deployment migration visible.
    console.error("Blog generation run persistence failed:", error);
    return null;
  }
}

export async function startBlogGenerationRun(input: {
  correlationId: string;
  userId?: string;
  businessId?: string;
  provider: string;
  model: string;
  compilerVersion: number;
  factPacketVersion?: number;
  factPacketHash?: string;
  approvedTitle?: string;
  approvedSeoTitle?: string;
  approvedOutline?: unknown;
  claimIds?: string[];
  sourceUrls?: string[];
  metadata?: unknown;
}): Promise<void> {
  await bestEffort(() =>
    prisma.blogGenerationRun.upsert({
      where: { correlationId: input.correlationId },
      create: {
        correlationId: input.correlationId,
        userId: input.userId,
        businessId: input.businessId,
        provider: input.provider,
        model: input.model,
        promptVersion: BLOG_WRITER_PROMPT_VERSION,
        compilerVersion: input.compilerVersion,
        factPacketVersion: input.factPacketVersion,
        factPacketHash: input.factPacketHash,
        approvedTitle: input.approvedTitle,
        approvedSeoTitle: input.approvedSeoTitle,
        approvedOutline: json(input.approvedOutline),
        claimIds: input.claimIds ?? [],
        sourceUrls: input.sourceUrls ?? [],
        metadata: json(input.metadata),
      },
      update: {
        provider: input.provider,
        model: input.model,
        factPacketVersion: input.factPacketVersion,
        factPacketHash: input.factPacketHash,
        approvedTitle: input.approvedTitle,
        approvedSeoTitle: input.approvedSeoTitle,
        approvedOutline: json(input.approvedOutline),
        claimIds: input.claimIds ?? [],
        sourceUrls: input.sourceUrls ?? [],
        metadata: json(input.metadata),
        status: "RUNNING",
      },
    }),
  );
}

export async function finishBlogGenerationRun(input: {
  correlationId: string;
  status: BlogGenerationRunStatus;
  provider?: string;
  model?: string;
  blogId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  estimatedUsd?: number | null;
  validationFailures?: unknown;
  repairCount?: number;
  judgeScore?: number | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  finalSaveStatus?: string | null;
  durationMs?: number;
  error?: unknown;
  metadata?: unknown;
}): Promise<void> {
  const error = input.error ? errorFields(input.error) : {};
  await bestEffort(() =>
    prisma.blogGenerationRun.update({
      where: { correlationId: input.correlationId },
      data: {
        completedAt: new Date(),
        status: input.status,
        provider: input.provider,
        model: input.model,
        blogId: input.blogId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        estimatedUsd: input.estimatedUsd,
        validationFailures: json(input.validationFailures),
        repairCount: input.repairCount,
        judgeScore: input.judgeScore,
        fallbackUsed: input.fallbackUsed,
        fallbackReason: input.fallbackReason,
        finalSaveStatus: input.finalSaveStatus,
        durationMs: input.durationMs,
        metadata: json(input.metadata),
        ...error,
      },
    }),
  );
}

export async function recordBlockedBlogGeneration(input: {
  correlationId: string;
  userId?: string;
  businessId?: string;
  provider: string;
  model: string;
  compilerVersion: number;
  factPacketVersion?: number;
  factPacketHash?: string;
  conflicts: unknown;
  error: unknown;
}): Promise<void> {
  await startBlogGenerationRun({
    correlationId: input.correlationId,
    userId: input.userId,
    businessId: input.businessId,
    provider: input.provider,
    model: input.model,
    compilerVersion: input.compilerVersion,
    factPacketVersion: input.factPacketVersion,
    factPacketHash: input.factPacketHash,
    metadata: { conflicts: input.conflicts },
  });
  await finishBlogGenerationRun({
    correlationId: input.correlationId,
    status: "BLOCKED",
    validationFailures: input.conflicts,
    error: input.error,
    finalSaveStatus: "BLOCKED",
  });
}
