import type { Prisma } from "@prisma/client";
import type { Response } from "express";
import { z, ZodError } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { handleValidationError, sendError, sendSuccess } from "../utils/response.utils";
import { assessGmbConnectionHealth } from "../utils/gmb-connection-health";
import { readTenantCache, writeTenantCache } from "../utils/tenant-response-cache";
import { canViewHistoricalDashboardData } from "../utils/website-workspace-access.utils";

const snapshotSchema = z.object({ businessId: z.string().uuid().optional() }).strict();

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} days ago`;
  return `${Math.floor(seconds / 2592000)} months ago`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "a connected site";
  }
}

export async function getDashboardSnapshot(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const { businessId } = snapshotSchema.parse(req.body ?? {});

    const requestedBusiness = businessId
      ? await prisma.business.findFirst({
          where: { id: businessId, userId },
          select: {
            id: true,
            isPrimary: true,
            isActive: true,
            websiteStatus: true,
            onboardingFlow: true,
            onboardingStatus: true,
            removalStatus: true,
            websiteSubscription: { select: { status: true } },
          },
        })
      : null;
    const business = businessId
      ? requestedBusiness && canViewHistoricalDashboardData(requestedBusiness)
        ? requestedBusiness
        : null
      : await prisma.business.findFirst({
          where: { userId, isPrimary: true, isActive: true },
          select: { id: true, isPrimary: true },
        });

    if (businessId && !business) return sendError(res, "Business not found", 404);

    const targetBusinessId = business?.id;
    const isPrimary = business?.isPrimary ?? false;
    const cachedSnapshot = await readTenantCache<unknown>({
      namespace: "dashboard-snapshot",
      userId,
      businessId: targetBusinessId,
    });
    if (cachedSnapshot) {
      return sendSuccess(res, { snapshot: cachedSnapshot }, "Dashboard snapshot retrieved");
    }
    const blogWhere: Prisma.BlogWhereInput = { userId };
    const planBase: Prisma.PlanWhereInput = { userId, deletedAt: null };
    const backlinkWhere: Prisma.BacklinksWhereInput = {};

    if (targetBusinessId) {
      blogWhere.businessId = targetBusinessId;
      if (isPrimary) {
        planBase.OR = [{ businessId: targetBusinessId }, { businessId: null }];
      } else {
        planBase.businessId = targetBusinessId;
      }
      backlinkWhere.referredBusinessId = targetBusinessId;
      backlinkWhere.sourceBusinessId = { not: targetBusinessId };
    } else {
      planBase.businessId = null;
    }

    const publishingWhere: Prisma.PublishingIntegrationWhereInput = {
      userId,
      isActive: true,
      ...(targetBusinessId
        ? isPrimary
          ? { OR: [{ businessId: targetBusinessId }, { businessId: null }] }
          : { businessId: targetBusinessId }
        : { businessId: null }),
    };

    const [
      totalContent,
      publishedContent,
      totalBacklinks,
      pendingTasks,
      totalKeywords,
      publishingIntegration,
      activeApiToken,
      legacyWordPressIntegration,
      gmbIntegration,
      recentBlogs,
      recentBacklinks,
      recentKeywords,
      upcomingKeywords,
      opportunities,
    ] = await Promise.all([
      targetBusinessId ? prisma.blog.count({ where: blogWhere }) : Promise.resolve(0),
      targetBusinessId
        ? prisma.blog.count({ where: { ...blogWhere, status: "PUBLISH" } })
        : Promise.resolve(0),
      targetBusinessId ? prisma.backlinks.count({ where: backlinkWhere }) : Promise.resolve(0),
      prisma.plan.count({ where: { ...planBase, blogId: null } }),
      prisma.plan.count({ where: planBase }),
      prisma.publishingIntegration.findFirst({ where: publishingWhere, select: { id: true } }),
      targetBusinessId
        ? prisma.apiToken.findFirst({
            where: {
              userId,
              businessId: targetBusinessId,
              isActive: true,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      isPrimary || !targetBusinessId
        ? prisma.wordPressintegration.findUnique({ where: { userId }, select: { id: true } })
        : Promise.resolve(null),
      targetBusinessId
        ? prisma.googleMyBusiness.findUnique({
            where: { businessId: targetBusinessId },
            select: {
              accessToken: true,
              accountId: true,
              locationId: true,
              isActive: true,
              lastSyncAt: true,
              lastSyncError: true,
            },
          })
        : Promise.resolve(null),
      targetBusinessId
        ? prisma.blog.findMany({
            where: blogWhere,
            orderBy: { createdAt: "desc" },
            take: 3,
            select: { id: true, title: true, status: true, createdAt: true },
          })
        : Promise.resolve([]),
      targetBusinessId
        ? prisma.backlinks.findMany({
            where: backlinkWhere,
            orderBy: { createdAt: "desc" },
            take: 2,
            select: { id: true, sourceBlogUrl: true, createdAt: true },
          })
        : Promise.resolve([]),
      prisma.plan.findMany({
        where: { ...planBase, blogId: { not: null } },
        orderBy: { updatedAt: "desc" },
        take: 2,
        select: { id: true, keyword: true, updatedAt: true },
      }),
      prisma.plan.findMany({
        where: {
          ...planBase,
          blogId: null,
          publishDate: { gte: new Date().toISOString().split("T")[0] },
        },
        orderBy: { publishDate: "asc" },
        take: 5,
        select: {
          id: true,
          keyword: true,
          publishDate: true,
          publishTime: true,
          keywordDiffculty: true,
          keywordSearchVolume: true,
        },
      }),
      prisma.plan.findMany({
        where: { ...planBase, blogId: null },
        orderBy: { keywordSearchVolume: "desc" },
        take: 5,
        select: {
          id: true,
          keyword: true,
          publishDate: true,
          keywordDiffculty: true,
          keywordSearchVolume: true,
        },
      }),
    ]);

    const recentActivity = [
      ...recentBlogs.map((blog) => ({
        id: `blog-${blog.id}`,
        type: "content" as const,
        title: blog.title,
        status: blog.status === "PUBLISH" ? ("completed" as const) : ("pending" as const),
        timestamp: formatTimeAgo(blog.createdAt),
        createdAt: blog.createdAt,
      })),
      ...recentBacklinks.map((backlink) => ({
        id: `backlink-${backlink.id}`,
        type: "backlink" as const,
        title: `New managed cross-link from ${extractDomain(backlink.sourceBlogUrl)}`,
        status: "completed" as const,
        timestamp: formatTimeAgo(backlink.createdAt),
        createdAt: backlink.createdAt,
      })),
      ...recentKeywords.map((keyword) => ({
        id: `keyword-${keyword.id}`,
        type: "analysis" as const,
        title: `Content created for "${keyword.keyword}"`,
        status: "completed" as const,
        timestamp: formatTimeAgo(keyword.updatedAt),
        createdAt: keyword.updatedAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5)
      .map(({ createdAt: _createdAt, ...activity }) => activity);

    const publishingConnected = Boolean(
      publishingIntegration || activeApiToken || ((isPrimary || !targetBusinessId) && legacyWordPressIntegration),
    );
    const gmbHealth = assessGmbConnectionHealth({
      accessTokenPresent: Boolean(gmbIntegration?.accessToken),
      isActive: gmbIntegration?.isActive ?? false,
      accountId: gmbIntegration?.accountId,
      locationId: gmbIntegration?.locationId,
      lastSyncAt: gmbIntegration?.lastSyncAt,
      lastSyncError: gmbIntegration?.lastSyncError,
    });

    const snapshot = {
        stats: {
          totalContent,
          publishedContent,
          totalBacklinks,
          pendingTasks,
          totalKeywords,
          publishingConnected,
          wordpressConnected: publishingConnected,
          // A saved OAuth record is not enough to claim the integration is
          // working. `gmbConfigured` records setup, while `gmbConnected`
          // remains the operational signal consumed by legacy clients.
          gmbConnected: gmbHealth.operational,
          gmbConfigured: gmbHealth.configured,
          gmbConnectionState: gmbHealth.state,
          gmbLastSyncAt: gmbHealth.lastSyncAt,
          completionRate: totalContent > 0
            ? Math.round((publishedContent / totalContent) * 100)
            : 0,
        },
        recentActivity,
        upcomingContent: upcomingKeywords.map((keyword) => ({
          id: keyword.id,
          keyword: keyword.keyword,
          publishDate: keyword.publishDate,
          publishTime: keyword.publishTime,
          difficulty: keyword.keywordDiffculty,
          searchVolume: keyword.keywordSearchVolume,
        })),
        keywordOpportunities: opportunities.map((keyword) => ({
          id: keyword.id,
          keyword: keyword.keyword,
          publishDate: keyword.publishDate,
          difficulty: keyword.keywordDiffculty,
          searchVolume: keyword.keywordSearchVolume,
        })),
      };
    await writeTenantCache({
      namespace: "dashboard-snapshot",
      userId,
      businessId: targetBusinessId,
      value: snapshot,
      ttlSeconds: 60,
    });
    return sendSuccess(res, { snapshot }, "Dashboard snapshot retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("[dashboard] Snapshot failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}
