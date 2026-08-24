import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { SourceAvailabilityError } from "../utils/source-availability.errors";

const summaryUpsertMock = mock(async () => ({}));
const summaryUpdateMock = mock(async () => ({}));
const fetchSummaryMock = mock(async () => null);

mock.module("../config/db.config", () => ({
  prisma: {
    externalBacklinkSummary: {
      upsert: summaryUpsertMock,
      update: summaryUpdateMock,
    },
  },
}));

mock.module("../utils/dataforseo-backlinks.utils", () => ({
  fetchBacklinksFromDataForSEO: mock(async () => []),
  fetchBacklinkSummaryFromDataForSEO: fetchSummaryMock,
  fetchReferringDomainsFromDataForSEO: mock(async () => []),
  fetchAnchorTextFromDataForSEO: mock(async () => []),
  fetchDomainRankFromDataForSEO: mock(async () => null),
}));

describe("ExternalBacklinksService source availability handling", () => {
  let ExternalBacklinksService: typeof import("../services/external-backlinks.service").ExternalBacklinksService;

  beforeAll(async () => {
    ({ ExternalBacklinksService } = await import(
      "../services/external-backlinks.service"
    ));
  });

  beforeEach(() => {
    summaryUpsertMock.mockClear();
    summaryUpdateMock.mockClear();
    fetchSummaryMock.mockReset();
  });

  it("marks the sync as unavailable when DataForSEO backlinks access is disabled", async () => {
    fetchSummaryMock.mockImplementation(async () => {
      throw new SourceAvailabilityError({
        source: "dataforseo-backlinks",
        code: "DATAFORSEO_BACKLINKS_UNAVAILABLE",
        message: "Access denied for backlinks subscription",
        userMessage:
          "DataForSEO backlinks access is not active for this workspace right now. Enable the Backlinks subscription in DataForSEO to resume syncing.",
        retryable: false,
        statusCode: 20000,
      });
    });

    const service = new ExternalBacklinksService();
    const result = await service.syncBacklinksForBusiness(
      "business-1",
      "https://example.com"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Backlinks subscription");
    expect(summaryUpsertMock).toHaveBeenCalledTimes(1);
    expect(summaryUpdateMock).toHaveBeenCalledTimes(1);
    const firstSummaryUpdateCall = summaryUpdateMock.mock.calls[0] as
      | [Record<string, unknown>]
      | undefined;
    expect(firstSummaryUpdateCall?.[0]).toMatchObject({
      where: { businessId: "business-1" },
      data: {
        syncStatus: "unavailable",
        syncError: expect.stringContaining("Backlinks subscription"),
      },
    });
  });
});
