import type { NextFunction, Request, Response } from "express";
import { consumeSensitiveRateLimit } from "../utils/tenant-response-cache";
import { sendError } from "../utils/response.utils";

export function sensitiveRateLimitDiscriminators(input: {
  authUserId?: string | null;
  ip?: string | null;
}): string[] {
  const authUserId = input.authUserId?.trim();
  if (authUserId) {
    // Authenticated dashboard requests are relayed by Next.js. Limiting those
    // requests by the relay IP makes unrelated customers share one bucket and
    // allows one noisy browser to cause 429s for everyone. The verified account
    // is the security boundary once authentication has completed.
    return [`account:${authUserId}`];
  }

  return [`ip:${input.ip?.trim() || "unknown"}`];
}

export function sensitiveRouteRateLimit(options: {
  namespace: string;
  limit: number;
  windowSeconds: number;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const discriminators = sensitiveRateLimitDiscriminators({
      authUserId: req.authUserId,
      ip,
    });
    const results = await Promise.all(
      discriminators.map((discriminator) =>
        consumeSensitiveRateLimit({ ...options, discriminator }),
      ),
    );
    const result = {
      allowed: results.every((entry) => entry.allowed),
      remaining: Math.min(...results.map((entry) => entry.remaining)),
      retryAfterSeconds: Math.max(
        ...results.map((entry) => entry.retryAfterSeconds),
      ),
    };
    res.setHeader("RateLimit-Limit", String(options.limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(result.retryAfterSeconds));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      sendError(res, "Too many requests", 429);
      return;
    }
    next();
  };
}
