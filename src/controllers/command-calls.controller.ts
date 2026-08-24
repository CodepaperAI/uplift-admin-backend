import type { Request, Response } from "express";
import { z } from "zod";
import { resolveApprovedCommandDecisions } from "../command/decision.service";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/admin-client";
import {
  invalidateCommandCache,
  readCommandCache,
  writeCommandCache,
} from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

const monthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

async function coachingVisibility() {
  const decisions = await resolveApprovedCommandDecisions();
  const value = decisions.coaching_visibility?.value;
  return value && typeof value === "object" && !Array.isArray(value) && "visibility" in value
    ? value.visibility
    : null;
}

async function resolveCallScope(req: Request, requestedRepId?: string | null) {
  const capabilities = req.commandCapabilities ?? [];
  if (capabilities.includes("view.coaching")) return requestedRepId ?? null;
  const visibility = await coachingVisibility();
  if (
    visibility === "rep_own" &&
    capabilities.includes("view.own.coaching") &&
    req.commandRepId &&
    (!requestedRepId || requestedRepId === req.commandRepId)
  ) {
    return req.commandRepId;
  }
  throw new Error("FORBIDDEN_CALL_SCOPE");
}

export async function getCommandCalls(req: Request, res: Response): Promise<void> {
  try {
    const requestedRepId = typeof req.query.repId === "string" ? req.query.repId : null;
    const repId = await resolveCallScope(req, requestedRepId);
    const namespace = `calls-v1:${repId ?? "all"}`;
    const cached = await readCommandCache<unknown>(namespace);
    if (cached) {
      sendSuccess(res, cached, "Command calls");
      return;
    }
    const calls = await prisma.commandCall.findMany({
      where: repId ? { repId } : undefined,
      include: {
        rep: { select: { id: true, name: true } },
        account: { select: { id: true, name: true } },
        reviews: { orderBy: { generatedAt: "desc" }, take: 1 },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    const payload = {
      calls: calls.map((call) => ({
        id: call.id,
        provider: call.provider,
        rep: call.rep,
        account: call.account,
        title: call.title,
        startedAt: call.startedAt,
        durationSeconds: call.durationSeconds,
        participantCount: call.participantEmails.length,
        summary: call.summary,
        actionItems: call.actionItems,
        transcriptUrl: call.transcriptUrl,
        recordingUrl: call.recordingUrl,
        reviewStatus: call.reviewStatus,
        review: call.reviews[0]
          ? { ...call.reviews[0], score: call.reviews[0].score?.toString() ?? null }
          : null,
      })),
      scope: repId ? "rep" : "team",
    };
    await writeCommandCache(namespace, payload, 60);
    sendSuccess(res, payload, "Command calls");
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN_CALL_SCOPE") {
      sendError(res, "Forbidden", 403);
      return;
    }
    sendError(res, "Failed to load Command calls", 500, error);
  }
}

export async function retryCommandCallReview(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const call = await prisma.commandCall.findUnique({
      where: { id: req.params.id },
      select: { id: true, repId: true, provider: true },
    });
    if (!call) {
      sendError(res, "Call not found", 404);
      return;
    }
    const scopeRepId = await resolveCallScope(req, call.repId);
    if (scopeRepId && call.repId !== scopeRepId) {
      sendError(res, "Forbidden", 403);
      return;
    }
    await prisma.commandCall.update({
      where: { id: call.id },
      data: { reviewStatus: "pending" },
    });
    await inngest.send({
      name: "command/call.review.requested",
      data: { callId: call.id, provider: call.provider },
    });
    await invalidateCommandCache();
    sendSuccess(res, { accepted: true }, "Call review queued", 202);
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN_CALL_SCOPE") {
      sendError(res, "Forbidden", 403);
      return;
    }
    sendError(res, "Call review could not be queued", 500, error);
  }
}

export async function getCommandCoachingBriefs(
  req: Request,
  res: Response,
): Promise<void> {
  const parsedMonth = monthInput.safeParse(req.query.month);
  if (!parsedMonth.success) {
    sendError(res, "Month must use YYYY-MM", 400);
    return;
  }
  try {
    const requestedRepId = typeof req.query.repId === "string" ? req.query.repId : null;
    const repId = await resolveCallScope(req, requestedRepId);
    const briefs = await prisma.commandCoachingBrief.findMany({
      where: {
        periodMonth: parsedMonth.data,
        ...(repId ? { repId } : {}),
      },
      include: { rep: { select: { id: true, name: true } } },
      orderBy: { generatedAt: "desc" },
    });
    sendSuccess(res, { briefs }, "Command coaching briefs");
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN_CALL_SCOPE") {
      sendError(res, "Forbidden", 403);
      return;
    }
    sendError(res, "Failed to load coaching briefs", 500, error);
  }
}

export async function requestCommandCoachingBrief(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = z
    .object({ repId: z.string().uuid(), periodMonth: monthInput })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid coaching request", 400, parsed.error);
    return;
  }
  try {
    const scopeRepId = await resolveCallScope(req, parsed.data.repId);
    if (scopeRepId && scopeRepId !== parsed.data.repId) {
      sendError(res, "Forbidden", 403);
      return;
    }
    await inngest.send({
      name: "command/coaching-brief.requested",
      data: parsed.data,
    });
    await invalidateCommandCache();
    sendSuccess(res, { accepted: true }, "Coaching brief queued", 202);
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN_CALL_SCOPE") {
      sendError(res, "Forbidden", 403);
      return;
    }
    sendError(res, "Coaching brief could not be queued", 500, error);
  }
}
