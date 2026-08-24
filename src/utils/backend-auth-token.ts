import crypto from "crypto";

const TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MIN_SECRET_BYTES = 32;
const TOKEN_VERSION = 1;
const TOKEN_ISSUER = "uplift-next";
const TOKEN_AUDIENCE = "uplift-api";

function getSecret(): string {
  return process.env.BACKEND_AUTH_SECRET?.trim() ?? "";
}

function hasStrongSecret(secret: string): boolean {
  return Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

function isSafeUserId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function signBackendAuthToken(userId: string): string {
  const secret = getSecret();
  if (!hasStrongSecret(secret) || !isSafeUserId(userId)) return "";
  const now = Date.now();
  const payload = {
    v: TOKEN_VERSION,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    userId,
    iat: now,
    exp: now + TTL_MS,
    jti: crypto.randomBytes(16).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifyBackendAuthToken(token: string): { userId: string } | null {
  const secret = getSecret();
  if (!hasStrongSecret(secret) || !token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payloadB64 = parts[0];
  const sig = parts[1];
  if (!payloadB64 || !sig || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  const received = Buffer.from(sig, "utf8");
  const expected = Buffer.from(expectedSig, "utf8");
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const now = Date.now();
    if (
      payload.v !== TOKEN_VERSION ||
      payload.iss !== TOKEN_ISSUER ||
      payload.aud !== TOKEN_AUDIENCE ||
      !isSafeUserId(payload.userId) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.jti !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(payload.jti) ||
      payload.iat > now + MAX_CLOCK_SKEW_MS ||
      payload.exp <= now ||
      payload.exp - payload.iat > TTL_MS + MAX_CLOCK_SKEW_MS ||
      payload.exp <= payload.iat
    ) {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export function isBackendAuthRequired(): boolean {
  return hasStrongSecret(getSecret());
}
