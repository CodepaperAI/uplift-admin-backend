import { describe, expect, it } from "bun:test";
import {
  computePriority,
  makeOpportunityKey,
  runOffPageEngine,
} from "../services/offpage/offpage-engine";
import type {
  BusinessOffPageProfile,
  Lever,
  Opportunity,
} from "../services/offpage/offpage-types";

const PROFILE: BusinessOffPageProfile = {
  businessId: "b1",
  businessName: "Test Co",
  businessModelType: "service",
  isLocationDependent: true,
  scope: "local",
  keywords: ["x"],
};

function opp(priority: number, title = "o"): Opportunity {
  return {
    leverKey: "directory",
    key: `directory:${title}`,
    title,
    action: "",
    priority,
    rationale: "",
    status: "todo",
    businessTypeFit: "",
  };
}

function lever(key: Lever["key"], applies: boolean, opps: Opportunity[]): Lever {
  return {
    key,
    appliesTo: () => applies,
    findOpportunities: () => opps,
  };
}

describe("computePriority", () => {
  it("multiplies relevance by authority/100", () => {
    expect(computePriority(1, 100)).toBe(100);
    expect(computePriority(0.5, 100)).toBe(50);
    expect(computePriority(1, 90)).toBe(90);
    expect(computePriority(0.7, 80)).toBe(56);
  });
  it("clamps out-of-range inputs", () => {
    expect(computePriority(2, 100)).toBe(100);
    expect(computePriority(-1, 100)).toBe(0);
    expect(computePriority(1, 200)).toBe(100);
    expect(computePriority(1, -5)).toBe(0);
  });
});

describe("makeOpportunityKey", () => {
  it("produces a stable, slugified key", () => {
    expect(makeOpportunityKey("directory", "Google Business Profile")).toBe(
      "directory:google-business-profile",
    );
    expect(makeOpportunityKey("reddit", "threads-best caterers!")).toBe(
      "reddit:threads-best-caterers",
    );
  });
  it("is deterministic", () => {
    expect(makeOpportunityKey("directory", "Yelp")).toBe(
      makeOpportunityKey("directory", "Yelp"),
    );
  });
});

describe("runOffPageEngine", () => {
  it("returns no_applicable_levers when nothing applies", () => {
    const r = runOffPageEngine(PROFILE, [lever("directory", false, [opp(50)])]);
    expect(r.opportunities).toEqual([]);
    expect(r.emptyReason).toBe("no_applicable_levers");
    expect(r.appliedLevers).toEqual([]);
  });

  it("returns no_opportunities when an applicable lever finds nothing", () => {
    const r = runOffPageEngine(PROFILE, [lever("directory", true, [])]);
    expect(r.emptyReason).toBe("no_opportunities");
    expect(r.appliedLevers).toEqual(["directory"]);
  });

  it("merges applicable levers and ranks by priority desc (stable on ties)", () => {
    const r = runOffPageEngine(PROFILE, [
      lever("directory", true, [opp(30, "d1"), opp(90, "d2")]),
      lever("reddit", true, [opp(90, "r1"), opp(10, "r2")]),
    ]);
    expect(r.opportunities.map((o) => o.title)).toEqual(["d2", "r1", "d1", "r2"]);
    expect(r.appliedLevers).toEqual(["directory", "reddit"]);
    expect(r.emptyReason).toBeUndefined();
  });

  it("a throwing lever does not crash the queue", () => {
    const broken: Lever = {
      key: "reddit",
      appliesTo: () => true,
      findOpportunities: () => {
        throw new Error("boom");
      },
    };
    const r = runOffPageEngine(PROFILE, [lever("directory", true, [opp(50)]), broken]);
    expect(r.opportunities).toHaveLength(1);
  });

  it("a throwing appliesTo is treated as not-applicable", () => {
    const broken: Lever = {
      key: "reddit",
      appliesTo: () => {
        throw new Error("boom");
      },
      findOpportunities: () => [opp(99)],
    };
    const r = runOffPageEngine(PROFILE, [broken]);
    expect(r.emptyReason).toBe("no_applicable_levers");
  });
});
