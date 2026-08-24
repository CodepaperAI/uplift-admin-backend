import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;
const CAMPAIGN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getSecret(): string {
  return process.env.OUTREACH_UNSUBSCRIBE_SECRET?.trim() ?? "";
}

function digest(campaignId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`dr-unsubscribe:v1:${campaignId}`)
    .digest("base64url");
}

export function createOutreachUnsubscribeToken(campaignId: string): string {
  const secret = getSecret();
  if (
    Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES ||
    !CAMPAIGN_ID_PATTERN.test(campaignId)
  ) {
    throw new Error("Outreach unsubscribe signing is unavailable");
  }
  return `${campaignId}.${digest(campaignId, secret)}`;
}

export function verifyOutreachUnsubscribeToken(token: unknown): string | null {
  const secret = getSecret();
  if (
    Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES ||
    typeof token !== "string" ||
    token.length > 256
  ) {
    return null;
  }
  const parts = token.split(".");
  const campaignId = parts[0];
  const suppliedDigest = parts[1];
  if (
    parts.length !== 2 ||
    !campaignId ||
    !CAMPAIGN_ID_PATTERN.test(campaignId) ||
    !suppliedDigest
  ) {
    return null;
  }
  const expected = Buffer.from(digest(campaignId, secret));
  const supplied = Buffer.from(suppliedDigest);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return null;
  }
  return campaignId;
}
