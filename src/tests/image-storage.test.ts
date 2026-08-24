import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  uploadBase64Image,
  uploadImageBufferWithMetadata,
} from "../lib/image-storage";

const originalFetch = globalThis.fetch;
const originalEnv = {
  BUNNY_CDN_BASE_URL: process.env.BUNNY_CDN_BASE_URL,
  BUNNY_STORAGE_ACCESS_KEY: process.env.BUNNY_STORAGE_ACCESS_KEY,
  BUNNY_STORAGE_ENDPOINT: process.env.BUNNY_STORAGE_ENDPOINT,
  BUNNY_STORAGE_ZONE: process.env.BUNNY_STORAGE_ZONE,
  BUNNY_VERIFY_PUBLIC_UPLOADS: process.env.BUNNY_VERIFY_PUBLIC_UPLOADS,
};

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

describe("platform image storage", () => {
  test("writes a deterministic named buffer to Bunny", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response("", { status: 201 });
      },
    ) as unknown as typeof fetch;

    const receipt = await uploadImageBufferWithMetadata(
      Buffer.from("image-bytes"),
      "image/png",
      { folder: "blog-images/business-1", publicId: "feature-1" },
    );

    expect(receipt.provider).toBe("bunny");
    expect(receipt.objectKey).toBe(
      "blog-images/business-1/feature-1.png",
    );
    expect(receipt.url).toBe(
      "https://uplift-ai-images.b-cdn.net/blog-images/business-1/feature-1.png",
    );
    expect(calls[0]?.input).toBe(
      "https://storage.bunnycdn.com/uplift-ai-images/blog-images/business-1/feature-1.png",
    );
    expect(new Headers(calls[0]?.init?.headers).get("AccessKey")).toBe(
      "test-storage-password",
    );
  });

  test("decodes generated base64 images before the Bunny upload", async () => {
    const expected = Buffer.from("generated-image");
    let uploaded: Uint8Array | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      uploaded = init?.body as Uint8Array;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;

    const url = await uploadBase64Image(
      `data:image/webp;base64,${expected.toString("base64")}`,
      "generated/gmb",
    );

    expect(Buffer.compare(Buffer.from(uploaded ?? []), expected)).toBe(0);
    expect(url).toMatch(
      /^https:\/\/uplift-ai-images\.b-cdn\.net\/generated\/gmb\/[a-f0-9-]+\.webp$/,
    );
  });

  test("rejects non-data sources instead of passing them to another provider", async () => {
    await expect(
      uploadBase64Image("https://res.cloudinary.com/demo/image.png"),
    ).rejects.toThrow("base64 data URL");
  });
});
