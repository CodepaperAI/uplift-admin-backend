import { describe, expect, it } from "bun:test";
import { buildMovementHistory } from "../command/month-movement";

const EMPTY = { starts: [], cancellations: [], failedInvoices: [] } as const;

describe("buildMovementHistory signup counts", () => {
  it("uses pre-bucketed counts when given them", () => {
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-06",
      to: "2026-08",
      signupCountsByMonth: new Map([
        ["2026-06", 12],
        ["2026-07", 340],
        ["2026-08", 7],
      ]),
    });
    expect(history.months.map((month) => [month.month, month.signups])).toEqual([
      ["2026-06", 12],
      ["2026-07", 340],
      ["2026-08", 7],
    ]);
  });

  it("agrees with counting rows, which is the claim the swap rests on", () => {
    // Two Toronto months, with a row placed either side of a month boundary at
    // Toronto local time — 2026-07-01 00:30 in Toronto is 04:30 UTC, and
    // 2026-07-01 03:30 UTC is still June there.
    const rows = [
      { at: new Date("2026-06-15T12:00:00.000Z") },
      { at: new Date("2026-07-01T03:30:00.000Z") },
      { at: new Date("2026-07-01T04:30:00.000Z") },
      { at: new Date("2026-07-20T12:00:00.000Z") },
    ];
    const fromRows = buildMovementHistory({
      ...EMPTY,
      from: "2026-06",
      to: "2026-07",
      signups: rows,
    });
    const counted = new Map<string, number>();
    for (const month of fromRows.months) counted.set(month.month, month.signups);
    const fromCounts = buildMovementHistory({
      ...EMPTY,
      from: "2026-06",
      to: "2026-07",
      signupCountsByMonth: counted,
    });
    expect(fromCounts.months.map((m) => [m.month, m.signups])).toEqual(
      fromRows.months.map((m) => [m.month, m.signups]),
    );
    // And the boundary itself: the 03:30 UTC row belongs to June in Toronto.
    expect(counted.get("2026-06")).toBe(2);
    expect(counted.get("2026-07")).toBe(2);
  });

  it("ignores a month outside the requested span", () => {
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-08",
      to: "2026-08",
      signupCountsByMonth: new Map([
        ["2026-07", 999],
        ["2026-08", 5],
      ]),
    });
    expect(history.months).toHaveLength(1);
    expect(history.months[0]?.signups).toBe(5);
  });

  it("prefers the counts over the rows when both arrive", () => {
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-08",
      to: "2026-08",
      signups: [{ at: new Date("2026-08-10T12:00:00.000Z") }],
      signupCountsByMonth: new Map([["2026-08", 42]]),
    });
    expect(history.months[0]?.signups).toBe(42);
  });

  it("reports zero for a month with no signups rather than omitting it", () => {
    const history = buildMovementHistory({
      ...EMPTY,
      from: "2026-07",
      to: "2026-08",
      signupCountsByMonth: new Map([["2026-08", 3]]),
    });
    expect(history.months.map((m) => m.signups)).toEqual([0, 3]);
  });
});
