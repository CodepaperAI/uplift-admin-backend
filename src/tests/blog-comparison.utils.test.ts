import { describe, expect, it } from "bun:test";
import {
  aggregateComparisons,
  compareDrafts,
  countMentions,
  namesMentioned,
  type DraftMetrics,
} from "../utils/blog-comparison.utils";

const DIMS = {
  specificity: 5,
  opinions: 5,
  livedExperience: 5,
  hedgingFreedom: 5,
  competitorUse: 5,
  offeringUse: 5,
};

function metrics(over: Partial<DraftMetrics> = {}): DraftMetrics {
  return {
    voiceOverall: 5,
    voiceDimensions: { ...DIMS },
    competitorsMentioned: 0,
    productsMentioned: 0,
    wordCount: 2000,
    ...over,
  };
}

describe("countMentions", () => {
  it("counts case-insensitively", () => {
    expect(countMentions("Acme is great, ACME wins, acme!", "Acme")).toBe(3);
    expect(countMentions("nothing here", "Acme")).toBe(0);
    expect(countMentions("", "Acme")).toBe(0);
  });

  it("escapes regex metacharacters in the name", () => {
    expect(countMentions("buy C++ books and C++ kits", "C++")).toBe(2);
  });
});

describe("namesMentioned", () => {
  it("returns the names present in stripped HTML, deduped", () => {
    const html = "<p>We beat <b>Acme</b> and Rival Co</p>";
    expect(namesMentioned(html, ["Acme", "Rival Co", "Nobody"])).toEqual([
      "Acme",
      "Rival Co",
    ]);
  });
});

describe("compareDrafts", () => {
  it("calls a +1 voice gain better and a -1 loss worse", () => {
    expect(compareDrafts(metrics(), metrics({ voiceOverall: 6 })).verdict).toBe("better");
    expect(compareDrafts(metrics(), metrics({ voiceOverall: 4 })).verdict).toBe("worse");
  });

  it("breaks similar-voice ties on substance usage", () => {
    // voice flat, but new uses +2 more competitors/products → better
    const better = compareDrafts(
      metrics(),
      metrics({ competitorsMentioned: 1, productsMentioned: 1 }),
    );
    expect(better.verdict).toBe("better");

    const worse = compareDrafts(
      metrics({ competitorsMentioned: 2, productsMentioned: 1 }),
      metrics(),
    );
    expect(worse.verdict).toBe("worse");

    const similar = compareDrafts(metrics(), metrics({ competitorsMentioned: 1 }));
    expect(similar.verdict).toBe("similar");
  });

  it("reports per-dimension deltas and field deltas", () => {
    const cmp = compareDrafts(
      metrics(),
      metrics({
        voiceOverall: 7,
        wordCount: 2500,
        voiceDimensions: { ...DIMS, specificity: 9 },
      }),
    );
    expect(cmp.voiceDelta).toBe(2);
    expect(cmp.wordCountDelta).toBe(500);
    expect(cmp.dimensionDeltas.specificity).toBe(4);
    expect(cmp.dimensionDeltas.opinions).toBe(0);
  });
});

describe("aggregateComparisons", () => {
  it("rolls up verdicts and average voice delta", () => {
    const a = compareDrafts(metrics(), metrics({ voiceOverall: 7 })); // better +2
    const b = compareDrafts(metrics(), metrics({ voiceOverall: 4 })); // worse -1
    const c = compareDrafts(metrics(), metrics()); // similar 0
    const agg = aggregateComparisons([a, b, c]);
    expect(agg.total).toBe(3);
    expect(agg.better).toBe(1);
    expect(agg.worse).toBe(1);
    expect(agg.similar).toBe(1);
    expect(agg.avgVoiceDelta).toBe(round3((2 - 1 + 0) / 3));
  });

  it("handles empty input", () => {
    expect(aggregateComparisons([])).toEqual({
      total: 0,
      better: 0,
      worse: 0,
      similar: 0,
      avgVoiceDelta: 0,
    });
  });
});

function round3(n: number): number {
  return Math.round(n * 100) / 100;
}
