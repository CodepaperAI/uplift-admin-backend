import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./require-backend-auth";
import { sendError } from "../utils/response.utils";

function suppliedUserId(value: unknown): string | null {
  if (Array.isArray(value)) return suppliedUserId(value[0]);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Bind legacy body/query userId inputs to the identity in the signed backend
 * token. This keeps existing controller schemas compatible while preventing a
 * caller from selecting another tenant by changing userId.
 */
export function bindAuthenticatedUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authUserId = req.authUserId;
  if (!authUserId) {
    sendError(res, "Unauthorized", 401);
    return;
  }

  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const bodyUserId = suppliedUserId(body?.userId);
  const queryUserId = suppliedUserId(req.query?.userId);
  const paramUserId = suppliedUserId(req.params?.userId);
  if (
    (bodyUserId && bodyUserId !== authUserId) ||
    (queryUserId && queryUserId !== authUserId) ||
    (paramUserId && paramUserId !== authUserId)
  ) {
    sendError(res, "Forbidden", 403);
    return;
  }

  if (body) body.userId = authUserId;
  req.query.userId = authUserId;
  next();
}
