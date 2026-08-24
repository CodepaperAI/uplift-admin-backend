import { Prisma } from "@prisma/client";

export type StripeSubscriptionMetricFact = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  userId: string | null;
  businessId: string | null;
  status: string;
  pauseCollectionBehavior: string | null;
  monthlyRecurringMinor: Prisma.Decimal;
  currency: string | null;
};

export type StripeInvoiceMetricFact = {
  amountPaidMinor: Prisma.Decimal;
  currency: string;
  status: string;
  paidAt: Date | null;
};

const MRR_STATUSES = new Set(["trialing", "active", "past_due"]);

export function isMrrEligibleSubscription(
  fact: Pick<
    StripeSubscriptionMetricFact,
    "status" | "pauseCollectionBehavior"
  >,
): boolean {
  return (
    MRR_STATUSES.has(fact.status) && fact.pauseCollectionBehavior === null
  );
}

export function aggregateStripeSubscriberCounts(
  facts: readonly StripeSubscriptionMetricFact[],
  settledSubscriptionIds: ReadonlySet<string>,
) {
  const live = facts.filter((fact) => MRR_STATUSES.has(fact.status));
  return {
    accounts: new Set(
      live.flatMap((fact) =>
        fact.stripeCustomerId ? [fact.stripeCustomerId] : [],
      ),
    ).size,
    subscriptions: live.length,
    paying: live.filter(
      (fact) =>
        fact.status !== "trialing" &&
        fact.pauseCollectionBehavior === null &&
        settledSubscriptionIds.has(fact.stripeSubscriptionId),
    ).length,
    trialing: live.filter((fact) => fact.status === "trialing").length,
    pastDue: live.filter((fact) => fact.status === "past_due").length,
    paused: live.filter((fact) => fact.pauseCollectionBehavior !== null).length,
  };
}

export function aggregateStripeMrr(
  facts: readonly StripeSubscriptionMetricFact[],
): {
  byCurrency: Record<string, string>;
  arrByCurrency: Record<string, string>;
} {
  const totals = new Map<string, Prisma.Decimal>();

  for (const fact of facts) {
    if (!isMrrEligibleSubscription(fact) || !fact.currency) continue;
    const currency = fact.currency.toLowerCase();
    totals.set(
      currency,
      (totals.get(currency) ?? new Prisma.Decimal(0)).add(
        fact.monthlyRecurringMinor,
      ),
    );
  }

  const byCurrency = Object.fromEntries(
    [...totals.entries()].map(([currency, amount]) => [
      currency,
      amount.toDecimalPlaces(4).toString(),
    ]),
  );
  const arrByCurrency = Object.fromEntries(
    [...totals.entries()].map(([currency, amount]) => [
      currency,
      amount.mul(12).toDecimalPlaces(4).toString(),
    ]),
  );
  return { byCurrency, arrByCurrency };
}

export function aggregatePaidToDate(
  facts: readonly StripeInvoiceMetricFact[],
): Record<string, string> {
  const totals = new Map<string, Prisma.Decimal>();

  for (const fact of facts) {
    if (fact.status !== "paid" || fact.paidAt === null) continue;
    const currency = fact.currency.toLowerCase();
    totals.set(
      currency,
      (totals.get(currency) ?? new Prisma.Decimal(0)).add(
        fact.amountPaidMinor,
      ),
    );
  }

  return Object.fromEntries(
    [...totals.entries()].map(([currency, amount]) => [
      currency,
      amount.toDecimalPlaces(0).toString(),
    ]),
  );
}
