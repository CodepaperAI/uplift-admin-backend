import { describe, expect, test } from "bun:test";
import { parseCommandCallReview } from "../command/call-review.service";

describe("Command call review parser", () => {
  test("accepts the strict coaching contract", () => {
    const review = parseCommandCallReview({
      scores: {
        openingAndRapport: 4,
        discoveryDepth: 5,
        valueFraming: 4,
        objectionHandling: 3,
        nextStepSecured: 5,
        talkListenBalance: 4,
      },
      strengths: ["Confirmed the buyer's goals"],
      improvements: ["Quantify the cost of delay"],
      missedSignal: "The buyer mentioned an internal deadline that was not explored.",
      focus: "Ask one follow-up question whenever the buyer mentions timing.",
    });
    expect(review.scores.discoveryDepth).toBe(5);
    expect(review.focus).toContain("follow-up");
  });

  test("rejects malformed output instead of crashing a page", () => {
    expect(() =>
      parseCommandCallReview({
        scores: { openingAndRapport: 6 },
        strengths: [],
      }),
    ).toThrow();
  });
});
