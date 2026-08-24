import type { Request, Response } from "express";
import { resolveDashboardSession } from "../auth/dashboard-session";
import { sendError, sendSuccess } from "../utils/response.utils";

export async function getDashboardAuthContext(
  req: Request,
  res: Response,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  try {
    const session = await resolveDashboardSession(req.headers);
    if (!session) {
      sendError(res, "Unauthorized", 401);
      return;
    }
    sendSuccess(res, { user: session.user }, "Authenticated");
  } catch {
    sendError(res, "Unable to verify session", 503);
  }
}
