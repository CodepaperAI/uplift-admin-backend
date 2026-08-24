import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";
import { commandMonthForDate, currentCommandMonth } from "../command/toronto-period";

const PROVIDERS = ["stripe", "ghl", "legacy"] as const;
const FIELDS = [
  "serviceId",
  "ownerRepId",
  "amountMinor",
  "currency",
  "startedAt",
  "canceledAt",
  "isPastDueInPeriod",
  "commissionAdjustmentMinor",
] as const;
const ENTITY_TYPES_BY_PROVIDER = {
  stripe: ["stripe_subscription"],
  ghl: ["ghl_subscription", "ghl_transaction"],
  legacy: ["legacy_sale"],
} as const;

const OVERRIDE_INPUT = z
  .object({
    provider: z.enum(PROVIDERS),
    entityType: z.enum([
      "stripe_subscription",
      "ghl_subscription",
      "ghl_transaction",
      "legacy_sale",
    ]),
    entityId: z.string().trim().min(1).max(255),
    field: z.enum(FIELDS),
    value: z.unknown(),
    reason: z.string().trim().min(10).max(2000),
    effectiveAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!(ENTITY_TYPES_BY_PROVIDER[value.provider] as readonly string[]).includes(value.entityType)) {
      context.addIssue({
        code: "custom",
        path: ["entityType"],
        message: "Source type does not belong to the selected provider",
      });
    }
    if (value.expiresAt && value.expiresAt <= value.effectiveAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry must be after the effective time",
      });
    }
    if (["serviceId", "ownerRepId"].includes(value.field)) {
      if (typeof value.value !== "string" || !z.string().uuid().safeParse(value.value).success) {
        context.addIssue({ code: "custom", path: ["value"], message: "A UUID is required" });
      }
    }
    if (["amountMinor", "commissionAdjustmentMinor"].includes(value.field) && !z.string().regex(/^-?\d+(?:\.\d{1,4})?$/).safeParse(value.value).success) {
      context.addIssue({ code: "custom", path: ["value"], message: "Exact minor units are required" });
    }
    if (
      value.field === "commissionAdjustmentMinor" &&
      commandMonthForDate(value.effectiveAt) !== currentCommandMonth()
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveAt"],
        message: "Commission adjustments must post in the current open Toronto month",
      });
    }
    if (value.field === "currency" && !z.string().regex(/^[A-Za-z]{3}$/).safeParse(value.value).success) {
      context.addIssue({ code: "custom", path: ["value"], message: "A three-letter currency is required" });
    }
    if (["startedAt", "canceledAt"].includes(value.field) && value.value !== null && !z.coerce.date().safeParse(value.value).success) {
      context.addIssue({ code: "custom", path: ["value"], message: "An ISO date or null is required" });
    }
    if (value.field === "isPastDueInPeriod" && typeof value.value !== "boolean") {
      context.addIssue({ code: "custom", path: ["value"], message: "A boolean is required" });
    }
  });

export async function getCommandOverrides(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const rows = await prisma.commandDataOverride.findMany({
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      take: 500,
    });
    sendSuccess(res, { overrides: rows }, "Command data overrides");
  } catch (error) {
    sendError(res, "Failed to load Command data overrides", 500, error);
  }
}

export async function createCommandOverride(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.userRole !== "SUPERADMIN" || !req.authUserId) {
    sendError(res, "Forbidden", 403);
    return;
  }
  const parsed = OVERRIDE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid data override", 400, parsed.error);
    return;
  }
  try {
    if (parsed.data.field === "serviceId") {
      const service = await prisma.commandService.findUnique({
        where: { id: String(parsed.data.value) },
        select: { id: true },
      });
      if (!service) {
        sendError(res, "Service not found", 404);
        return;
      }
    }
    if (parsed.data.field === "ownerRepId") {
      const rep = await prisma.commandRepProfile.findUnique({
        where: { id: String(parsed.data.value) },
        select: { id: true },
      });
      if (!rep) {
        sendError(res, "Rep not found", 404);
        return;
      }
    }
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.commandDataOverride.create({
        data: {
          provider: parsed.data.provider,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          field: parsed.data.field,
          value:
            parsed.data.value === null
              ? Prisma.JsonNull
              : (parsed.data.value as Prisma.InputJsonValue),
          reason: parsed.data.reason,
          effectiveAt: parsed.data.effectiveAt,
          expiresAt: parsed.data.expiresAt ?? null,
          approvedByUserId: req.authUserId!,
          createdByUserId: req.authUserId!,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.data_override.approve",
          targetType: "command_data_override",
          targetId: row.id,
          before: Prisma.JsonNull,
          after: {
            provider: row.provider,
            entityType: row.entityType,
            entityId: row.entityId,
            field: row.field,
            value: row.value,
            reason: row.reason,
            effectiveAt: row.effectiveAt,
            expiresAt: row.expiresAt,
          },
          ipAddress: req.ip,
        },
      });
      return row;
    });
    await invalidateCommandCache();
    sendSuccess(res, created, "Command data override approved", 201);
  } catch (error) {
    sendError(res, "Failed to create Command data override", 500, error);
  }
}
