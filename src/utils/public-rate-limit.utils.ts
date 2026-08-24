import type { Response } from "express";

export type PublicRateLimitScope = "public_audit" | "public_tools";

export type PublicRateLimitStore = Map<string, { count: number; resetAt: number }>;

export type PublicRateLimitStatus = {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  windowMs: number;
};

export function evaluatePublicRateLimit(params: {
  store: PublicRateLimitStore;
  key: string;
  limit: number;
  windowMs: number;
  bypass?: boolean;
}): PublicRateLimitStatus {
  const { store, key, limit, windowMs, bypass = process.env.NODE_ENV !== "production" } =
    params;
  const now = Date.now();

  if (bypass) {
    return {
      allowed: true,
      limit,
      used: 0,
      remaining: limit,
      resetAt: now + windowMs,
      retryAfterSeconds: 0,
      windowMs,
    };
  }

  const current = store.get(key);
  if (!current || now > current.resetAt) {
    const next = { count: 1, resetAt: now + windowMs };
    store.set(key, next);
    return {
      allowed: true,
      limit,
      used: next.count,
      remaining: Math.max(limit - next.count, 0),
      resetAt: next.resetAt,
      retryAfterSeconds: Math.max(Math.ceil((next.resetAt - now) / 1000), 0),
      windowMs,
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      limit,
      used: current.count,
      remaining: 0,
      resetAt: current.resetAt,
      retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 0),
      windowMs,
    };
  }

  current.count += 1;
  return {
    allowed: true,
    limit,
    used: current.count,
    remaining: Math.max(limit - current.count, 0),
    resetAt: current.resetAt,
    retryAfterSeconds: Math.max(Math.ceil((current.resetAt - now) / 1000), 0),
    windowMs,
  };
}

export function applyPublicRateLimitHeaders(
  res: Response,
  status: PublicRateLimitStatus,
): void {
  res.setHeader("X-RateLimit-Limit", String(status.limit));
  res.setHeader("X-RateLimit-Remaining", String(status.remaining));
  res.setHeader("X-RateLimit-Reset", new Date(status.resetAt).toISOString());

  if (!status.allowed) {
    res.setHeader("Retry-After", String(status.retryAfterSeconds));
  }
}

export function buildPublicRateLimitError(params: {
  scope: PublicRateLimitScope;
  status: PublicRateLimitStatus;
  resourceLabel: string;
  actionLabel: string;
  windowLabel: string;
}) {
  const { scope, status, resourceLabel, actionLabel, windowLabel } = params;

  return {
    success: false,
    errorCode: "rate_limited",
    message: `Rate limit reached for ${resourceLabel}.`,
    rateLimit: {
      scope,
      resourceLabel,
      actionLabel,
      limit: status.limit,
      used: status.used,
      remaining: status.remaining,
      resetAt: new Date(status.resetAt).toISOString(),
      retryAfterSeconds: status.retryAfterSeconds,
      windowLabel,
    },
  };
}
