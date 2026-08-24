import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { decrypt, isEncrypted } from "../utils/encryption";

type FetchFixture =
  | { status?: number; body: unknown }
  | ((
      url: string,
      init?: RequestInit,
    ) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>);

const businessFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const analyticsFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const analyticsUpsertMock = mock(async (_args: unknown): Promise<any> => ({}));
const analyticsUpdateMock = mock(async (_args: unknown): Promise<any> => ({}));
const metricUpsertMock = mock(async (_args: unknown): Promise<any> => ({}));
const metricFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);

mock.module("../config/db.config", () => ({
  prisma: {
    business: { findUnique: businessFindUniqueMock },
    businessAnalyticsConfig: {
      findUnique: analyticsFindUniqueMock,
      upsert: analyticsUpsertMock,
      update: analyticsUpdateMock,
    },
    searchConsoleMetric: {
      upsert: metricUpsertMock,
      findMany: metricFindManyMock,
    },
  },
}));

let service: typeof import("../services/search-console.service");
const originalFetch = globalThis.fetch;
const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};
let fetchFixtures: FetchFixture[] = [];

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const fixture = fetchFixtures.shift();
  if (!fixture) {
    throw new Error(`Unexpected fetch call: ${String(input)}`);
  }

  const url = String(input);
  const result =
    typeof fixture === "function" ? await fixture(url, init) : fixture;

  return new Response(JSON.stringify(result.body), {
    status: result.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeAll(async () => {
  service = await import("../services/search-console.service");
});

beforeEach(() => {
  businessFindUniqueMock.mockReset();
  analyticsFindUniqueMock.mockReset();
  analyticsUpsertMock.mockReset();
  analyticsUpdateMock.mockReset();
  metricUpsertMock.mockReset();
  metricFindManyMock.mockReset();
  fetchMock.mockClear();
  fetchFixtures = [];

  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GOOGLE_CLIENT_ID = originalEnv.GOOGLE_CLIENT_ID;
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID =
    originalEnv.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = originalEnv.GOOGLE_CLIENT_SECRET;
  process.env.ENCRYPTION_KEY = originalEnv.ENCRYPTION_KEY;
});

describe("search console service", () => {
  it("exchanges OAuth code, encrypts tokens, and selects the matching verified site", async () => {
    businessFindUniqueMock.mockImplementation(async () => ({
      id: "biz-1",
      businessWebsiteUrl: "https://www.example.com/services",
    }));
    analyticsFindUniqueMock.mockImplementation(async () => null);
    fetchFixtures = [
      {
        body: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      },
      {
        body: {
          siteEntry: [
            {
              siteUrl: "https://unverified.example.com/",
              permissionLevel: "siteUnverifiedUser",
            },
            {
              siteUrl: "sc-domain:example.com",
              permissionLevel: "siteOwner",
            },
          ],
        },
      },
    ];

    const result = await service.connectSearchConsole("biz-1", {
      code: "oauth-code",
      redirectUri: "https://upliftai.co/api/auth/search-console/callback",
    });

    expect(result.connected).toBe(true);
    expect(result.siteUrl).toBe("sc-domain:example.com");
    expect(result.requiresSiteSelection).toBe(false);
    expect(result.sites).toEqual([
      {
        siteUrl: "https://unverified.example.com/",
        permissionLevel: "siteUnverifiedUser",
        verified: false,
      },
      {
        siteUrl: "sc-domain:example.com",
        permissionLevel: "siteOwner",
        verified: true,
      },
    ]);

    const upsertArgs: any = analyticsUpsertMock.mock.calls[0]![0];
    expect(upsertArgs.create.gscSiteUrl).toBe("sc-domain:example.com");
    expect(isEncrypted(upsertArgs.create.gscAccessToken)).toBe(true);
    expect(isEncrypted(upsertArgs.create.gscRefreshToken)).toBe(true);
    expect(decrypt(upsertArgs.create.gscAccessToken, "gsc-tokens")).toBe(
      "access-token",
    );
    expect(decrypt(upsertArgs.create.gscRefreshToken, "gsc-tokens")).toBe(
      "refresh-token",
    );
  });

  it("rejects site selection when the authenticated account cannot access the property", async () => {
    analyticsFindUniqueMock.mockImplementation(async () => ({
      gscAccessToken: "access-token",
      gscRefreshToken: null,
    }));
    fetchFixtures = [
      {
        body: {
          siteEntry: [
            {
              siteUrl: "https://owned.example.com/",
              permissionLevel: "siteOwner",
            },
          ],
        },
      },
    ];

    await expect(
      service.selectSearchConsoleSite("biz-1", "https://other.example.com/"),
    ).rejects.toThrow(
      "Selected Search Console property is not available for this Google account",
    );
    expect(analyticsUpdateMock).not.toHaveBeenCalled();
  });

  it("paginates Search Analytics rows and upserts by the unique metric key", async () => {
    analyticsFindUniqueMock.mockImplementation(async () => ({
      gscSiteUrl: "sc-domain:example.com",
      gscAccessToken: "access-token",
      gscRefreshToken: null,
    }));
    const capturedStartRows: number[] = [];
    const firstPageRows = Array.from({ length: 25_000 }, (_value, index) => ({
      keys: [
        "2026-06-10",
        `query ${index}`,
        "https://example.com/page",
        "DESKTOP",
        "usa",
      ],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
      position: 9,
    }));
    fetchFixtures = [
      (_url, init) => {
        capturedStartRows.push(JSON.parse(String(init?.body)).startRow);
        return { body: { rows: firstPageRows } };
      },
      (_url, init) => {
        capturedStartRows.push(JSON.parse(String(init?.body)).startRow);
        return {
          body: {
            rows: [
              {
                keys: [
                  "2026-06-11",
                  "final query",
                  "https://example.com/final",
                  "MOBILE",
                  "can",
                ],
                clicks: 2,
                impressions: 20,
                ctr: 0.1,
                position: 8,
              },
            ],
          },
        };
      },
    ];

    const result = await service.syncSearchConsoleMetrics("biz-1", {
      startDate: "2026-06-10",
      endDate: "2026-06-11",
    });

    expect(result).toEqual({
      success: true,
      rowsWritten: 25_001,
      startDate: "2026-06-10",
      endDate: "2026-06-11",
    });
    expect(capturedStartRows).toEqual([0, 25_000]);
    expect(metricUpsertMock).toHaveBeenCalledTimes(25_001);
    expect(analyticsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: "biz-1" },
        data: expect.objectContaining({ gscLastSyncError: null }),
      }),
    );

    const firstUpsert: any = metricUpsertMock.mock.calls[0]![0];
    expect(firstUpsert.where.businessId_date_query_page_device_country).toEqual(
      {
        businessId: "biz-1",
        date: new Date(Date.UTC(2026, 5, 10)),
        query: "query 0",
        page: "https://example.com/page",
        device: "DESKTOP",
        country: "usa",
      },
    );
  });
});
