import crypto from "node:crypto";
import { ConnectionPlatform } from "@prisma/client";
import { prisma } from "../config/db.config";

export const WORDPRESS_KEY_V2_PREFIX = "wp_key_v2_";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PREFIX = "hmac-sha256:wp:v2:";
const HMAC_CONTEXT = "uplift-ai:wordpress-integration-key:v2:";

export class WordPressKeyConfigurationError extends Error {}

function readSecret(
  name: "WORDPRESS_KEY_HMAC_SECRET" | "WORDPRESS_KEY_HMAC_PREVIOUS_SECRET",
  required: boolean,
): string | null {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    if (required) throw new WordPressKeyConfigurationError(`${name} is not configured`);
    return null;
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new WordPressKeyConfigurationError(`${name} must be at least 32 bytes`);
  }
  return value;
}

function digest(token: string, secret: string): string {
  return `${DIGEST_PREFIX}${crypto
    .createHmac("sha256", secret)
    .update(`${HMAC_CONTEXT}${token}`, "utf8")
    .digest("hex")}`;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseWordPressKeyV2(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(WORDPRESS_KEY_V2_PREFIX)) return null;
  const parts = token.slice(WORDPRESS_KEY_V2_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [id, secret] = parts;
  if (!id || !secret || !UUID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return null;
  return { id: id.toLowerCase(), secret };
}

export function generateWordPressKeyCredential(id: string) {
  if (!UUID_PATTERN.test(id)) throw new Error("Invalid integration ID");
  const token = `${WORDPRESS_KEY_V2_PREFIX}${id.toLowerCase()}.${crypto
    .randomBytes(32)
    .toString("base64url")}`;
  return {
    plainToken: token,
    tokenDigest: digest(token, readSecret("WORDPRESS_KEY_HMAC_SECRET", true)!),
  };
}

export function verifyWordPressKeyDigest(token: string, storedDigest: string) {
  if (!parseWordPressKeyV2(token)) {
    return { valid: false, needsRehash: false, currentDigest: null as string | null };
  }
  const current = digest(token, readSecret("WORDPRESS_KEY_HMAC_SECRET", true)!);
  const previousSecret = readSecret("WORDPRESS_KEY_HMAC_PREVIOUS_SECRET", false);
  const currentMatches = safeEqual(current, storedDigest);
  const previousMatches = previousSecret
    ? safeEqual(digest(token, previousSecret), storedDigest)
    : false;
  return { valid: currentMatches || previousMatches, needsRehash: !currentMatches && previousMatches, currentDigest: current };
}

export async function authenticateWordPressIntegrationKey(token: string) {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const parsed = parseWordPressKeyV2(trimmed);
  const integration = parsed
    ? await prisma.publishingIntegration.findUnique({
        where: { id: parsed.id },
        select: {
          id: true,
          userId: true,
          businessId: true,
          platform: true,
          isActive: true,
          wordpressUrl: true,
          wordpressIntegrationKeyDigest: true,
          autoPublish: true,
          publishAs: true,
          business: { select: { id: true, isActive: true, businessWebsiteUrl: true } },
        },
      })
    : await prisma.publishingIntegration.findFirst({
        // Temporary legacy compatibility. New v2 credentials are never stored plaintext.
        where: { wordpressIntegrationKey: trimmed },
        select: {
          id: true,
          userId: true,
          businessId: true,
          platform: true,
          isActive: true,
          wordpressUrl: true,
          wordpressIntegrationKeyDigest: true,
          autoPublish: true,
          publishAs: true,
          business: { select: { id: true, isActive: true, businessWebsiteUrl: true } },
        },
      });

  if (!integration || integration.platform !== ConnectionPlatform.WORDPRESS) return null;
  if (parsed) {
    if (!integration.wordpressIntegrationKeyDigest) return null;
    const verification = verifyWordPressKeyDigest(trimmed, integration.wordpressIntegrationKeyDigest);
    if (!verification.valid) return null;
    if (verification.needsRehash && verification.currentDigest) {
      await prisma.publishingIntegration.update({
        where: { id: integration.id },
        data: { wordpressIntegrationKeyDigest: verification.currentDigest },
      });
    }
  }
  return integration;
}
