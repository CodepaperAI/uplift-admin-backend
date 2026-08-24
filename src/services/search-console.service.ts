import { prisma } from "../config/db.config";
import { decrypt, encrypt, isEncrypted } from "../utils/encryption";

const GSC_TOKEN_ENCRYPTION_CONTEXT = "gsc-tokens";
const DEFAULT_LOOKBACK_DAYS = 35;
const GSC_ROW_LIMIT = 25_000;
const LOW_CTR_THRESHOLD = 0.02;
const LOW_CTR_MIN_IMPRESSIONS = 50;
const STRIKING_DISTANCE_MIN_IMPRESSIONS = 20;

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type SearchConsoleSiteEntry = {
  siteUrl: string;
  permissionLevel?: string;
};

type SearchAnalyticsRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

type SearchAnalyticsResponse = {
  rows?: SearchAnalyticsRow[];
};

export type SearchConsoleSite = {
  siteUrl: string;
  permissionLevel: string | null;
  verified: boolean;
};

export type SearchConsoleSyncResult = {
  success: boolean;
  rowsWritten: number;
  startDate: string;
  endDate: string;
  reason?: string;
};

type MetricAggregate = {
  key: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  positionWeight: number;
};

export async function connectSearchConsole(
  businessId: string,
  input: { code: string; redirectUri: string },
) {
  if (!input.code) throw new Error("OAuth code is required");
  if (!input.redirectUri) throw new Error("redirectUri is required");

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, businessWebsiteUrl: true },
  });
  if (!business) throw new Error("Business not found");

  const existing = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
    select: { gscRefreshToken: true },
  });

  const tokens = await exchangeOAuthCode(input.code, input.redirectUri);
  if (!tokens.access_token) {
    throw new Error("Google did not return an access token");
  }

  const sites = await fetchSearchConsoleSites(tokens.access_token);
  const selectedSiteUrl = chooseDefaultSite(
    sites,
    business.businessWebsiteUrl,
  );

  const refreshTokenToStore =
    tokens.refresh_token ??
    (existing?.gscRefreshToken
      ? decryptToken(existing.gscRefreshToken)
      : undefined);

  await prisma.businessAnalyticsConfig.upsert({
    where: { businessId },
    create: {
      businessId,
      gscSiteUrl: selectedSiteUrl,
      gscAccessToken: encryptToken(tokens.access_token),
      gscRefreshToken: refreshTokenToStore
        ? encryptToken(refreshTokenToStore)
        : null,
      gscConnectedAt: new Date(),
      gscLastSyncError: null,
    } as any,
    update: {
      gscSiteUrl: selectedSiteUrl,
      gscAccessToken: encryptToken(tokens.access_token),
      ...(refreshTokenToStore
        ? { gscRefreshToken: encryptToken(refreshTokenToStore) }
        : {}),
      gscConnectedAt: new Date(),
      gscLastSyncError: null,
    } as any,
  });

  return {
    connected: true,
    siteUrl: selectedSiteUrl,
    sites,
    requiresSiteSelection: !selectedSiteUrl,
  };
}

export async function listSearchConsoleSites(
  businessId: string,
): Promise<SearchConsoleSite[]> {
  const accessToken = await getValidAccessToken(businessId);
  return fetchSearchConsoleSites(accessToken);
}

export async function selectSearchConsoleSite(
  businessId: string,
  siteUrl: string,
) {
  const trimmedSiteUrl = siteUrl.trim();
  if (!trimmedSiteUrl) throw new Error("siteUrl is required");

  const sites = await listSearchConsoleSites(businessId);
  const match = sites.find(
    (site) => site.siteUrl === trimmedSiteUrl && site.verified,
  );
  if (!match) {
    throw new Error(
      "Selected Search Console property is not available for this Google account",
    );
  }

  await prisma.businessAnalyticsConfig.update({
    where: { businessId },
    data: {
      gscSiteUrl: trimmedSiteUrl,
      gscLastSyncError: null,
    } as any,
  });

  return getSearchConsoleStatus(businessId);
}

export async function getSearchConsoleStatus(businessId: string) {
  const config = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
    select: {
      gscSiteUrl: true,
      gscAccessToken: true,
      gscRefreshToken: true,
      gscConnectedAt: true,
      gscLastSyncedAt: true,
      gscLastSyncError: true,
    } as any,
  });

  if (!config?.gscAccessToken && !config?.gscRefreshToken) {
    return {
      connected: false,
      siteUrl: null,
      sites: [] as SearchConsoleSite[],
      connectedAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
    };
  }

  let sites: SearchConsoleSite[] = [];
  let listError: string | null = null;
  try {
    sites = await listSearchConsoleSites(businessId);
  } catch (error) {
    listError = (error as Error).message;
  }

  return {
    connected: true,
    siteUrl: config.gscSiteUrl,
    sites,
    connectedAt: config.gscConnectedAt,
    lastSyncedAt: config.gscLastSyncedAt,
    lastSyncError: config.gscLastSyncError ?? listError,
  };
}

export async function syncSearchConsoleMetrics(
  businessId: string,
  options: { days?: number; startDate?: string; endDate?: string } = {},
): Promise<SearchConsoleSyncResult> {
  const config = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
    select: {
      gscSiteUrl: true,
      gscAccessToken: true,
      gscRefreshToken: true,
    } as any,
  });

  if (!config?.gscSiteUrl) {
    return {
      success: false,
      rowsWritten: 0,
      ...resolveDateRange(options),
      reason: "Search Console property is not selected",
    };
  }

  const { startDate, endDate } = resolveDateRange(options);
  const accessToken = await getValidAccessToken(businessId);
  let startRow = 0;
  let rowsWritten = 0;

  try {
    while (true) {
      const response = await fetchSearchAnalyticsRows(accessToken, {
        siteUrl: config.gscSiteUrl,
        startDate,
        endDate,
        startRow,
      });
      const rows = response.rows ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const keys = row.keys ?? [];
        const date = parseApiDate(keys[0]);
        if (!date) continue;

        const query = keys[1] ?? "";
        const page = keys[2] ?? "";
        const device = keys[3] ?? "";
        const country = keys[4] ?? "";
        const clicks = Math.round(toFiniteNumber(row.clicks));
        const impressions = Math.round(toFiniteNumber(row.impressions));
        const ctr = toFiniteNumber(row.ctr);
        const position = toFiniteNumber(row.position);

        await prisma.searchConsoleMetric.upsert({
          where: {
            businessId_date_query_page_device_country: {
              businessId,
              date,
              query,
              page,
              device,
              country,
            },
          } as any,
          create: {
            businessId,
            date,
            query,
            page,
            device,
            country,
            clicks,
            impressions,
            ctr,
            position,
          },
          update: {
            clicks,
            impressions,
            ctr,
            position,
          },
        } as any);
        rowsWritten++;
      }

      if (rows.length < GSC_ROW_LIMIT) break;
      startRow += GSC_ROW_LIMIT;
    }

    await prisma.businessAnalyticsConfig.update({
      where: { businessId },
      data: {
        gscLastSyncedAt: new Date(),
        gscLastSyncError: null,
      } as any,
    });

    return { success: true, rowsWritten, startDate, endDate };
  } catch (error) {
    const message = (error as Error).message;
    await prisma.businessAnalyticsConfig.update({
      where: { businessId },
      data: { gscLastSyncError: message.slice(0, 500) } as any,
    });
    throw error;
  }
}

export async function getSearchConsoleSummary(
  businessId: string,
  options: { days?: number } = {},
) {
  const days = options.days ?? 30;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const [config, rows] = await Promise.all([
    prisma.businessAnalyticsConfig.findUnique({
      where: { businessId },
      select: {
        gscSiteUrl: true,
        gscConnectedAt: true,
        gscLastSyncedAt: true,
        gscLastSyncError: true,
      } as any,
    }),
    prisma.searchConsoleMetric.findMany({
      where: { businessId, date: { gte: since } },
      orderBy: [{ date: "desc" }],
    } as any),
  ]);

  const totals = {
    clicks: 0,
    impressions: 0,
    ctr: 0,
    averagePosition: 0,
  };

  let positionWeight = 0;
  const queryMap = new Map<string, MetricAggregate>();
  const pageMap = new Map<string, MetricAggregate>();
  const opportunityMap = new Map<string, MetricAggregate>();

  for (const row of rows as Array<{
    query: string;
    page: string;
    clicks: number;
    impressions: number;
    position: number;
  }>) {
    totals.clicks += row.clicks;
    totals.impressions += row.impressions;
    positionWeight += row.position * row.impressions;

    addAggregate(queryMap, row.query || "(not provided)", row, {
      query: row.query || "(not provided)",
      page: "",
    });
    addAggregate(pageMap, row.page || "(unknown page)", row, {
      query: "",
      page: row.page || "(unknown page)",
    });
    addAggregate(opportunityMap, `${row.query}\n${row.page}`, row, {
      query: row.query || "(not provided)",
      page: row.page || "(unknown page)",
    });
  }

  totals.ctr =
    totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  totals.averagePosition =
    totals.impressions > 0 ? positionWeight / totals.impressions : 0;

  const topQueries = sortAggregates(queryMap).slice(0, 10);
  const topPages = sortAggregates(pageMap).slice(0, 10);
  const opportunities = sortAggregates(opportunityMap);

  return {
    connected: !!config?.gscSiteUrl,
    siteUrl: config?.gscSiteUrl ?? null,
    connectedAt: config?.gscConnectedAt ?? null,
    lastSyncedAt: config?.gscLastSyncedAt ?? null,
    lastSyncError: config?.gscLastSyncError ?? null,
    days,
    totals,
    topQueries,
    topPages,
    opportunities: {
      lowCtr: opportunities
        .filter(
          (item) =>
            item.impressions >= LOW_CTR_MIN_IMPRESSIONS &&
            item.ctr < LOW_CTR_THRESHOLD,
        )
        .slice(0, 10),
      strikingDistance: opportunities
        .filter(
          (item) =>
            item.impressions >= STRIKING_DISTANCE_MIN_IMPRESSIONS &&
            item.averagePosition >= 8 &&
            item.averagePosition <= 20,
        )
        .slice(0, 10),
    },
  };
}

async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const clientId =
    process.env.GOOGLE_CLIENT_ID ?? process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials are not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok) {
    throw new Error(
      body.error_description ?? body.error ?? "Failed to exchange OAuth code",
    );
  }

  return body;
}

async function refreshAccessToken(
  businessId: string,
  storedRefreshToken: string,
): Promise<string> {
  const clientId =
    process.env.GOOGLE_CLIENT_ID ?? process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials are not configured");
  }

  const refreshToken = decryptToken(storedRefreshToken);
  if (!refreshToken) {
    throw new Error("Search Console refresh token is not available");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok || !body.access_token) {
    throw new Error(
      body.error_description ??
        body.error ??
        "Failed to refresh Search Console token",
    );
  }

  await prisma.businessAnalyticsConfig.update({
    where: { businessId },
    data: {
      gscAccessToken: encryptToken(body.access_token),
      ...(body.refresh_token
        ? { gscRefreshToken: encryptToken(body.refresh_token) }
        : {}),
    } as any,
  });

  return body.access_token;
}

async function getValidAccessToken(businessId: string): Promise<string> {
  const config = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
    select: { gscAccessToken: true, gscRefreshToken: true } as any,
  });

  if (!config?.gscAccessToken && !config?.gscRefreshToken) {
    throw new Error("Search Console is not connected");
  }

  if (config.gscRefreshToken) {
    return refreshAccessToken(businessId, config.gscRefreshToken);
  }

  return decryptToken(config.gscAccessToken);
}

async function fetchSearchConsoleSites(
  accessToken: string,
): Promise<SearchConsoleSite[]> {
  const response = await fetch(
    "https://www.googleapis.com/webmasters/v3/sites",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    siteEntry?: SearchConsoleSiteEntry[];
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      body.error?.message ?? "Failed to list Search Console properties",
    );
  }

  return (body.siteEntry ?? []).map((site) => ({
    siteUrl: site.siteUrl,
    permissionLevel: site.permissionLevel ?? null,
    verified: site.permissionLevel !== "siteUnverifiedUser",
  }));
}

async function fetchSearchAnalyticsRows(
  accessToken: string,
  input: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    startRow: number;
  },
): Promise<SearchAnalyticsResponse> {
  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      input.siteUrl,
    )}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: ["date", "query", "page", "device", "country"],
        rowLimit: GSC_ROW_LIMIT,
        startRow: input.startRow,
        dataState: "final",
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as
    | SearchAnalyticsResponse
    | { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(
      "error" in body && body.error?.message
        ? body.error.message
        : "Failed to fetch Search Console metrics",
    );
  }

  return body as SearchAnalyticsResponse;
}

function encryptToken(token: string): string {
  if (!token) return token;
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is required to store Search Console tokens");
  }
  return isEncrypted(token)
    ? token
    : encrypt(token, GSC_TOKEN_ENCRYPTION_CONTEXT);
}

function decryptToken(token: string | null | undefined): string {
  if (!token) return "";
  return isEncrypted(token)
    ? decrypt(token, GSC_TOKEN_ENCRYPTION_CONTEXT)
    : token;
}

function chooseDefaultSite(
  sites: SearchConsoleSite[],
  businessWebsiteUrl: string | null,
): string | null {
  const verifiedSites = sites.filter((site) => site.verified);
  if (verifiedSites.length === 0) return null;

  const domain = extractDomain(businessWebsiteUrl ?? "");
  if (!domain) return verifiedSites[0]?.siteUrl ?? null;

  const exactDomain = verifiedSites.find(
    (site) => site.siteUrl.toLowerCase() === `sc-domain:${domain}`,
  );
  if (exactDomain) return exactDomain.siteUrl;

  const urlPrefix = verifiedSites.find((site) => {
    const siteDomain = extractDomain(site.siteUrl);
    return siteDomain === domain;
  });

  return urlPrefix?.siteUrl ?? verifiedSites[0]?.siteUrl ?? null;
}

function extractDomain(value: string): string {
  if (!value) return "";
  if (value.startsWith("sc-domain:")) {
    return value.replace(/^sc-domain:/, "").replace(/^www\./, "").toLowerCase();
  }

  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.toLowerCase() ?? "";
  }
}

function resolveDateRange(options: {
  days?: number;
  startDate?: string;
  endDate?: string;
}): { startDate: string; endDate: string } {
  if (options.startDate && options.endDate) {
    return {
      startDate: options.startDate,
      endDate: options.endDate,
    };
  }

  const days = Math.max(1, options.days ?? DEFAULT_LOOKBACK_DAYS);
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  end.setUTCHours(0, 0, 0, 0);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);

  return {
    startDate: formatApiDate(start),
    endDate: formatApiDate(end),
  };
}

function formatApiDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseApiDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function toFiniteNumber(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function addAggregate(
  map: Map<string, MetricAggregate>,
  key: string,
  row: { query: string; page: string; clicks: number; impressions: number; position: number },
  labels: { query: string; page: string },
) {
  const aggregate =
    map.get(key) ??
    ({
      key,
      query: labels.query,
      page: labels.page,
      clicks: 0,
      impressions: 0,
      positionWeight: 0,
    } satisfies MetricAggregate);

  aggregate.clicks += row.clicks;
  aggregate.impressions += row.impressions;
  aggregate.positionWeight += row.position * row.impressions;
  map.set(key, aggregate);
}

function sortAggregates(map: Map<string, MetricAggregate>) {
  return [...map.values()]
    .map((item) => ({
      query: item.query,
      page: item.page,
      clicks: item.clicks,
      impressions: item.impressions,
      ctr: item.impressions > 0 ? item.clicks / item.impressions : 0,
      averagePosition:
        item.impressions > 0 ? item.positionWeight / item.impressions : 0,
    }))
    .sort((a, b) => b.impressions - a.impressions);
}
