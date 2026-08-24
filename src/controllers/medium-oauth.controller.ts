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

const MEDIUM_CLIENT_ID = process.env.MEDIUM_CLIENT_ID;
const MEDIUM_CLIENT_SECRET = process.env.MEDIUM_CLIENT_SECRET;
const MEDIUM_REDIRECT_URI = `${process.env.BACKEND_URL}/api/v1/auth/medium/callback`;

const MEDIUM_SCOPES = "basicProfile,publishPost";

export async function authorizeMedium(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "Missing userId parameter", 400);
    }

    if (!MEDIUM_CLIENT_ID) {
      return sendError(res, "Medium client ID not configured", 500);
    }

    const state = createOAuthState({ provider: "medium", userId });
    const authUrl = `https://medium.com/m/oauth/authorize?` +
      `client_id=${MEDIUM_CLIENT_ID}&` +
      `scope=${encodeURIComponent(MEDIUM_SCOPES)}&` +
      `state=${state}&` +
      `response_type=code&` +
      `redirect_uri=${encodeURIComponent(MEDIUM_REDIRECT_URI)}`;

    res.cookie("medium_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("[Medium OAuth] Authorization error:", error);
    return sendError(res, "Authorization failed", 500, error);
  }
}

export async function handleMediumCallback(req: Request, res: Response) {
  try {
    const { code, state, error } = req.query;
    const storedState = req.cookies?.medium_oauth_state;

    if (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/publish-console?error=medium_oauth_denied`
      );
    }

    if (!code || !state) {
      return sendError(res, "Missing required OAuth parameters", 400);
    }

    if (storedState && state !== storedState) {
      return sendError(res, "Invalid state parameter", 400);
    }
    const verifiedState = verifyOAuthState(state, "medium");
    if (!verifiedState) return sendError(res, "Invalid state parameter", 400);
    const userId = verifiedState.userId;

    if (!MEDIUM_CLIENT_ID || !MEDIUM_CLIENT_SECRET) {
      return sendError(res, "Medium credentials not configured", 500);
    }

    const tokenResponse = await axios.post(
      "https://api.medium.com/v1/tokens",
      {
        code: code as string,
        client_id: MEDIUM_CLIENT_ID,
        client_secret: MEDIUM_CLIENT_SECRET,
        grant_type: "authorization_code",
        redirect_uri: MEDIUM_REDIRECT_URI,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const { access_token, refresh_token, expires_at, token_type } = tokenResponse.data as {
      access_token?: string;
      refresh_token?: string | null;
      expires_at?: number;
      token_type?: string | null;
    };

    if (!access_token) {
      return sendError(res, "Failed to obtain access token", 500);
    }

    const userInfoResponse = await axios.get("https://api.medium.com/v1/me", {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
      },
    });

    const mediumUser = userInfoResponse.data.data as { id: string; username?: string | null };
    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const expiresAt = expires_at != null ? new Date(expires_at * 1000) : undefined;

    const existingToken = await prisma.mediumOAuthToken.findUnique({
      where: { userId: databaseUserId },
    });

    const encryptedAccessToken = encryptOAuthToken(access_token, "medium");
    const encryptedRefreshToken: string | undefined = refresh_token != null
      ? encryptOAuthToken(refresh_token, "medium")
      : undefined;

    const tokenData: Record<string, unknown> = {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken ?? undefined,
      tokenType: token_type ?? "bearer",
      tokenExpiresAt: expiresAt,
      mediumUserId: mediumUser.id ?? undefined,
      mediumUsername: mediumUser.username ?? "",
      isActive: true,
    };
    if (existingToken) {
      await prisma.mediumOAuthToken.update({
        where: { id: existingToken.id },
        data: { ...tokenData, lastUsedAt: new Date() } as unknown as import("@prisma/client").Prisma.MediumOAuthTokenUpdateInput,
      });
    } else {
      await prisma.mediumOAuthToken.create({
        data: { ...tokenData, userId: databaseUserId } as unknown as import("@prisma/client").Prisma.MediumOAuthTokenCreateInput,
      });
    }

    const integrationWhere: { userId: string; platform: typeof ConnectionPlatform.MEDIUM; businessId: null } = { userId: databaseUserId, platform: ConnectionPlatform.MEDIUM, businessId: null };
    let integration = await prisma.publishingIntegration.findFirst({
      where: integrationWhere as import("@prisma/client").Prisma.PublishingIntegrationWhereInput,
    });

    if (!integration) {
      const tokenId = existingToken?.id ?? (await prisma.mediumOAuthToken.findUnique({ where: { userId: databaseUserId } }))?.id ?? undefined;
      integration = await prisma.publishingIntegration.create({
        data: { userId: databaseUserId, platform: ConnectionPlatform.MEDIUM, mediumOAuthTokenId: tokenId, isActive: true, autoPublish: true, publishAs: "PUBLISH" } as unknown as import("@prisma/client").Prisma.PublishingIntegrationCreateInput,
      });
    } else {
      const tokenId = existingToken?.id ?? (await prisma.mediumOAuthToken.findUnique({ where: { userId: databaseUserId } }))?.id ?? undefined;
      integration = await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: { mediumOAuthTokenId: tokenId, isActive: true, isVerified: true, lastSyncAt: new Date() } as import("@prisma/client").Prisma.PublishingIntegrationUpdateInput,
      });
    }

    res.clearCookie("medium_oauth_state");

    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/publish-console?success=medium_connected`
    );
  } catch (error: any) {
    console.error("[Medium OAuth] Callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/publish-console?error=medium_oauth_failed`
    );
  }
}

export async function disconnectMedium(req: Request, res: Response) {
  try {
    const rawUserId = req.body?.userId ?? req.query?.userId;
    if (typeof rawUserId !== "string") {
      return sendError(res, "Missing userId", 400);
    }
    const databaseUserId = await getDatabaseUserId(rawUserId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const token = await prisma.mediumOAuthToken.findUnique({
      where: { userId: databaseUserId },
    });

    if (!token) {
      return sendError(res, "Medium account not connected", 404);
    }

    await prisma.mediumOAuthToken.update({
      where: { id: token.id },
      data: { isActive: false },
    });

    await prisma.publishingIntegration.updateMany({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.MEDIUM,
      },
      data: {
        isActive: false,
      },
    });

    return sendSuccess(res, { message: "Medium account disconnected" });
  } catch (error: any) {
    console.error("[Medium OAuth] Disconnect error:", error);
    return sendError(res, "Failed to disconnect Medium account", 500, error);
  }
}

export async function getMediumStatus(req: Request, res: Response) {
  try {
    const rawUserId = req.query?.userId;
    if (typeof rawUserId !== "string") {
      return sendError(res, "Missing userId", 400);
    }
    const databaseUserId = await getDatabaseUserId(rawUserId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const token = await prisma.mediumOAuthToken.findUnique({
      where: { userId: databaseUserId },
      select: {
        id: true,
        mediumUsername: true,
        isActive: true,
        connectedAt: true,
        lastUsedAt: true,
      },
    });

    if (!token) {
      return sendSuccess(res, { connected: false });
    }

    const integration = await prisma.publishingIntegration.findFirst({
      where: { userId: databaseUserId, platform: ConnectionPlatform.MEDIUM, businessId: null } as import("@prisma/client").Prisma.PublishingIntegrationWhereInput,
    });

    return sendSuccess(res, {
      connected: token.isActive,
      username: token.mediumUsername ?? undefined,
      connectedAt: token.connectedAt ?? undefined,
      lastUsedAt: token.lastUsedAt ?? undefined,
      integrationId: integration?.id ?? undefined,
      isActive: integration?.isActive ?? undefined,
    });
  } catch (error: any) {
    console.error("[Medium OAuth] Status error:", error);
    return sendError(res, "Failed to get Medium status", 500, error);
  }
}
