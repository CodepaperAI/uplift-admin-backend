import { describe, expect, it } from "bun:test";
import {
  buildStrategistBrief,
  deriveModuleContext,
  parseArticleStrategy,
} from "../services/article-strategist.service";
import type { LocationPolicy } from "../utils/location-policy.utils";

const CITY_POLICY: LocationPolicy = {
  tier: "city",
  useNeighborhoodAndLandmarks: true,
  useLocalSection: true,
  useLocalCTA: true,
  reason: "local",
};
const NONE_POLICY: LocationPolicy = {
  tier: "none",
  useNeighborhoodAndLandmarks: false,
  useLocalSection: false,
  useLocalCTA: false,
  reason: "national",
};

describe("parseArticleStrategy", () => {
  it("parses a clean strategy and clamps word count to the no-pad range", () => {
    const raw =
      '{"contentType":"comparison","searchIntent":"commercial","angle":"lead with real College St pricing","requiredModules":["quick-answer","comparison-table","faq"],"outline":["A","B"],"targetWordCount":9000,"research":"local competitors"}';
    const s = parseArticleStrategy(raw)!;
    expect(s.contentType).toBe("comparison");
    expect(s.searchIntent).toBe("commercial");
    expect(s.angle).toContain("College St");
    expect(s.requiredModules).toContain("comparison-table");
    expect(s.targetWordCount).toBeLessThanOrEqual(2400); // clamped down from 9000
    expect(s.research).toBe("local competitors");
  });

  it("tolerates code fences / stray prose and invalid enums", () => {
    const raw =
      'Sure!\n```json\n{"contentType":"nonsense","searchIntent":"bad","angle":"x","outline":[],"requiredModules":["faq","not-a-module"]}\n```';
    const s = parseArticleStrategy(raw)!;
    expect(s.contentType).toBe("complete-guide"); // invalid → default
    expect(s.searchIntent).toBe("informational"); // invalid → default
    expect(s.requiredModules).toEqual(["faq"]); // unknown id filtered out
  });

  it("returns null when there's nothing usable", () => {
    expect(parseArticleStrategy("")).toBeNull();
    expect(parseArticleStrategy("no json here")).toBeNull();
    expect(parseArticleStrategy('{"angle":"","outline":[]}')).toBeNull();
  });
});

describe("deriveModuleContext", () => {
  it("comparison + local + facts + reviews → comparative, local, factful context", () => {
    const ctx = deriveModuleContext(
      { contentType: "comparison", searchIntent: "commercial", requiredModules: ["comparison-table"] },
      {
        businessModel: "service",
        locationPolicy: CITY_POLICY,
        facts: { priceFrom: "$18" },
        hasReviews: true,
      },
    );
    expect(ctx.isComparative).toBe(true);
    expect(ctx.isHowTo).toBe(false);
    expect(ctx.useLocalSection).toBe(true);
    expect(ctx.locationTier).toBe("city");
    expect(ctx.hasFacts).toBe(true);
    expect(ctx.hasReviews).toBe(true);
  });

  it("how-to + national + no facts → howto, non-local, factless context", () => {
    const ctx = deriveModuleContext(
      { contentType: "how-to", searchIntent: "informational", requiredModules: ["howto-steps"] },
      { businessModel: "service", locationPolicy: NONE_POLICY, facts: {}, hasReviews: false },
    );
    expect(ctx.isHowTo).toBe(true);
    expect(ctx.useLocalSection).toBe(false);
    expect(ctx.hasFacts).toBe(false);
  });
});

describe("buildStrategistBrief", () => {
  it("includes the approach profile and demands minified JSON", () => {
    const brief = buildStrategistBrief({
      keyword: "small party catering toronto",
      businessModel: "service",
      approachProfile: "model: service; locationDependent: true; audience: event hosts",
      serpSummary: "Top titles: ...",
      locationPolicy: CITY_POLICY,
      facts: { foundingYear: 2019 },
      hasReviews: true,
    });
    expect(brief).toContain("approach profile");
    expect(brief).toContain("event hosts");
    expect(brief).toContain("ONLY minified JSON");
  });
});
