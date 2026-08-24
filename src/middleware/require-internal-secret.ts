import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;

type InternalSecretName =
  | "INTERNAL_AUTH_EMAIL_SECRET"
  | "INTERNAL_BILLING_SECRET"
  | "INTERNAL_ONBOARDING_SECRET"
  | "INTERNAL_TRANSACTIONAL_EMAIL_SECRET";

function safeSecretMatches(expected: string, received: string): boolean {
  if (Buffer.byteLength(expected, "utf8") < MIN_SECRET_BYTES) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function requireInternalSecretFor(secretName: InternalSecretName) {
  return function requirePurposeBoundInternalSecret(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const internalSecret = process.env[secretName]?.trim() ?? "";

    if (Buffer.byteLength(internalSecret, "utf8") < MIN_SECRET_BYTES) {
      res.status(503).json({
        success: false,
        error: "Service unavailable",
      });
      return;
    }
    const provided = req.headers["x-internal-secret"];
    const secret =
      typeof provided === "string"
        ? provided
        : Array.isArray(provided)
          ? provided[0] ?? ""
          : "";
    if (!safeSecretMatches(internalSecret, secret)) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }
    next();
  };
}

export const requireInternalAuthEmailSecret = requireInternalSecretFor(
  "INTERNAL_AUTH_EMAIL_SECRET",
);
export const requireInternalBillingSecret = requireInternalSecretFor(
  "INTERNAL_BILLING_SECRET",
);
export const requireInternalOnboardingSecret = requireInternalSecretFor(
  "INTERNAL_ONBOARDING_SECRET",
);
export const requireInternalTransactionalEmailSecret = requireInternalSecretFor(
  "INTERNAL_TRANSACTIONAL_EMAIL_SECRET",
);
