import { Prisma } from "@prisma/client";
import { normalizeCommandCostBucket } from "./cost-bucket";

export type CostAnalyticsEntry = {
  category: string;
  costCategory: string;
  vendor: string;
  amountMinor: Prisma.Decimal;
  currency: string;
  occurredAt: Date;
};

export function commandMonthSequence(endMonth: string, count: number): string[] {
  if (!/^\d{4}-\d{2}$/.test(endMonth) || count < 1) {
    throw new Error("Cost analytics requires YYYY-MM and a positive count");
  }
  const [year, month] = endMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year!, month! - 1 - (count - 1 - index), 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function torontoMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

export function aggregateCostAnalytics(
  entries: readonly CostAnalyticsEntry[],
  months: readonly string[],
) {
  const monthSet = new Set(months);
  const trend = new Map<
    string,
    Map<string, { acquisition: Prisma.Decimal; delivery: Prisma.Decimal }>
  >();
  const breakdown = new Map<
    string,
    Map<string, { category: string; vendor: string; bucket: string; amount: Prisma.Decimal }>
  >();
  const selectedMonth = months.at(-1);

  for (const entry of entries) {
    const month = torontoMonth(entry.occurredAt);
    if (!monthSet.has(month)) continue;
    const currency = entry.currency.toLowerCase();
    const byMonth = trend.get(currency) ?? new Map();
    const point = byMonth.get(month) ?? {
      acquisition: new Prisma.Decimal(0),
      delivery: new Prisma.Decimal(0),
    };
    const bucket = normalizeCommandCostBucket(entry.category);
    if (!bucket) continue;
    point[bucket] = point[bucket].add(entry.amountMinor);
    byMonth.set(month, point);
    trend.set(currency, byMonth);

    if (month === selectedMonth) {
      const byDimension = breakdown.get(currency) ?? new Map();
      const key = `${bucket}\u0000${entry.costCategory}\u0000${entry.vendor}`;
      const item = byDimension.get(key) ?? {
        category: entry.costCategory,
        vendor: entry.vendor,
        bucket,
        amount: new Prisma.Decimal(0),
      };
      item.amount = item.amount.add(entry.amountMinor);
      byDimension.set(key, item);
      breakdown.set(currency, byDimension);
    }
  }

  const currencies = new Set([...trend.keys(), ...breakdown.keys()]);
  return Object.fromEntries(
    [...currencies].sort().map((currency) => {
      const byMonth = trend.get(currency) ?? new Map();
      const dimensions = [...(breakdown.get(currency)?.values() ?? [])]
        .sort((left, right) => right.amount.comparedTo(left.amount))
        .map(({ amount, ...item }) => ({
          ...item,
          amountMinor: amount.toString(),
        }));
      return [
        currency,
        {
          trend: months.map((month) => {
            const point = byMonth.get(month) ?? {
              acquisition: new Prisma.Decimal(0),
              delivery: new Prisma.Decimal(0),
            };
            return {
              month,
              acquisitionMinor: point.acquisition.toString(),
              deliveryMinor: point.delivery.toString(),
              totalMinor: point.acquisition.add(point.delivery).toString(),
            };
          }),
          breakdown: dimensions,
        },
      ];
    }),
  );
}
