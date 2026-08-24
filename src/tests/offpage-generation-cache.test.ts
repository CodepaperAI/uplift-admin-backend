import { describe, expect, it } from "bun:test";
import { finalizeOffPageGenerationCandidates } from "../services/offpage/offpage-opportunities.service";
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

describe("finalizeOffPageGenerationCandidates", () => {
  it("stores only shown opportunities while preserving hidden/rejected analytics", () => {
    const highConfidence = opportunity({
      key: "directory:google",
      confidence: 92,
      confidenceLevel: "high",
      evidenceSources: ["directory_reachability", "known_submission_map"],
      sourceType: "business_profile",
      submissionUrl: "https://www.google.com/business/",
      submissionUrlType: "direct_claim",
      pricingModel: "free",
    });
    const needsReview = opportunity({
      key: "reddit:thread",
      leverKey: "reddit",
      confidence: 55,
      confidenceLevel: "needs_review",
      evidenceSources: ["live_search", "thread_page"],
      sourceType: "reddit_thread",
    });
    const lowConfidence = opportunity({
      key: "directory:unknown",
      confidence: 31,
      confidenceLevel: "low",
      evidenceSources: ["directory_reachability"],
      sourceType: "directory",
    });

    const result = finalizeOffPageGenerationCandidates(
      [highConfidence, needsReview, lowConfidence],
      [
        { reason: "wrong country for this business" },
        { reason: "previously dismissed: already tried" },
      ],
    );

    expect(result.opportunities.map((item) => item.key)).toEqual([
      "directory:google",
      "reddit:thread",
    ]);
    expect(result.qualitySummary.totalCandidates).toBe(3);
    expect(result.qualitySummary.shown).toBe(2);
    expect(result.qualitySummary.hiddenLowConfidence).toBe(1);
    expect(result.qualitySummary.rejected).toBe(2);
    expect(result.qualitySummary.highConfidence).toBe(1);
    expect(result.qualitySummary.needsReview).toBe(1);
    expect(result.qualitySummary.lowConfidence).toBe(1);
    expect(result.qualitySummary.bySourceType.reddit_thread).toBe(1);
    expect(result.qualitySummary.evidenceSourceCounts.directory_reachability).toBe(2);
    expect(result.qualitySummary.rejectionReasons.wrong_location).toBe(1);
    expect(result.qualitySummary.rejectionReasons.dismissed_feedback).toBe(1);
  });
});
