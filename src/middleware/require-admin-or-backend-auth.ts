import type { NextFunction, Request, Response } from "express";
import { resolveAdminSession } from "../auth/admin-session";
import { requireBackendAuth } from "./require-backend-auth";
import { sendError } from "../utils/response.utils";

/**
 * Command requests use the backend-owned admin cookie. Dashboard superadmin
 * requests use the backend-owned dashboard cookie. The signed-token fallback
 * remains only for non-browser compatibility callers during their own cutover.
 */
export async function requireAdminOrBackendAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const session = await resolveAdminSession(req.headers);
    if (session) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Vary", "Cookie");
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
      return;
    }
  } catch {
    // Dashboard-cookie/signed compatibility authentication is evaluated below.
  }
  await requireBackendAuth(req, res, next);
}
