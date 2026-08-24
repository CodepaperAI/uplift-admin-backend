import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  calculateDealCommissionLines,
  summarizeRepCommission,
  type CommissionDeal,
} from "../command/commission-engine";

const decimal = (value: string | number) => new Prisma.Decimal(value);

function deal(overrides: Partial<CommissionDeal> = {}): CommissionDeal {
  return {
    sourceType: "stripe_subscription",
    sourceId: "sub_1",
    serviceId: "service_1",
    repId: "rep_1",
    creditShare: decimal(1),
    amountMinor: decimal(9900),
    currency: "cad",
    kind: "subscription",
    startedAt: new Date("2026-01-10T12:00:00Z"),
    canceledAt: null,
    repDepartedAt: null,
    isPastDueInPeriod: false,
    heldMinorToRelease: decimal(0),
    rate: {
      id: "rate_1",
      firstSaleRate: decimal("0.5"),
      recurringRate: decimal("0.1"),
    },
    ...overrides,
  };
}

const january = {
  periodMonth: "2026-01",
  periodStart: new Date("2026-01-01T05:00:00Z"),
  periodEnd: new Date("2026-02-01T05:00:00Z"),
  clawbackWindowDays: 60 as const,
  departingRepResiduals: "stop_on_departure" as const,
};

describe("Command commission engine", () => {
  test("first month earns the exact first-sale rate", () => {
    const lines = calculateDealCommissionLines(deal(), january);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe("first_sale");
    expect(lines[0]?.amountMinor.toString()).toBe("4950");
  });

  test("recurring starts after the first month and stops in cancellation month", () => {
    const february = {
      ...january,
      periodMonth: "2026-02",
      periodStart: january.periodEnd,
      periodEnd: new Date("2026-03-01T05:00:00Z"),
    };
    expect(calculateDealCommissionLines(deal(), february)[0]?.amountMinor.toString()).toBe("990");
    const canceled = deal({ canceledAt: new Date("2026-02-12T12:00:00Z") });
    expect(
      calculateDealCommissionLines(canceled, { ...february, clawbackWindowDays: 0 }),
    ).toHaveLength(0);
  });

  test("a sale earned before departure keeps first-sale commission but residuals stop", () => {
    const beforeDeparture = deal({
      startedAt: new Date("2026-01-10T12:00:00Z"),
      repDepartedAt: new Date("2026-01-20T12:00:00Z"),
    });
    expect(calculateDealCommissionLines(beforeDeparture, january).map((line) => line.kind)).toEqual([
      "first_sale",
    ]);
    const february = {
      ...january,
      periodMonth: "2026-02",
      periodStart: january.periodEnd,
      periodEnd: new Date("2026-03-01T05:00:00Z"),
    };
    expect(calculateDealCommissionLines(beforeDeparture, february)).toHaveLength(0);
  });

  test("a source dated on or after departure cannot create first-sale earnings", () => {
    const afterDeparture = deal({
      startedAt: new Date("2026-01-20T12:00:00Z"),
      repDepartedAt: new Date("2026-01-20T12:00:00Z"),
    });
    expect(calculateDealCommissionLines(afterDeparture, january)).toHaveLength(0);
  });

  test("clawback is exact inside the approved window", () => {
    const lines = calculateDealCommissionLines(
      deal({ canceledAt: new Date("2026-01-31T12:00:00Z") }),
      january,
    );
    expect(lines.map((line) => [line.kind, line.amountMinor.toString()])).toEqual([
      ["first_sale", "4950"],
      ["clawback", "-4950"],
    ]);
  });

  test("past-due earnings are held and release only in the current open month", () => {
    const held = calculateDealCommissionLines(deal({ isPastDueInPeriod: true }), january);
    expect(held[0]?.status).toBe("held");
    const released = calculateDealCommissionLines(
      deal({ heldMinorToRelease: decimal(4950) }),
      { ...january, periodMonth: "2026-02", periodStart: january.periodEnd, periodEnd: new Date("2026-03-01T05:00:00Z") },
    );
    expect(released.some((line) => line.kind === "release" && line.amountMinor.eq(4950))).toBe(true);
  });

  test("approved corrections post as an exact open-period adjustment", () => {
    const lines = calculateDealCommissionLines(
      deal({
        startedAt: new Date("2025-12-10T12:00:00Z"),
        creditShare: decimal("0.4"),
        adjustmentMinor: decimal("1250.5"),
      }),
      january,
    );
    const adjustment = lines.find((line) => line.kind === "adjustment");
    expect(adjustment?.status).toBe("earned");
    expect(adjustment?.originPeriodMonth).toBe("approved_open_period_adjustment");
    expect(adjustment?.amountMinor.toString()).toBe("500.2");

    const summary = summarizeRepCommission({
      lines,
      baseDrawMinor: decimal(0),
      openingDrawBalanceMinor: decimal(0),
      drawPolicy: "non_recoverable",
    });
    expect(summary.recurringMinor.toString()).toBe("396");
    expect(summary.adjustmentMinor.toString()).toBe("500.2");
    expect(summary.earnedMinor.toString()).toBe("896.2");
  });

  test("worked draw example A creates a 25 balance", () => {
    const summary = summarizeRepCommission({
      lines: [{ ...calculateDealCommissionLines(deal(), january)[0]!, amountMinor: decimal(2475) }],
      baseDrawMinor: decimal(2500),
      openingDrawBalanceMinor: decimal(0),
      drawPolicy: "recoverable",
    });
    expect(summary.earnedMinor.toString()).toBe("2475");
    expect(summary.drawDifferentialMinor.toString()).toBe("-25");
    expect(summary.closingDrawBalanceMinor.toString()).toBe("25");
    expect(summary.cashPayableMinor.toString()).toBe("2500");
  });

  test("worked draw example B recovers 25 and leaves 2747 payable", () => {
    const summary = summarizeRepCommission({
      lines: [{ ...calculateDealCommissionLines(deal(), january)[0]!, amountMinor: decimal(2772) }],
      baseDrawMinor: decimal(2500),
      openingDrawBalanceMinor: decimal(25),
      drawPolicy: "recoverable",
    });
    expect(summary.drawRecoveryMinor.toString()).toBe("25");
    expect(summary.cashPayableMinor.toString()).toBe("2747");
    expect(summary.closingDrawBalanceMinor.toString()).toBe("0");
  });

  test("worked closes-needed example rounds up to 15", () => {
    const summary = summarizeRepCommission({
      lines: [],
      baseDrawMinor: decimal(2500),
      openingDrawBalanceMinor: decimal(0),
      drawPolicy: "non_recoverable",
      firstSaleCommissionPerCloseMinor: decimal("166.6667"),
    });
    expect(summary.closesNeeded).toBe(15);
  });

  test("ten $99 cancellations remove $990 MRR while recurring commission is $99", () => {
    const tenRecurring = Array.from({ length: 10 }, (_, index) =>
      calculateDealCommissionLines(
        deal({ sourceId: `sub_${index}`, startedAt: new Date("2025-12-10T12:00:00Z") }),
        january,
      )[0]!,
    );
    const summary = summarizeRepCommission({
      lines: tenRecurring,
      baseDrawMinor: decimal(0),
      openingDrawBalanceMinor: decimal(0),
      drawPolicy: "non_recoverable",
    });
    expect(summary.recurringMinor.toString()).toBe("9900");
  });
});
