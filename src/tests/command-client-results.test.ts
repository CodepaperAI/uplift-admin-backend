import { describe, expect, test } from "bun:test";
import {
  ctrPercent,
  positionOf,
  summariseSearchConsole,
} from "../command/client-results";

describe("ctrPercent", () => {
  test("is clicks over impressions", () => {
    expect(ctrPercent(5, 100)).toBe("5.00");
    expect(ctrPercent(1, 3)).toBe("33.33");
  });

  test("is unknown rather than zero when nothing was shown", () => {
    // A page with no impressions has no click-through rate. Rendering 0.00%
    // puts a real-looking number next to a page nothing has measured.
    expect(ctrPercent(0, 0)).toBeNull();
    expect(ctrPercent(0, null)).toBeNull();
    expect(ctrPercent(4, undefined)).toBeNull();
  });

  test("is zero when impressions happened and nobody clicked", () => {
    // Distinct from the case above, and the distinction is the whole point.
    expect(ctrPercent(0, 240)).toBe("0.00");
  });
});

describe("positionOf", () => {
  test("rounds to one decimal", () => {
    expect(positionOf(12.34)).toBe("12.3");
    expect(positionOf(1)).toBe("1.0");
  });

  test("treats absent or nonsensical positions as unknown", () => {
    for (const value of [null, undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(positionOf(value)).toBeNull();
    }
  });
});

describe("summariseSearchConsole", () => {
  const group = (clicks: number | null, impressions: number | null, position: number | null) => ({
    _sum: { clicks, impressions },
    _avg: { position },
  });

  test("totals, trend, pages and queries all come back shaped", () => {
    const summary = summariseSearchConsole({
      totals: { ...group(120, 4_000, 14.2), _count: { _all: 900 } },
      byDate: [{ ...group(10, 300, 12.5), date: new Date("2026-08-01T00:00:00.000Z") }],
      topPages: [{ ...group(40, 900, 8.1), page: "https://example.com/a" }],
      topQueries: [{ ...group(30, 700, 6.4), query: "best widgets" }],
    });
    expect(summary.totals.clicks).toBe(120);
    expect(summary.totals.ctrPercent).toBe("3.00");
    expect(summary.trend[0]?.date).toBe("2026-08-01");
    expect(summary.topPages[0]?.ctrPercent).toBe("4.44");
    expect(summary.topQueries[0]?.averagePosition).toBe("6.4");
  });

  test("survives an account whose metrics are all null", () => {
    // Prisma returns null sums for an empty group rather than zero, and a page
    // that crashed on that would take down the whole account view.
    const summary = summariseSearchConsole({
      totals: { ...group(null, null, null), _count: { _all: 0 } },
      byDate: [],
      topPages: [],
      topQueries: [],
    });
    expect(summary.totals.clicks).toBe(0);
    expect(summary.totals.impressions).toBe(0);
    expect(summary.totals.ctrPercent).toBeNull();
    expect(summary.totals.averagePosition).toBeNull();
    expect(summary.trend).toEqual([]);
  });

  test("keeps a page that was shown but never clicked", () => {
    // The row worth seeing: it ranks, and nobody is clicking it.
    const summary = summariseSearchConsole({
      totals: { ...group(0, 500, 42.7), _count: { _all: 3 } },
      byDate: [],
      topPages: [{ ...group(0, 500, 42.7), page: "https://example.com/buried" }],
      topQueries: [],
    });
    expect(summary.topPages[0]?.clicks).toBe(0);
    expect(summary.topPages[0]?.ctrPercent).toBe("0.00");
    expect(summary.topPages[0]?.averagePosition).toBe("42.7");
  });
});
