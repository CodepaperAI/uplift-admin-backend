import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Response } from "express";
import sharp from "sharp";

import { prisma } from "../config/db.config";
import { uploadBusinessBrandLogoController } from "../controllers/business.controller";

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
const brandAnalysisDelegate = prisma.brandAnalysis as unknown as {
  upsert: typeof prisma.brandAnalysis.upsert;
};
const originalFindFirst = businessDelegate.findFirst;
const originalUpsert = brandAnalysisDelegate.upsert;

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

async function logoRequest(userId = "user-1", mimeType = "image/png") {
  const buffer = await sharp({
    create: {
      width: 320,
      height: 120,
      channels: 4,
      background: "#6d5df6",
    },
  })
    .png()
    .toBuffer();
  return {
    authUserId: userId,
    body: { businessId: "business-1" },
    file: { buffer, mimetype: mimeType, originalname: "brand.png" },
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
  brandAnalysisDelegate.upsert = originalUpsert;
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("business brand logo upload controller", () => {
  test("requires authentication before reading the Business", async () => {
    let queried = false;
    businessDelegate.findFirst = (async () => {
      queried = true;
      return null;
    }) as typeof businessDelegate.findFirst;
    const response = mockResponse();

    await uploadBusinessBrandLogoController(
      { body: { businessId: "business-1" } } as never,
      response.res,
    );

    expect(response.status()).toBe(401);
    expect(queried).toBe(false);
  });

  test("checks active ownership before writing an image", async () => {
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

    await uploadBusinessBrandLogoController(
      await logoRequest("another-user"),
      response.res,
    );

    expect(ownerWhere).toEqual({
      id: "business-1",
      userId: "another-user",
      isActive: true,
    });
    expect(response.status()).toBe(404);
    expect(uploaded).toBe(false);
  });

  test("persists the canonical logo URL used by BrandAnalysis consumers", async () => {
    businessDelegate.findFirst = (async () => ({
      id: "business-1",
      businessName: "Acme Catering",
      BrandAnalysis: { logoAltText: null },
    })) as unknown as typeof businessDelegate.findFirst;
    let upsertArgs: any;
    brandAnalysisDelegate.upsert = (async (args: unknown) => {
      upsertArgs = args;
      return {
        analysisVersion: "manual-logo-v1",
        faviconUrl: null,
        fontFamily: null,
        id: "brand-1",
        lastAnalyzed: new Date(),
        logoAltText: "Acme Catering logo",
        logoUrl: (args as any).create.logoUrl,
        primaryColors: [],
        secondaryColors: [],
      };
    }) as unknown as typeof brandAnalysisDelegate.upsert;
    let storageUrl = "";
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      storageUrl = String(input);
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadBusinessBrandLogoController(await logoRequest(), response.res);

    expect(response.status()).toBe(200);
    expect(upsertArgs.where).toEqual({ businessId: "business-1" });
    expect(upsertArgs.create.logoAltText).toBe("Acme Catering logo");
    expect(upsertArgs.create.logoUrl).toStartWith(
      "https://uplift-ai-images.b-cdn.net/businesses/user-1/business-1/brand-logos/logo-",
    );
    expect(upsertArgs.update).toEqual({
      logoAltText: "Acme Catering logo",
      logoUrl: upsertArgs.create.logoUrl,
    });
    expect(response.body().data.brandData.logoUrl).toBe(upsertArgs.create.logoUrl);
    expect(response.body().data.logo.mimeType).toBe("image/png");
    expect(storageUrl).toStartWith(
      "https://storage.bunnycdn.com/uplift-ai-images/businesses/user-1/business-1/brand-logos/logo-",
    );
  });

  test("rejects a spoofed content type before CDN storage", async () => {
    businessDelegate.findFirst = (async () => ({
      id: "business-1",
      businessName: "Acme Catering",
      BrandAnalysis: null,
    })) as unknown as typeof businessDelegate.findFirst;
    let uploaded = false;
    globalThis.fetch = mock(async () => {
      uploaded = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadBusinessBrandLogoController(
      await logoRequest("user-1", "image/jpeg"),
      response.res,
    );

    expect(response.status()).toBe(400);
    expect(response.body().message).toContain("contents do not match");
    expect(uploaded).toBe(false);
  });
});
