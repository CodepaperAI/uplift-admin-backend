import type { Request, Response, NextFunction } from "express";
import {
  verifyBackendAuthToken,
} from "../utils/backend-auth-token";
import { resolveDashboardSession } from "../auth/dashboard-session";
import { sendError } from "../utils/response.utils";

export type AuthenticatedRequest = Request & {
  authUserId?: string;
  authSurface?: "admin" | "dashboard" | "sales";
};

export async function requireBackendAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = req.headers.authorization;
  const token = typeof raw === "string" && raw.startsWith("Bearer ")
    ? raw.slice(7).trim()
    : "";
  const parsed = verifyBackendAuthToken(token);
  if (parsed) {
    req.authUserId = parsed.userId;
    next();
    return;
  }

  if (typeof req.headers.cookie === "string" && req.headers.cookie.length > 0) {
    try {
      const session = await resolveDashboardSession(req.headers);
      if (session) {
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.setHeader("Vary", "Cookie");
        req.authUserId = session.user.id;
        req.authSurface = "dashboard";
        next();
        return;
      }
    } catch {
      sendError(res, "Unable to verify session", 503);
      return;
    }
  }

  sendError(res, "Unauthorized", 401);
}
