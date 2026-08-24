import { describe, expect, it } from "bun:test";

import { computeDeltaSummary } from "../services/gmb-edit-impact.service";

type Row = {
  scanId: string;
  keyword: string;
  locationLabel: string | null;
  requestedAt: string;
  position: number | null;
  rankAbsolute: number | null;
};

function row(
  keyword: string,
  position: number | null,
  locationLabel: string | null = null,
): Row {
  return {
    scanId: `scan-${keyword}-${position ?? "x"}`,
    keyword,
    locationLabel,
    requestedAt: new Date().toISOString(),
    position,
    rankAbsolute: position,
  };
}

describe("computeDeltaSummary", () => {
  it("reports a single improvement", () => {
    const baseline = [row("shawarma toronto", 14)];
    const current = [row("shawarma toronto", 6)];
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.keywordsImproved).toBe(1);
    expect(summary.keywordsDeclined).toBe(0);
    expect(summary.keywordsUnchanged).toBe(0);
    expect(summary.avgPositionDelta).toBe(8);
    expect(summary.topImprovements).toHaveLength(1);
    expect(summary.topImprovements[0]).toMatchObject({
      keyword: "shawarma toronto",
      before: 14,
      after: 6,
      delta: 8,
    });
    expect(summary.topDeclines).toHaveLength(0);
  });

  it("reports a mix of improvements, declines, and unchanged", () => {
    const baseline = [
      row("a", 10),
      row("b", 5),
      row("c", 3),
      row("d", 20),
    ];
    const current = [
      row("a", 2), // improved by 8
      row("b", 7), // declined by 2
      row("c", 3), // unchanged
      row("d", 8), // improved by 12
    ];
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.keywordsImproved).toBe(2);
    expect(summary.keywordsDeclined).toBe(1);
    expect(summary.keywordsUnchanged).toBe(1);
    expect(summary.avgPositionDelta).toBe(4.5); // (8 + -2 + 0 + 12) / 4
    expect(summary.topImprovements[0]!.keyword).toBe("d");
    expect(summary.topImprovements[0]!.delta).toBe(12);
    expect(summary.topImprovements[1]!.delta).toBe(8);
    expect(summary.topDeclines[0]!.keyword).toBe("b");
    expect(summary.topDeclines[0]!.delta).toBe(-2);
  });

  it("handles keywords missing from the post snapshot", () => {
    const baseline = [row("a", 10), row("b", 5)];
    const current = [row("a", 4)]; // b disappeared
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.keywordsImproved).toBe(1);
    expect(summary.keywordsMissingPost).toBe(1);
    expect(summary.avgPositionDelta).toBe(6);
  });

  it("handles new keywords in the post snapshot that weren't in baseline", () => {
    const baseline = [row("a", 10)];
    const current = [row("a", 4), row("new keyword", 7)];
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.keywordsImproved).toBe(1);
    expect(summary.keywordsMissingBaseline).toBe(1);
  });

  it("treats null positions as missing data, not as 0", () => {
    const baseline = [row("a", null), row("b", 5)];
    const current = [row("a", 3), row("b", 2)];
    const summary = computeDeltaSummary(baseline, current);

    // Only 'b' should count (baseline.a is null)
    expect(summary.keywordsImproved).toBe(1);
    expect(summary.keywordsUnchanged).toBe(0);
    expect(summary.avgPositionDelta).toBe(3);
  });

  it("distinguishes the same keyword across different locations", () => {
    const baseline = [
      row("a", 10, "Toronto"),
      row("a", 15, "Mississauga"),
    ];
    const current = [
      row("a", 5, "Toronto"),
      row("a", 18, "Mississauga"),
    ];
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.keywordsImproved).toBe(1);
    expect(summary.keywordsDeclined).toBe(1);
    expect(summary.avgPositionDelta).toBe(1); // (5 + -3) / 2
  });

  it("returns null avgPositionDelta when no comparable pairs exist", () => {
    const summary = computeDeltaSummary([row("a", null)], [row("a", null)]);
    expect(summary.avgPositionDelta).toBeNull();
  });

  it("caps topImprovements and topDeclines at 5 each", () => {
    const baseline = Array.from({ length: 10 }, (_, i) =>
      row(`improve-${i}`, 20 + i),
    );
    const current = baseline.map((b, i) => ({ ...b, position: 5 + i }));
    const summary = computeDeltaSummary(baseline, current);

    expect(summary.topImprovements).toHaveLength(5);
    // Sorted by largest delta first
    expect(summary.topImprovements[0]!.delta).toBeGreaterThanOrEqual(
      summary.topImprovements[4]!.delta,
    );
  });
});
