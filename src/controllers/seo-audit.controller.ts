import type { Response } from "express";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  GET_AUDIT_STATUS_PARAMS,
  GET_LATEST_AUDIT_PARAMS,
  TRIGGER_SEO_AUDIT_SCHEMA,
} from "../validators/seo-audit.validation";
import { ZodError } from "zod";

export async function triggerSeoAudit(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.authUserId;
    if (!userId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const payload = TRIGGER_SEO_AUDIT_SCHEMA.parse(req.body);

    const business = await prisma.business.findFirst({
      where: { id: payload.businessId, userId, isActive: true },
      select: { id: true, businessWebsiteUrl: true, businessName: true },
    });

    if (!business) {
      sendError(res, "Business not found or access denied", 404);
      return;
    }

    const activeRun = await prisma.seoAuditRun.findFirst({
      where: {
        businessId: payload.businessId,
        userId,
        status: { in: ["pending", "running"] },
      },
    });

    if (activeRun) {
      sendError(
        res,
        "An audit is already in progress for this business",
        409,
      );
      return;
    }

    const run = await prisma.seoAuditRun.create({
      data: {
        userId,
        businessId: payload.businessId,
        status: "pending",
        modulesRequested: payload.modules,
        progress: 0,
      },
    });

    await inngest.send({
      name: "seo-audit/run-complete",
      data: {
        runId: run.id,
        userId,
        businessId: payload.businessId,
        websiteUrl: business.businessWebsiteUrl,
        businessName: business.businessName,
        modules: payload.modules,
      },
    });

    sendSuccess(
      res,
      {
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
      },
      "SEO audit triggered successfully",
      202,
    );
  } catch (error) {
    if (error instanceof ZodError) {
      handleValidationError(res, error);
      return;
    }
    console.error("Error triggering SEO audit:", error);
    sendError(res, "Failed to trigger SEO audit", 500);
  }
}

export async function getSeoAuditStatus(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.authUserId;
    if (!userId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const params = GET_AUDIT_STATUS_PARAMS.parse(req.params);

    const run = await prisma.seoAuditRun.findFirst({
      where: { id: params.runId, userId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        error: true,
        summaryScore: true,
        currentModule: true,
        progress: true,
        modulesRequested: true,
        report: true,
        modelUsed: true,
        tokenUsage: true,
        runtimeMs: true,
      },
    });

    if (!run) {
      sendError(res, "Audit run not found or access denied", 404);
      return;
    }

    sendSuccess(res, run, "Audit status retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      handleValidationError(res, error);
      return;
    }
    console.error("Error fetching audit status:", error);
    sendError(res, "Failed to fetch audit status", 500);
  }
}

export async function getLatestSeoAudit(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.authUserId;
    if (!userId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const params = GET_LATEST_AUDIT_PARAMS.parse(req.params);

    const business = await prisma.business.findFirst({
      where: { id: params.businessId, userId, isActive: true },
      select: { id: true },
    });

    if (!business) {
      sendError(res, "Business not found or access denied", 404);
      return;
    }

    const latestRun = await prisma.seoAuditRun.findFirst({
      where: { businessId: params.businessId, userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        error: true,
        summaryScore: true,
        currentModule: true,
        progress: true,
        modulesRequested: true,
        report: true,
        modelUsed: true,
        tokenUsage: true,
        runtimeMs: true,
      },
    });

    if (!latestRun) {
      sendSuccess(res, null, "No audit runs found for this business");
      return;
    }

    sendSuccess(res, latestRun, "Latest audit retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      handleValidationError(res, error);
      return;
    }
    console.error("Error fetching latest audit:", error);
    sendError(res, "Failed to fetch latest audit", 500);
  }
}

export async function getSeoAuditHistory(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.authUserId;
    if (!userId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const params = GET_LATEST_AUDIT_PARAMS.parse(req.params);

    const business = await prisma.business.findFirst({
      where: { id: params.businessId, userId, isActive: true },
      select: { id: true },
    });

    if (!business) {
      sendError(res, "Business not found or access denied", 404);
      return;
    }

    const runs = await prisma.seoAuditRun.findMany({
      where: { businessId: params.businessId, userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        summaryScore: true,
        modulesRequested: true,
        runtimeMs: true,
      },
    });

    sendSuccess(res, runs, "Audit history retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      handleValidationError(res, error);
      return;
    }
    console.error("Error fetching audit history:", error);
    sendError(res, "Failed to fetch audit history", 500);
  }
}
