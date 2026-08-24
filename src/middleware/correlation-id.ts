import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export type RequestWithCorrelationId = Request & { correlationId?: string };

const HEADER = "x-correlation-id";

export function correlationIdMiddleware(
  req: RequestWithCorrelationId,
  _res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers[HEADER];
  req.correlationId =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : crypto.randomUUID();
  next();
}
