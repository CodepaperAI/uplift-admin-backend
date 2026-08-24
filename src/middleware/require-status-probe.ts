import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const MIN_SECRET_BYTES = 32;

function readProbeSecret(req: Request): string {
  const header = req.headers["x-status-probe-key"];
  if (typeof header === "string") return header.trim();
  if (Array.isArray(header) && typeof header[0] === "string") {
    return header[0].trim();
  }
  const authorization = req.headers.authorization?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function matches(expected: string, received: string): boolean {
  if (Buffer.byteLength(expected, "utf8") < MIN_SECRET_BYTES) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function requireStatusProbe(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.STATUS_PROBE_TOKEN?.trim() ?? "";
  if (Buffer.byteLength(expected, "utf8") < MIN_SECRET_BYTES) {
    res.status(503).json({ success: false, error: "Service unavailable" });
    return;
  }
  if (!matches(expected, readProbeSecret(req))) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  next();
}
