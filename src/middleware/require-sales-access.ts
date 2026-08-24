import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError } from "../utils/response.utils";

export async function requireSalesAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.authUserId) {
    sendError(res, "Unauthorized", 401);
    return;
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: { role: true, commandPanelEnabled: true },
    });
    if (user?.role !== "SALES" || !user.commandPanelEnabled) {
      sendError(res, "Forbidden", 403);
      return;
    }
    req.userRole = user.role;
    next();
  } catch (error) {
    sendError(res, "Access could not be verified", 500, error);
  }
}
