import { describe, expect, it } from "bun:test";

import {
  buildPlatformAwareSocialTopicSchedule,
  buildSocialSchedule,
  parseSocialStrategyDraft,
  resolveSocialCadencePerWeek,
  resolveSocialTopicCadencePerWeek,
  SOCIAL_TOPIC_PLANNER_MODEL,
  SOCIAL_TOPIC_PLANNER_VERSION,
  socialTopicCountForThirtyDays,
} from "../services/social-topic-planner.service";

describe("social topic planner contracts", () => {
  it("uses the pinned Luna planner model and version", () => {
    expect(SOCIAL_TOPIC_PLANNER_MODEL).toBe("gpt-5.6-luna");
    expect(SOCIAL_TOPIC_PLANNER_VERSION).toBe(
      "social-topic-planner-v5-platform-calendars",
    );
  });

  it("maps onboarding cadence without unbounded values", () => {
    expect(resolveSocialCadencePerWeek("3_per_week")).toBe(3);
    expect(resolveSocialCadencePerWeek("5_per_week")).toBe(5);
    expect(resolveSocialCadencePerWeek("daily")).toBe(7);
    expect(resolveSocialCadencePerWeek("10_per_week")).toBe(10);
    expect(resolveSocialCadencePerWeek(null)).toBe(7);
    expect(socialTopicCountForThirtyDays(7)).toBe(30);
    expect(socialTopicCountForThirtyDays(10)).toBe(42);
    expect(socialTopicCountForThirtyDays(999)).toBe(42);
    expect(resolveSocialTopicCadencePerWeek(3, ["instagram", "x"])).toBe(7);
    expect(resolveSocialTopicCadencePerWeek(3, ["instagram"])).toBe(7);
    expect(resolveSocialTopicCadencePerWeek(3, ["linkedin"])).toBe(3);
  });

  it("creates an ordered UTC schedule for the next local morning", () => {
    const schedule = buildSocialSchedule({
      count: 3,
      cadencePerWeek: 7,
      now: new Date("2026-08-08T20:00:00.000Z"),
      timeZone: "America/Toronto",
    });
    expect(schedule.map((date) => date.toISOString())).toEqual([
      "2026-08-09T12:30:00.000Z",
      "2026-08-10T12:30:00.000Z",
      "2026-08-11T12:30:00.000Z",
    ]);
  });

  it("builds Instagram/Facebook topics only for their four eligible weekdays", () => {
    const schedule = buildPlatformAwareSocialTopicSchedule({
      cadencePerWeek: 3,
      platforms: ["instagram", "facebook"],
      now: new Date("2026-08-16T20:00:00.000Z"),
      timeZone: "America/Toronto",
    });

    expect(
      schedule.slice(0, 4).map((entry) => ({
        scheduledFor: entry.scheduledFor.toISOString(),
        platforms: entry.platforms,
      })),
    ).toEqual([
      {
        scheduledFor: "2026-08-18T12:30:00.000Z",
        platforms: ["instagram", "facebook"],
      },
      {
        scheduledFor: "2026-08-20T12:30:00.000Z",
        platforms: ["instagram", "facebook"],
      },
      {
        scheduledFor: "2026-08-22T12:30:00.000Z",
        platforms: ["instagram", "facebook"],
      },
      {
        scheduledFor: "2026-08-23T12:30:00.000Z",
        platforms: ["instagram", "facebook"],
      },
    ]);
    expect(
      schedule.every((entry) =>
        [0, 2, 4, 6].includes(
          new Date(
            entry.scheduledFor.toLocaleString("en-US", {
              timeZone: "America/Toronto",
            }),
          ).getDay(),
        ),
      ),
    ).toBe(true);
  });

  it("merges independent X, Instagram/Facebook, and cadence calendars", () => {
    const schedule = buildPlatformAwareSocialTopicSchedule({
      cadencePerWeek: 3,
      platforms: ["instagram", "facebook", "linkedin", "x"],
      now: new Date("2026-08-16T20:00:00.000Z"),
      timeZone: "America/Toronto",
    });

    expect(schedule).toHaveLength(30);
    expect(schedule.every((entry) => entry.platforms.includes("x"))).toBe(true);
    expect(
      schedule.filter((entry) => entry.platforms.includes("linkedin")),
    ).toHaveLength(13);
    expect(
      schedule
        .filter((entry) => entry.platforms.includes("instagram"))
        .every((entry) => entry.platforms.includes("facebook")),
    ).toBe(true);
  });

  it("rejects duplicate or incomplete planner output", () => {
    const topic = {
      topic: "How our service works",
      contentPillar: "Education",
      objective: "education",
      hook: "A clear look at the process",
      cta: "Learn more",
      contentType: "guide",
    } as const;
    expect(() =>
      parseSocialStrategyDraft(
        {
          strategySummary: "A useful factual strategy for the next month.",
          contentPillars: ["Education", "Trust", "Services"],
          topics: [topic, topic],
        },
        2,
      ),
    ).toThrow("duplicate topics");
  });
});
