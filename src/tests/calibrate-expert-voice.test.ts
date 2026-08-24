import { describe, expect, it } from "bun:test";
import {
  parseArgs,
  summarizeScores,
} from "../scripts/calibrate-expert-voice";

describe("parseArgs", () => {
  it("uses sane defaults", () => {
    const o = parseArgs([]);
    expect(o.limit).toBe(10);
    expect(o.status).toBe("PUBLISH");
    expect(o.catalog).toBe(false);
    expect(o.competitorProducts).toBe(false);
    expect(o.businessId).toBeUndefined();
  });

  it("parses all flags", () => {
    const o = parseArgs([
      "--business",
      "b1",
      "--limit",
      "25",
      "--status",
      "DRAFT",
      "--catalog",
      "--competitor-products",
    ]);
    expect(o.businessId).toBe("b1");
    expect(o.limit).toBe(25);
    expect(o.status).toBe("DRAFT");
    expect(o.catalog).toBe(true);
    expect(o.competitorProducts).toBe(true);
  });

  it("falls back to limit 10 on invalid limit", () => {
    expect(parseArgs(["--limit", "abc"]).limit).toBe(10);
  });
});

describe("summarizeScores", () => {
  it("handles empty input", () => {
    const s = summarizeScores([]);
    expect(s).toEqual({
      count: 0,
      mean: 0,
      min: 0,
      max: 0,
      belowBar: { 6: 0, 7: 0, 8: 0 },
    });
  });

  it("computes mean/min/max and below-bar counts", () => {
    const s = summarizeScores([4, 6, 7, 9]);
    expect(s.count).toBe(4);
    expect(s.mean).toBe(6.5);
    expect(s.min).toBe(4);
    expect(s.max).toBe(9);
    expect(s.belowBar[6]).toBe(1); // 4
    expect(s.belowBar[7]).toBe(2); // 4, 6
    expect(s.belowBar[8]).toBe(3); // 4, 6, 7
  });

  it("supports custom bars", () => {
    const s = summarizeScores([5, 5, 9], [5]);
    expect(s.belowBar[5]).toBe(0); // strictly below
  });
});
