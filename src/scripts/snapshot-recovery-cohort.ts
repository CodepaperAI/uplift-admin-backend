import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import z from "zod";

const prisma = createPrismaClient({ log: [] });

const COHORT_FILE = z.object({
  items: z.array(
    z.object({
      slot: z.string().min(1),
      plan: z.object({ id: z.string().min(1) }),
    }),
  ).min(1),
});

function argumentValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim() || null;

  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

function requirePath(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new Error(`Missing --${name} <path>`);
  return resolve(value);
}

function parseBoundary(): Date {
  const value = argumentValue("freeze-boundary");
  if (!value) {
    throw new Error("Missing --freeze-boundary <ISO timestamp>");
  }
  const boundary = new Date(value);
  if (!Number.isFinite(boundary.getTime())) {
    throw new Error("Invalid --freeze-boundary; expected an ISO timestamp");
  }
  return boundary;
}

async function main() {
  const cohortPath = requirePath("cohort");
  const outputPath = requirePath("output");
  const boundary = parseBoundary();
  const cohort = COHORT_FILE.parse(
    JSON.parse(readFileSync(cohortPath, "utf8")) as unknown,
  );
  const orderedPlanIds = cohort.items.map((item) => item.plan.id);

  const plans = await prisma.plan.findMany({
    where: { id: { in: orderedPlanIds } },
    select: {
      id: true,
      keyword: true,
      keywordInstructions: true,
      publishDate: true,
      publishTime: true,
      keywordDiffculty: true,
      keywordSearchVolume: true,
      keywordMonthlySearches: true,
      keywordCpc: true,
      keywordCompetition: true,
      keywordCategory: true,
      keywordIntent: true,
      keywordSource: true,
      difficultyBucket: true,
      selectionMetadata: true,
      businessId: true,
      userId: true,
      blogId: true,
      isUsed: true,
      usedAt: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      business: {
        select: {
          id: true,
          userId: true,
          businessName: true,
          businessType: true,
          businessDescription: true,
          businessWebsiteUrl: true,
          businessPhone: true,
          businessAddress: true,
          businessCity: true,
          businessState: true,
          businessCountry: true,
          serviceArea: true,
          serviceAreaLocations: true,
          targetAudience: true,
          contentTone: true,
          preferredContentTypes: true,
          defaultLanguage: true,
          supportedLanguages: true,
          defaultLocale: true,
          exampleBlogUrls: true,
          detectedServices: true,
          selectedServices: true,
          servicesPriority: true,
          authorName: true,
          authorBio: true,
          authorJobTitle: true,
          authorImage: true,
          authorExpertise: true,
          authorSocialLinks: true,
          isActive: true,
          websiteStatus: true,
          updatedAt: true,
          websiteSubscription: {
            select: {
              status: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              trialStartDate: true,
              trialEndDate: true,
              trialStatus: true,
              updatedAt: true,
            },
          },
          currentRanking: {
            orderBy: { updatedAt: "desc" },
            select: {
              website: true,
              ranking: true,
              updatedAt: true,
            },
          },
          BlogLinks: {
            select: {
              urls: true,
              udpatedAt: true,
            },
          },
          websiteAnalysis: {
            select: {
              scrapedUrl: true,
              domain: true,
              updatedAt: true,
              contactInfo: true,
              coreServices: true,
              recognition: true,
              sitemap: true,
              brandIdentity: true,
            },
          },
        },
      },
    },
  });

  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const missingPlanIds = orderedPlanIds.filter((id) => !planById.has(id));
  const businessIds = [
    ...new Set(plans.map((plan) => plan.businessId).filter(Boolean)),
  ] as string[];
  const exactKeywords = [...new Set(plans.map((plan) => plan.keyword))];
  const [existingBlogs, exactSearchConsoleMetrics] = await Promise.all([
    prisma.blog.findMany({
      where: { businessId: { in: businessIds } },
      orderBy: [{ businessId: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        businessId: true,
        title: true,
        slug: true,
        status: true,
        excerpt: true,
        categories: true,
        tags: true,
        featured_media: true,
        blogPublishDate: true,
        blogPublishTime: true,
        canonicalUrl: true,
        authorName: true,
        createdAt: true,
        updatedAt: true,
        meta: {
          select: {
            seo_title: true,
            seo_description: true,
            focus_keyword: true,
            keywords: true,
          },
        },
        Plan: {
          select: { id: true, keyword: true },
        },
        publishedBlogs: {
          select: {
            platform: true,
            externalPostUrl: true,
            status: true,
            publishedAt: true,
            lastSyncedAt: true,
          },
        },
      },
    }),
    prisma.searchConsoleMetric.findMany({
      where: {
        businessId: { in: businessIds },
        query: { in: exactKeywords },
      },
      orderBy: [{ date: "desc" }, { impressions: "desc" }],
      select: {
        businessId: true,
        date: true,
        query: true,
        page: true,
        device: true,
        country: true,
        clicks: true,
        impressions: true,
        ctr: true,
        position: true,
      },
    }),
  ]);

  const [blogsCreatedAfterBoundary, plansUsedAfterBoundary, generationRuns] =
    await Promise.all([
      prisma.blog.count({ where: { createdAt: { gte: boundary } } }),
      prisma.plan.count({ where: { usedAt: { gte: boundary } } }),
      prisma.blogGenerationRun.findMany({
        where: {
          OR: [
            { createdAt: { gte: boundary } },
            { status: "RUNNING" },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          businessId: true,
          status: true,
          finalSaveStatus: true,
          provider: true,
          model: true,
          createdAt: true,
          completedAt: true,
          errorCode: true,
        },
      }),
    ]);

  const capturedAt = new Date().toISOString();
  const output = {
    schemaVersion: "1.0.0",
    queryMode: "production_read_only",
    capturedAt,
    source: {
      cohortFile: cohortPath,
      freezeBoundary: boundary.toISOString(),
    },
    safety: {
      writesPerformed: 0,
      blogsCreatedAfterBoundary,
      plansUsedAfterBoundary,
      generationRunsStartedAfterBoundary: generationRuns.filter(
        (run) => run.createdAt >= boundary,
      ).length,
      runningGenerationRuns: generationRuns.filter(
        (run) => run.status === "RUNNING",
      ).length,
      generationRuns,
    },
    reconciliation: {
      requestedPlanCount: orderedPlanIds.length,
      foundPlanCount: plans.length,
      missingPlanIds,
    },
    plans: orderedPlanIds
      .map((id) => planById.get(id))
      .filter((plan) => plan !== undefined),
    existingBlogs,
    exactSearchConsoleMetrics,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        capturedAt,
        outputPath,
        requestedPlans: orderedPlanIds.length,
        foundPlans: plans.length,
        missingPlans: missingPlanIds.length,
        businesses: businessIds.length,
        existingBlogs: existingBlogs.length,
        exactSearchConsoleMetrics: exactSearchConsoleMetrics.length,
        safety: output.safety,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
