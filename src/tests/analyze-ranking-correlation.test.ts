import { describe, expect, it } from "bun:test";
import {
  featuresOf,
  parseArgs,
} from "../scripts/analyze-ranking-correlation";
import type { RankedBlog } from "../services/ranking-dataset.service";
import type { ExpertVoiceVerdict } from "../services/expert-voice-judge.service";

function makeRankedBlog(over: Partial<RankedBlog> = {}): RankedBlog {
  return {
    blogId: "b1",
    businessId: "biz1",
    title: "T",
    liveUrl: "https://x.com/p",
    focusKeyword: "kw",
    outcome: { avgPosition: 5, clicks: 10, impressions: 100, ctr: 0.1, gscRows: 3 },
    features: {
      wordCount: 2000,
      h2Count: 6,
      h3Count: 4,
      faqCount: 3,
      listItemCount: 20,
      externalLinkCount: 3,
      internalLinkCount: 5,
      imageCount: 3,
      paragraphCount: 15,
      hasSchema: 1,
    },
    seoScore: 88,
    contentLlmScore: 7,
    content: "<p>x</p>",
    ...over,
  };
}

describe("parseArgs", () => {
  it("defaults", () => {
    const o = parseArgs([]);
    expect(o.limit).toBe(200);
    expect(o.sinceDays).toBe(90);
    expect(o.judge).toBe(false);
    expect(o.businessId).toBeUndefined();
  });

  it("parses flags", () => {
    const o = parseArgs(["--business", "b1", "--limit", "50", "--since", "180", "--judge"]);
    expect(o.businessId).toBe("b1");
    expect(o.limit).toBe(50);
    expect(o.sinceDays).toBe(180);
    expect(o.judge).toBe(true);
  });
});

describe("featuresOf", () => {
  it("maps structural features + scores", () => {
    const f = featuresOf(makeRankedBlog());
    expect(f.words).toBe(2000);
    expect(f.h2).toBe(6);
    expect(f.seoScore).toBe(88);
    expect(f.llmScore).toBe(7);
    expect(f.voiceOverall).toBeUndefined(); // no verdict passed
  });

  it("omits seo/llm score when null", () => {
    const f = featuresOf(makeRankedBlog({ seoScore: null, contentLlmScore: null }));
    expect("seoScore" in f).toBe(false);
    expect("llmScore" in f).toBe(false);
  });

  it("includes expert-voice dimensions when a verdict is supplied", () => {
    const verdict: ExpertVoiceVerdict = {
      overall: 8,
      dimensions: {
        specificity: 9,
        opinions: 7,
        livedExperience: 8,
        hedgingFreedom: 8,
        competitorUse: 6,
        offeringUse: 7,
      },
      critique: [],
    };
    const f = featuresOf(makeRankedBlog(), verdict);
    expect(f.voiceOverall).toBe(8);
    expect(f.voiceSpecificity).toBe(9);
    expect(f.voiceCompetitor).toBe(6);
  });
});
