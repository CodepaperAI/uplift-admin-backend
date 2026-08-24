import type { Response } from "express";
import { ZodError } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { encryptPublishingSecret } from "../utils/publishing-secret-crypto";
import { handleValidationError, sendError, sendSuccess } from "../utils/response.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";
import { guardUrl, SsrfBlocked } from "../utils/ssrf-guard";
import { addWordPressCredentialsValidation } from "../validators/wordpress.validation";

function userId(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.authUserId) {
    sendError(res, "Unauthorized", 401);
    return null;
  }
  return req.authUserId;
}

export async function getWordPressCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const ownerId = userId(req, res);
    if (!ownerId) return;
    const integration = await prisma.wordPressintegration.findUnique({
      where: { userId: ownerId },
      select: {
        id: true,
        websiteUrl: true,
        username: true,
        createdAt: true,
        updatedAt: true,
        app_password: true,
      },
    });
    return sendSuccess(res, {
      integration: integration
        ? {
            id: integration.id,
            websiteUrl: integration.websiteUrl,
            username: integration.username,
            createdAt: integration.createdAt,
            updatedAt: integration.updatedAt,
            hasAppPassword: Boolean(integration.app_password),
          }
        : null,
    });
  } catch (error) {
    console.error("[wordpress-credentials] Read failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function addWordPressCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const ownerId = userId(req, res);
    if (!ownerId) return;
    const payload = addWordPressCredentialsValidation.parse(req.body);
    const { url } = await guardUrl(payload.websiteUrl);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new SsrfBlocked("HTTPS is required", "https_required");
    }
    if (url.username || url.password) {
      throw new SsrfBlocked("URL credentials are not allowed", "embedded_credentials");
    }
    url.search = "";
    url.hash = "";
    const websiteUrl = url.toString().replace(/\/$/, "");
    const integration = await prisma.wordPressintegration.upsert({
      where: { userId: ownerId },
      update: {
        username: payload.username,
        websiteUrl,
        app_password: encryptPublishingSecret(payload.app_password, "wordpress-password"),
      },
      create: {
        username: payload.username,
        websiteUrl,
        app_password: encryptPublishingSecret(payload.app_password, "wordpress-password"),
        userId: ownerId,
      },
      select: { id: true, websiteUrl: true, username: true, createdAt: true, updatedAt: true },
    });
    await invalidateTenantCache(ownerId);
    return sendSuccess(
      res,
      { integration: { ...integration, hasAppPassword: true } },
      "WordPress account connected successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof SsrfBlocked) return sendError(res, "WordPress URL is not allowed", 400);
    console.error("[wordpress-credentials] Write failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function deleteWordPressCredentials(req: AuthenticatedRequest, res: Response) {
  try {
    const ownerId = userId(req, res);
    if (!ownerId) return;
    await prisma.wordPressintegration.deleteMany({ where: { userId: ownerId } });
    await invalidateTenantCache(ownerId);
    return sendSuccess(res, {}, "WordPress account disconnected");
  } catch (error) {
    console.error("[wordpress-credentials] Delete failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}
