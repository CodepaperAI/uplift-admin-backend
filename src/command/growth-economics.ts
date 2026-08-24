import { Prisma } from "@prisma/client";

export type GrowthEconomicsBucket = {
  mrrMinor: Prisma.Decimal;
  collectedMinor: Prisma.Decimal;
  acquisitionCostMinor: Prisma.Decimal;
  deliveryCostMinor: Prisma.Decimal;
  salesCashMinor: Prisma.Decimal;
  liveAccounts: number;
  newCustomers: number;
};

export type RevenueChurnMovement = {
  openingMrrMinorByCurrency: Readonly<Record<string, string>>;
  churnedMrrMinorByCurrency: Readonly<Record<string, string>>;
};

export type TrailingRevenueChurn = {
  openingMrrMinorByCurrency: Record<string, string>;
  churnedMrrMinorByCurrency: Record<string, string>;
  revenueChurnPercentByCurrency: Record<string, string | null>;
};

function exact(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toString();
}

export function aggregateTrailingRevenueChurn(
  movements: readonly RevenueChurnMovement[],
): TrailingRevenueChurn {
  const opening = new Map<string, Prisma.Decimal>();
  const churned = new Map<string, Prisma.Decimal>();
  for (const movement of movements) {
    for (const [currency, amount] of Object.entries(
      movement.openingMrrMinorByCurrency,
    )) {
      opening.set(
        currency,
        (opening.get(currency) ?? new Prisma.Decimal(0)).add(amount),
      );
    }
    for (const [currency, amount] of Object.entries(
      movement.churnedMrrMinorByCurrency,
    )) {
      churned.set(
        currency,
        (churned.get(currency) ?? new Prisma.Decimal(0)).add(amount),
      );
    }
  }
  const currencies = new Set([...opening.keys(), ...churned.keys()]);
  return {
    openingMrrMinorByCurrency: Object.fromEntries(
      [...currencies].sort().map((currency) => [
        currency,
        exact(opening.get(currency) ?? new Prisma.Decimal(0)),
      ]),
    ),
    churnedMrrMinorByCurrency: Object.fromEntries(
      [...currencies].sort().map((currency) => [
        currency,
        exact(churned.get(currency) ?? new Prisma.Decimal(0)),
      ]),
    ),
    revenueChurnPercentByCurrency: Object.fromEntries(
      [...currencies].sort().map((currency) => {
        const openingAmount = opening.get(currency) ?? new Prisma.Decimal(0);
        const churnedAmount = churned.get(currency) ?? new Prisma.Decimal(0);
        return [
          currency,
          openingAmount.gt(0)
            ? churnedAmount.mul(100).div(openingAmount).toFixed(4)
            : null,
        ];
      }),
    ),
  };
}

export function calculateGrowthEconomics(
  buckets: Readonly<Record<string, GrowthEconomicsBucket>>,
  trailingRevenueChurnPercentByCurrency: Readonly<
    Record<string, string | null>
  >,
) {
  return Object.fromEntries(
    Object.entries(buckets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, bucket]) => {
        const salesAndAcquisition = bucket.salesCashMinor.add(
          bucket.acquisitionCostMinor,
        );
        const cac =
          bucket.newCustomers > 0
            ? salesAndAcquisition.div(bucket.newCustomers)
            : null;
        const grossProfit = bucket.collectedMinor.sub(bucket.deliveryCostMinor);
        const grossMargin = bucket.collectedMinor.gt(0)
          ? grossProfit.div(bucket.collectedMinor)
          : null;
        const arpu =
          bucket.liveAccounts > 0
            ? bucket.mrrMinor.div(bucket.liveAccounts)
            : null;
        const trailingRevenueChurnPercent =
          trailingRevenueChurnPercentByCurrency[currency] ?? null;
        const churn = trailingRevenueChurnPercent
          ? new Prisma.Decimal(trailingRevenueChurnPercent).div(100)
          : null;
        const ltv =
          arpu && grossMargin && churn?.gt(0)
            ? arpu.mul(grossMargin).div(churn)
            : null;
        return [
          currency,
          {
            liveAccounts: bucket.liveAccounts,
            newCustomers: bucket.newCustomers,
            salesCashMinor: exact(bucket.salesCashMinor),
            acquisitionCostMinor: exact(bucket.acquisitionCostMinor),
            cacMinor: cac ? exact(cac) : null,
            monthlyArpuMinor: arpu ? exact(arpu) : null,
            trailingRevenueChurnPercent,
            ltvMinor: ltv ? exact(ltv) : null,
            ltvToCac: ltv && cac?.gt(0) ? ltv.div(cac).toFixed(2) : null,
            blockers: [
              ...(bucket.newCustomers === 0 ? ["no_new_customers"] : []),
              ...(bucket.liveAccounts === 0 ? ["no_live_accounts"] : []),
              ...(!grossMargin ? ["no_gross_margin"] : []),
              ...(!churn?.gt(0)
                ? ["no_positive_trailing_revenue_churn"]
                : []),
            ],
          },
        ];
      }),
  );
}
