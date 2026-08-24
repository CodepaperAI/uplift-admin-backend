import { describe, expect, it } from "bun:test";
import {
  applyDirectoryOpportunityQuality,
  applyRedditOpportunityQuality,
  confidenceLevel,
  getDirectorySubmissionTarget,
  rankRedditThreads,
  shouldShowOpportunity,
} from "../services/offpage/offpage-quality.service";
import { titleIsForeignMarket } from "../services/offpage/offpage-enrich.service";
import type {
  BusinessResearchBrief,
  Opportunity,
} from "../services/offpage/offpage-types";

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    leverKey: "directory",
    key: "directory-google",
    title: "List Example on Google Business Profile",
    url: "https://www.google.com/business/",
    action: "Create a listing.",
    priority: 90,
    rationale: "Core citation.",
    source: "researched",
    status: "todo",
    businessTypeFit: "local",
    ...overrides,
  };
}

function brief(overrides: Partial<BusinessResearchBrief> = {}): BusinessResearchBrief {
  return {
    businessId: "b1",
    businessName: "Example Plumbing",
    category: "Plumbing Services",
    description: null,
    websiteUrl: null,
    targetAudience: null,
    services: ["Emergency plumbing"],
    competitors: [],
    keywords: ["plumber toronto"],
    location: {
      city: "Toronto",
      serviceArea: "local",
      serviceAreaLocations: [],
      country: "Canada",
      formattedAddress: null,
      neighborhoods: [],
    },
    scope: "local",
    businessModelType: "service",
    tagline: null,
    summary: null,
    differentiators: [],
    painPoints: [],
    businessGoals: [],
    industryPositioning: null,
    recognition: [],
    competitorTopics: [],
    contentTopics: [],
    ...overrides,
  };
}

describe("confidenceLevel", () => {
  it("buckets quality scores into stable UI labels", () => {
    expect(confidenceLevel(90)).toBe("high");
    expect(confidenceLevel(70)).toBe("medium");
    expect(confidenceLevel(55)).toBe("needs_review");
    expect(confidenceLevel(30)).toBe("low");
  });
});

describe("rankRedditThreads", () => {
  it("prefers buyer-intent, active, fresh threads and drops locked threads", () => {
    const threads = rankRedditThreads([
      {
        url: "https://www.reddit.com/r/toronto/comments/a/old_generic",
        title: "Random thoughts about shawarma",
        ageDays: 1800,
        commentCount: 0,
      },
      {
        url: "https://www.reddit.com/r/toronto/comments/b/best_shawarma",
        title: "Best shawarma near downtown?",
        ageDays: 12,
        commentCount: 18,
      },
      {
        url: "https://www.reddit.com/r/toronto/comments/c/locked",
        title: "Need shawarma recommendations",
        ageDays: 4,
        commentCount: 30,
        locked: true,
      },
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toContain("Best shawarma");
    expect(threads[0]?.buyerIntent).toBe(true);
    expect((threads[0]?.qualityScore ?? 0) >= 80).toBe(true);
  });

  it("filters possible foreign-language Reddit threads before they reach users", () => {
    const threads = rankRedditThreads([
      {
        url: "https://www.reddit.com/r/toronto/comments/x/mejor_plomero",
        title: "Donde encuentro el mejor plomero para emergencia?",
        ageDays: 3,
        commentCount: 19,
      },
      {
        url: "https://www.reddit.com/r/toronto/comments/y/best_plumber",
        title: "Best emergency plumber near downtown?",
        ageDays: 3,
        commentCount: 19,
      },
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toContain("Best emergency plumber");
  });

  it("drops deleted or unavailable Reddit threads after detail checks", () => {
    const threads = rankRedditThreads([
      {
        url: "https://www.reddit.com/r/toronto/comments/a/deleted",
        title: "Best emergency plumber near downtown?",
        ageDays: 3,
        commentCount: 19,
        deleted: true,
        detailCheckedAt: "2026-06-30T00:00:00.000Z",
      },
      {
        url: "https://www.reddit.com/r/toronto/comments/b/unavailable",
        title: "Need emergency plumber recommendations",
        ageDays: 3,
        commentCount: 19,
        unavailable: true,
        detailCheckedAt: "2026-06-30T00:00:00.000Z",
      },
      {
        url: "https://www.reddit.com/r/toronto/comments/c/live",
        title: "Need emergency plumber recommendations",
        ageDays: 3,
        commentCount: 19,
        detailCheckedAt: "2026-06-30T00:00:00.000Z",
      },
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.url).toContain("/live");
    expect(threads[0]?.qualitySignals).toContain("Thread page checked");
  });

  it("detects Reddit titles from a different market", () => {
    const brief = {
      location: {
        city: "Toronto",
        country: "Canada",
        serviceAreaLocations: ["Mississauga"],
        neighborhoods: [],
      },
    };

    expect(titleIsForeignMarket("Best driving school in Finland?", brief)).toBe(true);
    expect(titleIsForeignMarket("Best driving school in Toronto?", brief)).toBe(false);
  });
});

describe("directory quality", () => {
  it("maps known directory hosts to direct add or claim URLs", () => {
    const target = getDirectorySubmissionTarget("https://www.google.com/business/");
    expect(target.submissionUrl).toBe("https://www.google.com/business/");
    expect(target.submissionUrlType).toBe("direct_claim");
    expect(target.pricingModel).toBe("free");
  });

  it("adds confidence metadata and keeps direct listing targets visible", () => {
    const result = applyDirectoryOpportunityQuality(opportunity());
    expect(result.confidenceLevel).toBe("high");
    expect(result.sourceType).toBe("business_profile");
    expect(result.evidenceSources).toContain("ai_research");
    expect(result.evidenceSources).toContain("directory_reachability");
    expect(result.evidenceSources).toContain("known_submission_map");
    expect(result.submissionUrlType).toBe("direct_claim");
    expect(result.whyRecommended).toContain("direct claim page");
    expect(shouldShowOpportunity(result)).toBe(true);
  });

  it("keeps already-listed profile URLs while storing the direct submission path", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "Review existing Yelp listing",
        url: "https://www.yelp.com/biz/example-toronto",
        alreadyListed: true,
        validatorScore: 0.9,
      }),
    );

    expect(result.url).toBe("https://www.yelp.com/biz/example-toronto");
    expect(result.submissionUrl).toBe("https://biz.yelp.com/");
    expect(result.sourceType).toBe("review_platform");
    expect(result.evidenceSources).toContain("already_listed_search");
    expect(result.qualitySignals).toContain("Existing listing detected");
    expect(result.whyRecommended).toContain("existing listing");
    expect(shouldShowOpportunity(result)).toBe(true);
  });

  it("uses dynamically discovered directory submission URLs for confidence scoring", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "List Example on Regional Directory",
        url: "https://directory.example/",
        submissionUrl: "https://directory.example/claim-business",
        submissionUrlType: "direct_claim",
        pricingModel: "free",
        priority: 70,
      }),
    );

    expect(result.url).toBe("https://directory.example/claim-business");
    expect(result.originalUrl).toBe("https://directory.example/");
    expect(result.submissionUrlType).toBe("direct_claim");
    expect(result.evidenceSources).toContain("directory_page_scan");
    expect(result.qualitySignals).toContain("Direct claim page discovered");
    expect(result.whyRecommended).toContain("direct claim page");
    expect(result.confidenceLevel).toBe("high");
  });

  it("adds category and location fit signals to directory confidence scoring", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "List Example Plumbing on Google Business Profile",
        priority: 70,
      }),
      brief(),
    );

    expect(result.qualitySignals).toContain("Matched to Toronto, Canada");
    expect(result.qualitySignals?.some((signal) => signal.includes("Category fit"))).toBe(true);
    expect(result.confidenceLevel).toBe("high");
  });

  it("hides low-confidence directory opportunities by default", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "List Example on Unknown Directory",
        url: "",
        priority: 10,
        source: "baseline",
        validatorScore: 0.2,
      }),
    );
    expect(result.confidenceLevel).toBe("low");
    expect(shouldShowOpportunity(result)).toBe(false);
  });

  it("hides directory homepages even when other signals make them medium confidence", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "List Example Plumbing on Toronto Directory",
        url: "https://directory.example/",
        priority: 95,
        validatorScore: 0.9,
      }),
      brief(),
    );

    expect(result.submissionUrlType).toBe("homepage");
    expect(result.confidenceLevel).toBe("medium");
    expect(shouldShowOpportunity(result)).toBe(false);
  });

  it("hides directories with malformed direct submission URLs", () => {
    const result = applyDirectoryOpportunityQuality(
      opportunity({
        title: "List Example on Regional Directory",
        url: "https://directory.example/",
        submissionUrl: "mailto:submit@directory.example",
        submissionUrlType: "add_business",
        pricingModel: "free",
        validatorScore: 0.9,
      }),
    );

    expect(result.submissionUrlType).toBe("add_business");
    expect(result.confidenceLevel).toBe("high");
    expect(shouldShowOpportunity(result)).toBe(false);
  });
});

describe("reddit opportunity quality", () => {
  it("adds confidence, source type and checked timestamp to Reddit opportunities", () => {
    const result = applyRedditOpportunityQuality(
      opportunity({
        leverKey: "reddit",
        key: "reddit-toronto",
        title: "Reply in r/toronto",
        url: "https://www.reddit.com/r/toronto/comments/b/best_shawarma",
        threads: [
          {
            url: "https://www.reddit.com/r/toronto/comments/b/best_shawarma",
            title: "Best shawarma near downtown?",
            ageDays: 8,
            commentCount: 22,
            draft: "Helpful reply.",
          },
        ],
        draft: "Helpful reply.",
        validatorScore: 0.9,
      }),
    );

    expect(result.sourceType).toBe("reddit_thread");
    expect(result.confidenceLevel).toBe("high");
    expect(result.lastCheckedAt).toBeTruthy();
    expect(result.evidenceSources).toContain("ai_research");
    expect(result.evidenceSources).toContain("live_search");
    expect(result.evidenceSources).toContain("strict_reviewer");
    expect(result.whyRecommended).toContain("buyer intent");
    expect(result.threads?.[0]?.buyerIntent).toBe(true);
  });
});
