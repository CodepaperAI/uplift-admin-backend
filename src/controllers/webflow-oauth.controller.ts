import { ConnectionPlatform } from "@prisma/client";
import axios from "axios";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { encryptOAuthToken } from "../utils/oauth-token-crypto";
import { createOAuthState, verifyOAuthState } from "../utils/oauth-state";
import {
    sendError,
    sendSuccess
} from "../utils/response.utils";
import { getDatabaseUserId } from "../utils/user.utils";

/**
 * GET /api/v1/auth/webflow/authorize
 * Initiate Webflow OAuth flow
 */
export async function authorizeWebflow(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const {
      site_id,
      businessId,
      collection_id,
      auto_publish,
      publish_as,
    } = req.query;
    const userId = req.authUserId;

    if (!site_id) {
      return sendError(res, "Missing site_id parameter", 400);
    }
    if (!userId) {
      return sendError(res, "Missing userId parameter", 400);
    }
    if (!collection_id) {
      return sendError(res, "Missing collection_id parameter", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) return sendError(res, "Unauthorized", 401);
    const targetBusinessId =
      typeof businessId === "string" && businessId.trim()
        ? businessId.trim()
        : undefined;
    if (targetBusinessId) {
      const business = await prisma.business.findFirst({
        where: { id: targetBusinessId, userId: databaseUserId, isActive: true },
        select: { id: true },
      });
      if (!business) return sendError(res, "Not found", 404);
    }

    const clientId = process.env.WEBFLOW_CLIENT_ID;
    if (!clientId) {
      return sendError(res, "Webflow client ID not configured", 500);
    }

    const scopes = process.env.WEBFLOW_SCOPES || "sites:read sites:write collections:read collections:write";
    const redirectUri = `${process.env.BACKEND_URL}/api/v1/auth/webflow/callback`;

    const state = createOAuthState({
      provider: "webflow",
      userId,
      context: {
        siteId: String(site_id),
        collectionId: String(collection_id),
        businessId: targetBusinessId,
        autoPublish: auto_publish !== "false",
        publishAs: publish_as === "DRAFT" ? "DRAFT" : "PUBLISH",
      },
    });

    // Build Webflow OAuth URL
    const authUrl = `https://webflow.com/oauth/authorize?` +
      `client_id=${clientId}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri as string)}&` +
      `state=${state}`;

    console.log(`[Webflow OAuth] Redirecting to: ${authUrl}`);

    // Store state in cookie for verification
    res.cookie("webflow_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000, // 10 minutes
      sameSite: "lax",
    });

    // Store site_id in cookie for retrieval in callback
    res.cookie("webflow_oauth_site_id", site_id as string, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });
    if (businessId) {
      res.cookie("webflow_oauth_business_id", businessId as string, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 600000,
        sameSite: "lax",
      });
    }
    res.cookie("webflow_oauth_collection_id", collection_id as string, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });
    res.cookie("webflow_oauth_auto_publish", String(auto_publish ?? "true"), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });
    res.cookie("webflow_oauth_publish_as", String(publish_as ?? "PUBLISH"), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("[Webflow OAuth] Authorization error:", error);
    return sendError(res, "Authorization failed", 500, error);
  }
}

/**
 * GET /api/v1/auth/webflow/callback
 * Handle Webflow OAuth callback
 */
export async function handleWebflowCallback(req: Request, res: Response) {
  try {
    const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query;

    // Handle OAuth denial or error from provider
    if (oauthError) {
      console.warn(`[Webflow OAuth] User denied or error occurred: ${oauthError} - ${oauthErrorDesc}`);
      res.clearCookie("webflow_oauth_state");
      res.clearCookie("webflow_oauth_site_id");
      res.clearCookie("webflow_oauth_user_id");
      res.clearCookie("webflow_oauth_business_id");
      res.clearCookie("webflow_oauth_collection_id");
      res.clearCookie("webflow_oauth_auto_publish");
      res.clearCookie("webflow_oauth_publish_as");
      const frontendUrl = process.env.FRONTEND_URL || "http://upliftai.co/";
      const errorMessage = encodeURIComponent(
        (oauthErrorDesc as string) || (oauthError === "access_denied" ? "Authorization was cancelled" : `OAuth error: ${oauthError}`)
      );
      return res.redirect(`${frontendUrl}/dashboard/publish-console?webflow_error=${errorMessage}&tab=webflow`);
    }

    const storedState = req.cookies?.webflow_oauth_state;

    if (!code || !state) {
      return sendError(res, "Missing required OAuth parameters", 400);
    }

    // Verify state (CSRF protection)
    if (storedState && state !== storedState) {
      return sendError(res, "Invalid state parameter", 400);
    }
    const verifiedState = verifyOAuthState(state, "webflow");
    if (!verifiedState) return sendError(res, "Invalid state parameter", 400);
    const storedSiteId = verifiedState.context.siteId;
    const storedCollectionId = verifiedState.context.collectionId;
    if (!storedSiteId) {
      return sendError(res, "Site ID not found in session", 400);
    }

    if (!storedCollectionId) {
      return sendError(res, "Collection ID not found in OAuth session", 400);
    }

    const userId = verifiedState.userId;

    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const targetBusinessId =
      typeof verifiedState.context.businessId === "string" &&
      verifiedState.context.businessId.trim()
        ? verifiedState.context.businessId.trim()
        : null;
    if (targetBusinessId) {
      const business = await prisma.business.findFirst({
        where: { id: targetBusinessId, userId: databaseUserId, isActive: true },
        select: { id: true },
      });
      if (!business) {
        return sendError(res, "Business not found for OAuth connection", 404);
      }
    }

    const autoPublish = verifiedState.context.autoPublish !== false;
    const publishAs =
      verifiedState.context.publishAs === "DRAFT" ? "DRAFT" : "PUBLISH";

    const clientId = process.env.WEBFLOW_CLIENT_ID;
    const clientSecret = process.env.WEBFLOW_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return sendError(res, "Webflow credentials not configured", 500);
    }

    // Exchange code for access token
    const tokenUrl = "https://api.webflow.com/v1/oauth/access_token";
    
    const tokenResponse = await axios.post(
      tokenUrl,
      {
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: "authorization_code",
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    if (!access_token) {
      return sendError(res, "Failed to obtain access token", 500);
    }

    // Get site information
    let siteInfo: any = {};
    try {
      const siteResponse = await axios.get(
        `https://api.webflow.com/v2/sites/${storedSiteId}`,
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }
      );
      siteInfo = siteResponse.data || {};
    } catch (error) {
      console.warn("[Webflow OAuth] Could not fetch site info:", error);
    }

    // Encrypt and store tokens
    const encryptedAccessToken = encryptOAuthToken(access_token, "webflow");
    const encryptedRefreshToken = refresh_token
      ? encryptOAuthToken(refresh_token, "webflow")
      : null;
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000)
      : null;

    // Upsert OAuth token
    const oauthToken = await prisma.webflowOAuthToken.upsert({
      where: {
        userId_siteId: {
          userId: databaseUserId,
          siteId: storedSiteId as string,
        },
      },
      update: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: expiresAt,
        isActive: true,
        lastUsedAt: new Date(),
        siteName: siteInfo.name,
        siteUrl: siteInfo.preferredDomain || siteInfo.shortName,
      },
      create: {
        userId: databaseUserId,
        siteId: storedSiteId as string,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: expiresAt,
        isActive: true,
        connectedAt: new Date(),
        siteName: siteInfo.name,
        siteUrl: siteInfo.preferredDomain || siteInfo.shortName,
      },
    });

    const existing = await prisma.publishingIntegration.findFirst({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.WEBFLOW,
        businessId: targetBusinessId,
      },
    });
    if (existing) {
      await prisma.publishingIntegration.update({
        where: { id: existing.id },
        data: {
          webflowConnectionMethod: "OAUTH",
          webflowOAuthTokenId: oauthToken.id,
          webflowSiteId: storedSiteId as string,
          webflowCollectionId: storedCollectionId as string,
          businessId: targetBusinessId,
          isActive: true,
          isVerified: true,
          autoPublish,
          publishAs,
        },
      });
    } else {
      await prisma.publishingIntegration.create({
        data: {
          userId: databaseUserId,
          platform: ConnectionPlatform.WEBFLOW,
          businessId: targetBusinessId,
          webflowConnectionMethod: "OAUTH",
          webflowOAuthTokenId: oauthToken.id,
          webflowSiteId: storedSiteId as string,
          webflowCollectionId: storedCollectionId as string,
          isActive: true,
          isVerified: true,
          autoPublish,
          publishAs,
        },
      });
    }

    // Clear state cookies
    res.clearCookie("webflow_oauth_state");
    res.clearCookie("webflow_oauth_site_id");
    res.clearCookie("webflow_oauth_user_id");
    res.clearCookie("webflow_oauth_business_id");
    res.clearCookie("webflow_oauth_collection_id");
    res.clearCookie("webflow_oauth_auto_publish");
    res.clearCookie("webflow_oauth_publish_as");

    // Redirect to frontend success page
    const frontendUrl = process.env.FRONTEND_URL || "http://upliftai.co/";
    res.redirect(`${frontendUrl}/dashboard/publish-console?webflow_connected=true&tab=webflow`);
  } catch (error: any) {
    console.error("[Webflow OAuth] Callback error:", error);
    const frontendUrl = process.env.FRONTEND_URL || "http://upliftai.co/";
    const errorMessage = encodeURIComponent("Failed to connect Webflow account. Please try again.");
    return res.redirect(`${frontendUrl}/dashboard/publish-console?webflow_error=${errorMessage}&tab=webflow`);
  }
}

/**
 * POST /api/v1/auth/webflow/refresh
 * Refresh Webflow access token
 */
export async function refreshWebflowToken(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { site_id } = req.body;
    const userId = req.authUserId;

    if (!userId) return sendError(res, "Unauthorized", 401);
    if (!site_id || typeof site_id !== "string") {
      return sendError(res, "Missing site_id", 400);
    }

    const tokenRecord = await prisma.webflowOAuthToken.findFirst({
      where: { userId, siteId: site_id, isActive: true },
      select: { id: true },
    });

    if (!tokenRecord) {
      return sendError(res, "Not found", 404);
    }

    // Use the shared refresh utility
    const { refreshWebflowOAuthToken } = await import("../utils/webflow-oauth.utils");
    const result = await refreshWebflowOAuthToken(tokenRecord.id);

    return sendSuccess(res, {
      refreshed: true,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (error: any) {
    console.error("[Webflow OAuth] Refresh error:", error);
    return sendError(res, "Token refresh failed", 500, error);
  }
}
