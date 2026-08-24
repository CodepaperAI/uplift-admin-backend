import { describe, expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { aggregateStripeMonthlyMovement } from "../command/stripe-churn";
import { aggregatePipelineSourceConversion } from "../command/pipeline-metrics";

describe("Command production-volume shaping", () => {
  test("processes 5,000 subscriptions and 50,000 lead outcomes under two seconds", () => {
    const period = {
      start: new Date("2026-08-01T04:00:00.000Z"),
      end: new Date("2026-09-01T04:00:00.000Z"),
    };
    const subscriptionFacts = Array.from({ length: 5_000 }, (_, index) => [
      {
        stripeSubscriptionId: `sub_${index}`,
        stripeCustomerId: `cus_${Math.floor(index / 2)}`,
        status: "active",
        pauseCollectionBehavior: null,
        monthlyRecurringMinor: new Prisma.Decimal(9_900),
        currency: "cad",
        occurredAt: new Date("2026-07-15T12:00:00.000Z"),
      },
      {
        stripeSubscriptionId: `sub_${index}`,
        stripeCustomerId: `cus_${Math.floor(index / 2)}`,
        status: index % 20 === 0 ? "canceled" : "active",
        pauseCollectionBehavior: null,
        monthlyRecurringMinor: new Prisma.Decimal(9_900),
        currency: "cad",
        occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      },
    ]).flat();
    const leadOutcomes = Array.from({ length: 50_000 }, (_, index) => ({
      source: `source_${index % 20}`,
      status: index % 8 === 0 ? "won" : index % 5 === 0 ? "lost" : "open",
      count: 1,
    }));

    const startedAt = performance.now();
    const movement = aggregateStripeMonthlyMovement(subscriptionFacts, period);
    const sources = aggregatePipelineSourceConversion(leadOutcomes);
    const elapsedMs = performance.now() - startedAt;

    expect(movement.openingAccounts).toBe(2_500);
    expect(sources).toHaveLength(20);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
