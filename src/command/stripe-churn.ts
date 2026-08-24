import { Prisma } from "@prisma/client";

export type StripeMovementFact = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  status: string;
  pauseCollectionBehavior: string | null;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
  occurredAt: Date;
};

function isLive(fact: StripeMovementFact | undefined): boolean {
  return Boolean(
    fact &&
      fact.pauseCollectionBehavior === null &&
      ["trialing", "active", "past_due"].includes(fact.status),
  );
}

function addBucket(
  buckets: Map<string, Prisma.Decimal>,
  fact: StripeMovementFact,
): void {
  if (!fact.currency) return;
  buckets.set(
    fact.currency,
    (buckets.get(fact.currency) ?? new Prisma.Decimal(0)).add(
      fact.monthlyRecurringMinor,
    ),
  );
}

function serializeBuckets(
  buckets: Map<string, Prisma.Decimal>,
): Record<string, string> {
  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => [currency, amount.toFixed(4)]),
  );
}

export function aggregateStripeMonthlyMovement(
  facts: readonly StripeMovementFact[],
  period: { start: Date; end: Date },
) {
  const bySubscription = new Map<string, StripeMovementFact[]>();
  for (const fact of facts) {
    const list = bySubscription.get(fact.stripeSubscriptionId) ?? [];
    list.push(fact);
    bySubscription.set(fact.stripeSubscriptionId, list);
  }

  const openingMrr = new Map<string, Prisma.Decimal>();
  const churnedMrr = new Map<string, Prisma.Decimal>();
  const newMrr = new Map<string, Prisma.Decimal>();
  const openingAccounts = new Set<string>();
  const retainedOpeningAccounts = new Set<string>();
  const canceledOpeningAccounts = new Set<string>();

  for (const subscriptionFacts of bySubscription.values()) {
    const ordered = [...subscriptionFacts].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    const opening = ordered.filter((fact) => fact.occurredAt < period.start).at(-1);
    const closing = ordered.filter((fact) => fact.occurredAt < period.end).at(-1);
    const first = ordered[0];

    if (isLive(opening)) {
      addBucket(openingMrr, opening!);
      if (opening!.stripeCustomerId) openingAccounts.add(opening!.stripeCustomerId);
      if (closing?.status === "canceled") {
        addBucket(churnedMrr, opening!);
        if (opening!.stripeCustomerId) canceledOpeningAccounts.add(opening!.stripeCustomerId);
      } else if (closing && (isLive(closing) || closing.pauseCollectionBehavior !== null)) {
        if (opening!.stripeCustomerId) retainedOpeningAccounts.add(opening!.stripeCustomerId);
      }
    }

    if (
      first &&
      first.occurredAt >= period.start &&
      first.occurredAt < period.end &&
      isLive(closing)
    ) {
      addBucket(newMrr, closing!);
    }
  }

  const churnedAccounts = [...openingAccounts].filter(
    (customerId) =>
      canceledOpeningAccounts.has(customerId) &&
      !retainedOpeningAccounts.has(customerId),
  ).length;
  const revenueChurnPercentByCurrency = Object.fromEntries(
    [...openingMrr.entries()].map(([currency, opening]) => {
      const churned = churnedMrr.get(currency) ?? new Prisma.Decimal(0);
      return [
        currency,
        opening.eq(0) ? null : churned.mul(100).div(opening).toFixed(2),
      ];
    }),
  );

  return {
    openingMrrMinorByCurrency: serializeBuckets(openingMrr),
    newMrrMinorByCurrency: serializeBuckets(newMrr),
    churnedMrrMinorByCurrency: serializeBuckets(churnedMrr),
    revenueChurnPercentByCurrency,
    openingAccounts: openingAccounts.size,
    churnedAccounts,
    logoChurnPercent:
      openingAccounts.size === 0
        ? null
        : new Prisma.Decimal(churnedAccounts)
            .mul(100)
            .div(openingAccounts.size)
            .toFixed(2),
  };
}
