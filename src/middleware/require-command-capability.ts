import type { NextFunction, Request, Response } from "express";
import {
  hasCommandCapability,
  type CommandCapability,
} from "../command/access-control";
import { resolveCommandActor } from "../command/access.service";
import { sendError } from "../utils/response.utils";

export async function requireCommandPanel(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  // Backend-owned admin sessions already resolved the current database role,
  // rep assignment, capabilities, and MFA assurance. Reuse that projection so
  // a page load does not repeat the same authorization queries per endpoint.
  if (
    req.authSurface === "admin" &&
    req.userRole &&
    Array.isArray(req.commandCapabilities)
  ) {
    next();
    return;
  }

  try {
    const actor = await resolveCommandActor(req.authUserId);
    if (!actor) {
      sendError(res, "Forbidden", 403);
      return;
    }

    req.userRole = actor.role;
    req.commandRepId = actor.repId ?? undefined;
    req.commandCapabilities = actor.capabilities;
    next();
  } catch {
    sendError(res, "Failed to verify Command Panel access", 500);
  }
}

export function requireCommandCapability(capability: CommandCapability) {
  return async function commandCapabilityMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    await requireCommandPanel(req, res, () => {
      const capabilities = req.commandCapabilities ?? [];
      if (!hasCommandCapability(capabilities, capability)) {
        sendError(res, "Forbidden", 403);
        return;
      }
      next();
    });
  };
}
