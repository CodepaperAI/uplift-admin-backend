import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  prepareAutomaticSocialPublishing,
  submitSocialPublishAttempt,
} from "../services/zernio/social-publishing.service";

const scheduledFor = new Date("2026-08-15T12:30:00.000Z");
const now = new Date("2026-08-13T14:00:00.000Z");

function completeCalendarRun(approvalRequired = false) {
  return {
    id: "run-1",
    userId: "user-1",
    businessId: "business-1",
    status: "COMPLETE",
    requestedPlatforms: ["instagram", "facebook"],
    socialTopicPlan: { scheduledFor, timezone: "America/Toronto" },
    business: { socialAutomationSettings: { approvalRequired } },
  };
}

function publishableRun() {
  return {
    ...completeCalendarRun(),
    contentPlan: {
      platformCopy: {
        instagram: { caption: "Instagram caption", hashtags: ["uplift"] },
      },
    },
    posts: [
      {
        caption: "Fallback caption",
        slideIndex: 0,
        assets: [
          {
            id: "asset-instagram",
            platform: "instagram",
            status: "COMPLETE",
            imageUrl: "https://cdn.example.com/instagram.png",
          },
        ],
      },
    ],
  };
}

function publishableCarouselRun() {
  return {
    ...completeCalendarRun(),
    kind: "carousel",
    requestedPlatforms: ["instagram"],
    contentPlan: {
      platformCopy: {
        instagram: { caption: "A connected four-step guide", hashtags: [] },
      },
    },
    posts: Array.from({ length: 4 }, (_, slideIndex) => ({
      caption: "A connected four-step guide",
      slideIndex,
      assets: [
        {
          id: `asset-instagram-${slideIndex}`,
          platform: "instagram",
          slideIndex,
          status: "COMPLETE",
          imageUrl: `https://cdn.example.com/instagram-${slideIndex}.png`,
        },
      ],
    })),
  };
}

function completeXCalendarRun(topicDate: Date) {
  return {
    ...completeCalendarRun(),
    requestedPlatforms: ["x"],
    socialTopicPlan: {
      scheduledFor: topicDate,
      timezone: "America/Toronto",
    },
  };
}

function publishableXRun(topicDate: Date, includeImage: boolean) {
  return {
    ...completeXCalendarRun(topicDate),
    contentPlan: {
      platformCopy: {
        x: { caption: "Default X caption", hashtags: ["Uplift"] },
      },
      platformCopyVariants: {
        x: [
          { slot: "lunch", caption: "Lunch X caption", hashtags: ["Uplift"] },
          { slot: "evening", caption: "Evening X caption", hashtags: [] },
        ],
      },
    },
    posts: [
      {
        caption: "Fallback caption",
        slideIndex: 0,
        assets: includeImage
          ? [
              {
                id: "asset-x",
                platform: "x",
                status: "COMPLETE",
                imageUrl: "https://cdn.example.com/x.png",
              },
            ]
          : [],
      },
    ],
  };
}

describe("automatic social publishing preparation", () => {
  test("persists one ordered provider attempt containing every carousel slide", async () => {
    const attempts: any[] = [];
    const mediaRows: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(),
        findFirst: async () => publishableCarouselRun(),
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
        ],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          attempts.push(input.create);
          return { id: "attempt-carousel", status: "PENDING" };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async (input: any) => {
          mediaRows.push(...input.data);
          return { count: input.data.length };
        },
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(result.attemptIds).toEqual(["attempt-carousel"]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      idempotencyKey:
        "zernio:run-1:instagram:primary:account-instagram:carousel-v1",
      assetId: "asset-instagram-0",
      mediaUrl: "https://cdn.example.com/instagram-0.png",
    });
    expect(mediaRows).toEqual(
      Array.from({ length: 4 }, (_, position) => ({
        attemptId: "attempt-carousel",
        assetId: `asset-instagram-${position}`,
        position,
        mediaUrl: `https://cdn.example.com/instagram-${position}.png`,
      })),
    );
  });

  test("schedules completed creative only for connected platforms", async () => {
    const upserts: any[] = [];
    const account = {
      id: "account-instagram",
      platform: "instagram",
      externalAccountId: "provider-instagram",
    };
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(),
        findFirst: async () => publishableRun(),
      },
      socialPublisherAccount: {
        findMany: async () => [account],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          upserts.push(input);
          return { id: "attempt-instagram", status: "PENDING" };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(result).toEqual({
      runId: "run-1",
      businessId: "business-1",
      status: "prepared",
      mode: "SCHEDULE",
      platforms: ["instagram"],
      attemptIds: ["attempt-instagram"],
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      create: {
        idempotencyKey:
          "zernio:run-1:instagram:primary:account-instagram:auto-v1",
        runId: "run-1",
        platform: "instagram",
        mode: "SCHEDULE",
        scheduledFor: new Date("2026-08-15T13:00:00.000Z"),
        timezone: "America/Toronto",
      },
    });
  });

  test("strips complete internal context paragraphs before creating a publish attempt", async () => {
    const creates: any[] = [];
    const unsafeRun = publishableRun();
    unsafeRun.contentPlan.platformCopy.instagram.caption = [
      "A practical office lunch starts with a clear plan.",
      "Service: Corporate catering.",
      "Audience: Corporate offices and organizations across Toronto and the GTA that host regular lunches, meetings, and events.",
      "See the menu options at https://example.com.",
    ].join("\n\n");
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(),
        findFirst: async () => unsafeRun,
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
        ],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          creates.push(input.create);
          return { id: "attempt-instagram", status: "PENDING" };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(creates[0].caption).toBe(
      "A practical office lunch starts with a clear plan.\n\nSee the menu options at https://example.com.",
    );
    expect(creates[0].caption).not.toContain("Service:");
    expect(creates[0].caption).not.toContain("Audience:");
  });

  test("keeps generated content untouched when no requested platform is connected", async () => {
    let attemptWrites = 0;
    const prisma = {
      socialCreativeRun: { findUnique: async () => completeCalendarRun() },
      socialPublisherAccount: { findMany: async () => [] },
      socialPublishAttempt: {
        upsert: async () => {
          attemptWrites += 1;
        },
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(result.status).toBe("no_connected_accounts");
    expect(result.attemptIds).toEqual([]);
    expect(attemptWrites).toBe(0);
  });

  test("honors an explicit approval-required workspace", async () => {
    let accountReads = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(true),
      },
      socialPublisherAccount: {
        findMany: async () => {
          accountReads += 1;
          return [];
        },
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(result.status).toBe("approval_required");
    expect(result.attemptIds).toEqual([]);
    expect(accountReads).toBe(0);
  });

  test("defaults to auto publish when no social settings row exists", async () => {
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => ({
          ...completeCalendarRun(),
          business: { socialAutomationSettings: null },
        }),
        findFirst: async () => publishableRun(),
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
        ],
      },
      socialPublishAttempt: {
        upsert: async () => ({ id: "attempt-instagram", status: "PENDING" }),
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing("run-1", prisma, now);

    expect(result.status).toBe("prepared");
    expect(result.attemptIds).toEqual(["attempt-instagram"]);
  });

  test("publishes immediately when the planned time is already due", async () => {
    const creates: any[] = [];
    const account = {
      id: "account-instagram",
      platform: "instagram",
      externalAccountId: "provider-instagram",
    };
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(),
        findFirst: async () => publishableRun(),
      },
      socialPublisherAccount: { findMany: async () => [account] },
      socialPublishAttempt: {
        findFirst: async () => null,
        upsert: async (input: any) => {
          creates.push(input.create);
          return { id: "attempt-instagram", status: "PENDING" };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-15T14:00:00.000Z"),
    );

    expect(result.mode).toBe("NOW");
    expect(creates[0]).toMatchObject({
      idempotencyKey:
        "zernio:run-1:instagram:primary:account-instagram:auto-v1",
      mode: "NOW",
      scheduledFor: null,
    });
  });

  test("reuses the scheduled provider attempt when its publish time becomes due", async () => {
    const lookupInputs: any[] = [];
    let upserts = 0;
    const existingAttempt = {
      id: "attempt-scheduled",
      status: "SCHEDULED",
      mode: "SCHEDULE",
    };
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeCalendarRun(),
        findFirst: async () => publishableRun(),
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
        ],
      },
      socialPublishAttempt: {
        findFirst: async (input: any) => {
          lookupInputs.push(input);
          return existingAttempt;
        },
        upsert: async () => {
          upserts += 1;
          throw new Error("must not create a duplicate attempt");
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 0 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-15T14:00:00.000Z"),
    );

    expect(upserts).toBe(0);
    expect(result).toMatchObject({
      status: "prepared",
      mode: "SCHEDULE",
      attemptIds: [],
    });
    expect(lookupInputs).toEqual([
      {
        where: {
          idempotencyKey: {
            in: [
              "zernio:asset-instagram:account-instagram:SCHEDULE:2026-08-15T13:00:00.000Z",
              "zernio:asset-instagram:account-instagram:NOW:now",
            ],
          },
        },
        orderBy: { createdAt: "asc" },
      },
    ]);
  });

  test("schedules Instagram and Facebook together at 09:00 on Tuesday", async () => {
    const topicDate = new Date("2026-08-18T12:30:00.000Z");
    const creates: any[] = [];
    const run = {
      ...completeCalendarRun(),
      socialTopicPlan: {
        scheduledFor: topicDate,
        timezone: "America/Toronto",
      },
    };
    const publishable = {
      ...run,
      contentPlan: {
        platformCopy: {
          instagram: { caption: "Instagram Tuesday", hashtags: ["Uplift"] },
          facebook: { caption: "Facebook Tuesday", hashtags: ["Uplift"] },
        },
      },
      posts: [
        {
          caption: "Fallback caption",
          slideIndex: 0,
          assets: [
            {
              id: "asset-instagram",
              platform: "instagram",
              status: "COMPLETE",
              imageUrl: "https://cdn.example.com/instagram.png",
            },
            {
              id: "asset-facebook",
              platform: "facebook",
              status: "COMPLETE",
              imageUrl: "https://cdn.example.com/facebook.png",
            },
          ],
        },
      ],
    };
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => run,
        findFirst: async () => publishable,
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
          {
            id: "account-facebook",
            platform: "facebook",
            externalAccountId: "provider-facebook",
          },
        ],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          creates.push(input.create);
          return {
            id: `attempt-${input.create.platform}`,
            status: "PENDING",
            mode: input.create.mode,
          };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-17T14:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "prepared",
      platforms: ["instagram", "facebook"],
      attemptIds: ["attempt-instagram", "attempt-facebook"],
    });
    expect(creates.map((create) => create.scheduledFor.toISOString())).toEqual([
      "2026-08-18T13:00:00.000Z",
      "2026-08-18T13:00:00.000Z",
    ]);
    expect(creates.every((create) => create.mediaUrl)).toBe(true);
  });

  test("creates no Instagram/Facebook attempts on Monday, Wednesday, or Friday", async () => {
    let runReads = 0;
    let attemptWrites = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => ({
          ...completeCalendarRun(),
          socialTopicPlan: {
            scheduledFor: new Date("2026-08-17T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
        }),
        findFirst: async () => {
          runReads += 1;
          return publishableRun();
        },
      },
      socialPublisherAccount: {
        findMany: async () => [
          {
            id: "account-instagram",
            platform: "instagram",
            externalAccountId: "provider-instagram",
          },
          {
            id: "account-facebook",
            platform: "facebook",
            externalAccountId: "provider-facebook",
          },
        ],
      },
      socialPublishAttempt: {
        upsert: async () => {
          attemptWrites += 1;
        },
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-16T14:00:00.000Z"),
    );

    expect(result.status).toBe("no_scheduled_platforms");
    expect(result.platforms).toEqual([]);
    expect(result.attemptIds).toEqual([]);
    expect(runReads).toBe(0);
    expect(attemptWrites).toBe(0);
  });

  test("creates two distinct text-only X attempts on a weekday", async () => {
    const topicDate = new Date("2026-08-20T12:30:00.000Z");
    const creates: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeXCalendarRun(topicDate),
        findFirst: async () => publishableXRun(topicDate, false),
      },
      socialPublisherAccount: {
        findMany: async () => [
          { id: "account-x", platform: "x", externalAccountId: "provider-x" },
        ],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          creates.push(input.create);
          return {
            id: `attempt-${creates.length}`,
            status: "PENDING",
            mode: input.create.mode,
          };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    const result = await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-19T14:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "prepared",
      mode: "SCHEDULE",
      platforms: ["x"],
      attemptIds: ["attempt-1", "attempt-2"],
    });
    expect(creates.map((create) => create.scheduledFor.toISOString())).toEqual([
      "2026-08-20T16:00:00.000Z",
      "2026-08-20T22:00:00.000Z",
    ]);
    expect(creates.map((create) => create.caption)).toEqual([
      "Lunch X caption",
      "Evening X caption",
    ]);
    expect(creates.every((create) => create.hashtags.length === 0)).toBe(true);
    expect(creates.every((create) => create.assetId === null)).toBe(true);
    expect(creates.every((create) => create.mediaUrl === null)).toBe(true);
  });

  test("includes the generated X image in both Saturday slots", async () => {
    const topicDate = new Date("2026-08-22T12:30:00.000Z");
    const creates: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => completeXCalendarRun(topicDate),
        findFirst: async () => publishableXRun(topicDate, true),
      },
      socialPublisherAccount: {
        findMany: async () => [
          { id: "account-x", platform: "x", externalAccountId: "provider-x" },
        ],
      },
      socialPublishAttempt: {
        upsert: async (input: any) => {
          creates.push(input.create);
          return {
            id: `attempt-${creates.length}`,
            status: "PENDING",
            mode: input.create.mode,
          };
        },
      },
      socialPublishAttemptMedia: {
        createMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    await prepareAutomaticSocialPublishing(
      "run-1",
      prisma,
      new Date("2026-08-21T14:00:00.000Z"),
    );

    expect(creates).toHaveLength(2);
    expect(creates.every((create) => create.assetId === "asset-x")).toBe(true);
    expect(
      creates.every(
        (create) => create.mediaUrl === "https://cdn.example.com/x.png",
      ),
    ).toBe(true);
  });
});

describe("social publisher public-caption boundary", () => {
  test("cleans a legacy queued caption again immediately before provider submission", async () => {
    const providerRequests: any[] = [];
    const databaseUpdates: any[] = [];
    const attempt = {
      id: "attempt-legacy",
      requestId: "request-legacy",
      status: "SUBMITTING",
      businessId: "business-1",
      runId: "run-1",
      assetId: null,
      platform: "instagram",
      mode: "NOW",
      scheduledFor: null,
      timezone: "America/Toronto",
      mediaUrl: null,
      caption: [
        "Make the next team lunch easier to coordinate.",
        "Service: Corporate catering.",
        "Audience: Corporate offices across Toronto and the GTA.",
        "Explore the options at https://example.com.",
      ].join("\n\n"),
      publisherAccount: {
        isActive: true,
        externalAccountId: "provider-instagram",
      },
      mediaItems: [],
      run: { topic: "Corporate catering" },
    };
    const prisma = {
      socialPublishAttempt: {
        updateMany: async () => ({ count: 1 }),
        findUnique: async () => attempt,
        update: async (input: any) => {
          databaseUpdates.push(input);
          return { ...attempt, ...input.data };
        },
      },
    } as unknown as PrismaClient;
    const client = {
      createPost: async (input: any) => {
        providerRequests.push(input);
        return { _id: "provider-post-1", status: "published" };
      },
    } as any;

    await submitSocialPublishAttempt("attempt-legacy", prisma, client);

    const expected =
      "Make the next team lunch easier to coordinate.\n\nExplore the options at https://example.com.";
    expect(providerRequests[0].content).toBe(expected);
    expect(databaseUpdates[0].data.caption).toBe(expected);
    expect(providerRequests[0].content).not.toContain("Audience:");
    expect(providerRequests[0].content).not.toContain("Service:");
  });
});
