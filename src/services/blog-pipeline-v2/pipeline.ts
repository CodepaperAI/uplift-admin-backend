import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import { syncManagedBacklinksForPublishedBlog } from "../managed-backlinks.service";
import {
  BLOG_PIPELINE_V2_COMPILER_VERSION,
  BLOG_PIPELINE_V2_COMPATIBLE_PROMPT_VERSIONS,
  BLOG_PIPELINE_V2_PROMPT_VERSION,
  BLOG_PIPELINE_V2_TEXT_MODEL,
  BLOG_PIPELINE_V2_VERSION,
} from "./constants";
import {
  loadProductionBlogContext,
  researchLocationForContext,
} from "./context-loader";
import type { DirectRecoveryWriterResult } from "./direct-writer";
import {
  runProductionDurableStep,
  type ProductionDurableStepRunner,
} from "./durable-step";
import {
  generateProductionBlogImages,
  insertProductionInternalImages,
  type ProductionBlogImage,
} from "./image-pipeline";
import {
  filterProductionLinkCandidates,
  selectProductionBlogLinks,
  type ProductionLinkCandidate,
} from "./link-selector";
import { persistProductionBlog } from "./persistence";
import {
  stagedVisibleWordCount,
  writeProductionStagedV3Draft,
} from "./staged-writer";
import {
  fetchRecoveryTopicSerpViaOpenAi,
  type RecoveryTopicSerpAnalysis,
  type RecoveryTopicSerpEvidenceExcerpt,
  type RecoveryTopicSerpOpenAiProvenance,
} from "./topic-research";
import { ProductionPipelineUsageRecorder } from "./usage-accounting";

type ResearchCheckpoint = {
  analysis: RecoveryTopicSerpAnalysis;
  evidenceExcerpts: RecoveryTopicSerpEvidenceExcerpt[];
  provenance: RecoveryTopicSerpOpenAiProvenance;
};

type ProductionPipelineCheckpoint = {
  blogImagesEnabled?: boolean;
  links?: ProductionLinkCandidate[];
  research?: ResearchCheckpoint;
  draft?: DirectRecoveryWriterResult;
  images?: ProductionBlogImage[];
};

type RunMetadata = {
  pipelineVersion: typeof BLOG_PIPELINE_V2_VERSION;
  planId: string;
  state: string;
  checkpoint: ProductionPipelineCheckpoint;
  cost?: unknown;
  outputSummary?: unknown;
  publishingHandoff?: string;
};

export type ProductionBlogPipelineInput = {
  planId: string;
  userId: string;
  businessId: string;
  pipelineVersion: typeof BLOG_PIPELINE_V2_VERSION;
  correlationId?: string;
  prisma?: PrismaClient;
  durableStep?: ProductionDurableStepRunner;
};

export type ProductionBlogPipelineResult = {
  success: true;
  blogId: string;
  alreadyExisted: boolean;
  pipelineVersion: typeof BLOG_PIPELINE_V2_VERSION;
  title: string | null;
  status: "PUBLISH";
  publishingHandoff: "unified-publishing-dispatch";
  cost: Awaited<ReturnType<ProductionPipelineUsageRecorder["summary"]>>;
};

function asCheckpoint(metadata: unknown): ProductionPipelineCheckpoint {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const checkpoint = (metadata as { checkpoint?: unknown }).checkpoint;
  return checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
    ? (checkpoint as ProductionPipelineCheckpoint)
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorFields(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code:
        "code" in error && typeof error.code === "string"
          ? error.code
          : error.name || "PRODUCTION_BLOG_PIPELINE_ERROR",
      message: error.message.slice(0, 4_000),
    };
  }
  return { code: "PRODUCTION_BLOG_PIPELINE_ERROR", message: String(error).slice(0, 4_000) };
}

async function checkpointRun(input: {
  prisma: PrismaClient;
  correlationId: string;
  planId: string;
  state: string;
  checkpoint: ProductionPipelineCheckpoint;
  cost?: unknown;
  outputSummary?: unknown;
  publishingHandoff?: string;
}): Promise<void> {
  const metadata: RunMetadata = {
    pipelineVersion: BLOG_PIPELINE_V2_VERSION,
    planId: input.planId,
    state: input.state,
    checkpoint: input.checkpoint,
    ...(input.cost ? { cost: input.cost } : {}),
    ...(input.outputSummary ? { outputSummary: input.outputSummary } : {}),
    ...(input.publishingHandoff
      ? { publishingHandoff: input.publishingHandoff }
      : {}),
  };
  await input.prisma.blogGenerationRun.update({
    where: { correlationId: input.correlationId },
    data: { metadata: json(metadata) },
  });
}

async function startPinnedRun(input: {
  prisma: PrismaClient;
  correlationId: string;
  planId: string;
  userId: string;
  businessId: string;
}): Promise<{
  checkpoint: ProductionPipelineCheckpoint;
  startedAtMs: number;
}> {
  const existing = await input.prisma.blogGenerationRun.findUnique({
    where: { correlationId: input.correlationId },
    select: { promptVersion: true, metadata: true, createdAt: true },
  });
  if (
    existing &&
    !BLOG_PIPELINE_V2_COMPATIBLE_PROMPT_VERSIONS.includes(
      existing.promptVersion as (typeof BLOG_PIPELINE_V2_COMPATIBLE_PROMPT_VERSIONS)[number],
    )
  ) {
    throw new Error(
      `Pinned run ${input.correlationId} belongs to ${existing.promptVersion}`,
    );
  }
  const checkpoint = asCheckpoint(existing?.metadata);
  const run = await input.prisma.blogGenerationRun.upsert({
    where: { correlationId: input.correlationId },
    create: {
      correlationId: input.correlationId,
      userId: input.userId,
      businessId: input.businessId,
      provider: "openai",
      model: BLOG_PIPELINE_V2_TEXT_MODEL,
      promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
      compilerVersion: BLOG_PIPELINE_V2_COMPILER_VERSION,
      status: "RUNNING",
      metadata: json({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        planId: input.planId,
        state: "started",
        checkpoint,
      }),
    },
    update: {
      provider: "openai",
      model: BLOG_PIPELINE_V2_TEXT_MODEL,
      promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      metadata: json({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        planId: input.planId,
        state: "resumed",
        checkpoint,
      }),
    },
    select: { createdAt: true },
  });
  return {
    checkpoint,
    startedAtMs: run.createdAt.getTime(),
  };
}

async function finishRun(input: {
  prisma: PrismaClient;
  correlationId: string;
  planId: string;
  blogId: string;
  title: string;
  sourceUrls: string[];
  cost: Awaited<ReturnType<ProductionPipelineUsageRecorder["summary"]>>;
  outputSummary: unknown;
  checkpoint: ProductionPipelineCheckpoint;
  durationMs: number;
}): Promise<void> {
  await input.prisma.blogGenerationRun.update({
    where: { correlationId: input.correlationId },
    data: {
      completedAt: new Date(),
      blogId: input.blogId,
      approvedTitle: input.title,
      approvedSeoTitle: input.title,
      sourceUrls: input.sourceUrls,
      inputTokens: input.cost.inputTokens,
      outputTokens: input.cost.outputTokens,
      totalTokens: input.cost.totalTokens,
      estimatedUsd: input.cost.totalUsd,
      validationFailures: json([]),
      repairCount: input.cost.failures,
      status: "ACCEPTED",
      finalSaveStatus: "PUBLISH_HANDOFF_READY",
      durationMs: input.durationMs,
      metadata: json({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        planId: input.planId,
        state: "complete",
        checkpoint: input.checkpoint,
        cost: input.cost,
        outputSummary: input.outputSummary,
        publishingHandoff: "unified-publishing-dispatch",
        directWordPressPublishing: false,
      }),
    },
  });
}

async function updateStoredCost(input: {
  prisma: PrismaClient;
  blogId: string;
  cost: unknown;
}): Promise<void> {
  const blog = await input.prisma.blog.findUnique({
    where: { id: input.blogId },
    select: { analytics: true },
  });
  const analytics =
    blog?.analytics && typeof blog.analytics === "object" && !Array.isArray(blog.analytics)
      ? (blog.analytics as Record<string, unknown>)
      : {};
  const productionPipeline =
    analytics.productionPipeline &&
    typeof analytics.productionPipeline === "object" &&
    !Array.isArray(analytics.productionPipeline)
      ? (analytics.productionPipeline as Record<string, unknown>)
      : {};
  await input.prisma.blog.update({
    where: { id: input.blogId },
    data: {
      analytics: json({
        ...analytics,
        productionPipeline: { ...productionPipeline, cost: input.cost },
      }),
    },
  });
}

export async function generateProductionV2Blog(
  input: ProductionBlogPipelineInput,
): Promise<ProductionBlogPipelineResult> {
  if (input.pipelineVersion !== BLOG_PIPELINE_V2_VERSION) {
    throw new Error(`generateProductionV2Blog requires ${BLOG_PIPELINE_V2_VERSION}`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  const correlationId =
    input.correlationId ?? `${BLOG_PIPELINE_V2_VERSION}:${input.planId}`;
  const durableStep = input.durableStep;
  const runState = await startPinnedRun({
    prisma,
    correlationId,
    planId: input.planId,
    userId: input.userId,
    businessId: input.businessId,
  });
  const startedAt = runState.startedAtMs;
  let checkpoint = runState.checkpoint;
  const recorder = new ProductionPipelineUsageRecorder(
    {
      correlationId,
      planId: input.planId,
      userId: input.userId,
      businessId: input.businessId,
    },
    prisma,
  );
  try {
    const context = await loadProductionBlogContext({ ...input, prisma });
    const blogImagesEnabled =
      checkpoint.blogImagesEnabled ?? context.business.blogImagesEnabled;
    checkpoint = { ...checkpoint, blogImagesEnabled };
    if (context.plan.blogId) {
      await recorder.attachBlog(context.plan.blogId);
      const existing = await prisma.blog.findUnique({
        where: { id: context.plan.blogId },
        select: {
          title: true,
          status: true,
          userId: true,
          businessId: true,
          analytics: true,
        },
      });
      if (
        !existing ||
        existing.status !== "PUBLISH" ||
        existing.userId !== input.userId ||
        existing.businessId !== input.businessId
      ) {
        throw new Error("Existing production-v2 Blog is not PUBLISH-ready");
      }
      const analytics =
        existing.analytics &&
        typeof existing.analytics === "object" &&
        !Array.isArray(existing.analytics)
          ? (existing.analytics as Record<string, unknown>)
          : {};
      const pipelineMetadata =
        analytics.productionPipeline &&
        typeof analytics.productionPipeline === "object" &&
        !Array.isArray(analytics.productionPipeline)
          ? (analytics.productionPipeline as Record<string, unknown>)
          : {};
      if (
        pipelineMetadata.version !== BLOG_PIPELINE_V2_VERSION ||
        pipelineMetadata.correlationId !== correlationId ||
        pipelineMetadata.planId !== input.planId
      ) {
        throw new Error("Existing Blog was not created by the pinned production-v2 run");
      }
      const approvedLinks = (checkpoint.links ?? []) as ProductionLinkCandidate[];
      await syncManagedBacklinksForPublishedBlog({
        blogId: context.plan.blogId,
        approvedManagedUrls: approvedLinks
          .filter((link) => link.kind === "managed_backlink")
          .map((link) => link.url),
      });
      const cost = await recorder.summary();
      const sourceUrls = checkpoint.research?.evidenceExcerpts.map(
        (item) => item.url,
      ) ?? [];
      await updateStoredCost({ prisma, blogId: context.plan.blogId, cost });
      await finishRun({
        prisma,
        correlationId,
        planId: input.planId,
        blogId: context.plan.blogId,
        title: existing.title,
        sourceUrls,
        cost,
        outputSummary: { resumedAfterPersistence: true },
        checkpoint,
        durationMs: Date.now() - startedAt,
      });
      return {
        success: true,
        blogId: context.plan.blogId,
        alreadyExisted: true,
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        title: existing?.title ?? null,
        status: "PUBLISH",
        publishingHandoff: "unified-publishing-dispatch",
        cost,
      };
    }

    let links = checkpoint.links
      ? filterProductionLinkCandidates({
          candidates: checkpoint.links,
          businessId: input.businessId,
          websiteUrl: context.business.businessWebsiteUrl,
          keyword: context.plan.keyword,
        })
      : undefined;
    if (checkpoint.links && links && links.length !== checkpoint.links.length) {
      checkpoint = { ...checkpoint, links };
      await checkpointRun({
        prisma,
        correlationId,
        planId: input.planId,
        state: "links_revalidated",
        checkpoint,
      });
    }
    if (!links) {
      links = await runProductionDurableStep(
        durableStep,
        "production-v2-select-links",
        async () => {
          const selected = await selectProductionBlogLinks({
            planId: input.planId,
            businessId: input.businessId,
            websiteUrl: context.business.businessWebsiteUrl,
            keyword: context.plan.keyword,
            preferredInternalCandidates: context.preferredInternalLinks,
            recorder,
            prisma,
          });
          await checkpointRun({
            prisma,
            correlationId,
            planId: input.planId,
            state: "links_complete",
            checkpoint: { ...checkpoint, links: selected },
          });
          return selected;
        },
      );
      checkpoint = { ...checkpoint, links };
    }

    let research = checkpoint.research;
    if (!research) {
      const location = researchLocationForContext({
        locale: context.locale,
        country: context.business.businessCountry,
        region: context.business.businessState,
        city: context.business.businessCity,
      });
      research = await runProductionDurableStep(
        durableStep,
        "production-v2-topic-research",
        async () => {
          const researched = await fetchRecoveryTopicSerpViaOpenAi({
            keyword: context.plan.keyword,
            location,
            model: BLOG_PIPELINE_V2_TEXT_MODEL,
            estimatedUsdPerCall: 0.04,
            client: recorder.trackingResponsesClient(),
          });
          await checkpointRun({
            prisma,
            correlationId,
            planId: input.planId,
            state: "research_complete",
            checkpoint: { ...checkpoint, research: researched },
          });
          return researched;
        },
      );
      checkpoint = { ...checkpoint, research };
    }

    let draft = checkpoint.draft;
    if (!draft) {
      draft = await writeProductionStagedV3Draft(
        {
          keyword: context.plan.keyword,
          articleTopic: context.plan.keyword,
          targetedInstructions: context.plan.keywordInstructions,
          businessName: context.business.businessName,
          websiteUrl: context.business.businessWebsiteUrl,
          locale: context.locale,
          publishDate: context.plan.publishDate,
          businessInformation: context.businessInformation,
          businessLocation: context.businessLocation,
          brandData: context.brandData,
          contentStrategy: context.contentStrategy,
          generateImages: blogImagesEnabled,
          writerModel: BLOG_PIPELINE_V2_TEXT_MODEL,
          recentBusinessTitles: context.recentBusinessTitles,
          linkCandidates: links.map((link) => ({
            kind: link.kind,
            title: link.title,
            url: link.url,
            businessId: link.businessId,
          })),
          researchEvidence: research.evidenceExcerpts.map((item) => ({
            url: item.url,
            title: item.title,
            excerpt: item.excerpt,
            authority: item.authority,
          })),
          serpContext: research.analysis,
          idempotencyKey: correlationId,
        },
        recorder.trackingResponsesClient(),
        durableStep,
      );
      checkpoint = { ...checkpoint, draft };
      await runProductionDurableStep(
        durableStep,
        "production-v2-checkpoint-editorial",
        async () => {
          await checkpointRun({
            prisma,
            correlationId,
            planId: input.planId,
            state: "editorial_complete",
            checkpoint,
          });
          return { checkpointed: true };
        },
      );
    }

    let images: ProductionBlogImage[] = [];
    let contentWithImages = draft.content;
    if (blogImagesEnabled) {
      const accumulatedImages = [...(checkpoint.images ?? [])];
      images = await generateProductionBlogImages({
        planId: input.planId,
        title: draft.title,
        keyword: context.plan.keyword,
        businessName: context.business.businessName,
        locale: context.locale,
        content: draft.content,
        editorialBriefs: draft.imageBriefs,
        recorder,
        existing: checkpoint.images,
        durableStep,
        onImage: async (image) => {
          const index = accumulatedImages.findIndex(
            (item) => item.role === image.role,
          );
          if (index >= 0) accumulatedImages[index] = image;
          else accumulatedImages.push(image);
          checkpoint = { ...checkpoint, images: [...accumulatedImages] };
          await checkpointRun({
            prisma,
            correlationId,
            planId: input.planId,
            state: `image_${image.role}_complete`,
            checkpoint,
          });
        },
      });
      contentWithImages = insertProductionInternalImages(draft.content, images);
    }
    checkpoint = { ...checkpoint, images };
    const outputSummary = {
      mode: "prompt-first",
      blogImagesEnabled,
      generatedImageCount: images.length,
      postGenerationEditorialValidation: false,
      wordCount: stagedVisibleWordCount(contentWithImages),
    };
    return await runProductionDurableStep(
      durableStep,
      "production-v2-persist",
      async () => {
        const preImportCost = await recorder.summary();
        await checkpointRun({
          prisma,
          correlationId,
          planId: input.planId,
          state: "content_ready",
          checkpoint,
          cost: preImportCost,
          outputSummary,
        });
        const persisted = await persistProductionBlog(
          {
            planId: input.planId,
            userId: input.userId,
            businessId: input.businessId,
            correlationId,
            title: draft.title,
            slug: draft.slug,
            excerpt: draft.excerpt,
            content: contentWithImages,
            keyword: context.plan.keyword,
            locale: context.locale,
            featuredMedia:
              images.find((image) => image.role === "featured")?.url ?? "",
            images,
            links,
            sourceUrls: research.evidenceExcerpts.map((item) => item.url),
            titleStrategy: draft.titlePlaybookStrategy,
            cost: preImportCost,
            wordCount: outputSummary.wordCount,
            contentQualityScore: draft.contentQualityScore!,
            contentStrategy: context.contentStrategy,
          },
          prisma,
        );
        await recorder.attachBlog(persisted.blogId);
        const cost = await recorder.summary();
        await updateStoredCost({ prisma, blogId: persisted.blogId, cost });
        await finishRun({
          prisma,
          correlationId,
          planId: input.planId,
          blogId: persisted.blogId,
          title: draft.title,
          sourceUrls: research.evidenceExcerpts.map((item) => item.url),
          cost,
          outputSummary,
          checkpoint,
          durationMs: Date.now() - startedAt,
        });
        return {
          success: true as const,
          blogId: persisted.blogId,
          alreadyExisted: persisted.alreadyExisted,
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          title: draft.title,
          status: "PUBLISH" as const,
          publishingHandoff: "unified-publishing-dispatch" as const,
          cost,
        };
      },
    );
  } catch (error) {
    const cost = await recorder.summary().catch(() => null);
    const details = errorFields(error);
    await prisma.blogGenerationRun.update({
      where: { correlationId },
      data: {
        completedAt: new Date(),
        status: "FAILED",
        finalSaveStatus: "FAILED",
        durationMs: Date.now() - startedAt,
        errorCode: details.code,
        errorMessage: details.message,
        estimatedUsd: cost?.totalUsd,
        inputTokens: cost?.inputTokens,
        outputTokens: cost?.outputTokens,
        totalTokens: cost?.totalTokens,
        metadata: json({
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          planId: input.planId,
          state: "failed",
          checkpoint,
          cost,
          directWordPressPublishing: false,
        }),
      },
    });
    throw error;
  }
}
