/**
 * offpage.controller.ts
 *
 * HTTP surface for the off-page strategy engine:
 *   GET  /api/v1/off-page/opportunities?businessId=...  → ranked queue
 *   POST /api/v1/off-page/opportunity-status            → set status
 *
 * Mirrors the dr-dashboard controller pattern (getDatabaseUserId + sendSuccess/
 * sendError). The GET is read-only; status reads degrade gracefully if the
 * OffPageOpportunity migration hasn't been applied yet.
 */

import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { getDatabaseUserId } from "../utils/user.utils";
import { getOffPageOpportunities } from "../services/offpage/offpage-opportunities.service";
import {
  getOpportunityStatuses,
  isValidStatus,
  mergeStatuses,
  setOpportunityStatus,
  setOpportunityVerification,
  type PersistedStatus,
} from "../services/offpage/offpage-status.service";
import { verifyOpportunityOutcome } from "../services/offpage/offpage-outcome-verifier";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";

export async function getOffPageOpportunitiesHandler(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    const businessId = req.query.businessId as string | undefined;
    if (!userId) return sendError(res, "User ID is required", 400);
    if (!businessId) return sendError(res, "businessId is required", 400);

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) return sendError(res, "User not found", 404);

    const refresh = req.query.refresh === "true";
    const result = await getOffPageOpportunities(databaseUserId, businessId, {
      refresh,
    });
    if (!result.profile) return sendError(res, "Business not found", 404);

    // Merge persisted statuses; degrade gracefully if the table isn't migrated.
    let statuses = new Map<string, PersistedStatus>();
    try {
      statuses = await getOpportunityStatuses(businessId);
    } catch (err) {
      console.warn(
        "⚠️ Off-page status read failed (table not migrated?):",
        (err as Error).message,
      );
    }

    return sendSuccess(res, {
      profile: result.profile,
      opportunities: mergeStatuses(result.opportunities, statuses),
      appliedLevers: result.appliedLevers,
      emptyReason: result.emptyReason,
      generating: result.generating ?? false,
      generatedAt: result.generatedAt ?? null,
      qualitySummary: result.qualitySummary ?? null,
    });
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
}

export async function updateOffPageOpportunityStatusHandler(
  req: Request,
  res: Response,
) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    const { businessId, opportunityKey, leverKey, status, dismissReason } = (req.body ?? {}) as {
      businessId?: string;
      opportunityKey?: string;
      leverKey?: string;
      status?: string;
      dismissReason?: string | null;
    };
    if (!userId) return sendError(res, "User ID is required", 400);
    if (!businessId || !opportunityKey || !leverKey || !status) {
      return sendError(
        res,
        "businessId, opportunityKey, leverKey and status are required",
        400,
      );
    }
    if (!isValidStatus(status)) {
      return sendError(res, "Invalid status", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) return sendError(res, "User not found", 404);

    // Ownership check before any write.
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: databaseUserId },
      select: { id: true },
    });
    if (!business) return sendError(res, "Business not found", 404);

    await setOpportunityStatus(
      businessId,
      opportunityKey,
      leverKey,
      status,
      dismissReason,
    );
    return sendSuccess(res, { ok: true, opportunityKey, status });
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
}

/**
 * Outcome verification: the user pastes the URL of what they actually did (their
 * Reddit thread/comment, or their new directory listing) and we re-fetch it to
 * confirm it's live — instead of blind-trusting the "done" toggle.
 */
export async function verifyOffPageOpportunityHandler(
  req: Request,
  res: Response,
) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    const { businessId, opportunityKey, leverKey, url } = (req.body ?? {}) as {
      businessId?: string;
      opportunityKey?: string;
      leverKey?: string;
      url?: string;
    };
    if (!userId) return sendError(res, "User ID is required", 400);
    if (!businessId || !opportunityKey || !leverKey || !url) {
      return sendError(
        res,
        "businessId, opportunityKey, leverKey and url are required",
        400,
      );
    }

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) return sendError(res, "User not found", 404);

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: databaseUserId },
      select: { id: true, businessName: true },
    });
    if (!business) return sendError(res, "Business not found", 404);

    const outcome = await verifyOpportunityOutcome(
      leverKey,
      url,
      business.businessName ?? "",
    );
    await setOpportunityVerification(businessId, opportunityKey, leverKey, {
      verificationStatus: outcome.status,
      evidenceUrl: url,
      evidence: outcome.evidence,
    });

    return sendSuccess(res, {
      opportunityKey,
      verificationStatus: outcome.status,
      evidence: outcome.evidence,
    });
  } catch (err) {
    return sendError(res, (err as Error).message, 500);
  }
}
