import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { SourceAvailabilityError } from "../utils/source-availability.errors";

const discoverFromRedditMock = mock(async (): Promise<any[]> => []);
const discoverFromMediumMock = mock(async (): Promise<any[]> => []);
const fetchDomainRankMock = mock(async () => null);
const analyzePublisherWithAIMock = mock(async () => ({
  confidenceScore: 0.82,
  guidelines: "Pitch a practical article with examples.",
  siteName: "Example Medium Publication",
  contactEmail: "editor@example.com",
  contactName: "Editor",
}));

mock.module("../config/db.config", () => ({
  prisma: {},
}));

mock.module("../utils/reddit-scraper.utils", () => ({
  discoverFromReddit: discoverFromRedditMock,
}));

mock.module("../utils/medium-scraper.utils", () => ({
  discoverFromMedium: discoverFromMediumMock,
}));

mock.module("../utils/dataforseo-backlinks.utils", () => ({
  fetchDomainRankFromDataForSEO: fetchDomainRankMock,
}));

mock.module("../utils/ai-publisher-analysis.utils", () => ({
  analyzePublisherWithAI: analyzePublisherWithAIMock,
}));

describe("PublisherDiscoveryService multi-source discovery", () => {
  let PublisherDiscoveryService: typeof import("../services/publisher-discovery.service").PublisherDiscoveryService;

  beforeAll(async () => {
    ({ PublisherDiscoveryService } = await import(
      "../services/publisher-discovery.service"
    ));
  });

  beforeEach(() => {
    discoverFromRedditMock.mockReset();
    discoverFromMediumMock.mockReset();
    fetchDomainRankMock.mockReset();
    analyzePublisherWithAIMock.mockReset();

    fetchDomainRankMock.mockImplementation(async () => null);
    analyzePublisherWithAIMock.mockImplementation(async () => ({
      confidenceScore: 0.82,
      guidelines: "Pitch a practical article with examples.",
      siteName: "Example Medium Publication",
      contactEmail: "editor@example.com",
      contactName: "Editor",
    }));
  });

  it("returns partial results and warnings when Reddit is unavailable", async () => {
    discoverFromRedditMock.mockImplementation(async () => {
      throw new SourceAvailabilityError({
        source: "reddit",
        code: "REDDIT_FORBIDDEN",
        message: "Reddit blocked the request",
        userMessage:
          "Reddit blocked guest-post discovery requests right now, so results from Reddit are temporarily unavailable.",
        retryable: true,
        statusCode: 403,
      });
    });

    discoverFromMediumMock.mockImplementation(async () => [
      {
        websiteUrl: "https://example.com/write-for-us",
        name: "Example",
        domain: "example.com",
        source: "MEDIUM",
      },
    ]);

    const service = new PublisherDiscoveryService();
    const result = await service.discoverPublishers(
      ["reddit", "medium"],
      ["guest post"],
      "marketing",
      undefined,
      10
    );

    expect(result.publishers).toHaveLength(1);
    expect(result.publishers[0]).toMatchObject({
      websiteUrl: "https://example.com/write-for-us",
      domain: "example.com",
      source: "MEDIUM",
    });
    expect(result.warnings).toContain(
      "Reddit blocked guest-post discovery requests right now, so results from Reddit are temporarily unavailable."
    );
    expect(result.sourceStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "reddit",
          status: "unavailable",
        }),
        expect.objectContaining({
          source: "medium",
          status: "success",
          discoveredCount: 1,
        }),
      ])
    );
  });
});
