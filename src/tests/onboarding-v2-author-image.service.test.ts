import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  inspectImageUpload,
  inspectOnboardingV2AuthorImage,
  ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES,
  uploadOnboardingV2AuthorImage,
} from "../services/onboarding-v2-author-image.service";

const originalFetch = globalThis.fetch;
const originalEnv = {
  BUNNY_CDN_BASE_URL: process.env.BUNNY_CDN_BASE_URL,
  BUNNY_STORAGE_ACCESS_KEY: process.env.BUNNY_STORAGE_ACCESS_KEY,
  BUNNY_STORAGE_ENDPOINT: process.env.BUNNY_STORAGE_ENDPOINT,
  BUNNY_STORAGE_ZONE: process.env.BUNNY_STORAGE_ZONE,
  BUNNY_VERIFY_PUBLIC_UPLOADS: process.env.BUNNY_VERIFY_PUBLIC_UPLOADS,
};

function png(width = 512, height = 512): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width = 512, height = 512): Buffer {
  const buffer = Buffer.alloc(21);
  buffer.set([0xff, 0xd8, 0xff, 0xc0], 0);
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webp(width = 512, height = 512): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

beforeEach(() => {
  process.env.BUNNY_CDN_BASE_URL = "https://uplift-ai-images.b-cdn.net";
  process.env.BUNNY_STORAGE_ACCESS_KEY = "test-storage-password";
  process.env.BUNNY_STORAGE_ENDPOINT = "https://storage.bunnycdn.com";
  process.env.BUNNY_STORAGE_ZONE = "uplift-ai-images";
  process.env.BUNNY_VERIFY_PUBLIC_UPLOADS = "false";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("onboarding-v2 author image storage", () => {
  test("validates JPEG, PNG, and WebP signatures and dimensions", () => {
    expect(inspectOnboardingV2AuthorImage(jpeg(), "image/jpeg")).toMatchObject({
      mimeType: "image/jpeg",
      width: 512,
      height: 512,
    });
    expect(inspectOnboardingV2AuthorImage(png(), "image/png")).toMatchObject({
      mimeType: "image/png",
      width: 512,
      height: 512,
    });
    expect(inspectOnboardingV2AuthorImage(webp(), "image/webp")).toMatchObject({
      mimeType: "image/webp",
      width: 512,
      height: 512,
    });
  });

  test("rejects MIME spoofing, undersized dimensions, and oversized files", () => {
    expect(() =>
      inspectOnboardingV2AuthorImage(png(), "image/jpeg"),
    ).toThrow("do not match");
    expect(() => inspectOnboardingV2AuthorImage(png(255, 512), "image/png")).toThrow(
      "at least 256",
    );
    expect(() =>
      inspectOnboardingV2AuthorImage(
        Buffer.alloc(ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES + 1),
        "image/png",
      ),
    ).toThrow("1 MB or smaller");
  });

  test("applies reusable signature and decompression-bomb limits to other image uploads", () => {
    const policy = {
      maxBytes: 10 * 1024 * 1024,
      maxDimension: 8_192,
      maxPixels: 40_000_000,
    };
    expect(inspectImageUpload(png(100, 100), "image/png", policy)).toMatchObject({
      width: 100,
      height: 100,
      mimeType: "image/png",
    });
    expect(() =>
      inspectImageUpload(Buffer.from("<svg><script/></svg>"), "image/svg+xml", policy),
    ).toThrow("JPEG, PNG, or WebP");
    expect(() => inspectImageUpload(png(), "image/jpeg", policy)).toThrow(
      "do not match",
    );
    expect(() => inspectImageUpload(png(8_193, 100), "image/png", policy)).toThrow(
      "dimensions are too large",
    );
    expect(() => inspectImageUpload(png(8_000, 8_000), "image/png", policy)).toThrow(
      "dimensions are too large",
    );
  });

  test("uses a deterministic owner-scoped Bunny object key", async () => {
    const image = png();
    let uploadedUrl = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      uploadedUrl = String(input);
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;

    const receipt = await uploadOnboardingV2AuthorImage({
      buffer: image,
      declaredMimeType: "image/png",
      quickBusinessId: "quick-business-1",
      userId: "user-1",
    });
    const hash = createHash("sha256").update(image).digest("hex").slice(0, 32);
    const expectedKey =
      `onboarding-v2/author-images/user-1/quick-business-1/author-${hash}.png`;

    expect(receipt.objectKey).toBe(expectedKey);
    expect(receipt.url).toBe(`https://uplift-ai-images.b-cdn.net/${expectedKey}`);
    expect(uploadedUrl).toBe(
      `https://storage.bunnycdn.com/uplift-ai-images/${expectedKey}`,
    );
  });
});
