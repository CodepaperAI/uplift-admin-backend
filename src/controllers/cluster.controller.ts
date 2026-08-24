import type { Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { sendError, sendSuccess } from "../utils/response.utils";

export async function getClustersByBusiness(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);

    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId, isActive: true },
    });
    if (!business) return sendError(res, "Business not found", 404);

    const clusters = await prisma.contentCluster.findMany({
      where: { businessId, userId },
      include: {
        keywords: {
          where: { deletedAt: null },
          select: {
            id: true,
            keyword: true,
            clusterRole: true,
            publishDate: true,
            blogId: true,
            keywordSearchVolume: true,
            keywordDiffculty: true,
          },
          orderBy: { publishDate: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const clusterSummaries = clusters.map((c) => {
      const pillar = c.keywords.find((k) => k.clusterRole === "pillar");
      const clusterKeywords = c.keywords.filter((k) => k.clusterRole === "cluster");
      const publishedCount = c.keywords.filter((k) => k.blogId).length;

      return {
        id: c.id,
        name: c.name,
        description: c.description,
        pillarKeyword: pillar ? {
          id: pillar.id,
          keyword: pillar.keyword,
          hasBlob: !!pillar.blogId,
          publishDate: pillar.publishDate,
        } : null,
        keywordCount: c.keywords.length,
        publishedCount,
        pendingCount: c.keywords.length - publishedCount,
        keywords: c.keywords.map((k) => ({
          id: k.id,
          keyword: k.keyword,
          role: k.clusterRole || "cluster",
          hasBlog: !!k.blogId,
          publishDate: k.publishDate,
          searchVolume: k.keywordSearchVolume,
          difficulty: k.keywordDiffculty,
        })),
      };
    });

    // Also get unclustered keywords count
    const unclusteredCount = await prisma.plan.count({
      where: {
        businessId,
        userId,
        clusterId: null,
        deletedAt: null,
      },
    });

    return sendSuccess(res, {
      clusters: clusterSummaries,
      totalClusters: clusters.length,
      unclusteredKeywords: unclusteredCount,
    }, "Clusters retrieved successfully");
  } catch (error) {
    console.error("Error fetching clusters:", error);
    return sendError(res, "Failed to fetch clusters", 500);
  }
}

export async function getClusterDetails(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);

    const { clusterId } = req.body;
    if (!clusterId) return sendError(res, "clusterId is required", 400);

    const cluster = await prisma.contentCluster.findFirst({
      where: { id: clusterId, userId },
      include: {
        keywords: {
          where: { deletedAt: null },
          select: {
            id: true,
            keyword: true,
            clusterRole: true,
            publishDate: true,
            publishTime: true,
            blogId: true,
            keywordSearchVolume: true,
            keywordDiffculty: true,
            keywordIntent: true,
            keywordCategory: true,
            blog: {
              select: {
                id: true,
                title: true,
                slug: true,
                seoScore: true,
                status: true,
              },
            },
          },
          orderBy: [{ clusterRole: "asc" }, { publishDate: "asc" }],
        },
        blogs: {
          select: {
            id: true,
            title: true,
            slug: true,
            seoScore: true,
            clusterRole: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!cluster) return sendError(res, "Cluster not found", 404);

    return sendSuccess(res, cluster, "Cluster details retrieved");
  } catch (error) {
    console.error("Error fetching cluster details:", error);
    return sendError(res, "Failed to fetch cluster details", 500);
  }
}
