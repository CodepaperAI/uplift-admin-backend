import type { Request, Response } from "express";
import { resolveAdminSession } from "../auth/admin-session";
import { sendError, sendSuccess } from "../utils/response.utils";

export async function getAdminAuthContext(
  req: Request,
  res: Response,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  try {
    const session = await resolveAdminSession(req.headers);
    if (!session) {
      sendError(res, "Unauthorized", 401);
      return;
    }
    sendSuccess(
      res,
      {
        user: session.user,
        role: session.role,
        commandPanelEnabled: session.commandPanelEnabled,
        twoFactorEnabled: session.twoFactorEnabled,
        mfaVerified: session.mfaVerified,
        mfaRequired: session.mfaRequired,
      },
      "Authenticated",
    );
  } catch {
    sendError(res, "Unable to verify session", 503);
  }
}
