import { createHash } from "node:crypto";

import {
  BLOG_PIPELINE_V2_IMAGE_MODEL,
  BLOG_PIPELINE_V2_IMAGE_QUALITY,
  BLOG_PIPELINE_V2_IMAGE_SIZE,
} from "./blog-pipeline-v2/constants";
import {
  type ImageUploadReceipt,
  uploadImageBufferWithMetadata,
} from "../lib/image-storage";

export type RecoveryOpenAiImage = {
  imageUrl: string;
  altText: string;
  source: "openai";
  width: 1536;
  height: 1024;
  model: typeof BLOG_PIPELINE_V2_IMAGE_MODEL;
  quality: typeof BLOG_PIPELINE_V2_IMAGE_QUALITY;
  storage: ImageUploadReceipt;
};

/**
 * Local-recovery image adapter. Production generation uses image-pipeline.ts;
 * this adapter remains intentionally separate so recovery runs can build
 * durable packages without restoring the retired Qwen/tool graph.
 */
export async function generateRecoveryImageWithOpenAI(input: {
  query: string;
  folder?: string;
  publicId?: string;
}): Promise<RecoveryOpenAiImage[]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for recovery images");

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": `recovery-image-${createHash("sha256")
        .update(input.query)
        .digest("hex")}`,
    },
    body: JSON.stringify({
      model: BLOG_PIPELINE_V2_IMAGE_MODEL,
      prompt: input.query,
      n: 1,
      size: BLOG_PIPELINE_V2_IMAGE_SIZE,
      quality: BLOG_PIPELINE_V2_IMAGE_QUALITY,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(
      `OpenAI recovery image generation failed (${response.status}): ${body.slice(0, 500)}`,
    );
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const generated = payload.data?.[0];
  if (!generated?.b64_json && !generated?.url) {
    throw new Error("OpenAI recovery image response contained no image");
  }

  let buffer = generated.b64_json
    ? Buffer.from(generated.b64_json, "base64")
    : null;
  let mimeType = "image/png";
  if (!buffer && generated.url) {
    const downloaded = await fetch(generated.url);
    if (!downloaded.ok) {
      throw new Error(
        `Could not download the generated recovery image (${downloaded.status})`,
      );
    }
    buffer = Buffer.from(await downloaded.arrayBuffer());
    mimeType = downloaded.headers.get("content-type") || "image/png";
  }
  if (!buffer?.length) throw new Error("Recovery image source was empty");

  const storage = await uploadImageBufferWithMetadata(buffer, mimeType, {
    folder: input.folder ?? "recovery/gpt-image-2",
    publicId: input.publicId,
  });
  return [
    {
      imageUrl: storage.url,
      altText: input.query.replace(/\s+/g, " ").trim().slice(0, 180),
      source: "openai",
      width: 1536,
      height: 1024,
      model: BLOG_PIPELINE_V2_IMAGE_MODEL,
      quality: BLOG_PIPELINE_V2_IMAGE_QUALITY,
      storage,
    },
  ];
}
