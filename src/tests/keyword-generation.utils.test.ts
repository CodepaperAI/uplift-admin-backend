import { describe, expect, it } from "bun:test";
import type { KeywordCandidate } from "../utils/dataforseo-keyword-plan.utils";
import {
  KEYWORD_CANDIDATE_GROUP_LIMIT,
  KEYWORD_CANDIDATE_POOL_LIMIT,
  capKeywordCandidates,
  getPersistedKeywordPlanItems,
  mapWithConcurrency,
} from "../utils/keyword-generation.utils";

function createCandidate(service: string, index: number): KeywordCandidate {
  return {
    keyword: `${service} keyword ${index}`,
    searchVolume: 1000 - index,
    difficulty: 20 + (index % 50),
    cpc: 1.5,
    competition: 0.4,
    trend: [],
    monthlySearches: 1000 - index,
    clicks: null,
    impressions: null,
    ctr: null,
    score: 1000 - index,
    trendGrowth: 1,
    relevanceScore: 0.9,
    trafficPotential: 0.9,
    sourceType: "service_seed",
    allSources: ["service_seed"],
    sourceLabel: service,
    originSeeds: [service],
    matchedService: service,
    refinementRound: 0,
  };
}

describe("capKeywordCandidates", () => {
  it("caps the candidate pool to 420 while preserving baseline diversity", () => {
    const services = [
      "Camera Systems",
      "Electrical Services",
      "NVR Systems",
      "Security Monitoring",
      "Access Control",
    ];

    const candidates = services.flatMap((service) =>
      Array.from({ length: 100 }, (_, index) =>
        createCandidate(service, index),
      ),
    );

    const capped = capKeywordCandidates({
      candidates,
      businessAreas: [],
      primaryServices: services,
    });

    expect(capped).toHaveLength(KEYWORD_CANDIDATE_POOL_LIMIT);

    const counts = new Map<string, number>();
    for (const candidate of capped) {
      const key = candidate.matchedService ?? "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const service of services) {
      expect(counts.get(service)).toBeGreaterThanOrEqual(
        KEYWORD_CANDIDATE_GROUP_LIMIT,
      );
    }
  });
});

describe("getPersistedKeywordPlanItems", () => {
  it("removes skipped items from the persisted allocation set", () => {
    const items = [
      { keyword: "camera installation guide", publishDate: "2099-01-01" },
      { keyword: "security monitoring tips", publishDate: "2099-01-02" },
      { keyword: "nvr setup checklist", publishDate: "2099-01-03" },
    ];

    const persisted = getPersistedKeywordPlanItems(items, [
      {
        keyword: "security monitoring tips",
        date: "2099-01-02",
        reason: "Date already exists",
      },
    ]);

    expect(persisted).toEqual([
      { keyword: "camera installation guide", publishDate: "2099-01-01" },
      { keyword: "nvr setup checklist", publishDate: "2099-01-03" },
    ]);
  });
});

describe("mapWithConcurrency", () => {
  it("bounds parallel work and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
  });
});
