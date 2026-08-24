import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";

const BUSINESS_ID = "34849719-ef87-4e98-bb6c-3a8e6904677d";
const EXPECTED_KEYS = [
  "directory:homestars-canada",
  "directory:landscape-ontario-green-trade",
  "reddit:r-mississauga-property-grading",
  "reddit:r-lawncare-canada-mississauga-sod-grading",
  "directory:houzz-canada",
  "reddit:r-lawncare-canada-new-sod-care",
  "directory:apple-business-connect",
  "reddit:r-lawncare-canada-ontario-interlock",
  "directory:bing-places-for-business",
  "directory:yelp-canada",
];

const prisma = createPrismaClient();

try {
  const [cache, statusCount] = await Promise.all([
    prisma.offPageResearchCache.findUnique({
      where: { businessId: BUSINESS_ID },
      select: { businessId: true, generatedAt: true, expiresAt: true, payload: true },
    }),
    prisma.offPageOpportunity.count({ where: { businessId: BUSINESS_ID } }),
  ]);

  if (!cache || !cache.payload || typeof cache.payload !== "object") {
    throw new Error("Production cache row is missing.");
  }

  const payload = cache.payload as Record<string, unknown>;
  const opportunities = Array.isArray(payload.opportunities)
    ? (payload.opportunities as Array<Record<string, unknown>>)
    : [];
  const keys = opportunities.map((item) => String(item.key));
  const directories = opportunities.filter((item) => item.leverKey === "directory").length;
  const reddit = opportunities.filter((item) => item.leverKey === "reddit").length;
  const malformed = opportunities.filter((item) => {
    try {
      const url = new URL(String(item.submissionUrl ?? item.url));
      return !["http:", "https:"].includes(url.protocol);
    } catch {
      return true;
    }
  }).length;
  const missingKeys = EXPECTED_KEYS.filter((key) => !keys.includes(key));
  const unexpectedKeys = keys.filter((key) => !EXPECTED_KEYS.includes(key));
  const duplicateKeys = keys.length - new Set(keys).size;
  const ok =
    cache.businessId === BUSINESS_ID &&
    opportunities.length === EXPECTED_KEYS.length &&
    directories === 6 &&
    reddit === 4 &&
    malformed === 0 &&
    duplicateKeys === 0 &&
    missingKeys.length === 0 &&
    unexpectedKeys.length === 0 &&
    statusCount === 0;

  console.log(
    JSON.stringify(
      {
        ok,
        businessId: cache.businessId,
        generatedAt: cache.generatedAt,
        expiresAt: cache.expiresAt,
        total: opportunities.length,
        directories,
        reddit,
        malformed,
        duplicateKeys,
        missingKeys,
        unexpectedKeys,
        statusRows: statusCount,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
