import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { reconcileFutureSocialPlatformCalendars } from "../services/social-platform-calendar-reconciliation.service";

const allPlatforms = ["instagram", "facebook", "linkedin", "x"];

describe("future social platform calendar reconciliation", () => {
  test("dry-runs platform eligibility without writing", async () => {
    let writes = 0;
    const prisma = {
      socialTopicPlan: {
        findMany: async () => [
          {
            id: "monday",
            platforms: allPlatforms,
            scheduledFor: new Date("2026-08-17T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
          {
            id: "tuesday",
            platforms: allPlatforms,
            scheduledFor: new Date("2026-08-18T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
        ],
        updateMany: async () => {
          writes += 1;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    const result = await reconcileFutureSocialPlatformCalendars(
      { now: new Date("2026-08-16T12:00:00.000Z") },
      prisma,
    );

    expect(result).toEqual({
      scanned: 2,
      unchanged: 1,
      wouldUpdate: 1,
      wouldSkip: 0,
      updated: 0,
      skipped: 0,
      raced: 0,
    });
    expect(writes).toBe(0);
  });

  test("applies platform changes and skips an empty off-day claim-safely", async () => {
    const writes: any[] = [];
    const prisma = {
      socialTopicPlan: {
        findMany: async () => [
          {
            id: "mixed-monday",
            platforms: allPlatforms,
            scheduledFor: new Date("2026-08-17T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
          {
            id: "instagram-monday",
            platforms: ["instagram", "facebook"],
            scheduledFor: new Date("2026-08-17T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
        ],
        updateMany: async (input: any) => {
          writes.push(input);
          return { count: input.where.id === "mixed-monday" ? 1 : 0 };
        },
      },
    } as unknown as PrismaClient;

    const result = await reconcileFutureSocialPlatformCalendars(
      { now: new Date("2026-08-16T12:00:00.000Z"), apply: true },
      prisma,
    );

    expect(result).toEqual({
      scanned: 2,
      unchanged: 0,
      wouldUpdate: 1,
      wouldSkip: 1,
      updated: 1,
      skipped: 0,
      raced: 1,
    });
    expect(writes[0]).toEqual({
      where: {
        id: "mixed-monday",
        status: "PLANNED",
        platforms: { equals: allPlatforms },
      },
      data: { platforms: ["linkedin", "x"] },
    });
    expect(writes[1].data).toEqual({ status: "SKIPPED", platforms: [] });
  });
});
