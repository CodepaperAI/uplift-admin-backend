import { describe, expect, it } from "bun:test";
import {
  buildGeoAwareKeywordGenerationPrompt,
  parseGeoAwareKeywordIdeas,
} from "../llm/keywords/geo-keyword-llm";
import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";
import type { GeoKeywordContext } from "../utils/geo-keyword-context";

const businessContext: BusinessContextAnalysis = {
  businessModel: {
    type: "service",
    isLocationDependent: true,
  },
  services: {
    primary: ["Family Law", "Immigration Law", "Traffic Violations"],
    secondary: ["Notary Public"],
    industry: "Legal Services",
  },
  market: {
    geographic: {
      primary: "Brampton",
      secondary: ["Toronto"],
      scope: "regional",
    },
    industry: {
      vertical: "Legal Services",
      subVertical: ["Family Law", "Immigration Law"],
      b2bOrB2c: "B2C",
    },
    customerSegment: {
      primary: "Local individuals seeking legal help",
      characteristics: ["local", "service-area"],
    },
  },
  keywordStrategy: {
    intentDistribution: {
      informational: 50,
      commercial: 25,
      transactional: 20,
      navigational: 5,
    },
    difficultyDistribution: {
      easy: { min: 0, max: 45, count: 10 },
      medium: { min: 46, max: 70, count: 12 },
      hard: { min: 71, max: 85, count: 8 },
    },
    mustHaveKeywords: [],
    focusAreas: ["family law", "immigration appeals"],
  },
  coreOfferings: {
    primary: ["Family Law", "Immigration Law"],
    secondary: ["Traffic Violations"],
    explicitDescription: "Legal support for families and immigration matters.",
    whatBusinessSells: "legal services",
  },
  competitorNames: [],
};

const geoContext: GeoKeywordContext = {
  geoEligible: true,
  geoEligibilityReason: "local_or_regional",
  primaryTarget: {
    city: "Brampton",
    locationCode: 9000965,
    type: "primary",
    isResolved: true,
  },
  allTargets: [
    {
      city: "Brampton",
      locationCode: 9000965,
      type: "primary",
      isResolved: true,
    },
    {
      city: "Toronto",
      locationCode: 9000965,
      type: "service-area",
      isResolved: false,
    },
    {
      city: "Regional Municipality of Peel",
      locationCode: 9000965,
      type: "neighborhood",
      isResolved: true,
    },
  ],
  serviceAreaTargets: [
    {
      city: "Toronto",
      locationCode: 9000965,
      type: "service-area",
      isResolved: false,
    },
  ],
  neighborhoodTargets: [
    {
      city: "Regional Municipality of Peel",
      locationCode: 9000965,
      type: "neighborhood",
      isResolved: true,
    },
  ],
  languageCode: "en",
  countryLocationCode: 2124,
  priorityServices: ["Family Law", "Immigration Law", "Traffic Violations"],
  rawBusinessCity: "Brampton",
};

function makeParams() {
  return {
    business: {
      businessName: "Example Law",
      businessType: "Law Firm",
      businessDescription: "Legal help for families and immigration matters.",
      businessCity: "Brampton",
      businessState: "Ontario",
      businessCountry: "Canada",
      targetAudience: "Local residents",
      businessWebsiteUrl: "https://examplelaw.ca",
    },
    businessContext,
    geoContext,
    primaryServices: ["Family Law", "Immigration Law", "Traffic Violations"],
    focusAreas: ["family law", "immigration appeals"],
    expandedSubOfferings: ["child custody", "work permits"],
    existingKeywordTexts: ["old family law topic"],
    previousKeywords: [{ keyword: "previous immigration article" }],
    locationScope: "Brampton",
    limit: 10,
  };
}

describe("GEO-aware LLM keyword generation helpers", () => {
  it("builds prompts with allowed locations and no instruction to invent cities", () => {
    const prompt = buildGeoAwareKeywordGenerationPrompt(makeParams());

    expect(prompt).toContain("Allowed location names");
    expect(prompt).toContain("Brampton");
    expect(prompt).toContain("Toronto");
    expect(prompt).toContain("Do not invent unrelated practice areas, services, cities, or neighborhoods");
  });

  it("parses, dedupes, and attaches GEO metadata only for allowed locations", () => {
    const parsed = parseGeoAwareKeywordIdeas(
      JSON.stringify({
        ideas: [
          {
            keyword: "family law checklist brampton",
            intent: "informational",
            category: "local_guide",
            service: "Family Law",
            targetLocation: "Brampton",
            estimatedSearchVolume: 140,
            estimatedDifficulty: 38,
            reason: "Local family-law research topic.",
          },
          {
            keyword: "Family Law Checklist Brampton",
            intent: "informational",
            targetLocation: "Brampton",
          },
          {
            keyword: "immigration appeal questions toronto",
            intent: "commercial",
            service: "Immigration Law",
            targetLocation: null,
          },
          {
            keyword: "traffic ticket lawyer vancouver",
            intent: "transactional",
            service: "Traffic Violations",
            targetLocation: "Vancouver",
          },
          {
            keyword:
              "this keyword is far too long for the ten word keyword guardrail",
            intent: "informational",
          },
        ],
      }),
      makeParams(),
    );

    expect(parsed.map((idea) => idea.keyword)).toEqual([
      "family law checklist brampton",
      "immigration appeal questions toronto",
    ]);
    expect(parsed[0]?.geoTarget?.targetCity).toBe("Brampton");
    expect(parsed[0]?.geoTarget?.geoSource).toBe("primary");
    expect(parsed[1]?.geoTarget?.targetCity).toBe("Toronto");
    expect(parsed[1]?.geoTarget?.geoSource).toBe("service-area");
  });
});
