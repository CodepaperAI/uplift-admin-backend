import type { Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { syncSignupToGhl } from "../services/ghl-signup-sync.service";
import { sendError, sendSuccess } from "../utils/response.utils";

const SIGNUP_EVENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export async function syncSignupCreatedEvent(
  req: AuthenticatedRequest,
  res: Response,
) {
  const userId = req.authUserId;
  if (!userId) return sendError(res, "Unauthorized", 401);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
    });
    if (!user) return sendError(res, "Account not found", 404);
    if (Date.now() - user.createdAt.getTime() > SIGNUP_EVENT_WINDOW_MS) {
      return sendError(res, "Event is no longer eligible", 409);
    }

    const result = await syncSignupToGhl(user);
    return sendSuccess(res, result, "Signup event processed");
  } catch (error) {
    return sendError(res, "Signup event could not be processed", 500, error);
  }
}
