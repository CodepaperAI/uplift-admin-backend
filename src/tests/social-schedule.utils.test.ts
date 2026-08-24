import { describe, expect, it } from "bun:test";

import {
  buildSocialSchedule,
  resolveSocialScheduleTimeZone,
  socialLocalDateTimeToUtc,
  socialScheduleLocalParts,
} from "../utils/social-schedule.utils";

describe("social morning schedule", () => {
  it("derives a regional timezone when the persisted value is the UTC default", () => {
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "UTC",
        businessCountry: "Canada",
        businessState: "Ontario",
      }),
    ).toBe("America/Toronto");
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "UTC",
        businessCountry: "USA",
        businessState: "California",
      }),
    ).toBe("America/Los_Angeles");
  });

  it("preserves a valid explicitly configured non-default timezone", () => {
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "America/Vancouver",
        businessCountry: "Canada",
        businessState: "Ontario",
      }),
    ).toBe("America/Vancouver");
  });

  it("repairs a stale derived timezone when an exact known city disagrees", () => {
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "America/Halifax",
        businessCountry: "Canada",
        businessState: "Nova Scotia",
        businessCity: "Brampton",
        serviceAreaLocations: ["Brampton"],
      }),
    ).toBe("America/Toronto");
  });

  it("prefers a connected provider timezone over the legacy UTC default", () => {
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "UTC",
        providerTimeZone: "America/Vancouver",
        businessCountry: "Canada",
        businessState: "Ontario",
      }),
    ).toBe("America/Vancouver");
  });

  it("recovers shifted Canadian address fields from existing onboarding data", () => {
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "UTC",
        businessCountry: "ON",
        businessState: "Mississauga",
        businessCity: "Unit 201B",
        serviceAreaLocations: ["Mississauga"],
      }),
    ).toBe("America/Toronto");
    expect(
      resolveSocialScheduleTimeZone({
        configuredTimeZone: "UTC",
        businessCountry: "BC",
        businessState: "White Rock",
        businessCity: "1493 Foster St",
        serviceAreaLocations: ["White Rock"],
      }),
    ).toBe("America/Vancouver");
  });

  it("converts local morning times with seasonal DST offsets", () => {
    expect(
      socialLocalDateTimeToUtc(
        { year: 2026, month: 8, day: 9, hour: 8, minute: 30 },
        "America/Toronto",
      ).toISOString(),
    ).toBe("2026-08-09T12:30:00.000Z");
    expect(
      socialLocalDateTimeToUtc(
        { year: 2026, month: 1, day: 9, hour: 8, minute: 30 },
        "America/Toronto",
      ).toISOString(),
    ).toBe("2026-01-09T13:30:00.000Z");
  });

  it("keeps every cadence inside 08:00–09:00 in the business timezone", () => {
    for (const cadencePerWeek of [3, 5, 7, 10]) {
      const schedule = buildSocialSchedule({
        count: 42,
        cadencePerWeek,
        now: new Date("2026-03-07T20:00:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const localParts = schedule.map((date) =>
        socialScheduleLocalParts(date, "America/Los_Angeles"),
      );

      expect(schedule).toHaveLength(42);
      expect(schedule.every((date, index) => index === 0 || date > schedule[index - 1]!)).toBe(
        true,
      );
      expect(localParts.every((parts) => parts.hour === 8)).toBe(true);
      expect(
        localParts.every((parts) => parts.minute >= 0 && parts.minute < 60),
      ).toBe(true);
    }
  });

  it("spreads two same-day slots instead of creating duplicate instants", () => {
    const schedule = buildSocialSchedule({
      count: 4,
      cadencePerWeek: 10,
      now: new Date("2026-08-08T20:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    const localParts = schedule.map((date) =>
      socialScheduleLocalParts(date, "Asia/Kolkata"),
    );

    expect(localParts.slice(0, 2).map((parts) => parts.minute)).toEqual([20, 40]);
    expect(new Set(schedule.map((date) => date.toISOString())).size).toBe(4);
  });

  it("fails closed on an invalid timezone", () => {
    expect(() =>
      buildSocialSchedule({
        count: 1,
        cadencePerWeek: 7,
        timeZone: "Not/A_Timezone",
      }),
    ).toThrow("Invalid social scheduling timezone");
  });
});
