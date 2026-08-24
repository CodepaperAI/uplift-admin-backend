import { createPrismaClient } from "../config/prisma-client.factory";
import { inngest } from "../inngest/client";
import { isCanonicalBunnyBrandLogoUrl } from "../services/onboarding-v2-brand-logo.service";

const prisma = createPrismaClient();

function argument(name: string): string | null {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const execute = process.argv.includes("--execute");
const includeAll = process.argv.includes("--all");
const includeUnentitled = process.argv.includes("--include-unentitled");
const businessId = argument("--business-id");
const limit = positiveInteger(argument("--limit"), 50);
const skip = positiveInteger(argument("--skip"), 0);

async function main() {
  if (execute && !includeAll && !businessId) {
    throw new Error(
      "Execution requires --all or an explicit --business-id=<uuid>. Dry-run is the default.",
    );
  }

  const businesses = await prisma.business.findMany({
    where: {
      isActive: true,
      businessWebsiteUrl: { not: "" },
      ...(businessId ? { id: businessId } : {}),
      ...(!businessId && !includeUnentitled
        ? {
            websiteSubscription: {
              is: { status: { in: ["active", "trialing"] } },
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: businessId ? 0 : skip,
    take: businessId ? 1 : limit,
    select: {
      id: true,
      userId: true,
      businessWebsiteUrl: true,
      BrandAnalysis: {
        select: {
          analysisVersion: true,
          faviconUrl: true,
          lastAnalyzed: true,
          logoUrl: true,
        },
      },
    },
  });

  const inventory = businesses.map((business) => {
    const analysis = business.BrandAnalysis;
    return {
      business,
      missingAnalysis: !analysis,
      missingLogo: !analysis?.logoUrl,
      faviconPromotedToLogo:
        Boolean(analysis?.logoUrl) && analysis?.logoUrl === analysis?.faviconUrl,
      nonCanonicalLogo:
        Boolean(analysis?.logoUrl) &&
        !isCanonicalBunnyBrandLogoUrl(analysis?.logoUrl),
      failedAnalysis: analysis?.analysisVersion?.endsWith("-error") === true,
    };
  });

  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "dry-run",
        scope: includeUnentitled ? "all-active-businesses" : "entitled-clients",
        skipped: businessId ? 0 : skip,
        selected: inventory.length,
        missingAnalysis: inventory.filter((item) => item.missingAnalysis).length,
        missingLogo: inventory.filter((item) => item.missingLogo).length,
        faviconPromotedToLogo: inventory.filter(
          (item) => item.faviconPromotedToLogo,
        ).length,
        nonCanonicalLogo: inventory.filter((item) => item.nonCanonicalLogo).length,
        failedAnalysis: inventory.filter((item) => item.failedAnalysis).length,
        approvedCanonicalLogosPreserved: inventory.filter((item) =>
          isCanonicalBunnyBrandLogoUrl(item.business.BrandAnalysis?.logoUrl),
        ).length,
      },
      null,
      2,
    ),
  );

  if (!execute) return;

  let queued = 0;
  for (const item of inventory) {
    const websiteUrl = item.business.businessWebsiteUrl?.trim();
    if (!websiteUrl) continue;
    await inngest.send({
      id: `brand-analysis-backfill-${Date.now()}-${item.business.id}`,
      name: "brand/analyze",
      data: {
        businessId: item.business.id,
        websiteUrl,
        userId: item.business.userId,
        forceRefresh: true,
        source: "brand_analysis_backfill",
      },
    });
    queued += 1;
  }

  console.log(JSON.stringify({ queued, selected: inventory.length }, null, 2));
}

main()
  .catch((error) => {
    console.error("Brand-analysis backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
