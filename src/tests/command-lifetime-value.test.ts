import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  EXTRAPOLATION_WARNING_FACTOR,
  MAX_LIFETIME_MONTHS,
  calculateLifetimeValue,
  calculateLifetimeValueRange,
  cumulativeMonthlyChurnPercent,
} from "../command/lifetime-value";

/** The live USD figures, so the maths can be checked against the panel. */
const live = {
  mrrMinor: "2000845.1666666666667",
  payingUnits: 217,
  collectedMinor: "2289383",
  deliveryCostMinor: "21568",
  monthlyChurnPercent: "1.3682",
  churnWindowMonths: 3,
};

describe("calculateLifetimeValue", () => {
  test("multiplies ARPU by margin by expected lifetime", () => {
    const result = calculateLifetimeValue(live);
    // ARPU 9220.48 minor, margin 99.06%, lifetime capped at 60 months.
    expect(result.arpuMinor).toBe("9220.4846");
    expect(result.grossMarginPercent).toBe("99.06");
    expect(result.expectedLifetimeMonths).toBe("60.0");
    // Recomputed from the exact inputs, not from the rounded percent above —
    // reconstructing from a two-decimal margin drifts by a cent per hundred
    // dollars and would be asserting the display, not the arithmetic.
    const expected = new Prisma.Decimal(live.mrrMinor)
      .div(live.payingUnits)
      .mul(
        new Prisma.Decimal(live.collectedMinor)
          .sub(live.deliveryCostMinor)
          .div(live.collectedMinor),
      )
      .mul(MAX_LIFETIME_MONTHS);
    expect(result.ltvMinor).toBe(expected.toFixed(4));
  });

  test("caps an implausible lifetime rather than printing it", () => {
    // 1.37% monthly churn implies 73 months. A business with three months of
    // history has not earned a six-year projection, so the cap bites and says so.
    const result = calculateLifetimeValue(live);
    expect(result.blockers).toContain("lifetime_capped");
    expect(Number(result.expectedLifetimeMonths)).toBe(MAX_LIFETIME_MONTHS);
  });

  test("computes an uncapped lifetime when churn is high enough", () => {
    const result = calculateLifetimeValue({
      ...live,
      monthlyChurnPercent: "5",
    });
    expect(result.expectedLifetimeMonths).toBe("20.0");
    expect(result.blockers).not.toContain("lifetime_capped");
  });

  test("flags a projection that far outruns its own history", () => {
    const result = calculateLifetimeValue({
      ...live,
      monthlyChurnPercent: "5",
      churnWindowMonths: 3,
    });
    // 20 months projected from 3 months of history is 6.7x.
    expect(Number(result.extrapolationFactor)).toBeGreaterThanOrEqual(
      EXTRAPOLATION_WARNING_FACTOR,
    );
    expect(result.blockers).toContain("projection_exceeds_history");
  });

  test("does not flag extrapolation when the history supports the projection", () => {
    const result = calculateLifetimeValue({
      ...live,
      monthlyChurnPercent: "10",
      churnWindowMonths: 12,
    });
    expect(result.expectedLifetimeMonths).toBe("10.0");
    expect(result.blockers).not.toContain("projection_exceeds_history");
  });

  test("refuses to project from zero churn instead of dividing by it", () => {
    // Nobody left this window. That is not immortality, and 1/0 is not a metric.
    const result = calculateLifetimeValue({
      ...live,
      monthlyChurnPercent: "0.0000",
    });
    expect(result.ltvMinor).toBeNull();
    expect(result.expectedLifetimeMonths).toBeNull();
    expect(result.blockers).toContain("no_churn_observed");
  });

  test("reports no LTV when churn has never been measured", () => {
    const result = calculateLifetimeValue({
      ...live,
      monthlyChurnPercent: null,
    });
    expect(result.ltvMinor).toBeNull();
    expect(result.blockers).toContain("no_churn_measurement");
  });

  test("treats an empty collection window as no margin, not a zero margin", () => {
    // A zero margin would report LTV as nought and read as a finding. The
    // truth is that nothing was measured.
    const result = calculateLifetimeValue({ ...live, collectedMinor: "0" });
    expect(result.grossMarginPercent).toBeNull();
    expect(result.ltvMinor).toBeNull();
    expect(result.blockers).toContain("no_collections_in_window");
  });

  test("refuses to project a lifetime value on a negative margin", () => {
    const result = calculateLifetimeValue({
      ...live,
      collectedMinor: "1000",
      deliveryCostMinor: "4000",
      monthlyChurnPercent: "5",
    });
    expect(result.grossMarginPercent).toBe("-300.00");
    expect(result.ltvMinor).toBeNull();
    expect(result.blockers).toContain("non_positive_margin");
  });

  test("reports no ARPU when nothing is paying", () => {
    const result = calculateLifetimeValue({ ...live, payingUnits: 0 });
    expect(result.arpuMinor).toBeNull();
    expect(result.ltvMinor).toBeNull();
    expect(result.blockers).toContain("no_paying_units");
  });

  test("survives a fractional MRR, which minor units are not guaranteed to avoid", () => {
    // An annual price normalised to a month produces exactly this shape, and it
    // has taken a page down before.
    const result = calculateLifetimeValue({
      ...live,
      mrrMinor: "2935383.3334",
      monthlyChurnPercent: "5",
    });
    expect(result.ltvMinor).not.toBeNull();
  });

  test("returns nulls rather than throwing on unparseable input", () => {
    const result = calculateLifetimeValue({
      ...live,
      mrrMinor: "n/a",
      collectedMinor: "not a number",
    });
    expect(() => result).not.toThrow();
    expect(result.ltvMinor).toBeNull();
  });
});

describe("cumulativeMonthlyChurnPercent", () => {
  test("compounds the loss across the months observed", () => {
    // The live figures: USD 15,236.50 of MRR lost against 20,008.45 live, which
    // is 43.2% of everything ever won, spread over six months of trading.
    const rate = cumulativeMonthlyChurnPercent({
      churnedMinor: "1523650",
      liveMinor: "2000845.1666666666667",
      monthsObserved: 6,
    });
    expect(Number(rate)).toBeCloseTo(9.0, 1);
  });

  test("compounds rather than divides", () => {
    // Losing 43% over six months is not 7.2% a month — survival multiplies.
    // Getting this wrong understates churn and so overstates lifetime value.
    const rate = Number(
      cumulativeMonthlyChurnPercent({
        churnedMinor: "1523650",
        liveMinor: "2000845.1666666666667",
        monthsObserved: 6,
      }),
    );
    expect(rate).toBeGreaterThan(43.2 / 6);
  });

  test("half lost over one month is fifty percent", () => {
    expect(
      cumulativeMonthlyChurnPercent({
        churnedMinor: "1000",
        liveMinor: "1000",
        monthsObserved: 1,
      }),
    ).toBe("50.0000");
  });

  test("reports nothing when no revenue has churned yet", () => {
    // A young book, not permanence. Projecting an infinite life from it would
    // be the same mistake as dividing by a zero churn rate.
    expect(
      cumulativeMonthlyChurnPercent({
        churnedMinor: "0",
        liveMinor: "500000",
        monthsObserved: 6,
      }),
    ).toBeNull();
  });

  test("reports nothing when everything ever won has churned", () => {
    expect(
      cumulativeMonthlyChurnPercent({
        churnedMinor: "500000",
        liveMinor: "0",
        monthsObserved: 6,
      }),
    ).toBeNull();
  });

  test("reports nothing before any revenue exists or any time has passed", () => {
    expect(
      cumulativeMonthlyChurnPercent({ churnedMinor: 0, liveMinor: 0, monthsObserved: 6 }),
    ).toBeNull();
    expect(
      cumulativeMonthlyChurnPercent({
        churnedMinor: "100",
        liveMinor: "100",
        monthsObserved: 0,
      }),
    ).toBeNull();
  });
});

describe("calculateLifetimeValueRange", () => {
  const base = {
    mrrMinor: "2000845.1666666666667",
    payingUnits: 170,
    collectedMinor: "2757499",
    deliveryCostMinor: "23598",
    monthlyChurnPercent: "1.3682",
    cumulativeChurnPercent: "9.0000",
    monthsObserved: 6,
    marginMonth: "2026-08",
  };

  test("the conservative end is far below the optimistic one", () => {
    const range = calculateLifetimeValueRange(base);
    const low = Number(range.low!.ltvMinor);
    const high = Number(range.high!.ltvMinor);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
    // The spread is the honest content of this metric: two measurements of the
    // same thing that disagree several times over.
    expect(high / low).toBeGreaterThan(3);
  });

  test("names the method behind each end", () => {
    const range = calculateLifetimeValueRange(base);
    expect(range.basis.lowMethod).toBe("cumulative_revenue_churn");
    expect(range.basis.highMethod).toBe("monthly_revenue_churn");
    expect(range.basis.lowChurnPercent).toBe("9.0000");
    expect(range.basis.marginMonth).toBe("2026-08");
  });

  test("the conservative end is not capped, because real churn is not tiny", () => {
    const range = calculateLifetimeValueRange(base);
    expect(range.low!.blockers).not.toContain("lifetime_capped");
    expect(Number(range.low!.expectedLifetimeMonths)).toBeCloseTo(11.1, 0);
  });

  test("survives either measurement being absent", () => {
    expect(
      calculateLifetimeValueRange({ ...base, cumulativeChurnPercent: null }).low,
    ).toBeNull();
    expect(
      calculateLifetimeValueRange({ ...base, monthlyChurnPercent: null }).high,
    ).toBeNull();
  });
});
