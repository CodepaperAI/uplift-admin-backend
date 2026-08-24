import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.config";
import { sendError } from "../utils/response.utils";

export async function requireAgencyAdmin(
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

    if (!user) {
      sendError(res, "User not found", 404);
      return;
    }

    const role: string = user.role;

    if (
      role !== "ADMIN" &&
      role !== "SUPERADMIN" &&
      role !== "AGENCY_ADMIN"
    ) {
      sendError(res, "Forbidden: agency admin access required", 403);
      return;
    }

    req.userRole = role;

    if (role === "ADMIN" || role === "SUPERADMIN") {
      const queryAgencyId: string | undefined =
        (req.query["agencyId"] as string) || undefined;
      req.agencyId = queryAgencyId;
      next();
      return;
    }

    const membership = await prisma.agencyMembership.findFirst({
      where: {
        userId,
        isActive: true,
      },
      select: {
        agencyId: true,
        agency: {
          select: {
            slug: true,
            isActive: true,
          },
        },
      },
    });

    if (!membership || !membership.agency.isActive) {
      sendError(res, "Forbidden: no active agency membership found", 403);
      return;
    }

    req.agencyId = membership.agencyId;
    req.agencySlug = membership.agency.slug;
    next();
  } catch {
    sendError(res, "Failed to verify agency admin status", 500);
  }
}
