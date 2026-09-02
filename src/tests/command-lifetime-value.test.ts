import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  EXTRAPOLATION_WARNING_FACTOR,
  MAX_LIFETIME_MONTHS,
  calculateLifetimeValue,
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
