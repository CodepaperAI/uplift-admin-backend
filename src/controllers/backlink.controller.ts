import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { prisma } from "../config/db.config";
import { getLinkOverviewForBusiness } from "../services/link-overview.service";
import { emptyLinkOverview } from "../utils/link-overview.utils";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { GET_ALL_BACKLINKS } from "../validators/backlink.validation";

async function resolveTargetBusinessId(payload: {
  userId: string;
  businessId?: string;
}): Promise<string | undefined> {
  if (payload.businessId) {
    const business = await prisma.business.findFirst({
      where: {
        id: payload.businessId,
        userId: payload.userId,
        isActive: true,
      },
      select: { id: true },
    });

    return business?.id;
  }

  const primaryBusiness = await prisma.business.findFirst({
    where: {
      userId: payload.userId,
      isPrimary: true,
      isActive: true,
    },
    select: { id: true },
  });

  return primaryBusiness?.id;
}

export async function GetAllBacklinks(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = GET_ALL_BACKLINKS.parse(body);

    const targetBusinessId = await resolveTargetBusinessId(payload);

    if (payload.businessId && !targetBusinessId) {
      return sendError(res, "Resource not found", 404);
    }

    if (!targetBusinessId) {
      return sendSuccess(res, { backlinks: [] }, "No backlinks found");
    }

    const where: Prisma.BacklinksWhereInput = {
      referredBusinessId: targetBusinessId,
      sourceBusinessId: { not: targetBusinessId },
    };

    const backlinks = await prisma.backlinks.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return sendSuccess(
      res,
      { backlinks },
      backlinks.length > 0
        ? "Managed cross-links retrieved successfully"
        : "No managed cross-links found"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to retrieve backlinks", 500, error);
  }
}

export async function GetBacklinkOverview(req: Request, res: Response) {
  try {
    const payload = GET_ALL_BACKLINKS.parse(req.body);
    const targetBusinessId = await resolveTargetBusinessId(payload);

    if (payload.businessId && !targetBusinessId) {
      return sendError(res, "Resource not found", 404);
    }

    if (!targetBusinessId) {
      return sendSuccess(
        res,
        { overview: emptyLinkOverview() },
        "No link data found",
      );
    }

    const overview = await getLinkOverviewForBusiness(targetBusinessId);

    return sendSuccess(
      res,
      { overview },
      "Content links and managed backlinks retrieved successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to retrieve link overview", 500, error);
  }
}
