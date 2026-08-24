import { prisma } from "../config/db.config";
import {
  AI_ENGINE_SOURCE_PATTERN,
  getAnalyticsClient,
} from "../config/analytics.config";

/**
 * GA4 Analytics Service (Phase 4)
 * ----------------------------------------------------------------------------
 * Syncs AI-referral traffic from Google Analytics 4 into the local
 * AiReferralTraffic table so the dashboard can attribute AI citations to
 * actual traffic and conversions without exposing GA4 credentials to the
 * browser.
 *
 * Design choices:
 *   - We run one GA4 `runReport` per business per sync, fetching last N
 *     days so re-runs are idempotent (we upsert on unique
 *     (businessId, date, source, blogUrl)).
 *   - A REGEXP_CONTAINS filter on sessionSource isolates the AI-engine
 *     surface — Bing, Wikipedia, etc. are excluded.
 *   - If either the service account or the property ID is missing we
 *     noop. Callers (cron) decide whether to warn.
 */

const DEFAULT_LOOKBACK_DAYS = 30;

export interface SyncOptions {
  days?: number;
}

export interface SyncResult {
  success: boolean;
  rowsWritten: number;
  reason?: string;
}

export async function syncAiReferralTraffic(
  businessId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const days = options.days ?? DEFAULT_LOOKBACK_DAYS;

  const config = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
  });
  if (!config?.ga4PropertyId) {
    return {
      success: false,
      rowsWritten: 0,
      reason: "GA4 not connected for this business",
    };
  }

  const client = getAnalyticsClient(config.serviceAccountRef);
  if (!client) {
    return {
      success: false,
      rowsWritten: 0,
      reason: "Analytics client unavailable (missing credentials)",
    };
  }

  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const [response] = await client.runReport({
      property: `properties/${config.ga4PropertyId}`,
      dateRanges: [
        {
          startDate: formatGA4Date(startDate),
          endDate: formatGA4Date(endDate),
        },
      ],
      dimensions: [
        { name: "date" },
        { name: "sessionSource" },
        { name: "landingPage" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "conversions" },
      ],
      dimensionFilter: {
        filter: {
          fieldName: "sessionSource",
          stringFilter: {
            matchType: "FULL_REGEXP",
            value: AI_ENGINE_SOURCE_PATTERN,
            caseSensitive: false,
          },
        },
      },
      limit: 5000,
    });

    const rows = response.rows ?? [];
    let rowsWritten = 0;

    // Wipe same-window rows so we never double-count if GA4 restates a day.
    await prisma.aiReferralTraffic.deleteMany({
      where: {
        businessId,
        date: {
          gte: new Date(
            Date.UTC(
              startDate.getUTCFullYear(),
              startDate.getUTCMonth(),
              startDate.getUTCDate(),
            ),
          ),
        },
      },
    });

    for (const row of rows) {
      const dims = row.dimensionValues ?? [];
      const mets = row.metricValues ?? [];

      const gaDate = dims[0]?.value ?? "";
      const source = dims[1]?.value ?? "";
      const landingPage = dims[2]?.value ?? null;

      const date = parseGA4Date(gaDate);
      if (!date || !source) continue;

      const sessions = toInt(mets[0]?.value);
      const engagedSessions = toInt(mets[1]?.value);
      const conversions = toInt(mets[2]?.value);

      // Skip zero-signal rows.
      if (sessions === 0) continue;

      try {
        await prisma.aiReferralTraffic.upsert({
          where: {
            businessId_date_source_blogUrl: {
              businessId,
              date,
              source,
              blogUrl: landingPage ?? "",
            },
          } as any,
          create: {
            businessId,
            date,
            source,
            sessions,
            engagedSessions,
            conversions,
            blogUrl: landingPage,
          },
          update: {
            sessions,
            engagedSessions,
            conversions,
          },
        });
        rowsWritten++;
      } catch (err) {
        // The composite unique relies on Prisma's generated input type.
        // If it's unavailable, fall back to createMany skipDuplicates.
        console.warn(
          "[ga4-analytics] upsert fallback:",
          (err as Error).message,
        );
        await prisma.aiReferralTraffic.create({
          data: {
            businessId,
            date,
            source,
            sessions,
            engagedSessions,
            conversions,
            blogUrl: landingPage,
          },
        });
        rowsWritten++;
      }
    }

    await prisma.businessAnalyticsConfig.update({
      where: { businessId },
      data: { lastSyncedAt: new Date(), lastSyncError: null },
    });

    return { success: true, rowsWritten };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.businessAnalyticsConfig.update({
      where: { businessId },
      data: { lastSyncError: message.slice(0, 500) },
    });
    throw err;
  }
}

export async function getAiReferralStats(
  businessId: string,
  options: { days?: number } = {},
): Promise<{
  days: number;
  totals: {
    sessions: number;
    engagedSessions: number;
    conversions: number;
  };
  bySource: Array<{
    source: string;
    sessions: number;
    engagedSessions: number;
    conversions: number;
  }>;
  byDay: Array<{
    date: string;
    sessions: number;
    engagedSessions: number;
    conversions: number;
  }>;
  topBlogs: Array<{ blogUrl: string; sessions: number }>;
}> {
  const days = options.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.aiReferralTraffic.findMany({
    where: { businessId, date: { gte: since } },
    orderBy: [{ date: "asc" }],
  });

  const totals = { sessions: 0, engagedSessions: 0, conversions: 0 };
  const bySourceMap = new Map<
    string,
    { sessions: number; engagedSessions: number; conversions: number }
  >();
  const byDayMap = new Map<
    string,
    { sessions: number; engagedSessions: number; conversions: number }
  >();
  const blogMap = new Map<string, number>();

  for (const r of rows) {
    totals.sessions += r.sessions;
    totals.engagedSessions += r.engagedSessions;
    totals.conversions += r.conversions;

    const src =
      bySourceMap.get(r.source) ?? {
        sessions: 0,
        engagedSessions: 0,
        conversions: 0,
      };
    src.sessions += r.sessions;
    src.engagedSessions += r.engagedSessions;
    src.conversions += r.conversions;
    bySourceMap.set(r.source, src);

    const dayKey = r.date.toISOString().slice(0, 10);
    const day =
      byDayMap.get(dayKey) ?? {
        sessions: 0,
        engagedSessions: 0,
        conversions: 0,
      };
    day.sessions += r.sessions;
    day.engagedSessions += r.engagedSessions;
    day.conversions += r.conversions;
    byDayMap.set(dayKey, day);

    if (r.blogUrl) {
      blogMap.set(r.blogUrl, (blogMap.get(r.blogUrl) ?? 0) + r.sessions);
    }
  }

  const bySource = [...bySourceMap.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.sessions - a.sessions);

  const byDay = [...byDayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topBlogs = [...blogMap.entries()]
    .map(([blogUrl, sessions]) => ({ blogUrl, sessions }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  return { days, totals, bySource, byDay, topBlogs };
}

/**
 * Save / update a business's GA4 config.
 * serviceAccountJson is stored verbatim in serviceAccountRef if provided
 * (the service reads it back at sync time). Callers should avoid echoing
 * this value back to the client — there's no "get credentials" endpoint.
 */
export async function connectGa4(
  businessId: string,
  input: { ga4PropertyId: string; serviceAccountJson?: string },
) {
  if (!input.ga4PropertyId) {
    throw new Error("ga4PropertyId is required");
  }
  // Light validation — if customer pastes the whole "properties/12345" path.
  const propertyId = input.ga4PropertyId.replace(/^properties\//, "").trim();

  return prisma.businessAnalyticsConfig.upsert({
    where: { businessId },
    create: {
      businessId,
      ga4PropertyId: propertyId,
      serviceAccountRef: input.serviceAccountJson,
      connectedAt: new Date(),
    },
    update: {
      ga4PropertyId: propertyId,
      ...(input.serviceAccountJson
        ? { serviceAccountRef: input.serviceAccountJson }
        : {}),
      connectedAt: new Date(),
    },
  });
}

export async function getGa4Status(businessId: string) {
  const config = await prisma.businessAnalyticsConfig.findUnique({
    where: { businessId },
    select: {
      ga4PropertyId: true,
      connectedAt: true,
      lastSyncedAt: true,
      lastSyncError: true,
      serviceAccountRef: true,
    },
  });
  if (!config) {
    return {
      connected: false,
      ga4PropertyId: null,
      connectedAt: null,
      lastSyncedAt: null,
      lastSyncError: null,
      usesBusinessServiceAccount: false,
    };
  }
  return {
    connected: !!config.ga4PropertyId,
    ga4PropertyId: config.ga4PropertyId,
    connectedAt: config.connectedAt,
    lastSyncedAt: config.lastSyncedAt,
    lastSyncError: config.lastSyncError,
    usesBusinessServiceAccount: !!config.serviceAccountRef,
  };
}

// ---- helpers -----

function formatGA4Date(d: Date): string {
  // GA4 API accepts YYYY-MM-DD.
  return d.toISOString().slice(0, 10);
}

function parseGA4Date(gaDate: string): Date | null {
  // GA4 returns dates as YYYYMMDD.
  if (!/^\d{8}$/.test(gaDate)) return null;
  const y = Number(gaDate.slice(0, 4));
  const m = Number(gaDate.slice(4, 6));
  const d = Number(gaDate.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

function toInt(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
