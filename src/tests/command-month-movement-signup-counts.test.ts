import { describe, expect, it } from "bun:test";
import { buildMovementHistory } from "../command/month-movement";

const EMPTY = { starts: [], cancellations: [], failedInvoices: [] } as const;

/**
 * Signups are bucketed by Toronto month, not UTC month.
 *
 * The rest of this chart — arrivals, cancellations, collected — is bucketed by
 * `commandMonthRange`, which is Toronto. The signup count is bucketed by
 * `commandMonthForDate`. Both have to agree on where a month ends, or the
 * columns of one chart would be measuring two different months. The hours either
 * side of midnight on the first are the only place that shows.
 */
describe("signup months use the Toronto boundary", () => {
  it("puts the small hours of a UTC month into the previous Toronto month", () => {
    // 2026-07-01 03:30 UTC is 2026-06-30 23:30 in Toronto — June, not July.
    // 2026-07-01 04:30 UTC is 2026-07-01 00:30 in Toronto — July.
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-06",
      to: "2026-07",
      signups: [
        { at: new Date("2026-06-15T12:00:00.000Z") },
        { at: new Date("2026-07-01T03:30:00.000Z") },
        { at: new Date("2026-07-01T04:30:00.000Z") },
        { at: new Date("2026-07-20T12:00:00.000Z") },
      ],
    });
    expect(history.months.map((month) => [month.month, month.signups])).toEqual([
      ["2026-06", 2],
      ["2026-07", 2],
    ]);
  });

  it("holds across the winter offset too, where the boundary is an hour later", () => {
    // Toronto is UTC-5 in January, so 2026-01-01 04:30 UTC is still December.
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2025-12",
      to: "2026-01",
      signups: [
        { at: new Date("2026-01-01T04:30:00.000Z") },
        { at: new Date("2026-01-01T05:30:00.000Z") },
      ],
    });
    expect(history.months.map((month) => [month.month, month.signups])).toEqual([
      ["2025-12", 1],
      ["2026-01", 1],
    ]);
  });

  it("drops a signup outside the requested span rather than widening it", () => {
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-08",
      to: "2026-08",
      signups: [
        { at: new Date("2026-07-15T12:00:00.000Z") },
        { at: new Date("2026-08-15T12:00:00.000Z") },
      ],
    });
    expect(history.months).toHaveLength(1);
    expect(history.months[0]?.signups).toBe(1);
  });
});
