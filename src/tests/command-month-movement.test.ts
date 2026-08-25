import { describe, expect, test } from "bun:test";
import {
  buildMonthMovement,
  parseMovementMonth,
  type FailedInvoiceFact,
  type MovementFact,
} from "../command/month-movement";

const MONTH = "2026-08";

function start(account: string, at: string, source: MovementFact["source"] = "subscription_record"): MovementFact {
  return { accountKey: account, at: new Date(at), source };
}

function invoice(account: string, at: string, id = `in_${account}_${at}`): FailedInvoiceFact {
  return { accountKey: account, stripeInvoiceId: id, at: new Date(at) };
}

const dayOf = (result: ReturnType<typeof buildMonthMovement>, date: string) =>
  result.days.find((day) => day.date === date)!;

describe("buildMonthMovement", () => {
  test("covers every day of the month, including the quiet ones", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [],
    });
    expect(result.days).toHaveLength(31);
    expect(result.days[0]?.date).toBe("2026-08-01");
    expect(result.days.at(-1)?.date).toBe("2026-08-31");
    expect(result.totals.newSubscribers).toBe(0);
  });

  test("counts arrivals per Toronto day", () => {
    const result = buildMonthMovement({
      month: MONTH,
      // 04:00Z on the 5th is midnight Toronto — the 5th, not the 4th.
      starts: [start("cus_a", "2026-08-05T04:00:00.000Z"), start("cus_b", "2026-08-05T18:00:00.000Z")],
      cancellations: [],
      failedInvoices: [],
    });
    expect(dayOf(result, "2026-08-05").newSubscribers).toBe(2);
    expect(dayOf(result, "2026-08-04").newSubscribers).toBe(0);
    expect(result.totals.newSubscribers).toBe(2);
  });

  test("an instant before Toronto midnight belongs to the previous day", () => {
    // 03:59Z on the 1st is still 23:59 on July 31 in Toronto, so it is not
    // August business at all and must be reported as ignored, not counted.
    const result = buildMonthMovement({
      month: MONTH,
      starts: [start("cus_a", "2026-08-01T03:59:00.000Z")],
      cancellations: [],
      failedInvoices: [],
    });
    expect(result.totals.newSubscribers).toBe(0);
    expect(result.coverage.outOfMonthFactsIgnored).toBe(1);
  });

  test("three failed retries for one customer is one account in trouble", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [
        invoice("cus_a", "2026-08-10T12:00:00.000Z", "in_1"),
        invoice("cus_a", "2026-08-10T18:00:00.000Z", "in_2"),
        invoice("cus_a", "2026-08-10T22:00:00.000Z", "in_3"),
      ],
    });
    expect(dayOf(result, "2026-08-10").paymentFailures).toBe(1);
    expect(result.totals.paymentFailures).toBe(1);
    // The raw invoice count is still reported, so the dedupe is visible.
    expect(result.totals.failedInvoices).toBe(3);
  });

  test("a customer who failed a payment and then cancelled is one account lost", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [start("cus_a", "2026-08-20T12:00:00.000Z")],
      failedInvoices: [invoice("cus_a", "2026-08-20T09:00:00.000Z")],
    });
    const day = dayOf(result, "2026-08-20");
    expect(day.cancellations).toBe(1);
    expect(day.paymentFailures).toBe(1);
    expect(day.churned).toBe(1);
    expect(result.totals.churned).toBe(1);
  });

  test("the month total is distinct accounts, not the sum of the daily bars", () => {
    // One customer fails on two separate days. Two bars, one account.
    const result = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [
        invoice("cus_a", "2026-08-05T12:00:00.000Z", "in_1"),
        invoice("cus_a", "2026-08-12T12:00:00.000Z", "in_2"),
      ],
    });
    expect(dayOf(result, "2026-08-05").paymentFailures).toBe(1);
    expect(dayOf(result, "2026-08-12").paymentFailures).toBe(1);
    const summedBars = result.days.reduce((sum, day) => sum + day.paymentFailures, 0);
    expect(summedBars).toBe(2);
    expect(result.totals.paymentFailures).toBe(1);
  });

  test("net is arrivals minus distinct accounts lost", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [start("cus_a", "2026-08-02T12:00:00.000Z"), start("cus_b", "2026-08-03T12:00:00.000Z")],
      cancellations: [start("cus_c", "2026-08-04T12:00:00.000Z")],
      failedInvoices: [invoice("cus_c", "2026-08-05T12:00:00.000Z")],
    });
    expect(result.totals.newSubscribers).toBe(2);
    expect(result.totals.churned).toBe(1);
    expect(result.totals.net).toBe(1);
  });

  test("reports which source dated each arrival and departure", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [
        start("cus_a", "2026-08-02T12:00:00.000Z", "subscription_record"),
        start("cus_b", "2026-08-20T12:00:00.000Z", "stripe_event"),
      ],
      cancellations: [start("cus_c", "2026-08-21T12:00:00.000Z", "stripe_event")],
      failedInvoices: [],
    });
    expect(result.coverage.newBySource).toEqual({
      stripe_event: 1,
      subscription_record: 1,
    });
    expect(result.coverage.cancellationsBySource).toEqual({
      stripe_event: 1,
      subscription_record: 0,
    });
  });

  test("says so when the month reaches back before the webhook log", () => {
    const before = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      eventLogStartsOn: "2026-08-18",
    });
    expect(before.coverage.monthStartsBeforeEventLog).toBe(true);

    const after = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      eventLogStartsOn: "2026-07-01",
    });
    expect(after.coverage.monthStartsBeforeEventLog).toBe(false);
  });

  test("carries undatable cancellations through instead of dropping them", () => {
    const result = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      undatedCancellations: 7,
    });
    expect(result.coverage.undatedCancellations).toBe(7);
  });

  test("a short month ends on its own last day", () => {
    const february = buildMonthMovement({
      month: "2026-02",
      starts: [],
      cancellations: [],
      failedInvoices: [],
    });
    expect(february.days).toHaveLength(28);
    expect(february.days.at(-1)?.date).toBe("2026-02-28");
  });
});

describe("parseMovementMonth", () => {
  test("accepts a real Toronto month", () => {
    expect(parseMovementMonth("2026-08")).toBe("2026-08");
    expect(parseMovementMonth(" 2026-12 ")).toBe("2026-12");
  });

  test("rejects anything that is not one", () => {
    for (const value of ["2026-13", "2026-00", "2026", "26-08", "", null, 8, "2026-8"]) {
      expect(parseMovementMonth(value)).toBeNull();
    }
  });
});
