import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  isPublicStatusComponent,
  runPublicStatusProbe,
} from "../services/public-status-probe.service";

const now = new Date("2026-08-24T16:00:00.000Z");

function prismaMock(overrides: Record<string, unknown> = {}): PrismaClient {
  return {
    blogGenerationRun: { count: async () => 0 },
    publishedBlog: { count: async () => 0 },
    socialPublisherProfile: {
      findFirst: async () => ({ externalProfileId: "profile-1" }),
    },
    socialPublishAttempt: { count: async () => 0, findMany: async () => [] },
    googleMyBusiness: {
      findMany: async () => [{ lastSyncAt: now, lastSyncError: null }],
    },
    gMBPost: { count: async () => 0 },
    ...overrides,
  } as unknown as PrismaClient;
}

describe("public status probes", () => {
  it("accepts only the explicit customer-facing component keys", () => {
    expect(isPublicStatusComponent("social-media-publishing")).toBe(true);
    expect(isPublicStatusComponent("postgresql")).toBe(false);
  });

  it("uses a read-only provider request and recent run state for AI", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const calls: string[] = [];
    const result = await runPublicStatusProbe("ai-content-generation", {
      prisma: prismaMock(),
      now: () => now,
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      zernioClient: { listAccounts: async () => [] },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["https://api.openai.com/v1/models"]);
  });

  it("marks repeated stuck blog publishing work unavailable", async () => {
    let call = 0;
    const result = await runPublicStatusProbe("blog-website-publishing", {
      prisma: prismaMock({
        publishedBlog: { count: async () => (++call === 3 ? 2 : 0) },
      }),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [] },
    });
    expect(result.ok).toBe(false);
  });

  it("keeps blog publishing available when the delivery path has a recent success", async () => {
    let call = 0;
    const result = await runPublicStatusProbe("blog-website-publishing", {
      prisma: prismaMock({
        publishedBlog: {
          count: async () => {
            call += 1;
            if (call === 1) return 1;
            if (call === 2) return 20;
            return 0;
          },
        },
      }),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [] },
    });
    expect(result.ok).toBe(true);
  });

  it("does not turn customer reconnect errors into a platform social outage", async () => {
    const result = await runPublicStatusProbe("social-media-publishing", {
      prisma: prismaMock({
        socialPublishAttempt: {
          count: async () => 0,
          findMany: async () =>
            Array.from({ length: 8 }, () => ({
              lastErrorCode: null,
              lastErrorMessage:
                "Failed to create media container 1: HTTP error! status: 403 - Application does not have permission for this action",
            })),
        },
      }),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [{ _id: "a", platform: "linkedin" }] },
    });
    expect(result.ok).toBe(true);
  });

  it("reports a platform social outage for repeated provider/server failures", async () => {
    const result = await runPublicStatusProbe("social-media-publishing", {
      prisma: prismaMock({
        socialPublishAttempt: {
          count: async () => 0,
          findMany: async () =>
            Array.from({ length: 5 }, () => ({
              lastErrorCode: "ZERNIO_SERVER_ERROR",
              lastErrorMessage: "HTTP 500 from publishing provider",
            })),
        },
      }),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [{ _id: "a", platform: "instagram" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("requires at least one recently synchronized real GMB connection", async () => {
    const result = await runPublicStatusProbe("google-business-profile", {
      prisma: prismaMock({
        googleMyBusiness: {
          findMany: async () => [
            { lastSyncAt: new Date("2026-08-01T00:00:00.000Z"), lastSyncError: null },
          ],
        },
      }),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [] },
    });
    expect(result.ok).toBe(false);
  });

  it("checks the self-hosted Inngest registration route without enqueueing work", async () => {
    const previousBaseUrl = process.env.INNGEST_BASE_URL;
    const previousSigningKey = process.env.INNGEST_SIGNING_KEY;
    process.env.INNGEST_BASE_URL = "https://inngest.example.com";
    process.env.INNGEST_SIGNING_KEY = `signkey-prod-${"a".repeat(64)}`;
    const calls: Array<{ url: string; method: string | undefined }> = [];
    try {
      const result = await runPublicStatusProbe("scheduled-automations", {
        prisma: prismaMock(),
        now: () => now,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), method: init?.method });
          return new Response(null, { status: 405 });
        }) as typeof fetch,
        zernioClient: { listAccounts: async () => [] },
      });
      expect(result.ok).toBe(true);
      expect(calls).toEqual([
        { url: "https://inngest.example.com/fn/register", method: "GET" },
      ]);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.INNGEST_BASE_URL;
      else process.env.INNGEST_BASE_URL = previousBaseUrl;
      if (previousSigningKey === undefined) delete process.env.INNGEST_SIGNING_KEY;
      else process.env.INNGEST_SIGNING_KEY = previousSigningKey;
    }
  });

  it("does not cache a failed automation probe across monitoring retries", async () => {
    const previousBaseUrl = process.env.INNGEST_BASE_URL;
    const previousSigningKey = process.env.INNGEST_SIGNING_KEY;
    process.env.INNGEST_BASE_URL = "https://inngest-retry.example.com";
    process.env.INNGEST_SIGNING_KEY = `signkey-prod-${"b".repeat(64)}`;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 405 });
    }) as typeof fetch;

    try {
      const dependencies = {
        prisma: prismaMock(),
        fetchImpl,
        zernioClient: { listAccounts: async () => [] },
      };
      const first = await runPublicStatusProbe("scheduled-automations", dependencies);
      const retry = await runPublicStatusProbe("scheduled-automations", dependencies);

      expect(first.ok).toBe(false);
      expect(retry.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.INNGEST_BASE_URL;
      else process.env.INNGEST_BASE_URL = previousBaseUrl;
      if (previousSigningKey === undefined) delete process.env.INNGEST_SIGNING_KEY;
      else process.env.INNGEST_SIGNING_KEY = previousSigningKey;
    }
  });
});
