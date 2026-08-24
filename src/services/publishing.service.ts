import { ConnectionPlatform, PublishAs } from "@prisma/client";
import axios from "axios";
import { prisma } from "../config/db.config";
import type {
    BlogPublishData,
    PublishingIntegrationData,
    PublishResult,
    RetryConfig,
} from "../types/publishing.types";
import {
    publishToCustomApi,
    testCustomApiConnection,
} from "../utils/custom-api-publisher";
import {
    decryptOAuthToken,
    encryptOAuthToken,
} from "../utils/oauth-token-crypto";
import {
    decryptPublishingSecret,
    type PublishingSecretKind,
} from "../utils/publishing-secret-crypto";
import {
    publishToFramer,
    testFramerConnection,
} from "../utils/framer-publisher";
import {
    publishToMedium,
    testMediumConnection,
} from "../utils/medium-publisher";
import {
    publishToReddit,
    testRedditConnection,
} from "../utils/reddit-publisher";
import {
    publishToShopify,
    testShopifyConnection,
    type ShopifyCredentials,
} from "../utils/shopify-publisher";
import {
    publishToWebflow,
    testWebflowConnection,
} from "../utils/webflow-publisher";
import {
    publishToWix,
    testWixConnection,
} from "../utils/wix-publisher";
import { refreshWebflowOAuthToken } from "../utils/webflow-oauth.utils";
import { refreshWixOAuthToken } from "../utils/wix-oauth.utils";
import {
    publishToWordPress,
    testWordPressConnection,
} from "../utils/wordpress-publisher";
import { guardUrl } from "../utils/ssrf-guard";

export const PUBLISH_LOCK_TTL_MS = 15 * 60 * 1000;

export interface PublishLockResult {
  acquired: boolean;
  alreadyPublishing?: boolean;
  staleRecovered?: boolean;
}

export async function tryAcquirePublishLock(
  blogId: string,
  integrationId: string,
  attemptId: string,
  platform: ConnectionPlatform
): Promise<PublishLockResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PUBLISH_LOCK_TTL_MS);

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.publishedBlog.findUnique({
      where: {
        blogId_integrationId: { blogId, integrationId },
      },
    });

    if (!row) {
      await tx.publishedBlog.create({
        data: {
          blogId,
          integrationId,
          platform,
          status: "PENDING",
          publishingStartedAt: now,
          lastPublishAttemptId: attemptId,
          publishLockExpiresAt: expiresAt,
        },
      });
      return { acquired: true as const, staleRecovered: false };
    }

    const lockExpired = !row.publishLockExpiresAt || row.publishLockExpiresAt <= now;
    const sameAttempt = row.lastPublishAttemptId === attemptId;

    if (!lockExpired && !sameAttempt) {
      return { acquired: false as const, alreadyPublishing: true };
    }

    await tx.publishedBlog.update({
      where: { id: row.id },
      data: {
        publishingStartedAt: now,
        lastPublishAttemptId: attemptId,
        publishLockExpiresAt: expiresAt,
      },
    });

    const staleRecovered = !!row.publishingStartedAt && lockExpired;
    return { acquired: true as const, staleRecovered };
  });

  return result;
}

export async function releasePublishLock(
  blogId: string,
  integrationId: string
): Promise<void> {
  await prisma.publishedBlog.updateMany({
    where: { blogId, integrationId },
    data: {
      publishingStartedAt: null,
      lastPublishAttemptId: null,
      publishLockExpiresAt: null,
    },
  });
}

export class PublishingService {
  private defaultRetryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
  };

  /**
   * Main entry point for publishing a blog to a platform
   */
  async publishBlog(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    console.log(
      `[PublishingService] Publishing blog ${blog.id} to ${integration.platform}`
    );

    // Validate integration
    if (!integration.isActive) {
      return {
        success: false,
        error: `Integration for ${integration.platform} is not active`,
      };
    }

    // Determine publish status based on integration settings
    const targetStatus =
      integration.publishAs === PublishAs.PUBLISH ? "publish" : "draft";

    // Update blog status if needed
    const blogWithStatus = {
      ...blog,
      status: targetStatus,
    };

    try {
      let result: PublishResult;

      // Route to appropriate platform publisher
      switch (integration.platform) {
        case ConnectionPlatform.WORDPRESS:
          result = await this.publishToWordPress(blogWithStatus, integration);
          break;
        case ConnectionPlatform.SHOPIFY:
          result = await this.publishToShopify(blogWithStatus, integration);
          break;
        case ConnectionPlatform.WEBFLOW:
          result = await this.publishToWebflow(blogWithStatus, integration);
          break;
        case ConnectionPlatform.FRAMER:
          result = await this.publishToFramer(blogWithStatus, integration);
          break;
        case ConnectionPlatform.CUSTOM_API:
          result = await this.publishToCustomApi(blogWithStatus, integration);
          break;
        case ConnectionPlatform.WIX:
          result = await this.publishToWix(blogWithStatus, integration);
          break;
        case ConnectionPlatform.REDDIT:
          result = await this.publishToReddit(blogWithStatus, integration);
          break;
        case ConnectionPlatform.MEDIUM:
          result = await this.publishToMedium(blogWithStatus, integration);
          break;
        default:
          return {
            success: false,
            error: `Unsupported platform: ${integration.platform}`,
          };
      }

      return result;
    } catch (error: any) {
      console.error(
        `[PublishingService] Error publishing to ${integration.platform}:`,
        error
      );
      return {
        success: false,
        error: error.message || "Unknown error occurred",
      };
    }
  }

  /**
   * Publish blog with retry logic
   */
  async publishBlogWithRetry(
    blog: BlogPublishData,
    integration: PublishingIntegrationData,
    retryConfig?: Partial<RetryConfig>
  ): Promise<PublishResult> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
          config.maxDelayMs
        );
        console.log(
          `[PublishingService] Retry attempt ${attempt} after ${delay}ms`
        );
        await this.delay(delay);
      }

      try {
        const result = await this.publishBlog(blog, integration);
        if (result.success) {
          return result;
        }
        if (result.inProgress) {
          return result;
        }
        lastError = new Error(result.error || "Publish failed");
      } catch (error: any) {
        lastError = error;
      }
    }

    return {
      success: false,
      error: lastError?.message || "Failed after all retry attempts",
    };
  }

  /**
   * Test connection to a platform
   */
  async testConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string; pluginVersion?: string }> {
    try {
      switch (integration.platform) {
        case ConnectionPlatform.WORDPRESS:
          return await this.testWordPressConnection(integration);
        case ConnectionPlatform.SHOPIFY:
          return await this.testShopifyConnection(integration);
        case ConnectionPlatform.WEBFLOW:
          return await this.testWebflowConnection(integration);
        case ConnectionPlatform.FRAMER:
          return await this.testFramerConnection(integration);
        case ConnectionPlatform.CUSTOM_API:
          return await this.testCustomApiConnection(integration);
        case ConnectionPlatform.WIX:
          return await this.testWixConnection(integration);
        case ConnectionPlatform.REDDIT:
          return await this.testRedditConnection(integration);
        case ConnectionPlatform.MEDIUM:
          return await this.testMediumConnection(integration);
        default:
          return {
            success: false,
            error: `Unsupported platform: ${integration.platform}`,
          };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || "Connection test failed",
      };
    }
  }

  /**
   * Platform-specific publish methods
   */
  private normalizeShopifyConnectionMethod(
    integration: PublishingIntegrationData,
  ): "API_KEY" | "OAUTH" | "CUSTOM_APP" {
    const connectionMethod = integration.shopifyConnectionMethod;

    if (connectionMethod === "CUSTOM_APP") {
      return "CUSTOM_APP";
    }

    if (connectionMethod === "API_KEY") {
      return "API_KEY";
    }

    if (connectionMethod === "OAUTH") {
      return "OAUTH";
    }

    if (integration.shopifyOAuthTokenId) {
      return "OAUTH";
    }

    if (integration.shopifyClientId || integration.shopifyClientSecret) {
      return "CUSTOM_APP";
    }

    return "API_KEY";
  }

  private normalizeShopifyDomain(shopDomain: string): string {
    return shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  private decryptStoredValue(
    value: string | null | undefined,
    kind: PublishingSecretKind,
  ): string | null {
    if (!value) {
      return null;
    }

    return decryptPublishingSecret(value, kind);
  }

  private getShopifyCustomAppErrorMessage(error: any): string {
    const apiMessage =
      error?.response?.data?.error_description ||
      error?.response?.data?.error ||
      error?.message;

    return `Failed to authenticate the Shopify custom app. Check the shop domain, client ID, client secret, content scopes, and that the app belongs to this merchant's organization/store.${apiMessage ? ` Shopify said: ${apiMessage}` : ""}`;
  }

  private async exchangeShopifyCustomAppAccessToken(
    integration: PublishingIntegrationData,
  ): Promise<string> {
    if (!integration.shopifyShopDomain) {
      throw new Error("Shopify shop domain is missing");
    }

    if (!integration.shopifyClientId || !integration.shopifyClientSecret) {
      throw new Error(
        "Shopify custom app client ID and client secret are required. Please reconnect.",
      );
    }

    const clientId = this.decryptStoredValue(
      integration.shopifyClientId,
      "shopify-client-id",
    );
    const clientSecret = this.decryptStoredValue(
      integration.shopifyClientSecret,
      "shopify-client-secret",
    );
    if (!clientId) {
      throw new Error(
        "Shopify custom app client ID is missing. Please reconnect.",
      );
    }
    if (!clientSecret) {
      throw new Error(
        "Shopify custom app client secret is missing. Please reconnect.",
      );
    }

    const tokenUrl = `https://${this.normalizeShopifyDomain(
      integration.shopifyShopDomain,
    )}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    try {
      const response = await axios.post(tokenUrl, body.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      });

      const accessToken = response.data?.access_token as string | undefined;
      const expiresInRaw = response.data?.expires_in;

      if (!accessToken) {
        throw new Error("No access token returned by Shopify");
      }

      const issuedAt = new Date();
      const expiresInSeconds =
        typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
          ? expiresInRaw
          : 3600;
      const expiresAt = new Date(issuedAt.getTime() + expiresInSeconds * 1000);
      const encryptedToken = encryptOAuthToken(accessToken, "shopify");

      await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: {
          shopifyAccessToken: encryptedToken,
          shopifyAccessTokenIssuedAt: issuedAt,
          shopifyAccessTokenExpiresAt: expiresAt,
        },
      });

      integration.shopifyAccessToken = encryptedToken;
      integration.shopifyAccessTokenIssuedAt = issuedAt;
      integration.shopifyAccessTokenExpiresAt = expiresAt;

      return accessToken;
    } catch (error: any) {
      throw new Error(this.getShopifyCustomAppErrorMessage(error));
    }
  }

  private async resolveShopifyCredentials(
    integration: PublishingIntegrationData,
  ): Promise<
    Pick<
      ShopifyCredentials,
      "accessToken" | "oauthAccessToken" | "connectionMethod"
    >
  > {
    const connectionMethod = this.normalizeShopifyConnectionMethod(
      integration,
    );

    if (connectionMethod === "OAUTH") {
      if (!integration.shopifyOAuthTokenId) {
        throw new Error("Shopify OAuth token is missing");
      }

      const oauthToken = await prisma.shopifyOAuthToken.findUnique({
        where: { id: integration.shopifyOAuthTokenId },
      });

      if (!oauthToken || !oauthToken.isActive) {
        throw new Error("Shopify OAuth token not found or inactive");
      }

      if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date()) {
        throw new Error("Shopify OAuth token has expired. Please reconnect.");
      }

      const accessToken = decryptOAuthToken(oauthToken.accessToken, "shopify");

      await prisma.shopifyOAuthToken.update({
        where: { id: oauthToken.id },
        data: { lastUsedAt: new Date() },
      });

      return {
        connectionMethod: "OAUTH",
        oauthAccessToken: accessToken,
      };
    }

    if (connectionMethod === "API_KEY") {
      const accessToken = this.decryptStoredValue(
        integration.shopifyAccessToken,
        "shopify-access-token",
      );

      if (!accessToken) {
        throw new Error("Shopify access token is missing");
      }

      return {
        connectionMethod: "API_KEY",
        accessToken,
      };
    }

    const now = new Date();
    const cachedAccessToken = this.decryptStoredValue(
      integration.shopifyAccessToken,
      "shopify-access-token",
    );
    const expiresAt = integration.shopifyAccessTokenExpiresAt;
    const hasFreshCachedToken =
      !!cachedAccessToken &&
      !!expiresAt &&
      expiresAt.getTime() - now.getTime() > 60 * 1000;

    const accessToken = hasFreshCachedToken
      ? cachedAccessToken
      : await this.exchangeShopifyCustomAppAccessToken(integration);

    return {
      connectionMethod: "CUSTOM_APP",
      accessToken,
    };
  }

  private async publishToWordPress(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.wordpressUrl) {
      throw new Error("WordPress URL is missing");
    }

    // Check if using plugin or REST API
    const connectionMethod = integration.wordpressConnectionMethod || "REST_API";

    if (connectionMethod === "PLUGIN") {
      // Use integration key
      if (!integration.wordpressIntegrationKey) {
        throw new Error("WordPress integration key is missing");
      }

      return await publishToWordPress(blog, {
        websiteUrl: integration.wordpressUrl,
        integrationKey: decryptPublishingSecret(
          integration.wordpressIntegrationKey,
          "wordpress-integration-key",
        ),
        connectionMethod: "PLUGIN",
      });
    } else {
      // Use REST API (legacy)
      if (!integration.wordpressUsername) {
        throw new Error("WordPress username is missing");
      }

      // Decrypt password
      const password = integration.wordpressPassword
        ? decryptPublishingSecret(
            integration.wordpressPassword,
            "wordpress-password",
          )
        : null;

      if (!password) {
        throw new Error("WordPress password is missing");
      }

      return await publishToWordPress(blog, {
        websiteUrl: integration.wordpressUrl,
        username: integration.wordpressUsername,
        appPassword: password,
        connectionMethod: "REST_API",
      });
    }
  }

  private async publishToShopify(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.shopifyShopDomain) {
      throw new Error("Shopify shop domain is missing");
    }

    const credentials = await this.resolveShopifyCredentials(integration);

    return await publishToShopify(blog, {
      shopDomain: integration.shopifyShopDomain,
      ...credentials,
      apiVersion: integration.shopifyApiVersion || "2026-01",
      blogId: integration.shopifyBlogId,
      apiMethod: (integration.shopifyApiMethod || "GRAPHQL") as "REST" | "GRAPHQL",
    });
  }

  private async publishToWebflow(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.webflowSiteId) {
      throw new Error("Webflow site ID is missing");
    }

    const connectionMethod = integration.webflowConnectionMethod || "API_KEY";

    if (connectionMethod === "OAUTH") {
      if (!integration.webflowOAuthTokenId) {
        throw new Error("Webflow OAuth token is missing");
      }
      const oauthToken = await prisma.webflowOAuthToken.findUnique({
        where: { id: integration.webflowOAuthTokenId },
      });
      if (!oauthToken || !oauthToken.isActive) {
        throw new Error("Webflow OAuth token not found or inactive");
      }
      let accessToken: string;
      if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date(Date.now() + 60_000)) {
        console.log("[PublishingService] Webflow token expired or expiring soon, attempting refresh...");
        try {
          const refreshed = await refreshWebflowOAuthToken(oauthToken.id);
          accessToken = refreshed.accessToken;
        } catch (refreshError: any) {
          console.error("[PublishingService] Webflow token refresh failed:", refreshError.message);
          throw new Error("Webflow OAuth token has expired and refresh failed. Please reconnect.");
        }
      } else {
        accessToken = decryptOAuthToken(oauthToken.accessToken, "webflow");
        await prisma.webflowOAuthToken.update({
          where: { id: oauthToken.id },
          data: { lastUsedAt: new Date() },
        });
      }
      return await publishToWebflow(blog, {
        siteId: integration.webflowSiteId,
        oauthAccessToken: accessToken,
        connectionMethod: "OAUTH",
        collectionId: integration.webflowCollectionId,
      });
    } else {
      // API Key (legacy) method
      if (!integration.webflowApiKey) {
        throw new Error("Webflow API key is missing");
      }
      const apiKey = decryptPublishingSecret(
        integration.webflowApiKey,
        "webflow-site-token",
      );
      return await publishToWebflow(blog, {
        siteId: integration.webflowSiteId,
        apiKey: apiKey,
        connectionMethod: "API_KEY",
        collectionId: integration.webflowCollectionId,
      });
    }
  }

  private async publishToFramer(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.framerProjectId || !integration.framerApiKey) {
      throw new Error("Framer credentials are missing");
    }

    const apiKey = integration.framerApiKey
      ? decryptPublishingSecret(integration.framerApiKey, "framer-api-key")
      : null;

    if (!apiKey) {
      throw new Error("Framer API key is missing");
    }

    return await publishToFramer(blog, {
      projectId: integration.framerProjectId,
      apiKey,
      collectionName: integration.framerCollectionName,
    });
  }

  private async publishToCustomApi(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.customApiUrl) {
      throw new Error("Custom API URL is missing");
    }

    const apiKey = integration.customApiKey
      ? decryptPublishingSecret(integration.customApiKey, "custom-api-key")
      : null;

    const apiSecret = integration.customApiSecret
      ? decryptPublishingSecret(
          integration.customApiSecret,
          "custom-api-secret",
        )
      : null;

    return await publishToCustomApi(blog, {
      url: integration.customApiUrl,
      method: (integration.customApiMethod || "POST") as "POST" | "PUT" | "PATCH",
      authType: (integration.customApiAuthType || "bearer") as
        | "bearer"
        | "basic"
        | "apikey"
        | "oauth",
      apiKey,
      apiSecret,
      headers: integration.customApiHeaders || {},
      payloadMapping: integration.customApiPayloadMapping,
      responseMapping: integration.customApiResponseMapping,
    });
  }

  private async publishToWix(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.wixSiteId) {
      throw new Error("Wix site ID is missing");
    }

    if (!integration.wixOAuthTokenId) {
      throw new Error("Wix OAuth token is missing");
    }

    // Get OAuth token from database
    const oauthToken = await prisma.wixOAuthToken.findUnique({
      where: { id: integration.wixOAuthTokenId },
    });

    if (!oauthToken || !oauthToken.isActive) {
      throw new Error("Wix OAuth token not found or inactive");
    }

    let accessToken: string;
    if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date(Date.now() + 60_000)) {
      console.log("[PublishingService] Wix token expired or expiring soon, attempting refresh...");
      try {
        const refreshed = await refreshWixOAuthToken(oauthToken.id);
        accessToken = refreshed.accessToken;
      } catch (refreshError: any) {
        console.error("[PublishingService] Wix token refresh failed:", refreshError.message);
        throw new Error("Wix OAuth token has expired and refresh failed. Please reconnect.");
      }
    } else {
      accessToken = decryptOAuthToken(oauthToken.accessToken, "wix");
      await prisma.wixOAuthToken.update({
        where: { id: oauthToken.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return await publishToWix(blog, {
      siteId: integration.wixSiteId,
      oauthAccessToken: accessToken,
      collectionId: integration.wixCollectionId,
    });
  }

  private async publishToReddit(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.redditOAuthTokenId) {
      throw new Error("Reddit OAuth token is missing");
    }

    const oauthToken = await prisma.redditOAuthToken.findUnique({
      where: { id: integration.redditOAuthTokenId },
    });

    if (!oauthToken || !oauthToken.isActive) {
      throw new Error("Reddit OAuth token not found or inactive");
    }

    if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date()) {
      throw new Error("Reddit OAuth token has expired. Please reconnect.");
    }

    const accessToken = decryptOAuthToken(oauthToken.accessToken, "reddit");

    await prisma.redditOAuthToken.update({
      where: { id: oauthToken.id },
      data: { lastUsedAt: new Date() },
    });

    return await publishToReddit(blog, {
      accessToken: oauthToken.accessToken, // Pass encrypted token, publisher will decrypt
      subreddit: integration.redditSubreddit || undefined,
      userAgent: process.env.REDDIT_USER_AGENT,
    });
  }

  private async publishToMedium(
    blog: BlogPublishData,
    integration: PublishingIntegrationData
  ): Promise<PublishResult> {
    if (!integration.mediumOAuthTokenId) {
      throw new Error("Medium OAuth token is missing");
    }

    const oauthToken = await prisma.mediumOAuthToken.findUnique({
      where: { id: integration.mediumOAuthTokenId },
    });

    if (!oauthToken || !oauthToken.isActive) {
      throw new Error("Medium OAuth token not found or inactive");
    }

    if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date()) {
      throw new Error("Medium OAuth token has expired. Please reconnect.");
    }

    const accessToken = decryptOAuthToken(oauthToken.accessToken, "medium");

    await prisma.mediumOAuthToken.update({
      where: { id: oauthToken.id },
      data: { lastUsedAt: new Date() },
    });

    return await publishToMedium(blog, {
      accessToken: oauthToken.accessToken,
      publicationId: integration.mediumPublicationId || undefined,
    });
  }

  /**
   * Platform-specific connection test methods
   */
  private async testWordPressConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string; pluginVersion?: string }> {
    if (!integration.wordpressUrl) {
      return { success: false, error: "WordPress URL is missing" };
    }

    const connectionMethod = integration.wordpressConnectionMethod || "REST_API";

    if (connectionMethod === "PLUGIN") {
      // Test plugin connection using integration key
      if (!integration.wordpressIntegrationKey) {
        return {
          success: false,
          error: "WordPress integration key is missing",
        };
      }

      try {
        // Trim the integration key to avoid whitespace issues
        const integrationKey = decryptPublishingSecret(
          integration.wordpressIntegrationKey,
          "wordpress-integration-key",
        ).trim();
        
        if (!integrationKey) {
          return {
            success: false,
            error: "Integration key is empty",
          };
        }

        const { url: guardedUrl } = await guardUrl(integration.wordpressUrl);
        if (guardedUrl.protocol !== "https:" && process.env.NODE_ENV === "production") {
          return { success: false, error: "WordPress site must use HTTPS" };
        }
        guardedUrl.search = "";
        guardedUrl.hash = "";
        const wordpressUrl = guardedUrl.toString().replace(/\/$/, "");

        console.log("[WordPress Test] Testing plugin connection");
        
        // Test connection by calling plugin status endpoint
        const response = await axios.get(
          `${wordpressUrl}/wp-json/seo-tool/v1/test`,
          {
            headers: {
              Authorization: `Bearer ${integrationKey}`,
            },
            timeout: 10000,
            maxRedirects: 0,
            maxContentLength: 2 * 1024 * 1024,
          }
        );

        if (response.status === 200) {
          console.log(`[WordPress Test] ✅ Connection test successful`);
          const pluginVersion = response.data?.plugin_version || undefined;
          return { success: true, pluginVersion };
        }

        return {
          success: false,
          error: "Connection test failed",
        };
      } catch (error: any) {
        const errorMessage = error.response?.data?.message || 
                            error.response?.data?.code ||
                            error.message || 
                            "Failed to test WordPress plugin connection";
        
        console.error(`[WordPress Test] ❌ Connection test failed:`, {
          status: error.response?.status,
          message: errorMessage,
          data: error.response?.data,
        });
        
        return {
          success: false,
          error: errorMessage,
        };
      }
    } else {
      // Test REST API connection (legacy)
      if (!integration.wordpressUsername) {
        return {
          success: false,
          error: "WordPress username is missing",
        };
      }

      const password = integration.wordpressPassword
        ? decryptPublishingSecret(
            integration.wordpressPassword,
            "wordpress-password",
          )
        : null;

      if (!password) {
        return {
          success: false,
          error: "WordPress password is missing",
        };
      }

      return await testWordPressConnection({
        websiteUrl: integration.wordpressUrl,
        username: integration.wordpressUsername,
        appPassword: password,
      });
    }
  }

  private async testShopifyConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.shopifyShopDomain) {
      return { success: false, error: "Shopify shop domain is missing" };
    }

    try {
      const credentials = await this.resolveShopifyCredentials(integration);

      return await testShopifyConnection({
        shopDomain: integration.shopifyShopDomain,
        ...credentials,
        apiVersion: integration.shopifyApiVersion || "2026-01",
        blogId: integration.shopifyBlogId,
        apiMethod: (integration.shopifyApiMethod || "GRAPHQL") as "REST" | "GRAPHQL",
      });
    } catch (error: any) {
      return {
        success: false,
        error: error.message || "Failed to test Shopify connection",
      };
    }
  }

  private async testWebflowConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.webflowSiteId) {
      return { success: false, error: "Webflow site ID is missing" };
    }

    const connectionMethod = integration.webflowConnectionMethod || "API_KEY";

    if (connectionMethod === "OAUTH") {
      if (!integration.webflowOAuthTokenId) {
        return { success: false, error: "Webflow OAuth token is missing" };
      }
      try {
        const oauthToken = await prisma.webflowOAuthToken.findUnique({
          where: { id: integration.webflowOAuthTokenId },
        });
        if (!oauthToken || !oauthToken.isActive) {
          return { success: false, error: "Webflow OAuth token not found or inactive" };
        }
        let accessToken: string;
        if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date(Date.now() + 60_000)) {
          try {
            const refreshed = await refreshWebflowOAuthToken(oauthToken.id);
            accessToken = refreshed.accessToken;
          } catch (refreshError: any) {
            return { success: false, error: "Webflow OAuth token has expired and refresh failed. Please reconnect." };
          }
        } else {
          accessToken = decryptOAuthToken(oauthToken.accessToken, "webflow");
        }
        const response = await axios.get(
          `https://api.webflow.com/v2/sites/${integration.webflowSiteId}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 10000,
          }
        );
        if (response.status === 200) {
          return { success: true };
        }
        return { success: false, error: "Connection test failed" };
      } catch (error: any) {
        return {
          success: false,
          error: error.response?.data?.message || error.message || "Failed to test Webflow OAuth connection",
        };
      }
    } else {
      // API Key (legacy) method
      if (!integration.webflowApiKey) {
        return { success: false, error: "Webflow API key is missing" };
      }
      const apiKey = decryptPublishingSecret(
        integration.webflowApiKey,
        "webflow-site-token",
      );
      return await testWebflowConnection({
        siteId: integration.webflowSiteId,
        apiKey: apiKey,
        connectionMethod: "API_KEY",
        collectionId: integration.webflowCollectionId,
      });
    }
  }

  private async testFramerConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.framerProjectId || !integration.framerApiKey) {
      return { success: false, error: "Framer credentials are missing" };
    }

    const apiKey = integration.framerApiKey
      ? decryptPublishingSecret(integration.framerApiKey, "framer-api-key")
      : null;

    if (!apiKey) {
      return { success: false, error: "Framer API key is missing" };
    }

    return await testFramerConnection({
      projectId: integration.framerProjectId,
      apiKey,
      collectionName: integration.framerCollectionName,
    });
  }

  private async testCustomApiConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.customApiUrl) {
      return { success: false, error: "Custom API URL is missing" };
    }

    const apiKey = integration.customApiKey
      ? decryptPublishingSecret(integration.customApiKey, "custom-api-key")
      : null;

    const apiSecret = integration.customApiSecret
      ? decryptPublishingSecret(
          integration.customApiSecret,
          "custom-api-secret",
        )
      : null;

    return await testCustomApiConnection({
      url: integration.customApiUrl,
      method: (integration.customApiMethod || "POST") as "POST" | "PUT" | "PATCH",
      authType: (integration.customApiAuthType || "bearer") as
        | "bearer"
        | "basic"
        | "apikey"
        | "oauth",
      apiKey,
      apiSecret,
      headers: integration.customApiHeaders || {},
      payloadMapping: integration.customApiPayloadMapping,
      responseMapping: integration.customApiResponseMapping,
    });
  }

  private async testWixConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.wixSiteId) {
      return { success: false, error: "Wix site ID is missing" };
    }

    if (!integration.wixOAuthTokenId) {
      return { success: false, error: "Wix OAuth token is missing" };
    }

    try {
      const oauthToken = await prisma.wixOAuthToken.findUnique({
        where: { id: integration.wixOAuthTokenId },
      });

      if (!oauthToken || !oauthToken.isActive) {
        return { success: false, error: "Wix OAuth token not found or inactive" };
      }

      let accessToken: string;
      if (oauthToken.tokenExpiresAt && oauthToken.tokenExpiresAt < new Date(Date.now() + 60_000)) {
        try {
          const refreshed = await refreshWixOAuthToken(oauthToken.id);
          accessToken = refreshed.accessToken;
        } catch (refreshError: any) {
          return { success: false, error: "Wix OAuth token has expired and refresh failed. Please reconnect." };
        }
      } else {
        accessToken = decryptOAuthToken(oauthToken.accessToken, "wix");
      }

      return await testWixConnection({
        siteId: integration.wixSiteId,
        oauthAccessToken: accessToken,
        collectionId: integration.wixCollectionId,
      });
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.message || error.message || "Failed to test Wix connection",
      };
    }
  }

  private async testRedditConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.redditOAuthTokenId) {
      return { success: false, error: "Reddit OAuth token is missing" };
    }

    try {
      const oauthToken = await prisma.redditOAuthToken.findUnique({
        where: { id: integration.redditOAuthTokenId },
      });

      if (!oauthToken || !oauthToken.isActive) {
        return { success: false, error: "Reddit OAuth token not found or inactive" };
      }

      return await testRedditConnection({
        accessToken: oauthToken.accessToken, // Pass encrypted token, publisher will decrypt
        subreddit: integration.redditSubreddit || undefined,
        userAgent: process.env.REDDIT_USER_AGENT,
      });
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.message || error.message || "Failed to test Reddit connection",
      };
    }
  }

  private async testMediumConnection(
    integration: PublishingIntegrationData
  ): Promise<{ success: boolean; error?: string }> {
    if (!integration.mediumOAuthTokenId) {
      return { success: false, error: "Medium OAuth token is missing" };
    }

    try {
      const oauthToken = await prisma.mediumOAuthToken.findUnique({
        where: { id: integration.mediumOAuthTokenId },
      });

      if (!oauthToken || !oauthToken.isActive) {
        return { success: false, error: "Medium OAuth token not found or inactive" };
      }

      return await testMediumConnection({
        accessToken: oauthToken.accessToken, // Pass encrypted token, publisher will decrypt
        publicationId: integration.mediumPublicationId || undefined,
      });
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.message || error.message || "Failed to test Medium connection",
      };
    }
  }

  /**
   * Helper: Delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
