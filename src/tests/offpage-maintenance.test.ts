import { describe, expect, it } from "bun:test";
import {
  cacheNeedsV2Refresh,
  classifyOffPageRefreshReason,
  opportunityHasV2QualityMetadata,
  selectOffPageRefreshCandidates,
} from "../services/offpage/offpage-maintenance.service";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const PAST = new Date("2026-06-29T12:00:00.000Z");
const FUTURE = new Date("2026-07-01T12:00:00.000Z");

function row(
  businessId: string,
  expiresAt: Date,
  payload: unknown,
  generatedAt = PAST,
) {
  return { businessId, generatedAt, expiresAt, payload };
}

function business(id: string, isActive = true) {
  return {
    id,
    userId: `user-${id}`,
    businessName: `Business ${id}`,
    isActive,
  };
}

function qualitySummary(overrides: Record<string, unknown> = {}) {
  return {
    totalCandidates: 1,
    shown: 1,
    hiddenLowConfidence: 0,
    rejected: 0,
    averageConfidence: 90,
    highConfidence: 1,
    mediumConfidence: 0,
    needsReview: 0,
    lowConfidence: 0,
    byLever: { directory: 1 },
    byConfidenceLevel: { high: 1 },
    bySourceType: { business_profile: 1 },
    evidenceSourceCounts: { directory_reachability: 1 },
    rejectionReasons: {},
    ...overrides,
  };
}

describe("off-page maintenance metadata checks", () => {
  it("recognizes V2 quality metadata on Reddit and directory opportunities", () => {
    expect(
      opportunityHasV2QualityMetadata({
        leverKey: "reddit",
        url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
        confidence: 86,
        confidenceLevel: "high",
        sourceType: "reddit_thread",
        evidenceSources: ["live_search", "thread_page"],
        whyRecommended: "The thread is active and page checked.",
        lastCheckedAt: NOW.toISOString(),
        qualitySignals: ["Recent thread"],
        qualityWarnings: [],
        threads: [
          {
            url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
            detailCheckedAt: NOW.toISOString(),
            locked: false,
            archived: false,
            deleted: false,
            unavailable: false,
          },
        ],
      }),
    ).toBe(true);

    expect(
      opportunityHasV2QualityMetadata({
        leverKey: "directory",
        confidence: 86,
        confidenceLevel: "high",
      }),
    ).toBe(false);
  });

  it("marks legacy cached opportunities for V2 refresh", () => {
    expect(
      cacheNeedsV2Refresh({
        opportunities: [
          {
            leverKey: "directory",
            title: "List on Google Business Profile",
            url: "https://www.google.com/business/",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects malformed V2 metadata so bad cache rows are refreshed", () => {
    const valid = {
      leverKey: "directory",
      url: "https://directory.example/add-business",
      confidence: 86,
      confidenceLevel: "high",
      sourceType: "business_profile",
      evidenceSources: ["directory_reachability", "known_submission_map"],
      whyRecommended: "A direct claim page is available.",
      lastCheckedAt: NOW.toISOString(),
      qualitySignals: [],
      qualityWarnings: [],
      submissionUrl: "https://directory.example/add-business",
      submissionUrlType: "add_business",
      pricingModel: "free",
    };

    expect(opportunityHasV2QualityMetadata({ ...valid, confidence: 101 })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, confidenceLevel: "great" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, sourceType: "random_source" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, evidenceSources: ["unknown"] })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, lastCheckedAt: "not-a-date" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, url: "mailto:submit@example.com" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, submissionUrl: "not-a-url" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, submissionUrlType: "contact_form" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, submissionUrlType: "homepage" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, submissionUrlType: "unknown" })).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, pricingModel: "barter" })).toBe(false);
    expect(
      cacheNeedsV2Refresh({
        qualitySummary: qualitySummary(),
        opportunities: [{ ...valid, evidenceSources: ["unknown"] }],
      }),
    ).toBe(true);
  });

  it("rejects malformed Reddit V2 metadata so unusable thread rows are refreshed", () => {
    const valid = {
      leverKey: "reddit",
      url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
      confidence: 86,
      confidenceLevel: "high",
      sourceType: "reddit_thread",
      evidenceSources: ["live_search", "thread_page"],
      whyRecommended: "The thread is active and page checked.",
      lastCheckedAt: NOW.toISOString(),
      qualitySignals: ["Recent thread"],
      qualityWarnings: [],
      threads: [
        {
          url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
          detailCheckedAt: NOW.toISOString(),
          locked: false,
          archived: false,
          deleted: false,
          unavailable: false,
        },
      ],
    };

    expect(
      opportunityHasV2QualityMetadata({
        ...valid,
        url: "https://www.reddit.com/r/toronto/",
      }),
    ).toBe(false);
    expect(opportunityHasV2QualityMetadata({ ...valid, threads: [] })).toBe(false);
    expect(
      opportunityHasV2QualityMetadata({
        ...valid,
        threads: [{ ...valid.threads[0], url: "https://www.reddit.com/r/ottawa/" }],
      }),
    ).toBe(false);
    expect(
      opportunityHasV2QualityMetadata({
        ...valid,
        threads: [{ ...valid.threads[0], detailCheckedAt: null }],
      }),
    ).toBe(false);
    expect(
      opportunityHasV2QualityMetadata({
        ...valid,
        threads: [{ ...valid.threads[0], locked: true }],
      }),
    ).toBe(false);
    expect(
      opportunityHasV2QualityMetadata({
        ...valid,
        threads: [{ ...valid.threads[0], deleted: true }],
      }),
    ).toBe(false);
  });

  it("classifies expired and legacy refresh reasons", () => {
    const legacyPayload = {
      opportunities: [{ leverKey: "reddit", title: "Reply in r/toronto" }],
    };
    const v2Payload = {
      qualitySummary: qualitySummary({
        byLever: { reddit: 1 },
        bySourceType: { reddit_thread: 1 },
        evidenceSourceCounts: { live_search: 1, thread_page: 1 },
      }),
      opportunities: [
        {
          leverKey: "reddit",
          url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
          confidence: 90,
          confidenceLevel: "high",
          sourceType: "reddit_thread",
          evidenceSources: ["live_search", "thread_page"],
          whyRecommended: "The thread is active and page checked.",
          lastCheckedAt: NOW.toISOString(),
          qualitySignals: [],
          qualityWarnings: [],
          threads: [
            {
              url: "https://www.reddit.com/r/toronto/comments/abc123/best_plumber/",
              detailCheckedAt: NOW.toISOString(),
              locked: false,
              archived: false,
              deleted: false,
              unavailable: false,
            },
          ],
        },
      ],
    };

    expect(classifyOffPageRefreshReason(row("a", FUTURE, legacyPayload), NOW)).toBe(
      "legacy_v2_metadata",
    );
    expect(classifyOffPageRefreshReason(row("a", PAST, v2Payload), NOW)).toBe(
      "expired",
    );
    expect(classifyOffPageRefreshReason(row("a", PAST, legacyPayload), NOW)).toBe(
      "expired_and_legacy_v2_metadata",
    );
  });

  it("marks caches without V2 quality summary analytics for refresh", () => {
    expect(
      cacheNeedsV2Refresh({
        opportunities: [
          {
            leverKey: "directory",
            url: "https://directory.example/add-business",
            confidence: 90,
            confidenceLevel: "high",
            sourceType: "business_profile",
            evidenceSources: ["directory_reachability", "known_submission_map"],
            whyRecommended: "A direct claim page is available.",
            lastCheckedAt: NOW.toISOString(),
            qualitySignals: [],
            qualityWarnings: [],
            submissionUrl: "https://directory.example/add-business",
            submissionUrlType: "add_business",
            pricingModel: "free",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("selectOffPageRefreshCandidates", () => {
  it("prioritizes expired legacy rows and skips inactive businesses", () => {
    const candidates = selectOffPageRefreshCandidates(
      [
        row("active-legacy", PAST, {
          opportunities: [{ leverKey: "directory", title: "Legacy" }],
        }),
        row("active-expired", PAST, {
          qualitySummary: qualitySummary(),
          opportunities: [
            {
              leverKey: "directory",
              url: "https://directory.example/add-business",
              confidence: 90,
              confidenceLevel: "high",
              sourceType: "business_profile",
              evidenceSources: ["directory_reachability", "known_submission_map"],
              whyRecommended: "A direct claim page is available.",
              lastCheckedAt: NOW.toISOString(),
              qualitySignals: [],
              qualityWarnings: [],
              submissionUrl: "https://directory.example/add-business",
              submissionUrlType: "add_business",
              pricingModel: "free",
            },
          ],
        }),
        row("inactive", PAST, {
          opportunities: [{ leverKey: "reddit", title: "Legacy inactive" }],
        }),
      ],
      [business("active-legacy"), business("active-expired"), business("inactive", false)],
      { now: NOW, limit: 10 },
    );

    expect(candidates.map((candidate) => candidate.businessId)).toEqual([
      "active-legacy",
      "active-expired",
    ]);
    expect(candidates[0]?.reason).toBe("expired_and_legacy_v2_metadata");
    expect(candidates[1]?.reason).toBe("expired");
  });
});
