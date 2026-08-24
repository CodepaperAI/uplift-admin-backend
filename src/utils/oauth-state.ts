import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const MIN_SECRET_BYTES = 32;

export type OAuthProvider = "medium" | "reddit" | "shopify" | "webflow" | "wix";

export type OAuthStateContext = {
  businessId?: string;
  shop?: string;
  siteId?: string;
  collectionId?: string;
  autoPublish?: boolean;
  publishAs?: "DRAFT" | "PUBLISH";
  apiVersion?: string;
  apiMethod?: "REST" | "GRAPHQL";
  blogId?: string;
};

export type VerifiedOAuthState = {
  provider: OAuthProvider;
  userId: string;
  context: OAuthStateContext;
};

function secret(): string {
  return process.env.OAUTH_STATE_SECRET?.trim() ?? "";
}

function isSafeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function signature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createOAuthState(input: {
  provider: OAuthProvider;
  userId: string;
  context?: OAuthStateContext;
}): string {
  const key = secret();
  if (
    Buffer.byteLength(key, "utf8") < MIN_SECRET_BYTES ||
    !isSafeText(input.userId, 128)
  ) {
    throw new Error("OAuth state signing is unavailable");
  }
  const now = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      v: 1,
      provider: input.provider,
      userId: input.userId,
      context: input.context ?? {},
      iat: now,
      exp: now + STATE_TTL_MS,
      nonce: randomBytes(16).toString("base64url"),
    }),
  ).toString("base64url");
  return `${encoded}.${signature(encoded, key)}`;
}

export function verifyOAuthState(
  token: unknown,
  expectedProvider: OAuthProvider,
): VerifiedOAuthState | null {
  const key = secret();
  if (
    Buffer.byteLength(key, "utf8") < MIN_SECRET_BYTES ||
    typeof token !== "string" ||
    token.length > 4096
  ) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(signature(parts[0], key));
  const received = Buffer.from(parts[1]);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const now = Date.now();
    if (
      parsed.v !== 1 ||
      parsed.provider !== expectedProvider ||
      !isSafeText(parsed.userId, 128) ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.iat > now + CLOCK_SKEW_MS ||
      parsed.exp <= now ||
      parsed.exp <= parsed.iat ||
      parsed.exp - parsed.iat > STATE_TTL_MS + CLOCK_SKEW_MS ||
      !isSafeText(parsed.nonce, 64) ||
      !parsed.context ||
      typeof parsed.context !== "object" ||
      Array.isArray(parsed.context)
    ) {
      return null;
    }
    return {
      provider: expectedProvider,
      userId: parsed.userId,
      context: parsed.context as OAuthStateContext,
    };
  } catch {
    return null;
  }
}
