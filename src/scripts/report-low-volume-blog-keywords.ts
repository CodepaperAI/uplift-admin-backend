import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient();
const MAX_LOW_VOLUME = 100;
const REPORT_DIR = join(process.cwd(), "reports");

function parseStoredVolume(monthly: number | null, legacy: string): number | null {
  if (typeof monthly === "number" && Number.isFinite(monthly)) return monthly;
  const normalized = legacy.trim().replaceAll(",", "");
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

function ageDays(value: Date, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86_400_000));
}

function csvEscape(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>) {
  const columns = [
    "businessName",
    "businessWebsiteUrl",
    "businessCreatedAt",
    "businessAgeDays",
    "keyword",
    "monthlySearchVolume",
    "volumeBucket",
    "volumeSource",
    "keywordCreatedAt",
    "keywordAgeDays",
    "keywordIntent",
    "keywordSource",
    "blogTitle",
    "blogStatus",
    "blogCreatedAt",
    "publicationRecords",
    "publishedAt",
    "externalPostUrl",
    "userEmail",
    "businessId",
    "planId",
    "blogId",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n");
}

try {
  const plans = await prisma.plan.findMany({
    where: {
      deletedAt: null,
      blogId: { not: null },
      businessId: { not: null },
      business: {
        isActive: true,
        websiteSubscription: {
          is: {
            status: "active",
            trialStatus: { notIn: ["trialing", "expired"] },
          },
        },
      },
    },
    select: {
      id: true,
      keyword: true,
      keywordSearchVolume: true,
      keywordMonthlySearches: true,
      keywordIntent: true,
      keywordSource: true,
      createdAt: true,
      blogId: true,
      user: { select: { email: true } },
      business: {
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          createdAt: true,
        },
      },
      blog: {
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          publishedBlogs: {
            where: { status: "PUBLISHED" },
            select: { publishedAt: true, externalPostUrl: true },
            orderBy: { publishedAt: "desc" },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const measured = plans.flatMap((plan) => {
    if (!plan.business || !plan.blog) return [];
    const volume = parseStoredVolume(
      plan.keywordMonthlySearches,
      plan.keywordSearchVolume,
    );
    if (volume == null || volume > MAX_LOW_VOLUME) return [];
    const publication = plan.blog.publishedBlogs[0] ?? null;
    return [{
      businessName: plan.business.businessName,
      businessWebsiteUrl: plan.business.businessWebsiteUrl,
      businessCreatedAt: plan.business.createdAt.toISOString(),
      businessAgeDays: ageDays(plan.business.createdAt),
      keyword: plan.keyword,
      monthlySearchVolume: volume,
      volumeBucket: volume === 0 ? "zero" : volume <= 10 ? "1-10" : "11-100",
      volumeSource: plan.keywordMonthlySearches != null ? "keywordMonthlySearches" : "legacyNumeric",
      keywordCreatedAt: plan.createdAt.toISOString(),
      keywordAgeDays: ageDays(plan.createdAt),
      keywordIntent: plan.keywordIntent,
      keywordSource: plan.keywordSource,
      blogTitle: plan.blog.title,
      blogStatus: plan.blog.status,
      blogCreatedAt: plan.blog.createdAt.toISOString(),
      publicationRecords: plan.blog.publishedBlogs.length,
      publishedAt: publication?.publishedAt?.toISOString() ?? null,
      externalPostUrl: publication?.externalPostUrl ?? null,
      userEmail: plan.user.email,
      businessId: plan.business.id,
      planId: plan.id,
      blogId: plan.blog.id,
    }];
  });

  measured.sort((a, b) =>
    a.businessCreatedAt.localeCompare(b.businessCreatedAt) ||
    a.keywordCreatedAt.localeCompare(b.keywordCreatedAt) ||
    a.monthlySearchVolume - b.monthlySearchVolume,
  );

  const businessMap = new Map<string, {
    businessId: string;
    businessName: string;
    businessWebsiteUrl: string;
    businessCreatedAt: string;
    businessAgeDays: number;
    lowVolumeBlogKeywords: number;
    zeroVolume: number;
    nonZeroLowVolume: number;
    livePublicationRecords: number;
  }>();

  for (const row of measured) {
    const existing = businessMap.get(row.businessId) ?? {
      businessId: row.businessId,
      businessName: row.businessName,
      businessWebsiteUrl: row.businessWebsiteUrl,
      businessCreatedAt: row.businessCreatedAt,
      businessAgeDays: row.businessAgeDays,
      lowVolumeBlogKeywords: 0,
      zeroVolume: 0,
      nonZeroLowVolume: 0,
      livePublicationRecords: 0,
    };
    existing.lowVolumeBlogKeywords += 1;
    existing.zeroVolume += row.monthlySearchVolume === 0 ? 1 : 0;
    existing.nonZeroLowVolume += row.monthlySearchVolume > 0 ? 1 : 0;
    existing.livePublicationRecords += row.publicationRecords > 0 ? 1 : 0;
    businessMap.set(row.businessId, existing);
  }

  const businesses = [...businessMap.values()].sort((a, b) =>
    a.businessCreatedAt.localeCompare(b.businessCreatedAt) ||
    b.lowVolumeBlogKeywords - a.lowVolumeBlogKeywords,
  );
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await mkdir(REPORT_DIR, { recursive: true });
  const csvPath = join(REPORT_DIR, `low-volume-blog-keywords-${stamp}.csv`);
  const jsonPath = join(REPORT_DIR, `low-volume-blog-keywords-${stamp}.json`);
  await Promise.all([
    writeFile(csvPath, toCsv(measured)),
    writeFile(jsonPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      definition: {
        paidActiveOnly: true,
        requiresBlogId: true,
        lowVolumeMaximum: MAX_LOW_VOLUME,
        unknownVolumeExcluded: true,
      },
      summary: {
        eligiblePlanRowsWithBlogs: plans.length,
        lowVolumeRows: measured.length,
        zeroVolumeRows: measured.filter((row) => row.monthlySearchVolume === 0).length,
        nonZeroLowVolumeRows: measured.filter((row) => row.monthlySearchVolume > 0).length,
        affectedBusinesses: businesses.length,
        withLivePublicationRecord: measured.filter((row) => row.publicationRecords > 0).length,
      },
      businesses,
      rows: measured,
    }, null, 2)),
  ]);

  console.log(JSON.stringify({
    ok: true,
    csvPath,
    jsonPath,
    summary: {
      eligiblePlanRowsWithBlogs: plans.length,
      lowVolumeRows: measured.length,
      zeroVolumeRows: measured.filter((row) => row.monthlySearchVolume === 0).length,
      nonZeroLowVolumeRows: measured.filter((row) => row.monthlySearchVolume > 0).length,
      affectedBusinesses: businesses.length,
      withLivePublicationRecord: measured.filter((row) => row.publicationRecords > 0).length,
    },
    oldestBusinesses: businesses.slice(0, 20),
    oldestKeywordRows: measured.slice(0, 50),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
