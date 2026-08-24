import { describe, expect, test } from "bun:test";
import { parseCommandCoachingBrief } from "../command/coaching-brief.service";

describe("Command coaching brief parser", () => {
  test("accepts the binding monthly coaching contract", () => {
    const brief = parseCommandCoachingBrief({
      verdict: "Strong discovery with inconsistent next-step discipline.",
      patterns: ["Specific discovery questions", "Late confirmation of ownership"],
      priorities: [
        "Confirm the decision process",
        "Quantify the cost of delay",
        "Book the next meeting while live",
      ],
      managerAction: "Role-play next-step confirmation in the next one-to-one.",
    });
    expect(brief.priorities).toHaveLength(3);
  });

  test("rejects a brief without exactly three ranked priorities", () => {
    expect(() =>
      parseCommandCoachingBrief({
        verdict: "Incomplete",
        patterns: [],
        priorities: ["Only one"],
        managerAction: "Review the call.",
      }),
    ).toThrow();
  });
});
