import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.config";
import { sendError } from "../utils/response.utils";
import { isSuperAdminRole } from "../utils/platform-role.utils";

export async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId: string | undefined = req.authUserId;

  if (!userId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || !isSuperAdminRole(user.role)) {
      sendError(res, "Forbidden", 403);
      return;
    }

    req.userRole = user.role;
    next();
  } catch {
    sendError(res, "Failed to verify admin status", 500);
  }
}
