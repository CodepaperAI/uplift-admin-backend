import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { runOffPageGeneration } from "../services/offpage/offpage-opportunities.service";

const TARGET_EMAIL = "hrgreenrootslandscapingltd@gmail.com";
const TARGET_BUSINESS_ID = "34849719-ef87-4e98-bb6c-3a8e6904677d";
const prisma = createPrismaClient();

type OpportunityLike = {
  key?: unknown;
  leverKey?: unknown;
  title?: unknown;
  priority?: unknown;
  url?: unknown;
  submissionUrl?: unknown;
  confidence?: unknown;
  qualityScore?: unknown;
};

function opportunitiesFromPayload(payload: unknown): OpportunityLike[] {
  if (!payload || typeof payload !== "object") return [];
  const opportunities = (payload as { opportunities?: unknown }).opportunities;
  return Array.isArray(opportunities) ? opportunities : [];
}

function validateRefreshedPayload(payload: unknown) {
  const opportunities = opportunitiesFromPayload(payload);
  const valid = opportunities.filter(
    (item) =>
      typeof item.key === "string" &&
      item.key.length > 0 &&
      typeof item.leverKey === "string" &&
      typeof item.title === "string" &&
      typeof item.priority === "number",
  );
  const directory = valid.filter((item) => item.leverKey === "directory");
  const reddit = valid.filter((item) => item.leverKey === "reddit");
  const duplicateKeys = valid.length - new Set(valid.map((item) => item.key)).size;
  const invalidUrls = valid.filter((item) => {
    const value = item.submissionUrl ?? item.url;
    if (typeof value !== "string" || value.length === 0) return false;
    try {
      const url = new URL(value);
      return url.protocol !== "https:" && url.protocol !== "http:";
    } catch {
      return true;
    }
  });

  return {
    ok:
      valid.length >= 5 &&
      directory.length >= 2 &&
      reddit.length >= 1 &&
      duplicateKeys === 0 &&
      invalidUrls.length === 0,
    total: opportunities.length,
    valid: valid.length,
    directory: directory.length,
    reddit: reddit.length,
    duplicateKeys,
    invalidUrls: invalidUrls.length,
  };
}

async function restoreCache(
  backup: NonNullable<
    Awaited<ReturnType<typeof prisma.offPageResearchCache.findUnique>>
  >,
) {
  await prisma.offPageResearchCache.upsert({
    where: { businessId: backup.businessId },
    create: {
      id: backup.id,
      businessId: backup.businessId,
      inputHash: backup.inputHash,
      payload: backup.payload as Prisma.InputJsonValue,
      generatedAt: backup.generatedAt,
      expiresAt: backup.expiresAt,
    },
    update: {
      inputHash: backup.inputHash,
      payload: backup.payload as Prisma.InputJsonValue,
      generatedAt: backup.generatedAt,
      expiresAt: backup.expiresAt,
    },
  });
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: TARGET_EMAIL },
    select: {
      id: true,
      business: {
        where: { id: TARGET_BUSINESS_ID },
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          isActive: true,
          websiteSubscription: {
            select: { status: true, trialStatus: true },
          },
        },
      },
    },
  });
  const business = user?.business[0];
  if (!user || !business) {
    throw new Error("Target user/business ownership check failed.");
  }
  if (
    !business.isActive ||
    business.websiteSubscription?.status !== "active" ||
    business.websiteSubscription.trialStatus === "trialing" ||
    business.websiteSubscription.trialStatus === "expired"
  ) {
    throw new Error("Target business is not paid-active; refusing refresh.");
  }

  const before = await prisma.offPageResearchCache.findUnique({
    where: { businessId: TARGET_BUSINESS_ID },
  });
  const statusesBefore = await prisma.offPageOpportunity.count({
    where: { businessId: TARGET_BUSINESS_ID },
  });

  const reportDir = join(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(
    reportDir,
    `hr-greenroots-offpage-cache-backup-${timestamp}.json`,
  );
  await writeFile(
    backupPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        target: {
          email: TARGET_EMAIL,
          businessId: business.id,
          businessName: business.businessName,
          website: business.businessWebsiteUrl,
        },
        cache: before,
        opportunityStatusCount: statusesBefore,
      },
      null,
      2,
    ),
  );

  try {
    await runOffPageGeneration(user.id, business.id);
    const after = await prisma.offPageResearchCache.findUnique({
      where: { businessId: TARGET_BUSINESS_ID },
    });
    const validation = validateRefreshedPayload(after?.payload);
    const statusesAfter = await prisma.offPageOpportunity.count({
      where: { businessId: TARGET_BUSINESS_ID },
    });
    if (!after || !validation.ok || statusesAfter !== statusesBefore) {
      if (before) await restoreCache(before);
      throw new Error(
        `Refreshed cache failed safety validation and was restored: ${JSON.stringify({ validation, statusesBefore, statusesAfter })}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          backupPath,
          target: {
            email: TARGET_EMAIL,
            businessId: business.id,
            businessName: business.businessName,
          },
          before: {
            generatedAt: before?.generatedAt ?? null,
            expiresAt: before?.expiresAt ?? null,
            opportunities: opportunitiesFromPayload(before?.payload).length,
          },
          after: {
            generatedAt: after.generatedAt,
            expiresAt: after.expiresAt,
            validation,
          },
          opportunityStatusRowsUnchanged: statusesAfter,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (before) await restoreCache(before);
    throw error;
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
