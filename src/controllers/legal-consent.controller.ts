import type { Response } from "express";
import { z, ZodError } from "zod";

import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { handleValidationError, sendError, sendSuccess } from "../utils/response.utils";

export const CURRENT_TERMS_VERSION = "2026-05-01";
export const CURRENT_PRIVACY_VERSION = "2026-05-01";

const ACCEPTANCE = z.object({
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  termsVersion: z.literal(CURRENT_TERMS_VERSION),
  privacyVersion: z.literal(CURRENT_PRIVACY_VERSION),
}).strict();

const CONSENT_SELECT = {
  termsAcceptedAt: true,
  termsVersion: true,
  privacyAcceptedAt: true,
  privacyVersion: true,
} as const;

function status(consent: {
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  privacyAcceptedAt: Date | null;
  privacyVersion: string | null;
}) {
  return {
    ...consent,
    currentTermsVersion: CURRENT_TERMS_VERSION,
    currentPrivacyVersion: CURRENT_PRIVACY_VERSION,
    requiresConsent: !(
      consent.termsAcceptedAt &&
      consent.privacyAcceptedAt &&
      consent.termsVersion === CURRENT_TERMS_VERSION &&
      consent.privacyVersion === CURRENT_PRIVACY_VERSION
    ),
  };
}

function failure(res: Response, error: unknown) {
  if (error instanceof ZodError) return handleValidationError(res, error);
  console.error("[legal-consent] Request failed:", error);
  return sendError(res, "Request could not be completed", 500);
}

export async function getLegalConsent(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const user = await prisma.user.findUnique({
      where: { id: req.authUserId },
      select: CONSENT_SELECT,
    });
    if (!user) return sendError(res, "User not found", 404);
    return sendSuccess(res, status(user), "Consent status retrieved");
  } catch (error) {
    return failure(res, error);
  }
}

export async function acceptLegalConsent(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    ACCEPTANCE.parse(req.body ?? {});

    const acceptedAt = new Date();
    const user = await prisma.user.update({
      where: { id: req.authUserId },
      data: {
        termsAcceptedAt: acceptedAt,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyAcceptedAt: acceptedAt,
        privacyVersion: CURRENT_PRIVACY_VERSION,
        legalConsentIp: (req.ip || req.socket.remoteAddress || "").slice(0, 64) || null,
        legalConsentUserAgent: req.get("user-agent")?.slice(0, 512) || null,
      },
      select: CONSENT_SELECT,
    });
    return sendSuccess(res, status(user), "Consent recorded");
  } catch (error) {
    return failure(res, error);
  }
}
