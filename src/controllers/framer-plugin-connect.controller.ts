import { ConnectionPlatform } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { encrypt } from "../utils/encryption";
import {
  getFramerHandshakeLookupId,
  verifyFramerHandshakeToken,
} from "../utils/framer-handshake-token";
import { z } from "zod";

const CONNECT_BODY = z.object({
  apiKey: z.string().trim().min(1).max(4_096),
  projectId: z.string().trim().min(1).max(512),
  collectionId: z.string().trim().min(1).max(256).optional(),
  collectionName: z.string().trim().min(1).max(256),
  businessId: z.string().uuid().optional(),
}).strict();

/**
 * POST /api/v1/framer-plugin/connect
 *
 * Plugin submits {apiKey, projectId, collectionId, collectionName} using
 * `Authorization: Bearer <exchangeCode>` as returned by /exchange.
 *
 * Behaviour:
 *  - Look up handshake row by exchangeCode; 401 if missing / expired / no userId.
 *  - If businessId was provided in the body (optional), verify it belongs to the user.
 *  - Encrypt key with context: "framer-api-key".
 *  - Upsert PublishingIntegration row with platform: FRAMER.
 *  - Delete the handshake row on success (single-use).
 */

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function framerPluginConnect(req: Request, res: Response) {
  try {
    const exchangeCode = readBearer(req);
    if (!exchangeCode) {
      return res.status(401).json({ code: "no_auth", title: "Missing session token" });
    }
    const connectLookupId = getFramerHandshakeLookupId(exchangeCode, "connect");
    const handshake = await prisma.framerPluginHandshake.findFirst({
      where: { exchangeCode: connectLookupId ?? exchangeCode },
    });
    if (!handshake || !handshake.userId) {
      return res.status(401).json({ code: "expired", title: "Session expired" });
    }
    if (handshake.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ code: "expired", title: "Session expired" });
    }
    if (
      handshake.exchangeCodeDigest &&
      !verifyFramerHandshakeToken(
        exchangeCode,
        "connect",
        handshake.exchangeCodeDigest,
      )
    ) {
      return res.status(401).json({ code: "expired", title: "Session expired" });
    }

    const parsedBody = CONNECT_BODY.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({ code: "invalid", title: "Invalid request" });
    }
    const { apiKey, projectId, collectionId, collectionName, businessId } = parsedBody.data;
    const collectionReference =
      collectionId ?? collectionName;

    const userId = handshake.userId;

    // Optional businessId — when provided, must belong to the handshake user.
    let targetBusinessId: string | null = null;
    if (businessId) {
      const biz = await prisma.business.findFirst({
        where: { id: businessId.trim(), userId, isActive: true },
        select: { id: true },
      });
      if (!biz) {
        return res.status(404).json({ code: "business_not_found", title: "Business not found" });
      }
      targetBusinessId = biz.id;
    } else {
      // Fall back to the user's first active business (matches dashboard behavior).
      const biz = await prisma.business.findFirst({
        where: { userId, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (biz) {
        targetBusinessId = biz.id;
      }
    }

    const encryptedKey = encrypt(apiKey.trim(), "framer-api-key");
    const normalizedProjectId = projectId
      .replace(/^https?:\/\/(www\.)?framer\.com\/projects\//, "")
      .split("/")[0];

    const existing = await prisma.publishingIntegration.findFirst({
      where: {
        userId,
        platform: ConnectionPlatform.FRAMER,
        businessId: targetBusinessId,
      },
    });

    // Integration write and credential consumption are one transaction. A
    // replay cannot race two connect requests into duplicate active writes.
    await prisma.$transaction(async (tx) => {
      const consumed = await tx.framerPluginHandshake.deleteMany({
        where: {
          readKey: handshake.readKey,
          exchangeCode: handshake.exchangeCode,
          expiresAt: { gt: new Date() },
        },
      });
      if (consumed.count !== 1) {
        throw new Error("Framer session already consumed");
      }

      if (existing) {
        await tx.publishingIntegration.update({
          where: { id: existing.id },
          data: {
            framerApiKey: encryptedKey,
            framerProjectId: normalizedProjectId,
            framerCollectionName: collectionReference,
            isActive: true,
            isVerified: true,
            autoPublish: true,
            publishAs: "PUBLISH",
          },
        });
      } else {
        await tx.publishingIntegration.create({
          data: {
            userId,
            businessId: targetBusinessId,
            platform: ConnectionPlatform.FRAMER,
            framerApiKey: encryptedKey,
            framerProjectId: normalizedProjectId,
            framerCollectionName: collectionReference,
            isActive: true,
            isVerified: true,
            autoPublish: true,
            publishAs: "PUBLISH",
          },
        });
      }
    });

    return res.json({
      ok: true,
      businessId: targetBusinessId,
      collectionId: collectionId ?? null,
    });
  } catch (err) {
    console.error("[Framer Plugin Connect]", err);
    return res.status(500).json({ code: "internal", title: "Connect failed" });
  }
}
