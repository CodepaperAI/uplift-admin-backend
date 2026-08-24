import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { reconcileFutureSocialMorningSchedules } from "../services/social-schedule-reconciliation.service";

const now = new Date("2026-08-08T20:00:00.000Z");

function reconciliationPrisma(options: { applyCount?: number } = {}) {
  const topicQueries: any[] = [];
  const settingsUpdates: any[] = [];
  const topicUpdates: any[] = [];
  const topics = [
    {
      id: "topic-1",
      scheduledFor: new Date("2026-08-09T14:00:00.000Z"),
      timezone: "UTC",
    },
    {
      id: "topic-2",
      scheduledFor: new Date("2026-08-10T14:00:00.000Z"),
      timezone: "UTC",
    },
  ];
  const tx = {
    socialAutomationSettings: {
      update: async (input: any) => {
        settingsUpdates.push(input);
        return input;
      },
    },
    socialTopicPlan: {
      updateMany: async (input: any) => {
        topicUpdates.push(input);
        return { count: options.applyCount ?? 1 };
      },
    },
  };
  const prisma = {
    socialAutomationSettings: {
      findMany: async () => [
        {
          businessId: "business-1",
          cadencePerWeek: 7,
          timezone: "UTC",
          business: {
            businessCountry: "Canada",
            businessState: "Ontario",
            businessCity: "Toronto",
          },
        },
      ],
    },
    socialTopicPlan: {
      findMany: async (input: any) => {
        topicQueries.push(input);
        return topics;
      },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
  } as unknown as PrismaClient;

  return { prisma, topicQueries, settingsUpdates, topicUpdates };
}

describe("future social schedule reconciliation", () => {
  it("dry-runs future PLANNED topics without writing", async () => {
    const state = reconciliationPrisma();
    const summary = await reconcileFutureSocialMorningSchedules(
      { now },
      state.prisma,
    );

    expect(state.topicQueries[0]).toMatchObject({
      where: {
        businessId: "business-1",
        status: "PLANNED",
        scheduledFor: { gt: now },
      },
    });
    expect(summary).toMatchObject({
      applied: false,
      businessesScanned: 1,
      settingsNeedingUpdate: 1,
      settingsUpdated: 0,
      topicsScanned: 2,
      topicsNeedingUpdate: 2,
      topicsUpdated: 0,
      timezones: { "America/Toronto": 1 },
    });
    expect(state.settingsUpdates).toHaveLength(0);
    expect(state.topicUpdates).toHaveLength(0);
  });

  it("updates timezone and schedules with a claim-safe PLANNED guard", async () => {
    const state = reconciliationPrisma();
    const summary = await reconcileFutureSocialMorningSchedules(
      { apply: true, now },
      state.prisma,
    );

    expect(summary.settingsUpdated).toBe(1);
    expect(summary.topicsUpdated).toBe(2);
    expect(state.settingsUpdates[0]).toMatchObject({
      where: { businessId: "business-1" },
      data: { timezone: "America/Toronto" },
    });
    expect(
      state.topicUpdates.map((update) =>
        update.data.scheduledFor.toISOString(),
      ),
    ).toEqual([
      "2026-08-09T12:30:00.000Z",
      "2026-08-10T12:30:00.000Z",
    ]);
    expect(state.topicUpdates[0]).toMatchObject({
      where: {
        id: "topic-1",
        status: "PLANNED",
        scheduledFor: new Date("2026-08-09T14:00:00.000Z"),
      },
      data: { timezone: "America/Toronto" },
    });
  });

  it("does not report a raced topic as updated", async () => {
    const state = reconciliationPrisma({ applyCount: 0 });
    const summary = await reconcileFutureSocialMorningSchedules(
      { apply: true, now },
      state.prisma,
    );

    expect(summary.topicsNeedingUpdate).toBe(2);
    expect(summary.topicsUpdated).toBe(0);
  });

  it("is idempotent after topics are aligned to their existing local dates", async () => {
    let writes = 0;
    const prisma = {
      socialAutomationSettings: {
        findMany: async () => [
          {
            businessId: "business-1",
            timezone: "America/Toronto",
            business: {
              businessCountry: "Canada",
              businessState: "Ontario",
              businessCity: "Toronto",
            },
          },
        ],
      },
      socialTopicPlan: {
        findMany: async () => [
          {
            id: "topic-1",
            scheduledFor: new Date("2026-08-09T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
          {
            id: "topic-2",
            scheduledFor: new Date("2026-08-10T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
        ],
        updateMany: async () => {
          writes += 1;
          return { count: 1 };
        },
      },
      $transaction: async () => {
        writes += 1;
      },
    } as unknown as PrismaClient;

    const summary = await reconcileFutureSocialMorningSchedules(
      { now },
      prisma,
    );

    expect(summary).toMatchObject({
      settingsNeedingUpdate: 0,
      topicsScanned: 2,
      topicsNeedingUpdate: 0,
      topicsUpdated: 0,
    });
    expect(writes).toBe(0);
  });
});
