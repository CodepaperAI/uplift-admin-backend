import { ConnectionPlatform } from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db.config";
import { updateBlogUrl } from "../config/pinecone.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { syncManagedBacklinksForPublishedBlog } from "../services/managed-backlinks.service";
import {
    handleValidationError,
    sendError,
    sendSuccess
} from "../utils/response.utils";
import {
  authenticateWordPressIntegrationKey,
  generateWordPressKeyCredential,
  WordPressKeyConfigurationError,
} from "../utils/wordpress-key.utils";
import {
  decryptPublishingSecret,
  encryptPublishingSecret,
} from "../utils/publishing-secret-crypto";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

const WORDPRESS_KEY_ADMIN_BODY = z
  .object({ businessId: z.string().uuid() })
  .strict();

const WORDPRESS_KEY_VALIDATION_BODY = z.object({
  // Body support remains temporarily for older plugin builds. Version 2.3+
  // sends credentials in Authorization so reverse-proxy body logs cannot
  // capture a reusable publishing secret.
  integrationKey: z.string().trim().min(20).max(256).optional(),
  wordpressSiteUrl: z.string().trim().url().max(2048),
}).strict();

const WORDPRESS_SCHEMA_CONTEXT_BODY = WORDPRESS_KEY_VALIDATION_BODY;

const WORDPRESS_WEBHOOK_BODY = z.object({
  event: z.enum(["post.published", "post.failed", "post.updated", "post.content_updated", "post.update_failed"]),
  data: z.record(z.string().max(64), z.unknown()).refine(
    (value) => Object.keys(value).length <= 50 && JSON.stringify(value).length <= 100_000,
    "Webhook data is too large",
  ),
}).strict();

function requireWordPressAdminUserId(
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

function normalizeWordPressSiteIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      return null;
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${hostname}${url.port ? `:${url.port}` : ""}${pathname}`;
  } catch {
    return null;
  }
}

function normalizeSiteHostname(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")) {
      return null;
    }
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostnamesAreRelated(left: string, right: string): boolean {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function invalidWordPressCredentials(res: Response) {
  return sendError(res, "Invalid credentials", 401);
}

function readWordPressCredential(
  req: Request,
  bodyCredential?: string,
): string | null {
  const authorization = req.headers.authorization ?? "";
  const match = authorization.match(/^Bearer[ \t]+([^\s]{20,256})$/i);
  const headerCredential = match?.[1]?.trim() ?? "";
  const normalizedBodyCredential = bodyCredential?.trim() ?? "";
  if (
    headerCredential &&
    normalizedBodyCredential &&
    headerCredential !== normalizedBodyCredential
  ) {
    return null;
  }
  return headerCredential || normalizedBodyCredential || null;
}

/**
 * POST /api/v1/auth/wordpress/webhook
 * Receive webhook from WordPress plugin
 */
export async function handleWordPressWebhook(req: Request, res: Response) {
  try {
    const authorization = req.headers.authorization ?? "";
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    const integrationKey = match?.[1]?.trim() ?? "";
    if (!integrationKey) {
      return invalidWordPressCredentials(res);
    }

    const integration = await authenticateWordPressIntegrationKey(integrationKey);
    const requestSiteIdentity = normalizeWordPressSiteIdentity(
      req.headers["x-wordpress-site"],
    );
    const integrationSiteIdentity = normalizeWordPressSiteIdentity(
      integration?.wordpressUrl,
    );
    if (
      !integration ||
      !integration.isActive ||
      integration.platform !== ConnectionPlatform.WORDPRESS ||
      !requestSiteIdentity ||
      (integrationSiteIdentity &&
        integrationSiteIdentity !== requestSiteIdentity)
    ) {
      return invalidWordPressCredentials(res);
    }

    const webhookBody = WORDPRESS_WEBHOOK_BODY.safeParse(req.body);
    if (!webhookBody.success) {
      return sendError(res, "Request rejected", 400);
    }
    const { event } = webhookBody.data;
    const data = webhookBody.data.data as Record<string, any>;

    console.log(`[WordPress Webhook] Received event: ${event}`);

    // Find published blog by post_id or seo_tool_blog_id
    let publishedBlog = null;

    if (data.post_id) {
      publishedBlog = await prisma.publishedBlog.findFirst({
        where: {
          integrationId: integration.id,
          externalPostId: String(data.post_id),
        },
        include: {
          blog: true,
          integration: true,
        },
      });
    } else if (data.seo_tool_blog_id) {
      publishedBlog = await prisma.publishedBlog.findFirst({
        where: {
          integrationId: integration.id,
          blogId: data.seo_tool_blog_id,
        },
        include: {
          blog: true,
          integration: true,
        },
      });
    }

    if (!publishedBlog) {
      console.warn(`[WordPress Webhook] Published blog not found for event: ${event}`);
      // Still return success to avoid webhook retries
      return sendSuccess(res, { received: true, message: "Event received but blog not found" });
    }

    // Update status based on event
    switch (event) {
      case "post.published":
        await prisma.publishedBlog.update({
          where: { id: publishedBlog.id },
          data: {
            status: "PUBLISHED",
            publishedAt: new Date(data.timestamp || new Date()),
            externalPostUrl: data.post_url,
            platformResponse: data,
          },
        });
        if (data.post_url) {
          await updateBlogUrl(publishedBlog.blogId, data.post_url).catch((error) => {
            console.error("[WordPress Webhook] Failed to update blog URL in Pinecone:", error);
          });
          await syncManagedBacklinksForPublishedBlog({
            blogId: publishedBlog.blogId,
            publishedUrl: data.post_url,
          }).catch((error) => {
            console.error("[WordPress Webhook] Failed to sync managed cross-links:", error);
          });
        }
        console.log(`[WordPress Webhook] ✅ Post ${data.post_id} marked as published`);
        break;

      case "post.failed":
        await prisma.publishedBlog.update({
          where: { id: publishedBlog.id },
          data: {
            status: "FAILED",
            lastError: data.error || "Publishing failed",
            platformResponse: data,
          },
        });
        console.log(`[WordPress Webhook] ❌ Post ${data.post_id} marked as failed`);
        break;

      case "post.updated":
        await prisma.publishedBlog.update({
          where: { id: publishedBlog.id },
          data: {
            externalPostUrl: data.post_url,
            platformResponse: data,
            updatedAt: new Date(),
          },
        });
        if (data.post_url) {
          await updateBlogUrl(publishedBlog.blogId, data.post_url).catch((error) => {
            console.error("[WordPress Webhook] Failed to update blog URL in Pinecone:", error);
          });
          await syncManagedBacklinksForPublishedBlog({
            blogId: publishedBlog.blogId,
            publishedUrl: data.post_url,
          }).catch((error) => {
            console.error("[WordPress Webhook] Failed to sync managed cross-links:", error);
          });
        }
        console.log(`[WordPress Webhook] 📝 Post ${data.post_id} updated`);
        break;

      default:
        console.log(`[WordPress Webhook] ⚠️ Unknown event: ${event}`);
    }

    return sendSuccess(res, { received: true, event, processed: true });
  } catch (error) {
    console.error("[WordPress Webhook] Error processing webhook:", error);
    return sendError(res, "Webhook processing failed", 500, error);
  }
}

/**
 * POST /api/v1/auth/wordpress/generate-key
 * Generate a new integration key for WordPress plugin
 */
export async function generateIntegrationKey(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const databaseUserId = requireWordPressAdminUserId(req, res);
    if (!databaseUserId) return;
    const { businessId: targetBusinessId } = WORDPRESS_KEY_ADMIN_BODY.parse(
      req.body,
    );

    const business = await prisma.business.findFirst({
      where: {
        id: targetBusinessId,
        userId: databaseUserId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!business) {
      return sendError(res, "Business not found or access denied", 404);
    }

    // Check for legacy integration (businessId: null) to migrate
    const legacyIntegration = await prisma.publishingIntegration.findFirst({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.WORDPRESS,
        businessId: null,
      },
      orderBy: { createdAt: "desc" },
    });

    let integration;
    if (legacyIntegration && targetBusinessId) {
      // Migrate legacy integration
      integration = await prisma.publishingIntegration.update({
        where: { id: legacyIntegration.id },
        data: {
          businessId: targetBusinessId,
          wordpressConnectionMethod: "PLUGIN",
          isActive: true,
        },
      });
      console.log(`[WordPress Integration Key] Migrated legacy integration to business: ${targetBusinessId}`);
    } else {
      integration = await prisma.publishingIntegration.upsert({
        where: {
          userId_platform_businessId: {
            userId: databaseUserId,
            platform: ConnectionPlatform.WORDPRESS,
            businessId: targetBusinessId,
          },
        },
        update: {
          wordpressConnectionMethod: "PLUGIN",
          isActive: true,
          autoPublish: undefined,
        },
        create: {
          userId: databaseUserId,
          businessId: targetBusinessId,
          platform: ConnectionPlatform.WORDPRESS,
          wordpressConnectionMethod: "PLUGIN",
          isActive: true,
          autoPublish: true,
          publishAs: "PUBLISH",
        },
      });
    }

    // The plugin receives the plaintext once. PostgreSQL stores only a
    // type-bound encrypted copy (for outbound publish calls) and an HMAC
    // digest (for inbound plugin authentication).
    const credential = generateWordPressKeyCredential(integration.id);
    const integrationKey = credential.plainToken;
    const keyCreatedAt = new Date();
    integration = await prisma.publishingIntegration.update({
      where: { id: integration.id },
      data: {
        wordpressPreviousKeyDigest:
          integration.wordpressIntegrationKeyDigest ?? undefined,
        wordpressIntegrationKey: encryptPublishingSecret(
          integrationKey,
          "wordpress-integration-key",
        ),
        wordpressIntegrationKeyDigest: credential.tokenDigest,
        wordpressIntegrationKeyFirstCreatedAt:
          integration.wordpressIntegrationKeyFirstCreatedAt ?? keyCreatedAt,
        wordpressIntegrationKeyCreatedAt: keyCreatedAt,
        wordpressIntegrationKeyLastUsedAt: null,
        wordpressIntegrationKeyRevokedAt: null,
        wordpressIntegrationKeyRotationCount: { increment: 1 },
        isActive: true,
      },
    });

    // Double-check that integration is active (in case of race conditions)
    if (!integration.isActive) {
      await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: { isActive: true },
      });
      console.log(`[WordPress Integration Key] Activated inactive integration ${integration.id}`);
    }

    // Verify the key was actually saved
    const verifyIntegration = await prisma.publishingIntegration.findUnique({
      where: { id: integration.id },
      select: {
        wordpressIntegrationKey: true,
        wordpressIntegrationKeyDigest: true,
      },
    });

    if (
      !verifyIntegration?.wordpressIntegrationKey ||
      !verifyIntegration.wordpressIntegrationKeyDigest ||
      decryptPublishingSecret(
        verifyIntegration.wordpressIntegrationKey,
        "wordpress-integration-key",
      ) !== integrationKey
    ) {
      console.error(`[WordPress Integration Key] Key persistence verification failed for integration ${integration.id}`);
      return sendError(res, "Failed to save integration key properly", 500);
    }

    const keyFingerprint = crypto
      .createHash("sha256")
      .update(integrationKey)
      .digest("hex")
      .slice(0, 12);
    console.log(`[WordPress Integration Key] Generated key for user ${databaseUserId}, business ${targetBusinessId}, fingerprint ${keyFingerprint}, integration active: ${integration.isActive}`);
    await invalidateTenantCache(databaseUserId, targetBusinessId);

    return sendSuccess(res, {
      integrationKey,
      createdAt: integration.wordpressIntegrationKeyCreatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleValidationError(res, error);
    }
    if (error instanceof WordPressKeyConfigurationError) {
      console.error("[WordPress Integration Key] HMAC configuration error", error.message);
      return sendError(res, "WordPress key service is not configured", 503);
    }
    console.error("[WordPress Integration Key] Generation error:", error);
    return sendError(res, "Failed to generate integration key", 500);
  }
}

/**
 * POST /api/v1/auth/wordpress/validate-key
 * Validate integration key and return access token
 */
export async function validateIntegrationKey(req: Request, res: Response) {
  try {
    const parsedBody = WORDPRESS_KEY_VALIDATION_BODY.safeParse(req.body);
    if (!parsedBody.success) {
      return invalidWordPressCredentials(res);
    }
    const { wordpressSiteUrl } = parsedBody.data;
    const integrationKey = readWordPressCredential(
      req,
      parsedBody.data.integrationKey,
    );
    if (!integrationKey) {
      return invalidWordPressCredentials(res);
    }

    // Trim whitespace from the key
    const trimmedKey = integrationKey.trim();
    const requestedSiteIdentity = normalizeWordPressSiteIdentity(
      wordpressSiteUrl,
    );
    if (!requestedSiteIdentity) {
      return invalidWordPressCredentials(res);
    }

    const integration = await authenticateWordPressIntegrationKey(trimmedKey);

    if (!integration) {
      return invalidWordPressCredentials(res);
    }

    if (!integration.isActive) {
      return invalidWordPressCredentials(res);
    }

    const requestedHostname = normalizeSiteHostname(wordpressSiteUrl);
    const businessHostname = normalizeSiteHostname(
      integration.business?.businessWebsiteUrl,
    );
    if (
      !requestedHostname ||
      (businessHostname && !hostnamesAreRelated(requestedHostname, businessHostname))
    ) {
      return invalidWordPressCredentials(res);
    }

    const existingSiteIdentity = normalizeWordPressSiteIdentity(
      integration.wordpressUrl,
    );
    if (
      existingSiteIdentity &&
      existingSiteIdentity !== requestedSiteIdentity
    ) {
      return invalidWordPressCredentials(res);
    }

    // Update last used timestamp and WordPress URL
    await prisma.publishingIntegration.update({
      where: { id: integration.id },
      data: {
        wordpressIntegrationKeyLastUsedAt: new Date(),
        wordpressUrl: String(wordpressSiteUrl).trim(),
        isVerified: true,
        // Ensure autoPublish is set (default to true if null)
        autoPublish: integration.autoPublish ?? true,
        publishAs: integration.publishAs ?? "PUBLISH",
      },
    });

    console.log(`[WordPress Integration Key] ✅ Validated key for user ${integration.userId}`);

    return sendSuccess(res, {
      user_id: integration.userId,
      verified: true,
    });
  } catch (error) {
    console.error("[WordPress Integration Key] Validation error:", error);
    return sendError(res, "Failed to validate integration key", 500);
  }
}

/**
 * DELETE /api/v1/auth/wordpress/revoke-key
 * Revoke (delete) integration key
 */
export async function revokeIntegrationKey(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const databaseUserId = requireWordPressAdminUserId(req, res);
    if (!databaseUserId) return;
    const { businessId } = WORDPRESS_KEY_ADMIN_BODY.parse(req.body);

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: databaseUserId, isActive: true },
      select: { id: true },
    });
    if (!business) {
      return sendError(res, "Business not found or access denied", 404);
    }

    await prisma.publishingIntegration.updateMany({
      where: {
        userId: databaseUserId,
        businessId,
        platform: ConnectionPlatform.WORDPRESS,
      },
      data: {
        wordpressIntegrationKey: null,
        isActive: false,
        wordpressIntegrationKeyRevokedAt: new Date(),
      },
    });
    await invalidateTenantCache(databaseUserId, businessId);

    console.log(`[WordPress Integration Key] Revoked key for user ${databaseUserId}, business ${businessId}`);

    return sendSuccess(res, { message: "Integration key revoked successfully" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleValidationError(res, error);
    }
    console.error("[WordPress Integration Key] Revocation error:", error);
    return sendError(res, "Failed to revoke integration key", 500);
  }
}

/**
 * POST /api/v1/auth/wordpress/schema-context
 *
 * Returns LocalBusiness + Person + geo profile data so the WordPress plugin
 * can emit JSON-LD in every page's <head>. Plugin calls this at most once a
 * day (cached via WP transients) so read volume is negligible.
 *
 * Always-on by design — no customer toggle. Graceful no-op when the integration
 * key is unknown or the business hasn't completed NAP onboarding.
 *
 * Body: { integrationKey: string, wordpressSiteUrl: string }
 */
export async function getSchemaContextForPlugin(req: Request, res: Response) {
  try {
    const parsedBody = WORDPRESS_SCHEMA_CONTEXT_BODY.safeParse(req.body);
    if (!parsedBody.success) {
      return invalidWordPressCredentials(res);
    }
    const { wordpressSiteUrl } = parsedBody.data;
    const integrationKey = readWordPressCredential(
      req,
      parsedBody.data.integrationKey,
    );
    if (!integrationKey) {
      return invalidWordPressCredentials(res);
    }
    const trimmedKey = String(integrationKey).trim();

    const integration = await authenticateWordPressIntegrationKey(trimmedKey);

    if (!integration || !integration.businessId || !integration.isActive) {
      return invalidWordPressCredentials(res);
    }

    const existingSiteIdentity = normalizeWordPressSiteIdentity(
      integration.wordpressUrl,
    );
    const requestedSiteIdentity = wordpressSiteUrl
      ? normalizeWordPressSiteIdentity(wordpressSiteUrl)
      : null;
    if (
      existingSiteIdentity &&
      requestedSiteIdentity !== existingSiteIdentity
    ) {
      return invalidWordPressCredentials(res);
    }

    const business = await prisma.business.findUnique({
      where: { id: integration.businessId },
      select: {
        id: true,
        businessName: true,
        businessType: true,
        businessDescription: true,
        businessWebsiteUrl: true,
        businessPhone: true,
        businessAddress: true,
        businessCity: true,
        businessState: true,
        businessCountry: true,
        authorName: true,
        authorBio: true,
        authorJobTitle: true,
        authorImage: true,
        authorExpertise: true,
        authorSocialLinks: true,
        GeoProfile: {
          select: {
            placeId: true,
            formattedAddress: true,
            latitude: true,
            longitude: true,
            neighborhood: true,
            locality: true,
            postalCode: true,
            countryCode: true,
            googleMapsUri: true,
          },
        },
      },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // Record the last-used timestamp so the plugin cache-refresh event is visible in audit logs.
    void prisma.publishingIntegration
      .update({
        where: { id: integration.id },
        data: {
          wordpressIntegrationKeyLastUsedAt: new Date(),
          ...(wordpressSiteUrl
            ? { wordpressUrl: String(wordpressSiteUrl).trim() }
            : {}),
        },
      })
      .catch(() => {
        /* best-effort; never fail the context call */
      });

    return sendSuccess(res, {
      // Version so the plugin can compare against its cached payload and
      // choose to refresh more aggressively later.
      schemaVersion: 1,
      business: {
        id: business.id,
        name: business.businessName,
        description: business.businessDescription,
        websiteUrl: business.businessWebsiteUrl,
        phone: business.businessPhone,
        type: business.businessType,
        address: business.businessAddress,
        city: business.businessCity,
        state: business.businessState,
        country: business.businessCountry,
      },
      author: {
        name: business.authorName,
        bio: business.authorBio,
        jobTitle: business.authorJobTitle,
        image: business.authorImage,
        expertise: business.authorExpertise,
        socialLinks: business.authorSocialLinks,
      },
      geoProfile: business.GeoProfile,
    });
  } catch (error) {
    console.error("[WordPress Schema Context] error:", error);
    return sendError(res, "Failed to resolve schema context", 500);
  }
}
