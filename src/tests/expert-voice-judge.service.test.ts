import { describe, expect, it } from "bun:test";
import {
  applyDimensionWeights,
  buildExpertVoiceJudgeBrief,
  buildRevisionMessage,
  decideCritiqueAction,
  parseExpertVoiceVerdict,
  pickBestDraft,
  stripHtmlForJudge,
  type ExpertVoiceVerdict,
} from "../services/expert-voice-judge.service";
import type { OfferingSubstance } from "../utils/blog-substance.utils";

const SERVICE_OFFERING: OfferingSubstance = {
  type: "service",
  categories: ["Catering"],
  items: ["Platters"],
};

describe("stripHtmlForJudge", () => {
  it("strips tags, scripts, styles and collapses whitespace", () => {
    const html =
      "<style>.a{color:red}</style><h1>Title</h1><p>Hello&nbsp;there</p><script>evil()</script>";
    const out = stripHtmlForJudge(html);
    expect(out).toBe("Title Hello there");
  });

  it("handles non-string input", () => {
    expect(stripHtmlForJudge(undefined as unknown as string)).toBe("");
  });

  it("excludes application-owned profile, TOC, and author boilerplate", () => {
    const html = [
      '<section data-uplift-assembled="verified-business-facts"><p>Verified profile dump</p></section>',
      '<nav data-uplift-component="article-toc"><a href="#one">Contents</a></nav>',
      "<p>Writer-owned decision guidance.</p>",
      '<div data-uplift-assembled="author-bio"><h3>About</h3><p>Author boilerplate</p></div>',
    ].join("");
    expect(stripHtmlForJudge(html)).toBe("Writer-owned decision guidance.");
  });
});

describe("buildExpertVoiceJudgeBrief", () => {
  it("includes keyword, competitor names and comparative flag", () => {
    const brief = buildExpertVoiceJudgeBrief({
      content: "<p>" + "word ".repeat(50) + "</p>",
      title: "Best Caterers in Calgary",
      keyword: "best caterers calgary",
      businessName: "Moose Catering",
      competitors: [{ name: "Rival Eats" }],
      offering: SERVICE_OFFERING,
    });
    expect(brief).toContain("Best Caterers in Calgary");
    expect(brief).toContain("best caterers calgary");
    expect(brief).toContain("Rival Eats");
    // "best" makes it comparative
    expect(brief).toContain("comparative (should reference competitors): yes");
    expect(brief).toContain("Return ONLY minified JSON");
  });

  it("marks non-comparative topics", () => {
    const brief = buildExpertVoiceJudgeBrief({
      content: "x".repeat(300),
      title: "How catering works",
      keyword: "how catering works",
      businessName: "Moose",
      competitors: [],
      offering: SERVICE_OFFERING,
    });
    expect(brief).toContain("comparative (should reference competitors): no");
    expect(brief).toContain("Real competitors available: (none provided)");
  });

  it("expects detailed coverage only for offerings backed by first-party evidence", () => {
    const brief = buildExpertVoiceJudgeBrief({
      content: "x".repeat(300),
      title: "Fitness Services",
      keyword: "fitness services",
      businessName: "Example Fitness",
      competitors: [],
      offering: {
        type: "service",
        categories: [],
        items: ["Group fitness classes", "Recovery rooms"],
      },
      evidenceBackedOfferings: ["Group fitness classes"],
    });
    expect(brief).toContain(
      "Evidence-backed offerings available for detailed coverage: Group fitness classes",
    );
    expect(brief).not.toContain("Recovery rooms");
    expect(brief).toContain(
      "Never penalize omission of an offering that",
    );
  });
});

describe("parseExpertVoiceVerdict", () => {
  it("parses clean JSON", () => {
    const v = parseExpertVoiceVerdict(
      `{"specificity":8,"opinions":7,"livedExperience":6,"hedgingFreedom":9,"competitorUse":10,"offeringUse":8,"overall":8,"critique":["tighten intro"]}`,
    );
    expect(v.overall).toBe(8);
    expect(v.dimensions.specificity).toBe(8);
    expect(v.critique).toEqual(["tighten intro"]);
  });

  it("tolerates code fences and surrounding prose", () => {
    const v = parseExpertVoiceVerdict(
      'Here you go:\n```json\n{"overall":5,"critique":[]}\n```\nthanks',
    );
    expect(v.overall).toBe(5);
  });

  it("averages dimensions when overall is missing", () => {
    const v = parseExpertVoiceVerdict(
      `{"specificity":6,"opinions":6,"livedExperience":6,"hedgingFreedom":6,"competitorUse":6,"offeringUse":6,"critique":[]}`,
    );
    expect(v.overall).toBe(6);
  });

  it("clamps out-of-range scores", () => {
    const v = parseExpertVoiceVerdict(`{"specificity":50,"opinions":-3,"overall":99}`);
    expect(v.dimensions.specificity).toBe(10);
    expect(v.dimensions.opinions).toBe(0);
    expect(v.overall).toBe(10);
  });

  it("returns zero fallback for non-JSON and empty input", () => {
    expect(parseExpertVoiceVerdict("not json at all").overall).toBe(0);
    expect(parseExpertVoiceVerdict("").overall).toBe(0);
    expect(parseExpertVoiceVerdict(undefined as unknown as string).overall).toBe(0);
  });

  it("filters non-string critique entries and caps length", () => {
    const v = parseExpertVoiceVerdict(
      `{"overall":4,"critique":["a", "", 5, "  b  ", null]}`,
    );
    expect(v.critique).toEqual(["a", "b"]);
  });
});

describe("decideCritiqueAction", () => {
  const base = { maxRevisions: 1, bar: 7 };

  it("saves when at or above the bar", () => {
    expect(decideCritiqueAction({ ...base, overall: 7, attemptNumber: 1 }).action).toBe("save");
    expect(decideCritiqueAction({ ...base, overall: 9, attemptNumber: 1 }).action).toBe("save");
  });

  it("revises when below the bar and budget remains", () => {
    const d = decideCritiqueAction({ ...base, overall: 5, attemptNumber: 1 });
    expect(d.action).toBe("revise");
  });

  it("saves when below the bar but budget exhausted", () => {
    const d = decideCritiqueAction({ ...base, overall: 5, attemptNumber: 2 });
    expect(d.action).toBe("save");
    expect(d.reason).toContain("exhausted");
  });

  it("never revises when maxRevisions is 0", () => {
    expect(
      decideCritiqueAction({ overall: 1, attemptNumber: 1, maxRevisions: 0, bar: 7 }).action,
    ).toBe("save");
  });
});

describe("pickBestDraft", () => {
  it("returns undefined for empty", () => {
    expect(pickBestDraft([])).toBeUndefined();
  });

  it("picks the highest score", () => {
    const best = pickBestDraft([
      { overall: 4, snapshot: "a" },
      { overall: 8, snapshot: "b" },
      { overall: 6, snapshot: "c" },
    ]);
    expect(best?.snapshot).toBe("b");
  });

  it("keeps the earliest on ties (stable)", () => {
    const best = pickBestDraft([
      { overall: 7, snapshot: "first" },
      { overall: 7, snapshot: "second" },
    ]);
    expect(best?.snapshot).toBe("first");
  });
});

describe("buildRevisionMessage", () => {
  const verdict: ExpertVoiceVerdict = {
    overall: 4,
    dimensions: {
      specificity: 3,
      opinions: 4,
      livedExperience: 3,
      hedgingFreedom: 5,
      competitorUse: 6,
      offeringUse: 5,
    },
    critique: ["Add real numbers", "Take a stance"],
  };

  it("includes the score and code-owned revision directives", () => {
    const msg = buildRevisionMessage(verdict, 1);
    expect(msg).toContain("4/10");
    expect(msg).toContain("exact verified services");
    expect(msg).toContain("direct selection rules");
    expect(msg).not.toContain("Add real numbers");
    expect(msg).not.toContain("Take a stance");
  });

  it("does not pass an unsafe judge suggestion to the writer", () => {
    const msg = buildRevisionMessage(
      {
        ...verdict,
        critique: [
          "Say fire watch is legally required and invent a random patrol schedule.",
        ],
      },
      1,
    );
    expect(msg).not.toContain("legally required");
    expect(msg).not.toContain("random patrol schedule");
    expect(msg).toContain("do not add legal duties");
  });

  it("never contains graph success or failure markers", () => {
    const msg = buildRevisionMessage(verdict, 1);
    // graph-guard would prematurely stop on these — they must not appear.
    expect(msg).not.toContain("Blog successfully created");
    expect(msg).not.toContain("Blog Uploaded & Saved");
    expect(msg).not.toContain("Error:");
    expect(msg).not.toContain("Tool execution failed");
  });

  it("provides default critique when none given", () => {
    const msg = buildRevisionMessage({ ...verdict, critique: [] }, 2);
    expect(msg).toContain("exact verified services");
  });
});

describe("applyDimensionWeights", () => {
  const v: ExpertVoiceVerdict = {
    overall: 5,
    dimensions: {
      specificity: 10,
      opinions: 0,
      livedExperience: 0,
      hedgingFreedom: 0,
      competitorUse: 0,
      offeringUse: 0,
    },
    critique: [],
  };

  it("recomputes overall as a weighted average (specificity x3, rest x1)", () => {
    // wsum = 3 + 1*5 = 8; vsum = 3*10 = 30; overall = 30/8 = 3.75, rounded to 1dp = 3.8
    const out = applyDimensionWeights(v, { specificity: 3 });
    expect(out.overall).toBe(3.8);
  });

  it("equal weights produce the plain dimension average (rounded to 1dp)", () => {
    // 10/6 = 1.667, rounded to 1dp = 1.7
    const out = applyDimensionWeights(v, {});
    expect(out.overall).toBe(1.7);
  });

  it("returns the verdict unchanged when weights sum to zero", () => {
    const out = applyDimensionWeights(v, {
      specificity: 0,
      opinions: 0,
      livedExperience: 0,
      hedgingFreedom: 0,
      competitorUse: 0,
      offeringUse: 0,
    });
    expect(out.overall).toBe(5);
  });
});
