import crypto from "crypto";
import type { Request } from "express";

export const API_TOKEN_PREFIX = "uai_";
export const API_TOKEN_V2_PREFIX = "uai_v2_";
export const WORDPRESS_TOKEN_PREFIX = "wp_key_";

const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_TOKEN_DIGEST_PREFIX = "hmac-sha256:v2:";
const API_TOKEN_HMAC_CONTEXT = "uplift-ai:api-token:v2:";

export class ApiTokenConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiTokenConfigurationError";
  }
}

export type GeneratedApiTokenCredential = {
  id: string;
  plainToken: string;
  tokenDigest: string;
  tokenPrefix: string;
};

export type ParsedApiTokenV2 = {
  id: string;
  secret: string;
};

export type ApiTokenDigestVerification = {
  valid: boolean;
  currentDigest: string | null;
  needsRehash: boolean;
};

export type ExtractedPublicToken = {
  source: "authorization" | "x-api-key" | "path" | "query";
  token: string;
};

function readHmacSecret(
  name: "API_TOKEN_HMAC_SECRET" | "API_TOKEN_HMAC_PREVIOUS_SECRET",
  required: boolean,
): string | null {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    if (required) {
      throw new ApiTokenConfigurationError(`${name} is not configured`);
    }
    return null;
  }

  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new ApiTokenConfigurationError(
      `${name} must contain at least 32 bytes of secret material`,
    );
  }

  return value;
}

function createV2Digest(token: string, secret: string): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${API_TOKEN_HMAC_CONTEXT}${token}`, "utf8")
    .digest("hex");
  return `${API_TOKEN_DIGEST_PREFIX}${digest}`;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function generateApiTokenCredential(): GeneratedApiTokenCredential {
  const hmacSecret = readHmacSecret("API_TOKEN_HMAC_SECRET", true)!;
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
  const plainToken = `${API_TOKEN_V2_PREFIX}${id}.${secret}`;

  return {
    id,
    plainToken,
    tokenDigest: createV2Digest(plainToken, hmacSecret),
    tokenPrefix: `${API_TOKEN_V2_PREFIX}${id.slice(0, 8)}`,
  };
}

export function parseApiTokenV2(token: string): ParsedApiTokenV2 | null {
  if (!token.startsWith(API_TOKEN_V2_PREFIX)) {
    return null;
  }

  const value = token.slice(API_TOKEN_V2_PREFIX.length);
  const separatorIndex = value.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex !== value.lastIndexOf(".")) {
    return null;
  }

  const id = value.slice(0, separatorIndex).toLowerCase();
  const secret = value.slice(separatorIndex + 1);
  if (!UUID_PATTERN.test(id) || !API_TOKEN_SECRET_PATTERN.test(secret)) {
    return null;
  }

  return { id, secret };
}

export function verifyApiTokenV2Digest(
  token: string,
  storedDigest: string,
): ApiTokenDigestVerification {
  if (!parseApiTokenV2(token)) {
    return { valid: false, currentDigest: null, needsRehash: false };
  }

  const currentSecret = readHmacSecret("API_TOKEN_HMAC_SECRET", true)!;
  const previousSecret = readHmacSecret(
    "API_TOKEN_HMAC_PREVIOUS_SECRET",
    false,
  );
  const currentDigest = createV2Digest(token, currentSecret);
  const currentMatches = timingSafeStringEqual(storedDigest, currentDigest);
  const previousMatches = previousSecret
    ? timingSafeStringEqual(storedDigest, createV2Digest(token, previousSecret))
    : false;

  return {
    valid: currentMatches || previousMatches,
    currentDigest,
    needsRehash: !currentMatches && previousMatches,
  };
}

export function isLegacyApiTokenValidationEnabled(): boolean {
  return process.env.API_TOKEN_LEGACY_VALIDATION_ENABLED?.trim().toLowerCase() !==
    "false";
}

function normalizeWebsiteUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getTokenPrefix(token: string): string {
  return token.substring(0, 12);
}

export function deriveAllowedOriginsFromWebsiteUrl(
  websiteUrl: string | null | undefined,
): string[] {
  if (!websiteUrl) {
    return [];
  }

  try {
    const normalizedUrl = normalizeWebsiteUrl(websiteUrl);
    if (!normalizedUrl) {
      return [];
    }

    const parsed = new URL(normalizedUrl);
    const origins = new Set<string>([parsed.origin]);
    const hostname = parsed.hostname.toLowerCase();

    if (parsed.protocol === "https:" && !hostname.includes("localhost")) {
      if (hostname.startsWith("www.")) {
        origins.add(`https://${hostname.slice(4)}`);
      } else if (hostname.split(".").length >= 2) {
        origins.add(`https://www.${hostname}`);
      }
    }

    return Array.from(origins);
  } catch {
    return [];
  }
}

export function extractPublicTokenDetailsFromRequest(
  req: Request,
): ExtractedPublicToken | null {
  const pathToken =
    typeof req.params.token === "string" ? req.params.token.trim() : "";
  if (pathToken) {
    return { token: pathToken, source: "path" };
  }

  const queryToken =
    typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (queryToken) {
    return { token: queryToken, source: "query" };
  }

  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    return { token: apiKeyHeader.trim(), source: "x-api-key" };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || (parts[0] ?? "").toLowerCase() !== "bearer") {
    return null;
  }

  const bearerToken = (parts[1] ?? "").trim();
  return bearerToken
    ? { token: bearerToken, source: "authorization" }
    : null;
}

export function extractPublicTokenFromRequest(req: Request): string | null {
  return extractPublicTokenDetailsFromRequest(req)?.token ?? null;
}

export function isPublicTokenTransportAllowed(
  extracted: ExtractedPublicToken,
): boolean {
  return !(
    extracted.token.startsWith(API_TOKEN_V2_PREFIX) &&
    (extracted.source === "path" || extracted.source === "query")
  );
}

export function isApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX);
}

export function isWordPressKey(token: string): boolean {
  return token.startsWith(WORDPRESS_TOKEN_PREFIX);
}
