import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const gmbFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const lastScanFindFirstMock = mock(async (_args: unknown): Promise<any> => null);
const discoveryFindManyMock = mock(async () => []);
const scanCreateMock = mock(async ({ data }: any) => ({ id: `scan-${Date.now()}`, ...data, requestedAt: new Date() }));
const scanUpdateMock = mock(async ({ data }: any) => ({ id: "scan", ...data }));
const resultCreateManyMock = mock(async () => ({ count: 0 }));
const competitorUpsertMock = mock(async () => ({}));

mock.module("../config/db.config", () => ({
  prisma: {
    googleMyBusiness: {
      findUnique: gmbFindUniqueMock,
    },
    gMBLocalRankScan: {
      findFirst: lastScanFindFirstMock,
      create: scanCreateMock,
      update: scanUpdateMock,
      findMany: mock(async () => []),
    },
    gMBLocalRankResult: {
      createMany: resultCreateManyMock,
      create: mock(async () => ({})),
    },
    gMBCompetitorSnapshot: {
      upsert: competitorUpsertMock,
      findFirst: mock(async () => null),
      create: mock(async () => ({})),
      update: mock(async () => ({})),
    },
    gMBDiscoveryKeyword: {
      findMany: discoveryFindManyMock,
    },
    gMBAlert: {
      findFirst: mock(async () => null),
      create: mock(async () => ({})),
      update: mock(async () => ({})),
    },
    business: {
      findFirst: mock(async () => null),
    },
  },
}));

mock.module("../utils/dataforseo.utils", () => ({
  getLocalMapsResultsFromDataForSEO: mock(async () => ({ results: [], rawJson: null })),
  getLocalPackResultsFromDataForSEO: mock(async () => ({ results: [], rawJson: null })),
}));

mock.module("./gmb-demo-data.service", () => ({
  isDemoGmbConnection: () => false,
}));

const realConnection = {
  id: "gmb-1",
  businessId: "biz-1",
  isActive: true,
  isDemo: false,
  locationId: "loc/1",
  rankScanCadence: "weekly",
  placeId: "place-1",
  businessName: "Test",
  businessWebsite: "https://test.example",
  cachedAverageRating: 4.5,
  totalReviewCount: 10,
  business: {
    id: "biz-1",
    businessName: "Test",
    businessType: "Plumbing",
    businessCity: "Toronto",
    businessAddress: "123 Main",
    businessWebsiteUrl: "https://test.example",
    GeoProfile: {
      latitude: 43.6532,
      longitude: -79.3832,
      locality: "Toronto",
    },
  },
};

let service: typeof import("../services/gmb-local-visibility.service");

beforeAll(async () => {
  service = await import("../services/gmb-local-visibility.service");
});

beforeEach(() => {
  gmbFindUniqueMock.mockReset();
  lastScanFindFirstMock.mockReset();
  discoveryFindManyMock.mockReset();
  scanCreateMock.mockClear();
  scanUpdateMock.mockClear();
  resultCreateManyMock.mockClear();
  competitorUpsertMock.mockClear();
});

describe("GMB rank scan cadence enforcement", () => {
  it("rejects scan when within weekly cadence window", async () => {
    gmbFindUniqueMock.mockImplementationOnce(async () => realConnection);
    lastScanFindFirstMock.mockImplementationOnce(async () => ({
      requestedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    }));

    await expect(
      service.gmbLocalVisibilityService.runRankScan("biz-1"),
    ).rejects.toMatchObject({
      name: "GMBRankScanThrottledError",
      reason: "cadence",
    });

    expect(scanCreateMock).not.toHaveBeenCalled();
  });

  it("allows scan when cadence window has elapsed", async () => {
    gmbFindUniqueMock.mockImplementationOnce(async () => realConnection);
    lastScanFindFirstMock.mockImplementationOnce(async () => ({
      requestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
    }));
    discoveryFindManyMock.mockImplementationOnce(async () => []);

    const result = await service.gmbLocalVisibilityService.runRankScan(
      "biz-1",
      { keywords: ["plumbing toronto"] },
    );

    expect(result).toBeDefined();
    expect(scanCreateMock).toHaveBeenCalled();
  });

  it("allows first-ever scan with no prior history", async () => {
    gmbFindUniqueMock.mockImplementationOnce(async () => realConnection);
    lastScanFindFirstMock.mockImplementationOnce(async () => null);
    discoveryFindManyMock.mockImplementationOnce(async () => []);

    const result = await service.gmbLocalVisibilityService.runRankScan(
      "biz-1",
      { keywords: ["plumbing"] },
    );

    expect(result).toBeDefined();
    expect(scanCreateMock).toHaveBeenCalled();
  });

  it("allows scan immediately when cadence is manual", async () => {
    gmbFindUniqueMock.mockImplementationOnce(async () => ({
      ...realConnection,
      rankScanCadence: "manual",
    }));
    discoveryFindManyMock.mockImplementationOnce(async () => []);
    // last scan check is skipped when cadence is manual

    const result = await service.gmbLocalVisibilityService.runRankScan(
      "biz-1",
      { keywords: ["plumbing"] },
    );

    expect(result).toBeDefined();
  });
});
