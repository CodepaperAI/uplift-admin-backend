import { describe, expect, test } from "bun:test";
import { aggregatePipelineSourceConversion } from "../command/pipeline-metrics";

describe("Command pipeline metrics", () => {
  test("groups provider outcomes by source with an exact denominator", () => {
    expect(
      aggregatePipelineSourceConversion([
        { source: "Meta", status: "open", count: 5 },
        { source: "Meta", status: "won", count: 3 },
        { source: "Meta", status: "lost", count: 2 },
        { source: null, status: "won", count: 1 },
      ]),
    ).toEqual([
      {
        source: "Meta",
        leads: 10,
        won: 3,
        lost: 2,
        conversionPercent: "30.00",
      },
      {
        source: "Unattributed",
        leads: 1,
        won: 1,
        lost: 0,
        conversionPercent: "100.00",
      },
    ]);
  });
});
