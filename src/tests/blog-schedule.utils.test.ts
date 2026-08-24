import { describe, expect, it } from "bun:test";
import {
  evaluateScheduleDue,
  getBusinessLocalScheduleSnapshot,
  getUtcScheduleQueryCeiling,
  inferBusinessTimeZone,
  normalizeScheduleTime,
} from "../utils/blog-schedule.utils";

describe("blog schedule helpers", () => {
  it("maps common North American business locations to a local timezone", () => {
    expect(
      inferBusinessTimeZone({
        businessCountry: "Canada",
        businessState: "Ontario",
      }).timeZone,
    ).toBe("America/Toronto");

    expect(
      inferBusinessTimeZone({
        businessCountry: "USA",
        businessState: "California",
      }).timeZone,
    ).toBe("America/Los_Angeles");
  });

  it("does not mark tomorrow morning as due on the prior local afternoon", () => {
    const evaluation = evaluateScheduleDue({
      publishDate: "2026-03-31",
      publishTime: "08:00",
      businessCountry: "Canada",
      businessState: "Ontario",
      now: new Date("2026-03-31T00:30:00.000Z"),
    });

    expect(evaluation.timeZone).toBe("America/Toronto");
    expect(evaluation.date).toBe("2026-03-30");
    expect(evaluation.time).toBe("20:30");
    expect(evaluation.isDue).toBe(false);
  });

  it("marks the schedule due once the local business time has passed", () => {
    const evaluation = evaluateScheduleDue({
      publishDate: "2026-03-30",
      publishTime: "08:00",
      businessCountry: "Canada",
      businessState: "Ontario",
      now: new Date("2026-03-31T00:30:00.000Z"),
    });

    expect(evaluation.isDue).toBe(true);
  });

  it("normalizes seconds in publish times and uses a one-day UTC query cushion", () => {
    expect(normalizeScheduleTime("09:00:00")).toBe("09:00");
    expect(getUtcScheduleQueryCeiling(new Date("2026-03-31T23:15:00.000Z"), 1)).toBe(
      "2026-04-01",
    );
  });

  it("falls back safely to UTC when business location data is missing", () => {
    const snapshot = getBusinessLocalScheduleSnapshot(
      {},
      new Date("2026-03-31T10:15:00.000Z"),
    );

    expect(snapshot.timeZone).toBe("Etc/UTC");
    expect(snapshot.date).toBe("2026-03-31");
    expect(snapshot.time).toBe("10:15");
  });
});
