import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { type CommandCapability } from "../command/access-control";
import {
  calculateAndPersistCommissionRun,
  CommandCommissionBlockedError,
} from "../command/commission-run.service";
import { currentCommandMonth } from "../command/toronto-period";
import { prisma } from "../config/db.config";
import {
  invalidateCommandCache,
  readCommandCache,
  writeCommandCache,
} from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const CALCULATE_INPUT = z.object({ month: MONTH }).strict();

function serializeSnapshot<T extends Record<string, unknown>>(snapshot: T) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      value instanceof Prisma.Decimal ? value.toString() : value,
    ]),
  );
}

export function resolveCommissionRepScope(input: {
  requestedRepId: string | null;
  capabilities: readonly CommandCapability[];
  actorRepId: string | null;
}):
  | { allowed: true; repId: string | null }
  | { allowed: false } {
  const requested = input.requestedRepId;
  const capabilities = input.capabilities;
  const canViewAll =
    capabilities.includes("view.team.all") ||
    capabilities.includes("view.financials");
  if (requested) {
    return canViewAll ||
      (capabilities.includes("view.own.financials") &&
        input.actorRepId === requested)
      ? { allowed: true, repId: requested }
      : { allowed: false };
  }
  if (canViewAll) return { allowed: true, repId: null };
  return capabilities.includes("view.own.financials") && input.actorRepId
    ? { allowed: true, repId: input.actorRepId }
    : { allowed: false };
}

function requestedRepScope(req: Request) {
  return resolveCommissionRepScope({
    requestedRepId: typeof req.query.repId === "string" ? req.query.repId : null,
    capabilities: req.commandCapabilities ?? [],
    actorRepId: req.commandRepId ?? null,
  });
}

export async function getCommandCommissions(
  req: Request,
  res: Response,
): Promise<void> {
  const month = typeof req.query.month === "string" ? req.query.month : currentCommandMonth();
  if (!MONTH.safeParse(month).success) {
    sendError(res, "Invalid commission month", 400);
    return;
  }
  const scope = requestedRepScope(req);
  if (!scope.allowed) {
    sendError(res, "Forbidden rep scope", 403);
    return;
  }
  try {
    const canViewConfiguration =
      req.userRole === "SUPERADMIN" ||
      (req.commandCapabilities ?? []).includes("view.financials");
    const cacheKey = `commissions-v1:${month}:${scope.repId ?? "all"}:${canViewConfiguration ? "config" : "redacted"}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command commissions");
      return;
    }
    const run = await prisma.commandCommissionRun.findUnique({
      where: { periodMonth: month },
      include: {
        repSnapshots: {
          where: scope.repId ? { repId: scope.repId } : undefined,
          include: { rep: { select: { id: true, name: true } } },
          orderBy: [{ rep: { name: "asc" } }, { currency: "asc" }],
        },
        lines: {
          where: scope.repId ? { repId: scope.repId } : undefined,
          include: {
            rep: { select: { id: true, name: true } },
            service: { select: { id: true, key: true, name: true } },
          },
          orderBy: [{ repId: "asc" }, { kind: "asc" }, { lineKey: "asc" }],
          take: 5000,
        },
      },
    });
    const payload = run
        ? {
            run: {
              id: run.id,
              periodMonth: run.periodMonth,
              status: run.status,
              sourceFactsThrough: run.sourceFactsThrough,
              calculatedAt: run.calculatedAt,
              lockedAt: run.lockedAt,
              configurationSnapshot:
                canViewConfiguration
                  ? run.configurationSnapshot
                  : undefined,
            },
            snapshots: run.repSnapshots.map(serializeSnapshot),
            lines: run.lines.map(serializeSnapshot),
          }
        : { run: null, snapshots: [], lines: [] };
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command commissions");
  } catch (error) {
    sendError(res, "Failed to load Command commissions", 500, error);
  }
}

export async function calculateCommandCommissions(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = CALCULATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid commission calculation", 400);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  if (parsed.data.month > currentCommandMonth()) {
    sendError(res, "A future commission period cannot be calculated", 409);
    return;
  }
  try {
    const result = await calculateAndPersistCommissionRun({
      periodMonth: parsed.data.month,
      actorUserId: req.authUserId,
      ipAddress: req.ip,
    });
    await invalidateCommandCache();
    sendSuccess(res, result, "Commission run calculated");
  } catch (error) {
    if (error instanceof CommandCommissionBlockedError) {
      res.status(409).json({
        success: false,
        message: "Commission calculation is blocked",
        data: { calculated: false, blockers: error.blockers },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    sendError(res, "Failed to calculate Command commissions", 500, error);
  }
}

export async function lockCommandCommissionRun(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.userRole !== "SUPERADMIN" || !req.authUserId) {
    sendError(res, "Forbidden", 403);
    return;
  }
  try {
    const existing = await prisma.commandCommissionRun.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { repSnapshots: true } } },
    });
    if (!existing) {
      sendError(res, "Commission run not found", 404);
      return;
    }
    if (existing.status === "locked") {
      sendSuccess(res, existing, "Commission run is already locked");
      return;
    }
    if (existing._count.repSnapshots === 0) {
      sendError(res, "An empty commission run cannot be locked", 409);
      return;
    }
    const now = new Date();
    const locked = await prisma.$transaction(async (tx) => {
      const updated = await tx.commandCommissionRun.update({
        where: { id: existing.id },
        data: {
          status: "locked",
          lockedAt: now,
          lockedByUserId: req.authUserId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.commission.lock",
          targetType: "command_commission_run",
          targetId: updated.id,
          before: { status: existing.status, lockedAt: existing.lockedAt },
          after: { status: updated.status, lockedAt: updated.lockedAt },
          ipAddress: req.ip,
        },
      });
      return updated;
    });
    await invalidateCommandCache();
    sendSuccess(res, locked, "Commission run locked");
  } catch (error) {
    sendError(res, "Failed to lock Command commission run", 500, error);
  }
}
