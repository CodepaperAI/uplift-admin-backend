/**
 * Shaping for a client's Search Console figures.
 *
 * The pure half, so the CTR arithmetic and the empty cases are testable without
 * a database.
 *
 * One rule runs through all of it: a rate with no denominator is not zero, it is
 * unknown. A page with no impressions has no click-through rate, and reporting
 * `0.00%` there puts a real-looking number next to a page nothing has measured.
 */

export type SearchConsoleGroup = {
  _sum: { clicks: number | null; impressions: number | null };
  _avg: { position: number | null };
};

export type SearchConsoleDateRow = SearchConsoleGroup & { date: Date };
export type SearchConsolePageRow = SearchConsoleGroup & { page: string };
export type SearchConsoleQueryRow = SearchConsoleGroup & { query: string };

function n(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Clicks per impression, or null when nothing was shown. */
export function ctrPercent(
  clicks: number | null | undefined,
  impressions: number | null | undefined,
): string | null {
  const shown = n(impressions);
  if (shown <= 0) return null;
  return ((n(clicks) * 100) / shown).toFixed(2);
}

/** Average position to one decimal, or null when nothing ranked. */
export function positionOf(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value.toFixed(1)
    : null;
}

export function summariseSearchConsole(input: {
  totals: SearchConsoleGroup & { _count: { _all: number } };
  byDate: readonly SearchConsoleDateRow[];
  topPages: readonly SearchConsolePageRow[];
  topQueries: readonly SearchConsoleQueryRow[];
}) {
  const clicks = n(input.totals._sum.clicks);
  const impressions = n(input.totals._sum.impressions);
  return {
    totals: {
      clicks,
      impressions,
      ctrPercent: ctrPercent(clicks, impressions),
      averagePosition: positionOf(input.totals._avg.position),
      rows: input.totals._count._all,
    },
    trend: input.byDate.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      clicks: n(row._sum.clicks),
      impressions: n(row._sum.impressions),
      averagePosition: positionOf(row._avg.position),
    })),
    topPages: input.topPages.map((row) => ({
      page: row.page,
      clicks: n(row._sum.clicks),
      impressions: n(row._sum.impressions),
      ctrPercent: ctrPercent(row._sum.clicks, row._sum.impressions),
      averagePosition: positionOf(row._avg.position),
    })),
    topQueries: input.topQueries.map((row) => ({
      query: row.query,
      clicks: n(row._sum.clicks),
      impressions: n(row._sum.impressions),
      ctrPercent: ctrPercent(row._sum.clicks, row._sum.impressions),
      averagePosition: positionOf(row._avg.position),
    })),
  };
}
