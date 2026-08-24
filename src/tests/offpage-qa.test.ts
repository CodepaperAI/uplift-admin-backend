import { describe, expect, it } from "bun:test";
import {
  MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
  REQUIRED_OFFPAGE_QA_LEVERS,
  REQUIRED_OFFPAGE_QA_SEGMENTS,
  classifyOffPageQaBusinessSegment,
  selectStratifiedOffPageBenchmarkRows,
  summarizeBusinessSegments,
  summarizeOffPageManualQa,
} from "../services/offpage/offpage-qa.service";

describe("summarizeOffPageManualQa", () => {
  it("passes only when all items are scored and quality targets are met", () => {
    const summary = summarizeOffPageManualQa([
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "okay", criticalFlags: [] },
    ]);

    expect(summary.complete).toBe(true);
    expect(summary.goodRate).toBe(0.8);
    expect(summary.badRate).toBe(0);
    expect(summary.benchmarkBusinesses).toBe(null);
    expect(summary.uniqueBenchmarkBusinesses).toBe(null);
    expect(summary.minimumBusinesses).toBe(null);
    expect(summary.requiredSegments).toEqual([]);
    expect(summary.missingRequiredSegments).toEqual([]);
    expect(summary.requiredLevers).toEqual([]);
    expect(summary.missingRequiredLevers).toEqual([]);
    expect(summary.minimumReviewItemsPerRequiredLever).toBe(null);
    expect(summary.shallowRequiredLevers).toEqual([]);
    expect(summary.passed).toBe(true);
  });

  it("enforces the 20-business benchmark requirement when metadata is provided", () => {
    const scoredItems = Array.from({ length: 20 }, (_, index) => ({
      businessId: `business-${index + 1}`,
      leverKey: index % 2 === 0 ? ("reddit" as const) : ("directory" as const),
      manualScore: index < 16 ? ("good" as const) : ("okay" as const),
      criticalFlags: [],
    }));

    const partial = summarizeOffPageManualQa(scoredItems, {
      benchmarkBusinesses: 19,
      minimumBusinesses: 20,
    });
    expect(partial.passed).toBe(false);
    expect(partial.benchmarkBusinesses).toBe(19);
    expect(partial.uniqueBenchmarkBusinesses).toBe(20);
    expect(partial.minimumBusinesses).toBe(20);
    expect(partial.failures).toContain("19 benchmark businesses is below required 20");

    const complete = summarizeOffPageManualQa(scoredItems, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
    });
    expect(complete.passed).toBe(true);
  });

  it("fails when benchmark metadata is inflated but review items have fewer unique businesses", () => {
    const scoredItems = Array.from({ length: 20 }, (_, index) => ({
      businessId: `business-${(index % 19) + 1}`,
      leverKey: index % 2 === 0 ? ("reddit" as const) : ("directory" as const),
      manualScore: index < 16 ? ("good" as const) : ("okay" as const),
      criticalFlags: [],
    }));

    const summary = summarizeOffPageManualQa(scoredItems, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
    });

    expect(summary.benchmarkBusinesses).toBe(20);
    expect(summary.uniqueBenchmarkBusinesses).toBe(19);
    expect(summary.passed).toBe(false);
    expect(summary.failures).toContain(
      "19 unique benchmark businesses is below required 20",
    );
  });

  it("enforces required benchmark segment coverage when configured", () => {
    const completeSegments = REQUIRED_OFFPAGE_QA_SEGMENTS.flatMap((segment, index) => [
      {
        businessId: `${segment}-business-${index + 1}`,
        businessSegment: segment,
        leverKey: "directory" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: `${segment}-business-extra-${index + 1}`,
        businessSegment: segment,
        leverKey: "reddit" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: `${segment}-business-more-${index + 1}`,
        businessSegment: segment,
        leverKey: "directory" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: `${segment}-business-ok-${index + 1}`,
        businessSegment: segment,
        leverKey: "reddit" as const,
        manualScore: "okay" as const,
        criticalFlags: [],
      },
    ]).map((item, index) => ({
      ...item,
      manualScore: index < 16 ? ("good" as const) : ("okay" as const),
    }));

    const complete = summarizeOffPageManualQa(completeSegments, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
      requiredSegments: REQUIRED_OFFPAGE_QA_SEGMENTS,
    });
    expect(complete.passed).toBe(true);
    expect(complete.missingRequiredSegments).toEqual([]);
    expect(complete.uniqueBusinessSegments).toMatchObject({
      local_service: 4,
      restaurant_hospitality: 4,
      saas: 4,
      ecommerce: 4,
      agency_professional: 4,
    });

    const missingEcommerce = completeSegments
      .filter((item) => item.businessSegment !== "ecommerce")
      .map((item, index) => ({ ...item, businessId: `business-${index + 1}` }));
    const partial = summarizeOffPageManualQa(missingEcommerce, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
      requiredSegments: REQUIRED_OFFPAGE_QA_SEGMENTS,
    });
    expect(partial.passed).toBe(false);
    expect(partial.missingRequiredSegments).toEqual(["ecommerce"]);
    expect(partial.failures).toContain("Missing required benchmark segments: ecommerce");
  });

  it("requires segment coverage to come from identifiable businesses", () => {
    const items = [
      {
        businessId: null,
        businessSegment: "ecommerce" as const,
        leverKey: "directory" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: "restaurant-1",
        businessSegment: "restaurant_hospitality" as const,
        leverKey: "reddit" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: "saas-1",
        businessSegment: "saas" as const,
        leverKey: "directory" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      {
        businessId: "agency-1",
        businessSegment: "agency_professional" as const,
        leverKey: "reddit" as const,
        manualScore: "good" as const,
        criticalFlags: [],
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        businessId: `local-${index + 1}`,
        businessSegment: "local_service" as const,
        leverKey: index % 2 === 0 ? ("directory" as const) : ("reddit" as const),
        manualScore: "good" as const,
        criticalFlags: [],
      })),
    ];

    const summary = summarizeOffPageManualQa(items, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
      requiredSegments: REQUIRED_OFFPAGE_QA_SEGMENTS,
    });

    expect(summary.uniqueBenchmarkBusinesses).toBe(20);
    expect(summary.businessSegments.ecommerce).toBe(1);
    expect(summary.uniqueBusinessSegments.ecommerce).toBe(0);
    expect(summary.passed).toBe(false);
    expect(summary.missingRequiredSegments).toEqual(["ecommerce"]);
  });

  it("enforces required Reddit and directory coverage when configured", () => {
    const directoryOnlyItems = Array.from({ length: 20 }, (_, index) => ({
      businessId: `business-${index + 1}`,
      leverKey: "directory" as const,
      manualScore: index < 16 ? ("good" as const) : ("okay" as const),
      criticalFlags: [],
    }));

    const directoryOnly = summarizeOffPageManualQa(directoryOnlyItems, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
      requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
    });
    expect(directoryOnly.passed).toBe(false);
    expect(directoryOnly.missingRequiredLevers).toEqual(["reddit"]);
    expect(directoryOnly.failures).toContain("Missing required benchmark levers: reddit");

    const bothLevers = summarizeOffPageManualQa(
      directoryOnlyItems.map((item, index) => ({
        ...item,
        leverKey: index % 2 === 0 ? ("reddit" as const) : ("directory" as const),
      })),
      {
        benchmarkBusinesses: 20,
        minimumBusinesses: 20,
        requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
      },
    );
    expect(bothLevers.passed).toBe(true);
    expect(bothLevers.missingRequiredLevers).toEqual([]);
  });

  it("enforces minimum review-item depth for each required lever", () => {
    const shallowReddit = Array.from({ length: 20 }, (_, index) => ({
      businessId: `business-${index + 1}`,
      leverKey: index < 4 ? ("reddit" as const) : ("directory" as const),
      manualScore: "good" as const,
      criticalFlags: [],
    }));

    const shallow = summarizeOffPageManualQa(shallowReddit, {
      benchmarkBusinesses: 20,
      minimumBusinesses: 20,
      requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
      minimumReviewItemsPerRequiredLever:
        MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
    });
    expect(shallow.passed).toBe(false);
    expect(shallow.minimumReviewItemsPerRequiredLever).toBe(
      MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
    );
    expect(shallow.shallowRequiredLevers).toEqual(["reddit"]);
    expect(shallow.failures).toContain(
      "reddit review item count 4 is below required 5",
    );

    const deepEnough = summarizeOffPageManualQa(
      shallowReddit.map((item, index) => ({
        ...item,
        leverKey: index < 5 ? ("reddit" as const) : ("directory" as const),
      })),
      {
        benchmarkBusinesses: 20,
        minimumBusinesses: 20,
        requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
        minimumReviewItemsPerRequiredLever:
          MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
      },
    );
    expect(deepEnough.passed).toBe(true);
    expect(deepEnough.shallowRequiredLevers).toEqual([]);
  });

  it("fails incomplete or critical-bad manual reviews", () => {
    const summary = summarizeOffPageManualQa([
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "bad", criticalFlags: ["missing_url"] },
      { leverKey: "directory", manualScore: null, criticalFlags: [] },
    ]);

    expect(summary.complete).toBe(false);
    expect(summary.passed).toBe(false);
    expect(summary.criticalBad).toBe(1);
    expect(summary.criticalFlagCounts).toEqual({ missing_url: 1 });
    expect(summary.failures).toContain("1 review items are unscored");
    expect(summary.failures).toContain("1 critical bad results found");
  });

  it("fails release gate when automated critical flags exist even if manually scored good", () => {
    const summary = summarizeOffPageManualQa([
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      {
        leverKey: "reddit",
        manualScore: "good",
        criticalFlags: ["spammy_or_unsafe_reddit_draft"],
      },
    ]);

    expect(summary.complete).toBe(true);
    expect(summary.goodRate).toBe(1);
    expect(summary.criticalBad).toBe(1);
    expect(summary.criticalFlagCounts).toEqual({
      spammy_or_unsafe_reddit_draft: 1,
    });
    expect(summary.passed).toBe(false);
    expect(summary.failures).toContain("1 critical bad results found");
  });

  it("counts duplicate critical flag reasons for release triage", () => {
    const summary = summarizeOffPageManualQa([
      {
        leverKey: "reddit",
        manualScore: "bad",
        criticalFlags: ["wrong_business_warning", "dead_or_unreachable_url_warning"],
      },
      {
        leverKey: "directory",
        manualScore: "bad",
        criticalFlags: ["dead_or_unreachable_url_warning"],
      },
    ]);

    expect(summary.withCriticalFlags).toBe(2);
    expect(summary.criticalFlagCounts).toEqual({
      wrong_business_warning: 1,
      dead_or_unreachable_url_warning: 2,
    });
  });

  it("fails release gate when legacy items still need V2 refresh even if manually scored good", () => {
    const summary = summarizeOffPageManualQa([
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "directory", manualScore: "good", criticalFlags: [] },
      { leverKey: "reddit", manualScore: "good", criticalFlags: [] },
      {
        leverKey: "directory",
        manualScore: "good",
        criticalFlags: [],
        automatedBucket: "needs_refresh",
      },
    ]);

    expect(summary.complete).toBe(true);
    expect(summary.goodRate).toBe(1);
    expect(summary.needsRefresh).toBe(1);
    expect(summary.criticalBad).toBe(1);
    expect(summary.passed).toBe(false);
    expect(summary.failures).toContain("1 review items still need V2 refresh");
  });
});

describe("off-page QA business segments", () => {
  it("classifies businesses into benchmark coverage segments", () => {
    expect(
      classifyOffPageQaBusinessSegment({
        businessName: "Shawarma Moose",
        businessType: "Restaurant",
      }),
    ).toBe("restaurant_hospitality");
    expect(
      classifyOffPageQaBusinessSegment({
        businessName: "WorkflowPilot",
        businessType: "SaaS workflow automation",
      }),
    ).toBe("saas");
    expect(
      classifyOffPageQaBusinessSegment({
        businessName: "Northstar SEO Agency",
        businessType: "Marketing agency",
      }),
    ).toBe("agency_professional");
    expect(
      classifyOffPageQaBusinessSegment({
        businessName: "Crystal Clear Window Care",
        businessType: "Window cleaning",
      }),
    ).toBe("local_service");
  });

  it("summarizes segment coverage for selected businesses", () => {
    expect(
      summarizeBusinessSegments([
        { businessName: "House of Pizza", businessType: "Restaurant" },
        { businessName: "Metro Tiles", businessType: "Flooring contractor" },
        { businessName: "OpsFlow", businessType: "SaaS platform" },
      ]),
    ).toMatchObject({
      restaurant_hospitality: 1,
      local_service: 1,
      saas: 1,
    });
  });
});

describe("selectStratifiedOffPageBenchmarkRows", () => {
  it("selects one row from each available segment before filling by recency", () => {
    const rows = [
      { businessId: "recent-local-2", generatedAt: new Date("2026-06-30T10:00:00Z") },
      { businessId: "recent-local-1", generatedAt: new Date("2026-06-30T09:00:00Z") },
      { businessId: "saas", generatedAt: new Date("2026-06-29T09:00:00Z") },
      { businessId: "restaurant", generatedAt: new Date("2026-06-28T09:00:00Z") },
      { businessId: "agency", generatedAt: new Date("2026-06-27T09:00:00Z") },
    ];
    const businessById = new Map([
      ["recent-local-2", { id: "recent-local-2", businessType: "Moving service" }],
      ["recent-local-1", { id: "recent-local-1", businessType: "Window cleaning" }],
      ["saas", { id: "saas", businessType: "SaaS platform" }],
      ["restaurant", { id: "restaurant", businessType: "Restaurant" }],
      ["agency", { id: "agency", businessType: "Marketing agency" }],
    ]);

    const selected = selectStratifiedOffPageBenchmarkRows(rows, businessById, 4);
    expect(selected.map((row) => row.businessId)).toEqual([
      "recent-local-2",
      "restaurant",
      "saas",
      "agency",
    ]);
  });
});
