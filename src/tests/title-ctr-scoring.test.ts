import { describe, expect, it } from "bun:test";
import {
  buildDeterministicFallbackTitle,
  buildLockedTitleFormatInstructions,
  getLockedTitleStructure,
  hasUnsupportedTitleClaim,
  hasUnsupportedTitlePremise,
  hasUnsupportedTitleLocation,
  getUnsupportedTitlePremiseReasons,
  keywordMatchScore,
  isTitleStructureCompatibleWithArchetype,
  scoreTitleCTR,
  titleFormatFamily,
  titleSimilarityScore,
} from "../llm/keywords/generate-titles-only.llm";

const KW = "individually packaged lunch catering";

describe("keywordMatchScore", () => {
  it("rewards exact phrase highest, drift lowest", () => {
    expect(keywordMatchScore("Individually Packaged Lunch Catering in Toronto", KW)).toBe(6);
    // contains most core nouns (packaged, lunch, catering)
    expect(keywordMatchScore("Packaged Lunch Catering for Toronto Teams", KW)).toBeGreaterThanOrEqual(4);
    // the drifted title the system actually picked — barely matches
    expect(keywordMatchScore("Meal Box Catering: What Teams Need to Know in 2026", KW)).toBeLessThanOrEqual(1);
  });
});

describe("scoreTitleCTR — ranking signals beat gimmicks", () => {
  it("a keyword-anchored + local title outscores the drifted clickbait one", () => {
    const good = scoreTitleCTR(
      "Individually Packaged Lunch Catering in Toronto",
      KW,
      [],
      "Toronto",
    );
    const drifted = scoreTitleCTR(
      "Meal Box Catering: What Teams Need to Know in 2026",
      KW,
      [],
      "Toronto",
    );
    expect(good).toBeGreaterThan(drifted);
  });

  it("penalises stacked AI-clickbait tells (year + brackets + power word)", () => {
    const stacked = scoreTitleCTR("Ultimate Lunch Catering [2026 Guide]", KW, []);
    const clean = scoreTitleCTR("Packaged Lunch Catering for Office Teams", KW, []);
    expect(clean).toBeGreaterThan(stacked);
  });

  it("rewards SERP differentiation and locality", () => {
    const unique = scoreTitleCTR(
      "Individually Packaged Lunch Catering in Toronto",
      KW,
      ["Generic Lunch Catering Services", "Best Catering Companies"],
      "Toronto",
    );
    const noLocal = scoreTitleCTR(
      "Individually Packaged Lunch Catering",
      KW,
      ["Generic Lunch Catering Services"],
    );
    expect(unique).toBeGreaterThan(noLocal);
  });

  it("prefers decision-oriented comparison titles for a broad services query", () => {
    const compare = scoreTitleCTR(
      "GoodLife Fitness Services: Compare Classes, Training",
      "GoodLife Fitness services",
      [],
    );
    const vague = scoreTitleCTR(
      "GoodLife Fitness Services: What Membership Gives You",
      "GoodLife Fitness services",
      [],
    );
    expect(compare).toBeGreaterThan(vague);
  });

  it("does not reward raw operational numbers over a useful decision angle", () => {
    const decision = scoreTitleCTR(
      "Corporate Catering Toronto: Compare Lunch Options",
      "corporate catering toronto",
      [],
      "Toronto",
    );
    const capacity = scoreTitleCTR(
      "Corporate Catering Toronto for 10 to 1,000 Guests",
      "corporate catering toronto",
      [],
      "Toronto",
    );
    expect(decision).toBeGreaterThan(capacity);
  });
});

describe("hasUnsupportedTitleLocation", () => {
  it("rejects a city that is absent from the verified location set", () => {
    expect(
      hasUnsupportedTitleLocation(
        "British Columbia Security Company: Condo Safety in Burnaby",
        ["British Columbia", "Canada"],
      ),
    ).toBe(true);
  });

  it("allows an exact verified multi-word region", () => {
    expect(
      hasUnsupportedTitleLocation(
        "Security Services in British Columbia: Selection Guide",
        ["British Columbia", "Canada"],
      ),
    ).toBe(false);
  });

  it("does not mistake a title without a location phrase for a geo claim", () => {
    expect(
      hasUnsupportedTitleLocation(
        "Security Company Selection: Choose Licensed Guards First",
        ["British Columbia"],
      ),
    ).toBe(false);
  });

  it("does not mistake the phrase in advance for a location", () => {
    expect(
      hasUnsupportedTitleLocation(
        "GoodLife Fitness Services: Book Workouts in Advance",
        [],
      ),
    ).toBe(false);
  });
});

describe("title history diversity", () => {
  it("classifies repeated punctuation templates for diversity scoring", () => {
    expect(titleFormatFamily("Kitchen Renovation Cost: A Planning Guide")).toBe("colon");
    expect(titleFormatFamily("How Much Does a Kitchen Renovation Cost?")).toBe("question");
    expect(titleFormatFamily("7 Kitchen Layout Mistakes to Avoid")).toBe("numbered");
    expect(titleFormatFamily("Kitchen Renovation Planning for Brampton Homes")).toBe("plain");
  });

  it("detects exact and close reordered title duplicates", () => {
    expect(
      titleSimilarityScore(
        "GoodLife Fitness Services: Compare Classes and Training",
        "GoodLife Fitness Services: Compare Classes and Training",
      ),
    ).toBe(1);
    expect(
      titleSimilarityScore(
        "GoodLife Fitness Services: Compare Training and Classes",
        "GoodLife Fitness Services: Compare Classes and Training",
      ),
    ).toBeGreaterThan(0.8);
    expect(
      titleSimilarityScore(
        "GoodLife Fitness Services: Questions Before You Join",
        "GoodLife Fitness Services: Compare Classes and Training",
      ),
    ).toBeLessThan(0.7);
  });
});

describe("closed-world title safety", () => {
  it("rejects numbered promises larger than the evidence-backed inventory", () => {
    const reasons = getUnsupportedTitlePremiseReasons(
      "Corporate Catering Toronto: Five Formats for Events",
      "corporate catering toronto",
      ["Corporate catering", "Office lunch catering"],
      2,
    );

    expect(reasons).toContain(
      "numbered premise promises 5 items but only 2 are evidence-backed",
    );
  });

  it("allows a numbered promise that the evidence-backed inventory can fulfil", () => {
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto: Two Options to Compare",
        "corporate catering toronto",
        ["Corporate catering", "Office lunch catering"],
        2,
      ),
    ).toBe(false);
  });

  it("rejects unsupported timing, availability, guarantee, and outcome promises", () => {
    for (const title of [
      "Mobile Patrols: Fast Help Tonight",
      "Security Guards With Guaranteed Same-Day Response",
      "SEO Services That Rank #1 Within 30 Days",
      "Emergency Support Available 24/7",
    ]) {
      expect(hasUnsupportedTitleClaim(title)).toBe(true);
    }
  });

  it("builds a neutral deterministic fallback without inventing an outcome", () => {
    const title = buildDeterministicFallbackTitle(
      "mobile security patrols",
      "Burnaby",
    );
    expect(title.title).toBe(
      "What to Expect From Mobile Security Patrols in Burnaby",
    );
    expect(hasUnsupportedTitleClaim(title.title)).toBe(false);
    expect(title.contentIntent).toBe("Informational");
  });

  it("rejects topic drift, pricing, and unsupported regulatory premises", () => {
    expect(
      hasUnsupportedTitlePremise(
        "Condo Safety in Burnaby: Keep Events Safe Tonight",
        "mobile security patrols",
      ),
    ).toBe(true);
    expect(
      hasUnsupportedTitlePremise(
        "Mobile Security Patrols: Pricing From $99",
        "mobile security patrols",
      ),
    ).toBe(true);
    expect(
      hasUnsupportedTitlePremise(
        "Mobile Security Patrols: Legal Compliance Requirements",
        "mobile security patrols",
      ),
    ).toBe(true);
  });

  it("rejects invented benefit angles unless the exact benefit is allowed", () => {
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Mississauga: Hot Meals, Clean Hands",
        "corporate catering Mississauga",
        ["Corporate catering", "Wraps", "Salads"],
      ),
    ).toBe(true);
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Mississauga: Gluten-Free Options",
        "corporate catering Mississauga",
        ["Gluten-free"],
      ),
    ).toBe(true);
    expect(
      hasUnsupportedTitlePremise(
        "Gluten-Free Corporate Catering Mississauga: Options",
        "gluten-free corporate catering Mississauga",
        ["Gluten-free"],
      ),
    ).toBe(false);
  });

  it("rejects unsupported savings, urgency, habit, and wait-time outcomes", () => {
    for (const title of [
      "GoodLife Fitness Services: Save More on Your Gym Plan",
      "GoodLife Fitness Services: Pick the Right Plan Today",
      "GoodLife Fitness Services: Build Stronger Habits Now",
      "GoodLife Fitness Services: Book Workouts with Less Wait",
      "GoodLife Fitness Services: Know the Real Fees Before",
      "GoodLife Fitness Services: Book Training With Confidence",
      "GoodLife Fitness Services: Build a Routine That Sticks",
      "GoodLife Fitness Services: See Why Members Keep Coming",
      "GoodLife Fitness Services: Get More from Your Gym Time",
      "GoodLife Fitness Services: Make the Most of Gym Time",
    ]) {
      expect(
        hasUnsupportedTitlePremise(title, "GoodLife Fitness services"),
      ).toBe(true);
    }
  });

  it("rejects creative title vocabulary absent from the closed-world corpus", () => {
    const claims = [
      "Group fitness classes",
      "Personal training",
      "Mobile app club access",
    ];
    expect(
      hasUnsupportedTitlePremise(
        "GoodLife Fitness Services: Compare Classes and Training",
        "GoodLife Fitness services",
        claims,
      ),
    ).toBe(false);
    for (const title of [
      "GoodLife Fitness Services: Pick the Right Plan in 2026",
      "GoodLife Fitness Services: Best Options for Busy Members",
      "GoodLife Fitness Services: Cancel Without Stress",
    ]) {
      expect(
        hasUnsupportedTitlePremise(
          title,
          "GoodLife Fitness services",
          claims,
        ),
      ).toBe(true);
    }
  });

  it("permits neutral decision framing without opening unsupported service angles", () => {
    const claims = [
      "Corporate event catering",
      "Boxed Lunch Bowls",
      "Mediterranean Buffet Bar",
    ];
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto: How to Compare Options",
        "corporate catering toronto",
        claims,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto: Questions Before Ordering",
        "corporate catering toronto",
        claims,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto: Buffet vs Boxed Lunch",
        "corporate catering toronto",
        claims,
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto: Halal and Vegan Options",
        "corporate catering toronto",
        claims,
      ),
    ).toBe(true);
  });

  it("reports the exact closed-world reason for title rejection", () => {
    const reasons = getUnsupportedTitlePremiseReasons(
      "Corporate Catering Toronto: Same-Day Vegan Menus",
      "corporate catering toronto",
      ["Corporate event catering"],
    );
    expect(reasons).toContain("unsupported promise or outcome");
    const vocabularyReason = reasons.find((reason) =>
      reason.startsWith("unsupported vocabulary:"),
    );
    expect(vocabularyReason).toContain("vegan");
    expect(vocabularyReason).toContain("menus");
  });

  it("blocks operational lead-time titles even when the timing fact is verified", () => {
    const reasons = getUnsupportedTitlePremiseReasons(
      "Corporate Catering Toronto: 5 Days in Advance",
      "corporate catering toronto",
      ["Order at least 5 days in advance"],
    );
    expect(reasons).toContain("operational timing premise");
  });

  it("allows the canonical business name but not an invented brand", () => {
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto from Shawarma Moose",
        "corporate catering toronto",
        ["Shawarma Moose"],
      ),
    ).toBe(false);
    expect(
      hasUnsupportedTitlePremise(
        "Corporate Catering Toronto from Lunch Moose",
        "corporate catering toronto",
        ["Shawarma Moose"],
      ),
    ).toBe(true);
  });

  it("does not duplicate a verified city already present in the keyword", () => {
    const title = buildDeterministicFallbackTitle(
      "corporate catering Mississauga",
      "Mississauga",
    );
    expect(title.title).toBe(
      "Corporate Catering Mississauga: Process and Questions to Ask",
    );
  });
});

describe("locked content type", () => {
  it("maps every supported archetype to one required title structure", () => {
    expect(getLockedTitleStructure("complete-guide")).toBe("complete-guide");
    expect(getLockedTitleStructure("how-to")).toBe("how-to");
    expect(getLockedTitleStructure("listicle")).toBe("list-based");
    expect(getLockedTitleStructure("service-page")).toBe("service-page");
    expect(getLockedTitleStructure("unknown")).toBeNull();
  });

  it("rejects title structures that drift away from the locked archetype", () => {
    expect(
      isTitleStructureCompatibleWithArchetype("how-to", "how-to"),
    ).toBe(true);
    expect(
      isTitleStructureCompatibleWithArchetype("list-based", "how-to"),
    ).toBe(false);
    expect(
      isTitleStructureCompatibleWithArchetype("service-page", "service-page"),
    ).toBe(true);
    expect(
      isTitleStructureCompatibleWithArchetype("comparison", "comparison"),
    ).toBe(true);
    expect(
      isTitleStructureCompatibleWithArchetype("list-based", "comparison"),
    ).toBe(false);
    expect(
      isTitleStructureCompatibleWithArchetype("process", null),
    ).toBe(true);
  });

  it("builds an explicit non-negotiable prompt contract", () => {
    const instructions = buildLockedTitleFormatInstructions("listicle");
    expect(instructions).toContain("Locked content type: listicle");
    expect(instructions).toContain(
      "Required structureType for every candidate: list-based",
    );
    expect(instructions).toContain("All ten options");
  });

  it("keeps deterministic fallbacks compatible with the locked archetype", () => {
    for (const [archetype, structureType] of [
      ["complete-guide", "complete-guide"],
      ["how-to", "how-to"],
      ["listicle", "list-based"],
      ["comparison", "comparison"],
      ["service-page", "service-page"],
    ] as const) {
      const fallback = buildDeterministicFallbackTitle(
        "shawarma catering for family parties",
        "Toronto",
        archetype,
      );
      expect(fallback.structureType).toBe(structureType);
      expect(fallback.title).not.toMatch(
        /A Practical Guide|Complete Guide|Ultimate Guide/i,
      );
      expect(
        isTitleStructureCompatibleWithArchetype(
          fallback.structureType,
          archetype,
        ),
      ).toBe(true);
    }
  });
});
