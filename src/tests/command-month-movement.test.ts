import { describe, expect, test } from "bun:test";
import {
  buildChurnCallList,
  buildMonthMovement,
  buildMovementHistory,
  commandMonthSpan,
  earliestFactMonth,
  parseMovementMonth,
  type ChurnIdentity,
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

describe("commandMonthSpan", () => {
  test("lists every month inclusive, oldest first", () => {
    expect(commandMonthSpan("2026-03", "2026-08")).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
  });

  test("a single month is a span of one", () => {
    expect(commandMonthSpan("2026-08", "2026-08")).toEqual(["2026-08"]);
  });

  test("crosses a year boundary", () => {
    expect(commandMonthSpan("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  test("refuses a backwards or absurd range", () => {
    expect(() => commandMonthSpan("2026-08", "2026-03")).toThrow();
    expect(() => commandMonthSpan("2010-01", "2026-08")).toThrow();
    expect(() => commandMonthSpan("2026-13", "2026-14")).toThrow();
  });
});

describe("buildMovementHistory", () => {
  const RANGE = { from: "2026-03", to: "2026-08" };

  test("gives every month in the span a row, including the empty ones", () => {
    const result = buildMovementHistory({ ...RANGE, starts: [], cancellations: [], failedInvoices: [] });
    expect(result.months.map((m) => m.month)).toEqual([
      "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08",
    ]);
    expect(result.totals.newSubscribers).toBe(0);
  });

  test("buckets arrivals into their Toronto month", () => {
    const result = buildMovementHistory({
      ...RANGE,
      // 03:59Z on 1 August is still July in Toronto.
      starts: [
        start("cus_a", "2026-08-01T03:59:00.000Z"),
        start("cus_b", "2026-08-01T04:00:00.000Z"),
      ],
      cancellations: [],
      failedInvoices: [],
    });
    const july = result.months.find((m) => m.month === "2026-07")!;
    const august = result.months.find((m) => m.month === "2026-08")!;
    expect(july.newSubscribers).toBe(1);
    expect(august.newSubscribers).toBe(1);
  });

  test("a failure early in the month and a cancellation later is one account lost", () => {
    // This is why the monthly series cannot be a roll-up of the daily bars:
    // summing two days would report two losses for one customer.
    const result = buildMovementHistory({
      ...RANGE,
      starts: [],
      cancellations: [start("cus_a", "2026-08-20T12:00:00.000Z")],
      failedInvoices: [invoice("cus_a", "2026-08-05T12:00:00.000Z")],
    });
    const august = result.months.find((m) => m.month === "2026-08")!;
    expect(august.cancellations).toBe(1);
    expect(august.paymentFailures).toBe(1);
    expect(august.churned).toBe(1);
    expect(august.net).toBe(-1);
  });

  test("the same account arriving in two months counts in each, once overall", () => {
    const result = buildMovementHistory({
      ...RANGE,
      starts: [
        start("cus_a", "2026-06-10T12:00:00.000Z"),
        start("cus_a", "2026-07-10T12:00:00.000Z"),
      ],
      cancellations: [],
      failedInvoices: [],
    });
    expect(result.months.find((m) => m.month === "2026-06")!.newSubscribers).toBe(1);
    expect(result.months.find((m) => m.month === "2026-07")!.newSubscribers).toBe(1);
    // Distinct across the span, so the header cannot double-count them.
    expect(result.totals.newSubscribers).toBe(1);
  });

  test("facts outside the span are left out entirely", () => {
    const result = buildMovementHistory({
      ...RANGE,
      starts: [start("cus_old", "2026-01-10T12:00:00.000Z"), start("cus_a", "2026-05-10T12:00:00.000Z")],
      cancellations: [],
      failedInvoices: [],
    });
    expect(result.totals.newSubscribers).toBe(1);
    expect(result.months.reduce((sum, m) => sum + m.newSubscribers, 0)).toBe(1);
  });

  test("net per month can be negative and is reported that way", () => {
    const result = buildMovementHistory({
      ...RANGE,
      starts: [start("cus_a", "2026-04-02T12:00:00.000Z")],
      cancellations: [
        start("cus_b", "2026-04-03T12:00:00.000Z"),
        start("cus_c", "2026-04-04T12:00:00.000Z"),
      ],
      failedInvoices: [],
    });
    expect(result.months.find((m) => m.month === "2026-04")!.net).toBe(-1);
  });
});

describe("earliestFactMonth", () => {
  test("finds the oldest month present", () => {
    expect(
      earliestFactMonth([
        start("cus_a", "2026-06-10T12:00:00.000Z"),
        start("cus_b", "2026-03-04T12:00:00.000Z"),
        start("cus_c", "2026-08-01T12:00:00.000Z"),
      ]),
    ).toBe("2026-03");
  });

  test("no facts means no month to start from", () => {
    expect(earliestFactMonth([])).toBeNull();
  });
});


describe("per-month signups and revenue", () => {
  const range = { from: "2026-07", to: "2026-08" };
  const monthOf = (
    result: ReturnType<typeof buildMovementHistory>,
    month: string,
  ) => result.months.find((row) => row.month === month)!;

  test("signups are counted per account created, not per distinct account", () => {
    // Deliberately the opposite rule from the churn buckets: two accounts on
    // one day are two signups, where three failed retries are one customer.
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      signups: [
        { at: new Date("2026-08-03T12:00:00Z") },
        { at: new Date("2026-08-03T18:00:00Z") },
        { at: new Date("2026-07-11T09:00:00Z") },
      ],
    });
    expect(monthOf(history, "2026-08").signups).toBe(2);
    expect(monthOf(history, "2026-07").signups).toBe(1);
  });

  test("a month with no signups reports nought rather than being absent", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      signups: [{ at: new Date("2026-08-03T12:00:00Z") }],
    });
    expect(monthOf(history, "2026-07").signups).toBe(0);
    expect(monthOf(history, "2026-07").collectedMinorByCurrency).toEqual({});
  });

  test("collected is summed per currency and never across them", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "usd", amountMinor: "14900" },
        { at: new Date("2026-08-20T12:00:00Z"), currency: "usd", amountMinor: "9900" },
        { at: new Date("2026-08-21T12:00:00Z"), currency: "cad", amountMinor: "9900" },
        { at: new Date("2026-07-02T12:00:00Z"), currency: "usd", amountMinor: "100" },
      ],
    });
    expect(monthOf(history, "2026-08").collectedMinorByCurrency).toEqual({
      cad: "9900",
      usd: "24800",
    });
    expect(monthOf(history, "2026-07").collectedMinorByCurrency).toEqual({
      usd: "100",
    });
  });

  test("currency case does not split a bucket", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "USD", amountMinor: "100" },
        { at: new Date("2026-08-05T12:00:00Z"), currency: "usd", amountMinor: "100" },
      ],
    });
    expect(monthOf(history, "2026-08").collectedMinorByCurrency).toEqual({ usd: "200" });
  });

  test("a malformed amount costs its own row, not the month", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "usd", amountMinor: "oops" },
        { at: new Date("2026-08-05T12:00:00Z"), currency: "usd", amountMinor: "500" },
      ],
    });
    expect(monthOf(history, "2026-08").collectedMinorByCurrency).toEqual({ usd: "500" });
  });

  test("GHL is converted from major units before it is added to Stripe", () => {
    // The error this guards against is a hundredfold one: GHL reports 750.00
    // where Stripe reports 75000, and adding them raw would understate the
    // month by almost the whole GHL amount.
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "usd", amountMinor: "14900" },
      ],
      ghlCollected: [
        { at: new Date("2026-08-06T12:00:00Z"), currency: "usd", amountMajor: "750" },
      ],
    });
    const august = monthOf(history, "2026-08");
    expect(august.collectedMinorByCurrency).toEqual({ usd: "14900" });
    expect(august.ghlCollectedMinorByCurrency).toEqual({ usd: "75000" });
    expect(august.collectedWithGhlMinorByCurrency).toEqual({ usd: "89900" });
  });

  test("a half-dollar GHL amount converts exactly", () => {
    // The real August figure was CAD 4,498.50, so the fractional case is the
    // normal one, not an edge case.
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      ghlCollected: [
        { at: new Date("2026-08-06T12:00:00Z"), currency: "cad", amountMajor: "4498.5" },
      ],
    });
    expect(monthOf(history, "2026-08").ghlCollectedMinorByCurrency).toEqual({
      cad: "449850",
    });
  });

  test("a currency present in only one system still reports", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "usd", amountMinor: "100" },
      ],
      ghlCollected: [
        { at: new Date("2026-08-06T12:00:00Z"), currency: "cad", amountMajor: "1" },
      ],
    });
    // Side by side, not added: there is no exchange rate here to invent.
    expect(monthOf(history, "2026-08").collectedWithGhlMinorByCurrency).toEqual({
      cad: "100",
      usd: "100",
    });
  });

  test("an amount finer than the currency's minor unit is skipped and counted", () => {
    // Rounding it would make a revenue figure wrong in a way nobody would spot.
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      ghlCollected: [
        { at: new Date("2026-08-06T12:00:00Z"), currency: "usd", amountMajor: "100.0001" },
        { at: new Date("2026-08-07T12:00:00Z"), currency: "usd", amountMajor: "5" },
      ],
    });
    expect(history.ghlAmountsSkipped).toBe(1);
    expect(monthOf(history, "2026-08").ghlCollectedMinorByCurrency).toEqual({
      usd: "500",
    });
  });

  test("with no GHL at all, combined equals Stripe", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      collected: [
        { at: new Date("2026-08-04T12:00:00Z"), currency: "usd", amountMinor: "14900" },
      ],
    });
    const august = monthOf(history, "2026-08");
    expect(august.ghlCollectedMinorByCurrency).toEqual({});
    expect(august.collectedWithGhlMinorByCurrency).toEqual(
      august.collectedMinorByCurrency,
    );
    expect(history.ghlAmountsSkipped).toBe(0);
  });

  test("months outside the range are ignored on both new fields", () => {
    const history = buildMovementHistory({
      ...range,
      starts: [],
      cancellations: [],
      failedInvoices: [],
      signups: [{ at: new Date("2026-03-01T12:00:00Z") }],
      collected: [
        { at: new Date("2026-03-01T12:00:00Z"), currency: "usd", amountMinor: "999" },
      ],
    });
    expect(history.months.every((row) => row.signups === 0)).toBe(true);
    expect(
      history.months.every(
        (row) => Object.keys(row.collectedMinorByCurrency).length === 0,
      ),
    ).toBe(true);
  });
});

describe("buildChurnCallList", () => {
  const identities = new Map<string, ChurnIdentity>([
    [
      "cus:a",
      {
        stripeCustomerId: "cus_a",
        name: "Ramesh Patel",
        email: "ramesh@example.invalid",
        phone: "+14165550101",
        businessName: "Patel Realty",
        planName: "Core + Social",
        mrrMinor: "14900",
        currency: "usd",
      },
    ],
    ["cus:b", { name: "Simran Kaur", mrrMinor: "9900", currency: "usd" }],
    [
      "cus:c",
      {
        name: "Daljit Sandhu",
        // No personal number on file; the business line is the fallback, and
        // the list has to say which it is so a rep is not surprised by a
        // receptionist.
        phone: "+16045550199",
        phoneSource: "business",
        businessName: "Sandhu Autos",
        mrrMinor: "5000",
        currency: "usd",
      },
    ],
  ]);

  function failed(
    account: string,
    at: string,
    remaining: string | null = "9900",
    id = `in_${account}_${at}`,
  ): FailedInvoiceFact {
    return {
      accountKey: account,
      stripeInvoiceId: id,
      at: new Date(at),
      amountRemainingMinor: remaining,
      currency: "usd",
    };
  }

  test("a cancellation and a failed payment on one account is one row", () => {
    // The row a rep should call first: a card that failed and then a
    // cancellation is usually a billing problem, not a decision.
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [start("cus:a", "2026-08-20T10:00:00Z")],
      failedInvoices: [failed("cus:a", "2026-08-17T10:00:00Z")],
      identities,
    });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.reason).toBe("both");
    expect(list.rows[0]?.name).toBe("Ramesh Patel");
    expect(list.rows[0]?.phone).toBe("+14165550101");
    expect(list.totals).toEqual({
      cancelled: 0,
      paymentFailed: 0,
      both: 1,
      accounts: 1,
    });
  });

  test("three failed retries are one person to ring", () => {
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [],
      failedInvoices: [
        failed("cus:b", "2026-08-10T10:00:00Z", "9900", "in_1"),
        failed("cus:b", "2026-08-13T10:00:00Z", "9900", "in_2"),
        failed("cus:b", "2026-08-16T10:00:00Z", "9900", "in_3"),
      ],
      identities,
    });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.failedInvoiceCount).toBe(3);
    // The retries are separate invoices, so the outstanding total is their sum.
    expect(list.rows[0]?.amountOutstandingMinor).toBe("29700");
    expect(list.rows[0]?.outstandingCurrency).toBe("usd");
  });

  test("the earliest event in the month is when the trouble started", () => {
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [
        start("cus:a", "2026-08-25T10:00:00Z"),
        start("cus:a", "2026-08-06T10:00:00Z"),
      ],
      failedInvoices: [],
      identities,
    });
    expect(list.rows[0]?.cancelledAt).toBe("2026-08-06T10:00:00.000Z");
  });

  test("the list is ordered by what is being lost, biggest first", () => {
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [
        start("cus:b", "2026-08-05T10:00:00Z"),
        start("cus:a", "2026-08-06T10:00:00Z"),
      ],
      failedInvoices: [],
      identities,
    });
    expect(list.rows.map((row) => row.accountKey)).toEqual(["cus:a", "cus:b"]);
  });

  test("an account with no identity is still listed", () => {
    // Dropping it would make the list disagree with the count beside it, and a
    // Stripe customer id is enough to look someone up.
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [start("cus:unknown", "2026-08-05T10:00:00Z")],
      failedInvoices: [],
      identities,
    });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.accountKey).toBe("cus:unknown");
    expect(list.rows[0]?.name).toBeUndefined();
  });

  test("a business line is carried with its source, not passed off as personal", () => {
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [start("cus:c", "2026-08-05T10:00:00Z")],
      failedInvoices: [],
      identities,
    });
    expect(list.rows[0]?.phone).toBe("+16045550199");
    expect(list.rows[0]?.phoneSource).toBe("business");
  });

  test("events outside the month do not reach the list", () => {
    const list = buildChurnCallList({
      month: MONTH,
      cancellations: [start("cus:a", "2026-07-31T10:00:00Z")],
      failedInvoices: [failed("cus:b", "2026-09-01T10:00:00Z")],
      identities,
    });
    expect(list.rows).toHaveLength(0);
    expect(list.totals.accounts).toBe(0);
  });

  test("the row count matches the churn count for the same facts", () => {
    // The guarantee that makes the list trustworthy: it is the same accounts
    // the tile counts, so "43 cancelled" and 43 rows cannot drift apart.
    const cancellations = [
      start("cus:a", "2026-08-05T10:00:00Z"),
      start("cus:b", "2026-08-07T10:00:00Z"),
    ];
    const failedInvoices = [failed("cus:b", "2026-08-06T10:00:00Z")];
    const movement = buildMonthMovement({
      month: MONTH,
      starts: [],
      cancellations,
      failedInvoices,
    });
    const list = buildChurnCallList({
      month: MONTH,
      cancellations,
      failedInvoices,
      identities,
    });
    expect(list.rows).toHaveLength(movement.totals.churned);
  });
});
