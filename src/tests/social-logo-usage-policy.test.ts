import { describe, expect, test } from "bun:test";

import {
  markSocialArtworkLogoGenerated,
  resolveScheduledSocialArtworkLogo,
  selectWeeklyLogoLocalDate,
} from "../services/social-logo-usage-policy.service";
import { publishingSettingsSchema } from "../controllers/social-publishing.controller";

const timeZone = "America/Toronto";
const candidateDates = [
  "2026-08-17T12:30:00.000Z",
  "2026-08-18T12:30:00.000Z",
  "2026-08-19T12:30:00.000Z",
  "2026-08-20T12:30:00.000Z",
  "2026-08-21T12:30:00.000Z",
  "2026-08-22T12:30:00.000Z",
  "2026-08-23T12:30:00.000Z",
];

function runInput(runId: string, scheduledFor: string) {
  return {
    runId,
    businessId: "business-1",
    scheduledFor: new Date(scheduledFor),
    timeZone,
    platforms: ["linkedin"] as const,
  };
}

function policyPrisma(mode: "RECOMMENDED" | "ALWAYS" = "RECOMMENDED") {
  let assignment: any = null;
  const prisma: any = {
    socialAutomationSettings: {
      findUnique: async () => ({ logoUsageMode: mode }),
    },
    socialTopicPlan: {
      findMany: async () =>
        candidateDates.map((scheduledFor, index) => ({
          id: `topic-${index + 1}`,
          platforms: ["linkedin"],
          scheduledFor: new Date(scheduledFor),
          timezone: timeZone,
        })),
    },
    socialLogoWeekAssignment: {
      findUnique: async () => assignment,
      create: async ({ data }: any) => {
        assignment = {
          id: "assignment-1",
          claimedRunId: null,
          claimedAt: null,
          generatedAt: null,
          ...data,
        };
        return assignment;
      },
      updateMany: async ({ where, data }: any) => {
        if (!assignment) return { count: 0 };
        if (where.claimedRunId === null && assignment.claimedRunId !== null) {
          return { count: 0 };
        }
        if (typeof where.claimedRunId === "string" && assignment.claimedRunId !== where.claimedRunId) {
          return { count: 0 };
        }
        assignment = { ...assignment, ...data };
        return { count: 1 };
      },
    },
  };
  return { prisma, assignment: () => assignment };
}

describe("social artwork logo policy", () => {
  test("accepts only the two public logo settings and requires a patch field", () => {
    const businessId = "9d9d6400-8478-4f2b-b8a7-40060f02e814";
    expect(
      publishingSettingsSchema.parse({ businessId, logoUsageMode: "recommended" }),
    ).toMatchObject({ logoUsageMode: "recommended" });
    expect(
      publishingSettingsSchema.parse({ businessId, logoUsageMode: "always" }),
    ).toMatchObject({ logoUsageMode: "always" });
    expect(() =>
      publishingSettingsSchema.parse({ businessId, logoUsageMode: "sometimes" }),
    ).toThrow();
    expect(() => publishingSettingsSchema.parse({ businessId })).toThrow();
  });

  test("chooses one stable pseudo-random planned date for a business-local week", () => {
    const candidates = candidateDates.map((value) => value.slice(0, 10));
    const first = selectWeeklyLogoLocalDate({
      businessId: "business-1",
      weekStart: "2026-08-17",
      candidates,
    });
    const repeated = selectWeeklyLogoLocalDate({
      businessId: "business-1",
      weekStart: "2026-08-17",
      candidates: [...candidates].reverse(),
    });

    if (!first) throw new Error("Expected a selected weekly logo date");
    expect(candidates).toContain(first);
    expect(repeated).toBe(first);
  });

  test("recommended mode durably claims only one run in the selected week", async () => {
    const state = policyPrisma();
    const firstResult = await resolveScheduledSocialArtworkLogo(
      runInput("run-monday", candidateDates[0]!),
      state.prisma,
    );
    const selectedDate = state.assignment().selectedLocalDate as string;
    const selectedInstant = candidateDates.find((value) =>
      value.startsWith(selectedDate),
    )!;
    const selectedRunId = firstResult ? "run-monday" : "run-selected";

    if (!firstResult) {
      expect(
        await resolveScheduledSocialArtworkLogo(
          runInput(selectedRunId, selectedInstant),
          state.prisma,
        ),
      ).toBe(true);
    }
    expect(
      await resolveScheduledSocialArtworkLogo(
        runInput(selectedRunId, selectedInstant),
        state.prisma,
      ),
    ).toBe(true);
    expect(
      await resolveScheduledSocialArtworkLogo(
        runInput("run-duplicate", selectedInstant),
        state.prisma,
      ),
    ).toBe(false);
    expect(state.assignment().claimedRunId).toBe(selectedRunId);

    await markSocialArtworkLogoGenerated(selectedRunId, state.prisma);
    expect(state.assignment().generatedAt).toBeInstanceOf(Date);
  });

  test("always mode includes the logo without consuming a weekly assignment", async () => {
    const state = policyPrisma("ALWAYS");
    expect(
      await resolveScheduledSocialArtworkLogo(
        runInput("run-always", candidateDates[0]!),
        state.prisma,
      ),
    ).toBe(true);
    expect(state.assignment()).toBeNull();
  });

  test("text-only schedules do not consume the weekly logo assignment", async () => {
    const state = policyPrisma();
    expect(
      await resolveScheduledSocialArtworkLogo(
        {
          ...runInput("run-text-only", candidateDates[0]!),
          platforms: [],
        },
        state.prisma,
      ),
    ).toBe(false);
    expect(state.assignment()).toBeNull();
  });
});
