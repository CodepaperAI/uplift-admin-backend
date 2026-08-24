import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import {
  COMMAND_SERVICE_CREATE_INPUT,
  COMMAND_SERVICE_UPDATE_INPUT,
  uniqueProviderIds,
} from "../command/service-input";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { COMMAND_SERVICE_RATE_INPUT } from "../command/service-rate-input";
import { invalidateCommandCache } from "../utils/command-cache";

type ServiceForAudit = {
  key: string;
  name: string;
  kind: string;
  listPriceMinor: Prisma.Decimal | null;
  currency: string | null;
  stripePriceIds: string[];
  ghlPipelineIds: string[];
  ghlCustomFieldValues: string[];
  isActive: boolean;
};

function serviceShape(service: ServiceForAudit) {
  return {
    ...service,
    listPriceMinor: service.listPriceMinor?.toString() ?? null,
  };
}

export async function getCommandServices(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const services = await prisma.commandService.findMany({
      include: { rateVersions: { orderBy: { effectiveFrom: "desc" } } },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    const now = new Date();
    const missingServiceRates = services
      .filter(
        (service) =>
          !service.rateVersions.some(
            (rate) =>
              rate.status === "approved" &&
              rate.approvedAt !== null &&
              rate.effectiveFrom <= now &&
              (rate.effectiveTo === null || rate.effectiveTo > now),
          ),
      )
      .map((service) => service.key);
    sendSuccess(
      res,
      {
        services: services.map(serviceShape),
        commissionConfiguration: {
          enabled: missingServiceRates.length === 0,
          blockedBy: missingServiceRates.length > 0 ? ["D1"] : [],
          missingServiceRates,
          message:
            missingServiceRates.length === 0
              ? "Every active service has an approved effective rate."
              : "Commission calculation remains fail-closed until every active service has an approved effective rate.",
        },
      },
      "Command services",
    );
  } catch (error) {
    sendError(res, "Failed to load Command services", 500, error);
  }
}

export async function createCommandService(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_SERVICE_CREATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid service", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  try {
    const created = await prisma.$transaction(async (tx) => {
      const service = await tx.commandService.create({
        data: {
          ...parsed.data,
          listPriceMinor:
            parsed.data.listPriceMinor === null
              ? null
              : new Prisma.Decimal(parsed.data.listPriceMinor),
          stripePriceIds: uniqueProviderIds(parsed.data.stripePriceIds),
          ghlPipelineIds: uniqueProviderIds(parsed.data.ghlPipelineIds),
          ghlCustomFieldValues: uniqueProviderIds(
            parsed.data.ghlCustomFieldValues,
          ),
          createdByUserId: req.authUserId,
          updatedByUserId: req.authUserId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.service.create",
          targetType: "command_service",
          targetId: service.id,
          before: Prisma.JsonNull,
          after: serviceShape(service),
          details: { before: null, after: serviceShape(service) },
          ipAddress: req.ip,
        },
      });
      return service;
    });
    sendSuccess(res, serviceShape(created), "Command service created", 201);
    await invalidateCommandCache();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      sendError(res, "A service with this key already exists", 409);
      return;
    }
    sendError(res, "Failed to create Command service", 500, error);
  }
}

export async function updateCommandService(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_SERVICE_UPDATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid service", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  try {
    const existing = await prisma.commandService.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      sendError(res, "Service not found", 404);
      return;
    }
    const updated = await prisma.$transaction(async (tx) => {
      const service = await tx.commandService.update({
        where: { id: existing.id },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
          ...(parsed.data.listPriceMinor !== undefined
            ? {
                listPriceMinor:
                  parsed.data.listPriceMinor === null
                    ? null
                    : new Prisma.Decimal(parsed.data.listPriceMinor),
              }
            : {}),
          ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
          ...(parsed.data.stripePriceIds !== undefined
            ? { stripePriceIds: uniqueProviderIds(parsed.data.stripePriceIds) }
            : {}),
          ...(parsed.data.ghlPipelineIds !== undefined
            ? { ghlPipelineIds: uniqueProviderIds(parsed.data.ghlPipelineIds) }
            : {}),
          ...(parsed.data.ghlCustomFieldValues !== undefined
            ? {
                ghlCustomFieldValues: uniqueProviderIds(
                  parsed.data.ghlCustomFieldValues,
                ),
              }
            : {}),
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
          updatedByUserId: req.authUserId,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.service.update",
          targetType: "command_service",
          targetId: existing.id,
          before: serviceShape(existing),
          after: serviceShape(service),
          details: { before: serviceShape(existing), after: serviceShape(service) },
          ipAddress: req.ip,
        },
      });
      return service;
    });
    sendSuccess(res, serviceShape(updated), "Command service updated");
    await invalidateCommandCache();
  } catch (error) {
    sendError(res, "Failed to update Command service", 500, error);
  }
}

export async function createCommandServiceRate(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_SERVICE_RATE_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid service rate", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }
  if (parsed.data.status === "approved" && req.userRole !== "SUPERADMIN") {
    sendError(res, "Only a superadmin can approve commission rates", 403);
    return;
  }

  try {
    const service = await prisma.commandService.findUnique({
      where: { id: req.params.id },
      select: { id: true, key: true, name: true },
    });
    if (!service) {
      sendError(res, "Service not found", 404);
      return;
    }
    const now = new Date();
    const rate = await prisma.$transaction(async (tx) => {
      if (parsed.data.status === "approved") {
        const current = await tx.commandServiceRateVersion.findFirst({
          where: {
            serviceId: service.id,
            status: "approved",
            effectiveFrom: { lt: parsed.data.effectiveFrom },
            OR: [
              { effectiveTo: null },
              { effectiveTo: { gt: parsed.data.effectiveFrom } },
            ],
          },
          orderBy: { effectiveFrom: "desc" },
        });
        if (current) {
          await tx.commandServiceRateVersion.update({
            where: { id: current.id },
            data: { effectiveTo: parsed.data.effectiveFrom },
          });
        }
      }
      const created = await tx.commandServiceRateVersion.create({
        data: {
          serviceId: service.id,
          effectiveFrom: parsed.data.effectiveFrom,
          firstSaleRate: new Prisma.Decimal(parsed.data.firstSaleRate),
          recurringRate: new Prisma.Decimal(parsed.data.recurringRate),
          status: parsed.data.status,
          approvedAt: parsed.data.status === "approved" ? now : null,
          approvedByUserId:
            parsed.data.status === "approved" ? req.authUserId : null,
          createdByUserId: req.authUserId!,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action:
            parsed.data.status === "approved"
              ? "command.service_rate.approve"
              : "command.service_rate.draft",
          targetType: "command_service_rate_version",
          targetId: created.id,
          before: Prisma.JsonNull,
          after: {
            serviceId: service.id,
            serviceKey: service.key,
            effectiveFrom: created.effectiveFrom,
            firstSaleRate: created.firstSaleRate.toString(),
            recurringRate: created.recurringRate.toString(),
            status: created.status,
          },
          ipAddress: req.ip,
        },
      });
      return created;
    });
    await invalidateCommandCache();
    sendSuccess(
      res,
      {
        ...rate,
        firstSaleRate: rate.firstSaleRate.toString(),
        recurringRate: rate.recurringRate.toString(),
      },
      "Command service rate recorded",
      201,
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      sendError(res, "A rate already starts at this effective time", 409);
      return;
    }
    sendError(res, "Failed to record Command service rate", 500, error);
  }
}
