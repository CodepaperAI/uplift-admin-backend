import type { Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
    ApiTokenConfigurationError,
    deriveAllowedOriginsFromWebsiteUrl,
    generateApiTokenCredential,
    hashToken,
} from "../utils/api-token.utils";
import {
    handleValidationError,
    sendError,
    sendSuccess,
} from "../utils/response.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

const API_TOKEN_PERMISSIONS = ["read:blogs", "read:keywords"] as const;
const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const CREATE_API_TOKEN = z
    .object({
        businessId: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        permissions: z
            .array(z.enum(API_TOKEN_PERMISSIONS))
            .min(1)
            .max(API_TOKEN_PERMISSIONS.length)
            .refine((values) => new Set(values).size === values.length, {
                message: "Permissions must be unique",
            })
            .optional()
            .default([...API_TOKEN_PERMISSIONS]),
        expiresAt: z.string().datetime().optional(),
    })
    .strict()
    .superRefine((body, context) => {
        if (!body.expiresAt) return;

        const now = Date.now();
        const requestedExpiry = new Date(body.expiresAt).getTime();
        if (requestedExpiry <= now) {
            context.addIssue({
                code: "custom",
                path: ["expiresAt"],
                message: "Expiration must be in the future",
            });
        } else if (requestedExpiry > now + MAX_TOKEN_TTL_MS) {
            context.addIssue({
                code: "custom",
                path: ["expiresAt"],
                message: "Expiration cannot be more than one year from now",
            });
        }
    });

const LIST_API_TOKENS = z
    .object({
        businessId: z.string().uuid(),
    })
    .strict();

const TOKEN_MUTATION = z
    .object({
        tokenId: z.string().uuid(),
    })
    .strict();

function requireAuthenticatedUserId(
    req: AuthenticatedRequest,
    res: Response,
): string | null {
    const userId = req.authUserId?.trim();
    if (!userId) {
        sendError(res, "Unauthorized", 401);
        return null;
    }
    return userId;
}

function resolveTokenExpiry(expiresAt?: string): Date {
    return expiresAt
        ? new Date(expiresAt)
        : new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
}

function normalizeStoredPermissions(permissions: string[]): Array<(typeof API_TOKEN_PERMISSIONS)[number]> {
    const supported = permissions.filter(
        (permission): permission is (typeof API_TOKEN_PERMISSIONS)[number] =>
            API_TOKEN_PERMISSIONS.includes(
                permission as (typeof API_TOKEN_PERMISSIONS)[number],
            ),
    );
    return supported.length > 0
        ? [...new Set(supported)]
        : [...API_TOKEN_PERMISSIONS];
}

export async function createApiToken(req: AuthenticatedRequest, res: Response) {
    try {
        const userId = requireAuthenticatedUserId(req, res);
        if (!userId) return;
        const body = CREATE_API_TOKEN.parse(req.body);
        const expiresAt = resolveTokenExpiry(body.expiresAt);

        const business = await prisma.business.findFirst({
            where: {
                id: body.businessId,
                userId,
                isActive: true,
            },
            select: {
                id: true,
                businessWebsiteUrl: true,
                businessName: true,
            },
        });

        if (!business) {
            return sendError(res, "Business not found or access denied", 404);
        }

        const credential = generateApiTokenCredential();

        const allowedOrigins = deriveAllowedOriginsFromWebsiteUrl(
            business.businessWebsiteUrl,
        );

        const siteUrlSnapshot: string | null =
            business.businessWebsiteUrl.trim() !== ""
                ? business.businessWebsiteUrl.trim()
                : null;
        const nameSnapshot: string | null =
            business.businessName.trim() !== ""
                ? business.businessName.trim()
                : null;

        const apiToken = await prisma.apiToken.create({
            data: {
                id: credential.id,
                userId,
                businessId: body.businessId,
                name: body.name,
                token: credential.tokenDigest,
                tokenPrefix: credential.tokenPrefix,
                permissions: body.permissions,
                allowedOrigins: allowedOrigins,
                expiresAt,
                connectedSiteUrlAtCreation: siteUrlSnapshot,
                connectedBusinessNameAtCreation: nameSnapshot,
            },
            select: {
                id: true,
                name: true,
                tokenPrefix: true,
                permissions: true,
                isActive: true,
                expiresAt: true,
                createdAt: true,
                business: {
                    select: {
                        id: true,
                        businessName: true,
                    },
                },
            },
        });

        console.log(`[API Token] Created token for user ${userId}, business ${body.businessId}`);
        await invalidateTenantCache(userId, body.businessId);

        return sendSuccess(
            res,
            {
                token: apiToken,
                plainToken: credential.plainToken,
            },
            "API token created successfully. Save the token now - it cannot be retrieved later."
        );
    } catch (error) {
        if (error instanceof z.ZodError) {
            return handleValidationError(res, error);
        }
        if (error instanceof ApiTokenConfigurationError) {
            console.error(`[API Token] Configuration error: ${error.message}`);
            return sendError(res, "API token service is not configured", 503);
        }
        console.error("[API Token] Error creating token:", error);
        return sendError(res, "Failed to create API token", 500);
    }
}

export async function listApiTokens(req: AuthenticatedRequest, res: Response) {
    try {
        const userId = requireAuthenticatedUserId(req, res);
        if (!userId) return;
        const body = LIST_API_TOKENS.parse(req.body);

        const business = await prisma.business.findFirst({
            where: {
                id: body.businessId,
                userId,
                isActive: true,
            },
            select: { id: true },
        });
        if (!business) {
            return sendError(res, "Business not found or access denied", 404);
        }

        const tokens = await prisma.apiToken.findMany({
            where: {
                userId,
                businessId: body.businessId,
            },
            select: {
                id: true,
                name: true,
                tokenPrefix: true,
                permissions: true,
                isActive: true,
                expiresAt: true,
                lastUsedAt: true,
                revokedAt: true,
                revocationReason: true,
                rotatedFromTokenId: true,
                createdAt: true,
                business: {
                    select: {
                        id: true,
                        businessName: true,
                    },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        return sendSuccess(res, { tokens }, "API tokens retrieved successfully");
    } catch (error) {
        if (error instanceof z.ZodError) {
            return handleValidationError(res, error);
        }
        console.error("[API Token] Error listing tokens:", error);
        return sendError(res, "Failed to list API tokens", 500);
    }
}

export async function revokeApiToken(req: AuthenticatedRequest, res: Response) {
    try {
        const userId = requireAuthenticatedUserId(req, res);
        if (!userId) return;
        const body = TOKEN_MUTATION.parse(req.body);

        const token = await prisma.apiToken.findFirst({
            where: {
                id: body.tokenId,
                userId,
            },
        });

        if (!token) {
            return sendError(res, "Token not found or access denied", 404);
        }

        await prisma.apiToken.update({
            where: { id: body.tokenId },
            data: {
                isActive: false,
                revokedAt: new Date(),
                revocationReason: "manual_revoke",
            },
        });
        await invalidateTenantCache(userId, token.businessId);

        console.log(`[API Token] Revoked token ${body.tokenId} for user ${userId}`);

        return sendSuccess(res, { id: body.tokenId }, "API token revoked successfully");
    } catch (error) {
        if (error instanceof z.ZodError) {
            return handleValidationError(res, error);
        }
        console.error("[API Token] Error revoking token:", error);
        return sendError(res, "Failed to revoke API token", 500);
    }
}

export async function regenerateApiToken(req: AuthenticatedRequest, res: Response) {
    try {
        const userId = requireAuthenticatedUserId(req, res);
        if (!userId) return;
        const body = TOKEN_MUTATION.parse(req.body);

        const existingToken = await prisma.apiToken.findFirst({
            where: {
                id: body.tokenId,
                userId,
            },
        });

        if (!existingToken) {
            return sendError(res, "Token not found or access denied", 404);
        }

        const business = await prisma.business.findFirst({
            where: {
                id: existingToken.businessId,
                userId,
                isActive: true,
            },
            select: {
                id: true,
                businessWebsiteUrl: true,
            },
        });

        if (!business) {
            return sendError(res, "Business not found or access denied", 404);
        }

        const credential = generateApiTokenCredential();

        const allowedOrigins = deriveAllowedOriginsFromWebsiteUrl(
            business.businessWebsiteUrl,
        );

        const newToken = await prisma.$transaction(async (transaction) => {
            await transaction.apiToken.update({
                where: { id: body.tokenId },
                data: {
                    isActive: false,
                    revokedAt: new Date(),
                    revocationReason: "rotated",
                },
            });

            return transaction.apiToken.create({
                data: {
                    id: credential.id,
                    userId: existingToken.userId,
                    businessId: existingToken.businessId,
                    name: existingToken.name,
                    token: credential.tokenDigest,
                    tokenPrefix: credential.tokenPrefix,
                    permissions: normalizeStoredPermissions(existingToken.permissions),
                    allowedOrigins: allowedOrigins,
                    expiresAt: new Date(Date.now() + DEFAULT_TOKEN_TTL_MS),
                    connectedSiteUrlAtCreation:
                        existingToken.connectedSiteUrlAtCreation,
                    connectedBusinessNameAtCreation:
                        existingToken.connectedBusinessNameAtCreation,
                    rotatedFromTokenId: existingToken.id,
                },
                select: {
                    id: true,
                    name: true,
                    tokenPrefix: true,
                    permissions: true,
                    isActive: true,
                    expiresAt: true,
                    createdAt: true,
                    business: {
                        select: {
                            id: true,
                            businessName: true,
                        },
                    },
                },
            });
        });

        console.log(`[API Token] Regenerated token for user ${userId}, old: ${body.tokenId}, new: ${newToken.id}`);
        await invalidateTenantCache(userId, existingToken.businessId);

        return sendSuccess(
            res,
            {
                token: newToken,
                plainToken: credential.plainToken,
                revokedTokenId: body.tokenId,
            },
            "API token regenerated successfully. Save the new token now - it cannot be retrieved later."
        );
    } catch (error) {
        if (error instanceof z.ZodError) {
            return handleValidationError(res, error);
        }
        if (error instanceof ApiTokenConfigurationError) {
            console.error(`[API Token] Configuration error: ${error.message}`);
            return sendError(res, "API token service is not configured", 503);
        }
        console.error("[API Token] Error regenerating token:", error);
        return sendError(res, "Failed to regenerate API token", 500);
    }
}

export async function deleteApiToken(req: AuthenticatedRequest, res: Response) {
    try {
        const userId = requireAuthenticatedUserId(req, res);
        if (!userId) return;
        const body = TOKEN_MUTATION.parse(req.body);

        const token = await prisma.apiToken.findFirst({
            where: {
                id: body.tokenId,
                userId,
            },
        });

        if (!token) {
            return sendError(res, "Token not found or access denied", 404);
        }

        await prisma.apiToken.update({
            where: { id: body.tokenId },
            data: {
                isActive: false,
                revokedAt: new Date(),
                revocationReason: "deleted_by_user",
            },
        });
        await invalidateTenantCache(userId, token.businessId);

        console.log(`[API Token] Soft-deleted token ${body.tokenId} for user ${userId}`);

        return sendSuccess(res, { id: body.tokenId }, "API token deleted successfully");
    } catch (error) {
        if (error instanceof z.ZodError) {
            return handleValidationError(res, error);
        }
        console.error("[API Token] Error deleting token:", error);
        return sendError(res, "Failed to delete API token", 500);
    }
}

export function hashTokenForValidation(plainToken: string): string {
    return hashToken(plainToken);
}
