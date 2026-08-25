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

    let claimedAssignments = 0;
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

      /**
       * Claim the assignment history this GHL id already owns.
       *
       * `CommandGhlLeadAssignment.repId` is resolved when the row is written,
       * and the sync only writes a row when an opportunity is first seen or
       * reassigned. So linking a rep to a GHL id does nothing for the deals
       * that id already holds — they keep the `null` they were written with,
       * and the leaderboard reports zero for a rep holding hundreds of
       * opportunities until each one happens to move. Measured on production
       * that was 259 opportunities for one rep and 232 for another.
       *
       * Only ever fills a null, and only for the exact id being linked, so it
       * cannot take a deal away from another rep or rewrite attribution history
       * that was already decided.
       */
      if (
        parsed.data.ghlUserId !== undefined &&
        normalizeOptionalText(parsed.data.ghlUserId)
      ) {
        const ghlUserId = normalizeOptionalText(parsed.data.ghlUserId)!;
        claimedAssignments = (
          await tx.commandGhlLeadAssignment.updateMany({
            where: { assignedToGhlId: ghlUserId, repId: null },
            data: { repId: existing.id },
          })
        ).count;
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
    sendSuccess(
      res,
      // The count is returned rather than silently applied: a link that quietly
      // moved 259 deals onto a rep is something the caller should see.
      { ...serializeRep(updated), claimedAssignments },
      "Command rep updated",
    );
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

const PROMOTE_TO_REP_INPUT = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    /** Overrides the name on the account, which is often a signup typo. */
    name: z.string().trim().min(2).max(100).optional(),
    startDate: z.coerce.date().optional(),
    basePay: z.number().finite().nonnegative().optional(),
    currency: z.string().trim().length(3).toLowerCase().optional(),
    ghlUserId: z.string().trim().max(120).optional(),
  })
  .strict();

/**
 * Promotes an existing account to a sales rep.
 *
 * `createCommandSalesAccount` cannot be used for someone who already has a
 * login: `User.email` is unique, so it fails outright. And `createCommandRep`
 * refuses anyone whose role is not already SALES. Between those two there was no
 * path for the common case — a rep who signed up through the product first,
 * usually to look at it, and now needs to be staff.
 *
 * No password is involved. The account keeps the credentials it already has,
 * which is the point: promoting someone must not silently reset how they log in.
 *
 * **Refuses anyone carrying customer data.** A role change moves an account from
 * the product side to the internal side, and doing that to a real customer would
 * take their own workspace away from them. An account with a business, a
 * published blog or a live subscription is therefore rejected rather than
 * promoted, with the counts in the error so whoever asked can see why. Deciding
 * that a paying customer is really a staff member is not a decision an endpoint
 * should make.
 */
export async function promoteUserToRep(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.userRole !== "SUPERADMIN" || !req.authUserId) {
    sendError(res, "Forbidden", 403);
    return;
  }
  const parsed = PROMOTE_TO_REP_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid promotion request", 400, parsed.error);
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        CommandRepProfile: { select: { id: true } },
        _count: { select: { business: true, Blog: true } },
      },
    });
    if (!user) {
      sendError(res, "No account exists with this email", 404);
      return;
    }
    if (user.CommandRepProfile) {
      sendError(res, "This account already has a rep profile", 409);
      return;
    }
    if (user.role === "SUPERADMIN") {
      sendError(res, "A superadmin cannot be demoted to a sales rep", 409);
      return;
    }

    const liveSubscription = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        status: { in: ["active", "trialing", "past_due"] },
      },
      select: { id: true, status: true },
    });
    if (
      user._count.business > 0 ||
      user._count.Blog > 0 ||
      liveSubscription
    ) {
      sendError(
        res,
        "This account has customer data, so it will not be converted automatically",
        409,
        {
          businesses: user._count.business,
          blogs: user._count.Blog,
          subscriptionStatus: liveSubscription?.status ?? null,
        },
      );
      return;
    }

    const rep = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          role: "SALES",
          commandPanelEnabled: true,
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
        },
      });
      const created = await tx.commandRepProfile.create({
        data: {
          userId: user.id,
          name: parsed.data.name ?? user.name,
          startDate: parsed.data.startDate ?? new Date(),
          basePay:
            parsed.data.basePay === undefined
              ? null
              : new Prisma.Decimal(parsed.data.basePay),
          currency: parsed.data.currency ?? null,
          ghlUserId: normalizeOptionalText(parsed.data.ghlUserId) ?? null,
        },
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
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "sales_account.promote",
          targetType: "User",
          targetId: user.id,
          details: {
            email: user.email,
            previousRole: user.role,
            previousName: user.name,
            role: "SALES",
            renamedTo: parsed.data.name ?? null,
            commandRepProfileCreated: true,
          },
          ipAddress: req.ip,
        },
      });
      return created;
    });

    await invalidateCommandCache();
    sendSuccess(res, { rep }, "Account promoted to sales rep", 201);
  } catch (error) {
    sendError(res, "Account could not be promoted", 500, error);
  }
}
