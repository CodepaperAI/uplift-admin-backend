import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { COMMAND_ACTIVITY_INPUT } from "../command/activity-input";
import { activityRatios } from "../command/activity-metrics";
import { canAccessRepScope } from "../command/access-control";
import { commandMonthRange, currentCommandMonth } from "../command/toronto-period";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";

function monthQuery(req: Request): string {
  return typeof req.query.month === "string" ? req.query.month : currentCommandMonth();
}

async function authorizedRepIds(req: Request): Promise<string[] | null> {
  const capabilities = req.commandCapabilities ?? [];
  if (capabilities.includes("view.team.all") || capabilities.includes("view.pipeline.all")) return null;
  if (capabilities.includes("view.own") && req.commandRepId) return [req.commandRepId];
  return [];
}

export async function getCommandActivity(req: Request, res: Response): Promise<void> {
  try {
    const periodMonth = monthQuery(req);
    const period = commandMonthRange(periodMonth);
    const allowedRepIds = await authorizedRepIds(req);
    if (allowedRepIds?.length === 0) {
      sendError(res, "Activity access required", 403);
      return;
    }
    const reps = await prisma.commandRepProfile.findMany({
      where: { isActive: true, ...(allowedRepIds ? { id: { in: allowedRepIds } } : {}) },
      select: { id: true, name: true, ghlUserId: true },
      orderBy: { name: "asc" },
    });
    const repIds = reps.map((rep) => rep.id);
    const entries = await prisma.commandRepActivity.findMany({
      where: { repId: { in: repIds }, periodMonth },
      orderBy: [{ repId: "asc" }, { source: "asc" }],
    });
    const wonByGhlUser = await prisma.commandGhlOpportunity.groupBy({
      by: ["assignedToGhlId"],
      where: {
        isActive: true,
        status: "won",
        assignedToGhlId: { not: null },
        lastStatusChangeAt: { gte: period.start, lt: period.end },
      },
      _count: { _all: true },
    });
    const wonCounts = new Map(wonByGhlUser.map((row) => [row.assignedToGhlId, row._count._all]));

    const rows = reps.map((rep) => {
      const sources = entries.filter((entry) => entry.repId === rep.id);
      const effective = sources.find((entry) => entry.source === "manual") ?? sources.find((entry) => entry.source === "ghl_sync") ?? null;
      const counts = effective ?? { calls: 0, connects: 0, meetingsBooked: 0, meetingsHeld: 0 };
      const closes = rep.ghlUserId ? wonCounts.get(rep.ghlUserId) ?? 0 : 0;
      return {
        rep: { id: rep.id, name: rep.name },
        periodMonth,
        source: effective?.source ?? "none",
        calls: counts.calls,
        connects: counts.connects,
        meetingsBooked: counts.meetingsBooked,
        meetingsHeld: counts.meetingsHeld,
        closes,
        ...activityRatios(counts, closes),
      };
    });
    sendSuccess(res, { period, scope: allowedRepIds ? "rep" : "company", rows }, "Command activity");
  } catch (error) {
    const status = error instanceof Error && error.message.includes("YYYY-MM") ? 400 : 500;
    sendError(res, "Failed to load Command activity", status, error);
  }
}

export async function upsertCommandActivity(req: Request, res: Response): Promise<void> {
  const parsed = COMMAND_ACTIVITY_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid activity", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  if (!canAccessRepScope({ capabilities: req.commandCapabilities ?? [], actorRepId: req.commandRepId ?? null, requestedRepId: parsed.data.repId })) {
    sendError(res, "Forbidden rep scope", 403);
    return;
  }
  try {
    const rep = await prisma.commandRepProfile.findFirst({ where: { id: parsed.data.repId, isActive: true }, select: { id: true } });
    if (!rep) {
      sendError(res, "Rep not found", 404);
      return;
    }
    const existing = await prisma.commandRepActivity.findUnique({
      where: { repId_periodMonth_source: { repId: rep.id, periodMonth: parsed.data.periodMonth, source: "manual" } },
    });
    const saved = await prisma.$transaction(async (tx) => {
      const activity = await tx.commandRepActivity.upsert({
        where: { repId_periodMonth_source: { repId: rep.id, periodMonth: parsed.data.periodMonth, source: "manual" } },
        create: { ...parsed.data, source: "manual", updatedByUserId: req.authUserId },
        update: { calls: parsed.data.calls, connects: parsed.data.connects, meetingsBooked: parsed.data.meetingsBooked, meetingsHeld: parsed.data.meetingsHeld, updatedByUserId: req.authUserId },
      });
      const before = existing ? { calls: existing.calls, connects: existing.connects, meetingsBooked: existing.meetingsBooked, meetingsHeld: existing.meetingsHeld, periodMonth: existing.periodMonth, source: existing.source } : null;
      const after = { calls: activity.calls, connects: activity.connects, meetingsBooked: activity.meetingsBooked, meetingsHeld: activity.meetingsHeld, periodMonth: activity.periodMonth, source: activity.source };
      await tx.adminAuditLog.create({ data: { adminUserId: req.authUserId!, action: existing ? "command.activity.update" : "command.activity.create", targetType: "command_rep_activity", targetId: activity.id, before: before ?? Prisma.JsonNull, after, details: { before, after }, ipAddress: req.ip } });
      return activity;
    });
    sendSuccess(res, saved, existing ? "Command activity updated" : "Command activity created", existing ? 200 : 201);
  } catch (error) {
    sendError(res, "Failed to save Command activity", 500, error);
  }
}
