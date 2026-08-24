import { Prisma } from "@prisma/client";
import { normalizeCommandCostBucket } from "./cost-bucket";

export type UnitEconomicsCostGroup = {
  category: string;
  currency: string;
  amountMinor: Prisma.Decimal;
};

export function aggregateCommandUnitEconomics(input: {
  collectedMinorByCurrency: Readonly<Record<string, string>>;
  costs: readonly UnitEconomicsCostGroup[];
}) {
  const collected = new Map(
    Object.entries(input.collectedMinorByCurrency).map(([currency, amount]) => [
      currency.toLowerCase(),
      new Prisma.Decimal(amount),
    ]),
  );
  const acquisition = new Map<string, Prisma.Decimal>();
  const delivery = new Map<string, Prisma.Decimal>();
  for (const cost of input.costs) {
    const bucket = normalizeCommandCostBucket(cost.category);
    if (!bucket) continue;
    const currency = cost.currency.toLowerCase();
    const target = bucket === "delivery" ? delivery : acquisition;
    target.set(
      currency,
      (target.get(currency) ?? new Prisma.Decimal(0)).add(cost.amountMinor),
    );
  }
  const currencies = new Set([
    ...collected.keys(),
    ...acquisition.keys(),
    ...delivery.keys(),
  ]);
  return Object.fromEntries(
    [...currencies].sort().map((currency) => {
      const revenue = collected.get(currency) ?? new Prisma.Decimal(0);
      const deliveryCost = delivery.get(currency) ?? new Prisma.Decimal(0);
      const acquisitionCost =
        acquisition.get(currency) ?? new Prisma.Decimal(0);
      const grossProfit = revenue.sub(deliveryCost);
      return [
        currency,
        {
          collectedMinor: revenue.toString(),
          acquisitionCostMinor: acquisitionCost.toString(),
          deliveryCostMinor: deliveryCost.toString(),
          grossProfitMinor: grossProfit.toString(),
          grossMarginPercent: revenue.eq(0)
            ? null
            : grossProfit.div(revenue).mul(100).toFixed(2),
        },
      ];
    }),
  );
}
