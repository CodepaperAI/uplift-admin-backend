import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";
import { extractExternalLinkUrlsFromHtml } from "../utils/managed-backlinks.utils";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Usage: diagnose-user-backlinks.ts <email>");

const prisma = createPrismaClient();

function domainFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

try {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      backlinkEnabled: true,
      createdAt: true,
      Subscription: {
        select: { status: true, currentPeriodEnd: true, stripeStatus: true },
      },
      business: {
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          isActive: true,
          websiteStatus: true,
          onboardingStatus: true,
          createdAt: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              currentPeriodEnd: true,
              stripeSubscriptionId: true,
            },
          },
        },
      },
    },
  });

  if (!user) throw new Error(`No production user found for ${email}`);

  const businesses = [];
  for (const business of user.business) {
    const domain = domainFromUrl(business.businessWebsiteUrl);
    const [
      totalBlogs,
      publishedStatusBlogs,
      publishedRecords,
      integrations,
      managedReceived,
      managedSent,
      externalActive,
      externalLost,
      externalSummary,
      offPageCache,
      offPageStatusCount,
      drActionCount,
      drOptimizationCount,
      otherPublishedBlogsMentioningDomain,
      otherBlogsWithDomain,
      recentBlogs,
    ] = await Promise.all([
      prisma.blog.count({ where: { businessId: business.id } }),
      prisma.blog.count({ where: { businessId: business.id, status: "PUBLISH" } }),
      prisma.publishedBlog.findMany({
        where: { blog: { businessId: business.id } },
        select: {
          status: true,
          publishedAt: true,
          lastSyncedAt: true,
          lastError: true,
          externalPostUrl: true,
          blogId: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      prisma.publishingIntegration.findMany({
        where: { businessId: business.id },
        select: {
          platform: true,
          isActive: true,
          autoPublish: true,
          isVerified: true,
          lastSyncAt: true,
          lastError: true,
          lastErrorAt: true,
          errorCount: true,
          createdAt: true,
        },
      }),
      prisma.backlinks.findMany({
        where: { referredBusinessId: business.id },
        select: {
          sourceBlogId: true,
          sourceBlogUrl: true,
          sourceBusinessId: true,
          referredBlogUrl: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.backlinks.findMany({
        where: { sourceBusinessId: business.id },
        select: {
          sourceBlogId: true,
          referredBusinessId: true,
          referredBlogUrl: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.externalBacklink.count({ where: { businessId: business.id, isLost: false } }),
      prisma.externalBacklink.count({ where: { businessId: business.id, isLost: true } }),
      prisma.externalBacklinkSummary.findUnique({
        where: { businessId: business.id },
        select: {
          totalBacklinks: true,
          totalReferringDomains: true,
          newBacklinksThisMonth: true,
          lostBacklinksThisMonth: true,
          lastSyncedAt: true,
          syncStatus: true,
          syncError: true,
          updatedAt: true,
        },
      }),
      prisma.offPageResearchCache.findUnique({
        where: { businessId: business.id },
        select: { generatedAt: true, expiresAt: true, payload: true },
      }),
      prisma.offPageOpportunity.count({ where: { businessId: business.id } }),
      prisma.dRActionLog.count({ where: { businessId: business.id } }),
      prisma.dRContentOptimization.count({ where: { businessId: business.id } }),
      domain
        ? prisma.blog.count({
            where: {
              businessId: { not: business.id },
              status: "PUBLISH",
              content: { contains: domain, mode: "insensitive" },
            },
          })
        : Promise.resolve(0),
      domain
        ? prisma.blog.findMany({
            where: {
              businessId: { not: business.id },
              status: "PUBLISH",
              content: { contains: domain, mode: "insensitive" },
            },
            select: {
              id: true,
              title: true,
              slug: true,
              content: true,
              businessId: true,
              business: { select: { businessWebsiteUrl: true } },
              publishedBlogs: {
                select: { status: true, externalPostUrl: true, publishedAt: true, lastError: true },
              },
              _count: { select: { outboundManagedBacklinks: true } },
            },
          })
        : Promise.resolve([]),
      prisma.blog.findMany({
        where: { businessId: business.id },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          analytics: true,
          _count: { select: { publishedBlogs: true, outboundManagedBacklinks: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    const payload =
      offPageCache?.payload && typeof offPageCache.payload === "object"
        ? (offPageCache.payload as Record<string, unknown>)
        : null;
    const opportunities = payload && Array.isArray(payload.opportunities)
      ? (payload.opportunities as Array<Record<string, unknown>>)
      : [];

    businesses.push({
      profile: { ...business, domain },
      eligibility: {
        backlinkEnabled: user.backlinkEnabled,
        paidActive:
          business.websiteSubscription?.status === "active" &&
          !["trialing", "expired"].includes(business.websiteSubscription?.trialStatus ?? ""),
        hasWebsite: Boolean(domain),
      },
      publishing: {
        totalBlogs,
        publishedStatusBlogs,
        publicationRecords: publishedRecords.length,
        publicationStatusCounts: publishedRecords.reduce<Record<string, number>>((acc, row) => {
          acc[row.status] = (acc[row.status] ?? 0) + 1;
          return acc;
        }, {}),
        recentPublicationRecords: publishedRecords.slice(0, 5),
        integrations,
        recentBlogs: recentBlogs.map((row) => {
          const analytics =
            row.analytics && typeof row.analytics === "object"
              ? (row.analytics as Record<string, unknown>)
              : {};
          return {
            id: row.id,
            title: row.title,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            publicationRecords: row._count.publishedBlogs,
            outboundManagedBacklinks: row._count.outboundManagedBacklinks,
            externalLinksCount: analytics.externalLinksCount ?? null,
            managedCrossLinksCount: analytics.managedCrossLinksCount ?? null,
          };
        }),
      },
      managedCrossLinks: {
        receivedCount: managedReceived.length,
        sentCount: managedSent.length,
        otherPublishedBlogsMentioningDomain,
        mentions: otherBlogsWithDomain.map((row) => {
          const sourceBaseUrl =
            row.publishedBlogs.find((entry) => entry.externalPostUrl)?.externalPostUrl ||
            row.business.businessWebsiteUrl;
          const externalLinks = sourceBaseUrl
            ? extractExternalLinkUrlsFromHtml({
                html: row.content,
                sourceBaseUrl,
                currentBusinessWebsiteUrl: row.business.businessWebsiteUrl,
              })
            : [];
          return {
            blogId: row.id,
            title: row.title,
            slug: row.slug,
            sourceBusinessId: row.businessId,
            sourceWebsite: row.business.businessWebsiteUrl,
            expectedFallbackUrl: new URL(
              `blog/${row.slug}`,
              row.business.businessWebsiteUrl,
            ).toString(),
            publicationRecords: row.publishedBlogs,
            recordedManagedLinks: row._count.outboundManagedBacklinks,
            containsClickableTargetLink: externalLinks.some((url) =>
              domainFromUrl(url).endsWith(domain),
            ),
            extractedTargetLinks: externalLinks.filter((url) =>
              domainFromUrl(url).endsWith(domain),
            ),
          };
        }),
        received: managedReceived.slice(0, 10),
        sent: managedSent.slice(0, 10),
      },
      discoveredExternalBacklinks: {
        activeRows: externalActive,
        lostRows: externalLost,
        summary: externalSummary,
      },
      offPageResearch: {
        cacheGeneratedAt: offPageCache?.generatedAt ?? null,
        cacheExpiresAt: offPageCache?.expiresAt ?? null,
        opportunities: opportunities.length,
        opportunityTypes: opportunities.reduce<Record<string, number>>((acc, row) => {
          const key = String(row.leverKey ?? "unknown");
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        trackedStatuses: offPageStatusCount,
      },
      domainRatingAutomation: { actionLogs: drActionCount, contentOptimizations: drOptimizationCount },
    });
  }

  const systemManagedCrossLinkRows = await prisma.backlinks.count();
  console.log(JSON.stringify({ user: { ...user, business: undefined }, businesses, systemManagedCrossLinkRows }, null, 2));
} finally {
  await prisma.$disconnect();
}
