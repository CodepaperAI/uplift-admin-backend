import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  buildBunnyObjectKey,
  deleteImageFromBunny,
  getBunnyStorageConfig,
  uploadImageBufferToBunny,
} from "../lib/bunny-storage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Bunny image storage", () => {
  test("requires server-only storage configuration", () => {
    expect(() =>
      getBunnyStorageConfig({
        BUNNY_CDN_BASE_URL: "https://uplift-ai-images.b-cdn.net",
        BUNNY_STORAGE_ZONE: "uplift-ai-images",
      }),
    ).toThrow("BUNNY_STORAGE_ACCESS_KEY");

    expect(
      getBunnyStorageConfig({
        BUNNY_CDN_BASE_URL: "https://uplift-ai-images.b-cdn.net/",
        BUNNY_STORAGE_ACCESS_KEY: "storage-zone-password",
        BUNNY_STORAGE_ZONE: "uplift-ai-images",
      }),
    ).toEqual({
      accessKey: "storage-zone-password",
      cdnBaseUrl: "https://uplift-ai-images.b-cdn.net",
      endpoint: "https://storage.bunnycdn.com",
      storageZone: "uplift-ai-images",
      verifyPublicUpload: true,
    });
  });

  test("builds a safe extension-aware object key", () => {
    expect(
      buildBunnyObjectKey({
        folder: "/social creatives/business 1/run#1/",
        mimeType: "image/jpeg",
        publicId: "asset one.PNG",
      }),
    ).toBe("social-creatives/business-1/run-1/asset-one.jpg");
    expect(
      buildBunnyObjectKey({
        folder: "../social-creatives/../../run-1",
        mimeType: "image/webp",
        publicId: "../asset-1",
      }),
    ).toBe("images/social-creatives/images/images/run-1/..-asset-1.webp");
  });

  test("uploads exact bytes with checksum and verifies public delivery", async () => {
    const image = Buffer.from("fixture-image-bytes");
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (init?.method === "PUT") {
        return new Response("", { status: 201 });
      }
      return new Response("", {
        status: 200,
        headers: { "content-length": String(image.length) },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadImageBufferToBunny(image, "image/png", {
      folder: "social-creatives/business-1/run-1",
      publicId: "asset-1",
      config: {
        accessKey: "secret-zone-password",
        cdnBaseUrl: "https://uplift-ai-images.b-cdn.net",
        endpoint: "https://storage.bunnycdn.com",
        storageZone: "uplift-ai-images",
        verifyPublicUpload: true,
      },
    });

    const expectedChecksum = createHash("sha256")
      .update(image)
      .digest("hex")
      .toUpperCase();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe(
      "https://storage.bunnycdn.com/uplift-ai-images/social-creatives/business-1/run-1/asset-1.png",
    );
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(new Headers(calls[0]?.init?.headers).get("AccessKey")).toBe(
      "secret-zone-password",
    );
    expect(new Headers(calls[0]?.init?.headers).get("Checksum")).toBe(
      expectedChecksum,
    );
    expect(Buffer.from(calls[0]?.init?.body as Buffer).equals(image)).toBe(true);
    expect(calls[1]).toMatchObject({
      input:
        "https://uplift-ai-images.b-cdn.net/social-creatives/business-1/run-1/asset-1.png",
      init: { method: "HEAD" },
    });
    expect(result).toEqual({
      bytes: image.length,
      checksumSha256: expectedChecksum,
      format: "png",
      objectKey: "social-creatives/business-1/run-1/asset-1.png",
      provider: "bunny",
      storageZone: "uplift-ai-images",
      url: "https://uplift-ai-images.b-cdn.net/social-creatives/business-1/run-1/asset-1.png",
    });
  });

  test("fails closed when Bunny rejects the upload", async () => {
    globalThis.fetch = mock(async () =>
      new Response("invalid storage zone", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      uploadImageBufferToBunny(Buffer.from("image"), "image/webp", {
        publicId: "asset-1",
        config: {
          accessKey: "must-not-appear-in-error",
          cdnBaseUrl: "https://uplift-ai-images.b-cdn.net",
          endpoint: "https://storage.bunnycdn.com",
          storageZone: "uplift-ai-images",
          verifyPublicUpload: false,
        },
      }),
    ).rejects.toThrow("HTTP 401: invalid storage zone");
  });

  test("deletes only objects that belong to the configured Bunny CDN", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const config = {
      accessKey: "secret-zone-password",
      cdnBaseUrl: "https://uplift-ai-images.b-cdn.net",
      endpoint: "https://storage.bunnycdn.com",
      storageZone: "uplift-ai-images",
      verifyPublicUpload: false,
    };
    const result = await deleteImageFromBunny(
      "https://uplift-ai-images.b-cdn.net/social-references/business-1/always/reference.png",
      {
        config,
        fetchImpl: (async (input, init) => {
          calls.push({ input: String(input), init });
          return new Response("", { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(result).toEqual({
      deleted: true,
      objectKey: "social-references/business-1/always/reference.png",
    });
    expect(calls).toEqual([
      {
        input:
          "https://storage.bunnycdn.com/uplift-ai-images/social-references/business-1/always/reference.png",
        init: expect.objectContaining({ method: "DELETE" }),
      },
    ]);
    await expect(
      deleteImageFromBunny("https://example.com/reference.png", {
        config,
        fetchImpl: mock(
          async () => new Response("", { status: 200 }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("does not belong to the configured Bunny CDN");
  });
});
