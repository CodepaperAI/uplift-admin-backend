import crypto from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { cleanupExpiredFramerPluginHandshakes } from "../services/framer-plugin-handshake-cleanup.service";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  createFramerHandshakeToken,
  getFramerHandshakeLookupId,
  getFramerHandshakeTokenDigest,
  verifyFramerHandshakeToken,
} from "../utils/framer-handshake-token";
import { decrypt, encrypt } from "../utils/encryption";
import { z } from "zod";

const EXCHANGE_CODE_ENCRYPTION_CONTEXT = "framer-handshake-exchange";
const FRAMER_CREDENTIAL = z.string().min(1).max(256);
const AUTHORIZE_BODY = z.object({
  pluginNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
}).strict();
const HANDSHAKE_BODY = z.object({ readKey: FRAMER_CREDENTIAL }).strict();
const EXCHANGE_BODY = z.object({ exchangeCode: FRAMER_CREDENTIAL }).strict();

/**
 * Implements Framer's documented OAuth poll pattern:
 *   POST /authorize  → { url, readKey }
 *   POST /poll?readKey=...  → 204 while waiting, 200 + { exchangeCode } when ready
 *
 * Ref: https://www.framer.com/developers/oauth
 *
 * The plugin also sends X-Plugin-Nonce on every poll so we can verify the poller
 * is the same plugin instance that started the /authorize flow (defeats replay).
 */

const READKEY_TTL_MS = 10 * 60 * 1000; // 10 min — Framer's recommended upper bound

function hashNonce(nonce: string): string {
  return crypto.createHash("sha256").update(nonce).digest("hex");
}

function appUrl(): string {
  return (
    process.env.FRONTEND_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://upliftai.co"
  );
}

/** POST /api/public/v1/framer-plugin/authorize */
export async function framerPluginAuthorize(req: Request, res: Response) {
  try {
    const parsed = AUTHORIZE_BODY.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ code: "invalid_nonce", title: "Missing or malformed pluginNonce" });
    }
    const { pluginNonce } = parsed.data;

    const readCredential = createFramerHandshakeToken("read");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + READKEY_TTL_MS);

    // Demand-driven TTL cleanup replaces the noisy ten-minute Inngest cron.
    // Keep authorization available if cleanup itself encounters a transient
    // database problem; the new handshake can still be created safely.
    try {
      await cleanupExpiredFramerPluginHandshakes(prisma, now);
    } catch (cleanupError) {
      console.warn("[Framer Plugin Handshake Cleanup]", cleanupError);
    }

    await prisma.framerPluginHandshake.create({
      data: {
        readKey: readCredential.id,
        readKeyDigest: readCredential.digest,
        pluginNonceHash: hashNonce(pluginNonce),
        createdAt: now,
        expiresAt,
      },
    });

    const url = `${appUrl()}/sign-up?from=framer-plugin&read_key=${encodeURIComponent(readCredential.token)}`;

    return res.json({ url, readKey: readCredential.token });
  } catch (err) {
    console.error("[Framer Plugin Authorize]", err);
    return res.status(500).json({ code: "internal", title: "Could not start signup flow" });
  }
}

/** POST /api/public/v1/framer-plugin/poll?readKey=... */
export async function framerPluginPoll(req: Request, res: Response) {
  try {
    const readKeyResult = FRAMER_CREDENTIAL.safeParse(req.query.readKey);
    const readKey = readKeyResult.success ? readKeyResult.data.trim() : "";
    const nonceHeader = req.headers["x-plugin-nonce"];
    const pluginNonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;

    if (!readKey || typeof readKey !== "string") {
      return res.status(400).json({ code: "missing_readkey", title: "readKey is required" });
    }
    if (
      !pluginNonce ||
      typeof pluginNonce !== "string" ||
      !/^[a-f0-9]{32,128}$/.test(pluginNonce)
    ) {
      return res.status(400).json({ code: "missing_nonce", title: "X-Plugin-Nonce header required" });
    }

    const lookupId = getFramerHandshakeLookupId(readKey, "read") ?? readKey;
    const row = await prisma.framerPluginHandshake.findUnique({
      where: { readKey: lookupId },
    });
    if (!row) {
      return res.status(410).json({ code: "expired", title: "This signup session has expired" });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ code: "expired", title: "This signup session has expired" });
    }
    if (
      row.readKeyDigest &&
      !verifyFramerHandshakeToken(readKey, "read", row.readKeyDigest)
    ) {
      return res.status(410).json({ code: "expired", title: "This signup session has expired" });
    }
    if (row.pluginNonceHash !== hashNonce(pluginNonce)) {
      return res.status(401).json({ code: "nonce_mismatch", title: "Plugin nonce mismatch" });
    }

    // Still waiting for user to complete signup.
    if (!row.exchangeCode || !row.userId) {
      return res.status(204).end();
    }

    // New credentials are encrypted at rest and authenticated separately with
    // an HMAC digest. A legacy in-flight row has no digest and remains usable
    // only until its short expiry.
    const exchangeCode = row.exchangeCodeDigest
      ? decrypt(row.exchangeCode, EXCHANGE_CODE_ENCRYPTION_CONTEXT)
      : row.exchangeCode;
    if (
      row.exchangeCodeDigest &&
      !verifyFramerHandshakeToken(
        exchangeCode,
        "exchange",
        row.exchangeCodeDigest,
      )
    ) {
      return res.status(410).json({ code: "expired", title: "This signup session has expired" });
    }
    return res.json({ exchangeCode });
  } catch (err) {
    console.error("[Framer Plugin Poll]", err);
    return res.status(500).json({ code: "internal", title: "Poll failed" });
  }
}

/**
 * POST /api/v1/framer-plugin/handshake
 *
 * Called by the Uplift sign-up page (seo-fe) after a user completes signup from
 * the `?from=framer-plugin&read_key=...` query. The frontend calls its local
 * Next.js route first; that route signs the request with BACKEND_AUTH_SECRET.
 *
 * The Next.js page POSTs { readKey } and this controller writes the
 * exchangeCode back to the handshake row so the polling plugin can pick it up.
 */
export async function framerPluginHandshakeStore(req: AuthenticatedRequest, res: Response) {
  try {
    const parsed = HANDSHAKE_BODY.safeParse(req.body ?? {});
    const readKey = parsed.success ? parsed.data.readKey : null;
    const userId = req.authUserId;

    if (!readKey) {
      return res.status(400).json({ code: "missing_readkey", title: "readKey is required" });
    }
    if (typeof userId !== "string" || !userId.trim()) {
      return res.status(401).json({ code: "unauthorized", title: "Authenticated user is required" });
    }

    const suppliedReadKey = readKey.trim();
    const lookupId =
      getFramerHandshakeLookupId(suppliedReadKey, "read") ?? suppliedReadKey;
    const row = await prisma.framerPluginHandshake.findUnique({
      where: { readKey: lookupId },
    });
    if (!row) {
      return res.status(410).json({ code: "expired", title: "Signup session expired" });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ code: "expired", title: "Signup session expired" });
    }
    if (
      row.readKeyDigest &&
      !verifyFramerHandshakeToken(suppliedReadKey, "read", row.readKeyDigest)
    ) {
      return res.status(410).json({ code: "expired", title: "Signup session expired" });
    }
    if (row.userId && row.userId !== userId) {
      return res.status(410).json({ code: "expired", title: "Signup session expired" });
    }

    // Verify user exists in DB (tolerate shapes from better-auth)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      return res.status(404).json({ code: "user_not_found", title: "User not found" });
    }

    const exchangeCredential = createFramerHandshakeToken("exchange");
    // Extend TTL by 15 minutes from completion so the plugin has time to call /connect.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const claimed = await prisma.framerPluginHandshake.updateMany({
      where: {
        readKey: row.readKey,
        OR: [{ userId: null }, { userId: user.id }],
        expiresAt: { gt: new Date() },
      },
      data: {
        exchangeCode: encrypt(
          exchangeCredential.token,
          EXCHANGE_CODE_ENCRYPTION_CONTEXT,
        ),
        exchangeCodeDigest: exchangeCredential.digest,
        userId: user.id,
        expiresAt,
      },
    });
    if (claimed.count !== 1) {
      return res.status(410).json({ code: "expired", title: "Signup session expired" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[Framer Plugin Handshake Store]", err);
    return res.status(500).json({ code: "internal", title: "Handshake failed" });
  }
}

/**
 * POST /api/public/v1/framer-plugin/exchange
 *
 * Plugin trades an exchangeCode for a sessionToken it can use to authenticate
 * the subsequent /connect call. In v1 we return the exchangeCode itself as the
 * sessionToken — the row isn't deleted here, so /connect can still look it up.
 * Keeping a separate /exchange call makes future JWT/swap cleaner.
 */
export async function framerPluginExchange(req: Request, res: Response) {
  try {
    const parsed = EXCHANGE_BODY.safeParse(req.body ?? {});
    const exchangeCode = parsed.success ? parsed.data.exchangeCode : null;
    if (!exchangeCode) {
      return res.status(400).json({ code: "missing_code", title: "exchangeCode required" });
    }

    const suppliedExchangeCode = exchangeCode.trim();
    const exchangeDigest = getFramerHandshakeTokenDigest(
      suppliedExchangeCode,
      "exchange",
    );
    const row = exchangeDigest
      ? await prisma.framerPluginHandshake.findFirst({
          where: { exchangeCodeDigest: exchangeDigest },
        })
      : await prisma.framerPluginHandshake.findFirst({
          where: { exchangeCode: suppliedExchangeCode },
        });
    if (!row || !row.userId) {
      return res.status(410).json({ code: "expired", title: "Session expired" });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ code: "expired", title: "Session expired" });
    }

    if (
      row.exchangeCodeDigest &&
      !verifyFramerHandshakeToken(
        suppliedExchangeCode,
        "exchange",
        row.exchangeCodeDigest,
      )
    ) {
      return res.status(410).json({ code: "expired", title: "Session expired" });
    }

    const connectCredential = createFramerHandshakeToken("connect");
    await prisma.framerPluginHandshake.update({
      where: { readKey: row.readKey },
      data: {
        exchangeCode: connectCredential.id,
        exchangeCodeDigest: connectCredential.digest,
      },
    });

    return res.json({ sessionToken: connectCredential.token });
  } catch (err) {
    console.error("[Framer Plugin Exchange]", err);
    return res.status(500).json({ code: "internal", title: "Exchange failed" });
  }
}
