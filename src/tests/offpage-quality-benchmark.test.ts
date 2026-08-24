import { describe, expect, it } from "bun:test";
import {
  MAX_OFFPAGE_QA_LAST_CHECKED_AGE_DAYS,
  benchmarkPreManualGate,
  criticalFlags,
  opportunitiesFromPayload,
  qualityBucket,
  rowsWithReviewableOpportunities,
  summarizeBenchmarkReviewItems,
} from "../scripts/offpage-quality-benchmark";

const completeSegmentCounts = {
  local_service: 1,
  restaurant_hospitality: 1,
  saas: 1,
  ecommerce: 1,
  agency_professional: 1,
  other: 0,
};

describe("offpage quality benchmark helpers", () => {
  it("classifies confidence scores into manual QA buckets", () => {
    expect(qualityBucket(undefined)).toBe("needs_refresh");
    expect(qualityBucket(90)).toBe("good");
    expect(qualityBucket(70)).toBe("okay");
    expect(qualityBucket(55)).toBe("needs_review");
    expect(qualityBucket(20)).toBe("bad");
  });

  it("extracts opportunities from cached payloads without trusting malformed data", () => {
    expect(opportunitiesFromPayload(null)).toEqual([]);
    expect(opportunitiesFromPayload({ opportunities: "nope" })).toEqual([]);
    expect(opportunitiesFromPayload({ opportunities: [{ key: "reddit:toronto" }] })).toEqual([
      { key: "reddit:toronto" },
    ]);
  });

  it("filters benchmark rows to caches with reviewable opportunities", () => {
    const rows = [
      { businessId: "empty", payload: { opportunities: [] } },
      { businessId: "malformed", payload: { opportunities: "nope" } },
      { businessId: "ready", payload: { opportunities: [{ key: "directory:yelp" }] } },
    ];

    expect(rowsWithReviewableOpportunities(rows).map((row) => row.businessId)).toEqual([
      "ready",
    ]);
  });

  it("summarizes benchmark review items with critical flag counts", () => {
    const summary = summarizeBenchmarkReviewItems([
      {
        automatedBucket: "good",
        leverKey: "reddit",
        criticalFlags: ["wrong_business_warning", "dead_or_unreachable_url_warning"],
      },
      {
        automatedBucket: "needs_refresh",
        leverKey: "directory",
        criticalFlags: ["dead_or_unreachable_url_warning"],
      },
      {
        automatedBucket: "needs_review",
        leverKey: "directory",
        criticalFlags: [],
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.reddit).toBe(1);
    expect(summary.directory).toBe(2);
    expect(summary.good).toBe(1);
    expect(summary.needs_refresh).toBe(1);
    expect(summary.needs_review).toBe(1);
    expect(summary.withCriticalFlags).toBe(2);
    expect(summary.criticalFlagCounts).toEqual({
      wrong_business_warning: 1,
      dead_or_unreachable_url_warning: 2,
    });
  });

  it("reports whether the benchmark is ready for manual scoring", () => {
    const legacyTotals = summarizeBenchmarkReviewItems([
      {
        automatedBucket: "needs_refresh",
        leverKey: "directory",
        criticalFlags: ["missing_confidence"],
      },
    ]);
    expect(benchmarkPreManualGate(legacyTotals)).toEqual({
      readyForManualScoring: false,
      requiredLevers: [],
      missingRequiredLevers: [],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: [
        "1 review items still need V2 refresh",
        "1 review items have automated critical flags",
      ],
    });

    const cleanTotals = summarizeBenchmarkReviewItems([
      { automatedBucket: "good", leverKey: "reddit", criticalFlags: [] },
      { automatedBucket: "okay", leverKey: "directory", criticalFlags: [] },
    ]);
    expect(benchmarkPreManualGate(cleanTotals)).toEqual({
      readyForManualScoring: true,
      requiredLevers: [],
      missingRequiredLevers: [],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: [],
    });

    expect(
      benchmarkPreManualGate(cleanTotals, {
        requiredLevers: ["reddit", "directory"],
      }),
    ).toEqual({
      readyForManualScoring: true,
      requiredLevers: ["reddit", "directory"],
      missingRequiredLevers: [],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: [],
    });

    const directoryOnlyTotals = summarizeBenchmarkReviewItems([
      { automatedBucket: "good", leverKey: "directory", criticalFlags: [] },
    ]);
    expect(
      benchmarkPreManualGate(directoryOnlyTotals, {
        requiredLevers: ["reddit", "directory"],
      }),
    ).toEqual({
      readyForManualScoring: false,
      requiredLevers: ["reddit", "directory"],
      missingRequiredLevers: ["reddit"],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: ["Missing required benchmark levers: reddit"],
    });

    expect(
      benchmarkPreManualGate(cleanTotals, {
        benchmarkBusinesses: 19,
        minimumBusinesses: 20,
      }),
    ).toEqual({
      readyForManualScoring: false,
      requiredLevers: [],
      missingRequiredLevers: [],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: ["19 benchmark businesses is below required 20"],
    });

    expect(
      benchmarkPreManualGate(cleanTotals, {
        requiredSegments: [
          "local_service",
          "restaurant_hospitality",
          "saas",
          "ecommerce",
          "agency_professional",
        ],
        businessSegments: {
          ...completeSegmentCounts,
          ecommerce: 0,
        },
      }),
    ).toEqual({
      readyForManualScoring: false,
      requiredLevers: [],
      missingRequiredLevers: [],
      requiredSegments: [
        "local_service",
        "restaurant_hospitality",
        "saas",
        "ecommerce",
        "agency_professional",
      ],
      missingRequiredSegments: ["ecommerce"],
      minimumReviewItemsPerRequiredLever: null,
      shallowRequiredLevers: [],
      failures: ["Missing required benchmark segments: ecommerce"],
    });

    const shallowLeverTotals = summarizeBenchmarkReviewItems([
      ...Array.from({ length: 4 }, () => ({
        automatedBucket: "good" as const,
        leverKey: "reddit",
        criticalFlags: [],
      })),
      ...Array.from({ length: 6 }, () => ({
        automatedBucket: "good" as const,
        leverKey: "directory",
        criticalFlags: [],
      })),
    ]);
    expect(
      benchmarkPreManualGate(shallowLeverTotals, {
        requiredLevers: ["reddit", "directory"],
        minimumReviewItemsPerRequiredLever: 5,
      }),
    ).toEqual({
      readyForManualScoring: false,
      requiredLevers: ["reddit", "directory"],
      missingRequiredLevers: [],
      requiredSegments: [],
      missingRequiredSegments: [],
      minimumReviewItemsPerRequiredLever: 5,
      shallowRequiredLevers: ["reddit"],
      failures: ["reddit review item count 4 is below required 5"],
    });
  });

  it("flags critical Reddit and directory failures for manual QA", () => {
    expect(
      criticalFlags({
        leverKey: "reddit",
        url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
        confidence: 75,
        threads: [
          {
            title: "Best plumber?",
            url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
            ageDays: 1800,
          },
        ],
      }),
    ).toContain("very_old_reddit_thread");

    const deletedFlags = criticalFlags({
      leverKey: "reddit",
      url: "https://www.reddit.com/r/toronto/comments/def/best_plumber",
      confidence: 75,
      threads: [
        {
          title: "Best plumber?",
          url: "https://www.reddit.com/r/toronto/comments/def/best_plumber",
          deleted: true,
        },
      ],
    });
    expect(deletedFlags).toContain("deleted_or_unavailable_thread");
    expect(deletedFlags).toContain("reddit_thread_detail_unchecked");

    const lockedFlags = criticalFlags({
      leverKey: "reddit",
      url: "https://www.reddit.com/r/toronto/comments/ghi/best_plumber",
      confidence: 75,
      sourceType: "reddit_thread",
      lastCheckedAt: "2026-06-30T00:00:00.000Z",
      evidenceSources: ["live_search", "thread_page"],
      whyRecommended: "Thread has buyer intent.",
      threads: [
        {
          title: "Best plumber?",
          url: "https://www.reddit.com/r/toronto/comments/ghi/best_plumber",
          locked: true,
          detailCheckedAt: "2026-06-30T00:00:00.000Z",
        },
      ],
    });
    expect(lockedFlags).toContain("locked_or_archived_thread");

    expect(
      criticalFlags({
        leverKey: "directory",
        url: "https://directory.example",
        confidence: 75,
        sourceType: "directory",
        lastCheckedAt: "2026-06-30T00:00:00.000Z",
        evidenceSources: ["directory_reachability"],
        whyRecommended: "Directory is reachable.",
        submissionUrl: "https://directory.example/claim",
        submissionUrlType: "homepage",
        pricingModel: "free",
      }),
    ).toContain("directory_homepage_or_unknown_submission");

    const missingDirectoryTargetFlags = criticalFlags({
      leverKey: "directory",
      url: "https://directory.example",
      confidence: 75,
      confidenceLevel: "medium",
      sourceType: "directory",
      lastCheckedAt: "2026-06-30T00:00:00.000Z",
      evidenceSources: ["directory_reachability"],
      whyRecommended: "Directory is reachable.",
    });
    expect(missingDirectoryTargetFlags).toContain("missing_submission_url");
    expect(missingDirectoryTargetFlags).toContain("missing_submission_url_type");
    expect(missingDirectoryTargetFlags).toContain("missing_pricing_model");

    const invalidDirectoryUrls = criticalFlags({
      leverKey: "directory",
      url: "not-a-url",
      confidence: 75,
      confidenceLevel: "medium",
      sourceType: "directory",
      lastCheckedAt: "2026-06-30T00:00:00.000Z",
      evidenceSources: ["directory_reachability"],
      whyRecommended: "Directory is reachable.",
      submissionUrl: "mailto:submit@directory.example",
      submissionUrlType: "add_business",
      pricingModel: "free",
    });
    expect(invalidDirectoryUrls).toContain("invalid_url");
    expect(invalidDirectoryUrls).toContain("invalid_submission_url");

    expect(criticalFlags({ leverKey: "directory", confidence: 75 })).toContain(
      "missing_url",
    );
    expect(criticalFlags({ leverKey: "directory", confidence: 75 })).toContain(
      "missing_evidence_sources",
    );
    expect(criticalFlags({ leverKey: "directory", confidence: 75 })).toContain(
      "missing_why_recommended",
    );
    expect(criticalFlags({ leverKey: "directory", confidence: 75 })).toContain(
      "missing_source_type",
    );
    expect(criticalFlags({ leverKey: "directory", confidence: 75 })).toContain(
      "missing_last_checked_at",
    );

    const legacyFlags = criticalFlags({
      leverKey: "directory",
      url: "https://directory.example",
    });
    expect(legacyFlags).toContain("missing_confidence");
    expect(legacyFlags).toContain("missing_confidence_level");
    expect(legacyFlags).toContain("missing_source_type");
    expect(legacyFlags).toContain("missing_last_checked_at");
    expect(legacyFlags).toContain("missing_evidence_sources");
    expect(legacyFlags).toContain("missing_why_recommended");
    expect(legacyFlags).toContain("missing_submission_url");
    expect(legacyFlags).toContain("missing_submission_url_type");
    expect(legacyFlags).toContain("missing_pricing_model");

    expect(
      criticalFlags({
        leverKey: "directory",
        url: "https://directory.example",
        confidence: 20,
        sourceType: "directory",
        lastCheckedAt: "2026-06-30T00:00:00.000Z",
        evidenceSources: ["directory_reachability"],
        whyRecommended: "Directory is reachable.",
        submissionUrl: "https://directory.example/add-business",
        submissionUrlType: "add_business",
        pricingModel: "free",
      }),
    ).toContain("low_confidence_visible");

    expect(
      criticalFlags({
        leverKey: "reddit",
        url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
        confidence: 75,
        sourceType: "reddit_thread",
        lastCheckedAt: "2026-06-30T00:00:00.000Z",
        evidenceSources: ["live_search", "thread_page"],
        whyRecommended: "Thread has buyer intent.",
        threads: [
          {
            title: "Best plumber?",
            url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
            detailCheckedAt: "2026-06-30T00:00:00.000Z",
            draft: "Visit https://example.com and book a call today.",
          },
        ],
      }),
    ).toContain("spammy_or_unsafe_reddit_draft");

    const warningFlags = criticalFlags({
      leverKey: "reddit",
      url: "https://www.reddit.com/r/toronto/comments/jkl/best_plumber",
      confidence: 75,
      confidenceLevel: "medium",
      sourceType: "reddit_thread",
      lastCheckedAt: "2026-06-30T00:00:00.000Z",
      evidenceSources: ["live_search", "thread_page", "strict_reviewer"],
      whyRecommended: "Thread has buyer intent.",
      validatorReason:
        "Wrong business and wrong country. The suggested reply would be spammy.",
      qualityWarnings: ["Dead URL: 404 not found"],
      threads: [
        {
          title: "Best plumber?",
          url: "https://www.reddit.com/r/toronto/comments/jkl/best_plumber",
          detailCheckedAt: "2026-06-30T00:00:00.000Z",
        },
      ],
    });
    expect(warningFlags).toContain("wrong_business_warning");
    expect(warningFlags).toContain("location_or_language_warning");
    expect(warningFlags).toContain("dead_or_unreachable_url_warning");
    expect(warningFlags).toContain("spammy_or_unsafe_reddit_intent");
  });

  it("flags Reddit opportunities that do not point to real thread permalinks", () => {
    const common = {
      leverKey: "reddit" as const,
      confidence: 75,
      confidenceLevel: "medium",
      sourceType: "reddit_thread",
      lastCheckedAt: "2026-06-30T00:00:00.000Z",
      evidenceSources: ["live_search", "thread_page"],
      whyRecommended: "Thread has buyer intent.",
    };

    expect(
      criticalFlags({
        ...common,
        url: "https://www.reddit.com/r/toronto/",
        threads: [
          {
            title: "Best plumber?",
            url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
            detailCheckedAt: "2026-06-30T00:00:00.000Z",
          },
        ],
      }),
    ).toContain("invalid_reddit_opportunity_url");

    expect(
      criticalFlags({
        ...common,
        url: "https://old.reddit.com/r/toronto/comments/abc/best_plumber",
        threads: [
          {
            title: "Best plumber?",
            url: "https://old.reddit.com/r/toronto/comments/abc/best_plumber",
            detailCheckedAt: "2026-06-30T00:00:00.000Z",
          },
        ],
      }),
    ).not.toContain("invalid_reddit_opportunity_url");

    expect(
      criticalFlags({
        ...common,
        url: "https://www.reddit.com/r/toronto/comments/abc/best_plumber",
        threads: [
          {
            title: "Best plumber?",
            url: "https://example.com/r/toronto/comments/abc/best_plumber",
            detailCheckedAt: "2026-06-30T00:00:00.000Z",
          },
        ],
      }),
    ).toContain("invalid_reddit_thread_url");
  });

  it("flags missing, invalid, stale, or future verification timestamps", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const common = {
      leverKey: "directory" as const,
      url: "https://directory.example",
      confidence: 75,
      confidenceLevel: "medium",
      sourceType: "directory",
      evidenceSources: ["directory_reachability"],
      whyRecommended: "Directory is reachable.",
      submissionUrl: "https://directory.example/add-business",
      submissionUrlType: "add_business",
      pricingModel: "free",
    };

    expect(criticalFlags({ ...common, lastCheckedAt: "not-a-date" }, now)).toContain(
      "invalid_last_checked_at",
    );
    expect(
      criticalFlags(
        {
          ...common,
          lastCheckedAt: new Date(
            now.getTime() - (MAX_OFFPAGE_QA_LAST_CHECKED_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        now,
      ),
    ).toContain("stale_last_checked_at");
    expect(
      criticalFlags(
        {
          ...common,
          lastCheckedAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
        now,
      ),
    ).toContain("future_last_checked_at");
  });
});
