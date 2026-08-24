import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Response } from "express";

import { prisma } from "../config/db.config";
import {
  patchOnboardingV2State,
  uploadOnboardingV2AuthorImageController,
} from "../controllers/quick-scrape.controller";

const businessId = "26338194-2831-4525-b616-99bf6402d9da";
const originalFetch = globalThis.fetch;
const originalEnv = {
  BUNNY_CDN_BASE_URL: process.env.BUNNY_CDN_BASE_URL,
  BUNNY_STORAGE_ACCESS_KEY: process.env.BUNNY_STORAGE_ACCESS_KEY,
  BUNNY_STORAGE_ENDPOINT: process.env.BUNNY_STORAGE_ENDPOINT,
  BUNNY_STORAGE_ZONE: process.env.BUNNY_STORAGE_ZONE,
  BUNNY_VERIFY_PUBLIC_UPLOADS: process.env.BUNNY_VERIFY_PUBLIC_UPLOADS,
};

const quickDelegate = prisma.quickScrapeBusiness as unknown as {
  findFirst: typeof prisma.quickScrapeBusiness.findFirst;
};
const prismaClient = prisma as unknown as {
  $transaction: (callback: (tx: any) => Promise<any>) => Promise<any>;
};
const originalFindFirst = quickDelegate.findFirst;
const originalTransaction = prismaClient.$transaction;

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

function ownedQuickBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: businessId,
    userId: "user-1",
    businessName: "Example Co",
    businessType: "Consulting",
    businessWebsiteUrl: "https://example.com",
    businessPhone: "+16475550123",
    businessDescription: null,
    targetAudience: null,
    brandContext: null,
    detectedServices: ["Consulting"],
    selectedServices: ["Consulting"],
    servicesPriority: { Consulting: 1 },
    serviceAreaLocations: [],
    onboardingV2Step: "author",
    onboardingV2QuestionIndex: 5,
    onboardingV2Answers: {},
    onboardingV2AnswerRevision: 1,
    onboardingV2Status: "in_progress",
    onboardingV2LastSeenAt: new Date("2026-08-09T12:00:00.000Z"),
    onboardingV2GenerationStartedAt: null,
    onboardingV2GenerationRevision: null,
    onboardingV2BusinessId: "provisional-business-1",
    onboardingV2BlogId: null,
    onboardingV2SocialRunId: null,
    onboardingV2BlogStatus: "idle",
    onboardingV2SocialStatus: "idle",
    onboardingV2GenerationError: null,
    onboardingV2Author: { name: "Example Author" },
    onboardingV2CompletedAt: null,
    createdAt: new Date("2026-08-09T12:00:00.000Z"),
    updatedAt: new Date("2026-08-09T12:00:00.000Z"),
    ...overrides,
  };
}

function uploadRequest(userId = "user-1") {
  return {
    authUserId: userId,
    body: { businessId },
    file: {
      buffer: png(),
      mimetype: "image/png",
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
  quickDelegate.findFirst = originalFindFirst;
  prismaClient.$transaction = originalTransaction;
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("onboarding-v2 author image controller", () => {
  test("requires an authenticated user before reading or uploading", async () => {
    let queried = false;
    quickDelegate.findFirst = (async () => {
      queried = true;
      return null;
    }) as typeof quickDelegate.findFirst;
    const response = mockResponse();

    await uploadOnboardingV2AuthorImageController(
      {
        body: { businessId },
        file: {
          buffer: png(),
          mimetype: "image/png",
          originalname: "profile.png",
        },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(401);
    expect(queried).toBe(false);
  });

  test("does not upload when the quick business is not owned", async () => {
    let ownerWhere: unknown;
    let uploaded = false;
    quickDelegate.findFirst = (async (args: unknown) => {
      ownerWhere = (args as { where?: unknown }).where;
      return null;
    }) as typeof quickDelegate.findFirst;
    globalThis.fetch = mock(async () => {
      uploaded = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    const response = mockResponse();

    await uploadOnboardingV2AuthorImageController(
      uploadRequest("user-2"),
      response.res,
    );

    expect(ownerWhere).toEqual({ id: businessId, userId: "user-2" });
    expect(response.status()).toBe(404);
    expect(uploaded).toBe(false);
  });

  test("persists the Bunny URL only after upload and syncs a pending provisional business", async () => {
    const quickBusiness = ownedQuickBusiness();
    let persistedQuickData: Record<string, unknown> | null = null;
    let provisionalData: Record<string, unknown> | null = null;
    let uploadFinished = false;
    quickDelegate.findFirst = ((async () =>
      quickBusiness) as unknown) as typeof quickDelegate.findFirst;
    globalThis.fetch = mock(async () => {
      uploadFinished = true;
      return new Response("", { status: 201 });
    }) as unknown as typeof fetch;
    prismaClient.$transaction = async (callback) =>
      callback({
        quickScrapeBusiness: {
          update: async (args: { data: Record<string, unknown> }) => {
            expect(uploadFinished).toBe(true);
            persistedQuickData = args.data;
            return {
              ...quickBusiness,
              onboardingV2Author: args.data.onboardingV2Author,
              updatedAt: new Date("2026-08-09T12:01:00.000Z"),
            };
          },
        },
        business: {
          findFirst: async () => ({ id: "provisional-business-1" }),
          update: async (args: { data: Record<string, unknown> }) => {
            provisionalData = args.data;
            return { id: "provisional-business-1" };
          },
        },
      });
    const response = mockResponse();

    await uploadOnboardingV2AuthorImageController(uploadRequest(), response.res);

    const body = response.body();
    expect(response.status()).toBe(200);
    expect(body.data.image).toMatchObject({
      name: "profile.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
      provider: "bunny",
    });
    expect(body.data.image.url).toStartWith(
      "https://uplift-ai-images.b-cdn.net/onboarding-v2/author-images/user-1/",
    );
    const persistedAuthor = (
      persistedQuickData as unknown as {
        onboardingV2Author?: Record<string, unknown>;
      }
    )?.onboardingV2Author;
    expect(persistedAuthor?.imageUrl).toBe(
      body.data.image.url,
    );
    expect(provisionalData as unknown).toEqual({
      authorImage: body.data.image.url,
    });
    expect(body.data.state.author).toEqual(body.data.author);
  });

  test("fails closed without a DB write when Bunny rejects the upload", async () => {
    let transactionCalled = false;
    quickDelegate.findFirst = ((async () =>
      ownedQuickBusiness()) as unknown) as typeof quickDelegate.findFirst;
    globalThis.fetch = mock(async () =>
      new Response("storage unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    prismaClient.$transaction = async () => {
      transactionCalled = true;
      throw new Error("transaction must not run after failed upload");
    };
    const response = mockResponse();

    await uploadOnboardingV2AuthorImageController(uploadRequest(), response.res);

    expect(response.status()).toBe(503);
    expect(response.body().message).toBe("Request could not be completed");
    expect(response.body().error).toBeUndefined();
    expect(transactionCalled).toBe(false);
  });

  test("preserves the verified image when later author metadata is patched", async () => {
    const imageUrl =
      "https://uplift-ai-images.b-cdn.net/onboarding-v2/author-images/user-1/verified.png";
    const quickBusiness = ownedQuickBusiness({
      onboardingV2Author: {
        name: "Original Author",
        imageName: "verified.png",
        imageUrl,
      },
    });
    let quickAuthor: Record<string, unknown> | null = null;
    let provisionalData: Record<string, unknown> | null = null;
    quickDelegate.findFirst = ((async () =>
      quickBusiness) as unknown) as typeof quickDelegate.findFirst;
    prismaClient.$transaction = async (callback) =>
      callback({
        quickScrapeBusiness: {
          update: async (args: { data: Record<string, unknown> }) => {
            quickAuthor = args.data.onboardingV2Author as Record<string, unknown>;
            return {
              ...quickBusiness,
              onboardingV2Author: quickAuthor,
            };
          },
        },
        business: {
          findFirst: async () => ({ id: "provisional-business-1" }),
          update: async (args: { data: Record<string, unknown> }) => {
            provisionalData = args.data;
            return { id: "provisional-business-1" };
          },
        },
      });
    const response = mockResponse();

    await patchOnboardingV2State(
      {
        authUserId: "user-1",
        body: {
          businessId,
          author: { name: "Updated Author", title: "Founder" },
        },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(quickAuthor as unknown).toEqual({
      name: "Updated Author",
      title: "Founder",
      imageName: "verified.png",
      imageUrl,
    });
    expect(provisionalData as unknown).toMatchObject({ authorImage: imageUrl });
  });
});
