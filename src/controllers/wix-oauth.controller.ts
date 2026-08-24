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
import {
  createWixAccessTokenForInstance,
  resolveWixInstanceId,
} from "../utils/wix-oauth.utils";

type WixPublishMode = "DRAFT" | "PUBLISH";

function getFrontendUrl() {
  return process.env.FRONTEND_URL || "http://upliftai.co/";
}

function getString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function clearWixOAuthCookies(res: Response) {
  res.clearCookie("wix_oauth_state");
  res.clearCookie("wix_oauth_site_id");
  res.clearCookie("wix_oauth_user_id");
  res.clearCookie("wix_oauth_business_id");
  res.clearCookie("wix_oauth_auto_publish");
  res.clearCookie("wix_oauth_publish_as");
}

async function fetchWixSiteInfo(siteId: string, accessToken: string) {
  try {
    const siteResponse = await axios.get(
      `https://www.wixapis.com/sites/v2/site/${siteId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "wix-site-id": siteId,
        },
      },
    );
    return siteResponse.data?.site || {};
  } catch (error) {
    console.warn("[Wix OAuth] Could not fetch site info:", error);
    return {};
  }
}

async function persistWixConnection(input: {
  databaseUserId: string;
  wixSiteId: string;
  wixInstanceId: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  targetBusinessId: string | null;
  autoPublish: boolean;
  publishAs: WixPublishMode;
}) {
  if (input.targetBusinessId) {
    const business = await prisma.business.findFirst({
      where: {
        id: input.targetBusinessId,
        userId: input.databaseUserId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!business) {
      throw new Error("Business not found for Wix connection");
    }
  }

  const siteInfo = await fetchWixSiteInfo(input.wixSiteId, input.accessToken);
  const encryptedAccessToken = encryptOAuthToken(input.accessToken, "wix");
  const encryptedRefreshToken = input.refreshToken
    ? encryptOAuthToken(input.refreshToken, "wix")
    : null;

  const oauthToken = await prisma.wixOAuthToken.upsert({
    where: {
      userId_wixSiteId: {
        userId: input.databaseUserId,
        wixSiteId: input.wixSiteId,
      },
    },
    update: {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      wixInstanceId: input.wixInstanceId,
      tokenExpiresAt: input.expiresAt,
      isActive: true,
      lastUsedAt: new Date(),
      siteName: siteInfo.displayName || siteInfo.name,
      siteUrl: siteInfo.url,
    },
    create: {
      userId: input.databaseUserId,
      wixSiteId: input.wixSiteId,
      wixInstanceId: input.wixInstanceId,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: input.expiresAt,
      isActive: true,
      connectedAt: new Date(),
      siteName: siteInfo.displayName || siteInfo.name,
      siteUrl: siteInfo.url,
    },
  });

  const existing = await prisma.publishingIntegration.findFirst({
    where: {
      userId: input.databaseUserId,
      platform: ConnectionPlatform.WIX,
      businessId: input.targetBusinessId,
    },
  });

  const integrationData = {
    wixConnectionMethod: "OAUTH",
    wixOAuthTokenId: oauthToken.id,
    wixSiteId: input.wixSiteId,
    businessId: input.targetBusinessId,
    isActive: true,
    isVerified: true,
    autoPublish: input.autoPublish,
    publishAs: input.publishAs,
  };

  if (existing) {
    await prisma.publishingIntegration.update({
      where: { id: existing.id },
      data: integrationData,
    });
  } else {
    await prisma.publishingIntegration.create({
      data: {
        userId: input.databaseUserId,
        platform: ConnectionPlatform.WIX,
        ...integrationData,
      },
    });
  }

  return oauthToken;
}

/**
 * GET /api/v1/auth/wix/authorize
 * Initiate Wix OAuth flow
 */
export async function authorizeWix(req: AuthenticatedRequest, res: Response) {
  try {
    const { site_id, businessId, auto_publish, publish_as } = req.query;
    const userId = req.authUserId;

    if (!site_id) {
      return sendError(res, "Missing site_id parameter", 400);
    }
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
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

    const appId = process.env.WIX_APP_ID;
    if (!appId) {
      return sendError(res, "Wix app ID not configured", 500);
    }

    const state = createOAuthState({
      provider: "wix",
      userId,
      context: {
        siteId: String(site_id),
        businessId: targetBusinessId,
        autoPublish: auto_publish !== "false",
        publishAs: publish_as === "DRAFT" ? "DRAFT" : "PUBLISH",
      },
    });

    const installUrl = new URL("https://www.wix.com/installer/install");
    installUrl.searchParams.set("appId", appId);
    installUrl.searchParams.set("state", state);

    const configuredRedirectUrl = process.env.WIX_INSTALL_REDIRECT_URL?.trim();
    if (configuredRedirectUrl) {
      installUrl.searchParams.set("redirectUrl", configuredRedirectUrl);
    }

    const authUrl = installUrl.toString();

    console.log(`[Wix OAuth] Redirecting to Wix installer: ${authUrl}`);

    // Store state in cookie for verification
    res.cookie("wix_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000, // 10 minutes
      sameSite: "lax",
    });

    // Store site_id in cookie for retrieval in callback
    res.cookie("wix_oauth_site_id", site_id as string, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });
    if (businessId) {
      res.cookie("wix_oauth_business_id", businessId as string, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 600000,
        sameSite: "lax",
      });
    }
    res.cookie("wix_oauth_auto_publish", String(auto_publish ?? "true"), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });
    res.cookie("wix_oauth_publish_as", String(publish_as ?? "PUBLISH"), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("[Wix OAuth] Authorization error:", error);
    return sendError(res, "Authorization failed", 500, error);
  }
}

/**
 * GET /api/v1/auth/wix/callback
 * Handle Wix OAuth callback
 */
export async function handleWixCallback(req: Request, res: Response) {
  try {
    const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query;

    // Handle OAuth denial or error from provider
    if (oauthError) {
      console.warn(`[Wix OAuth] User denied or error occurred: ${oauthError} - ${oauthErrorDesc}`);
      clearWixOAuthCookies(res);
      const frontendUrl = getFrontendUrl();
      const errorMessage = encodeURIComponent(
        (oauthErrorDesc as string) || (oauthError === "access_denied" ? "Authorization was cancelled" : `OAuth error: ${oauthError}`)
      );
      return res.redirect(`${frontendUrl}/dashboard/publish-console?wix_error=${errorMessage}&tab=wix`);
    }

    const storedState = req.cookies?.wix_oauth_state;

    const instance = getString(req.query.instance);
    const instanceIdParam =
      getString(req.query.instanceId) || getString(req.query.instance_id);
    const resolvedInstance = resolveWixInstanceId({
      instance,
      instanceId: instanceIdParam,
    });

    if ((!code && !resolvedInstance.instanceId) || !state) {
      return sendError(res, "Missing required Wix callback parameters", 400);
    }

    // Verify state (CSRF protection)
    if (storedState && state !== storedState) {
      return sendError(res, "Invalid state parameter", 400);
    }
    const verifiedState = verifyOAuthState(state, "wix");
    if (!verifiedState) return sendError(res, "Invalid state parameter", 400);
    const storedSiteId = verifiedState.context.siteId;

    if (!storedSiteId) {
      return sendError(res, "Site ID not found in session", 400);
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

    const autoPublish = verifiedState.context.autoPublish !== false;
    const publishAs: WixPublishMode =
      verifiedState.context.publishAs === "DRAFT" ? "DRAFT" : "PUBLISH";

    let accessToken: string;
    let refreshToken: string | null = null;
    let expiresAt: Date | null = null;
    let wixInstanceId: string | null = resolvedInstance.instanceId;

    if (wixInstanceId) {
      const issuedToken = await createWixAccessTokenForInstance(wixInstanceId);
      accessToken = issuedToken.accessToken;
      expiresAt = issuedToken.expiresAt;
    } else {
      const appId = process.env.WIX_APP_ID;
      const appSecret = process.env.WIX_APP_SECRET;

      if (!appId || !appSecret) {
        return sendError(res, "Wix credentials not configured", 500);
      }

      const tokenResponse = await axios.post(
        "https://www.wixapis.com/oauth/access",
        {
          grant_type: "authorization_code",
          client_id: appId,
          client_secret: appSecret,
          code,
          redirect_uri: `${process.env.BACKEND_URL}/api/v1/auth/wix/callback`,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const { access_token, refresh_token, expires_in } = tokenResponse.data;
      if (!access_token) {
        return sendError(res, "Failed to obtain access token", 500);
      }

      accessToken = access_token;
      refreshToken = refresh_token || null;
      expiresAt = expires_in
        ? new Date(Date.now() + expires_in * 1000)
        : null;
    }

    await persistWixConnection({
      databaseUserId,
      wixSiteId: storedSiteId as string,
      wixInstanceId,
      accessToken,
      refreshToken,
      expiresAt,
      targetBusinessId,
      autoPublish,
      publishAs,
    });

    clearWixOAuthCookies(res);

    // Redirect to frontend success page
    const frontendUrl = getFrontendUrl();
    res.redirect(`${frontendUrl}/dashboard/publish-console?wix_connected=true&tab=wix`);
  } catch (error: any) {
    console.error("[Wix OAuth] Callback error:", error);
    const frontendUrl = getFrontendUrl();
    const errorMessage = encodeURIComponent("Failed to connect Wix account. Please try again.");
    return res.redirect(`${frontendUrl}/dashboard/publish-console?wix_error=${errorMessage}&tab=wix`);
  }
}

/**
 * POST /api/v1/auth/wix/connect-instance
 * Connect a Wix app installation using Wix's current instance-based OAuth flow.
 */
export async function connectWixInstance(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const {
      site_id,
      instance,
      instance_id,
      instanceId,
      metaSiteId,
      userId,
      businessId,
      auto_publish,
      publish_as,
    } = req.body || {};

    if (typeof userId === "string" && userId.trim() && userId !== authUserId) {
      return sendError(res, "Authenticated user does not match request user", 403);
    }

    const databaseUserId = await getDatabaseUserId(authUserId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const resolvedInstance = resolveWixInstanceId({
      instance: typeof instance === "string" ? instance : null,
      instanceId:
        typeof instanceId === "string"
          ? instanceId
          : typeof instance_id === "string"
            ? instance_id
            : null,
    });

    if (!resolvedInstance.instanceId) {
      return sendError(
        res,
        "Missing Wix instance ID. Open the installed UpliftAI app from Wix or provide the Wix instanceId.",
        400,
      );
    }

    const payloadMetaSiteId =
      typeof resolvedInstance.payload?.metaSiteId === "string"
        ? resolvedInstance.payload.metaSiteId.trim()
        : "";
    const wixSiteId =
      (typeof site_id === "string" ? site_id.trim() : "") ||
      (typeof metaSiteId === "string" ? metaSiteId.trim() : "") ||
      payloadMetaSiteId;

    if (!wixSiteId) {
      return sendError(res, "Missing Wix site ID", 400);
    }

    const targetBusinessId =
      typeof businessId === "string" && businessId.trim()
        ? businessId.trim()
        : null;
    const autoPublish = auto_publish === false || auto_publish === "false"
      ? false
      : true;
    const publishAs: WixPublishMode = publish_as === "DRAFT" ? "DRAFT" : "PUBLISH";

    const issuedToken = await createWixAccessTokenForInstance(
      resolvedInstance.instanceId,
    );

    const oauthToken = await persistWixConnection({
      databaseUserId,
      wixSiteId,
      wixInstanceId: resolvedInstance.instanceId,
      accessToken: issuedToken.accessToken,
      refreshToken: null,
      expiresAt: issuedToken.expiresAt,
      targetBusinessId,
      autoPublish,
      publishAs,
    });

    return sendSuccess(res, {
      tokenRecordId: oauthToken.id,
      wixSiteId,
      wixInstanceId: resolvedInstance.instanceId,
    });
  } catch (error: any) {
    console.error("[Wix OAuth] Instance connect error:", error);
    return sendError(
      res,
      error.message || "Failed to connect Wix app instance",
      500,
      error,
    );
  }
}

/**
 * POST /api/v1/auth/wix/refresh
 * Refresh Wix access token
 */
export async function refreshWixToken(
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

    const tokenRecord = await prisma.wixOAuthToken.findFirst({
      where: { userId, wixSiteId: site_id, isActive: true },
      select: { id: true },
    });

    if (!tokenRecord) {
      return sendError(res, "Not found", 404);
    }

    // Use the shared refresh utility
    const { refreshWixOAuthToken } = await import("../utils/wix-oauth.utils");
    const result = await refreshWixOAuthToken(tokenRecord.id);

    return sendSuccess(res, {
      refreshed: true,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (error: any) {
    console.error("[Wix OAuth] Refresh error:", error);
    return sendError(res, "Token refresh failed", 500, error);
  }
}
