import { createHash } from "node:crypto";

import {
  SOCIAL_CREATIVE_MAX_IMAGE_REFERENCES,
  SOCIAL_CREATIVE_IMAGE_MODEL,
  SOCIAL_CREATIVE_IMAGE_PRICING_VERSION,
  socialCreativeImageCostUsd,
  socialCreativeImageTimeoutMs,
  socialCreativeImageUsageCostUsd,
} from "./constants";
import type {
  SocialCreativeImageReference,
  SocialCreativeImageResult,
  SocialCreativePreferredImageSize,
  SocialCreativeProviderImageSize,
} from "./types";
import { fetchPublicResource } from "./safe-fetch";

export class SocialCreativeProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SocialCreativeProviderError";
  }
}

type ImageUsagePayload = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens_details?: { image_tokens?: number; text_tokens?: number };
};

type ImageResponsePayload = {
  data?: Array<{ b64_json?: string; url?: string }>;
  usage?: ImageUsagePayload;
  output_format?: string;
  quality?: string;
  size?: string;
};

type LoadedReferenceImage = {
  buffer: Buffer;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

function referenceExtension(
  mimeType: LoadedReferenceImage["mimeType"],
): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function loadReferenceImages(
  references: SocialCreativeImageReference[],
  fetchReference: (url: string) => Promise<{
    buffer: Buffer;
    contentType: string;
  }>,
): Promise<LoadedReferenceImage[]> {
  const loaded: LoadedReferenceImage[] = [];
  for (const [index, reference] of references
    .slice(0, SOCIAL_CREATIVE_MAX_IMAGE_REFERENCES)
    .entries()) {
    try {
      const resource = await fetchReference(reference.url);
      const metadata = readProviderImageMetadata(resource.buffer);
      if (metadata.mimeType !== resource.contentType) continue;
      loaded.push({
        buffer: resource.buffer,
        filename: `${reference.role}-${index + 1}.${referenceExtension(metadata.mimeType)}`,
        mimeType: metadata.mimeType,
      });
    } catch (error) {
      // A missing or unsupported legacy asset must not prevent social
      // generation. The prompt still carries the stored palette/typography,
      // while valid references continue through the high-fidelity edit path.
      console.warn("[social-creative] brand reference unavailable", {
        role: reference.role,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return loaded;
}

function finiteToken(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function readJpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function readWebpDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (
    buffer.length < 25 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 > buffer.length
  ) {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21] ?? 0;
    const b2 = buffer[22] ?? 0;
    const b3 = buffer[23] ?? 0;
    const b4 = buffer[24] ?? 0;
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (
    chunk === "VP8 " &&
    buffer.length >= 30 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function readProviderImageMetadata(buffer: Buffer): {
  format: "png" | "jpeg" | "webp";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
} {
  if (
    buffer.length >= 24 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return {
      format: "png",
      mimeType: "image/png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const dimensions = readJpegDimensions(buffer);
    if (dimensions) {
      return { format: "jpeg", mimeType: "image/jpeg", ...dimensions };
    }
  }
  const webpDimensions = readWebpDimensions(buffer);
  if (webpDimensions) {
    return {
      format: "webp",
      mimeType: "image/webp",
      ...webpDimensions,
    };
  }
  throw new SocialCreativeProviderError(
    "OpenAI website campaign response was not a supported PNG, JPEG, or WebP image",
    502,
    true,
  );
}

/**
 * Execute the proven Studio websiteCampaign request contract.
 *
 * Uses the Image API generation endpoint for legacy/text-only runs and the
 * edits endpoint when a validated canonical brand image is available. GPT
 * Image 2 processes edit inputs at high fidelity, so input_fidelity is omitted.
 * The returned buffer remains the original decoded provider response.
 */
export async function generateWebsiteCampaignImage(
  input: {
    prompt: string;
    targetSize: SocialCreativePreferredImageSize;
    idempotencyKey: string;
    references?: SocialCreativeImageReference[];
  },
  dependencies: {
    fetchImpl?: typeof fetch;
    fetchReference?: (url: string) => Promise<{
      buffer: Buffer;
      contentType: string;
    }>;
  } = {},
): Promise<SocialCreativeImageResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for website campaign images");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    socialCreativeImageTimeoutMs(),
  );
  const loadedReferences = await loadReferenceImages(
    input.references ?? [],
    dependencies.fetchReference ??
      (async (url) => {
        const resource = await fetchPublicResource(url, {
          maxBytes: 5 * 1024 * 1024,
          allowedContentTypes: ["image/png", "image/jpeg", "image/webp"],
        });
        return { buffer: resource.buffer, contentType: resource.contentType };
      }),
  );
  const requestMode = loadedReferences.length
    ? ("reference-edit" as const)
    : ("generation" as const);
  let response: Response;
  try {
    const body = loadedReferences.length
      ? (() => {
          const form = new FormData();
          form.set("model", SOCIAL_CREATIVE_IMAGE_MODEL);
          form.set("prompt", input.prompt);
          form.set("size", input.targetSize);
          for (const reference of loadedReferences) {
            form.append(
              "image[]",
              new Blob([new Uint8Array(reference.buffer)], {
                type: reference.mimeType,
              }),
              reference.filename,
            );
          }
          return form;
        })()
      : JSON.stringify({
          model: SOCIAL_CREATIVE_IMAGE_MODEL,
          prompt: input.prompt,
          size: input.targetSize,
        });
    response = await fetchImpl(
      loadedReferences.length
        ? "https://api.openai.com/v1/images/edits"
        : "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...(loadedReferences.length
            ? {}
            : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": input.idempotencyKey,
        },
        body,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SocialCreativeProviderError(
      `OpenAI website campaign request failed: ${message}`,
      0,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }

  const requestId = response.headers.get("x-request-id")?.trim() ?? "";
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    throw new SocialCreativeProviderError(
      `OpenAI website campaign generation failed (${response.status}): ${body.slice(0, 500)}`,
      response.status,
      retryable,
    );
  }

  const payload = (await response.json()) as ImageResponsePayload;
  const image = payload.data?.[0];
  if (!image?.b64_json) {
    throw new SocialCreativeProviderError(
      "OpenAI website campaign response contained no image",
      502,
      true,
    );
  }
  const buffer = Buffer.from(image.b64_json, "base64");
  if (!buffer.length) {
    throw new SocialCreativeProviderError(
      "OpenAI website campaign response decoded to an empty buffer",
      502,
      true,
    );
  }

  const decoded = readProviderImageMetadata(buffer);

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const usagePayload = payload.usage;
  const usage = usagePayload
    ? {
        inputTokens: finiteToken(usagePayload.input_tokens),
        inputTextTokens: finiteToken(
          usagePayload.input_tokens_details?.text_tokens,
        ),
        inputImageTokens: finiteToken(
          usagePayload.input_tokens_details?.image_tokens,
        ),
        outputTokens: finiteToken(usagePayload.output_tokens),
        outputImageTokens: finiteToken(
          usagePayload.output_tokens_details?.image_tokens ??
            usagePayload.output_tokens,
        ),
        totalTokens: finiteToken(usagePayload.total_tokens),
      }
    : null;
  const usageCostUsd = usage
    ? socialCreativeImageUsageCostUsd({
        inputTextTokens: usage.inputTextTokens,
        inputImageTokens: usage.inputImageTokens,
        outputImageTokens: usage.outputImageTokens,
      })
    : null;
  const outputFormat = String(payload.output_format || decoded.format);
  const sourceSize =
    `${decoded.width}x${decoded.height}` as SocialCreativeProviderImageSize;
  if (sourceSize !== input.targetSize) {
    throw new SocialCreativeProviderError(
      `OpenAI website campaign returned ${sourceSize}; expected ${input.targetSize}`,
      502,
      true,
    );
  }

  return {
    buffer,
    model: SOCIAL_CREATIVE_IMAGE_MODEL,
    quality: payload.quality || null,
    sourceSize,
    providerRequestId: requestId || `image-${sha256}`,
    sha256,
    estimatedUsd: usageCostUsd ?? socialCreativeImageCostUsd(input.targetSize),
    actualUsd: usageCostUsd,
    pricingVersion: SOCIAL_CREATIVE_IMAGE_PRICING_VERSION,
    usage,
    requested: {
      quality: null,
      sourceSize: input.targetSize,
      targetSize: input.targetSize,
      outputFormat: null,
      ...(requestMode === "reference-edit"
        ? {
            requestMode,
            referenceImageCount: loadedReferences.length,
          }
        : {}),
    },
    returned: {
      outputFormat,
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
      source: "base64",
    },
  };
}

// Temporary compatibility export for already-enqueued jobs and older tests.
// It deliberately points at the direct template-free implementation.
export const generateSocialCreativeBackground = generateWebsiteCampaignImage;
