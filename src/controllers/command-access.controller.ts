import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db.config";
import {
  COMMAND_CAPABILITIES,
  isCommandPanelRole,
  resolveCommandCapabilities,
  type CommandPanelRole,
} from "../command/access-control";
import { sendError, sendSuccess } from "../utils/response.utils";

const ROLE_ORDER: CommandPanelRole[] = [
  "SUPERADMIN",
  "ADMIN",
  "SALES",
  "USER",
];

const UPDATE_GRANTS = z
  .object({
    grants: z
      .array(
        z.object({
          capability: z.enum(COMMAND_CAPABILITIES),
          enabled: z.boolean(),
        }),
      )
      .min(1),
  })
  .strict();

export async function getCommandSession(
  req: Request,
  res: Response,
): Promise<void> {
  sendSuccess(
    res,
    {
      userId: req.authUserId,
      role: req.userRole,
      repId: req.commandRepId ?? null,
      capabilities: req.commandCapabilities ?? [],
    },
    "Command session",
  );
}

export async function getCommandAccessMatrix(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const overrides = await prisma.commandRoleCapability.findMany({
      where: { role: { in: ROLE_ORDER } },
      select: {
        role: true,
        capability: true,
        enabled: true,
        updatedAt: true,
      },
      orderBy: [{ role: "asc" }, { capability: "asc" }],
    });

    const byRole = new Map<CommandPanelRole, typeof overrides>();
    for (const role of ROLE_ORDER) byRole.set(role, []);
    for (const row of overrides) {
      if (!isCommandPanelRole(row.role)) continue;
      byRole.get(row.role)?.push(row);
    }

    sendSuccess(
      res,
      {
        capabilities: COMMAND_CAPABILITIES,
        roles: ROLE_ORDER.map((role) => ({
          role,
          capabilities: resolveCommandCapabilities(role, byRole.get(role) ?? []),
          overrides: byRole.get(role) ?? [],
        })),
      },
      "Command access matrix",
    );
  } catch (error) {
    sendError(res, "Failed to load Command access matrix", 500, error);
  }
}

export async function updateCommandRoleCapabilities(
  req: Request,
  res: Response,
): Promise<void> {
  const role = req.params.role;
  if (!role || !isCommandPanelRole(role)) {
    sendError(res, "Unknown Command role", 400);
    return;
  }

  const parsed = UPDATE_GRANTS.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid capability grants", 400, parsed.error);
    return;
  }

  const uniqueCapabilities = new Set(
    parsed.data.grants.map((grant) => grant.capability),
  );
  if (uniqueCapabilities.size !== parsed.data.grants.length) {
    sendError(res, "Each capability may be supplied only once", 400);
    return;
  }

  if (
    role === "SUPERADMIN" &&
    parsed.data.grants.some((grant) => !grant.enabled)
  ) {
    sendError(res, "SUPERADMIN capabilities cannot be disabled", 409);
    return;
  }

  const actorUserId = req.authUserId;
  if (!actorUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const changedCapabilities = parsed.data.grants.map(
      (grant) => grant.capability,
    );
    const before = await prisma.commandRoleCapability.findMany({
      where: { role, capability: { in: changedCapabilities } },
      select: { capability: true, enabled: true },
      orderBy: { capability: "asc" },
    });

    await prisma.$transaction(async (tx) => {
      for (const grant of parsed.data.grants) {
        await tx.commandRoleCapability.upsert({
          where: {
            role_capability: {
              role,
              capability: grant.capability,
            },
          },
          create: {
            role,
            capability: grant.capability,
            enabled: grant.enabled,
            updatedByUserId: actorUserId,
          },
          update: {
            enabled: grant.enabled,
            updatedByUserId: actorUserId,
          },
        });
      }

      await tx.adminAuditLog.create({
        data: {
          adminUserId: actorUserId,
          action: "command.permissions.update",
          targetType: "command_role",
          targetId: role,
          before,
          after: parsed.data.grants,
          details: {
            before,
            after: parsed.data.grants,
          },
          ipAddress: req.ip,
        },
      });
    });

    const after = await prisma.commandRoleCapability.findMany({
      where: { role },
      select: { capability: true, enabled: true, updatedAt: true },
      orderBy: { capability: "asc" },
    });

    sendSuccess(
      res,
      {
        role,
        capabilities: resolveCommandCapabilities(role, after),
        overrides: after,
      },
      "Command role capabilities updated",
    );
  } catch (error) {
    sendError(res, "Failed to update Command role capabilities", 500, error);
  }
}
