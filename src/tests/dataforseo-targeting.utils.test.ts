import { describe, expect, it } from "bun:test";
import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";
import { resolveDataForSEOKeywordTarget } from "../utils/dataforseo-targeting.utils";

const productContext: BusinessContextAnalysis = {
  businessModel: {
    type: "product",
    isLocationDependent: false,
  },
  services: {
    primary: ["HairFiller für Frauen", "Haarfüllerpulver"],
    secondary: ["Haarausfall kaschieren"],
    industry: "Haarpflege",
  },
  market: {
    geographic: {
      primary: "Germany",
      scope: "international",
    },
    industry: {
      vertical: "Haarverdichtung",
      b2bOrB2c: "B2C",
    },
    customerSegment: {
      primary: "Frauen und Männer mit dünner werdendem Haar",
      characteristics: ["D2C"],
    },
  },
  keywordStrategy: {
    intentDistribution: {
      informational: 50,
      commercial: 30,
      transactional: 15,
      navigational: 5,
    },
    difficultyDistribution: {
      easy: { min: 0, max: 45, count: 10 },
      medium: { min: 46, max: 70, count: 12 },
      hard: { min: 71, max: 90, count: 8 },
    },
    mustHaveKeywords: ["HairFiller für Frauen", "Haarfüllerpulver"],
    focusAreas: ["Haarausfall kaschieren"],
  },
  coreOfferings: {
    primary: ["HairFiller für Frauen"],
    secondary: ["Haarfüllerpulver"],
    explicitDescription: "HairFiller für Frauen",
    whatBusinessSells: "Haarfüllerpulver",
  },
  competitorNames: [],
};

describe("resolveDataForSEOKeywordTarget", () => {
  it("uses German language and Germany market for a German DTC product site even if saved location is US", () => {
    const target = resolveDataForSEOKeywordTarget(
      {
        businessName: "Hear Me Out",
        businessType: "HairFiller für Frauen",
        businessCountry: "USA",
        businessCity: "Atlanta",
        defaultLanguage: "en",
        defaultLocale: "en-US",
        supportedLanguages: [],
        keywords: [
          { keyword: "HairFiller für Frauen" },
          { keyword: "Haarfüllerpulver" },
          { keyword: "Haarausfall kaschieren" },
        ],
        websiteAnalysis: {
          coreServices: {
            topLevel: ["HairFiller für Frauen"],
            subOfferings: ["Sofortige Abdeckung dünner Stellen"],
            industryFocus: ["Haarpflege"],
          },
          businessInfo: {
            businessSummary:
              "Hear Me Out ist eine Direct-to-Consumer Marke für Haarverdichtung.",
          },
        },
      },
      productContext,
    );

    expect(target.languageCode).toBe("de");
    expect(target.locale).toBe("de-DE");
    expect(target.locationCountry).toBe("Germany");
    expect(target.locationCity).toBeNull();
    expect(target.locationCode).toBe(2276);
  });

  it("preserves city targeting for a location-dependent English US business", () => {
    const target = resolveDataForSEOKeywordTarget(
      {
        businessName: "Atlanta Plumbing",
        businessType: "Plumbing services",
        businessCountry: "USA",
        businessCity: "Atlanta",
        defaultLanguage: "en",
        defaultLocale: "en-US",
        supportedLanguages: [],
      },
      {
        businessModel: {
          type: "service",
          isLocationDependent: true,
        },
        services: {
          primary: ["Plumbing repair"],
          secondary: [],
          industry: "Plumbing",
        },
        keywordStrategy: {
          ...productContext.keywordStrategy,
          mustHaveKeywords: ["plumber atlanta"],
          focusAreas: ["emergency plumbing"],
        },
        market: {
          geographic: {
            primary: "Atlanta",
            scope: "local",
          },
          industry: {
            vertical: "Plumbing",
            b2bOrB2c: "B2C",
          },
          customerSegment: {
            primary: "Atlanta homeowners",
            characteristics: ["local"],
          },
        },
        coreOfferings: {
          primary: ["Plumbing repair"],
          secondary: [],
          explicitDescription: "Plumbing repair services",
          whatBusinessSells: "Plumbing repair services",
        },
        competitorNames: [],
      },
    );

    expect(target.languageCode).toBe("en");
    expect(target.locale).toBe("en-US");
    expect(target.locationCountry).toBe("USA");
    expect(target.locationCity).toBe("Atlanta");
    expect(target.locationCode).toBe(1015137);
  });
});
