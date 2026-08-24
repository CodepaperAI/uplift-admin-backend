import { prisma } from "../config/db.config";
import { LlmProvider } from "@prisma/client";
import { normalizeCompetitorHost } from "./ai-citation-monitoring.service";

/**
 * Share of Voice Service
 * ----------------------------------------------------------------------------
 * Aggregates the raw citation rows in LlmCitation into "brand vs competitor"
 * percentages. Share of Voice is the share of cited mentions across an
 * AI-engine answer surface — our own cited answers ÷ (our cited answers +
 * all distinct competitor mentions).
 *
 * Data already lives in LlmCitation:
 *   - Own citations: cited=true counts for our domain
 *   - Competitor mentions: competitorsCited JSON array per row
 *
 * No migration needed to launch. If read latency becomes a problem, add a
 * daily rollup table later — the shape here is compatible.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type SovWindow = "7d" | "30d" | "90d";

function windowToDays(window: SovWindow | undefined): number {
  if (window === "7d") return 7;
  if (window === "90d") return 90;
  return 30;
}

interface CompetitorShare {
  domain: string;
  mentions: number;
  pct: number;
}

interface ProviderShare {
  provider: LlmProvider;
  yourPct: number;
  yourMentions: number;
  competitorMentions: number;
  totalMentions: number;
}

interface KeywordShare {
  keyword: string;
  yourMentions: number;
  competitorMentions: number;
  totalMentions: number;
  yourPct: number;
  topCompetitors: CompetitorShare[];
}

export interface ShareOfVoiceResult {
  window: SovWindow;
  windowDays: number;
  overall: {
    yourMentions: number;
    competitorMentions: number;
    totalMentions: number;
    yourPct: number;
    topCompetitors: CompetitorShare[];
  };
  perKeyword: KeywordShare[];
  perProvider: ProviderShare[];
}

export async function getShareOfVoice(
  businessId: string,
  options: { window?: SovWindow } = {},
): Promise<ShareOfVoiceResult> {
  const window: SovWindow = options.window ?? "30d";
  const windowDays = windowToDays(window);
  const since = new Date(Date.now() - windowDays * DAY_MS);

  const citations = await prisma.llmCitation.findMany({
    where: { businessId, createdAt: { gte: since } },
    select: {
      keyword: true,
      llmProvider: true,
      citedCount: true,
      cited: true,
      competitorsCited: true,
    },
  });

  // ---- Overall + per-keyword + per-provider aggregation -----
  let overallYour = 0;
  let overallCompetitor = 0;
  const overallCompetitorCounts = new Map<string, number>();

  const keywordMap = new Map<
    string,
    {
      yourMentions: number;
      competitorMentions: number;
      competitorCounts: Map<string, number>;
    }
  >();

  const providerMap = new Map<
    LlmProvider,
    { yourMentions: number; competitorMentions: number }
  >();

  for (const row of citations) {
    // Per-row "your" mentions = citedCount (one hit per run that cited us).
    const yourForRow = row.citedCount;
    // Per-row "competitor" mentions = count of distinct competitor domains.
    const competitorsRaw = (row.competitorsCited as any[]) || [];
    const uniqueCompetitorHosts = new Set<string>();
    for (const entry of competitorsRaw) {
      const host = normalizeCompetitorHost(entry?.domain ?? entry?.url ?? "");
      if (host) uniqueCompetitorHosts.add(host);
    }
    const competitorForRow = uniqueCompetitorHosts.size;

    overallYour += yourForRow;
    overallCompetitor += competitorForRow;
    for (const host of uniqueCompetitorHosts) {
      overallCompetitorCounts.set(
        host,
        (overallCompetitorCounts.get(host) ?? 0) + 1,
      );
    }

    // Per keyword
    const kwEntry =
      keywordMap.get(row.keyword) ?? {
        yourMentions: 0,
        competitorMentions: 0,
        competitorCounts: new Map<string, number>(),
      };
    kwEntry.yourMentions += yourForRow;
    kwEntry.competitorMentions += competitorForRow;
    for (const host of uniqueCompetitorHosts) {
      kwEntry.competitorCounts.set(
        host,
        (kwEntry.competitorCounts.get(host) ?? 0) + 1,
      );
    }
    keywordMap.set(row.keyword, kwEntry);

    // Per provider
    const provEntry =
      providerMap.get(row.llmProvider) ?? {
        yourMentions: 0,
        competitorMentions: 0,
      };
    provEntry.yourMentions += yourForRow;
    provEntry.competitorMentions += competitorForRow;
    providerMap.set(row.llmProvider, provEntry);
  }

  const overallTotal = overallYour + overallCompetitor;
  const overallTopCompetitors: CompetitorShare[] = [...overallCompetitorCounts]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([domain, mentions]) => ({
      domain,
      mentions,
      pct: overallTotal > 0 ? round1((mentions / overallTotal) * 100) : 0,
    }));

  const perKeyword: KeywordShare[] = [...keywordMap.entries()]
    .map(([keyword, v]) => {
      const total = v.yourMentions + v.competitorMentions;
      const topCompetitors: CompetitorShare[] = [...v.competitorCounts]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([domain, mentions]) => ({
          domain,
          mentions,
          pct: total > 0 ? round1((mentions / total) * 100) : 0,
        }));
      return {
        keyword,
        yourMentions: v.yourMentions,
        competitorMentions: v.competitorMentions,
        totalMentions: total,
        yourPct: total > 0 ? round1((v.yourMentions / total) * 100) : 0,
        topCompetitors,
      };
    })
    .sort((a, b) => b.totalMentions - a.totalMentions);

  const perProvider: ProviderShare[] = [...providerMap.entries()].map(
    ([provider, v]) => {
      const total = v.yourMentions + v.competitorMentions;
      return {
        provider,
        yourMentions: v.yourMentions,
        competitorMentions: v.competitorMentions,
        totalMentions: total,
        yourPct: total > 0 ? round1((v.yourMentions / total) * 100) : 0,
      };
    },
  );

  return {
    window,
    windowDays,
    overall: {
      yourMentions: overallYour,
      competitorMentions: overallCompetitor,
      totalMentions: overallTotal,
      yourPct: overallTotal > 0 ? round1((overallYour / overallTotal) * 100) : 0,
      topCompetitors: overallTopCompetitors,
    },
    perKeyword,
    perProvider,
  };
}

export interface SovTrendPoint {
  date: string; // YYYY-MM-DD
  yourMentions: number;
  competitorMentions: number;
  totalMentions: number;
  yourPct: number;
  rollingAveragePct: number; // 7-day trailing average
}

export async function getShareOfVoiceTrend(
  businessId: string,
  options: { keyword?: string; days?: number } = {},
): Promise<SovTrendPoint[]> {
  const days = options.days ?? 30;
  const since = new Date(Date.now() - days * DAY_MS);

  const citations = await prisma.llmCitation.findMany({
    where: {
      businessId,
      createdAt: { gte: since },
      ...(options.keyword ? { keyword: options.keyword } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      citedCount: true,
      competitorsCited: true,
    },
  });

  const dailyMap = new Map<string, { your: number; competitor: number }>();
  for (const row of citations) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const competitorsRaw = (row.competitorsCited as any[]) || [];
    const uniqueHosts = new Set<string>();
    for (const entry of competitorsRaw) {
      const host = normalizeCompetitorHost(entry?.domain ?? entry?.url ?? "");
      if (host) uniqueHosts.add(host);
    }
    const entry = dailyMap.get(day) ?? { your: 0, competitor: 0 };
    entry.your += row.citedCount;
    entry.competitor += uniqueHosts.size;
    dailyMap.set(day, entry);
  }

  const sortedDays = [...dailyMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return sortedDays.map(([date, data], idx) => {
    const total = data.your + data.competitor;
    const yourPct = total > 0 ? round1((data.your / total) * 100) : 0;

    // 7-day trailing rolling average, aggregating across days.
    const windowStart = Math.max(0, idx - 6);
    const windowRows = sortedDays.slice(windowStart, idx + 1);
    const winYour = windowRows.reduce((s, [, d]) => s + d.your, 0);
    const winCompetitor = windowRows.reduce((s, [, d]) => s + d.competitor, 0);
    const winTotal = winYour + winCompetitor;
    const rolling = winTotal > 0 ? round1((winYour / winTotal) * 100) : 0;

    return {
      date,
      yourMentions: data.your,
      competitorMentions: data.competitor,
      totalMentions: total,
      yourPct,
      rollingAveragePct: rolling,
    };
  });
}

/**
 * Detect whether a keyword has lost Share of Voice recently vs the prior
 * comparable window. Used by the freshness refresh service to trigger
 * regen when AI visibility collapses (independent of page age / SEO score).
 *
 * Compares the trailing `windowDays` against the window immediately
 * preceding it. Returns droppedBy as a percentage-point delta.
 *
 *   previousPct = 60%, currentPct = 40%   → droppedBy = 20
 *   previousPct = 10%, currentPct = 15%   → droppedBy = -5  (gained)
 *
 * When there's no prior data (zero mentions in the previous window), we
 * cannot detect "decay" — return dropped=false so we don't churn.
 */
export async function detectSovDrop(
  businessId: string,
  keyword: string,
  options: { windowDays?: number; dropThresholdPct?: number } = {},
): Promise<{
  dropped: boolean;
  droppedBy: number;
  currentPct: number;
  previousPct: number;
  currentMentions: number;
  previousMentions: number;
}> {
  const windowDays = options.windowDays ?? 30;
  const dropThresholdPct = options.dropThresholdPct ?? 25;
  const now = Date.now();
  const currentSince = new Date(now - windowDays * DAY_MS);
  const previousSince = new Date(now - 2 * windowDays * DAY_MS);

  const rows = await prisma.llmCitation.findMany({
    where: {
      businessId,
      keyword,
      createdAt: { gte: previousSince },
    },
    select: {
      createdAt: true,
      citedCount: true,
      competitorsCited: true,
    },
  });

  let curYour = 0;
  let curCompetitor = 0;
  let prevYour = 0;
  let prevCompetitor = 0;

  for (const row of rows) {
    const competitorsRaw = (row.competitorsCited as any[]) || [];
    const uniqueHosts = new Set<string>();
    for (const entry of competitorsRaw) {
      const host = normalizeCompetitorHost(entry?.domain ?? entry?.url ?? "");
      if (host) uniqueHosts.add(host);
    }
    const your = row.citedCount;
    const competitor = uniqueHosts.size;

    if (row.createdAt >= currentSince) {
      curYour += your;
      curCompetitor += competitor;
    } else {
      prevYour += your;
      prevCompetitor += competitor;
    }
  }

  const curTotal = curYour + curCompetitor;
  const prevTotal = prevYour + prevCompetitor;
  const currentPct = curTotal > 0 ? (curYour / curTotal) * 100 : 0;
  const previousPct = prevTotal > 0 ? (prevYour / prevTotal) * 100 : 0;
  const droppedBy = round1(previousPct - currentPct);

  // If we have no prior signal, we can't call it a "drop".
  const dropped =
    prevTotal > 0 && droppedBy >= dropThresholdPct && curTotal > 0;

  return {
    dropped,
    droppedBy,
    currentPct: round1(currentPct),
    previousPct: round1(previousPct),
    currentMentions: curYour,
    previousMentions: prevYour,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
