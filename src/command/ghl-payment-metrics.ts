import { Prisma } from "@prisma/client";

export type GhlRevenueTransaction = {
  amount: Prisma.Decimal | null;
  amountRefunded: Prisma.Decimal | null;
  currency: string | null;
  status: string;
  providerSubscriptionId: string | null;
};

const SETTLED_STATUSES = new Set(["succeeded", "paid", "completed"]);

export function normalizeGhlPaymentStatus(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim().toLowerCase();
  }
  if (value && typeof value === "object") {
    for (const key of ["status", "value", "name"] as const) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim().toLowerCase();
      }
    }
  }
  return "unknown";
}

export function isSettledGhlPayment(status: string): boolean {
  return SETTLED_STATUSES.has(status.trim().toLowerCase());
}

export function aggregateGhlRevenue(
  transactions: readonly GhlRevenueTransaction[],
  knownStripeSubscriptionIds: ReadonlySet<string>,
) {
  const recurring = new Map<string, Prisma.Decimal>();
  const oneTime = new Map<string, Prisma.Decimal>();
  let excludedStripeDuplicates = 0;

  for (const transaction of transactions) {
    if (
      !transaction.amount ||
      !transaction.currency ||
      !isSettledGhlPayment(transaction.status)
    ) {
      continue;
    }
    if (
      transaction.providerSubscriptionId &&
      knownStripeSubscriptionIds.has(transaction.providerSubscriptionId)
    ) {
      excludedStripeDuplicates += 1;
      continue;
    }
    const currency = transaction.currency.toLowerCase();
    const net = transaction.amount.sub(
      transaction.amountRefunded ?? new Prisma.Decimal(0),
    );
    const target = transaction.providerSubscriptionId ? recurring : oneTime;
    target.set(
      currency,
      (target.get(currency) ?? new Prisma.Decimal(0)).add(net),
    );
  }

  const currencies = new Set([...recurring.keys(), ...oneTime.keys()]);
  return {
    excludedStripeDuplicates,
    byCurrency: Object.fromEntries(
      [...currencies].sort().map((currency) => {
        const recurringAmount =
          recurring.get(currency) ?? new Prisma.Decimal(0);
        const oneTimeAmount = oneTime.get(currency) ?? new Prisma.Decimal(0);
        return [
          currency,
          {
            recurring: recurringAmount.toString(),
            oneTime: oneTimeAmount.toString(),
            collected: recurringAmount.add(oneTimeAmount).toString(),
          },
        ];
      }),
    ),
  };
}
