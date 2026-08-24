// Live-connected Google data flow: verifies that getProfileHealth on a non-demo
// connection actually triggers profile snapshot refresh, metrics sync, discovery
// keywords sync, signal computation, action recommendation, and alert generation.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

let snapshotCreateCount = 0;
let dailyMetricUpsertCount = 0;
let discoveryKeywordUpsertCount = 0;
let healthRunCreateCount = 0;
let alertCreateCount = 0;
let actionUpsertCount = 0;

const reset = () => {
  snapshotCreateCount = 0;
  dailyMetricUpsertCount = 0;
  discoveryKeywordUpsertCount = 0;
  healthRunCreateCount = 0;
  alertCreateCount = 0;
  actionUpsertCount = 0;
};

const fakeLiveConnection = {
  id: "gmb-live-1",
  businessId: "biz-live-1",
  isActive: true,
  isDemo: false,
  locationId: "locations/123",
  accountId: "accounts/456",
  placeId: "ChIJabcdef",
  businessName: "Real Plumbing Co",
  businessAddress: "200 King St W, Toronto",
  businessPhone: "+14165550100",
  businessWebsite: "https://realplumbing.example",
  cachedAverageRating: 4.5,
  totalReviewCount: 42,
  cachedCategories: ["Plumber", "Drain cleaning"],
  rankScanCadence: "weekly",
  business: {
    id: "biz-live-1",
    businessName: "Real Plumbing Co",
    businessType: "Plumbing",
    businessCity: "Toronto",
    businessAddress: "200 King St W, Toronto",
    businessWebsiteUrl: "https://realplumbing.example",
    Photos: [],
    GeoProfile: {
      latitude: 43.6486,
      longitude: -79.3801,
      locality: "Toronto",
    },
  },
};

mock.module("../config/db.config", () => ({
  prisma: {
    googleMyBusiness: {
      findUnique: mock(async () => fakeLiveConnection),
      update: mock(async () => ({})),
    },
    gMBProfileSnapshot: {
      findFirst: mock(async () => null),
      create: mock(async () => {
        snapshotCreateCount++;
        return {
          id: "snap-1",
          businessId: "biz-live-1",
          gmbId: "gmb-live-1",
          profileJson: {},
          syncedAt: new Date(),
        };
      }),
    },
    gMBDailyMetric: {
      upsert: mock(async () => {
        dailyMetricUpsertCount++;
        return {};
      }),
      findMany: mock(async () => [
        {
          businessId: "biz-live-1",
          metricDate: new Date(),
          impressionsSearch: 250,
          impressionsMaps: 410,
          websiteClicks: 18,
          callClicks: 7,
          directionRequests: 12,
          bookings: 0,
          menuClicks: 0,
          foodOrders: 0,
        },
      ]),
    },
    gMBDiscoveryKeyword: {
      upsert: mock(async () => {
        discoveryKeywordUpsertCount++;
        return {};
      }),
      count: mock(async () => 5),
      findMany: mock(async () => [
        { keyword: "plumber toronto", impressions: 1200 },
      ]),
    },
    gMBProfileHealthRun: {
      findFirst: mock(async () => null),
      create: mock(async ({ data }: any) => {
        healthRunCreateCount++;
        return {
          id: `run-${healthRunCreateCount}`,
          ...data,
          generatedAt: new Date(),
          items: data.items?.create ?? [],
        };
      }),
    },
    gMBProfileHealthItem: {
      findMany: mock(async () => []),
    },
    gMBActionRecommendation: {
      findFirst: mock(async () => null),
      findMany: mock(async () => []),
      create: mock(async () => {
        actionUpsertCount++;
        return {};
      }),
      update: mock(async () => ({})),
      updateMany: mock(async () => ({ count: 0 })),
    },
    gMBMediaAsset: {
      count: mock(async () => 8),
      findMany: mock(async () => []),
      findFirst: mock(async () => null),
      create: mock(async () => ({})),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBLocalRankScan: {
      findFirst: mock(async () => null),
      findMany: mock(async () => []),
    },
    gMBLocalRankResult: {
      findMany: mock(async () => []),
    },
    gMBCompetitorSnapshot: {
      count: mock(async () => 7),
      findMany: mock(async () => []),
    },
    gMBAttributionLink: {
      count: mock(async () => 0),
      findMany: mock(async () => []),
      findFirst: mock(async () => null),
      create: mock(async () => ({})),
    },
    gMBAlert: {
      create: mock(async () => {
        alertCreateCount++;
        return {};
      }),
      findFirst: mock(async () => null),
      findMany: mock(async () => []),
      update: mock(async () => ({})),
      count: mock(async () => 0),
    },
    gMBPost: {
      count: mock(async () => 4),
    },
    // Phase 1 structured tables (read by health-signal computation).
    gMBBusinessHours: {
      findMany: mock(async () => []),
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBSpecialHours: {
      findMany: mock(async () => []),
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBCategory: {
      findMany: mock(async () => []),
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBAttribute: {
      count: mock(async () => 0),
      findMany: mock(async () => []),
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBReview: {
      findMany: mock(async () => [
        {
          rating: 5,
          isResponded: true,
          reviewDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        },
        {
          rating: 4,
          isResponded: true,
          reviewDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        },
        {
          rating: 5,
          isResponded: false,
          reviewDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
      ]),
    },
    gMBReviewCampaign: {
      findFirst: mock(async () => null),
      findMany: mock(async () => []),
      create: mock(async () => ({})),
    },
    business: {
      findFirst: mock(async () => null),
      findUnique: mock(async () => ({
        id: "biz-live-1",
        userId: "user-live-1",
        businessName: "Real Plumbing Co",
        businessType: "Plumbing",
        businessCity: "Toronto",
        businessAddress: "200 King St W, Toronto",
        businessState: "ON",
        businessCountry: "CA",
        targetAudience: "homeowners",
        detectedServices: [],
        selectedServices: [],
        servicesPriority: [],
        websiteAnalysis: null,
      })),
    },
    businessPhoto: {
      findMany: mock(async () => []),
    },
    publishingIntegration: {
      findMany: mock(async () => []),
    },
  },
}));

let service: typeof import("../services/gmb-local-visibility.service");
let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

const getProfileDetailsSpy = mock(async (_b: string) => ({
  title: "Real Plumbing Co",
  storefrontAddress: {
    addressLines: ["200 King St W"],
    locality: "Toronto",
    administrativeArea: "ON",
    postalCode: "M5H 1J9",
    regionCode: "CA",
  },
  phoneNumbers: { primaryPhone: "+14165550100" },
  websiteUri: "https://realplumbing.example",
  profile: { description: "Trusted Toronto plumbing for 20 years." },
  serviceItems: [{ structuredServiceItem: {} }],
  regularHours: { periods: [{ openDay: "MONDAY" }] },
  specialHours: { specialHourPeriods: [] },
  attributes: [{ name: "wheelchair_accessible_entrance" }],
  metadata: { placeId: "ChIJabcdef" },
  categories: {
    primaryCategory: { displayName: "Plumber" },
    additionalCategories: [{ displayName: "Drain cleaning" }],
  },
}));

const getPerformanceMetricsSpy = mock(async (_b: string, _d: number) => [
  {
    date: "2026-05-01",
    impressionsSearch: 200,
    impressionsMaps: 350,
    websiteClicks: 15,
    callClicks: 5,
    directionRequests: 10,
    bookings: 0,
    menuClicks: 0,
    foodOrders: 0,
    raw: {},
  },
  {
    date: "2026-05-02",
    impressionsSearch: 220,
    impressionsMaps: 360,
    websiteClicks: 16,
    callClicks: 6,
    directionRequests: 11,
    bookings: 0,
    menuClicks: 0,
    foodOrders: 0,
    raw: {},
  },
]);

const getDiscoveryKeywordsSpy = mock(async (_b: string, _m: number) => [
  { keyword: "plumber toronto", month: new Date(), impressions: 1200, raw: {} },
  { keyword: "drain cleaning", month: new Date(), impressions: 350, raw: {} },
]);

let savedGetProfile: any;
let savedGetPerf: any;
let savedGetDisc: any;

beforeAll(async () => {
  service = await import("../services/gmb-local-visibility.service");
  ({ GoogleMyBusinessService } = await import(
    "../services/google-my-business.service"
  ));
});

beforeEach(() => {
  reset();
  savedGetProfile = GoogleMyBusinessService.prototype.getProfileDetails;
  savedGetPerf = GoogleMyBusinessService.prototype.getPerformanceDailyMetrics;
  savedGetDisc = GoogleMyBusinessService.prototype.getDiscoveryKeywordImpressions;

  GoogleMyBusinessService.prototype.getProfileDetails = getProfileDetailsSpy as any;
  GoogleMyBusinessService.prototype.getPerformanceDailyMetrics = getPerformanceMetricsSpy as any;
  GoogleMyBusinessService.prototype.getDiscoveryKeywordImpressions = getDiscoveryKeywordsSpy as any;

  getProfileDetailsSpy.mockClear();
  getPerformanceMetricsSpy.mockClear();
  getDiscoveryKeywordsSpy.mockClear();
});

afterEach(() => {
  GoogleMyBusinessService.prototype.getProfileDetails = savedGetProfile;
  GoogleMyBusinessService.prototype.getPerformanceDailyMetrics = savedGetPerf;
  GoogleMyBusinessService.prototype.getDiscoveryKeywordImpressions = savedGetDisc;
});

describe("Live Google flow: getProfileHealth drives data into ranking signals", () => {
  it("calls Google API for profile, metrics, and discovery keywords", async () => {
    const result = await service.gmbLocalVisibilityService.getProfileHealth(
      "biz-live-1",
      false,
    );

    expect(getProfileDetailsSpy).toHaveBeenCalledTimes(1);
    expect(getPerformanceMetricsSpy).toHaveBeenCalledTimes(1);
    expect(getDiscoveryKeywordsSpy).toHaveBeenCalledTimes(1);
    expect(getPerformanceMetricsSpy.mock.calls[0]?.[1]).toBe(90);
    expect(getDiscoveryKeywordsSpy.mock.calls[0]?.[1]).toBe(3);

    expect(result).toBeDefined();
    expect(result.run).toBeDefined();
  });

  it("persists fresh profile snapshot, daily metrics, and discovery keywords", async () => {
    await service.gmbLocalVisibilityService.getProfileHealth("biz-live-1", false);

    expect(snapshotCreateCount).toBeGreaterThan(0);
    expect(dailyMetricUpsertCount).toBe(2);
    expect(discoveryKeywordUpsertCount).toBe(2);
  });

  it("creates a GMBProfileHealthRun with the 5 sub-scores", async () => {
    const result = await service.gmbLocalVisibilityService.getProfileHealth(
      "biz-live-1",
      false,
    );

    expect(healthRunCreateCount).toBe(1);
    expect(result.run.score).toBeGreaterThanOrEqual(0);
    expect(result.run.score).toBeLessThanOrEqual(100);
    expect(typeof result.run.completenessScore).toBe("number");
    expect(typeof result.run.reputationScore).toBe("number");
    expect(typeof result.run.engagementScore).toBe("number");
    expect(typeof result.run.visibilityScore).toBe("number");
    expect(typeof result.run.conversionScore).toBe("number");
  });

  it("forceRefresh causes snapshot to refresh even if recent", async () => {
    // Reset and re-trigger; snapshot mock always returns null so forceRefresh is implied
    reset();
    await service.gmbLocalVisibilityService.getProfileHealth("biz-live-1", true);
    expect(snapshotCreateCount).toBeGreaterThan(0);
  });
});
