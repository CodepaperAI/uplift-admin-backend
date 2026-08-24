import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  buildStripeLifecycle,
  carriesRealOccurrenceTime,
  isReconciliationEvent,
  RECONCILIATION_EVENT_TYPE,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_DELETED_EVENT,
  type LifecycleEvent,
} from "../command/stripe-lifecycle";

function event(input: {
  subscription: string;
  type: string;
  at: string;
  amount?: string;
  currency?: string | null;
  status?: string;
  customer?: string | null;
}): LifecycleEvent {
  return {
    stripeSubscriptionId: input.subscription,
    stripeCustomerId: input.customer ?? "cus_1",
    eventType: input.type,
    status: input.status ?? "active",
    monthlyRecurringMinor: new Prisma.Decimal(input.amount ?? "9900"),
    currency: input.currency === undefined ? "cad" : input.currency,
    occurredAt: new Date(input.at),
  };
}

const RANGE = { from: "2026-08-01", to: "2026-08-31" };

describe("event trust classification", () => {
  test("reconciliation snapshots are identified as sync-time rows", () => {
    expect(isReconciliationEvent(RECONCILIATION_EVENT_TYPE)).toBe(true);
    expect(isReconciliationEvent(SUBSCRIPTION_CREATED_EVENT)).toBe(false);
  });

  test("only Stripe's own subscription namespace carries a real time", () => {
    expect(carriesRealOccurrenceTime(SUBSCRIPTION_CREATED_EVENT)).toBe(true);
    expect(carriesRealOccurrenceTime(SUBSCRIPTION_DELETED_EVENT)).toBe(true);
    expect(carriesRealOccurrenceTime("customer.subscription.updated")).toBe(true);
    // A type Stripe has not invented yet must still be trusted.
    expect(carriesRealOccurrenceTime("customer.subscription.paused")).toBe(true);
    expect(carriesRealOccurrenceTime(RECONCILIATION_EVENT_TYPE)).toBe(false);
    expect(carriesRealOccurrenceTime("invoice.paid")).toBe(false);
  });
});

describe("buildStripeLifecycle", () => {
  test("counts a real created event on its Toronto day", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({
          subscription: "sub_a",
          type: SUBSCRIPTION_CREATED_EVENT,
          at: "2026-08-19T14:00:00.000Z",
        }),
      ],
    });
    const day = result.days.find((d) => d.date === "2026-08-19")!;
    expect(day.started.count).toBe(1);
    expect(day.started.mrrMinorByCurrency).toEqual({ cad: "9900.0000" });
    expect(result.totals.started.count).toBe(1);
  });

  test("a reconciliation snapshot never creates a start", () => {
    // This is the whole point of the module: a subscription that began in June
    // and was first seen by a sync run in August is not August new business.
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({
          subscription: "sub_old",
          type: RECONCILIATION_EVENT_TYPE,
          at: "2026-08-24T21:00:00.000Z",
        }),
      ],
    });
    expect(result.totals.started.count).toBe(0);
    expect(result.totals.started.mrrMinorByCurrency).toEqual({});
    expect(result.coverage.reconciliationOnlySubscriptions).toBe(1);
  });

  test("a subscription with both kinds still starts on the real event", () => {
    const result = buildStripeLifecycle({
      from: "2026-06-01",
      to: "2026-08-31",
      events: [
        event({
          subscription: "sub_b",
          type: SUBSCRIPTION_CREATED_EVENT,
          at: "2026-06-10T12:00:00.000Z",
        }),
        event({
          subscription: "sub_b",
          type: RECONCILIATION_EVENT_TYPE,
          at: "2026-08-24T21:00:00.000Z",
        }),
      ],
    });
    expect(result.days.find((d) => d.date === "2026-06-10")!.started.count).toBe(1);
    expect(result.days.find((d) => d.date === "2026-08-24")!.started.count).toBe(0);
    expect(result.coverage.reconciliationOnlySubscriptions).toBe(0);
  });

  test("a redelivered created event counts once", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_c", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-05T10:00:00.000Z" }),
        event({ subscription: "sub_c", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-05T10:00:03.000Z" }),
      ],
    });
    expect(result.totals.started.count).toBe(1);
    expect(result.totals.started.mrrMinorByCurrency).toEqual({ cad: "9900.0000" });
  });

  test("takes the earliest created event when deliveries straddle a day", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_d", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-07T02:00:00.000Z" }),
        event({ subscription: "sub_d", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-06T23:00:00.000Z" }),
      ],
    });
    // 2026-08-06T23:00Z is 19:00 on the 6th in Toronto.
    expect(result.days.find((d) => d.date === "2026-08-06")!.started.count).toBe(1);
    expect(result.days.find((d) => d.date === "2026-08-07")!.started.count).toBe(0);
  });

  test("counts a cancellation and the revenue it took with it", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_e", type: SUBSCRIPTION_DELETED_EVENT, at: "2026-08-20T16:00:00.000Z", status: "canceled" }),
      ],
    });
    const day = result.days.find((d) => d.date === "2026-08-20")!;
    expect(day.canceled.count).toBe(1);
    expect(day.canceled.mrrMinorByCurrency).toEqual({ cad: "9900.0000" });
  });

  test("a zero-amount cancellation falls back to the last known value", () => {
    // Stripe can report 0 once items are gone. Reporting churn of nothing would
    // understate lost revenue to zero, so state is taken from the prior row —
    // including a reconciliation row, which is trustworthy for state.
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_f", type: RECONCILIATION_EVENT_TYPE, at: "2026-08-10T00:00:00.000Z", amount: "14900" }),
        event({ subscription: "sub_f", type: SUBSCRIPTION_DELETED_EVENT, at: "2026-08-21T16:00:00.000Z", amount: "0", status: "canceled" }),
      ],
    });
    expect(
      result.days.find((d) => d.date === "2026-08-21")!.canceled.mrrMinorByCurrency,
    ).toEqual({ cad: "14900.0000" });
  });

  test("a zero cancellation with no prior value reports zero, not a guess", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_g", type: SUBSCRIPTION_DELETED_EVENT, at: "2026-08-21T16:00:00.000Z", amount: "0", status: "canceled" }),
      ],
    });
    const day = result.days.find((d) => d.date === "2026-08-21")!;
    expect(day.canceled.count).toBe(1);
    expect(day.canceled.mrrMinorByCurrency).toEqual({ cad: "0.0000" });
  });

  test("keeps currencies apart instead of adding them", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_h", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-12T12:00:00.000Z", currency: "cad", amount: "9900" }),
        event({ subscription: "sub_i", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-12T13:00:00.000Z", currency: "usd", amount: "8250" }),
      ],
    });
    expect(
      result.days.find((d) => d.date === "2026-08-12")!.started.mrrMinorByCurrency,
    ).toEqual({ cad: "9900.0000", usd: "8250.0000" });
    expect(result.totals.started.count).toBe(2);
  });

  test("a mixed-currency subscription is reported, not silently dropped", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_j", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-14T12:00:00.000Z", currency: null }),
      ],
    });
    const day = result.days.find((d) => d.date === "2026-08-14")!;
    expect(day.started.count).toBe(1);
    expect(day.started.mrrMinorByCurrency).toEqual({});
    expect(result.coverage.unbucketedCurrencyCount).toBe(1);
  });

  test("zero-fills every day in the range and excludes days outside it", () => {
    const result = buildStripeLifecycle({
      from: "2026-08-01",
      to: "2026-08-03",
      events: [
        event({ subscription: "sub_k", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-07-20T12:00:00.000Z" }),
        event({ subscription: "sub_l", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-02T12:00:00.000Z" }),
      ],
    });
    expect(result.days.map((d) => d.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(result.days.map((d) => d.started.count)).toEqual([0, 1, 0]);
    expect(result.totals.started.count).toBe(1);
  });

  test("buckets across the DST boundary in Toronto, not UTC", () => {
    // 2026-11-01T05:30Z is 01:30 EDT on Nov 1 before the fall-back; the naive
    // UTC date would also be Nov 1, so use a case where they differ instead:
    // 2026-03-08T04:30Z is 23:30 on Mar 7 in Toronto.
    const result = buildStripeLifecycle({
      from: "2026-03-01",
      to: "2026-03-31",
      events: [
        event({ subscription: "sub_m", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-03-08T04:30:00.000Z" }),
      ],
    });
    expect(result.days.find((d) => d.date === "2026-03-07")!.started.count).toBe(1);
    expect(result.days.find((d) => d.date === "2026-03-08")!.started.count).toBe(0);
  });

  test("reports how much of the live roster it can date", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_n", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-04T12:00:00.000Z" }),
        event({ subscription: "sub_o", type: RECONCILIATION_EVENT_TYPE, at: "2026-08-24T21:00:00.000Z" }),
      ],
      liveSubscriptionIds: ["sub_n", "sub_o", "sub_p"],
    });
    expect(result.coverage.liveSubscriptions).toBe(3);
    expect(result.coverage.liveWithCreatedEvent).toBe(1);
    expect(result.coverage.liveWithoutCreatedEvent).toBe(2);
    expect(result.coverage.reconciliationOnlySubscriptions).toBe(1);
  });

  test("says when the range reaches back before the event log begins", () => {
    const early = buildStripeLifecycle({
      from: "2026-01-01",
      to: "2026-08-31",
      events: [
        event({ subscription: "sub_q", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-15T12:00:00.000Z" }),
      ],
    });
    expect(early.coverage.eventLogStartsOn).toBe("2026-06-15");
    expect(early.coverage.rangeStartsBeforeEventLog).toBe(true);

    const inside = buildStripeLifecycle({
      from: "2026-07-01",
      to: "2026-08-31",
      events: [
        event({ subscription: "sub_r", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-06-15T12:00:00.000Z" }),
      ],
    });
    expect(inside.coverage.rangeStartsBeforeEventLog).toBe(false);
  });

  test("survives an empty event log without claiming coverage", () => {
    const result = buildStripeLifecycle({ ...RANGE, events: [] });
    expect(result.totals.started.count).toBe(0);
    expect(result.totals.canceled.count).toBe(0);
    expect(result.coverage.eventLogStartsOn).toBeNull();
    expect(result.coverage.rangeStartsBeforeEventLog).toBe(false);
    expect(result.days).toHaveLength(31);
  });

  test("a start and a cancellation on the same day both land", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_s", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-15T12:00:00.000Z" }),
        event({ subscription: "sub_t", type: SUBSCRIPTION_DELETED_EVENT, at: "2026-08-15T18:00:00.000Z", status: "canceled" }),
      ],
    });
    const day = result.days.find((d) => d.date === "2026-08-15")!;
    expect(day.started.count).toBe(1);
    expect(day.canceled.count).toBe(1);
  });

  test("one subscription started and cancelled in range counts in both", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_u", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-02T12:00:00.000Z" }),
        event({ subscription: "sub_u", type: SUBSCRIPTION_DELETED_EVENT, at: "2026-08-25T12:00:00.000Z", status: "canceled" }),
      ],
    });
    expect(result.totals.started.count).toBe(1);
    expect(result.totals.canceled.count).toBe(1);
  });
});

describe("coverage uses the caller's global created-event set", () => {
  test("a subscription created before the range still counts as datable", () => {
    // Without the global set this would report 0 datable, purely because the
    // creating event falls outside the window the reader asked about.
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [],
      liveSubscriptionIds: ["sub_old", "sub_unknown"],
      subscriptionIdsWithCreatedEvent: new Set(["sub_old"]),
    });
    expect(result.coverage.liveWithCreatedEvent).toBe(1);
    expect(result.coverage.liveWithoutCreatedEvent).toBe(1);
  });

  test("falls back to what it saw when the caller supplies nothing", () => {
    const result = buildStripeLifecycle({
      ...RANGE,
      events: [
        event({ subscription: "sub_v", type: SUBSCRIPTION_CREATED_EVENT, at: "2026-08-09T12:00:00.000Z" }),
      ],
      liveSubscriptionIds: ["sub_v", "sub_w"],
    });
    expect(result.coverage.liveWithCreatedEvent).toBe(1);
    expect(result.coverage.liveWithoutCreatedEvent).toBe(1);
  });
});
