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

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_REDIRECT_URI = `${process.env.BACKEND_URL}/api/v1/auth/reddit/callback`;

const REDDIT_SCOPES = "submit,read,identity";

export async function authorizeReddit(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "Missing userId parameter", 400);
    }

    if (!REDDIT_CLIENT_ID) {
      return sendError(res, "Reddit client ID not configured", 500);
    }

    const state = createOAuthState({ provider: "reddit", userId });
    const authUrl = `https://www.reddit.com/api/v1/authorize?` +
      `client_id=${REDDIT_CLIENT_ID}&` +
      `response_type=code&` +
      `state=${state}&` +
      `redirect_uri=${encodeURIComponent(REDDIT_REDIRECT_URI)}&` +
      `duration=permanent&` +
      `scope=${encodeURIComponent(REDDIT_SCOPES)}`;

    res.cookie("reddit_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 600000,
      sameSite: "lax",
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("[Reddit OAuth] Authorization error:", error);
    return sendError(res, "Authorization failed", 500, error);
  }
}

export async function handleRedditCallback(req: Request, res: Response) {
  try {
    const { code, state, error } = req.query;
    const storedState = req.cookies?.reddit_oauth_state;

    if (error) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/publish-console?error=reddit_oauth_denied`
      );
    }

    if (!code || !state) {
      return sendError(res, "Missing required OAuth parameters", 400);
    }

    if (storedState && state !== storedState) {
      return sendError(res, "Invalid state parameter", 400);
    }
    const verifiedState = verifyOAuthState(state, "reddit");
    if (!verifiedState) return sendError(res, "Invalid state parameter", 400);
    const userId = verifiedState.userId;

    if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
      return sendError(res, "Reddit credentials not configured", 500);
    }

    const tokenResponse = await axios.post(
      "https://www.reddit.com/api/v1/access_token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: REDDIT_REDIRECT_URI,
      }),
      {
        auth: {
          username: REDDIT_CLIENT_ID,
          password: REDDIT_CLIENT_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": process.env.REDDIT_USER_AGENT || "SEO-Tool/1.0",
        },
      }
    );

    const { access_token, refresh_token, expires_in, token_type, scope } = tokenResponse.data as {
      access_token?: string;
      refresh_token?: string | null;
      expires_in?: number;
      token_type?: string | null;
      scope?: string | null;
    };

    if (!access_token) {
      return sendError(res, "Failed to obtain access token", 500);
    }

    const userInfoResponse = await axios.get("https://oauth.reddit.com/api/v1/me", {
      headers: {
        Authorization: `${token_type ?? "bearer"} ${access_token}`,
        "User-Agent": process.env.REDDIT_USER_AGENT || "SEO-Tool/1.0",
      },
    });

    const redditUser = userInfoResponse.data as { id: string; name?: string | null };
    const databaseUserId = await getDatabaseUserId(userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const expiresAt = expires_in != null ? new Date(Date.now() + expires_in * 1000) : undefined;

    const existingToken = await prisma.redditOAuthToken.findUnique({
      where: { userId: databaseUserId },
    });

    const encryptedAccessToken = encryptOAuthToken(access_token, "reddit");
    const encryptedRefreshToken: string | undefined = refresh_token != null
      ? encryptOAuthToken(refresh_token, "reddit")
      : undefined;

    const tokenData: Record<string, unknown> = {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken ?? undefined,
      tokenType: token_type ?? "bearer",
      tokenExpiresAt: expiresAt,
      scope: scope ?? undefined,
      redditUsername: redditUser.name ?? "",
      redditUserId: redditUser.id,
      isActive: true,
    };
    if (existingToken) {
      await prisma.redditOAuthToken.update({
        where: { id: existingToken.id },
        data: { ...tokenData, lastUsedAt: new Date() } as unknown as import("@prisma/client").Prisma.RedditOAuthTokenUpdateInput,
      });
    } else {
      await prisma.redditOAuthToken.create({
        data: { ...tokenData, userId: databaseUserId } as unknown as import("@prisma/client").Prisma.RedditOAuthTokenCreateInput,
      });
    }

    const integrationWhere: { userId: string; platform: typeof ConnectionPlatform.REDDIT; businessId: null } = { userId: databaseUserId, platform: ConnectionPlatform.REDDIT, businessId: null };
    let integration = await prisma.publishingIntegration.findFirst({
      where: integrationWhere as import("@prisma/client").Prisma.PublishingIntegrationWhereInput,
    });

    if (!integration) {
      const tokenId = existingToken?.id ?? (await prisma.redditOAuthToken.findUnique({ where: { userId: databaseUserId } }))?.id ?? undefined;
      integration = await prisma.publishingIntegration.create({
        data: { userId: databaseUserId, platform: ConnectionPlatform.REDDIT, redditOAuthTokenId: tokenId, isActive: true, autoPublish: true, publishAs: "PUBLISH" } as unknown as import("@prisma/client").Prisma.PublishingIntegrationCreateInput,
      });
    } else {
      const tokenId = existingToken?.id ?? (await prisma.redditOAuthToken.findUnique({ where: { userId: databaseUserId } }))?.id ?? undefined;
      integration = await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: { redditOAuthTokenId: tokenId, isActive: true, isVerified: true, lastSyncAt: new Date() } as import("@prisma/client").Prisma.PublishingIntegrationUpdateInput,
      });
    }

    res.clearCookie("reddit_oauth_state");

    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/publish-console?success=reddit_connected`
    );
  } catch (error: any) {
    console.error("[Reddit OAuth] Callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/publish-console?error=reddit_oauth_failed`
    );
  }
}

export async function disconnectReddit(req: Request, res: Response) {
  try {
    const rawUserId = req.body?.userId ?? req.query?.userId;
    if (typeof rawUserId !== "string") {
      return sendError(res, "Missing userId", 400);
    }
    const databaseUserId = await getDatabaseUserId(rawUserId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const token = await prisma.redditOAuthToken.findUnique({
      where: { userId: databaseUserId },
    });

    if (!token) {
      return sendError(res, "Reddit account not connected", 404);
    }

    await prisma.redditOAuthToken.update({
      where: { id: token.id },
      data: { isActive: false },
    });

    await prisma.publishingIntegration.updateMany({
      where: {
        userId: databaseUserId,
        platform: ConnectionPlatform.REDDIT,
      },
      data: {
        isActive: false,
      },
    });

    return sendSuccess(res, { message: "Reddit account disconnected" });
  } catch (error: any) {
    console.error("[Reddit OAuth] Disconnect error:", error);
    return sendError(res, "Failed to disconnect Reddit account", 500, error);
  }
}

export async function getRedditStatus(req: Request, res: Response) {
  try {
    const rawUserId = req.query?.userId;
    if (typeof rawUserId !== "string") {
      return sendError(res, "Missing userId", 400);
    }
    const databaseUserId = await getDatabaseUserId(rawUserId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const token = await prisma.redditOAuthToken.findUnique({
      where: { userId: databaseUserId },
      select: {
        id: true,
        redditUsername: true,
        isActive: true,
        connectedAt: true,
        lastUsedAt: true,
      },
    });

    if (!token) {
      return sendSuccess(res, { connected: false });
    }

    const integration = await prisma.publishingIntegration.findFirst({
      where: { userId: databaseUserId, platform: ConnectionPlatform.REDDIT, businessId: null } as import("@prisma/client").Prisma.PublishingIntegrationWhereInput,
    });

    return sendSuccess(res, {
      connected: token.isActive,
      username: token.redditUsername ?? undefined,
      connectedAt: token.connectedAt ?? undefined,
      lastUsedAt: token.lastUsedAt ?? undefined,
      integrationId: integration?.id ?? undefined,
      isActive: integration?.isActive ?? undefined,
    });
  } catch (error: unknown) {
    console.error("[Reddit OAuth] Status error:", error);
    return sendError(res, "Failed to get Reddit status", 500, error);
  }
}
