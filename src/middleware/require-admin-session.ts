import type { NextFunction, Request, Response } from "express";
import { resolveAdminSession } from "../auth/admin-session";
import { sendError } from "../utils/response.utils";

export async function requireAdminSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  try {
    const session = await resolveAdminSession(req.headers);
    if (!session) {
      sendError(res, "Unauthorized", 401);
      return;
    }
    if (session.mfaRequired && !session.mfaVerified) {
      sendError(res, "Forbidden", 403);
      return;
    }
    req.authUserId = session.user.id;
    req.userRole = session.role;
    req.commandRepId = session.repId ?? undefined;
    req.commandCapabilities = session.capabilities as Express.Request["commandCapabilities"];
    req.authSurface = "admin";
    req.adminMfaVerified = session.mfaVerified;
    next();
  } catch {
    sendError(res, "Unable to verify session", 503);
  }
}
