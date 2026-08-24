import { DROutreachStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import { processInboundReply } from "../services/dr-outreach.service";
import { sendError, sendSuccess } from "../utils/response.utils";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { verifyOutreachUnsubscribeToken } from "../utils/outreach-unsubscribe-token";
import { z } from "zod";

const DR_QUERY = z.object({
  businessId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

async function resolveDRBusiness(userId: string, businessId?: string) {
  return prisma.business.findFirst({
    where: {
      userId,
      ...(businessId ? { id: businessId } : { isPrimary: true }),
      isActive: true,
    },
    select: { id: true, businessName: true },
  });
}

/**
 * GET /api/v1/dr-dashboard/:userId/overview
 * Get DR growth dashboard data for a business.
 */
export async function getDROverview(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    const query = DR_QUERY.parse(req.query);
    const businessId = query.businessId;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (req.params.userId && req.params.userId !== userId) return sendError(res, "Unauthorized", 403);

    // Find the business
    const business = await resolveDRBusiness(userId, businessId);

    if (!business) return sendError(res, "Business not found", 404);

    // Get current DR from backlink summary
    const backlinkSummary = await prisma.externalBacklinkSummary.findUnique({
      where: { businessId: business.id },
    });

    // Get DR action stats for this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [actionStats, contentOptimizations, outreachCampaigns, linkRecoveries] =
      await Promise.all([
        // Action counts by type this month
        prisma.dRActionLog.groupBy({
          by: ["actionType"],
          where: {
            businessId: business.id,
            createdAt: { gte: startOfMonth },
            status: "COMPLETED",
          },
          _count: true,
        }),

        // Content optimizations
        prisma.dRContentOptimization.count({
          where: {
            businessId: business.id,
            status: "COMPLETED",
          },
        }),

        // Active outreach campaigns
        prisma.dROutreachCampaign.groupBy({
          by: ["status"],
          where: { businessId: business.id },
          _count: true,
        }),

        // Link recoveries
        prisma.dRLinkRecovery.groupBy({
          by: ["reclaimStatus"],
          where: { businessId: business.id },
          _count: true,
        }),
      ]);

    // Build DR trend (last 6 months of action logs with DR snapshots)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const drHistory = await prisma.dRActionLog.findMany({
      where: {
        businessId: business.id,
        businessDR: { not: null },
        createdAt: { gte: sixMonthsAgo },
      },
      select: {
        businessDR: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      distinct: ["businessDR"],
    });

    // Format response
    const actionsThisMonth: Record<string, number> = {};
    for (const stat of actionStats) {
      actionsThisMonth[stat.actionType] = stat._count;
    }

    const outreachByStatus: Record<string, number> = {};
    for (const stat of outreachCampaigns) {
      outreachByStatus[stat.status] = stat._count;
    }

    const recoveryByStatus: Record<string, number> = {};
    for (const stat of linkRecoveries) {
      recoveryByStatus[stat.reclaimStatus] = stat._count;
    }

    return sendSuccess(res, {
      businessId: business.id,
      businessName: business.businessName,
      currentDR: backlinkSummary?.averageDomainAuthority ?? null,
      totalBacklinks: backlinkSummary?.totalBacklinks ?? 0,
      totalReferringDomains: backlinkSummary?.totalReferringDomains ?? 0,
      newBacklinksThisMonth: backlinkSummary?.newBacklinksThisMonth ?? 0,
      lostBacklinksThisMonth: backlinkSummary?.lostBacklinksThisMonth ?? 0,
      growthRate: backlinkSummary?.growthRate ?? null,
      lastSyncedAt: backlinkSummary?.lastSyncedAt ?? null,
      drTrend: drHistory.map((h) => ({
        dr: h.businessDR,
        date: h.createdAt,
      })),
      actionsThisMonth,
      totalContentOptimizations: contentOptimizations,
      outreach: outreachByStatus,
      linkRecovery: recoveryByStatus,
    });
  } catch (error: any) {
    console.error("[DR Dashboard] Error fetching overview:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * GET /api/v1/dr-dashboard/:userId/actions
 * Get recent DR actions for a business.
 */
export async function getDRActions(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    const query = DR_QUERY.parse(req.query);
    const businessId = query.businessId;
    const limit = query.limit ?? 20;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (req.params.userId && req.params.userId !== userId) return sendError(res, "Unauthorized", 403);

    const business = await resolveDRBusiness(userId, businessId);

    if (!business) return sendError(res, "Business not found", 404);

    const actions = await prisma.dRActionLog.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return sendSuccess(res, { actions });
  } catch (error: any) {
    console.error("[DR Dashboard] Error fetching actions:", error);
    return sendError(res, error.message, 500);
  }
}

export async function getDROutreachCampaigns(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const query = DR_QUERY.parse(req.query);
    const business = await resolveDRBusiness(userId, query.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const campaigns = await prisma.dROutreachCampaign.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 50,
      select: {
        id: true,
        publisherDomain: true,
        publisherEmail: true,
        publisherDA: true,
        status: true,
        pitchSubject: true,
        proposedTopic: true,
        sentAt: true,
        respondedAt: true,
        responseContent: true,
        createdAt: true,
      },
    });
    return sendSuccess(res, { campaigns });
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(res, "Request validation failed", 400);
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function getDRContentOptimizations(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const query = DR_QUERY.parse(req.query);
    const business = await resolveDRBusiness(userId, query.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const optimizations = await prisma.dRContentOptimization.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 50,
      select: {
        id: true,
        blogId: true,
        optimizationType: true,
        drRangeStrategy: true,
        status: true,
        createdAt: true,
        blog: { select: { title: true } },
      },
    });
    return sendSuccess(res, {
      optimizations: optimizations.map(({ blog, ...item }) => ({ ...item, blogTitle: blog.title })),
    });
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(res, "Request validation failed", 400);
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function getDRLinkRecoveries(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const query = DR_QUERY.parse(req.query);
    const business = await resolveDRBusiness(userId, query.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    const recoveries = await prisma.dRLinkRecovery.findMany({
      where: { businessId: business.id },
      orderBy: { lostAt: "desc" },
      take: query.limit ?? 50,
      select: {
        id: true,
        sourceUrl: true,
        sourceDomain: true,
        targetUrl: true,
        domainAuthority: true,
        lostAt: true,
        reason: true,
        reclaimStatus: true,
        recoveredAt: true,
        createdAt: true,
      },
    });
    return sendSuccess(res, { recoveries });
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(res, "Request validation failed", 400);
    return sendError(res, "Request could not be completed", 500);
  }
}

/**
 * POST /api/v1/dr-dashboard/inbound-webhook
 * Resend inbound email webhook handler for outreach reply tracking.
 */
export async function handleInboundWebhook(req: Request, res: Response) {
  try {
    const { from, to, subject, text } = req.body;

    if (!from || !to || !text) {
      return sendError(res, "Missing required fields", 400);
    }

    const result = await processInboundReply({
      fromEmail: typeof from === "string" ? from : from.email || from[0]?.email,
      toAddress: typeof to === "string" ? to : to[0]?.email || to[0],
      subject: subject || "",
      body: text,
    });

    // If the reply was an acceptance, trigger guest content generation
    if (result.success && result.intent === "accepted" && result.campaignId) {
      await inngest.send({
        name: "dr/generate-guest-content",
        data: { campaignId: result.campaignId },
      });
    }

    console.log(
      `[DR Inbound] Processed reply: campaign=${result.campaignId}, intent=${result.intent}`,
    );
    return sendSuccess(res, result);
  } catch (error: any) {
    console.error("[DR Inbound] Webhook error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * GET /api/v1/dr-dashboard/unsubscribe
 * Handle unsubscribe requests from outreach emails.
 */
export async function handleUnsubscribe(req: Request, res: Response) {
  try {
    const campaignId = verifyOutreachUnsubscribeToken(req.query.token);
    if (!campaignId) {
      return res.status(400).send("Invalid unsubscribe link");
    }

    const campaign = await prisma.dROutreachCampaign.findUnique({
      where: { id: campaignId },
    });

    if (campaign) {
      await prisma.dROutreachCampaign.update({
        where: { id: campaignId },
        data: { status: DROutreachStatus.REJECTED },
      });
    }

    return res.status(200).send(
      "<html><body><h2>Unsubscribed</h2><p>You have been unsubscribed and will not receive further outreach from this sender.</p></body></html>"
    );
  } catch (error: any) {
    return res.status(500).send("An error occurred processing your request");
  }
}
