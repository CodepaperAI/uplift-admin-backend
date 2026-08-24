import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  SOCIAL_CREATIVE_IMAGE_MODEL,
  SOCIAL_CREATIVE_IMAGE_QUALITY,
  SOCIAL_CREATIVE_PIPELINE_VERSION,
  SOCIAL_CREATIVE_PROMPT_VERSION,
  SOCIAL_CREATIVE_TEXT_MODEL,
  socialCreativeSlideCount,
} from "./constants";
import { socialCreativeErrorMessage } from "./error-message";
import type {
  SocialCreativeGenerationRequest,
  SocialCreativePlan,
  SocialCreativeUsage,
  SocialPlatform,
} from "./types";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sameOptionalString(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

function samePlatforms(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((platform, index) => platform === [...right].sort()[index])
  );
}

function assertIdempotentRunMatchesRequest(
  existing: {
    userId: string;
    businessId: string;
    topic: string;
    kind: string;
    source: string;
    sourceBlogId: string | null;
    sourcePlanId: string | null;
    socialTopicPlanId: string | null;
    requestedPlatforms: string[];
  },
  input: SocialCreativeGenerationRequest & { platforms: SocialPlatform[] },
): void {
  const ownershipMatches =
    existing.userId === input.userId && existing.businessId === input.businessId;
  const requestMatches =
    existing.topic === input.topic &&
    existing.kind === input.kind &&
    existing.source === input.source &&
    sameOptionalString(existing.sourceBlogId, input.sourceBlogId) &&
    sameOptionalString(existing.sourcePlanId, input.sourcePlanId) &&
    sameOptionalString(existing.socialTopicPlanId, input.socialTopicPlanId) &&
    samePlatforms(existing.requestedPlatforms, input.platforms);
  if (!ownershipMatches || !requestMatches) {
    throw new Error("Social creative idempotency key request mismatch");
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "P2002",
  );
}

function usageToken(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export async function createOrGetSocialCreativeRun(
  input: SocialCreativeGenerationRequest & {
    platforms: SocialPlatform[];
    estimatedBudgetUsd: number;
  },
  prisma: PrismaClient = defaultPrisma,
) {
  const idempotencyKey =
    input.idempotencyKey?.trim() || `social-creative:${randomUUID()}`;
  const existing = await prisma.socialCreativeRun.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    assertIdempotentRunMatchesRequest(existing, input);
    return existing;
  }
  const correlationId = `social-creative:${randomUUID()}`;
  try {
    return await prisma.socialCreativeRun.create({
      data: {
        idempotencyKey,
        correlationId,
        userId: input.userId,
        businessId: input.businessId,
        topic: input.topic,
        kind: input.kind,
        source: input.source,
        sourceBlogId: input.sourceBlogId ?? null,
        sourcePlanId: input.sourcePlanId ?? null,
        socialTopicPlanId: input.socialTopicPlanId ?? null,
        requestedPlatforms: input.platforms,
        plannedSlides: socialCreativeSlideCount(input.kind),
        pipelineVersion: SOCIAL_CREATIVE_PIPELINE_VERSION,
        promptVersion: SOCIAL_CREATIVE_PROMPT_VERSION,
        textModel: SOCIAL_CREATIVE_TEXT_MODEL,
        imageModel: SOCIAL_CREATIVE_IMAGE_MODEL,
        imageQuality: SOCIAL_CREATIVE_IMAGE_QUALITY,
        estimatedBudgetUsd: input.estimatedBudgetUsd,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await prisma.socialCreativeRun.findUnique({
      where: { idempotencyKey },
    });
    if (!raced) throw error;
    assertIdempotentRunMatchesRequest(raced, input);
    return raced;
  }
}

export async function getSocialCreativeRunForUser(
  input: { runId: string; userId: string },
  prisma: PrismaClient = defaultPrisma,
) {
  return prisma.socialCreativeRun.findFirst({
    where: { id: input.runId, userId: input.userId },
    include: {
      business: { select: { businessName: true } },
      sourcePlan: { select: { publishDate: true, publishTime: true } },
      socialTopicPlan: { select: { scheduledFor: true, timezone: true } },
      posts: {
        orderBy: { slideIndex: "asc" },
        include: { assets: { orderBy: [{ slideIndex: "asc" }, { platform: "asc" }] } },
      },
    },
  });
}

export async function listSocialCreativeRunsForUser(
  input: {
    businessId: string;
    userId: string;
    limit: number;
    cursor?: string;
  },
  prisma: PrismaClient = defaultPrisma,
) {
  const business = await prisma.business.findFirst({
    where: { id: input.businessId, userId: input.userId },
    select: {
      id: true,
      businessName: true,
      socialAutomationSettings: {
        select: {
          initialPlanStatus: true,
          initialPlanQueuedAt: true,
          initialPlanStartedAt: true,
          initialPlanGeneratedAt: true,
          initialPlanErrorCode: true,
          initialPlanErrorMessage: true,
        },
      },
    },
  });
  if (!business) {
    throw new Error("Business not found or ownership mismatch");
  }

  if (input.cursor) {
    const ownedCursor = await prisma.socialCreativeRun.findFirst({
      where: {
        id: input.cursor,
        businessId: input.businessId,
        userId: input.userId,
      },
      select: { id: true },
    });
    if (!ownedCursor) throw new Error("Social creative cursor not found");
  }

  const runs = await prisma.socialCreativeRun.findMany({
    where: { businessId: input.businessId, userId: input.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(input.cursor
      ? { cursor: { id: input.cursor }, skip: 1 }
      : {}),
    include: {
      sourcePlan: { select: { publishDate: true, publishTime: true } },
      socialTopicPlan: { select: { scheduledFor: true, timezone: true } },
      posts: {
        orderBy: { slideIndex: "asc" },
        include: {
          assets: {
            orderBy: [{ slideIndex: "asc" }, { platform: "asc" }],
          },
        },
      },
    },
  });
  const hasMore = runs.length > input.limit;
  const items = hasMore ? runs.slice(0, input.limit) : runs;
  return {
    businessName: business.businessName,
    initialization: business.socialAutomationSettings,
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

export async function listSocialCalendarForUser(
  input: {
    businessId: string;
    userId: string;
    from: Date;
    to: Date;
  },
  prisma: PrismaClient = defaultPrisma,
) {
  const business = await prisma.business.findFirst({
    where: { id: input.businessId, userId: input.userId },
    select: {
      id: true,
      businessName: true,
      socialAutomationSettings: {
        select: {
          initialPlanStatus: true,
          initialPlanQueuedAt: true,
          initialPlanStartedAt: true,
          initialPlanGeneratedAt: true,
          initialPlanErrorCode: true,
          initialPlanErrorMessage: true,
        },
      },
    },
  });
  if (!business) {
    throw new Error("Business not found or ownership mismatch");
  }

  const items = await prisma.socialTopicPlan.findMany({
    where: {
      businessId: input.businessId,
      userId: input.userId,
      scheduledFor: { gte: input.from, lte: input.to },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    include: {
      carouselWeekAssignment: { select: { status: true } },
      creativeRun: {
        include: {
          sourcePlan: { select: { publishDate: true, publishTime: true } },
          posts: {
            orderBy: { slideIndex: "asc" },
            include: {
              assets: {
                orderBy: [{ slideIndex: "asc" }, { platform: "asc" }],
              },
            },
          },
        },
      },
    },
  });

  return {
    businessName: business.businessName,
    initialization: business.socialAutomationSettings,
    items,
  };
}

export async function persistSocialCreativePlan(
  input: {
    runId: string;
    businessId: string;
    plan: SocialCreativePlan;
    usage?: SocialCreativeUsage;
    assets: Array<{
      slideIndex: number;
      platform: SocialPlatform;
      width: number;
      height: number;
      aspectRatio: string;
      sourceSize: string;
      prompt: string;
    }>;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.socialCreativeRun.update({
      where: { id: input.runId },
      data: {
        status: "RENDERING",
        plannedSlides: input.plan.slides.length,
        language: input.plan.language,
        locale: input.plan.locale,
        contentPlan: json({
          ...input.plan,
          ...(input.usage ? { _usage: input.usage } : {}),
        }),
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    const postIds = new Map<number, string>();
    for (const slide of input.plan.slides) {
      const post = await tx.socialCreativePost.upsert({
        where: {
          runId_slideIndex: { runId: input.runId, slideIndex: slide.slideIndex },
        },
        create: {
          runId: input.runId,
          businessId: input.businessId,
          slideIndex: slide.slideIndex,
          topic: slide.topic,
          headline: slide.headline,
          supportingLine: slide.supportingLine || null,
          cta: slide.cta || null,
          caption: slide.caption,
          language: input.plan.language,
          locale: input.plan.locale,
          campaignObjective: slide.campaignObjective,
          archetype: slide.archetype,
          layoutFamily: slide.layoutFamily,
          visualConcept: slide.visualConcept,
        },
        update: {},
      });
      postIds.set(slide.slideIndex, post.id);
    }
    const assetIds: string[] = [];
    for (const asset of input.assets) {
      const postId = postIds.get(asset.slideIndex);
      if (!postId) throw new Error(`No post exists for slide ${asset.slideIndex}`);
      const row = await tx.socialCreativeAsset.upsert({
        where: {
          postId_platform_slideIndex: {
            postId,
            platform: asset.platform,
            slideIndex: asset.slideIndex,
          },
        },
        create: {
          postId,
          platform: asset.platform,
          slideIndex: asset.slideIndex,
          width: asset.width,
          height: asset.height,
          aspectRatio: asset.aspectRatio,
          sourceSize: asset.sourceSize,
          model: SOCIAL_CREATIVE_IMAGE_MODEL,
          quality: SOCIAL_CREATIVE_IMAGE_QUALITY,
          renderMode: "provider-direct",
          pipelineVersion: SOCIAL_CREATIVE_PIPELINE_VERSION,
          promptVersion: SOCIAL_CREATIVE_PROMPT_VERSION,
          prompt: asset.prompt,
        },
        update: {},
      });
      assetIds.push(row.id);
    }
    if (input.usage) {
      await recordSocialCreativeTextUsage(
        { runId: input.runId, usage: input.usage },
        tx,
        {
          correlationId: run.correlationId,
          userId: run.userId,
          businessId: run.businessId,
        },
      );
    }
    return assetIds;
  });
}

export async function loadSocialCreativeAsset(
  assetId: string,
  prisma: PrismaClient = defaultPrisma,
) {
  return prisma.socialCreativeAsset.findUnique({
    where: { id: assetId },
    include: { post: { include: { run: true } } },
  });
}

export async function claimSocialCreativeAsset(
  assetId: string,
  prisma: PrismaClient = defaultPrisma,
  options: { staleBefore?: Date; claimedAt?: Date } = {},
): Promise<boolean> {
  const claimedAt = options.claimedAt ?? new Date();
  const result = await prisma.socialCreativeAsset.updateMany({
    where: {
      id: assetId,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        ...(options.staleBefore
          ? [
              {
                status: "RENDERING" as const,
                updatedAt: { lte: options.staleBefore },
              },
            ]
          : []),
      ],
    },
    data: {
      status: "RENDERING",
      startedAt: claimedAt,
      errorCode: null,
      errorMessage: null,
      attemptCount: { increment: 1 },
    },
  });
  return result.count === 1;
}

/**
 * Refreshes a render lease only while the same worker still owns it. Reclaims
 * replace startedAt, so a delayed worker cannot keep a newer lease alive.
 */
export async function heartbeatSocialCreativeAsset(
  assetId: string,
  leaseStartedAt: Date,
  prisma: PrismaClient = defaultPrisma,
  heartbeatAt = new Date(),
): Promise<boolean> {
  const result = await prisma.socialCreativeAsset.updateMany({
    where: {
      id: assetId,
      status: "RENDERING",
      startedAt: leaseStartedAt,
    },
    data: { updatedAt: heartbeatAt },
  });
  return result.count === 1;
}

export async function checkpointSocialCreativeProviderResult(
  input: {
    assetId: string;
    providerRequestId: string;
    sha256: string;
    providerArtifactUrl?: string;
    estimatedUsd: number;
    actualUsd?: number | null;
    quality?: string | null;
    width?: number;
    height?: number;
    sourceSize?: string;
    runId?: string;
    metadata?: Record<string, unknown>;
    uploadMetadata?: Record<string, unknown>;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const checkpoint = async (tx: Prisma.TransactionClient | PrismaClient) => {
    await tx.socialCreativeAsset.update({
      where: { id: input.assetId },
      data: {
        providerRequestId: input.providerRequestId,
        providerArtifactSha256: input.sha256,
        providerArtifactUrl: input.providerArtifactUrl ?? undefined,
        estimatedUsd: input.estimatedUsd,
        actualUsd: input.actualUsd ?? undefined,
        quality: input.quality ?? undefined,
        width: input.width ?? undefined,
        height: input.height ?? undefined,
        sourceSize: input.sourceSize ?? undefined,
        uploadMetadata:
          input.uploadMetadata === undefined
            ? undefined
            : json(input.uploadMetadata),
      },
    });
    if (input.runId) {
      await recordSocialCreativeImageUsage(
        {
          runId: input.runId,
          assetId: input.assetId,
          providerRequestId: input.providerRequestId,
          estimatedUsd: input.estimatedUsd,
          metadata: input.metadata ?? {},
        },
        tx,
      );
    }
  };
  if (!input.runId) {
    await checkpoint(prisma);
    return;
  }
  await prisma.$transaction(checkpoint);
}

export async function completeSocialCreativeAsset(
  input: {
    assetId: string;
    imageUrl: string;
    finalArtifactSha256?: string;
    cloudinaryPublicId?: string;
    cloudinaryAccount?: string;
    uploadMetadata?: unknown;
    qualityResult: unknown;
    compositorDiagnostics: unknown;
    leaseStartedAt?: Date;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const data = {
    status: "COMPLETE" as const,
    imageUrl: input.imageUrl,
    finalArtifactSha256: input.finalArtifactSha256 ?? undefined,
    cloudinaryPublicId: input.cloudinaryPublicId ?? undefined,
    cloudinaryAccount: input.cloudinaryAccount ?? undefined,
    uploadMetadata:
      input.uploadMetadata === undefined ? undefined : json(input.uploadMetadata),
    qualityResult: json(input.qualityResult),
    compositorDiagnostics: json(input.compositorDiagnostics),
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    completedAt: new Date(),
  };
  if (input.leaseStartedAt) {
    const result = await prisma.socialCreativeAsset.updateMany({
      where: {
        id: input.assetId,
        status: "RENDERING",
        startedAt: input.leaseStartedAt,
      },
      data,
    });
    return result.count === 1;
  }
  await prisma.socialCreativeAsset.update({
    where: { id: input.assetId },
    data,
  });
  return true;
}

export async function failSocialCreativeAsset(
  input: {
    assetId: string;
    error: unknown;
    code?: string;
    stage?: string;
    leaseStartedAt?: Date;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const data = {
    status: "FAILED" as const,
    errorCode: input.code ?? "SOCIAL_CREATIVE_ASSET_FAILED",
    errorMessage: socialCreativeErrorMessage(input.error),
    failureStage: input.stage ?? null,
  };
  if (input.leaseStartedAt) {
    const result = await prisma.socialCreativeAsset.updateMany({
      where: {
        id: input.assetId,
        status: "RENDERING",
        startedAt: input.leaseStartedAt,
      },
      data,
    });
    return result.count === 1;
  }
  await prisma.socialCreativeAsset.update({
    where: { id: input.assetId },
    data,
  });
  return true;
}

export async function failIncompleteSocialCreativeAsset(
  input: { assetId: string; error: unknown; code?: string; stage?: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.socialCreativeAsset.updateMany({
    where: { id: input.assetId, status: { not: "COMPLETE" } },
    data: {
      status: "FAILED",
      errorCode: input.code ?? "SOCIAL_CREATIVE_ASSET_FAILED",
      errorMessage: socialCreativeErrorMessage(input.error),
      failureStage: input.stage ?? null,
    },
  });
}

type UsageReceiptPrisma = Pick<
  PrismaClient,
  "socialCreativeRun" | "llmUsageEvent"
>;

export async function recordSocialCreativeTextUsage(
  input: { runId: string; usage: SocialCreativeUsage },
  prisma: UsageReceiptPrisma = defaultPrisma,
  knownRun?: { correlationId: string; userId: string; businessId: string },
): Promise<void> {
  const run =
    knownRun ??
    (await prisma.socialCreativeRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { correlationId: true, userId: true, businessId: true },
    }));
  const correlationId = `${run.correlationId}:plan:${input.usage.responseId}`;
  const existing = await prisma.llmUsageEvent.findFirst({ where: { correlationId } });
  if (existing) return;
  try {
    await prisma.llmUsageEvent.create({
      data: {
        userId: run.userId,
        businessId: run.businessId,
        correlationId,
        purpose: "social_creative",
        provider: "openai",
        model: SOCIAL_CREATIVE_TEXT_MODEL,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        totalTokens: input.usage.totalTokens,
        estimatedUsd: input.usage.estimatedUsd,
        pricingSchemaVersion: 7,
        metadata: json({
          pipelineVersion: SOCIAL_CREATIVE_PIPELINE_VERSION,
          runId: input.runId,
          stage: "content_plan",
          providerResponseId: input.usage.responseId,
        }),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await prisma.llmUsageEvent.findFirst({ where: { correlationId } });
    if (!raced) throw error;
  }
}

export async function recordSocialCreativeImageUsage(
  input: {
    runId: string;
    assetId: string;
    providerRequestId: string;
    estimatedUsd: number;
    metadata: Record<string, unknown>;
  },
  prisma: UsageReceiptPrisma = defaultPrisma,
): Promise<void> {
  const run = await prisma.socialCreativeRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: { correlationId: true, userId: true, businessId: true },
  });
  const correlationId = `${run.correlationId}:asset:${input.assetId}:${input.providerRequestId}`;
  const existing = await prisma.llmUsageEvent.findFirst({ where: { correlationId } });
  if (existing) return;
  const usage =
    input.metadata.usage && typeof input.metadata.usage === "object"
      ? (input.metadata.usage as Record<string, unknown>)
      : null;
  const inputTokens = usageToken(usage?.inputTokens);
  const outputTokens = usageToken(usage?.outputTokens);
  const totalTokens = usageToken(usage?.totalTokens ?? inputTokens + outputTokens);
  try {
    await prisma.llmUsageEvent.create({
      data: {
        userId: run.userId,
        businessId: run.businessId,
        correlationId,
        purpose: "social_creative",
        provider: "openai",
        model: SOCIAL_CREATIVE_IMAGE_MODEL,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedUsd: input.estimatedUsd,
        pricingSchemaVersion: 7,
        metadata: json({
          pipelineVersion: SOCIAL_CREATIVE_PIPELINE_VERSION,
          runId: input.runId,
          assetId: input.assetId,
          stage: "image_generation",
          providerResponseId: input.providerRequestId,
          ...input.metadata,
        }),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await prisma.llmUsageEvent.findFirst({ where: { correlationId } });
    if (!raced) throw error;
  }
}

export async function socialCreativeSpendSince(
  since: Date,
  prisma: PrismaClient = defaultPrisma,
): Promise<number> {
  const aggregate = await prisma.llmUsageEvent.aggregate({
    where: { purpose: "social_creative", createdAt: { gte: since } },
    _sum: { estimatedUsd: true },
  });
  return Number(aggregate._sum.estimatedUsd ?? 0);
}

export async function finalizeSocialCreativeRun(
  runId: string,
  prisma: PrismaClient = defaultPrisma,
) {
  const run = await prisma.socialCreativeRun.findUniqueOrThrow({
    where: { id: runId },
    include: { posts: { include: { assets: true } } },
  });
  const assets = run.posts.flatMap((post) => post.assets);
  const complete = assets.filter((asset) => asset.status === "COMPLETE").length;
  const failed = assets.filter((asset) => asset.status === "FAILED").length;
  const active = assets.length - complete - failed;
  const firstFailedAsset = assets.find((asset) => asset.status === "FAILED");
  const imageCostUsd = assets.reduce(
    (sum, asset) => sum + Number(asset.actualUsd ?? asset.estimatedUsd ?? 0),
    0,
  );
  const contentPlan = run.contentPlan as { _usage?: { estimatedUsd?: unknown } } | null;
  const parsedPlanCost = Number(contentPlan?._usage?.estimatedUsd ?? 0);
  const planCostUsd = Number.isFinite(parsedPlanCost) && parsedPlanCost > 0
    ? parsedPlanCost
    : 0;
  const actualCostUsd = imageCostUsd + planCostUsd;
  const status =
    assets.length === 0 && run.contentPlan
      ? "COMPLETE"
      : assets.length > 0 && complete === assets.length
      ? "COMPLETE"
      : active === 0 && failed > 0
        ? "FAILED"
        : "RENDERING";
  await prisma.socialCreativeRun.update({
    where: { id: runId },
    data: {
      status,
      actualCostUsd,
      completedAt: status === "COMPLETE" || status === "FAILED" ? new Date() : null,
      errorCode: status === "FAILED" ? "SOCIAL_CREATIVE_ASSETS_FAILED" : null,
      errorMessage:
        status === "FAILED" ? `${failed} of ${assets.length} assets failed` : null,
      failureStage:
        status === "FAILED" ? firstFailedAsset?.failureStage ?? "asset" : null,
    },
  });
  return { runId, total: assets.length, complete, failed, active, status, actualCostUsd };
}

export async function failSocialCreativeRun(
  input: { runId: string; error: unknown; code?: string; stage?: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.socialCreativeRun.update({
    where: { id: input.runId },
    data: {
      status: "FAILED",
      errorCode: input.code ?? "SOCIAL_CREATIVE_RUN_FAILED",
      errorMessage: socialCreativeErrorMessage(input.error),
      failureStage: input.stage ?? null,
      completedAt: new Date(),
    },
  });
}
