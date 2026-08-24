import { describe, expect, it } from "bun:test";
import {
  buildCanonicalBusinessAreas,
  bucketDifficulty,
  evaluateKeywordCandidateQuality,
  inferKeywordIntent,
  mapKeywordToBusinessArea,
  selectKeywordsDeterministically,
  type CanonicalBusinessArea,
  type KeywordCandidate,
} from "../utils/dataforseo-keyword-plan.utils";
import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";
import type { EffectiveServices } from "../utils/effective-services.utils";

const mixedBusinessContext: BusinessContextAnalysis = {
  businessModel: {
    type: "mixed",
    isLocationDependent: false,
  },
  services: {
    primary: [
      "IP Camera Sales",
      "Security Camera Installation",
      "Commercial Electrical Solutions",
      "NVR Systems",
    ],
    secondary: ["Residential Electrical Solutions"],
    industry: "Security and electrical solutions",
  },
  market: {
    geographic: {
      primary: "Canada",
      scope: "national",
    },
    industry: {
      vertical: "Security and electrical",
      b2bOrB2c: "mixed",
    },
    customerSegment: {
      primary: "Homeowners and businesses",
      characteristics: ["B2B", "B2C"],
    },
  },
  keywordStrategy: {
    intentDistribution: {
      informational: 45,
      commercial: 30,
      transactional: 20,
      navigational: 5,
    },
    difficultyDistribution: {
      easy: { min: 0, max: 45, count: 10 },
      medium: { min: 46, max: 70, count: 12 },
      hard: { min: 71, max: 90, count: 8 },
    },
    mustHaveKeywords: ["ip cameras", "licensed electrician"],
    focusAreas: [
      "IP Cameras",
      "Security Camera Installation",
      "Commercial Electrical Solutions",
      "NVR Systems",
    ],
  },
  coreOfferings: {
    primary: ["IP cameras", "electrical services"],
    secondary: ["security camera installation"],
    explicitDescription: "Hybrid product and service business",
    whatBusinessSells: "Cameras, NVR systems, and electrical installation",
  },
  competitorNames: [],
};

const effectiveServices: EffectiveServices = {
  topLevel: [
    "IP Camera Sales",
    "Security Camera Installation",
    "Commercial Electrical Solutions",
    "NVR Systems",
  ],
  subOfferings: [
    "CCTV and security camera installation",
    "4K security cameras",
    "Industrial electrical services",
  ],
  industryFocus: ["Commercial", "Residential"],
  orderedPrimaryServices: [
    "IP Camera Sales",
    "Security Camera Installation",
    "Commercial Electrical Solutions",
    "NVR Systems",
  ],
};

function makeCandidate(
  keyword: string,
  area: string,
  group: "product" | "service",
  overrides: Partial<KeywordCandidate> = {},
): KeywordCandidate {
  return {
    keyword,
    searchVolume: overrides.searchVolume ?? 1200,
    difficulty: overrides.difficulty ?? 48,
    sourceType: overrides.sourceType ?? "service_seed",
    allSources: overrides.allSources ?? [overrides.sourceType ?? "service_seed"],
    originSeeds: overrides.originSeeds ?? [area],
    matchedService: overrides.matchedService ?? area,
    canonicalBusinessArea: area,
    businessAreaGroup: group,
    businessAreaPriority: overrides.businessAreaPriority ?? 1,
    refinementRound: overrides.refinementRound ?? 0,
    aiRelevanceScore: overrides.aiRelevanceScore ?? 0.86,
    relevanceScore: overrides.relevanceScore ?? 1.1,
    trafficPotential: overrides.trafficPotential ?? 0.95,
    keywordIntent: overrides.keywordIntent ?? "informational",
    semanticCluster: overrides.semanticCluster ?? keyword,
    naturalnessScore: overrides.naturalnessScore ?? 0.82,
    isBlogWorthy: overrides.isBlogWorthy ?? true,
    qualityScore: overrides.qualityScore ?? 0.88,
    selectionReason: overrides.selectionReason ?? "Strong match",
    ...overrides,
  };
}

describe("dataforseo keyword plan utils", () => {
  it("infers difficulty buckets and keyword intent", () => {
    expect(bucketDifficulty(20)).toBe("easy");
    expect(bucketDifficulty(55)).toBe("medium");
    expect(bucketDifficulty(80)).toBe("hard");

    expect(inferKeywordIntent("how to choose the right immigration lawyer")).toBe(
      "informational",
    );
    expect(inferKeywordIntent("best family lawyer for mediation")).toBe(
      "commercial",
    );
    expect(inferKeywordIntent("immigration lawyer cost toronto")).toBe(
      "transactional",
    );
    expect(inferKeywordIntent("immigration lawyer near me")).toBe(
      "navigational",
    );
  });

  it("builds canonical business areas and normalizes aliases for mixed businesses", () => {
    const areas = buildCanonicalBusinessAreas({
      business: {
        selectedServices: effectiveServices.topLevel,
        detectedServices: ["Security Systems", "IP Cameras"],
        servicesPriority: {
          "IP Camera Sales": 1,
          "Security Camera Installation": 2,
          "Commercial Electrical Solutions": 3,
          "NVR Systems": 4,
        },
      },
      businessContext: mixedBusinessContext,
      effectiveServices,
    });

    expect(areas.some((area) => area.name === "IP Camera Sales")).toBe(true);
    expect(
      areas.find((area) => area.name === "IP Camera Sales")?.group,
    ).toBe("product");
    expect(
      areas.find((area) => area.name === "Commercial Electrical Solutions")
        ?.group,
    ).toBe("service");
    expect(
      areas
        .find((area) => area.name === "Security Camera Installation")
        ?.aliases.includes("CCTV and security camera installation"),
    ).toBe(true);
  });

  it("rejects awkward and non-location-fit keywords before selection", () => {
    const areas = buildCanonicalBusinessAreas({
      business: {
        selectedServices: effectiveServices.topLevel,
        detectedServices: [],
        servicesPriority: {},
      },
      businessContext: mixedBusinessContext,
      effectiveServices,
    });

    const localCameraCandidate = makeCandidate(
      "local IP camera sales",
      "IP Camera Sales",
      "product",
      {
        canonicalBusinessArea: mapKeywordToBusinessArea(
          "local IP camera sales",
          areas,
        ),
      },
    );
    const awkwardCandidate = makeCandidate("nvr video", "NVR Systems", "product", {
      canonicalBusinessArea: mapKeywordToBusinessArea("nvr video", areas),
      naturalnessScore: 0.3,
    });

    const localResult = evaluateKeywordCandidateQuality(localCameraCandidate, {
      businessAreas: areas,
      businessContext: mixedBusinessContext,
      mustHaveKeywords: mixedBusinessContext.keywordStrategy.mustHaveKeywords,
    });
    const awkwardResult = evaluateKeywordCandidateQuality(awkwardCandidate, {
      businessAreas: areas,
      businessContext: mixedBusinessContext,
      mustHaveKeywords: mixedBusinessContext.keywordStrategy.mustHaveKeywords,
    });

    expect(localResult.accepted).toBe(false);
    expect(localResult.reasons).toContain("invalid_location_modifier");
    expect(awkwardResult.accepted).toBe(false);
    expect(awkwardResult.reasons).toContain("awkward_phrase");
  });

  it("enforces area caps, hybrid group floors, and semantic dedupe", () => {
    const businessAreas: CanonicalBusinessArea[] = [
      {
        name: "IP Camera Sales",
        aliases: ["IP cameras", "security cameras"],
        group: "product",
        priorityRank: 1,
        required: false,
      },
      {
        name: "Security Camera Installation",
        aliases: ["camera installation"],
        group: "service",
        priorityRank: 2,
        required: false,
      },
      {
        name: "Commercial Electrical Solutions",
        aliases: ["commercial electrical"],
        group: "service",
        priorityRank: 3,
        required: false,
      },
      {
        name: "NVR Systems",
        aliases: ["network video recorder", "nvr"],
        group: "product",
        priorityRank: 4,
        required: false,
      },
      {
        name: "Industrial Electrical Solutions",
        aliases: ["industrial electrical"],
        group: "service",
        priorityRank: 5,
        required: false,
      },
    ];

    const productCameraKeywords = [
      "4k ip camera buying guide",
      "best ip camera for small business",
      "smart security camera comparison",
      "wired ip camera vs wifi camera",
      "outdoor security camera features",
      "color night vision camera guide",
      "vandal proof security camera options",
      "remote viewing security camera setup",
      "poe security camera benefits",
      "bullet vs dome security camera",
    ];
    const installationKeywords = [
      "security camera installation checklist",
      "how to plan camera installation",
      "security camera wiring guide",
      "security camera placement tips",
      "commercial camera installation requirements",
      "security camera installation cost",
      "security camera installation quote",
      "best camera installer questions",
    ];
    const commercialElectricalKeywords = [
      "commercial electrical planning guide",
      "commercial electrical code checklist",
      "office electrical upgrade planning",
      "commercial electrician maintenance tips",
      "electrical load planning for offices",
      "commercial lighting safety checklist",
      "commercial panel upgrade guide",
      "warehouse electrical inspection tips",
    ];
    const nvrKeywords = [
      "network video recorder buying guide",
      "best nvr for 4k cameras",
      "nvr storage calculator guide",
      "nvr vs dvr comparison",
      "how to choose an nvr system",
      "nvr remote viewing setup",
      "business nvr security system review",
      "nvr price comparison guide",
    ];
    const industrialElectricalKeywords = [
      "industrial electrical maintenance tips",
      "industrial electrical safety checklist",
      "factory electrical troubleshooting guide",
      "industrial panel maintenance schedule",
    ];

    const candidates: KeywordCandidate[] = [
      ...productCameraKeywords.map((keyword, index) =>
        makeCandidate(keyword, "IP Camera Sales", "product", {
          difficulty: 35 + (index % 4) * 5,
          keywordIntent: index < 4 ? "commercial" : "informational",
          semanticCluster:
            index < 2 ? "security camera" : `ip camera ${index}`,
        }),
      ),
      ...installationKeywords.map((keyword, index) =>
        makeCandidate(keyword, "Security Camera Installation", "service", {
          difficulty: 42 + index,
          keywordIntent:
            index < 2
              ? "transactional"
              : keyword.includes("cost") || keyword.includes("quote")
                ? "commercial"
                : "informational",
          semanticCluster:
            index < 2 ? "security camera installation" : `camera install ${index}`,
        }),
      ),
      ...commercialElectricalKeywords.map((keyword, index) =>
        makeCandidate(keyword, "Commercial Electrical Solutions", "service", {
          difficulty: 55 + index,
          keywordIntent: index < 3 ? "commercial" : "informational",
          semanticCluster: `commercial electrical ${index}`,
        }),
      ),
      ...nvrKeywords.map((keyword, index) =>
        makeCandidate(keyword, "NVR Systems", "product", {
          difficulty: 60 + index,
          keywordIntent:
            keyword.includes("price") || keyword.includes("buying")
              ? "transactional"
              : "commercial",
          semanticCluster: index < 2 ? "nvr system" : `nvr system ${index}`,
        }),
      ),
      ...industrialElectricalKeywords.map((keyword, index) =>
        makeCandidate(keyword, "Industrial Electrical Solutions", "service", {
          difficulty: 72 + index,
          keywordIntent: "informational",
          semanticCluster: `industrial electrical ${index}`,
        }),
      ),
      makeCandidate("security camera installation service", "Security Camera Installation", "service", {
        keywordIntent: "informational",
        semanticCluster: "security camera installation",
      }),
      makeCandidate("surveillance camera installation service", "Security Camera Installation", "service", {
        keywordIntent: "informational",
        semanticCluster: "security camera installation",
      }),
    ];

    const result = selectKeywordsDeterministically({
      candidates,
      businessAreas,
      mustHaveKeywords: ["ip camera", "commercial electrical"],
      strategy: mixedBusinessContext.keywordStrategy,
    });

    expect(result.selected).toHaveLength(30);
    expect(result.summary.groupCounts.product).toBeGreaterThanOrEqual(12);
    expect(result.summary.groupCounts.service).toBeGreaterThanOrEqual(12);
    expect(result.summary.serviceCounts["IP Camera Sales"]).toBeLessThanOrEqual(8);
    expect(result.summary.serviceCounts["Security Camera Installation"]).toBeLessThanOrEqual(8);
    expect(result.summary.serviceCounts["Commercial Electrical Solutions"]).toBeGreaterThanOrEqual(2);
    expect(
      result.selected.filter(
        (candidate) =>
          candidate.semanticCluster === "security camera installation",
      ).length,
    ).toBe(1);
  });
});
