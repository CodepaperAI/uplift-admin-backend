import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import {
  COMMAND_DECISION_DEFINITIONS,
  COMMAND_RECOMMENDED_DECISIONS_INPUT,
  COMMAND_DECISION_WRITE_INPUT,
  getCommandDecisionDefinition,
  parseCommandDecisionValue,
} from "../command/decision-policy";
import {
  assertDecisionMayBeApproved,
  listCommandDecisionCenter,
} from "../command/decision.service";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

export async function getCommandDecisions(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, await listCommandDecisionCenter(), "Command decision center");
  } catch (error) {
    sendError(res, "Failed to load Command decisions", 500, error);
  }
}

export async function createCommandDecision(
  req: Request,
  res: Response,
): Promise<void> {
  const input = COMMAND_DECISION_WRITE_INPUT.safeParse(req.body);
  if (!input.success) {
    sendError(res, "Invalid decision", 400, input.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  const definition = getCommandDecisionDefinition(input.data.key);
  if (!definition) {
    sendError(res, "Invalid decision", 400);
    return;
  }

  let parsedValue: unknown;
  try {
    parsedValue = parseCommandDecisionValue(input.data.key, input.data.value);
    if (input.data.status === "approved") {
      assertDecisionMayBeApproved({
        key: input.data.key,
        isSuperadmin: req.userRole === "SUPERADMIN",
        legalConfirmed: input.data.legalConfirmed,
      });
    }
  } catch (error) {
    sendError(
      res,
      error instanceof Error ? error.message : "Invalid decision",
      req.userRole === "SUPERADMIN" ? 400 : 403,
    );
    return;
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const latest = await tx.commandDecision.findFirst({
        where: { key: input.data.key },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const now = new Date();
      const decision = await tx.commandDecision.create({
        data: {
          key: input.data.key,
          category: definition.category,
          version: (latest?.version ?? 0) + 1,
          status: input.data.status,
          value: parsedValue as Prisma.InputJsonValue,
          requiresLegal: definition.requiresLegal,
          legalConfirmedAt:
            definition.requiresLegal && input.data.legalConfirmed ? now : null,
          legalConfirmedById:
            definition.requiresLegal && input.data.legalConfirmed
              ? req.authUserId
              : null,
          approvedAt: input.data.status === "approved" ? now : null,
          approvedByUserId:
            input.data.status === "approved" ? req.authUserId : null,
          effectiveAt: input.data.effectiveAt,
          notes: input.data.notes ?? null,
          createdByUserId: req.authUserId!,
          updatedByUserId: req.authUserId!,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action:
            input.data.status === "approved"
              ? "command.decision.approve"
              : "command.decision.draft",
          targetType: "command_decision",
          targetId: decision.id,
          before: Prisma.JsonNull,
          after: {
            key: decision.key,
            version: decision.version,
            status: decision.status,
            value: decision.value,
            effectiveAt: decision.effectiveAt,
            requiresLegal: decision.requiresLegal,
            legalConfirmedAt: decision.legalConfirmedAt,
          },
          details: {
            decision: definition.decision,
            legalConfirmationRecorded: decision.legalConfirmedAt !== null,
          },
          ipAddress: req.ip,
        },
      });
      return decision;
    });
    await invalidateCommandCache();
    sendSuccess(res, created, "Command decision recorded", 201);
  } catch (error) {
    sendError(res, "Failed to record Command decision", 500, error);
  }
}

export async function approveRecommendedCommandDecisions(
  req: Request,
  res: Response,
): Promise<void> {
  const input = COMMAND_RECOMMENDED_DECISIONS_INPUT.safeParse(req.body);
  if (!input.success) {
    sendError(res, "Invalid policy-set approval", 400, input.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  const actorId = req.authUserId;

  try {
    for (const definition of COMMAND_DECISION_DEFINITIONS) {
      assertDecisionMayBeApproved({
        key: definition.key,
        isSuperadmin: req.userRole === "SUPERADMIN",
        legalConfirmed: input.data.legalConfirmed,
      });
      parseCommandDecisionValue(definition.key, definition.recommendedValue);
    }
  } catch (error) {
    sendError(
      res,
      error instanceof Error ? error.message : "Could not approve policy set",
      req.userRole === "SUPERADMIN" ? 400 : 403,
    );
    return;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const keys = COMMAND_DECISION_DEFINITIONS.map((definition) => definition.key);
      const [activeRows, versionRows] = await Promise.all([
        tx.commandDecision.findMany({
          where: {
            key: { in: keys },
            status: "approved",
            approvedAt: { not: null },
            effectiveAt: { lte: input.data.effectiveAt },
            OR: [
              { retiredAt: null },
              { retiredAt: { gt: input.data.effectiveAt } },
            ],
          },
          select: { key: true },
        }),
        tx.commandDecision.findMany({
          where: { key: { in: keys } },
          orderBy: [{ key: "asc" }, { version: "desc" }],
          select: { key: true, version: true },
        }),
      ]);
      const activeKeys = new Set(activeRows.map((row) => row.key));
      const latestVersionByKey = new Map<string, number>();
      for (const row of versionRows) {
        if (!latestVersionByKey.has(row.key)) {
          latestVersionByKey.set(row.key, row.version);
        }
      }

      const now = new Date();
      const created: Array<{ id: string; key: string; version: number }> = [];
      for (const definition of COMMAND_DECISION_DEFINITIONS) {
        if (activeKeys.has(definition.key)) continue;
        const decision = await tx.commandDecision.create({
          data: {
            key: definition.key,
            category: definition.category,
            version: (latestVersionByKey.get(definition.key) ?? 0) + 1,
            status: "approved",
            value: definition.recommendedValue as Prisma.InputJsonValue,
            requiresLegal: definition.requiresLegal,
            legalConfirmedAt: definition.requiresLegal ? now : null,
            legalConfirmedById: definition.requiresLegal ? actorId : null,
            approvedAt: now,
            approvedByUserId: actorId,
            effectiveAt: input.data.effectiveAt,
            notes:
              input.data.notes ??
              "Approved as part of the recommended Command operating policy set.",
            createdByUserId: actorId,
            updatedByUserId: actorId,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminUserId: actorId,
            action: "command.decision.approve_recommended",
            targetType: "command_decision",
            targetId: decision.id,
            before: Prisma.JsonNull,
            after: {
              key: decision.key,
              version: decision.version,
              status: decision.status,
              value: decision.value,
              effectiveAt: decision.effectiveAt,
              requiresLegal: decision.requiresLegal,
              legalConfirmedAt: decision.legalConfirmedAt,
            },
            details: {
              decision: definition.decision,
              approvalMode: "recommended_policy_set",
              legalConfirmationRecorded: decision.legalConfirmedAt !== null,
            },
            ipAddress: req.ip,
          },
        });
        created.push({
          id: decision.id,
          key: decision.key,
          version: decision.version,
        });
      }

      return {
        created,
        skipped: activeKeys.size,
        total: COMMAND_DECISION_DEFINITIONS.length,
      };
    });
    await invalidateCommandCache();
    sendSuccess(res, result, "Recommended operating policies approved", 201);
  } catch (error) {
    sendError(res, "Failed to approve recommended operating policies", 500, error);
  }
}
