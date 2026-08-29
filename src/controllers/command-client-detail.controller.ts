import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import { summariseSearchConsole } from "../command/client-results";

/**
 * One client account, as the people who serve it need to see it.
 *
 * Deliberately not a mirror of the customer portal. The portal answers "what
 * can I do next"; this answers "is this account getting what it pays for" — so
 * it leads with what was delivered, what broke, and what it produced, and
 * carries the operational facts the client never sees (onboarding state,
 * integration health, whether their results are even measurable).
 *
 * Split into an overview and two feeds rather than one payload. The overview is
 * small and always loads; blogs and results are paginated and streamed on their
 * own, so an account with two thousand blogs opens as fast as one with two.
 */

function notFound(res: Response) {
  sendError(res, "Client not found", 404);
}

/** Rejects a malformed id before it reaches Postgres as a failed uuid cast. */
function businessIdOf(req: Request): string | null {
  const raw = req.params.businessId;
  return typeof raw === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

export async function getCommandClientOverview(
  req: Request,
  res: Response,
): Promise<void> {
  const businessId = businessIdOf(req);
  if (!businessId) return notFound(res);

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        businessName: true,
        businessType: true,
        businessDescription: true,
        businessWebsiteUrl: true,
        businessPhone: true,
        businessCity: true,
        businessState: true,
        businessCountry: true,
        targetAudience: true,
        contentTone: true,
        publishingFrequency: true,
        selectedServices: true,
        defaultLanguage: true,
        defaultLocale: true,
        isActive: true,
        isPrimary: true,
        websiteStatus: true,
        onboardingFlow: true,
        onboardingStatus: true,
        onboardingCompletedAt: true,
        onboardingLastError: true,
        createdAt: true,
        userId: true,
        User: { select: { id: true, email: true, name: true, createdAt: true } },
        websiteSubscription: {
          select: {
            planTier: true,
            status: true,
            trialStatus: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            trialEndDate: true,
            stripeSubscriptionId: true,
          },
        },
      },
    });
    if (!business) return notFound(res);

    const [
      blogCounts,
      publishTargets,
      socialCounts,
      socialAccounts,
      keywordPlans,
      backlinks,
      analytics,
      gscWindow,
      lastBlog,
      lastSocial,
      seoAudit,
    ] = await Promise.all([
      prisma.blog.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),
      prisma.publishedBlog.groupBy({
        by: ["platform", "status"],
        where: { blog: { businessId } },
        _count: { _all: true },
      }),
      prisma.socialPublishAttempt.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),
      prisma.socialPublisherAccount.findMany({
        where: { businessId },
        select: {
          platform: true,
          username: true,
          displayName: true,
          profileUrl: true,
          isActive: true,
          connectedAt: true,
        },
        orderBy: [{ platform: "asc" }],
      }),
      prisma.plan.groupBy({
        by: ["businessId"],
        where: { businessId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.backlinks.count({ where: { referredBusinessId: businessId } }),
      prisma.businessAnalyticsConfig.findUnique({
        where: { businessId },
        select: {
          gscSiteUrl: true,
          gscConnectedAt: true,
          gscLastSyncedAt: true,
          gscLastSyncError: true,
          ga4PropertyId: true,
          lastSyncedAt: true,
          lastSyncError: true,
        },
      }),
      prisma.searchConsoleMetric.aggregate({
        where: { businessId },
        _count: { _all: true },
        _min: { date: true },
        _max: { date: true },
      }),
      prisma.blog.findFirst({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, status: true, createdAt: true },
      }),
      prisma.socialPublishAttempt.findFirst({
        where: { businessId, status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
        select: { platform: true, publishedAt: true, externalPostUrl: true },
      }),
      prisma.seoAuditRun.findFirst({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
      }),
    ]);

    const blogTotal = blogCounts.reduce((sum, row) => sum + row._count._all, 0);
    const blogPublished =
      blogCounts.find((row) => row.status === "PUBLISH")?._count._all ?? 0;
    const socialTotal = socialCounts.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const at = (status: string) =>
      socialCounts.find((row) => row.status === status)?._count._all ?? 0;

    sendSuccess(
      res,
      {
        client: {
          businessId: business.id,
          businessName: business.businessName,
          businessType: business.businessType,
          description: business.businessDescription,
          websiteUrl: business.businessWebsiteUrl,
          phone: business.businessPhone,
          location: [business.businessCity, business.businessState, business.businessCountry]
            .filter(Boolean)
            .join(", ") || null,
          targetAudience: business.targetAudience,
          contentTone: business.contentTone,
          publishingFrequency: business.publishingFrequency,
          services: business.selectedServices,
          language: business.defaultLanguage,
          locale: business.defaultLocale,
          isActive: business.isActive,
          isPrimary: business.isPrimary,
          websiteStatus: business.websiteStatus,
          createdAt: business.createdAt.toISOString(),
          owner: {
            userId: business.User?.id ?? business.userId,
            email: business.User?.email ?? null,
            name: business.User?.name ?? null,
            signedUpAt: business.User?.createdAt?.toISOString() ?? null,
          },
        },
        onboarding: {
          flow: business.onboardingFlow,
          status: business.onboardingStatus,
          completedAt: business.onboardingCompletedAt?.toISOString() ?? null,
          lastError: business.onboardingLastError ?? null,
        },
        subscription: business.websiteSubscription
          ? {
              planTier: business.websiteSubscription.planTier,
              status: business.websiteSubscription.status,
              trialStatus: business.websiteSubscription.trialStatus,
              currentPeriodStart:
                business.websiteSubscription.currentPeriodStart?.toISOString() ?? null,
              currentPeriodEnd:
                business.websiteSubscription.currentPeriodEnd?.toISOString() ?? null,
              trialEndDate:
                business.websiteSubscription.trialEndDate?.toISOString() ?? null,
              hasStripeSubscription: Boolean(
                business.websiteSubscription.stripeSubscriptionId,
              ),
            }
          : null,
        blogs: {
          total: blogTotal,
          published: blogPublished,
          drafts: blogTotal - blogPublished,
          destinations: publishTargets.map((row) => ({
            platform: row.platform,
            status: row.status,
            count: row._count._all,
          })),
          latest: lastBlog
            ? {
                id: lastBlog.id,
                title: lastBlog.title,
                status: lastBlog.status,
                createdAt: lastBlog.createdAt.toISOString(),
              }
            : null,
        },
        social: {
          attempts: socialTotal,
          published: at("PUBLISHED"),
          scheduled: at("SCHEDULED"),
          failed: at("FAILED"),
          pending: at("PENDING") + at("SUBMITTING"),
          accounts: socialAccounts.map((account) => ({
            platform: account.platform,
            username: account.username,
            displayName: account.displayName,
            profileUrl: account.profileUrl,
            isActive: account.isActive,
            connectedAt: account.connectedAt.toISOString(),
          })),
          latestPublished: lastSocial
            ? {
                platform: lastSocial.platform,
                publishedAt: lastSocial.publishedAt?.toISOString() ?? null,
                postUrl: lastSocial.externalPostUrl,
              }
            : null,
        },
        seo: {
          keywordPlans: keywordPlans[0]?._count._all ?? 0,
          backlinks,
          lastAuditAt: seoAudit?.createdAt.toISOString() ?? null,
          lastAuditStatus: seoAudit?.status ?? null,
        },
        /**
         * Whether this account's results are knowable at all.
         *
         * Six of two thousand businesses have connected Search Console, so for
         * almost every account the honest answer to "how is it performing" is
         * "nothing is measuring it". Said here rather than rendered as an empty
         * chart, which reads as zero traffic instead of no instrument.
         */
        results: {
          searchConsoleConnected: Boolean(analytics?.gscSiteUrl),
          searchConsoleSite: analytics?.gscSiteUrl ?? null,
          searchConsoleConnectedAt: analytics?.gscConnectedAt?.toISOString() ?? null,
          searchConsoleLastSyncedAt:
            analytics?.gscLastSyncedAt?.toISOString() ?? null,
          searchConsoleError: analytics?.gscLastSyncError ?? null,
          analyticsConnected: Boolean(analytics?.ga4PropertyId),
          metricRows: gscWindow._count._all,
          firstMetricDate: gscWindow._min.date?.toISOString().slice(0, 10) ?? null,
          lastMetricDate: gscWindow._max.date?.toISOString().slice(0, 10) ?? null,
        },
      },
      "Command client overview",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-client-detail",
        event: "overview_failed",
        businessId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to load client", 500);
  }
}

/**
 * Every blog this client has, with where each one actually went.
 *
 * A blog row on its own says nothing useful — "published" in our database means
 * the pipeline finished, not that anything reached the client's site. The
 * publish destinations carry that, so they are joined here rather than left to
 * a second call: a blog marked PUBLISH with no live URL is the row worth seeing.
 */
export async function getCommandClientBlogs(
  req: Request,
  res: Response,
): Promise<void> {
  const businessId = businessIdOf(req);
  if (!businessId) return notFound(res);
  const { page, pageSize, skip } = parseCommandPagination({
    page: req.query.page,
    pageSize: req.query.pageSize,
    defaultPageSize: 50,
    maxPageSize: 200,
  });
  const status =
    req.query.status === "PUBLISH" || req.query.status === "DRAFT"
      ? req.query.status
      : null;
  const search =
    typeof req.query.search === "string" && req.query.search.trim() !== ""
      ? req.query.search.trim()
      : null;

  const where: Prisma.BlogWhereInput = {
    businessId,
    ...(status ? { status } : {}),
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
  };

  try {
    const [blogs, total] = await Promise.all([
      prisma.blog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: pageSize,
        // Narrow: `content` is a whole article and never belongs in a list.
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          excerpt: true,
          seoScore: true,
          canonicalUrl: true,
          blogPublishDate: true,
          blogPublishTime: true,
          createdAt: true,
          updatedAt: true,
          publishedBlogs: {
            select: {
              platform: true,
              status: true,
              externalPostUrl: true,
              publishedAt: true,
              lastError: true,
              retryCount: true,
            },
          },
        },
      }),
      prisma.blog.count({ where }),
    ]);

    sendSuccess(
      res,
      {
        pagination: commandPaginationResult({ page, pageSize, total }),
        filters: { status, search },
        blogs: blogs.map((blog) => {
          const destinations = blog.publishedBlogs.map((row) => ({
            platform: row.platform,
            status: row.status,
            url: row.externalPostUrl,
            publishedAt: row.publishedAt?.toISOString() ?? null,
            error: row.lastError,
            retryCount: row.retryCount,
          }));
          const live = destinations.filter(
            (row) => row.status === "PUBLISHED" && row.url,
          );
          return {
            id: blog.id,
            title: blog.title,
            slug: blog.slug,
            status: blog.status,
            excerpt: blog.excerpt?.slice(0, 220) ?? null,
            seoScore: blog.seoScore,
            canonicalUrl: blog.canonicalUrl,
            scheduledFor:
              blog.blogPublishDate || blog.blogPublishTime
                ? `${blog.blogPublishDate ?? ""} ${blog.blogPublishTime ?? ""}`.trim()
                : null,
            createdAt: blog.createdAt.toISOString(),
            updatedAt: blog.updatedAt.toISOString(),
            destinations,
            liveUrl: live[0]?.url ?? null,
            /**
             * The state that matters operationally: our pipeline says done, and
             * nothing is on the client's site. It is neither a success nor a
             * recorded failure, so it shows up nowhere else.
             */
            publishedWithoutLink:
              blog.status === "PUBLISH" && live.length === 0,
          };
        }),
      },
      "Command client blogs",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-client-detail",
        event: "blogs_failed",
        businessId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to load client blogs", 500);
  }
}

/**
 * What the client's content actually did in search, when anything is measuring.
 *
 * Only meaningful for an account with Search Console connected, which is six of
 * two thousand. The unconnected case returns `connected: false` and nothing
 * else, so the page can say "nothing is measuring this" instead of drawing an
 * empty chart that reads as zero traffic.
 */
export async function getCommandClientResults(
  req: Request,
  res: Response,
): Promise<void> {
  const businessId = businessIdOf(req);
  if (!businessId) return notFound(res);
  const days = Math.min(
    365,
    Math.max(7, Number.parseInt(String(req.query.days ?? "28"), 10) || 28),
  );

  try {
    const connection = await prisma.businessAnalyticsConfig.findUnique({
      where: { businessId },
      select: {
        gscSiteUrl: true,
        gscLastSyncedAt: true,
        gscLastSyncError: true,
      },
    });
    if (!connection?.gscSiteUrl) {
      sendSuccess(
        res,
        {
          connected: false,
          reason:
            "Search Console is not connected for this account, so no clicks, impressions or positions exist to report.",
        },
        "Command client results",
      );
      return;
    }

    const since = new Date(Date.now() - days * 86_400_000);
    const [totals, byDate, topPages, topQueries] = await Promise.all([
      prisma.searchConsoleMetric.aggregate({
        where: { businessId, date: { gte: since } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        _count: { _all: true },
      }),
      prisma.searchConsoleMetric.groupBy({
        by: ["date"],
        where: { businessId, date: { gte: since } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { date: "asc" },
      }),
      prisma.searchConsoleMetric.groupBy({
        by: ["page"],
        where: { businessId, date: { gte: since }, page: { not: "" } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { clicks: "desc" } },
        take: 50,
      }),
      prisma.searchConsoleMetric.groupBy({
        by: ["query"],
        where: { businessId, date: { gte: since }, query: { not: "" } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { clicks: "desc" } },
        take: 50,
      }),
    ]);

    sendSuccess(
      res,
      {
        connected: true,
        site: connection.gscSiteUrl,
        lastSyncedAt: connection.gscLastSyncedAt?.toISOString() ?? null,
        syncError: connection.gscLastSyncError ?? null,
        windowDays: days,
        ...summariseSearchConsole({ totals, byDate, topPages, topQueries }),
      },
      "Command client results",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-client-detail",
        event: "results_failed",
        businessId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to load client results", 500);
  }
}
