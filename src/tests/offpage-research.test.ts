import { describe, expect, it } from "bun:test";
import { runOffPageEngineAsync } from "../services/offpage/offpage-engine";
import { buildBusinessResearchBrief } from "../services/offpage/offpage-research.service";
import { buildFallbackResearchStrategy } from "../llm/offpage/research-strategy.llm";
import type {
  BusinessOffPageProfile,
  BusinessResearchBrief,
  Lever,
  OffPageResearchStrategy,
  Opportunity,
} from "../services/offpage/offpage-types";

const PROFILE: BusinessOffPageProfile = {
  businessId: "b1",
  businessName: "Test Co",
  businessModelType: "service",
  isLocationDependent: true,
  scope: "local",
  serviceArea: "local",
  keywords: ["plumbing", "drain cleaning"],
};

const BRIEF: BusinessResearchBrief = {
  businessId: "b1",
  businessName: "Test Co",
  services: [],
  competitors: [],
  keywords: ["plumbing"],
  location: { serviceAreaLocations: [], neighborhoods: [] },
  scope: "local",
  businessModelType: "service",
  differentiators: [],
  painPoints: [],
  businessGoals: [],
  recognition: [],
  competitorTopics: [],
};

const STRATEGY: OffPageResearchStrategy = {
  businessSummary: "Test strategy",
  archetype: "local_service",
  demandSignals: ["plumbing"],
  reddit: {
    enabled: true,
    reason: "questions exist",
    subredditSeeds: ["r/HomeImprovement"],
    threadSearchQueries: ["drain cleaning"],
    coreTerms: ["drain"],
    audienceAngles: ["help homeowners"],
    avoidTerms: [],
  },
  directory: {
    enabled: true,
    reason: "citations matter",
    searchQueries: ["plumbing directories"],
    requiredDirectoryTypes: ["Google Business Profile"],
    nicheDirectoryTypes: ["Home services"],
    regionalHints: ["Austin"],
    avoidDirectories: [],
  },
};

function opp(key: string, priority: number, source?: Opportunity["source"]): Opportunity {
  return {
    leverKey: "reddit",
    key,
    title: key,
    action: "",
    priority,
    rationale: "",
    ...(source ? { source } : {}),
    status: "todo",
    businessTypeFit: "",
  };
}

function lever(
  key: Lever["key"],
  baseline: Opportunity[],
  research?: () => Promise<Opportunity[]>,
): Lever {
  return {
    key,
    appliesTo: () => true,
    findOpportunities: () => baseline,
    ...(research ? { researchOpportunities: research } : {}),
  };
}

describe("runOffPageEngineAsync", () => {
  it("prefers researched opportunities when research returns results", async () => {
    const l = lever(
      "reddit",
      [opp("base", 10)],
      async () => [opp("researched", 50, "researched")],
    );
    const result = await runOffPageEngineAsync(PROFILE, [l], BRIEF);
    expect(result.opportunities.map((o) => o.key)).toEqual(["researched"]);
    expect(result.opportunities[0]?.source).toBe("researched");
  });

  it("falls back to the deterministic baseline when research returns empty", async () => {
    const l = lever("reddit", [opp("base", 10)], async () => []);
    const result = await runOffPageEngineAsync(PROFILE, [l], BRIEF);
    expect(result.opportunities.map((o) => o.key)).toEqual(["base"]);
  });

  it("falls back to baseline when research throws (never blanks the lever)", async () => {
    const l = lever("reddit", [opp("base", 10)], async () => {
      throw new Error("LLM down");
    });
    const result = await runOffPageEngineAsync(PROFILE, [l], BRIEF);
    expect(result.opportunities.map((o) => o.key)).toEqual(["base"]);
  });

  it("isolates failures per lever and ranks the merged queue", async () => {
    const failing = lever("directory", [opp("dir-base", 80)], async () => {
      throw new Error("boom");
    });
    const working = lever("reddit", [opp("red-base", 5)], async () => [
      opp("red-researched", 30, "researched"),
    ]);
    const result = await runOffPageEngineAsync(PROFILE, [failing, working], BRIEF);
    // directory falls back to its baseline (80), reddit uses researched (30).
    expect(result.opportunities.map((o) => o.key)).toEqual([
      "dir-base",
      "red-researched",
    ]);
  });

  it("defaults a missing source to 'baseline'", async () => {
    const l = lever("reddit", [opp("base", 10)]);
    const result = await runOffPageEngineAsync(PROFILE, [l], BRIEF);
    expect(result.opportunities[0]?.source).toBe("baseline");
  });

  it("reports no_applicable_levers when nothing applies", async () => {
    const l: Lever = {
      key: "reddit",
      appliesTo: () => false,
      findOpportunities: () => [opp("x", 1)],
    };
    const result = await runOffPageEngineAsync(PROFILE, [l], BRIEF);
    expect(result.emptyReason).toBe("no_applicable_levers");
    expect(result.opportunities).toHaveLength(0);
  });

  it("respects the planner when it disables a lever", async () => {
    const reddit = lever("reddit", [opp("reddit-base", 90)]);
    const directory = lever("directory", [opp("directory-base", 50)]);
    const result = await runOffPageEngineAsync(
      PROFILE,
      [reddit, directory],
      BRIEF,
      {
        ...STRATEGY,
        reddit: { ...STRATEGY.reddit, enabled: false },
      },
    );

    expect(result.appliedLevers).toEqual(["directory"]);
    expect(result.opportunities.map((o) => o.key)).toEqual(["directory-base"]);
  });
});

describe("buildBusinessResearchBrief", () => {
  it("merges selected + detected services (deduped) and maps competitors", () => {
    const brief = buildBusinessResearchBrief(
      {
        businessType: "Plumbing",
        businessDescription: "We fix drains.",
        businessWebsiteUrl: "https://example.com",
        targetAudience: "Homeowners",
        selectedServices: ["Drain Cleaning", "Leak Repair"],
        detectedServices: [{ name: "drain cleaning" }, { name: "Water Heaters" }],
        serviceAreaLocations: ["Austin", "Round Rock"],
        businessCity: "Austin",
        businessCountry: "US",
        competitiors: [
          { name: "Acme Plumbing", url: "https://acme.test" },
          { name: "", url: "https://empty.test" },
        ],
      },
      PROFILE,
    );

    // "Drain Cleaning" and "drain cleaning" collapse to one (case-insensitive).
    expect(brief.services).toEqual([
      "Drain Cleaning",
      "Leak Repair",
      "Water Heaters",
    ]);
    expect(brief.competitors).toEqual([
      { name: "Acme Plumbing", url: "https://acme.test" },
    ]);
    expect(brief.location.serviceAreaLocations).toEqual(["Austin", "Round Rock"]);
    expect(brief.location.city).toBe("Austin");
    expect(brief.category).toBe("Plumbing");
    expect(brief.targetAudience).toBe("Homeowners");
    expect(brief.keywords).toEqual(PROFILE.keywords);
  });

  it("handles missing/empty optional fields without throwing", () => {
    const brief = buildBusinessResearchBrief({}, PROFILE);
    expect(brief.services).toEqual([]);
    expect(brief.competitors).toEqual([]);
    expect(brief.location.serviceAreaLocations).toEqual([]);
    expect(brief.businessId).toBe("b1");
  });

  it("parses detectedServices given as an object map of names", () => {
    const brief = buildBusinessResearchBrief(
      { detectedServices: { "SEO Audit": {}, "Link Building": {} } },
      PROFILE,
    );
    expect(brief.services).toEqual(["SEO Audit", "Link Building"]);
  });

  it("prefers real geo locality and ignores street-address city values", () => {
    const brief = buildBusinessResearchBrief(
      {
        businessCity: "746 Queen St W",
        businessCountry: "ON",
        GeoProfile: { locality: "Mississauga" },
      },
      PROFILE,
    );
    expect(brief.location.city).toBe("Mississauga");

    const addressOnly = buildBusinessResearchBrief(
      { businessCity: "31 Commercial Rd", businessCountry: "ON" },
      PROFILE,
    );
    expect(addressOnly.location.city).toBeNull();
  });
});

describe("buildFallbackResearchStrategy", () => {
  it("plans local service research without excluding Reddit entirely", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "Acme Plumbing",
      category: "Plumbing Services",
      keywords: ["drain cleaning calgary", "water heater repair"],
      isLocationDependent: true,
      scope: "local",
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "Acme Plumbing",
      category: "Plumbing Services",
      services: ["Drain cleaning", "Water heater repair"],
      keywords: profile.keywords,
      location: {
        city: "Calgary",
        country: "Canada",
        serviceAreaLocations: ["Calgary"],
        neighborhoods: [],
      },
      painPoints: ["Clogged drains", "No hot water"],
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("local_service");
    expect(strategy.reddit.enabled).toBe(true);
    expect(strategy.reddit.threadSearchQueries.join(" ").toLowerCase()).toContain("drain");
    expect(strategy.directory.searchQueries.join(" ").toLowerCase()).toContain("plumbing");
  });

  it("keeps local service archetypes even when copy contains preventative/event substrings", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      keywords: ["drain repair", "preventative plumbing maintenance"],
      isLocationDependent: true,
      scope: "local",
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      services: ["Drain repair", "Water heater repair"],
      keywords: profile.keywords,
      location: {
        city: "Toronto",
        country: "Canada",
        serviceAreaLocations: [],
        neighborhoods: [],
      },
      painPoints: ["Preventative maintenance", "Permit application support", "Leaking pipes"],
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("local_service");
  });

  it("uses the business name when classifying professional services", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "Vikram Sharma Law Professional Corporation",
      category: "Independent Legal Advice",
      keywords: ["independent legal advice"],
      isLocationDependent: true,
      scope: "local",
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "Vikram Sharma Law Professional Corporation",
      category: "Independent Legal Advice",
      keywords: profile.keywords,
      painPoints: ["Loan application review"],
      contentTopics: ["Mortgage renewal", "Mortgage application"],
      location: {
        city: "Toronto",
        country: "Canada",
        serviceAreaLocations: [],
        neighborhoods: [],
      },
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("professional_service");
  });

  it("does not let content topics override the actual business archetype", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      keywords: ["drain repair", "water line repair"],
      isLocationDependent: true,
      scope: "local",
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      services: ["Drain repair", "Water heater repair"],
      keywords: profile.keywords,
      contentTopics: ["Pipe health checklist", "Emergency water damage"],
      location: {
        city: null,
        country: "Canada",
        serviceAreaLocations: [],
        neighborhoods: [],
      },
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("local_service");
  });

  it("classifies trade services before incidental healthcare words", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      keywords: ["drain repair"],
      isLocationDependent: true,
      scope: "local",
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "Everest Plumbing",
      category: "Plumbing Services",
      description: "Full-service plumbing with dental plumbing and drain repair.",
      services: ["Plumbing Services", "Dental plumbing services", "Drain cleaning"],
      keywords: profile.keywords,
      location: {
        city: null,
        country: "Canada",
        serviceAreaLocations: [],
        neighborhoods: [],
      },
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("local_service");
  });

  it("plans SaaS directories and Reddit searches from product/problem language", () => {
    const profile: BusinessOffPageProfile = {
      ...PROFILE,
      businessName: "WorkflowPilot",
      category: "SaaS workflow automation",
      businessModelType: "product",
      isLocationDependent: false,
      scope: "national",
      keywords: ["workflow automation software", "operations dashboard"],
    };
    const brief: BusinessResearchBrief = {
      ...BRIEF,
      businessName: "WorkflowPilot",
      category: "SaaS workflow automation",
      services: ["Workflow automation", "Operations dashboard"],
      keywords: profile.keywords,
      location: { serviceAreaLocations: [], neighborhoods: [], country: "US" },
      painPoints: ["Manual reporting", "Missed handoffs"],
    };

    const strategy = buildFallbackResearchStrategy(brief, profile);
    expect(strategy.archetype).toBe("saas");
    expect(strategy.reddit.threadSearchQueries.join(" ").toLowerCase()).toContain("workflow");
    expect(strategy.directory.requiredDirectoryTypes.length).toBeGreaterThan(0);
  });
});
