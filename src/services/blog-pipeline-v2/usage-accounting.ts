import type { Prisma, PrismaClient } from "@prisma/client";
import OpenAI from "openai";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  BLOG_PIPELINE_V2_TEXT_MODEL,
  BLOG_PIPELINE_V2_VERSION,
} from "./constants";
import type { ResponsesClient } from "./direct-writer";

export type PipelineUsageStage =
  | "topic_research"
  | "research"
  | "angle"
  | "outline"
  | "article"
  | "seo_package"
  | "title_repair"
  | "length_repair"
  | "embedding"
  | "featured_image"
  | "internal_image_1"
  | "internal_image_2";

export type PipelineUsageContext = {
  correlationId: string;
  planId: string;
  userId: string;
  businessId: string;
  blogId?: string | null;
};

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

function finiteInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function tokenUsage(response: any): TokenUsage {
  const usage = response?.usage ?? {};
  const inputDetails = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};
  const inputTokens = finiteInteger(usage.input_tokens);
  const outputTokens = finiteInteger(usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: finiteInteger(inputDetails.cached_tokens),
    outputTokens,
    reasoningTokens: finiteInteger(outputDetails.reasoning_tokens),
    totalTokens: finiteInteger(usage.total_tokens || inputTokens + outputTokens),
  };
}

function configuredNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function estimateGpt5MiniUsageUsd(usage: TokenUsage): number {
  return estimateBlogPipelineTextUsageUsd("gpt-5-mini", usage);
}

export function estimateBlogPipelineTextUsageUsd(
  model: string,
  usage: TokenUsage,
): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const isLuna = model.trim().toLowerCase().includes("gpt-5.6-luna");
  const inputRate = isLuna
    ? configuredNumber("BLOG_PIPELINE_V2_GPT56_LUNA_INPUT_USD_PER_1M", 0.2)
    : configuredNumber("BLOG_PIPELINE_V2_GPT5_MINI_INPUT_USD_PER_1M", 0.25);
  const cachedRate = isLuna
    ? configuredNumber(
        "BLOG_PIPELINE_V2_GPT56_LUNA_CACHED_INPUT_USD_PER_1M",
        0.02,
      )
    : configuredNumber(
        "BLOG_PIPELINE_V2_GPT5_MINI_CACHED_INPUT_USD_PER_1M",
        0.025,
      );
  const outputRate = isLuna
    ? configuredNumber("BLOG_PIPELINE_V2_GPT56_LUNA_OUTPUT_USD_PER_1M", 1.2)
    : configuredNumber("BLOG_PIPELINE_V2_GPT5_MINI_OUTPUT_USD_PER_1M", 2);
  return (
    (uncachedInput * inputRate +
      usage.cachedInputTokens * cachedRate +
      usage.outputTokens * outputRate) /
    1_000_000
  );
}

function responseStage(request: Record<string, unknown>): PipelineUsageStage {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  if (tools.some((tool: any) => tool?.type === "web_search")) {
    return "topic_research";
  }
  const text = request.text as { format?: { name?: string } } | undefined;
  const schema = text?.format?.name ?? "";
  if (schema.includes("title_repair")) return "title_repair";
  if (schema.includes("length_repair")) return "length_repair";
  if (schema.includes("seo_package")) return "seo_package";
  if (schema.includes("research")) return "research";
  if (schema.includes("angle")) return "angle";
  if (schema.includes("outline")) return "outline";
  if (schema.includes("article")) return "article";
  return "article";
}

function webSearchActions(response: any): number {
  return (Array.isArray(response?.output) ? response.output : []).filter(
    (item: any) => item?.type === "web_search_call",
  ).length;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class ProductionPipelineUsageRecorder {
  private readonly attempts = new Map<PipelineUsageStage, number>();

  constructor(
    readonly context: PipelineUsageContext,
    private readonly prisma: PrismaClient = defaultPrisma,
  ) {}

  private nextAttempt(stage: PipelineUsageStage): number {
    const next = (this.attempts.get(stage) ?? 0) + 1;
    this.attempts.set(stage, next);
    return next;
  }

  async recordResponse(input: {
    stage: PipelineUsageStage;
    model: string;
    response: any;
    attempt: number;
  }): Promise<void> {
    const responseId = String(input.response?.id ?? "").trim();
    if (!responseId) {
      throw new Error(`Provider response ID missing for ${input.stage}`);
    }
    const eventCorrelationId = `${this.context.correlationId}:${input.stage}:${responseId}`;
    const existing = await this.prisma.llmUsageEvent.findFirst({
      where: {
        correlationId: eventCorrelationId,
        provider: "openai",
        model: input.model,
      },
      select: { id: true },
    });
    if (existing) return;

    const usage = tokenUsage(input.response);
    const searchActions = webSearchActions(input.response);
    const searchCost =
      searchActions *
      configuredNumber("BLOG_PIPELINE_V2_WEB_SEARCH_USD_PER_CALL", 0.01);
    const textEstimatedUsd = estimateBlogPipelineTextUsageUsd(
      input.model,
      usage,
    );
    const estimatedUsd = textEstimatedUsd + searchCost;
    await this.prisma.llmUsageEvent.create({
      data: {
        userId: this.context.userId,
        businessId: this.context.businessId,
        blogId: this.context.blogId ?? null,
        correlationId: eventCorrelationId,
        purpose: "blog_keyword_pipeline",
        provider: "openai",
        model: input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedUsd,
        pricingSchemaVersion: 8,
        metadata: json({
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          rootCorrelationId: this.context.correlationId,
          planId: this.context.planId,
          stage: input.stage,
          providerResponseId: responseId,
          attempt: input.attempt,
          outcome: "completed",
          finalOutcome: "completed",
          retry: Math.max(0, input.attempt - 1),
          cachedInputTokens: usage.cachedInputTokens,
          reasoningTokens: usage.reasoningTokens,
          webSearchCalls: searchActions,
          textEstimatedUsd,
          webSearchEstimatedUsd: searchCost,
        }),
      },
    });
  }

  async recordFailure(input: {
    stage: PipelineUsageStage;
    provider: string;
    model: string;
    attempt: number;
    error: unknown;
  }): Promise<void> {
    const message =
      input.error instanceof Error ? input.error.message : String(input.error);
    await this.prisma.llmUsageEvent.create({
      data: {
        userId: this.context.userId,
        businessId: this.context.businessId,
        blogId: this.context.blogId ?? null,
        correlationId: `${this.context.correlationId}:${input.stage}:failed:${Date.now()}:${input.attempt}`,
        purpose: "blog_keyword_pipeline",
        provider: input.provider,
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedUsd: 0,
        pricingSchemaVersion: 8,
        metadata: json({
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          rootCorrelationId: this.context.correlationId,
          planId: this.context.planId,
          stage: input.stage,
          attempt: input.attempt,
          outcome: "failed",
          finalOutcome: "failed",
          retry: Math.max(0, input.attempt - 1),
          error: message.slice(0, 2_000),
        }),
      },
    });
  }

  async recordFixedCost(input: {
    stage: PipelineUsageStage;
    provider: string;
    model: string;
    responseId: string;
    estimatedUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const attempt = this.nextAttempt(input.stage);
    const eventCorrelationId = `${this.context.correlationId}:${input.stage}:${input.responseId}`;
    const existing = await this.prisma.llmUsageEvent.findFirst({
      where: { correlationId: eventCorrelationId },
      select: { id: true },
    });
    if (existing) return;
    await this.prisma.llmUsageEvent.create({
      data: {
        userId: this.context.userId,
        businessId: this.context.businessId,
        blogId: this.context.blogId ?? null,
        correlationId: eventCorrelationId,
        purpose: "blog_keyword_pipeline",
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        totalTokens: input.totalTokens ?? 0,
        estimatedUsd: input.estimatedUsd,
        pricingSchemaVersion: 8,
        metadata: json({
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          rootCorrelationId: this.context.correlationId,
          planId: this.context.planId,
          stage: input.stage,
          providerResponseId: input.responseId,
          attempt,
          outcome: "completed",
          finalOutcome: "completed",
          ...(input.metadata ?? {}),
        }),
      },
    });
  }

  trackingResponsesClient(
    client: OpenAI = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
    }),
  ): ResponsesClient {
    return {
      responses: {
        create: async (request, options) => {
          const stage = responseStage(request);
          const attempt = this.nextAttempt(stage);
          try {
            const response = await client.responses.create(
              request as any,
              (options ?? {
                idempotencyKey: `${this.context.correlationId}:${stage}`,
              }) as any,
            );
            await this.recordResponse({
              stage,
              model: String(request.model ?? BLOG_PIPELINE_V2_TEXT_MODEL),
              response,
              attempt,
            });
            return response;
          } catch (error) {
            await this.recordFailure({
              stage,
              provider: "openai",
              model: String(request.model ?? BLOG_PIPELINE_V2_TEXT_MODEL),
              attempt,
              error,
            });
            throw error;
          }
        },
      },
    };
  }

  async attachBlog(blogId: string): Promise<void> {
    this.context.blogId = blogId;
    await this.prisma.llmUsageEvent.updateMany({
      where: {
        businessId: this.context.businessId,
        correlationId: { startsWith: `${this.context.correlationId}:` },
        blogId: null,
      },
      data: { blogId },
    });
  }

  async summary(): Promise<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    textUsd: number;
    webSearchUsd: number;
    imageUsd: number;
    embeddingUsd: number;
    totalUsd: number;
    attempts: number;
    failures: number;
  }> {
    const rows = await this.prisma.llmUsageEvent.findMany({
      where: {
        businessId: this.context.businessId,
        correlationId: { startsWith: `${this.context.correlationId}:` },
      },
      select: {
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        estimatedUsd: true,
        metadata: true,
      },
    });
    let textUsd = 0;
    let webSearchUsd = 0;
    let imageUsd = 0;
    let embeddingUsd = 0;
    let failures = 0;
    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      textUsd += Number(metadata.textEstimatedUsd ?? 0);
      webSearchUsd += Number(metadata.webSearchEstimatedUsd ?? 0);
      if (metadata.kind === "image") imageUsd += Number(row.estimatedUsd ?? 0);
      if (metadata.kind === "embedding") {
        embeddingUsd += Number(row.estimatedUsd ?? 0);
      }
      if (metadata.outcome === "failed") failures += 1;
    }
    return {
      inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
      textUsd,
      webSearchUsd,
      imageUsd,
      embeddingUsd,
      totalUsd: rows.reduce(
        (sum, row) => sum + Number(row.estimatedUsd ?? 0),
        0,
      ),
      attempts: rows.length,
      failures,
    };
  }
}
