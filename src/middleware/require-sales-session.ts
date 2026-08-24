import type { NextFunction, Request, Response } from "express";
import { resolveSalesSession } from "../auth/sales-session";
import { sendError } from "../utils/response.utils";

export async function requireSalesSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (typeof req.headers.cookie !== "string" || req.headers.cookie.length === 0) {
    sendError(res, "Unauthorized", 401);
    return;
  }
  try {
    const session = await resolveSalesSession(req.headers);
    if (!session) {
      sendError(res, "Unauthorized", 401);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", "Cookie");
    req.authUserId = session.user.id;
    req.authSurface = "sales";
    req.userRole = "SALES";
    next();
  } catch {
    sendError(res, "Unable to verify session", 503);
  }
}
