import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/db.config";
import { invalidateCommandCache } from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

const CREDIT_INPUT = z
  .object({
    sourceType: z.enum([
      "stripe_subscription",
      "ghl_subscription",
      "ghl_transaction",
      "legacy_sale",
    ]),
    sourceId: z.string().trim().min(1).max(255),
    serviceId: z.string().uuid().nullable().optional(),
    effectiveFrom: z.coerce.date(),
    allocations: z
      .array(
        z.object({
          repId: z.string().uuid(),
          creditShare: z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/),
        }).strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = new Set(value.allocations.map((allocation) => allocation.repId));
    if (unique.size !== value.allocations.length) {
      context.addIssue({ code: "custom", path: ["allocations"], message: "A rep may appear only once" });
    }
    const sum = value.allocations.reduce(
      (total, allocation) => total.add(allocation.creditShare),
      new Prisma.Decimal(0),
    );
    if (!sum.eq(1)) {
      context.addIssue({ code: "custom", path: ["allocations"], message: "Credit shares must total exactly 1" });
    }
  });

export async function getCommandDealCredits(req: Request, res: Response): Promise<void> {
  const sourceType = typeof req.query.sourceType === "string" ? req.query.sourceType.trim() : "";
  const sourceId = typeof req.query.sourceId === "string" ? req.query.sourceId.trim() : "";
  try {
    const credits = await prisma.commandDealCredit.findMany({
      where: {
        ...(sourceType ? { sourceType } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
      include: {
        rep: { select: { id: true, name: true } },
        service: { select: { id: true, key: true, name: true } },
      },
      orderBy: [{ effectiveFrom: "desc" }, { sourceType: "asc" }, { sourceId: "asc" }],
      take: 1000,
    });
    sendSuccess(res, { credits }, "Command deal credits");
  } catch (error) {
    sendError(res, "Failed to load Command deal credits", 500, error);
  }
}

export async function createCommandDealCredits(req: Request, res: Response): Promise<void> {
  if (req.userRole !== "SUPERADMIN" || !req.authUserId) {
    sendError(res, "Forbidden", 403);
    return;
  }
  const parsed = CREDIT_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid deal credit allocation", 400, parsed.error);
    return;
  }
  try {
    const [repCount, service] = await Promise.all([
      prisma.commandRepProfile.count({
        where: { id: { in: parsed.data.allocations.map((allocation) => allocation.repId) } },
      }),
      parsed.data.serviceId
        ? prisma.commandService.findUnique({ where: { id: parsed.data.serviceId }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    if (repCount !== parsed.data.allocations.length) {
      sendError(res, "One or more reps were not found", 404);
      return;
    }
    if (parsed.data.serviceId && !service) {
      sendError(res, "Service not found", 404);
      return;
    }
    const created = await prisma.$transaction(async (tx) => {
      await tx.commandDealCredit.updateMany({
        where: {
          sourceType: parsed.data.sourceType,
          sourceId: parsed.data.sourceId,
          status: "approved",
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: parsed.data.effectiveFrom } }],
        },
        data: { effectiveTo: parsed.data.effectiveFrom },
      });
      const rows = [];
      for (const allocation of parsed.data.allocations) {
        rows.push(await tx.commandDealCredit.create({
          data: {
            sourceType: parsed.data.sourceType,
            sourceId: parsed.data.sourceId,
            serviceId: parsed.data.serviceId ?? null,
            repId: allocation.repId,
            creditShare: new Prisma.Decimal(allocation.creditShare),
            effectiveFrom: parsed.data.effectiveFrom,
            approvedByUserId: req.authUserId!,
          },
        }));
      }
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.deal_credit.approve",
          targetType: "command_deal_credit",
          targetId: `${parsed.data.sourceType}:${parsed.data.sourceId}`,
          after: {
            sourceType: parsed.data.sourceType,
            sourceId: parsed.data.sourceId,
            serviceId: parsed.data.serviceId ?? null,
            effectiveFrom: parsed.data.effectiveFrom,
            allocations: parsed.data.allocations,
          },
          ipAddress: req.ip,
        },
      });
      return rows;
    });
    await invalidateCommandCache();
    sendSuccess(res, { credits: created }, "Deal credit allocation approved", 201);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      sendError(res, "A credit allocation already starts at this effective time", 409);
      return;
    }
    sendError(res, "Failed to approve deal credits", 500, error);
  }
}
