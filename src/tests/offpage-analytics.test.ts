import { describe, expect, it } from "bun:test";
import { summarizeOffPageQuality } from "../services/offpage/offpage-analytics.service";
import type { Opportunity } from "../services/offpage/offpage-types";

function opportunity(overrides: Partial<Opportunity>): Opportunity {
  return {
    leverKey: "directory",
    key: "directory-google",
    title: "List Example on Google Business Profile",
    url: "https://www.google.com/business/",
    action: "Create a listing.",
    priority: 90,
    rationale: "Core citation.",
    source: "researched",
    status: "todo",
    businessTypeFit: "local",
    ...overrides,
  };
}

describe("summarizeOffPageQuality", () => {
  it("summarizes shown, hidden, confidence, evidence and rejection analytics", () => {
    const candidates = [
      opportunity({
        key: "reddit:one",
        leverKey: "reddit",
        confidence: 90,
        confidenceLevel: "high",
        sourceType: "reddit_thread",
        evidenceSources: ["live_search", "thread_page"],
      }),
      opportunity({
        key: "directory:one",
        confidence: 70,
        confidenceLevel: "medium",
        sourceType: "business_profile",
        evidenceSources: ["directory_reachability", "known_submission_map"],
      }),
      opportunity({
        key: "directory:low",
        confidence: 30,
        confidenceLevel: "low",
        sourceType: "directory",
        evidenceSources: ["directory_reachability"],
      }),
    ];

    const summary = summarizeOffPageQuality(
      candidates,
      candidates.slice(0, 2),
      [
        { reason: "wrong location" },
        { reason: "previously dismissed: not relevant" },
      ],
    );

    expect(summary.totalCandidates).toBe(3);
    expect(summary.shown).toBe(2);
    expect(summary.hiddenLowConfidence).toBe(1);
    expect(summary.rejected).toBe(2);
    expect(summary.averageConfidence).toBe(63);
    expect(summary.highConfidence).toBe(1);
    expect(summary.mediumConfidence).toBe(1);
    expect(summary.lowConfidence).toBe(1);
    expect(summary.byLever.directory).toBe(2);
    expect(summary.bySourceType.reddit_thread).toBe(1);
    expect(summary.evidenceSourceCounts.directory_reachability).toBe(2);
    expect(summary.rejectionReasons.wrong_location).toBe(1);
    expect(summary.rejectionReasons.dismissed_feedback).toBe(1);
  });
});
