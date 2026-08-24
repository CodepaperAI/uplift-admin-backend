import { describe, expect, it } from "bun:test";

import {
  resolveAutomaticSocialPublishSlots,
  resolveSocialTopicImagePlatforms,
  resolveSocialTopicPublishPlatforms,
} from "../utils/social-platform-schedule.utils";

describe("automatic social platform schedule policy", () => {
  it("creates distinct X lunch and evening slots in the business timezone", () => {
    const slots = resolveAutomaticSocialPublishSlots({
      platform: "x",
      topicScheduledFor: new Date("2026-08-20T12:30:00.000Z"),
      timeZone: "America/Toronto",
    });

    expect(slots).toEqual([
      {
        id: "lunch",
        scheduledFor: new Date("2026-08-20T16:00:00.000Z"),
        mediaMode: "none",
      },
      {
        id: "evening",
        scheduledFor: new Date("2026-08-20T22:00:00.000Z"),
        mediaMode: "none",
      },
    ]);
  });

  it("keeps DST conversion correct in winter", () => {
    const slots = resolveAutomaticSocialPublishSlots({
      platform: "x",
      topicScheduledFor: new Date("2026-01-08T13:30:00.000Z"),
      timeZone: "America/Toronto",
    });

    expect(slots.map((slot) => slot.scheduledFor.toISOString())).toEqual([
      "2026-01-08T17:00:00.000Z",
      "2026-01-08T23:00:00.000Z",
    ]);
  });

  it("enables X media on Saturday and Sunday only", () => {
    const saturday = resolveAutomaticSocialPublishSlots({
      platform: "x",
      topicScheduledFor: new Date("2026-08-22T12:30:00.000Z"),
      timeZone: "America/Toronto",
    });
    const sunday = resolveAutomaticSocialPublishSlots({
      platform: "x",
      topicScheduledFor: new Date("2026-08-23T12:30:00.000Z"),
      timeZone: "America/Toronto",
    });

    expect(saturday.every((slot) => slot.mediaMode === "image")).toBe(true);
    expect(sunday.every((slot) => slot.mediaMode === "image")).toBe(true);
  });

  it("schedules Instagram and Facebook only Tuesday, Thursday, Saturday, and Sunday at 09:00 local", () => {
    const eligibleDates = [
      "2026-08-18T12:30:00.000Z",
      "2026-08-20T12:30:00.000Z",
      "2026-08-22T12:30:00.000Z",
      "2026-08-23T12:30:00.000Z",
    ];
    for (const topicDate of eligibleDates) {
      for (const platform of ["instagram", "facebook"] as const) {
        expect(
          resolveAutomaticSocialPublishSlots({
            platform,
            topicScheduledFor: new Date(topicDate),
            timeZone: "America/Toronto",
          }),
        ).toEqual([
          {
            id: "primary",
            scheduledFor: new Date(
              topicDate.replace("T12:30:00.000Z", "T13:00:00.000Z"),
            ),
            mediaMode: "image",
          },
        ]);
      }
    }

    for (const topicDate of [
      "2026-08-17T12:30:00.000Z",
      "2026-08-19T12:30:00.000Z",
      "2026-08-21T12:30:00.000Z",
    ]) {
      expect(
        resolveAutomaticSocialPublishSlots({
          platform: "instagram",
          topicScheduledFor: new Date(topicDate),
          timeZone: "America/Toronto",
        }),
      ).toEqual([]);
    }
  });

  it("keeps the Instagram/Facebook 09:00 wall clock through winter DST", () => {
    expect(
      resolveAutomaticSocialPublishSlots({
        platform: "facebook",
        topicScheduledFor: new Date("2026-01-06T13:30:00.000Z"),
        timeZone: "America/Toronto",
      })[0]?.scheduledFor.toISOString(),
    ).toBe("2026-01-06T14:00:00.000Z");
  });

  it("keeps mixed-platform eligibility and image requirements independent", () => {
    const platforms = ["instagram", "facebook", "linkedin", "x"] as const;
    const monday = new Date("2026-08-17T12:30:00.000Z");
    const saturday = new Date("2026-08-22T12:30:00.000Z");

    expect(
      resolveSocialTopicPublishPlatforms({
        platforms,
        topicScheduledFor: monday,
        timeZone: "America/Toronto",
      }),
    ).toEqual(["linkedin", "x"]);
    expect(
      resolveSocialTopicImagePlatforms({
        platforms,
        topicScheduledFor: monday,
        timeZone: "America/Toronto",
      }),
    ).toEqual(["linkedin"]);
    expect(
      resolveSocialTopicPublishPlatforms({
        platforms,
        topicScheduledFor: saturday,
        timeZone: "America/Toronto",
      }),
    ).toEqual(["instagram", "facebook", "linkedin", "x"]);
    expect(
      resolveSocialTopicImagePlatforms({
        platforms,
        topicScheduledFor: saturday,
        timeZone: "America/Toronto",
      }),
    ).toEqual(["instagram", "facebook", "linkedin", "x"]);
  });

  it("retains image generation for other platforms and non-calendar runs", () => {
    expect(
      resolveSocialTopicImagePlatforms({
        platforms: ["instagram", "facebook", "linkedin", "x"],
        topicScheduledFor: new Date("2026-08-20T12:30:00.000Z"),
        timeZone: "America/Toronto",
      }),
    ).toEqual(["instagram", "facebook", "linkedin"]);
    expect(
      resolveSocialTopicImagePlatforms({
        platforms: ["x"],
        topicScheduledFor: null,
        timeZone: null,
      }),
    ).toEqual(["x"]);
  });
});
