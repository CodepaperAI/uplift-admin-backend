import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { classifyUserSubscriptionStatus } from "../utils/superadmin-metrics.utils";

const prisma = createPrismaClient();

type CountryBucket = "india" | "non_india" | "unknown";

function csvEscape(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function normalizeCountry(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isIndiaCountry(value: string | null | undefined): boolean {
  const normalized = normalizeCountry(value);
  return [
    "india",
    "in",
    "ind",
    "bharat",
    "republic of india",
  ].includes(normalized);
}

function classifyCountry(countries: string[]): CountryBucket {
  const cleanCountries = countries
    .map((country) => country.trim())
    .filter(Boolean);

  if (cleanCountries.length === 0) return "unknown";
  if (cleanCountries.some(isIndiaCountry)) return "india";
  return "non_india";
}

async function main() {
  const now = new Date();

  const [users, quickScrapeBusinesses] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        trialStatus: true,
        trialStartDate: true,
        trialEndDate: true,
        createdAt: true,
        business: {
          where: { isActive: true },
          select: {
            businessName: true,
            businessWebsiteUrl: true,
            businessCountry: true,
            websiteStatus: true,
            isPrimary: true,
            websiteSubscription: {
              select: {
                status: true,
                stripeSubscriptionId: true,
                trialStatus: true,
                trialEndDate: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.quickScrapeBusiness.findMany({
      select: {
        userId: true,
        businessCountry: true,
        businessName: true,
        businessWebsiteUrl: true,
      },
    }),
  ]);

  const quickScrapeByUser = new Map<
    string,
    Array<{
      businessCountry: string | null;
      businessName: string;
      businessWebsiteUrl: string;
    }>
  >();

  for (const business of quickScrapeBusinesses) {
    const existing = quickScrapeByUser.get(business.userId) ?? [];
    existing.push(business);
    quickScrapeByUser.set(business.userId, existing);
  }

  const rows = users.map((user) => {
    const subscriptionStatus = classifyUserSubscriptionStatus(
      {
        trialStatus: user.trialStatus,
        trialEndDate: user.trialEndDate,
        business: user.business.map((business) => ({
          websiteStatus: business.websiteStatus,
          websiteSubscription: business.websiteSubscription,
        })),
      },
      null,
      now,
    );

    const activeBusinessCountries = user.business
      .map((business) => business.businessCountry ?? "")
      .filter(Boolean);
    const fallbackQuickScrapeCountries = (quickScrapeByUser.get(user.id) ?? [])
      .map((business) => business.businessCountry ?? "")
      .filter(Boolean);
    const countries =
      activeBusinessCountries.length > 0
        ? activeBusinessCountries
        : fallbackQuickScrapeCountries;
    const countryBucket = classifyCountry(countries);

    const primaryBusiness =
      user.business.find((business) => business.isPrimary) ?? user.business[0];
    const quickScrapeFallbacks = quickScrapeByUser.get(user.id) ?? [];

    return {
      id: user.id,
      email: user.email,
      name: user.name ?? "",
      role: user.role,
      subscriptionStatus,
      countryBucket,
      countries: [...new Set(countries)].join(" | "),
      trialStatus: user.trialStatus ?? "",
      trialStartDate: user.trialStartDate?.toISOString() ?? "",
      trialEndDate: user.trialEndDate?.toISOString() ?? "",
      createdAt: user.createdAt.toISOString(),
      primaryBusinessName:
        primaryBusiness?.businessName ?? quickScrapeFallbacks[0]?.businessName ?? "",
      primaryBusinessWebsiteUrl:
        primaryBusiness?.businessWebsiteUrl ??
        quickScrapeFallbacks[0]?.businessWebsiteUrl ??
        "",
      activeBusinessNames: user.business
        .map((business) => business.businessName)
        .filter(Boolean)
        .join(" | "),
      activeBusinessUrls: user.business
        .map((business) => business.businessWebsiteUrl)
        .filter(Boolean)
        .join(" | "),
      websiteStatuses: user.business
        .map((business) => business.websiteStatus)
        .filter(Boolean)
        .join(" | "),
      websiteSubscriptionStatuses: user.business
        .map((business) => business.websiteSubscription?.status ?? "")
        .filter(Boolean)
        .join(" | "),
    };
  });

  const trialOrExpiredRows = rows.filter(
    (row) =>
      row.subscriptionStatus === "trial" ||
      row.subscriptionStatus === "expired",
  );

  const summary = {
    generatedAt: now.toISOString(),
    source: "Prisma production DATABASE_URL from seo-be environment",
    countryClassification:
      "india if any active business country, or quick-scrape fallback country, is India/IN/IND; non_india if at least one country exists and none are India; unknown if no country is stored",
    totalUsers: rows.length,
    paidUsers: rows.filter((row) => row.subscriptionStatus === "paid").length,
    trialUsers: rows.filter((row) => row.subscriptionStatus === "trial").length,
    expiredUsers: rows.filter((row) => row.subscriptionStatus === "expired")
      .length,
    trialOrExpiredUsers: trialOrExpiredRows.length,
    trialOrExpiredByCountry: {
      india: trialOrExpiredRows.filter((row) => row.countryBucket === "india")
        .length,
      nonIndia: trialOrExpiredRows.filter(
        (row) => row.countryBucket === "non_india",
      ).length,
      unknown: trialOrExpiredRows.filter(
        (row) => row.countryBucket === "unknown",
      ).length,
    },
    activeTrialByCountry: {
      india: rows.filter(
        (row) =>
          row.subscriptionStatus === "trial" && row.countryBucket === "india",
      ).length,
      nonIndia: rows.filter(
        (row) =>
          row.subscriptionStatus === "trial" &&
          row.countryBucket === "non_india",
      ).length,
      unknown: rows.filter(
        (row) =>
          row.subscriptionStatus === "trial" && row.countryBucket === "unknown",
      ).length,
    },
    expiredByCountry: {
      india: rows.filter(
        (row) =>
          row.subscriptionStatus === "expired" && row.countryBucket === "india",
      ).length,
      nonIndia: rows.filter(
        (row) =>
          row.subscriptionStatus === "expired" &&
          row.countryBucket === "non_india",
      ).length,
      unknown: rows.filter(
        (row) =>
          row.subscriptionStatus === "expired" &&
          row.countryBucket === "unknown",
      ).length,
    },
  };

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });

  const dateStamp = now.toISOString().slice(0, 10);
  const csvPath = join(
    reportDir,
    `trial-expired-users-country-${dateStamp}.csv`,
  );
  const jsonPath = join(
    reportDir,
    `trial-expired-users-country-summary-${dateStamp}.json`,
  );

  const header = [
    "id",
    "email",
    "name",
    "role",
    "subscriptionStatus",
    "countryBucket",
    "countries",
    "trialStatus",
    "trialStartDate",
    "trialEndDate",
    "createdAt",
    "primaryBusinessName",
    "primaryBusinessWebsiteUrl",
    "activeBusinessNames",
    "activeBusinessUrls",
    "websiteStatuses",
    "websiteSubscriptionStatuses",
  ];

  const lines = trialOrExpiredRows.map((row) =>
    header.map((key) => csvEscape(row[key as keyof typeof row])).join(","),
  );

  writeFileSync(csvPath, [header.join(","), ...lines].join("\n"));
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({ summary, csvPath, jsonPath }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
