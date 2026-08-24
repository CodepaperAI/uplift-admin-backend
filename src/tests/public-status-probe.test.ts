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
    socialPublishAttempt: { count: async () => 0 },
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

  it("does not turn customer reconnect errors into a platform social outage", async () => {
    const result = await runPublicStatusProbe("social-media-publishing", {
      prisma: prismaMock(),
      now: () => now,
      fetchImpl: fetch,
      zernioClient: { listAccounts: async () => [{ _id: "a", platform: "linkedin" }] },
    });
    expect(result.ok).toBe(true);
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
});
