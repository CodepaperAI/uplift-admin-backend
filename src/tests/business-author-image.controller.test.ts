import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Response } from "express";

import { prisma } from "../config/db.config";
import { uploadBusinessAuthorImage } from "../controllers/business.controller";

const originalFetch = globalThis.fetch;
const originalEnv = {
  BUNNY_CDN_BASE_URL: process.env.BUNNY_CDN_BASE_URL,
  BUNNY_STORAGE_ACCESS_KEY: process.env.BUNNY_STORAGE_ACCESS_KEY,
  BUNNY_STORAGE_ENDPOINT: process.env.BUNNY_STORAGE_ENDPOINT,
  BUNNY_STORAGE_ZONE: process.env.BUNNY_STORAGE_ZONE,
  BUNNY_VERIFY_PUBLIC_UPLOADS: process.env.BUNNY_VERIFY_PUBLIC_UPLOADS,
};
const businessDelegate = prisma.business as unknown as {
  findFirst: typeof prisma.business.findFirst;
};
const originalFindFirst = businessDelegate.findFirst;

function png(width = 512, height = 512): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function mockResponse() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => body };
}

function uploadRequest(userId = "user-1", mimeType = "image/png") {
  return {
    authUserId: userId,
    body: { businessId: "business-1" },
    file: {
      buffer: png(),
      mimetype: mimeType,
      originalname: "../profile.png",
    },
  } as never;
}

beforeEach(() => {
  process.env.BUNNY_CDN_BASE_URL = "https://uplift-ai-images.b-cdn.net";
  process.env.BUNNY_STORAGE_ACCESS_KEY = "test-storage-password";
  process.env.BUNNY_STORAGE_ENDPOINT = "https://storage.bunnycdn.com";
  process.env.BUNNY_STORAGE_ZONE = "uplift-ai-images";
  process.env.BUNNY_VERIFY_PUBLIC_UPLOADS = "false";
});

afterEach(() => {
  businessDelegate.findFirst = originalFindFirst;
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("business author image upload controller", () => {
  test("requires authentication before querying or uploading", async () => {
    let queried = false;
    businessDelegate.findFirst = (async () => {
      queried = true;
      return null;
    }) as typeof businessDelegate.findFirst;
    const response = mockResponse();

    await uploadBusinessAuthorImage(
      { body: { businessId: "business-1" } } as never,
      response.res,
    );

    expect(response.status()).toBe(401);
    expect(queried).toBe(false);
  });

  test("checks active Business ownership before any Bunny write", async () => {
    let ownerWhere: unknown;
    let uploaded = false;
    businessDelegate.findFirst = (async (args: unknown) => {
      ownerWhere = (args as { where?: unknown }).where;
      return null;
    }) as typeof businessDelegate.findFirst;
    globalThis.fetch = mock(async () => {
      uploaded = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadBusinessAuthorImage(uploadRequest("user-2"), response.res);

    expect(ownerWhere).toEqual({
      id: "business-1",
      userId: "user-2",
      isActive: true,
    });
    expect(response.status()).toBe(404);
    expect(uploaded).toBe(false);
  });

  test("returns a durable deterministic owner-scoped Bunny URL", async () => {
    businessDelegate.findFirst = (async () => ({
      id: "business-1",
    })) as typeof businessDelegate.findFirst;
    let storageUrl = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      storageUrl = String(input);
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadBusinessAuthorImage(uploadRequest(), response.res);

    expect(response.status()).toBe(200);
    expect(response.body().data.image).toMatchObject({
      height: 512,
      mimeType: "image/png",
      name: "profile.png",
      provider: "bunny",
      sizeBytes: 33,
      width: 512,
    });
    expect(response.body().data.image.url).toStartWith(
      "https://uplift-ai-images.b-cdn.net/businesses/user-1/business-1/author-images/author-",
    );
    expect(storageUrl).toStartWith(
      "https://storage.bunnycdn.com/uplift-ai-images/businesses/user-1/business-1/author-images/author-",
    );
  });

  test("rejects spoofed image content before Bunny upload", async () => {
    businessDelegate.findFirst = (async () => ({
      id: "business-1",
    })) as typeof businessDelegate.findFirst;
    let uploaded = false;
    globalThis.fetch = mock(async () => {
      uploaded = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadBusinessAuthorImage(
      uploadRequest("user-1", "image/jpeg"),
      response.res,
    );

    expect(response.status()).toBe(400);
    expect(response.body().message).toContain("contents do not match");
    expect(response.body().error).toBeUndefined();
    expect(uploaded).toBe(false);
  });
});
