import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { estimateUsdFromStoredUsage } from "../services/llm-usage.service";

const prisma = createPrismaClient();

type UsageRow = Awaited<ReturnType<typeof loadRows>>[number];

function csvEscape(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function parseDateArg(index: number, fallback: string): Date {
  const raw = process.argv[index] ?? fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date argument: ${raw}`);
  }
  return date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getImageCount(row: Pick<UsageRow, "metadata">): number {
  const metadata = asRecord(row.metadata);
  const count = metadata.imageCount;
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : 0;
}

function estimatedUsd(row: Pick<UsageRow, "model" | "inputTokens" | "outputTokens" | "estimatedUsd">): number {
  return (
    estimateUsdFromStoredUsage({
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedUsd: row.estimatedUsd?.toString() ?? null,
    }) ?? 0
  );
}

function totalTokens(row: Pick<UsageRow, "inputTokens" | "outputTokens" | "totalTokens">): number {
  return row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
}

function createBucket(label: string) {
  return {
    label,
    events: 0,
    estimatedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    images: 0,
  };
}

function addToBucket(bucket: ReturnType<typeof createBucket>, row: UsageRow) {
  bucket.events += 1;
  bucket.estimatedUsd += estimatedUsd(row);
  bucket.inputTokens += row.inputTokens ?? 0;
  bucket.outputTokens += row.outputTokens ?? 0;
  bucket.totalTokens += totalTokens(row);
  bucket.images += getImageCount(row);
}

function summarizeBy(rows: UsageRow[], keyFn: (row: UsageRow) => string) {
  const map = new Map<string, ReturnType<typeof createBucket>>();
  for (const row of rows) {
    const key = keyFn(row) || "(none)";
    const bucket = map.get(key) ?? createBucket(key);
    addToBucket(bucket, row);
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort(
    (left, right) => right.estimatedUsd - left.estimatedUsd,
  );
}

function writeCsv(path: string, header: string[], rows: Array<Array<string | number | null | undefined>>) {
  writeFileSync(
    path,
    [header.join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join(
      "\n",
    ),
  );
}

async function loadRows(from: Date, to: Date) {
  return prisma.llmUsageEvent.findMany({
    where: {
      createdAt: {
        gte: from,
        lte: to,
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      purpose: true,
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      estimatedUsd: true,
      pricingSchemaVersion: true,
      correlationId: true,
      userId: true,
      businessId: true,
      blogId: true,
      metadata: true,
      user: {
        select: {
          email: true,
          name: true,
        },
      },
      business: {
        select: {
          businessName: true,
          businessWebsiteUrl: true,
        },
      },
    },
  });
}

async function main() {
  const from = parseDateArg(2, "2026-07-10");
  const to = parseDateArg(3, "2026-07-11");
  const rows = await loadRows(from, to);

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const stamp = `${from.toISOString().slice(0, 10)}_${to
    .toISOString()
    .slice(0, 10)}`;

  const byModel = summarizeBy(rows, (row) => row.model);
  const byPurpose = summarizeBy(rows, (row) => row.purpose);
  const byCustomer = summarizeBy(
    rows,
    (row) =>
      row.user?.email ??
      row.business?.businessName ??
      row.userId ??
      row.businessId ??
      "(unattributed)",
  );
  const byBusiness = summarizeBy(
    rows,
    (row) =>
      row.business?.businessName ??
      row.business?.businessWebsiteUrl ??
      row.businessId ??
      "(unattributed)",
  );
  const byCorrelation = summarizeBy(
    rows,
    (row) => row.correlationId ?? "(no correlation)",
  );
  const byHour = summarizeBy(rows, (row) => row.createdAt.toISOString().slice(0, 13));

  const topEvents = [...rows].sort(
    (left, right) => estimatedUsd(right) - estimatedUsd(left),
  );
  const topTokenEvents = [...rows].sort(
    (left, right) => totalTokens(right) - totalTokens(left),
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    filterSemantics:
      "Matches superadmin LLM filter: createdAt >= from and createdAt <= to",
    from: from.toISOString(),
    to: to.toISOString(),
    totals: createBucket("total"),
    byModel: byModel.slice(0, 20),
    byPurpose,
    byCustomer: byCustomer.slice(0, 20),
    byBusiness: byBusiness.slice(0, 20),
    byCorrelation: byCorrelation.slice(0, 20),
    byHour,
    topEvents: topEvents.slice(0, 20).map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      estimatedUsd: Number(estimatedUsd(row).toFixed(6)),
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      totalTokens: totalTokens(row),
      userEmail: row.user?.email ?? null,
      userName: row.user?.name ?? null,
      businessName: row.business?.businessName ?? null,
      businessWebsiteUrl: row.business?.businessWebsiteUrl ?? null,
      blogId: row.blogId,
      correlationId: row.correlationId,
      imageCount: getImageCount(row),
      metadataUsageType:
        typeof asRecord(row.metadata).usageType === "string"
          ? asRecord(row.metadata).usageType
          : null,
    })),
  };

  for (const row of rows) {
    addToBucket(summary.totals, row);
  }

  const summaryPath = join(reportDir, `llm-usage-spike-summary-${stamp}.json`);
  const topEventsPath = join(reportDir, `llm-usage-spike-top-events-${stamp}.csv`);
  const byCustomerPath = join(
    reportDir,
    `llm-usage-spike-by-customer-${stamp}.csv`,
  );
  const byCorrelationPath = join(
    reportDir,
    `llm-usage-spike-by-correlation-${stamp}.csv`,
  );

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const eventHeader = [
    "id",
    "createdAt",
    "purpose",
    "provider",
    "model",
    "estimatedUsd",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "userEmail",
    "userName",
    "businessName",
    "businessWebsiteUrl",
    "blogId",
    "correlationId",
    "imageCount",
    "metadataUsageType",
  ];

  writeCsv(
    topEventsPath,
    eventHeader,
    topTokenEvents.slice(0, 200).map((row) => [
      row.id,
      row.createdAt.toISOString(),
      row.purpose,
      row.provider,
      row.model,
      estimatedUsd(row).toFixed(6),
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      totalTokens(row),
      row.user?.email ?? "",
      row.user?.name ?? "",
      row.business?.businessName ?? "",
      row.business?.businessWebsiteUrl ?? "",
      row.blogId ?? "",
      row.correlationId ?? "",
      getImageCount(row),
      typeof asRecord(row.metadata).usageType === "string"
        ? (asRecord(row.metadata).usageType as string)
        : "",
    ]),
  );

  const bucketHeader = [
    "label",
    "events",
    "estimatedUsd",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "images",
  ];
  const bucketRows = (buckets: ReturnType<typeof summarizeBy>) =>
    buckets.map((bucket) => [
      bucket.label,
      bucket.events,
      bucket.estimatedUsd.toFixed(6),
      bucket.inputTokens,
      bucket.outputTokens,
      bucket.totalTokens,
      bucket.images,
    ]);

  writeCsv(byCustomerPath, bucketHeader, bucketRows(byCustomer));
  writeCsv(byCorrelationPath, bucketHeader, bucketRows(byCorrelation));

  console.log(
    JSON.stringify(
      {
        summary: {
          generatedAt: summary.generatedAt,
          from: summary.from,
          to: summary.to,
          totals: summary.totals,
          byModel: summary.byModel.slice(0, 5),
          byPurpose: summary.byPurpose,
          byCustomer: summary.byCustomer.slice(0, 10),
          byCorrelation: summary.byCorrelation.slice(0, 10),
        },
        files: {
          summaryPath,
          topEventsPath,
          byCustomerPath,
          byCorrelationPath,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
