import axios from "axios";
import crypto from "crypto";
import { prisma } from "../config/db.config";
import { decryptOAuthToken, encryptOAuthToken } from "./oauth-token-crypto";

export interface WixTokenRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  tokenRecordId: string;
}

export interface WixAccessTokenResult {
  accessToken: string;
  expiresAt: Date | null;
}

export type ParsedWixInstance = Record<string, unknown> & {
  instanceId?: string;
  metaSiteId?: string;
};

function requireWixCredentials() {
  const appId = process.env.WIX_APP_ID;
  const appSecret = process.env.WIX_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Wix credentials not configured");
  }
  return { appId, appSecret };
}

function toBase64UrlBuffer(value: string) {
  return Buffer.from(value, "base64url");
}

export function parseWixSignedInstance(instance: string): ParsedWixInstance {
  const { appSecret } = requireWixCredentials();
  const parts = instance.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid Wix signed instance format");
  }

  const [signature, payloadB64] = parts;
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(payloadB64)
    .digest();
  const actual = toBase64UrlBuffer(signature);

  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw new Error("Invalid Wix signed instance signature");
  }

  const payload = JSON.parse(
    toBase64UrlBuffer(payloadB64).toString("utf8"),
  ) as ParsedWixInstance;
  return payload;
}

export function resolveWixInstanceId(input: {
  instance?: string | null;
  instanceId?: string | null;
  instance_id?: string | null;
}): { instanceId: string | null; payload: ParsedWixInstance | null } {
  const directInstanceId =
    input.instanceId?.trim() || input.instance_id?.trim() || "";
  if (directInstanceId) {
    return { instanceId: directInstanceId, payload: null };
  }

  const signedInstance = input.instance?.trim();
  if (!signedInstance) {
    return { instanceId: null, payload: null };
  }

  const payload = parseWixSignedInstance(signedInstance);
  const parsedInstanceId =
    typeof payload.instanceId === "string" ? payload.instanceId.trim() : "";
  return { instanceId: parsedInstanceId || null, payload };
}

export async function createWixAccessTokenForInstance(
  instanceId: string,
): Promise<WixAccessTokenResult> {
  const { appId, appSecret } = requireWixCredentials();

  const tokenResponse = await axios.post(
    "https://www.wixapis.com/oauth2/token",
    {
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appSecret,
      instance_id: instanceId,
    },
    { headers: { "Content-Type": "application/json" } },
  );

  const { access_token, expires_in } = tokenResponse.data;
  if (!access_token) {
    throw new Error("Failed to create Wix access token");
  }

  return {
    accessToken: access_token,
    expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
  };
}

/**
 * Refresh Wix OAuth token by token record ID.
 * Updates the database and returns the new plaintext access token.
 */
export async function refreshWixOAuthToken(
  tokenRecordId: string
): Promise<WixTokenRefreshResult> {
  const tokenRecord = await prisma.wixOAuthToken.findUnique({
    where: { id: tokenRecordId },
  });

  if (!tokenRecord || !tokenRecord.isActive) {
    throw new Error("Wix OAuth token not found or inactive");
  }

  if (tokenRecord.wixInstanceId) {
    const issuedToken = await createWixAccessTokenForInstance(
      tokenRecord.wixInstanceId,
    );

    await prisma.wixOAuthToken.update({
      where: { id: tokenRecord.id },
      data: {
        accessToken: encryptOAuthToken(issuedToken.accessToken, "wix"),
        tokenExpiresAt: issuedToken.expiresAt,
        lastUsedAt: new Date(),
      },
    });

    return {
      accessToken: issuedToken.accessToken,
      refreshToken: tokenRecord.refreshToken
        ? decryptOAuthToken(tokenRecord.refreshToken, "wix")
        : null,
      expiresAt: issuedToken.expiresAt,
      tokenRecordId: tokenRecord.id,
    };
  }

  if (!tokenRecord.refreshToken) {
    throw new Error("No Wix instance ID or refresh token available. Please reconnect.");
  }

  const { appId, appSecret } = requireWixCredentials();
  const currentRefreshToken = decryptOAuthToken(tokenRecord.refreshToken, "wix");

  const tokenResponse = await axios.post(
    "https://www.wixapis.com/oauth/access",
    {
      grant_type: "refresh_token",
      client_id: appId,
      client_secret: appSecret,
      refresh_token: currentRefreshToken,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const { access_token, refresh_token: new_refresh_token, expires_in } = tokenResponse.data;

  if (!access_token) {
    throw new Error("Failed to refresh Wix access token");
  }

  const encryptedAccessToken = encryptOAuthToken(access_token, "wix");
  const encryptedRefreshToken = new_refresh_token
    ? encryptOAuthToken(new_refresh_token, "wix")
    : tokenRecord.refreshToken;
  const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

  await prisma.wixOAuthToken.update({
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
