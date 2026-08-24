import crypto from "node:crypto";

const TOKEN_PREFIX = "frh_v2";
const MIN_SECRET_BYTES = 32;
const TOKEN_SECRET_BYTES = 32;

type FramerHandshakePurpose = "read" | "exchange" | "connect";

function getSecret(): string {
  return (
    process.env.FRAMER_HANDSHAKE_HMAC_SECRET ??
    process.env.API_TOKEN_HMAC_SECRET ??
    ""
  ).trim();
}

function requireSecret(): string {
  const secret = getSecret();
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error("Framer handshake signing is unavailable");
  }
  return secret;
}

function parseToken(
  token: string,
  expectedPurpose: FramerHandshakePurpose,
): { id: string; secret: string } | null {
  const parts = token.trim().split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== TOKEN_PREFIX ||
    parts[1] !== expectedPurpose ||
    !/^[0-9a-f]{32}$/i.test(parts[2] ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")
  ) {
    return null;
  }
  return { id: parts[2]!, secret: parts[3]! };
}

function digest(
  purpose: FramerHandshakePurpose,
  id: string,
  tokenSecret: string,
): string {
  return crypto
    .createHmac("sha256", requireSecret())
    .update(`framer-handshake\0v2\0${purpose}\0${id}\0${tokenSecret}`)
    .digest("hex");
}

export function getFramerHandshakeTokenDigest(
  token: string,
  purpose: FramerHandshakePurpose,
): string | null {
  const parsed = parseToken(token, purpose);
  return parsed ? digest(purpose, parsed.id, parsed.secret) : null;
}

export function createFramerHandshakeToken(
  purpose: FramerHandshakePurpose,
): { token: string; id: string; digest: string } {
  const id = crypto.randomBytes(16).toString("hex");
  const tokenSecret = crypto.randomBytes(TOKEN_SECRET_BYTES).toString("base64url");
  return {
    token: `${TOKEN_PREFIX}.${purpose}.${id}.${tokenSecret}`,
    id,
    digest: digest(purpose, id, tokenSecret),
  };
}

export function getFramerHandshakeLookupId(
  token: string,
  purpose: FramerHandshakePurpose,
): string | null {
  return parseToken(token, purpose)?.id ?? null;
}

export function verifyFramerHandshakeToken(
  token: string,
  purpose: FramerHandshakePurpose,
  storedDigest: string | null | undefined,
): boolean {
  if (!storedDigest || !/^[0-9a-f]{64}$/i.test(storedDigest)) return false;
  const tokenDigest = getFramerHandshakeTokenDigest(token, purpose);
  if (!tokenDigest) return false;
  const expected = Buffer.from(tokenDigest, "hex");
  const actual = Buffer.from(storedDigest, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
