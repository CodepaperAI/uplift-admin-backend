import type { Request, Response } from "express";
import { hashPassword } from "better-auth/crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  COMMAND_REP_CREATE_INPUT,
  COMMAND_REP_UPDATE_INPUT,
  normalizeOptionalText,
} from "../command/rep-input";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

const SALES_ACCOUNT_INPUT = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z
      .string()
      .min(12)
      .max(128)
      .regex(/[a-z]/)
      .regex(/[A-Z]/)
      .regex(/[0-9]/)
      .regex(/[^A-Za-z0-9]/),
  })
  .strict();

function repAuditShape(rep: {
  name: string;
  basePay: Prisma.Decimal | null;
  currency: string | null;
  ghlUserId: string | null;
  startDate: Date;
  endDate: Date | null;
  isActive: boolean;
}) {
  return {
    name: rep.name,
    basePay: rep.basePay?.toString() ?? null,
    currency: rep.currency,
    ghlUserId: rep.ghlUserId,
    startDate: rep.startDate,
    endDate: rep.endDate,
    isActive: rep.isActive,
  };
}

function serializeRep<T extends { basePay: Prisma.Decimal | null }>(rep: T) {
  return { ...rep, basePay: rep.basePay?.toString() ?? null };
}

export async function getCommandReps(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const [reps, unlinkedSalesUsers, legacySalespeople] = await Promise.all([
      prisma.commandRepProfile.findMany({
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              commandPanelEnabled: true,
            },
          },
        },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.user.findMany({
        where: { role: "SALES", CommandRepProfile: { is: null } },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      }),
      req.userRole === "SUPERADMIN"
        ? prisma.user.findMany({
            where: { role: "SALES" },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              name: true,
              email: true,
              createdAt: true,
              _count: {
                select: {
                  SalesCustomerAssignments: true,
                  SalesEntries: true,
                },
              },
              SalesEntries: { select: { amountCents: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    sendSuccess(
      res,
      { reps: reps.map(serializeRep), unlinkedSalesUsers, legacySalespeople },
      "Command reps",
    );
  } catch (error) {
    sendError(res, "Failed to load Command reps", 500, error);
  }
}

export async function createCommandSalesAccount(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.userRole !== "SUPERADMIN" || !req.authUserId) {
    sendError(res, "Forbidden", 403);
    return;
  }
  const parsed = SALES_ACCOUNT_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid account details", 400);
    return;
  }

  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name: parsed.data.name,
          email: parsed.data.email,
          role: "SALES",
          commandPanelEnabled: true,
        },
        select: { id: true, name: true, email: true, createdAt: true },
      });
      await tx.account.create({
        data: {
          userId: createdUser.id,
          accountId: createdUser.id,
          providerId: "credential",
          password: passwordHash,
        },
      });
      await tx.commandRepProfile.create({
        data: {
          userId: createdUser.id,
          name: createdUser.name,
          startDate: new Date(),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "sales_account.create",
          targetType: "User",
          targetId: createdUser.id,
          details: {
            email: createdUser.email,
            role: "SALES",
            commandPanelEnabled: true,
            commandRepProfileCreated: true,
          },
          ipAddress: req.ip,
        },
      });
      return createdUser;
    });
    await invalidateCommandCache();
    sendSuccess(res, { user }, "Sales account created", 201);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      sendError(res, "An account with this email already exists", 409);
      return;
    }
    sendError(res, "Sales account could not be created", 500, error);
  }
}

export async function createCommandRep(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_REP_CREATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid rep profile", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: { id: true, role: true, name: true, email: true, CommandRepProfile: { select: { id: true } } },
    });
    if (!user) {
      sendError(res, "Sales user not found", 404);
      return;
    }
    if (user.role !== "SALES") {
      sendError(res, "Only an existing SALES user can be linked to a rep profile", 409);
      return;
    }
    if (user.CommandRepProfile) {
      sendError(res, "This sales user already has a rep profile", 409);
      return;
    }

    const created = await prisma.$transaction(async (tx) => {
      const rep = await tx.commandRepProfile.create({
        data: {
          userId: user.id,
          name: parsed.data.name,
          basePay:
            parsed.data.basePay === undefined || parsed.data.basePay === null
              ? null
              : new Prisma.Decimal(parsed.data.basePay),
          currency: parsed.data.currency ?? null,
          ghlUserId: normalizeOptionalText(parsed.data.ghlUserId) ?? null,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate ?? null,
          isActive: parsed.data.isActive,
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true, commandPanelEnabled: true },
          },
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { commandPanelEnabled: parsed.data.isActive },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.rep.create",
          targetType: "command_rep_profile",
          targetId: rep.id,
          before: Prisma.JsonNull,
          after: {
            ...repAuditShape(rep),
            userId: user.id,
            email: user.email,
            role: user.role,
            commandPanelEnabled: parsed.data.isActive,
          },
          details: {
            before: null,
            after: {
              ...repAuditShape(rep),
              userId: user.id,
              email: user.email,
              role: user.role,
              commandPanelEnabled: parsed.data.isActive,
            },
          },
          ipAddress: req.ip,
        },
      });
      return rep;
    });

    await invalidateCommandCache();
    sendSuccess(res, serializeRep(created), "Command rep created", 201);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      sendError(res, "This user or GHL user is already linked to another rep", 409);
      return;
    }
    sendError(res, "Failed to create Command rep", 500, error);
  }
}

export async function updateCommandRep(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_REP_UPDATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid rep profile", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const existing = await prisma.commandRepProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, email: true, role: true, commandPanelEnabled: true } } },
    });
    if (!existing) {
      sendError(res, "Rep profile not found", 404);
      return;
    }
    const effectiveStartDate = parsed.data.startDate ?? existing.startDate;
    const effectiveEndDate =
      parsed.data.endDate !== undefined ? parsed.data.endDate : existing.endDate;
    if (effectiveEndDate && effectiveEndDate < effectiveStartDate) {
      sendError(res, "End date must be on or after the start date", 400);
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const rep = await tx.commandRepProfile.update({
        where: { id: existing.id },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.basePay !== undefined
            ? {
                basePay:
                  parsed.data.basePay === null
                    ? null
                    : new Prisma.Decimal(parsed.data.basePay),
              }
            : {}),
          ...(parsed.data.currency !== undefined
            ? { currency: parsed.data.currency }
            : {}),
          ...(parsed.data.ghlUserId !== undefined
            ? { ghlUserId: normalizeOptionalText(parsed.data.ghlUserId) }
            : {}),
          ...(parsed.data.startDate !== undefined
            ? { startDate: parsed.data.startDate }
            : {}),
          ...(parsed.data.endDate !== undefined
            ? { endDate: parsed.data.endDate }
            : {}),
          ...(parsed.data.isActive !== undefined
            ? { isActive: parsed.data.isActive }
            : {}),
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true, commandPanelEnabled: true },
          },
        },
      });
      if (parsed.data.isActive !== undefined) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { commandPanelEnabled: parsed.data.isActive },
        });
      }
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.rep.update",
          targetType: "command_rep_profile",
          targetId: existing.id,
          before: {
            ...repAuditShape(existing),
            commandPanelEnabled: existing.user.commandPanelEnabled,
          },
          after: {
            ...repAuditShape(rep),
            commandPanelEnabled:
              parsed.data.isActive ?? existing.user.commandPanelEnabled,
          },
          details: {
            before: {
              ...repAuditShape(existing),
              commandPanelEnabled: existing.user.commandPanelEnabled,
            },
            after: {
              ...repAuditShape(rep),
              commandPanelEnabled:
                parsed.data.isActive ?? existing.user.commandPanelEnabled,
            },
          },
          ipAddress: req.ip,
        },
      });
      return rep;
    });

    await invalidateCommandCache();
    sendSuccess(res, serializeRep(updated), "Command rep updated");
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      sendError(res, "This GHL user is already linked to another rep", 409);
      return;
    }
    sendError(res, "Failed to update Command rep", 500, error);
  }
}
