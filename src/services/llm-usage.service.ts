import type { LlmUsagePurpose, Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";

export const LLM_USAGE_PRICING_SCHEMA_VERSION: number = 8;

export const GEMINI_25_FLASH_IMAGE_MODEL = "gemini-2.5-flash-image";
export const GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE = 1290;
export const GEMINI_25_FLASH_IMAGE_USD_PER_IMAGE = 0.039;

type ModelRate = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

const MODEL_RATES_USD_PER_1M: Record<string, ModelRate> = {
  "gpt-5-mini": { inputUsdPer1M: 0.25, outputUsdPer1M: 2.0 },
  "gpt-5-mini-2025-08-07": { inputUsdPer1M: 0.25, outputUsdPer1M: 2.0 },
  "gpt-5.6-luna": { inputUsdPer1M: 0.2, outputUsdPer1M: 1.2 },
  "gpt-5.4-mini": { inputUsdPer1M: 0.75, outputUsdPer1M: 4.5 },
  "gpt-5.4-nano": { inputUsdPer1M: 0.05, outputUsdPer1M: 0.4 },
  "gpt-5": { inputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gpt-5-2025-08-07": { inputUsdPer1M: 1.25, outputUsdPer1M: 10.0 },
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "claude-3-5-haiku-20241022": { inputUsdPer1M: 0.8, outputUsdPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "claude-haiku-4-5": { inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
  "claude-haiku-4-5-20251001": { inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
  "claude-sonnet-4-5": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "claude-sonnet-4-5-20250929": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "gemini-2.5-flash": { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  [GEMINI_25_FLASH_IMAGE_MODEL]: { inputUsdPer1M: 0.3, outputUsdPer1M: 30.0 },
  "qwen/qwen3.7-plus": { inputUsdPer1M: 0.32, outputUsdPer1M: 1.28 },
  "meta-llama/llama-3.3-70b-instruct-turbo": {
    inputUsdPer1M: 1.04,
    outputUsdPer1M: 1.04,
  },
  "openai/gpt-oss-120b": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "minimaxai/minimax-m3": { inputUsdPer1M: 0.3, outputUsdPer1M: 1.2 },
  "deepseek-ai/deepseek-v4-pro": {
    inputUsdPer1M: 1.74,
    outputUsdPer1M: 3.48,
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    inputUsdPer1M: 0.6,
    outputUsdPer1M: 3.6,
  },
  default: { inputUsdPer1M: 1.0, outputUsdPer1M: 4.0 },
};

function normalizeModelKey(model: string): string {
  const m: string = model.trim().toLowerCase();
  if (MODEL_RATES_USD_PER_1M[m] !== undefined) {
    return m;
  }
  for (const key of Object.keys(MODEL_RATES_USD_PER_1M)) {
    if (key === "default") continue;
    if (m.includes(key)) {
      return key;
    }
  }
  return "default";
}

export function estimateUsdFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key: string = normalizeModelKey(model);
  const rate: ModelRate =
    MODEL_RATES_USD_PER_1M[key] ?? MODEL_RATES_USD_PER_1M["default"]!;
  const inCost: number = (inputTokens / 1_000_000) * rate.inputUsdPer1M;
  const outCost: number = (outputTokens / 1_000_000) * rate.outputUsdPer1M;
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}

export function estimateUsdFromStoredUsage(input: {
  model: string;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  estimatedUsd?: number | string | null | undefined;
}): number | null {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;

  if (inputTokens > 0 || outputTokens > 0) {
    return estimateUsdFromTokens(input.model, inputTokens, outputTokens);
  }

  if (typeof input.estimatedUsd === "number") {
    return input.estimatedUsd;
  }

  if (typeof input.estimatedUsd === "string" && input.estimatedUsd !== "") {
    const parsed = Number(input.estimatedUsd);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

type LcMessageLike = {
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  response_metadata?: Record<string, unknown>;
};

type NormalizedTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function numberFromRecord(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractUsageFromResponseMetadata(
  metadata: Record<string, unknown> | undefined,
): NormalizedTokenUsage {
  if (!metadata) {
    return {};
  }

  const tokenUsage = asRecord(metadata["tokenUsage"]);
  const usage = asRecord(metadata["usage"]);
  const usageMetadata = asRecord(metadata["usage_metadata"]);

  return {
    inputTokens:
      numberFromRecord(tokenUsage, ["promptTokens", "prompt_tokens"]) ??
      numberFromRecord(usage, ["prompt_tokens", "input_tokens"]) ??
      numberFromRecord(usageMetadata, ["input_tokens", "prompt_tokens"]) ??
      numberFromRecord(metadata, ["promptTokens", "prompt_tokens", "input_tokens"]),
    outputTokens:
      numberFromRecord(tokenUsage, ["completionTokens", "completion_tokens"]) ??
      numberFromRecord(usage, ["completion_tokens", "output_tokens"]) ??
      numberFromRecord(usageMetadata, ["output_tokens", "completion_tokens"]) ??
      numberFromRecord(metadata, [
        "completionTokens",
        "completion_tokens",
        "output_tokens",
      ]),
    totalTokens:
      numberFromRecord(tokenUsage, ["totalTokens", "total_tokens"]) ??
      numberFromRecord(usage, ["total_tokens"]) ??
      numberFromRecord(usageMetadata, ["total_tokens"]) ??
      numberFromRecord(metadata, ["totalTokens", "total_tokens"]),
  };
}

export function sumUsageFromLcMessages(
  messages: unknown[],
): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  model: string;
} {
  let inputSum = 0;
  let outputSum = 0;
  let totalSum = 0;
  let hasAny = false;
  let model = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const m = raw as LcMessageLike;
    const um = m.usage_metadata;
    const rm = m.response_metadata;
    const metadataUsage = extractUsageFromResponseMetadata(rm);
    const inputTokens =
      typeof um?.input_tokens === "number"
        ? um.input_tokens
        : metadataUsage.inputTokens;
    const outputTokens =
      typeof um?.output_tokens === "number"
        ? um.output_tokens
        : metadataUsage.outputTokens;
    const totalTokens =
      typeof um?.total_tokens === "number"
        ? um.total_tokens
        : metadataUsage.totalTokens;
    if (inputTokens !== undefined) {
      inputSum += inputTokens;
      hasAny = true;
    }
    if (outputTokens !== undefined) {
      outputSum += outputTokens;
      hasAny = true;
    }
    if (totalTokens !== undefined) {
      totalSum += totalTokens;
      hasAny = true;
    }
    if (rm && typeof rm["model_name"] === "string") {
      model = rm["model_name"] as string;
    }
    if (rm && typeof rm["model"] === "string" && model === "") {
      model = rm["model"] as string;
    }
  }

  if (!hasAny) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: totalSum > 0 ? totalSum : null,
      model: model || "unknown",
    };
  }

  return {
    inputTokens: inputSum,
    outputTokens: outputSum,
    totalTokens: totalSum > 0 ? totalSum : inputSum + outputSum,
    model: model || "unknown",
  };
}

type ExtractedLcUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  model: string;
};

function extractFromSingleLcResponse(response: unknown): ExtractedLcUsage {
  if (!response || typeof response !== "object") {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      model: "unknown",
    };
  }
  const r = response as LcMessageLike & {
    response_metadata?: Record<string, unknown>;
  };
  const um = r.usage_metadata;
  let model = "";
  const meta = r.response_metadata;
  const metadataUsage = extractUsageFromResponseMetadata(meta);
  const inputTokens =
    typeof um?.input_tokens === "number"
      ? um.input_tokens
      : metadataUsage.inputTokens ?? null;
  const outputTokens =
    typeof um?.output_tokens === "number"
      ? um.output_tokens
      : metadataUsage.outputTokens ?? null;
  const totalTokens =
    typeof um?.total_tokens === "number"
      ? um.total_tokens
      : metadataUsage.totalTokens ?? null;
  if (meta && typeof meta["model_name"] === "string") {
    model = meta["model_name"] as string;
  }
  if (model === "" && meta && typeof meta["model"] === "string") {
    model = meta["model"] as string;
  }
  const tu = meta?.tokenUsage as
    | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | undefined;
  if (inputTokens === null && tu?.promptTokens !== undefined) {
    return {
      inputTokens: tu.promptTokens,
      outputTokens: tu.completionTokens ?? null,
      totalTokens: tu.totalTokens ?? null,
      model: model || "unknown",
    };
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    model: model || "unknown",
  };
}

export type RecordLlmUsageInput = {
  purpose: LlmUsagePurpose;
  provider: string;
  model: string;
  userId?: string | null;
  businessId?: string | null;
  blogId?: string | null;
  correlationId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  metadata?: Record<string, unknown> | null;
};

export async function recordLlmUsageEvent(
  input: RecordLlmUsageInput,
): Promise<void> {
  const inT: number = input.inputTokens ?? 0;
  const outT: number = input.outputTokens ?? 0;
  const estimated: number | null =
    inT > 0 || outT > 0
      ? estimateUsdFromTokens(input.model, inT, outT)
      : null;

  try {
    await prisma.llmUsageEvent.create({
      data: {
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        userId: input.userId ?? undefined,
        businessId: input.businessId ?? undefined,
        blogId: input.blogId ?? undefined,
        correlationId: input.correlationId ?? undefined,
        inputTokens: input.inputTokens ?? undefined,
        outputTokens: input.outputTokens ?? undefined,
        totalTokens: input.totalTokens ?? undefined,
        estimatedUsd: estimated ?? undefined,
        pricingSchemaVersion: LLM_USAGE_PRICING_SCHEMA_VERSION,
        metadata:
          (input.metadata as Prisma.InputJsonValue | null | undefined) ??
          undefined,
      },
    });
  } catch (e) {
    console.error("[llm-usage] failed to persist event", e);
  }
}

type GoogleUsageMetadataLike = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

function extractGoogleUsageMetadata(
  usageMetadata: unknown,
): GoogleUsageMetadataLike | null {
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return null;
  }
  const raw = usageMetadata as Record<string, unknown>;
  return {
    promptTokenCount:
      typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : undefined,
    candidatesTokenCount:
      typeof raw.candidatesTokenCount === "number"
        ? raw.candidatesTokenCount
        : undefined,
    totalTokenCount:
      typeof raw.totalTokenCount === "number" ? raw.totalTokenCount : undefined,
  };
}

export async function recordGeminiImageUsageEvent(input: {
  userId?: string | null;
  businessId?: string | null;
  blogId?: string | null;
  correlationId?: string | null;
  purpose?: LlmUsagePurpose;
  imageCount: number;
  query?: string | null;
  referenceImageUsed?: boolean;
  usageMetadata?: unknown;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const imageCount = Math.max(0, Math.floor(input.imageCount));
  if (imageCount <= 0) {
    return;
  }

  const googleUsage = extractGoogleUsageMetadata(input.usageMetadata);
  const inputTokens = googleUsage?.promptTokenCount ?? null;
  const outputTokens = imageCount * GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE;

  await recordLlmUsageEvent({
    purpose: input.purpose ?? "other",
    provider: "google",
    model: GEMINI_25_FLASH_IMAGE_MODEL,
    userId: input.userId ?? null,
    businessId: input.businessId ?? null,
    blogId: input.blogId ?? null,
    correlationId: input.correlationId ?? null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null ? inputTokens + outputTokens : outputTokens,
    metadata: {
      ...(input.metadata ?? {}),
      usageType: "blog_image_generation",
      imageCount,
      query: input.query?.substring(0, 500) ?? null,
      referenceImageUsed: Boolean(input.referenceImageUsed),
      imageOutputTokensPerImage: GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE,
      estimatedUsdPerImage: GEMINI_25_FLASH_IMAGE_USD_PER_IMAGE,
      googleUsageMetadata: googleUsage,
    },
  });
}

export async function recordLlmUsageFromLangChainMessage(
  response: unknown,
  args: Omit<RecordLlmUsageInput, "model" | "inputTokens" | "outputTokens" | "totalTokens"> & {
    modelFallback?: string;
  },
): Promise<void> {
  const u = extractFromSingleLcResponse(response);
  const model: string =
    u.model !== "unknown" ? u.model : args.modelFallback ?? "unknown";
  await recordLlmUsageEvent({
    ...args,
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
  });
}

export async function recordLlmUsageFromLangChainMessages(
  messages: unknown[],
  args: Omit<RecordLlmUsageInput, "model" | "inputTokens" | "outputTokens" | "totalTokens"> & {
    modelFallback?: string;
  },
): Promise<void> {
  const u = sumUsageFromLcMessages(messages);
  const model: string =
    u.model !== "unknown" ? u.model : args.modelFallback ?? "unknown";
  await recordLlmUsageEvent({
    ...args,
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
  });
}
