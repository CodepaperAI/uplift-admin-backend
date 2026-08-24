import type { Response } from "express";
import type { Prisma } from "@prisma/client";

import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  hasDashboardAccess,
  resolvePostAuthDestination,
} from "../utils/post-auth-destination";
import { sendError, sendSuccess } from "../utils/response.utils";

function privateResponse(res: Response) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

function fail(res: Response, error: unknown, operation: string) {
  console.error(`[account-context] ${operation} failed:`, error);
  return sendError(res, "Request could not be completed", 500);
}

const dashboardAccessSelect = {
  onboarding: true,
  business: {
    where: {
      OR: [
        { isActive: true },
        {
          onboardingStatus: {
            in: [
              "queued",
              "running",
              "awaiting_confirmation",
              "completed",
              "failed",
            ],
          },
        },
      ],
    },
    select: {
      businessWebsiteUrl: true,
      isActive: true,
      onboardingFlow: true,
      onboardingStatus: true,
      websiteStatus: true,
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.UserSelect;

export async function getAccountContext(req: AuthenticatedRequest, res: Response) {
  privateResponse(res);
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: {
        id: true,
        role: true,
        AgencyMemberships: {
          where: { isActive: true },
          select: { agencyId: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    if (!user) return sendError(res, "Not available", 404);
    return sendSuccess(res, {
      id: user.id,
      role: user.role,
      agencyId: user.role === "AGENCY_ADMIN"
        ? user.AgencyMemberships[0]?.agencyId ?? null
        : null,
    });
  } catch (error) {
    return fail(res, error, "context");
  }
}

export async function getAccountSecurity(req: AuthenticatedRequest, res: Response) {
  privateResponse(res);
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: {
        emailVerified: true,
        accounts: { select: { providerId: true, password: true } },
      },
    });
    if (!user) return sendError(res, "Not available", 404);
    return sendSuccess(res, {
      hasCredentialAccount: user.accounts.some(
        (account) =>
          account.providerId === "credential" &&
          typeof account.password === "string" &&
          account.password.length > 0,
      ),
      linkedProviders: [...new Set(user.accounts.map((account) => account.providerId))],
      emailVerified: user.emailVerified,
    });
  } catch (error) {
    return fail(res, error, "security");
  }
}

export async function getPostAuthDestination(req: AuthenticatedRequest, res: Response) {
  privateResponse(res);
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const [resumable, user] = await Promise.all([
      prisma.quickScrapeBusiness.findFirst({
        where: {
          userId: req.authUserId,
          onboardingV2LastSeenAt: { not: null },
          onboardingV2Status: {
            in: ["in_progress", "preview_ready", "awaiting_payment"],
          },
        },
        select: { id: true, onboardingV2Flow: true },
        orderBy: [{ onboardingV2LastSeenAt: "desc" }, { updatedAt: "desc" }],
      }),
      prisma.user.findUnique({
        where: { id: req.authUserId },
        select: dashboardAccessSelect,
      }),
    ]);
    if (!user) return sendError(res, "Not available", 404);
    const dashboardAccess = hasDashboardAccess({
      onboarding: user.onboarding,
      businesses: user.business,
    });
    return sendSuccess(res, {
      resumeOnboarding: Boolean(resumable),
      destination: resolvePostAuthDestination(resumable, dashboardAccess),
    });
  } catch (error) {
    return fail(res, error, "post-auth destination");
  }
}

export async function getDashboardAccess(req: AuthenticatedRequest, res: Response) {
  privateResponse(res);
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: dashboardAccessSelect,
    });
    if (!user) return sendError(res, "Not available", 404);
    const hasAccess = hasDashboardAccess({
      onboarding: user.onboarding,
      businesses: user.business,
    });
    return sendSuccess(res, { hasAccess });
  } catch (error) {
    return fail(res, error, "dashboard access");
  }
}
