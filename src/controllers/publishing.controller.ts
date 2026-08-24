import { ConnectionPlatform, PublishStatus, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { updateBlogUrl } from "../config/pinecone.config";
import {
  PublishingService,
  tryAcquirePublishLock,
  releasePublishLock,
} from "../services/publishing.service";
import { syncManagedBacklinksForPublishedBlog } from "../services/managed-backlinks.service";
import {
  decryptPublishingSecret,
  encryptPublishingSecret,
  type PublishingSecretKind,
} from "../utils/publishing-secret-crypto";
import {
    handleValidationError,
    sendError,
    sendSuccess,
} from "../utils/response.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";
import type { PublishingIntegrationData } from "../types/publishing.types";
import {
    CONNECT_PUBLISHING_INTEGRATION,
    GET_PUBLISHED_BLOGS,
    PUBLISH_BLOG,
    TEST_CONNECTION,
    UPDATE_PUBLISHING_INTEGRATION,
} from "../validators/publishing.validation";
import { buildExtendedBlogMeta, extractStoredSeoMeta } from "../utils/blog-seo.utils";
import { normalizeCloudinaryImageUrl } from "../lib/cloudinary";
import { sanitizeBlogContentImageSources } from "../utils/blog-image-url.utils";
import { guardUrl, SsrfBlocked } from "../utils/ssrf-guard";


const publishingService = new PublishingService();

async function normalizeOutboundIntegrationUrl(rawUrl: string): Promise<string> {
  const { url } = await guardUrl(rawUrl);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new SsrfBlocked("HTTPS is required", "https_required");
  }
  if (url.username || url.password) {
    throw new SsrfBlocked("URL credentials are not allowed", "embedded_credentials");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function decryptStoredPublishingValue(
  value: string | null | undefined,
  kind: PublishingSecretKind,
) {
  if (!value) {
    return null;
  }

  return decryptPublishingSecret(value, kind);
}

function sanitizePublishingIntegration<T extends Record<string, any>>(
  integration: T,
) {
  return {
    ...integration,
    wordpressPassword: integration.wordpressPassword ? "***" : null,
    shopifyAccessToken: integration.shopifyAccessToken ? "***" : null,
    shopifyClientId: decryptStoredPublishingValue(
      integration.shopifyClientId,
      "shopify-client-id",
    ),
    shopifyClientSecret: null,
    hasShopifyClientSecret: Boolean(integration.shopifyClientSecret),
    webflowApiKey: integration.webflowApiKey ? "***" : null,
    framerApiKey: integration.framerApiKey ? "***" : null,
    customApiKey: integration.customApiKey ? "***" : null,
    customApiSecret: integration.customApiSecret ? "***" : null,
    wordpressIntegrationKey: null,
    hasWordpressIntegrationKey: Boolean(integration.wordpressIntegrationKey),
  };
}

/**
 * Connect a publishing integration
 */
export async function connectIntegration(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = CONNECT_PUBLISHING_INTEGRATION.parse(req.body);

    const databaseUserId = authUserId;
    const existingIntegration = await prisma.publishingIntegration.findFirst({
      where: {
        userId: databaseUserId,
        platform: body.platform,
        businessId: body.businessId,
      },
    });

    // Validate platform-specific fields
    const validationError = validatePlatformFields(body, existingIntegration);
    if (validationError) {
      return sendError(res, validationError, 400);
    }

    const business = await prisma.business.findFirst({
      where: {
        id: body.businessId,
        userId: databaseUserId,
      },
    });
    if (!business) {
      return sendError(res, "Business not found or access denied", 404);
    }

    if (body.platform === ConnectionPlatform.WORDPRESS && body.wordpressUrl) {
      body.wordpressUrl = await normalizeOutboundIntegrationUrl(body.wordpressUrl);
    }
    if (body.platform === ConnectionPlatform.CUSTOM_API && body.customApiUrl) {
      body.customApiUrl = await normalizeOutboundIntegrationUrl(body.customApiUrl);
    }

    // Validate: WordPress integrations require a valid URL before autoPublish can be enabled
    const wantsAutoPublish = body.autoPublish !== undefined ? body.autoPublish : true;
    if (
      wantsAutoPublish &&
      body.platform === ConnectionPlatform.WORDPRESS &&
      !body.wordpressUrl?.trim()
    ) {
      return sendError(
        res,
        "WordPress URL is required to enable auto-publish. Please configure your WordPress site URL first.",
        400,
      );
    }

    const integrationData: any = {
      userId: databaseUserId,
      businessId: body.businessId,
      platform: body.platform,
      isActive: true,
      autoPublish: wantsAutoPublish,
      publishAs: body.publishAs || "PUBLISH",
      connectionName: body.connectionName,
    };

    // Add platform-specific fields
    switch (body.platform) {
      case ConnectionPlatform.WORDPRESS:
        if (
          body.wordpressUrl &&
          body.wordpressUsername &&
          body.wordpressPassword
        ) {
          integrationData.wordpressUrl = body.wordpressUrl;
          integrationData.wordpressUsername = body.wordpressUsername;
          integrationData.wordpressPassword = encryptPublishingSecret(
            body.wordpressPassword,
            "wordpress-password",
          );
        }
        break;
      case ConnectionPlatform.SHOPIFY:
        if (body.shopifyShopDomain) {
          const existingShopifyClientId = decryptStoredPublishingValue(
            existingIntegration?.shopifyClientId,
            "shopify-client-id",
          );
          const connectionMethod =
            body.shopifyConnectionMethod ||
            existingIntegration?.shopifyConnectionMethod ||
            "API_KEY";

          integrationData.shopifyShopDomain = body.shopifyShopDomain;
          integrationData.shopifyApiVersion =
            body.shopifyApiVersion || "2026-01";
          integrationData.shopifyBlogId = body.shopifyBlogId;
          integrationData.shopifyApiMethod = body.shopifyApiMethod || "REST";
          integrationData.shopifyConnectionMethod = connectionMethod;

          if (connectionMethod === "API_KEY") {
            if (body.shopifyAccessToken) {
              integrationData.shopifyAccessToken = encryptPublishingSecret(
                body.shopifyAccessToken,
                "shopify-access-token",
              );
            }

            integrationData.shopifyClientId = null;
            integrationData.shopifyClientSecret = null;
            integrationData.shopifyAccessTokenIssuedAt = null;
            integrationData.shopifyAccessTokenExpiresAt = null;
            integrationData.shopifyOAuthTokenId = null;
          } else if (connectionMethod === "CUSTOM_APP") {
            const nextClientId =
              body.shopifyClientId || existingShopifyClientId;

            integrationData.shopifyClientId = nextClientId
              ? encryptPublishingSecret(nextClientId, "shopify-client-id")
              : null;
            integrationData.shopifyOAuthTokenId = null;

            if (body.shopifyClientSecret) {
              integrationData.shopifyClientSecret = encryptPublishingSecret(
                body.shopifyClientSecret,
                "shopify-client-secret",
              );
            }

            if (
              body.shopifyClientId ||
              body.shopifyClientSecret ||
              existingIntegration?.shopifyConnectionMethod !== "CUSTOM_APP"
            ) {
              integrationData.shopifyAccessToken = null;
              integrationData.shopifyAccessTokenIssuedAt = null;
              integrationData.shopifyAccessTokenExpiresAt = null;
            }
          }
        }
        break;
      case ConnectionPlatform.WEBFLOW:
        if (body.webflowSiteId) {
          integrationData.webflowSiteId = body.webflowSiteId;
          if (body.webflowCollectionId !== undefined) {
            integrationData.webflowCollectionId = body.webflowCollectionId;
          }
          if (body.webflowApiKey) {
            integrationData.webflowApiKey = encryptPublishingSecret(
              body.webflowApiKey,
              "webflow-site-token",
            );
          }
          if (body.webflowConnectionMethod) {
            integrationData.webflowConnectionMethod = body.webflowConnectionMethod;
          }
        }
        break;
      case ConnectionPlatform.FRAMER:
        if (body.framerProjectId && body.framerApiKey) {
          integrationData.framerProjectId = body.framerProjectId;
          integrationData.framerApiKey = encryptPublishingSecret(
            body.framerApiKey,
            "framer-api-key",
          );
          integrationData.framerCollectionName = body.framerCollectionName;
        }
        break;
      case ConnectionPlatform.CUSTOM_API:
        if (body.customApiUrl) {
          integrationData.customApiUrl = body.customApiUrl;
          if (body.customApiKey) {
            integrationData.customApiKey = encryptPublishingSecret(
              body.customApiKey,
              "custom-api-key",
            );
          }
          if (body.customApiSecret) {
            integrationData.customApiSecret = encryptPublishingSecret(
              body.customApiSecret,
              "custom-api-secret",
            );
          }
          integrationData.customApiMethod = body.customApiMethod || "POST";
          integrationData.customApiAuthType =
            body.customApiAuthType || "bearer";
          integrationData.customApiHeaders = body.customApiHeaders;
          integrationData.customApiPayloadMapping =
            body.customApiPayloadMapping;
          integrationData.customApiResponseMapping =
            body.customApiResponseMapping;
        }
        break;
    }

    const normalizeWordPressUrl = (url: string): string =>
      url.trim().toLowerCase().replace(/\/$/, "");

    if (
      body.platform === ConnectionPlatform.WORDPRESS &&
      body.wordpressUrl &&
      body.businessId
    ) {
      const siteKey = normalizeWordPressUrl(body.wordpressUrl);
      const sameSite = await prisma.publishingIntegration.findMany({
        where: {
          userId: databaseUserId,
          platform: ConnectionPlatform.WORDPRESS,
          businessId: body.businessId,
          isActive: true,
        },
      });
      const toDeactivate = sameSite.filter(
        (i) => i.wordpressUrl && normalizeWordPressUrl(i.wordpressUrl) === siteKey
      );
      if (toDeactivate.length > 0) {
        await prisma.publishingIntegration.updateMany({
          where: { id: { in: toDeactivate.map((i) => i.id) } },
          data: { isActive: false },
        });
      }
    }

    let integration: { id: string } | null = null;
    let isMigration = false;

    if (body.businessId) {
      const legacyIntegration = await prisma.publishingIntegration.findFirst({
        where: {
          userId: databaseUserId,
          platform: body.platform,
          businessId: null,
        },
        orderBy: { createdAt: "desc" },
      });

      if (legacyIntegration) {
        const existingWithBusinessId =
          await prisma.publishingIntegration.findUnique({
            where: {
              userId_platform_businessId: {
                userId: databaseUserId,
                platform: body.platform,
                businessId: body.businessId,
              },
            },
          });

        if (existingWithBusinessId) {
          integration = await prisma.publishingIntegration.update({
            where: { id: existingWithBusinessId.id },
            data: {
              ...integrationData,
              updatedAt: new Date(),
            },
          });
          await prisma.publishingIntegration.updateMany({
            where: {
              userId: databaseUserId,
              platform: body.platform,
              businessId: null,
              id: { not: legacyIntegration.id },
            },
            data: { isActive: false },
          });
        } else {
          integration = await prisma.publishingIntegration.update({
            where: { id: legacyIntegration.id },
            data: {
              ...integrationData,
              updatedAt: new Date(),
            },
          });
          isMigration = true;
          await prisma.publishingIntegration.updateMany({
            where: {
              userId: databaseUserId,
              platform: body.platform,
              businessId: null,
              id: { not: legacyIntegration.id },
            },
            data: { isActive: false },
          });
        }
      } else {
        integration = await prisma.publishingIntegration.upsert({
          where: {
            userId_platform_businessId: {
              userId: databaseUserId,
              platform: body.platform,
              businessId: body.businessId,
            },
          },
          create: integrationData,
          update: {
            ...integrationData,
            updatedAt: new Date(),
          },
        });
      }
    }

    if (!integration) {
      return sendError(res, "Failed to create or update integration", 500);
    }

    try {
      const testResult = await publishingService.testConnection(
        integration as unknown as PublishingIntegrationData,
      );
      await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: {
          isVerified: testResult.success,
          lastError: testResult.error || null,
          lastErrorAt: testResult.error ? new Date() : null,
          // Store plugin version from test response if available
          ...(testResult.pluginVersion ? { pluginVersion: testResult.pluginVersion } : {}),
        },
      });
    } catch (testError: any) {
      console.error("Connection test failed:", testError);
    }

    const successMessage = isMigration
      ? "Integration migrated and connected successfully"
      : "Success";
    await invalidateTenantCache(authUserId, body.businessId);

    return sendSuccess(
      res,
      { integration: sanitizePublishingIntegration(integration) },
      successMessage,
      201,
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    if (error instanceof SsrfBlocked) {
      return sendError(res, "Integration URL is not allowed", 400);
    }
    console.error("Error connecting integration:", error);
    return sendError(res, "Failed to connect integration", 500);
  }
}

/**
 * Update a publishing integration
 */
export async function updateIntegration(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = UPDATE_PUBLISHING_INTEGRATION.parse(req.body);
    const { integrationId } = req.params;

    if (!integrationId) {
      return sendError(res, "Integration ID is required", 400);
    }

    const databaseUserId = authUserId;

    // Get existing integration
    const existing = await prisma.publishingIntegration.findUnique({
      where: { id: integrationId },
    });

    if (!existing) {
      return sendError(res, "Integration not found", 404);
    }

    // Verify user owns this integration
    if (existing.userId !== databaseUserId) {
      return sendError(res, "Unauthorized", 403);
    }

    if (body.platform && body.platform !== existing.platform) {
      return sendError(res, "Integration platform cannot be changed", 400);
    }
    if (body.businessId && body.businessId !== existing.businessId) {
      return sendError(res, "Integration business cannot be changed", 400);
    }

    const effectivePlatform = existing.platform;

    if (effectivePlatform === ConnectionPlatform.WORDPRESS && body.wordpressUrl) {
      body.wordpressUrl = await normalizeOutboundIntegrationUrl(body.wordpressUrl);
    }
    if (effectivePlatform === ConnectionPlatform.CUSTOM_API && body.customApiUrl) {
      body.customApiUrl = await normalizeOutboundIntegrationUrl(body.customApiUrl);
    }

    // Prepare update data
    const updateData: any = {};

    // Validate: WordPress integrations require a valid URL before autoPublish can be enabled
    if (body.autoPublish === true && existing.platform === "WORDPRESS") {
      const effectiveUrl = body.wordpressUrl?.trim() || existing.wordpressUrl?.trim();
      if (!effectiveUrl) {
        return sendError(
          res,
          "WordPress URL is required to enable auto-publish. Please configure your WordPress site URL first.",
          400,
        );
      }
    }

    if (body.connectionName !== undefined)
      updateData.connectionName = body.connectionName;
    if (body.autoPublish !== undefined)
      updateData.autoPublish = body.autoPublish;
    if (body.publishAs !== undefined) updateData.publishAs = body.publishAs;

    // Update platform-specific fields
    if (effectivePlatform === ConnectionPlatform.WORDPRESS) {
      if (body.wordpressUrl) updateData.wordpressUrl = body.wordpressUrl;
      if (body.wordpressUsername)
        updateData.wordpressUsername = body.wordpressUsername;
      if (body.wordpressPassword)
        updateData.wordpressPassword = encryptPublishingSecret(
          body.wordpressPassword,
          "wordpress-password",
        );
    } else if (effectivePlatform === ConnectionPlatform.SHOPIFY) {
      if (body.shopifyShopDomain)
        updateData.shopifyShopDomain = body.shopifyShopDomain;
      if (body.shopifyApiVersion)
        updateData.shopifyApiVersion = body.shopifyApiVersion;
      if (body.shopifyBlogId !== undefined)
        updateData.shopifyBlogId = body.shopifyBlogId;
      if (body.shopifyApiMethod !== undefined)
        updateData.shopifyApiMethod = body.shopifyApiMethod;
      if (body.shopifyConnectionMethod !== undefined)
        updateData.shopifyConnectionMethod = body.shopifyConnectionMethod;

      const connectionMethod =
        body.shopifyConnectionMethod ||
        existing.shopifyConnectionMethod ||
        "API_KEY";
      const existingShopifyClientId = decryptStoredPublishingValue(
        existing.shopifyClientId,
        "shopify-client-id",
      );

      if (connectionMethod === "API_KEY") {
        if (
          !body.shopifyAccessToken &&
          (existing.shopifyConnectionMethod !== "API_KEY" ||
            !existing.shopifyAccessToken)
        ) {
          return sendError(
            res,
            "Shopify shop domain and access token are required",
            400,
          );
        }

        if (body.shopifyAccessToken)
          updateData.shopifyAccessToken = encryptPublishingSecret(
            body.shopifyAccessToken,
            "shopify-access-token",
          );
        updateData.shopifyClientId = null;
        updateData.shopifyClientSecret = null;
        updateData.shopifyAccessTokenIssuedAt = null;
        updateData.shopifyAccessTokenExpiresAt = null;
        updateData.shopifyOAuthTokenId = null;
      } else if (connectionMethod === "CUSTOM_APP") {
        if (!body.shopifyClientId && !existingShopifyClientId) {
          return sendError(
            res,
            "Shopify shop domain, client ID, and client secret are required",
            400,
          );
        }
        if (!body.shopifyClientSecret && !existing.shopifyClientSecret) {
          return sendError(
            res,
            "Shopify shop domain, client ID, and client secret are required",
            400,
          );
        }
        if (
          body.shopifyClientId &&
          body.shopifyClientId !== existingShopifyClientId &&
          !body.shopifyClientSecret
        ) {
          return sendError(
            res,
            "Please re-enter the Shopify client secret when changing the client ID",
            400,
          );
        }

        if (body.shopifyClientId !== undefined)
          updateData.shopifyClientId = encryptPublishingSecret(
            body.shopifyClientId,
            "shopify-client-id",
          );
        if (body.shopifyClientSecret)
          updateData.shopifyClientSecret = encryptPublishingSecret(
            body.shopifyClientSecret,
            "shopify-client-secret",
          );
        updateData.shopifyOAuthTokenId = null;

        if (
          body.shopifyClientId !== undefined ||
          body.shopifyClientSecret !== undefined ||
          existing.shopifyConnectionMethod !== "CUSTOM_APP"
        ) {
          updateData.shopifyAccessToken = null;
          updateData.shopifyAccessTokenIssuedAt = null;
          updateData.shopifyAccessTokenExpiresAt = null;
        }
      }
    } else if (effectivePlatform === ConnectionPlatform.WEBFLOW) {
      if (body.webflowSiteId) updateData.webflowSiteId = body.webflowSiteId;
      if (body.webflowApiKey)
        updateData.webflowApiKey = encryptPublishingSecret(
          body.webflowApiKey,
          "webflow-site-token",
        );
      if (body.webflowCollectionId !== undefined)
        updateData.webflowCollectionId = body.webflowCollectionId;
    } else if (effectivePlatform === ConnectionPlatform.FRAMER) {
      if (body.framerProjectId)
        updateData.framerProjectId = body.framerProjectId;
      if (body.framerApiKey)
        updateData.framerApiKey = encryptPublishingSecret(
          body.framerApiKey,
          "framer-api-key",
        );
      if (body.framerCollectionName !== undefined)
        updateData.framerCollectionName = body.framerCollectionName;
    } else if (effectivePlatform === ConnectionPlatform.CUSTOM_API) {
      if (body.customApiUrl) updateData.customApiUrl = body.customApiUrl;
      if (body.customApiKey)
        updateData.customApiKey = encryptPublishingSecret(
          body.customApiKey,
          "custom-api-key",
        );
      if (body.customApiSecret)
        updateData.customApiSecret = encryptPublishingSecret(
          body.customApiSecret,
          "custom-api-secret",
        );
      if (body.customApiMethod)
        updateData.customApiMethod = body.customApiMethod;
      if (body.customApiAuthType)
        updateData.customApiAuthType = body.customApiAuthType;
      if (body.customApiHeaders !== undefined)
        updateData.customApiHeaders = body.customApiHeaders;
      if (body.customApiPayloadMapping !== undefined)
        updateData.customApiPayloadMapping = body.customApiPayloadMapping;
      if (body.customApiResponseMapping !== undefined)
        updateData.customApiResponseMapping = body.customApiResponseMapping;
    }

    const integration = await prisma.publishingIntegration.update({
      where: { id: integrationId },
      data: updateData,
    });
    await invalidateTenantCache(authUserId, integration.businessId);

    return sendSuccess(res, {
      integration: sanitizePublishingIntegration(integration),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    if (error instanceof SsrfBlocked) {
      return sendError(res, "Integration URL is not allowed", 400);
    }
    console.error("Error updating integration:", error);
    return sendError(res, "Failed to update integration", 500);
  }
}

/**
 * Get all integrations for a user (optionally filtered by businessId)
 */
export async function getIntegrations(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    if (req.params.userId && req.params.userId !== authUserId) {
      return sendError(res, "Unauthorized", 403);
    }
    const businessId = req.query.businessId as string | undefined;

    const databaseUserId = authUserId;

    // Build where clause
    const whereClause: any = {
      userId: databaseUserId,
      isActive: true,
    };

    // Filter by businessId if provided
    if (businessId) {
      // Check if this is the primary business
      const business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId: databaseUserId,
          isActive: true,
        },
        select: { id: true, isPrimary: true },
      });

      if (business?.isPrimary) {
        // Primary business: include its integrations + legacy integrations (null businessId)
        whereClause.OR = [
          { businessId: businessId },
          { businessId: null }, // Legacy integrations
        ];
      } else {
        // Non-primary business: only show its own integrations
        whereClause.businessId = businessId;
      }
    } else {
      // If no businessId, get primary business and show its integrations + legacy
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: databaseUserId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });

      if (primaryBusiness) {
        whereClause.OR = [
          { businessId: primaryBusiness.id },
          { businessId: null }, // Legacy integrations
        ];
      } else {
        // No primary business, only show legacy integrations
        whereClause.businessId = null;
      }
    }

    // Now query integrations using the database User.id
    const integrations = await prisma.publishingIntegration.findMany({
      where: whereClause,
      include: {
        wordpressOAuthToken: {
          select: {
            id: true,
            wordpressSiteUrl: true,
            isActive: true,
            connectedAt: true,
            lastUsedAt: true,
            tokenExpiresAt: true,
          },
        },
        shopifyOAuthToken: {
          select: {
            id: true,
            shopDomain: true,
            isActive: true,
            connectedAt: true,
            lastUsedAt: true,
            tokenExpiresAt: true,
            shopName: true,
          },
        },
        webflowOAuthToken: {
          select: {
            id: true,
            siteId: true,
            isActive: true,
            connectedAt: true,
            lastUsedAt: true,
            tokenExpiresAt: true,
            siteName: true,
            siteUrl: true,
          },
        },
        wixOAuthToken: {
          select: {
            id: true,
            wixSiteId: true,
            wixInstanceId: true,
            isActive: true,
            connectedAt: true,
            lastUsedAt: true,
            tokenExpiresAt: true,
            siteName: true,
            siteUrl: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Remove sensitive data from response
    const sanitized = integrations.map((integration) =>
      sanitizePublishingIntegration(integration),
    );

    return sendSuccess(res, { integrations: sanitized });
  } catch (error) {
    console.error("Error fetching integrations:", error);
    return sendError(res, "Failed to fetch integrations", 500);
  }
}

/**
 * Delete/Disconnect an integration
 */
export async function disconnectIntegration(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const { integrationId } = req.params;

    if (!integrationId) {
      return sendError(res, "Integration ID is required", 400);
    }

    const databaseUserId = authUserId;

    const integration = await prisma.publishingIntegration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      return sendError(res, "Integration not found", 404);
    }

    if (integration.userId !== databaseUserId) {
      return sendError(res, "Unauthorized", 403);
    }

    // Deactivate related OAuth tokens before clearing references
    if (integration.shopifyOAuthTokenId) {
      await prisma.shopifyOAuthToken.update({
        where: { id: integration.shopifyOAuthTokenId },
        data: { isActive: false },
      }).catch((e) => console.error("[Publishing] Failed to deactivate Shopify OAuth token:", e));
    }
    if (integration.webflowOAuthTokenId) {
      await prisma.webflowOAuthToken.update({
        where: { id: integration.webflowOAuthTokenId },
        data: { isActive: false },
      }).catch((e) => console.error("[Publishing] Failed to deactivate Webflow OAuth token:", e));
    }
    if (integration.wixOAuthTokenId) {
      await prisma.wixOAuthToken.update({
        where: { id: integration.wixOAuthTokenId },
        data: { isActive: false },
      }).catch((e) => console.error("[Publishing] Failed to deactivate Wix OAuth token:", e));
    }
    if (integration.redditOAuthTokenId) {
      await prisma.redditOAuthToken.update({
        where: { id: integration.redditOAuthTokenId },
        data: { isActive: false },
      }).catch((e) => console.error("[Publishing] Failed to deactivate Reddit OAuth token:", e));
    }
    if (integration.mediumOAuthTokenId) {
      await prisma.mediumOAuthToken.update({
        where: { id: integration.mediumOAuthTokenId },
        data: { isActive: false },
      }).catch((e) => console.error("[Publishing] Failed to deactivate Medium OAuth token:", e));
    }

    // Soft delete by setting isActive to false and clearing all platform-specific data
    await prisma.publishingIntegration.update({
      where: { id: integrationId },
      data: { 
        isActive: false,
        isVerified: false,
        
        // WordPress fields
        wordpressUrl: null,
        wordpressUsername: null,
        wordpressPassword: null,
        wordpressConnectionMethod: null,
        wordpressOAuthTokenId: null,
        wordpressIntegrationKey: null,
        wordpressIntegrationKeyDigest: null,
        wordpressIntegrationKeyCreatedAt: null,
        wordpressIntegrationKeyLastUsedAt: null,
        
        // Shopify fields
        shopifyShopDomain: null,
        shopifyAccessToken: null,
        shopifyClientId: null,
        shopifyClientSecret: null,
        shopifyAccessTokenIssuedAt: null,
        shopifyAccessTokenExpiresAt: null,
        shopifyApiVersion: null,
        shopifyBlogId: null,
        shopifyConnectionMethod: null,
        shopifyOAuthTokenId: null,
        shopifyApiMethod: null,
        
        // Webflow fields
        webflowSiteId: null,
        webflowApiKey: null,
        webflowCollectionId: null,
        webflowConnectionMethod: null,
        webflowOAuthTokenId: null,
        
        // Framer fields
        framerProjectId: null,
        framerApiKey: null,
        framerCollectionName: null,
        
        // Custom API fields
        customApiUrl: null,
        customApiKey: null,
        customApiSecret: null,
        customApiMethod: null,
        customApiAuthType: null,
        customApiHeaders: Prisma.JsonNull,
        customApiPayloadMapping: Prisma.JsonNull,
        customApiResponseMapping: Prisma.JsonNull,
        
        // Wix fields
        wixSiteId: null,
        wixConnectionMethod: null,
        wixOAuthTokenId: null,
        wixCollectionId: null,
        
        // Reddit fields
        redditOAuthTokenId: null,
        redditSubreddit: null,
        
        // Medium fields
        mediumOAuthTokenId: null,
        mediumPublicationId: null,
        
        // Clear connection name
        connectionName: null,
      },
    });

    console.log(`[Publishing] Integration ${integrationId} disconnected, OAuth tokens deactivated, and all credentials cleared`);
    await invalidateTenantCache(authUserId, integration.businessId);

    return sendSuccess(res, { message: "Integration disconnected" });
  } catch (error) {
    console.error("Error disconnecting integration:", error);
    return sendError(res, "Failed to disconnect integration", 500);
  }
}

/**
 * Test connection to an integration
 */
export async function testConnection(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = TEST_CONNECTION.parse(req.body);

    const databaseUserId = authUserId;

    const integration = await prisma.publishingIntegration.findUnique({
      where: { id: body.integrationId },
    });

    if (!integration) {
      return sendError(res, "Integration not found", 404);
    }

    if (integration.userId !== databaseUserId) {
      return sendError(res, "Unauthorized", 403);
    }

    const result = await publishingService.testConnection(
      integration as unknown as PublishingIntegrationData,
    );

    // Update integration with test result
    await prisma.publishingIntegration.update({
      where: { id: body.integrationId },
      data: {
        isVerified: result.success,
        lastError: result.error || null,
        lastErrorAt: result.error ? new Date() : null,
        lastSyncAt: result.success ? new Date() : null,
        // Store plugin version from test response if available
        ...(result.pluginVersion ? { pluginVersion: result.pluginVersion } : {}),
      },
    });

    return sendSuccess(res, result);
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error testing connection:", error);
    return sendError(res, "Failed to test connection", 500);
  }
}

/**
 * Publish a blog to one or more platforms
 */
export async function publishBlog(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    const body = PUBLISH_BLOG.parse(req.body);

    const databaseUserId = authUserId;

    console.log("[publishBlog] Received request:", {
      userId: databaseUserId,
      blogId: body.blogId,
      integrationId: body.integrationId,
      platform: body.platform,
    });

    // Fetch blog
    const blog = await prisma.blog.findUnique({
      where: { id: body.blogId },
      include: {
        meta: true,
        customField: true,
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            defaultLocale: true,
          },
        },
      },
    });

    if (!blog) {
      return sendError(res, "Blog not found", 404);
    }

    // Verify blog belongs to the user
    if (blog.userId !== databaseUserId) {
      return sendError(res, "Unauthorized: Blog does not belong to user", 403);
    }

    // Verify business ownership if businessId is provided
    if (body.businessId && blog.businessId !== body.businessId) {
      return sendError(res, "Unauthorized: Blog does not belong to the specified business", 403);
    }

    // Use blog's businessId if body.businessId is not provided
    const targetBusinessId = body.businessId || blog.businessId;
    const normalizedFeaturedMedia = normalizeCloudinaryImageUrl(
      blog.featured_media || "",
    );
    const normalizedContent = sanitizeBlogContentImageSources(
      blog.content,
    ).content;

    // Prepare blog data
    const blogData: any = {
      id: blog.id,
      title: blog.title,
      content: normalizedContent,
      excerpt: blog.excerpt,
      slug: blog.slug,
      featured_media: normalizedFeaturedMedia,
      status: blog.status,
      userId: blog.userId,
      blogPublishDate: blog.blogPublishDate,
      blogPublishTime: blog.blogPublishTime,
      meta: blog.meta
        ? buildExtendedBlogMeta({
            title: blog.title,
            excerpt: blog.excerpt,
            slug: blog.slug,
            meta: {
              ...blog.meta,
              ...extractStoredSeoMeta(blog.analytics),
            },
            categories: blog.categories,
            tags: blog.tags,
            authorName: blog.authorName,
            businessName: blog.business?.businessName,
            businessWebsiteUrl: blog.business?.businessWebsiteUrl,
            defaultLocale: blog.business?.defaultLocale,
          })
        : undefined,
      custom_fields: blog.customField
        ? {
            reading_time: blog.customField.reading_time,
            rating: blog.customField.rating,
          }
        : undefined,
      categories: blog.categories,
      tags: blog.tags,
    };

    // Find integrations to publish to
    let integrations;

    if (body.integrationId) {
      // Publish to specific integration
      const integration = await prisma.publishingIntegration.findUnique({
        where: { id: body.integrationId },
        include: {
          wordpressOAuthToken: true,
          shopifyOAuthToken: true,
          webflowOAuthToken: true,
        },
      });
      if (!integration || integration.userId !== databaseUserId) {
        return sendError(res, "Integration not found", 404);
      }
      // Verify integration belongs to the same business as the blog
      // Allow null businessId integrations to work with primary business blogs (legacy support)
      if (targetBusinessId && integration.businessId !== null && integration.businessId !== targetBusinessId) {
        return sendError(res, "Integration does not belong to the blog's business", 403);
      }
      // If integration has null businessId (legacy), verify it's being used with primary business
      if (targetBusinessId && integration.businessId === null) {
        const business = await prisma.business.findFirst({
          where: {
            id: targetBusinessId,
            userId: databaseUserId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });
        // Legacy integrations (null businessId) can only work with primary business
        if (!business?.isPrimary) {
          return sendError(res, "Legacy integration can only be used with primary business", 403);
        }
      }
      integrations = [integration];
    } else if (body.platform) {
      // Publish to all integrations of a platform for this business
      const whereClause: any = {
        userId: databaseUserId,
        platform: body.platform,
        isActive: true,
      };
      if (targetBusinessId) {
        const business = await prisma.business.findFirst({
          where: {
            id: targetBusinessId,
            userId: databaseUserId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business?.isPrimary) {
          const hasScoped = await prisma.publishingIntegration.count({
            where: {
              userId: databaseUserId,
              platform: body.platform,
              isActive: true,
              businessId: targetBusinessId,
            },
          });
          if (hasScoped > 0) {
            whereClause.businessId = targetBusinessId;
          } else {
            whereClause.OR = [
              { businessId: targetBusinessId },
              { businessId: null },
            ];
          }
        } else {
          whereClause.businessId = targetBusinessId;
        }
      }
      integrations = await prisma.publishingIntegration.findMany({
        where: whereClause,
        include: {
          wordpressOAuthToken: true,
          shopifyOAuthToken: true,
          webflowOAuthToken: true,
        },
      });
    } else {
      const whereClause: any = {
        userId: databaseUserId,
        isActive: true,
        autoPublish: false,
      };
      if (targetBusinessId) {
        const business = await prisma.business.findFirst({
          where: {
            id: targetBusinessId,
            userId: databaseUserId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business?.isPrimary) {
          const hasScoped = await prisma.publishingIntegration.count({
            where: {
              userId: databaseUserId,
              isActive: true,
              businessId: targetBusinessId,
            },
          });
          if (hasScoped > 0) {
            whereClause.businessId = targetBusinessId;
          } else {
            whereClause.OR = [
              { businessId: targetBusinessId },
              { businessId: null },
            ];
          }
        } else {
          whereClause.businessId = targetBusinessId;
        }
      }
      integrations = await prisma.publishingIntegration.findMany({
        where: whereClause,
        include: {
          wordpressOAuthToken: true,
          shopifyOAuthToken: true,
          webflowOAuthToken: true,
        },
      });
    }

    if (integrations.length === 0) {
      return sendError(res, "No active integrations found", 400);
    }

    const wordpressTargets = new Set<string>();
    const deduped = integrations.filter((i) => {
      if (i.platform === ConnectionPlatform.WORDPRESS && i.wordpressUrl) {
        const key = (i.wordpressUrl ?? "").toLowerCase();
        if (wordpressTargets.has(key)) return false;
        wordpressTargets.add(key);
      }
      return true;
    });
    integrations = deduped;

    const results = [];

    for (const integration of integrations) {
      const attemptId = `${body.blogId}:${integration.id}:${Date.now()}`;
      const lockResult = await tryAcquirePublishLock(
        body.blogId,
        integration.id,
        attemptId,
        integration.platform
      );

      if (!lockResult.acquired && lockResult.alreadyPublishing) {
        console.log(
          `[publishBlog] lock_skipped blogId=${body.blogId} integrationId=${integration.id} reason=already_publishing`
        );
        results.push({
          integrationId: integration.id,
          platform: integration.platform,
          success: false,
          message: "already publishing",
          skipped: true,
        });
        continue;
      }
      if (lockResult.staleRecovered) {
        console.log(
          `[publishBlog] stale_lock_recovered blogId=${body.blogId} integrationId=${integration.id}`
        );
      }
      console.log(
        `[publishBlog] lock_acquired blogId=${body.blogId} integrationId=${integration.id} attemptId=${attemptId}`
      );

      let publishedBlog = await prisma.publishedBlog.findUnique({
        where: {
          blogId_integrationId: {
            blogId: body.blogId,
            integrationId: integration.id,
          },
        },
      });

      if (
        publishedBlog &&
        publishedBlog.status === PublishStatus.PUBLISHED &&
        publishedBlog.externalPostId &&
        !body.forceUpdate
      ) {
        await releasePublishLock(body.blogId, integration.id);
        results.push({
          integrationId: integration.id,
          platform: integration.platform,
          success: true,
          postId: publishedBlog.externalPostId,
          postUrl: publishedBlog.externalPostUrl ?? undefined,
          message: "Already published",
          skipped: true,
        });
        continue;
      }

      const isUpdate = !!(
        publishedBlog &&
        publishedBlog.status === PublishStatus.PUBLISHED &&
        publishedBlog.externalPostId &&
        body.forceUpdate
      );

      if (!publishedBlog) {
        publishedBlog = await prisma.publishedBlog.create({
          data: {
            blogId: body.blogId,
            integrationId: integration.id,
            platform: integration.platform,
            status: PublishStatus.PUBLISHING,
          },
        });
      } else {
        await prisma.publishedBlog.update({
          where: { id: publishedBlog.id },
          data: { status: PublishStatus.PUBLISHING },
        });
      }

      try {
        const publishData = {
          ...blogData,
          attemptId,
          forceUpdate: isUpdate,
          externalPostId: isUpdate ? publishedBlog.externalPostId : undefined,
        };
        const publishResult = await publishingService.publishBlogWithRetry(
          publishData,
          integration as unknown as PublishingIntegrationData
        );

        const resolvedStatus = publishResult.success
          ? isUpdate
            ? PublishStatus.UPDATED
            : PublishStatus.PUBLISHED
          : publishResult.inProgress
            ? PublishStatus.PENDING
            : PublishStatus.FAILED;

        await prisma.publishedBlog.update({
          where: { id: publishedBlog.id },
          data: {
            status: resolvedStatus,
            externalPostId: publishResult.postId,
            externalPostUrl: publishResult.postUrl,
            publishStatus: publishResult.status,
            lastError: publishResult.error || publishResult.message,
            lastSyncedAt: new Date(),
            publishedAt: publishResult.success ? new Date() : null,
            platformResponse: publishResult.platformResponse,
            retryCount: publishResult.success
              ? 0
              : publishedBlog.retryCount + 1,
          },
        });

        if (publishResult.success && publishResult.postUrl) {
          try {
            await updateBlogUrl(body.blogId, publishResult.postUrl);
          } catch (err) {
            console.error("Failed to update blog URL in Pinecone:", err);
          }

          try {
            await syncManagedBacklinksForPublishedBlog({
              blogId: body.blogId,
              publishedUrl: publishResult.postUrl,
            });
          } catch (err) {
            console.error(
              "Failed to sync managed cross-links after publish:",
              err,
            );
          }
        }

        const actionType = isUpdate ? "update" : "publish";
        if (publishResult.success) {
          console.log(
            `[publishBlog] ${actionType}_success blogId=${body.blogId} integrationId=${integration.id} postId=${publishResult.postId ?? ""}`
          );
        } else {
          console.log(
            `[publishBlog] ${actionType}_failed blogId=${body.blogId} integrationId=${integration.id} error=${publishResult.error ?? ""}`
          );
        }
        results.push({
          integrationId: integration.id,
          platform: integration.platform,
          success: publishResult.success,
          postId: publishResult.postId,
          postUrl: publishResult.postUrl,
          error: publishResult.error,
        });
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`Error publishing to integration ${integration.id}:`, error);
        
        if (publishedBlog) {
          try {
            await prisma.publishedBlog.update({
              where: { id: publishedBlog.id },
              data: {
                status: PublishStatus.FAILED,
                lastError: errMsg,
                lastSyncedAt: new Date(),
                retryCount: publishedBlog.retryCount + 1,
              },
            });
            console.log(
              `[publishBlog] Updated PublishedBlog ${publishedBlog.id} to FAILED status after exception`
            );
          } catch (updateError) {
            console.error(
              `[publishBlog] Failed to update PublishedBlog status to FAILED:`,
              updateError
            );
          }
        }
        
        results.push({
          integrationId: integration.id,
          platform: integration.platform,
          success: false,
          error: errMsg,
        });
      } finally {
        await releasePublishLock(body.blogId, integration.id);
      }
    }

    return sendSuccess(res, { results });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error publishing blog:", error);
    return sendError(res, "Failed to publish blog", 500);
  }
}

/**
 * Get published blogs
 */
export async function getPublishedBlogs(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }
    if (req.params.userId && req.params.userId !== authUserId) {
      return sendError(res, "Unauthorized", 403);
    }
    const query = GET_PUBLISHED_BLOGS.parse(req.query);

    const databaseUserId = authUserId;

    const where: any = {
      blog: {
        userId: databaseUserId,
      },
    };

    if (query.businessId) {
      // Check if this is the primary business
      const business = await prisma.business.findFirst({
        where: {
          id: query.businessId,
          userId: databaseUserId,
          isActive: true,
        },
        select: { id: true, isPrimary: true },
      });

      if (business?.isPrimary) {
        // Primary business: show its published blogs + legacy published blogs (null businessId)
        where.blog.OR = [
          { businessId: business.id },
          { businessId: null }, // Legacy blogs from legacy onboarded business
        ];
      } else {
        // Non-primary business: only show its own published blogs (no legacy)
        where.blog.businessId = query.businessId;
      }
    } else {
      // If no businessId, get primary business and show its published blogs + legacy
      const primaryBusiness = await prisma.business.findFirst({
        where: {
          userId: databaseUserId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });

      if (primaryBusiness) {
        where.blog.OR = [
          { businessId: primaryBusiness.id },
          { businessId: null }, // Legacy blogs
        ];
      } else {
        // No primary business, only show legacy
        where.blog.businessId = null;
      }
    }

    if (query.blogId) {
      where.blogId = query.blogId;
    }

    if (query.platform) {
      where.platform = query.platform;
    }

    if (query.status) {
      where.status = query.status as PublishStatus;
    }

    const publishedBlogs = await prisma.publishedBlog.findMany({
      where,
      include: {
        integration: {
          select: {
            id: true,
            platform: true,
            connectionName: true,
          },
        },
        blog: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return sendSuccess(res, { publishedBlogs });
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Error fetching published blogs:", error);
    return sendError(res, "Failed to fetch published blogs", 500);
  }
}

/**
 * Helper: Validate platform-specific fields
 */
function validatePlatformFields(
  body: any,
  existingIntegration?: Record<string, any> | null,
): string | null {
  switch (body.platform) {
    case ConnectionPlatform.WORDPRESS:
      if (
        !body.wordpressUrl ||
        !body.wordpressUsername ||
        !body.wordpressPassword
      ) {
        return "WordPress URL, username, and password are required";
      }
      break;
    case ConnectionPlatform.SHOPIFY:
      if (!body.shopifyShopDomain) {
        return "Shopify shop domain is required";
      }

      const existingShopifyClientId = decryptStoredPublishingValue(
        existingIntegration?.shopifyClientId,
        "shopify-client-id",
      );

      switch (body.shopifyConnectionMethod || existingIntegration?.shopifyConnectionMethod || "API_KEY") {
        case "CUSTOM_APP":
          if (
            !body.shopifyClientId &&
            !existingShopifyClientId
          ) {
            return "Shopify shop domain, client ID, and client secret are required";
          }
        if (
          !body.shopifyClientSecret &&
          !existingIntegration?.shopifyClientSecret
        ) {
          return "Shopify shop domain, client ID, and client secret are required";
        }
        if (
          body.shopifyClientId &&
          body.shopifyClientId !== existingShopifyClientId &&
          !body.shopifyClientSecret
        ) {
          return "Please re-enter the Shopify client secret when changing the client ID";
        }
        break;
        case "OAUTH":
          break;
        default:
          if (
            !body.shopifyAccessToken &&
            (existingIntegration?.shopifyConnectionMethod !== "API_KEY" ||
              !existingIntegration?.shopifyAccessToken)
          ) {
            return "Shopify shop domain and access token are required";
          }
          break;
      }
      break;
    case ConnectionPlatform.WEBFLOW: {
      if (!body.webflowSiteId) {
        return "Webflow site ID is required";
      }
      const webflowMethod = body.webflowConnectionMethod
        || existingIntegration?.webflowConnectionMethod
        || "API_KEY";
      if (webflowMethod !== "OAUTH" && !body.webflowApiKey && !existingIntegration?.webflowApiKey) {
        return "Webflow API key is required for API key connections";
      }
      break;
    }
    case ConnectionPlatform.FRAMER:
      if (!body.framerProjectId || !body.framerApiKey) {
        return "Framer project ID and API key are required";
      }
      break;
    case ConnectionPlatform.CUSTOM_API:
      if (!body.customApiUrl) {
        return "Custom API URL is required";
      }
      break;
  }
  return null;
}
