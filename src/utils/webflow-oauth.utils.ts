import axios from "axios";
import { prisma } from "../config/db.config";
import { decryptOAuthToken, encryptOAuthToken } from "./oauth-token-crypto";

export interface WebflowTokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  tokenRecordId: string;
}

/**
 * Refresh Webflow OAuth token by token record ID.
 * Updates the database and returns the new plaintext access token.
 */
export async function refreshWebflowOAuthToken(
  tokenRecordId: string
): Promise<WebflowTokenRefreshResult> {
  const tokenRecord = await prisma.webflowOAuthToken.findUnique({
    where: { id: tokenRecordId },
  });

  if (!tokenRecord || !tokenRecord.isActive) {
    throw new Error("Webflow OAuth token not found or inactive");
  }

  if (!tokenRecord.refreshToken) {
    throw new Error("No refresh token available for Webflow. Please reconnect.");
  }

  const clientId = process.env.WEBFLOW_CLIENT_ID;
  const clientSecret = process.env.WEBFLOW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Webflow credentials not configured");
  }

  const currentRefreshToken = decryptOAuthToken(
    tokenRecord.refreshToken,
    "webflow",
  );

  const tokenResponse = await axios.post(
    "https://api.webflow.com/v1/oauth/access_token",
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: currentRefreshToken,
      grant_type: "refresh_token",
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const { access_token, refresh_token: new_refresh_token, expires_in } = tokenResponse.data;

  if (!access_token) {
    throw new Error("Failed to refresh Webflow access token");
  }

  const encryptedAccessToken = encryptOAuthToken(access_token, "webflow");
  const encryptedRefreshToken = new_refresh_token
    ? encryptOAuthToken(new_refresh_token, "webflow")
    : tokenRecord.refreshToken;
  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

  await prisma.webflowOAuthToken.update({
    where: { id: tokenRecord.id },
    data: {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: expiresAt,
      lastUsedAt: new Date(),
    },
  });

  return {
    accessToken: access_token,
    refreshToken: new_refresh_token || currentRefreshToken,
    expiresAt,
    tokenRecordId: tokenRecord.id,
  };
}
