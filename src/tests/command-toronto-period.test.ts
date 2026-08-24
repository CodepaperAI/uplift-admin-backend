import { describe, expect, it } from "bun:test";
import {
  commandDayForDate,
  commandDayRange,
  commandDays,
  commandMonthForDate,
  commandMonthsEndingAt,
  commandMonthRange,
  currentCommandMonth,
} from "../command/toronto-period";

describe("Command Toronto accounting periods", () => {
  it("uses Toronto day boundaries across the spring DST transition", () => {
    const range = commandDayRange("2026-03-08", "2026-03-08");
    expect(range.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(range.dayCount).toBe(1);
  });

  it("uses Toronto day boundaries across the fall DST transition", () => {
    const range = commandDayRange("2026-11-01", "2026-11-01");
    expect(range.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("maps instants and inclusive day sequences to Toronto calendar days", () => {
    expect(commandDayForDate(new Date("2026-08-21T03:59:59.000Z"))).toBe(
      "2026-08-20",
    );
    expect(commandDays("2026-12-31", "2027-01-02")).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("rejects invalid or reversed calendar ranges", () => {
    expect(() => commandDayRange("2026-02-30", "2026-03-01")).toThrow();
    expect(() => commandDayRange("2026-03-02", "2026-03-01")).toThrow();
  });

  it("uses the daylight-saving offset for summer month boundaries", () => {
    const range = commandMonthRange("2026-08");
    expect(range.start.toISOString()).toBe("2026-08-01T04:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  it("uses the standard-time offset for winter month boundaries", () => {
    const range = commandMonthRange("2026-12");
    expect(range.start.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(range.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("chooses month from Toronto rather than UTC", () => {
    expect(currentCommandMonth(new Date("2026-09-01T02:00:00.000Z"))).toBe(
      "2026-08",
    );
  });

  it("keeps the prior Toronto month until the local boundary", () => {
    expect(commandMonthForDate(new Date("2026-08-01T03:59:59.000Z"))).toBe(
      "2026-07",
    );
    expect(commandMonthForDate(new Date("2026-08-01T04:00:00.000Z"))).toBe(
      "2026-08",
    );
  });

  it("returns an inclusive trailing month sequence across year boundaries", () => {
    expect(commandMonthsEndingAt("2026-01", 3)).toEqual([
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
  });
});
