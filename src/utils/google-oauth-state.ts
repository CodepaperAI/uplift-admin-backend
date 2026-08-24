import crypto from "node:crypto";

export type GoogleOAuthProvider = "gmb" | "gsc";

export type GoogleOAuthStatePayload = {
  v: 1;
  provider: GoogleOAuthProvider;
  userId: string;
  businessId: string;
  redirectUri: string;
  exp: number;
  nonce: string;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_BYTES = 32;
const CALLBACK_PATHS: Record<GoogleOAuthProvider, string> = {
  gmb: "/api/auth/google-my-business/callback",
  gsc: "/api/auth/search-console/callback",
};

function normalizeOrigin(value?: string | null): string | null {
  const normalized = value?.trim().replace(/^"+|"+$/g, "").replace(/\/+$/, "");
  if (!normalized) return null;
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(): Set<string> {
  return new Set(
    [
      "http://localhost:3001",
      "http://dashboard.localhost:3001",
      "https://dashboard.upliftai.co",
      "https://upliftai.co",
      "https://www.upliftai.co",
      "https://dashboard.dev.upliftai.co",
      "https://app.dev.upliftai.co",
      normalizeOrigin(process.env.FRONTEND_URL),
      normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL),
      ...(process.env.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => normalizeOrigin(origin)),
    ].filter((origin): origin is string => Boolean(origin)),
  );
}

function getSecret(): string {
  return (
    process.env.GOOGLE_OAUTH_STATE_SECRET?.trim() ??
    process.env.BACKEND_AUTH_SECRET?.trim() ??
    ""
  );
}

function hasStrongSecret(secret: string): boolean {
  return Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

export function isAllowedGoogleOAuthRedirect(
  provider: GoogleOAuthProvider,
  redirectUri: string,
): boolean {
  try {
    const url = new URL(redirectUri);
    return (
      allowedOrigins().has(url.origin) &&
      url.pathname === CALLBACK_PATHS[provider] &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function signGoogleOAuthState(input: {
  provider: GoogleOAuthProvider;
  userId: string;
  businessId: string;
  redirectUri: string;
}): string {
  const secret = getSecret();
  if (
    !hasStrongSecret(secret) ||
    !isAllowedGoogleOAuthRedirect(input.provider, input.redirectUri)
  ) {
    return "";
  }

  const payload: GoogleOAuthStatePayload = {
    v: 1,
    provider: input.provider,
    userId: input.userId,
    businessId: input.businessId,
    redirectUri: input.redirectUri,
    exp: Date.now() + STATE_TTL_MS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyGoogleOAuthState(
  token: string,
  provider: GoogleOAuthProvider,
): GoogleOAuthStatePayload | null {
  const secret = getSecret();
  if (!hasStrongSecret(secret) || !token || token.length > 4_096) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const suppliedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<GoogleOAuthStatePayload>;
    if (
      payload.v !== 1 ||
      payload.provider !== provider ||
      typeof payload.userId !== "string" ||
      typeof payload.businessId !== "string" ||
      typeof payload.redirectUri !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.exp < Date.now() ||
      !isAllowedGoogleOAuthRedirect(provider, payload.redirectUri)
    ) {
      return null;
    }
    return payload as GoogleOAuthStatePayload;
  } catch {
    return null;
  }
}

export function isGoogleOAuthStateConfigured(): boolean {
  return hasStrongSecret(getSecret());
}
