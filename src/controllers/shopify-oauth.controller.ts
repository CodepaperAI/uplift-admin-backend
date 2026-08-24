import { ConnectionPlatform, PublishAs, PublishStatus } from "@prisma/client";
import axios from "axios";
import crypto from "crypto";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { updateBlogUrl } from "../config/pinecone.config";
import { syncManagedBacklinksForPublishedBlog } from "../services/managed-backlinks.service";
import { decryptOAuthToken, encryptOAuthToken } from "../utils/oauth-token-crypto";
import {
  SHOPIFY_OAUTH_CONTEXT_COOKIE,
  SHOPIFY_OAUTH_STATE_COOKIE,
  normalizeShopifyDomain,
  parseShopifyOAuthContext,
  resolveShopifyOAuthCredentials,
  serializeShopifyOAuthContext,
  type ShopifyOAuthSessionContext,
} from "../utils/shopify-oauth.utils";
import { sendError, sendSuccess } from "../utils/response.utils";
import { listShopifyBlogs as listBlogs } from "../utils/shopify-publisher";
import { getDatabaseUserId } from "../utils/user.utils";
import { createOAuthState, verifyOAuthState } from "../utils/oauth-state";

/**
 * Helper: Verify Shopify OAuth callback HMAC signature using the raw query
 * string so encoded params like `host` survive verification unchanged.
 */
function verifyShopifyHMAC(
  rawQueryString: string,
  hmac: string,
  clientSecret: string,
): boolean {
  if (!hmac || !clientSecret) return false;

  if (!clientSecret) {
    console.error("[Shopify OAuth] Missing client secret for HMAC verification");
    return false;
  }

  const sortedQuery = rawQueryString
    .split("&")
    .filter(Boolean)
    .filter((pair) => {
      const [rawKey] = pair.split("=", 1);
      return (
        rawKey !== "hmac" &&
        rawKey !== "signature" &&
        rawKey !== "userId"
      );
    })
    .sort()
    .join("&");

  const calculatedHmac = crypto
    .createHmac("sha256", clientSecret)
    .update(sortedQuery)
    .digest("hex");

  return calculatedHmac === hmac;
}

export function verifyShopifyWebhookHMAC({
  rawBody,
  hmac,
  clientSecret,
}: {
  rawBody: string | Buffer;
  hmac: string;
  clientSecret: string;
}): boolean {
  if (!rawBody || !hmac || !clientSecret) {
    return false;
  }

  const calculatedDigest = crypto
    .createHmac("sha256", clientSecret)
    .update(rawBody)
    .digest();
  const providedDigest = Buffer.from(hmac, "base64");

  if (providedDigest.length !== calculatedDigest.length) {
    return false;
  }

  return crypto.timingSafeEqual(calculatedDigest, providedDigest);
}

function getSingleHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  return value || null;
}

function getShopifyWebhookRawBody(req: Request): string | Buffer | null {
  const rawBody = (req as Request & { rawBody?: string | Buffer }).rawBody;

  if (typeof rawBody === "string" || Buffer.isBuffer(rawBody)) {
    return rawBody;
  }

  return null;
}

function getIsSecureRequest(req: Request): boolean {
  const forwardedProto = req
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();

  return forwardedProto === "https" || process.env.NODE_ENV === "production";
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = req
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedHost = req
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || req.get("host");
  const protocol = forwardedProto || req.protocol || "https";

  if (host) {
    return `${protocol}://${host}`;
  }

  return process.env.BACKEND_URL || "http://upliftai.co";
}

function getShopifyOauthCookieOptions(req: Request) {
  const secure = getIsSecureRequest(req);

  return {
    httpOnly: true,
    secure,
    sameSite: secure ? ("none" as const) : ("lax" as const),
    maxAge: 600000,
  };
}

function clearShopifyOauthCookies(req: Request, res: Response) {
  const cookieOptions = getShopifyOauthCookieOptions(req);

  res.clearCookie(SHOPIFY_OAUTH_STATE_COOKIE, cookieOptions);
  res.clearCookie(SHOPIFY_OAUTH_CONTEXT_COOKIE, cookieOptions);
}

interface StartShopifyAuthorizeFlowInput {
  req: Request;
  userId: string;
  shop: string;
  clientId: string;
  res: Response;
  businessId?: string | null;
  clientSecret?: string | null;
  apiVersion?: string | null;
  apiMethod?: "REST" | "GRAPHQL" | null;
  blogId?: string | null;
  autoPublish?: boolean | null;
  publishAs?: "DRAFT" | "PUBLISH" | null;
}

function startShopifyAuthorizeFlow({
  req,
  userId,
  shop,
  clientId,
  clientSecret,
  res,
  businessId,
  apiVersion,
  apiMethod,
  blogId,
  autoPublish,
  publishAs,
}: StartShopifyAuthorizeFlowInput) {
  const normalizedShop = normalizeShopifyDomain(shop);
  const scopes = process.env.SHOPIFY_SCOPES || "read_content,write_content";
  const redirectUri = `${getRequestOrigin(req)}/api/v1/auth/shopify/callback`;
  const state = createOAuthState({
    provider: "shopify",
    userId,
    context: {
      shop: normalizedShop,
      businessId: businessId || undefined,
      apiVersion: apiVersion || undefined,
      apiMethod: apiMethod || undefined,
      blogId: blogId || undefined,
      autoPublish: autoPublish ?? undefined,
      publishAs: publishAs || undefined,
    },
  });
  const cookieOptions = getShopifyOauthCookieOptions(req);

  res.cookie(
    SHOPIFY_OAUTH_STATE_COOKIE,
    state,
    cookieOptions,
  );

  const oauthContext: ShopifyOAuthSessionContext = {
    state,
    shop: normalizedShop,
    businessId: businessId || null,
    clientId: clientSecret ? clientId : null,
    clientSecret: clientSecret || null,
    apiVersion: apiVersion || null,
    apiMethod: apiMethod || null,
    blogId: blogId || null,
    autoPublish: autoPublish ?? null,
    publishAs: publishAs || null,
  };

  res.cookie(
    SHOPIFY_OAUTH_CONTEXT_COOKIE,
    serializeShopifyOAuthContext(oauthContext),
    cookieOptions,
  );

  const authUrl =
    `https://${normalizedShop}/admin/oauth/authorize?` +
    `client_id=${clientId}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `state=${state}`;

  return { authUrl, normalizedShop };
}

function getPublishAsValue(
  value?: "DRAFT" | "PUBLISH" | null,
): PublishAs | undefined {
  if (value === "DRAFT") {
    return PublishAs.DRAFT;
  }

  if (value === "PUBLISH") {
    return PublishAs.PUBLISH;
  }

  return undefined;
}

/**
 * GET /api/v1/auth/shopify/authorize
 * Initiate Shopify OAuth flow
 */
export async function authorizeShopify(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { shop, businessId, apiVersion, apiMethod, blogId, autoPublish, publishAs } =
      req.query;
    const userId = req.authUserId;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (!shop) {
      return sendError(res, "Missing shop parameter", 400);
    }

    const targetBusinessId =
      typeof businessId === "string" && businessId.trim()
        ? businessId.trim()
        : undefined;
    if (targetBusinessId) {
      const business = await prisma.business.findFirst({
        where: { id: targetBusinessId, userId, isActive: true },
        select: { id: true },
      });
      if (!business) return sendError(res, "Not found", 404);
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    if (!clientId) {
      return sendError(res, "Shopify client ID not configured", 500);
    }

    const autoPublishValue =
      typeof autoPublish === "string"
        ? autoPublish === "true"
        : undefined;
    const { authUrl } = startShopifyAuthorizeFlow({
      req,
      userId,
      shop: shop as string,
      clientId,
      res,
      businessId: targetBusinessId,
      apiVersion: typeof apiVersion === "string" ? apiVersion : undefined,
      apiMethod:
        apiMethod === "GRAPHQL" || apiMethod === "REST"
          ? apiMethod
          : undefined,
      blogId: typeof blogId === "string" ? blogId : undefined,
      autoPublish: autoPublishValue,
      publishAs:
        publishAs === "DRAFT" || publishAs === "PUBLISH"
          ? publishAs
          : undefined,
    });

    console.log(`[Shopify OAuth] Redirecting to: ${authUrl}`);

    res.redirect(authUrl);
  } catch (error) {
    console.error("[Shopify OAuth] Authorization error:", error);
    return sendError(res, "Authorization failed", 500, error);
  }
}

export async function authorizeShopifyWithCredentials(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const {
      shop,
      clientId,
      clientSecret,
      businessId,
      apiVersion,
      apiMethod,
      blogId,
      autoPublish,
      publishAs,
    } = req.body ?? {};
    const userId = req.authUserId;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (!shop) {
      return sendError(res, "Missing shop parameter", 400);
    }

    const hasTempClientId =
      typeof clientId === "string" && clientId.trim().length > 0;
    const hasTempClientSecret =
      typeof clientSecret === "string" && clientSecret.trim().length > 0;
    if (hasTempClientId || hasTempClientSecret) {
      return sendError(
        res,
        "Use the encrypted custom-app connection flow for store credentials",
        400,
      );
    }
    const effectiveClientId = hasTempClientId
      ? clientId.trim()
      : process.env.SHOPIFY_CLIENT_ID;
    const effectiveClientSecret = hasTempClientSecret
      ? clientSecret.trim()
      : process.env.SHOPIFY_CLIENT_SECRET;

    if (!effectiveClientId) {
      return sendError(res, "Shopify client ID not configured", 400);
    }

    if (hasTempClientId && !hasTempClientSecret) {
      return sendError(
        res,
        "Shopify client secret is required when using temporary app credentials",
        400,
      );
    }

    if (!effectiveClientSecret) {
      return sendError(res, "Shopify client secret not configured", 400);
    }

    const targetBusinessId =
      typeof businessId === "string" && businessId.trim()
        ? businessId.trim()
        : undefined;
    if (targetBusinessId) {
      const business = await prisma.business.findFirst({
        where: { id: targetBusinessId, userId, isActive: true },
        select: { id: true },
      });
      if (!business) return sendError(res, "Not found", 404);
    }

    const { authUrl, normalizedShop } = startShopifyAuthorizeFlow({
      req,
      userId,
      shop,
      clientId: effectiveClientId,
      clientSecret: hasTempClientId ? effectiveClientSecret : undefined,
      res,
      businessId: targetBusinessId,
      apiVersion:
        typeof apiVersion === "string" && apiVersion.trim()
          ? apiVersion.trim()
          : undefined,
      apiMethod:
        apiMethod === "GRAPHQL" || apiMethod === "REST"
          ? apiMethod
          : undefined,
      blogId:
        typeof blogId === "string" && blogId.trim() ? blogId.trim() : undefined,
      autoPublish:
        typeof autoPublish === "boolean" ? autoPublish : undefined,
      publishAs:
        publishAs === "DRAFT" || publishAs === "PUBLISH"
          ? publishAs
          : undefined,
    });

    console.log(`[Shopify OAuth] Created temp auth session for ${normalizedShop}`);

    return sendSuccess(res, { authUrl });
  } catch (error) {
    console.error("[Shopify OAuth] Temp authorization error:", error);
    clearShopifyOauthCookies(req, res);
    return sendError(res, "Authorization failed", 500, error);
  }
}

/**
 * GET /api/v1/auth/shopify/callback
 * Handle Shopify OAuth callback
 */
export async function handleShopifyCallback(req: Request, res: Response) {
  try {
    const { code, shop, state, hmac } = req.query;
    const storedState = req.cookies?.[SHOPIFY_OAUTH_STATE_COOKIE];
    const oauthContext = parseShopifyOAuthContext(
      req.cookies?.[SHOPIFY_OAUTH_CONTEXT_COOKIE],
    );

    if (!code || !shop || !state) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Missing required OAuth parameters", 400);
    }

    // Verify state (CSRF protection)
    const expectedState = storedState || oauthContext?.state;
    if (expectedState && state !== expectedState) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Invalid state parameter", 400);
    }
    const verifiedState = verifyOAuthState(state, "shopify");
    if (!verifiedState) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Invalid state parameter", 400);
    }
    const stateContext = verifiedState.context;

    const normalizedShop = normalizeShopifyDomain(shop as string);
    if (stateContext.shop !== normalizedShop) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Invalid state parameter", 400);
    }
    const oauthCredentials = resolveShopifyOAuthCredentials({
      state: String(state),
      shop: normalizedShop,
      tempContext: oauthContext,
      envClientId: process.env.SHOPIFY_CLIENT_ID,
      envClientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    });

    if (!oauthCredentials) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Shopify credentials not configured", 500);
    }

    // Verify HMAC using the raw callback query string from Shopify.
    const rawQueryString = req.originalUrl.split("?")[1] || "";
    if (
      !verifyShopifyHMAC(
        rawQueryString,
        hmac as string,
        oauthCredentials.clientSecret,
      )
    ) {
      clearShopifyOauthCookies(req, res);
      return sendError(res, "Invalid HMAC signature", 401);
    }

    const userId = verifiedState.userId;

    // Exchange code for access token
    const tokenUrl = `https://${normalizedShop}/admin/oauth/access_token`;

    const tokenBody = new URLSearchParams({
      client_id: oauthCredentials.clientId,
      client_secret: oauthCredentials.clientSecret,
      code: String(code),
    });

    const tokenResponse = await axios.post(tokenUrl, tokenBody.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });

    const { access_token, scope } = tokenResponse.data;

    if (!access_token) {
      return sendError(res, "Failed to obtain access token", 500);
    }

    // Get shop information
    let shopInfo: any = {};
    try {
      const shopResponse = await axios.get(
        `https://${normalizedShop}/admin/api/${stateContext.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-01"}/shop.json`,
        {
          headers: {
            "X-Shopify-Access-Token": access_token,
          },
        },
      );
      shopInfo = shopResponse.data.shop || {};
    } catch (error) {
      console.warn("[Shopify OAuth] Could not fetch shop info:", error);
    }

    // Get database User ID from Clerk ID
    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Encrypt and store tokens
    const encryptedAccessToken = encryptOAuthToken(access_token, "shopify");
    const expiresIn = 86400; // Shopify tokens typically don't expire, but we'll set a default

    // Upsert OAuth token
    const oauthToken = await prisma.shopifyOAuthToken.upsert({
      where: {
        userId_shopDomain: {
          userId: databaseUserId,
          shopDomain: normalizedShop,
        },
      },
      update: {
        accessToken: encryptedAccessToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        isActive: true,
        lastUsedAt: new Date(),
        shopName: shopInfo.name,
        shopEmail: shopInfo.email,
        planName: shopInfo.plan_name,
      },
      create: {
        userId: databaseUserId,
        shopDomain: normalizedShop,
        accessToken: encryptedAccessToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        isActive: true,
        connectedAt: new Date(),
        shopName: shopInfo.name,
        shopEmail: shopInfo.email,
        planName: shopInfo.plan_name,
      },
    });

    // Resolve businessId from the signed state or the user's primary business.
    let businessId = stateContext.businessId || undefined;
    if (!businessId) {
      const primaryBusiness = await prisma.business.findFirst({
        where: { userId: databaseUserId, isPrimary: true, isActive: true },
        select: { id: true },
      });
      businessId = primaryBusiness?.id || undefined;
    }

    // Fetch available blogs from Shopify to store default blogId
    let defaultBlogId: string | null = null;
    try {
      const apiVersion =
        stateContext.apiVersion ||
        process.env.SHOPIFY_API_VERSION ||
        "2026-01";
      const blogs = await listBlogs({
        shopDomain: normalizedShop,
        oauthAccessToken: access_token,
        connectionMethod: "OAUTH",
        apiVersion,
      });
      const firstBlog = blogs[0];
      if (firstBlog) {
        defaultBlogId = firstBlog.id; // GID format
        console.log(`[Shopify OAuth] Default blog: ${defaultBlogId} (${firstBlog.title})`);
      }
    } catch (error) {
      console.warn("[Shopify OAuth] Could not fetch blogs:", error);
    }

    const integrationData = {
      shopifyConnectionMethod: "OAUTH",
      shopifyOAuthTokenId: oauthToken.id,
      shopifyShopDomain: normalizedShop,
      shopifyAccessToken: null,
      shopifyClientId: null,
      shopifyClientSecret: null,
      shopifyAccessTokenIssuedAt: null,
      shopifyAccessTokenExpiresAt: null,
      shopifyApiMethod: stateContext.apiMethod || "GRAPHQL",
      shopifyApiVersion:
        stateContext.apiVersion ||
        process.env.SHOPIFY_API_VERSION ||
        "2026-01",
      shopifyBlogId: stateContext.blogId || defaultBlogId,
      isActive: true,
      isVerified: true,
      autoPublish: stateContext.autoPublish ?? true,
      ...(getPublishAsValue(stateContext.publishAs)
        ? { publishAs: getPublishAsValue(stateContext.publishAs) }
        : {}),
      ...(businessId ? { businessId } : {}),
    };

    const existing = await prisma.publishingIntegration.findFirst({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.SHOPIFY,
        ...(businessId ? { businessId } : {}),
      },
    });
    if (existing) {
      await prisma.publishingIntegration.update({
        where: { id: existing.id },
        data: integrationData,
      });
    } else {
      await prisma.publishingIntegration.create({
        data: {
          userId: databaseUserId,
          platform: ConnectionPlatform.SHOPIFY,
          ...integrationData,
        },
      });
    }

    // Clear state cookie
    clearShopifyOauthCookies(req, res);

    // Redirect to frontend success page (website integration)
    const frontendUrl = process.env.FRONTEND_URL || "http://upliftai.co/";
    res.redirect(
      `${frontendUrl}/dashboard/publish-console?shopify_connected=true&tab=shopify`,
    );
  } catch (error: any) {
    console.error("[Shopify OAuth] Callback error:", error);
    return sendError(res, "Callback processing failed", 500, error);
  }
}

/**
 * POST /api/v1/auth/shopify/refresh
 * Refresh Shopify access token (if needed)
 */
export async function refreshShopifyToken(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { shop } = req.body;
    const userId = req.authUserId;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (!shop || typeof shop !== "string") {
      return sendError(res, "Missing shop", 400);
    }

    const normalizedShop = normalizeShopifyDomain(shop);

    // Find token in database
    const tokenRecord = await prisma.shopifyOAuthToken.findFirst({
      where: {
        userId,
        shopDomain: normalizedShop,
        isActive: true,
      },
      select: { id: true },
    });

    if (!tokenRecord) {
      return sendError(res, "Not found", 404);
    }

    // Note: Shopify tokens typically don't expire, but if they do, refresh here
    // For now, we'll just update lastUsedAt
    await prisma.shopifyOAuthToken.update({
      where: { id: tokenRecord.id },
      data: { lastUsedAt: new Date() },
    });

    return sendSuccess(res, {
      refreshed: true,
    });
  } catch (error: any) {
    console.error("[Shopify OAuth] Token refresh error:", error);
    return sendError(res, "Token refresh failed", 500, error);
  }
}

/**
 * POST /api/v1/auth/shopify/webhook
 * Handle webhooks from Shopify
 */
async function deactivateShopifyShop(shop: string) {
  const normalizedShop = normalizeShopifyDomain(shop);

  const [integrationResult, tokenResult] = await Promise.all([
    prisma.publishingIntegration.updateMany({
      where: {
        platform: ConnectionPlatform.SHOPIFY,
        shopifyShopDomain: normalizedShop,
      },
      data: {
        isActive: false,
        isVerified: false,
      },
    }),
    prisma.shopifyOAuthToken.updateMany({
      where: {
        shopDomain: normalizedShop,
      },
      data: {
        isActive: false,
      },
    }),
  ]);

  return {
    shop: normalizedShop,
    integrationsUpdated: integrationResult.count,
    tokensUpdated: tokenResult.count,
  };
}

async function handleShopifyComplianceWebhook(topic: string, shop: string) {
  switch (topic) {
    case "customers/data_request":
      return {
        topic,
        action: "acknowledged",
        customerDataStored: false,
      };

    case "customers/redact":
      return {
        topic,
        action: "acknowledged",
        customerDataStored: false,
      };

    case "shop/redact":
      return {
        topic,
        action: "shop_deactivated",
        ...(await deactivateShopifyShop(shop)),
      };

    default:
      return null;
  }
}

export async function handleShopifyWebhook(req: Request, res: Response) {
  try {
    const hmac = getSingleHeader(req.headers["x-shopify-hmac-sha256"]);
    const topic = getSingleHeader(req.headers["x-shopify-topic"])?.toLowerCase();
    const rawBody = getShopifyWebhookRawBody(req);
    const shop =
      getSingleHeader(req.headers["x-shopify-shop-domain"]) ||
      (typeof req.body?.shop_domain === "string" ? req.body.shop_domain : null);

    if (!hmac || !shop || !topic) {
      return sendError(res, "Missing webhook headers", 400);
    }

    if (!rawBody) {
      return sendError(res, "Missing raw webhook body", 400);
    }

    const webhookSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!webhookSecret) {
      return sendError(res, "Shopify client secret not configured", 500);
    }

    if (
      !verifyShopifyWebhookHMAC({
        rawBody,
        hmac,
        clientSecret: webhookSecret,
      })
    ) {
      return sendError(res, "Invalid webhook HMAC", 401);
    }

    const complianceResult = await handleShopifyComplianceWebhook(topic, shop);
    if (complianceResult) {
      console.log(`[Shopify Webhook] Received compliance topic ${topic} for shop ${shop}`);
      return sendSuccess(res, { received: true, ...complianceResult });
    }

    const { id, article_id, blog_id } = req.body;

    console.log(`[Shopify Webhook] Received ${topic} for shop ${shop}`);

    // Handle different webhook topics
    switch (topic) {
      case "articles/create":
      case "articles/update":
        // Find published blog by article_id
        const publishedBlog = await prisma.publishedBlog.findFirst({
          where: {
            externalPostId: String(article_id || id),
            platform: ConnectionPlatform.SHOPIFY,
          },
          include: {
            blog: true,
            integration: true,
          },
        });

        if (publishedBlog) {
          const externalPostUrl = req.body.url || publishedBlog.externalPostUrl;
          await prisma.publishedBlog.update({
            where: { id: publishedBlog.id },
            data: {
              status: PublishStatus.PUBLISHED,
              publishedAt: new Date(),
              externalPostUrl,
              externalPostId: String(article_id || id),
            },
          });
          if (externalPostUrl) {
            await updateBlogUrl(publishedBlog.blogId, externalPostUrl).catch((error) => {
              console.error("[Shopify Webhook] Failed to update blog URL in Pinecone:", error);
            });
            await syncManagedBacklinksForPublishedBlog({
              blogId: publishedBlog.blogId,
              publishedUrl: externalPostUrl,
            }).catch((error) => {
              console.error("[Shopify Webhook] Failed to sync managed cross-links:", error);
            });
          }
          console.log(`[Shopify Webhook] ✅ Article ${article_id} updated`);
        }
        break;

      case "articles/delete":
        // Mark as failed/lost
        const deletedBlog = await prisma.publishedBlog.findFirst({
          where: {
            externalPostId: String(article_id || id),
            platform: ConnectionPlatform.SHOPIFY,
          },
        });

        if (deletedBlog) {
          await prisma.publishedBlog.update({
            where: { id: deletedBlog.id },
            data: {
              status: PublishStatus.FAILED,
              lastError: "Article deleted from Shopify",
            },
          });
          console.log(`[Shopify Webhook] ⚠️ Article ${article_id} deleted`);
        }
        break;

      case "app/uninstalled":
        await deactivateShopifyShop(shop);
        console.log(`[Shopify Webhook] App uninstalled for ${shop}`);
        break;

      default:
        console.log(`[Shopify Webhook] Unhandled topic: ${topic}`);
    }

    return sendSuccess(res, { received: true });
  } catch (error: any) {
    console.error("[Shopify Webhook] Error processing webhook:", error);
    return sendError(res, "Webhook processing failed", 500, error);
  }
}

/**
 * GET /api/v1/auth/shopify/blogs
 * List available blogs for a Shopify store
 */
export async function listShopifyStoreBlogs(req: Request, res: Response) {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      return sendError(res, "Missing userId parameter", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Find active Shopify integration
    const integration = await prisma.publishingIntegration.findFirst({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.SHOPIFY,
        isActive: true,
      },
      include: { shopifyOAuthToken: true },
    });

    if (!integration || !integration.shopifyShopDomain) {
      return sendError(res, "No active Shopify integration found", 404);
    }

    // Get access token
    let accessToken: string;
    if (integration.shopifyOAuthToken) {
      accessToken = decryptOAuthToken(
        integration.shopifyOAuthToken.accessToken,
        "shopify",
      );
    } else if (integration.shopifyAccessToken) {
      accessToken = integration.shopifyAccessToken;
    } else {
      return sendError(res, "No Shopify access token available", 400);
    }

    const apiVersion = integration.shopifyApiVersion || "2026-01";

    const blogs = await listBlogs({
      shopDomain: integration.shopifyShopDomain,
      oauthAccessToken: accessToken,
      connectionMethod: "OAUTH",
      apiVersion,
    });

    return sendSuccess(res, { blogs });
  } catch (error: any) {
    console.error("[Shopify] Error listing blogs:", error);
    return sendError(res, "Failed to list Shopify blogs", 500, error);
  }
}

/**
 * POST /api/v1/auth/shopify/disconnect
 * Disconnect Shopify integration
 */
export async function disconnectShopify(req: Request, res: Response) {
  try {
    const { userId, integrationId } = req.body;

    if (!userId) {
      return sendError(res, "Missing userId", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Find integration
    const whereClause: any = {
      userId: databaseUserId,
      platform: ConnectionPlatform.SHOPIFY,
      isActive: true,
    };
    if (integrationId) {
      whereClause.id = integrationId;
    }

    const integration = await prisma.publishingIntegration.findFirst({
      where: whereClause,
    });

    if (!integration) {
      return sendError(res, "No active Shopify integration found", 404);
    }

    // Deactivate integration
    await prisma.publishingIntegration.update({
      where: { id: integration.id },
      data: { isActive: false, isVerified: false },
    });

    // Deactivate OAuth token if exists
    if (integration.shopifyOAuthTokenId) {
      await prisma.shopifyOAuthToken.update({
        where: { id: integration.shopifyOAuthTokenId },
        data: { isActive: false },
      });
    }

    console.log(`[Shopify] Disconnected integration ${integration.id} for user ${databaseUserId}`);

    return sendSuccess(res, { disconnected: true });
  } catch (error: any) {
    console.error("[Shopify] Error disconnecting:", error);
    return sendError(res, "Failed to disconnect Shopify", 500, error);
  }
}
