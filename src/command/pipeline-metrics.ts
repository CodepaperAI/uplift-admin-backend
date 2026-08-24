import { Prisma } from "@prisma/client";

export type PipelineSourceStatusCount = {
  source: string | null;
  status: string;
  count: number;
};

export function aggregatePipelineSourceConversion(
  rows: readonly PipelineSourceStatusCount[],
) {
  const totals = new Map<string, { leads: number; won: number; lost: number }>();
  for (const row of rows) {
    const source = row.source?.trim() || "Unattributed";
    const current = totals.get(source) ?? { leads: 0, won: 0, lost: 0 };
    current.leads += row.count;
    if (row.status.toLowerCase() === "won") current.won += row.count;
    if (row.status.toLowerCase() === "lost") current.lost += row.count;
    totals.set(source, current);
  }
  return [...totals.entries()]
    .map(([source, counts]) => ({
      source,
      ...counts,
      conversionPercent:
        counts.leads === 0
          ? null
          : new Prisma.Decimal(counts.won)
              .mul(100)
              .div(counts.leads)
              .toFixed(2),
    }))
    .sort((left, right) => right.leads - left.leads || left.source.localeCompare(right.source));
}
