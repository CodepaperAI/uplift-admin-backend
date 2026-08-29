import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";

/**
 * Every client account, with what each one actually has behind it.
 *
 * The searchable index for the per-client view: pick a client here, open their
 * account. Each row says what that account will contain before it is opened —
 * how many blogs, how much social, whether Search Console is connected — so an
 * empty account is visible as empty rather than discovered by clicking into it.
 *
 * Counts come from grouped reads over the whole client base rather than a query
 * per client. A per-client fan-out at 500+ businesses is 2,000 queries for one
 * page, which is how a list view becomes a minute-long request.
 */

/** A client base of a few hundred; the cap is a runaway guard, not a limit. */
const MAX_CLIENTS_SCANNED = 2_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function getCommandClients(
  req: Request,
  res: Response,
): Promise<void> {
  const search = text(req.query.search);
  const { page, pageSize, skip } = parseCommandPagination({
    page: req.query.page,
    pageSize: req.query.pageSize,
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const where: Prisma.BusinessWhereInput = search
    ? {
        OR: [
          { businessName: { contains: search, mode: "insensitive" } },
          { businessWebsiteUrl: { contains: search, mode: "insensitive" } },
          { User: { email: { contains: search, mode: "insensitive" } } },
          { User: { name: { contains: search, mode: "insensitive" } } },
        ],
      }
    : {};

  try {
    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: pageSize,
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          businessCity: true,
          businessCountry: true,
          isActive: true,
          isPrimary: true,
          createdAt: true,
          userId: true,
          User: { select: { id: true, email: true, name: true } },
        },
      }),
      prisma.business.count({ where }),
    ]);

    const ids = businesses.map((business) => business.id);
    // Grouped once over the page's ids, not once per client.
    const [blogs, publishedBlogs, socialAttempts, socialAccounts, analytics] =
      ids.length === 0
        ? [[], [], [], [], []]
        : await Promise.all([
            prisma.blog.groupBy({
              by: ["businessId", "status"],
              where: { businessId: { in: ids } },
              _count: { _all: true },
              _max: { createdAt: true },
            }),
            prisma.publishedBlog.groupBy({
              by: ["status"],
              where: { blog: { businessId: { in: ids } } },
              _count: { _all: true },
            }),
            prisma.socialPublishAttempt.groupBy({
              by: ["businessId", "status"],
              where: { businessId: { in: ids } },
              _count: { _all: true },
              _max: { publishedAt: true },
            }),
            prisma.socialPublisherAccount.groupBy({
              by: ["businessId"],
              where: { businessId: { in: ids }, isActive: true },
              _count: { _all: true },
            }),
            /**
             * Whether this client's results are knowable at all.
             *
             * `gscSiteUrl` being set is what makes per-blog clicks, impressions
             * and position possible; without it the results question has no
             * answer for that client, and the account view should say so rather
             * than render an empty chart.
             */
            prisma.businessAnalyticsConfig.findMany({
              where: { businessId: { in: ids } },
              select: {
                businessId: true,
                gscSiteUrl: true,
                gscLastSyncedAt: true,
                gscLastSyncError: true,
                ga4PropertyId: true,
                lastSyncedAt: true,
              },
            }),
          ]);

    const blogsBy = new Map<string, { total: number; published: number; lastAt: Date | null }>();
    for (const row of blogs) {
      const current = blogsBy.get(row.businessId) ?? {
        total: 0,
        published: 0,
        lastAt: null,
      };
      current.total += row._count._all;
      if (row.status === "PUBLISH") current.published += row._count._all;
      const at = row._max.createdAt;
      if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
      blogsBy.set(row.businessId, current);
    }

    const socialBy = new Map<
      string,
      { attempts: number; published: number; failed: number; lastAt: Date | null }
    >();
    for (const row of socialAttempts) {
      const current = socialBy.get(row.businessId) ?? {
        attempts: 0,
        published: 0,
        failed: 0,
        lastAt: null,
      };
      current.attempts += row._count._all;
      if (row.status === "PUBLISHED") current.published += row._count._all;
      if (row.status === "FAILED") current.failed += row._count._all;
      const at = row._max.publishedAt;
      if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
      socialBy.set(row.businessId, current);
    }

    const accountsBy = new Map(
      socialAccounts.map((row) => [row.businessId, row._count._all]),
    );
    const analyticsBy = new Map(analytics.map((row) => [row.businessId, row]));

    const rows = businesses.map((business) => {
      const blog = blogsBy.get(business.id);
      const social = socialBy.get(business.id);
      const connection = analyticsBy.get(business.id);
      return {
        businessId: business.id,
        businessName: business.businessName,
        websiteUrl: business.businessWebsiteUrl,
        city: business.businessCity,
        country: business.businessCountry,
        isActive: business.isActive,
        isPrimary: business.isPrimary,
        createdAt: business.createdAt.toISOString(),
        owner: {
          userId: business.User?.id ?? business.userId,
          email: business.User?.email ?? null,
          name: business.User?.name ?? null,
        },
        blogs: {
          total: blog?.total ?? 0,
          published: blog?.published ?? 0,
          lastCreatedAt: blog?.lastAt?.toISOString() ?? null,
        },
        social: {
          attempts: social?.attempts ?? 0,
          published: social?.published ?? 0,
          failed: social?.failed ?? 0,
          connectedAccounts: accountsBy.get(business.id) ?? 0,
          lastPublishedAt: social?.lastAt?.toISOString() ?? null,
        },
        results: {
          searchConsoleConnected: Boolean(connection?.gscSiteUrl),
          searchConsoleSite: connection?.gscSiteUrl ?? null,
          searchConsoleLastSyncedAt:
            connection?.gscLastSyncedAt?.toISOString() ?? null,
          searchConsoleError: connection?.gscLastSyncError ?? null,
          analyticsConnected: Boolean(connection?.ga4PropertyId),
        },
      };
    });

    sendSuccess(
      res,
      {
        pagination: commandPaginationResult({ page, pageSize, total }),
        search,
        clients: rows,
        /**
         * Coverage across the whole client base, not the page. It answers the
         * question that decides what the account view can even show: how many
         * clients have connected the data that makes results knowable.
         */
        coverage: await clientCoverage(),
      },
      "Command clients",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-clients",
        event: "clients_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to load clients", 500);
  }
}

async function clientCoverage() {
  const [businesses, withGsc, withGa4, gscRows, gscBusinesses, aiReferral] =
    await Promise.all([
      prisma.business.count(),
      prisma.businessAnalyticsConfig.count({
        where: { gscSiteUrl: { not: null } },
      }),
      prisma.businessAnalyticsConfig.count({
        where: { ga4PropertyId: { not: null } },
      }),
      prisma.searchConsoleMetric.count(),
      prisma.searchConsoleMetric
        .groupBy({ by: ["businessId"], _count: { _all: true } })
        .then((rows) => rows.length),
      prisma.aiReferralTraffic.count(),
    ]);
  return {
    businesses,
    searchConsoleConnected: withGsc,
    analyticsConnected: withGa4,
    searchConsoleRows: gscRows,
    searchConsoleBusinessesWithData: gscBusinesses,
    aiReferralRows: aiReferral,
    scanCap: MAX_CLIENTS_SCANNED,
  };
}
