import { Prisma } from "@prisma/client";
import { normalizeCommandCostBucket } from "./cost-bucket";

export type CostMetricEntry = {
  category: string;
  amountMinor: Prisma.Decimal;
  currency: string;
};

export type RevenueMetricEntry = {
  amountPaidMinor: Prisma.Decimal;
  currency: string;
};

export function aggregateCostMetrics(
  costs: readonly CostMetricEntry[],
  revenue: readonly RevenueMetricEntry[],
) {
  const acquisition = new Map<string, Prisma.Decimal>();
  const delivery = new Map<string, Prisma.Decimal>();
  const revenueByCurrency = new Map<string, Prisma.Decimal>();

  for (const entry of revenue) {
    const currency = entry.currency.toLowerCase();
    revenueByCurrency.set(
      currency,
      (revenueByCurrency.get(currency) ?? new Prisma.Decimal(0)).add(
        entry.amountPaidMinor,
      ),
    );
  }
  for (const entry of costs) {
    const bucket = normalizeCommandCostBucket(entry.category);
    if (!bucket) continue;
    const currency = entry.currency.toLowerCase();
    const target = bucket === "delivery" ? delivery : acquisition;
    target.set(
      currency,
      (target.get(currency) ?? new Prisma.Decimal(0)).add(entry.amountMinor),
    );
  }

  const currencies = new Set([
    ...revenueByCurrency.keys(),
    ...acquisition.keys(),
    ...delivery.keys(),
  ]);
  return Object.fromEntries(
    [...currencies].sort().map((currency) => {
      const collected = revenueByCurrency.get(currency) ?? new Prisma.Decimal(0);
      const deliveryCost = delivery.get(currency) ?? new Prisma.Decimal(0);
      const acquisitionCost =
        acquisition.get(currency) ?? new Prisma.Decimal(0);
      const grossMarginPercent = collected.gt(0)
        ? collected
            .sub(deliveryCost)
            .div(collected)
            .mul(100)
            .toDecimalPlaces(4)
            .toString()
        : null;
      return [
        currency,
        {
          collectedMinor: collected.toFixed(0),
          acquisitionCostMinor: acquisitionCost.toFixed(0),
          deliveryCostMinor: deliveryCost.toFixed(0),
          grossProfitMinor: collected.sub(deliveryCost).toFixed(0),
          grossMarginPercent,
        },
      ];
    }),
  );
}
