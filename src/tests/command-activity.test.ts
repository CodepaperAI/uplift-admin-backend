import { describe, expect, test } from "bun:test";
import { COMMAND_ACTIVITY_INPUT } from "../command/activity-input";
import { activityRatios } from "../command/activity-metrics";

describe("Command activity", () => {
  test("calculates binding activity ratios", () => {
    expect(activityRatios({ calls: 100, connects: 25, meetingsBooked: 10, meetingsHeld: 8 }, 4)).toEqual({
      connectRatePercent: "25",
      showRatePercent: "80",
      callsPerClose: "25",
      meetingsPerClose: "2",
    });
  });

  test("returns unavailable ratios rather than dividing by zero", () => {
    expect(activityRatios({ calls: 0, connects: 0, meetingsBooked: 0, meetingsHeld: 0 }, 0)).toEqual({ connectRatePercent: null, showRatePercent: null, callsPerClose: null, meetingsPerClose: null });
  });

  test("rejects impossible manual activity", () => {
    expect(COMMAND_ACTIVITY_INPUT.safeParse({ repId: "1d651927-000d-4e44-8f6e-d714af1d50d0", periodMonth: "2026-08", calls: 10, connects: 11, meetingsBooked: 2, meetingsHeld: 1 }).success).toBe(false);
    expect(COMMAND_ACTIVITY_INPUT.safeParse({ repId: "1d651927-000d-4e44-8f6e-d714af1d50d0", periodMonth: "2026-08", calls: 10, connects: 5, meetingsBooked: 2, meetingsHeld: 3 }).success).toBe(false);
  });
});
