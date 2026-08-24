import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "../config/db.config";
import type { CanonicalBlogFactPacket } from "./canonical-blog-facts.service";
import {
  deduplicateRetrievedClaimEvidence,
  type RetrievedClaimEvidence,
} from "./blog-claim-evidence.service";

export interface ReusableBlogEvidence {
  firstParty: RetrievedClaimEvidence[];
  authoritative: RetrievedClaimEvidence[];
  source: "live" | "live+snapshot" | "snapshot";
  snapshotId?: string;
}

function keywordKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function evidenceHash(input: {
  packetHash: string;
  firstParty: RetrievedClaimEvidence[];
  authoritative: RetrievedClaimEvidence[];
}): string {
  const stableEvidence = (values: RetrievedClaimEvidence[]) =>
    values.map((item) => ({
      url: item.url.replace(/\/$/, "").toLowerCase(),
      excerpt: item.excerpt.replace(/\s+/g, " ").trim(),
      authority: item.authority,
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        packetHash: input.packetHash,
        firstParty: stableEvidence(input.firstParty),
        authoritative: stableEvidence(input.authoritative),
      }),
    )
    .digest("hex");
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function snapshotTtlMs(): number {
  const configured = Number.parseInt(
    process.env.BLOG_EVIDENCE_SNAPSHOT_TTL_HOURS ?? "24",
    10,
  );
  const hours = Number.isFinite(configured)
    ? Math.max(1, Math.min(configured, 24 * 30))
    : 24;
  return hours * 60 * 60 * 1000;
}

function parseEvidence(value: unknown): RetrievedClaimEvidence[] {
  if (!Array.isArray(value)) return [];
  return deduplicateRetrievedClaimEvidence(
    value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.url !== "string" ||
        typeof candidate.excerpt !== "string"
      ) {
        return [];
      }
      return [{
        url: candidate.url,
        title: typeof candidate.title === "string" ? candidate.title : null,
        excerpt: candidate.excerpt,
        retrievedAt:
          typeof candidate.retrievedAt === "string"
            ? candidate.retrievedAt
            : new Date(0).toISOString(),
        authority:
          candidate.authority === "authoritative_external"
            ? "authoritative_external" as const
            : "owned_website" as const,
        relevanceScore:
          typeof candidate.relevanceScore === "number"
            ? candidate.relevanceScore
            : undefined,
      }];
    }),
  );
}

export async function loadReusableBlogEvidence(input: {
  businessId: string;
  keyword: string;
  packetHash: string;
}): Promise<(ReusableBlogEvidence & { source: "snapshot" }) | null> {
  try {
    const snapshot = await prisma.blogEvidenceSnapshot.findFirst({
      where: {
        businessId: input.businessId,
        keywordKey: keywordKey(input.keyword),
        packetHash: input.packetHash,
        status: "READY",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!snapshot) return null;
    return {
      firstParty: parseEvidence(snapshot.firstPartyEvidence),
      authoritative: parseEvidence(snapshot.authoritativeEvidence),
      source: "snapshot",
      snapshotId: snapshot.id,
    };
  } catch (error) {
    console.warn(
      "Blog evidence snapshot lookup unavailable; continuing with live evidence:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function mergeWithReusableBlogEvidence(input: {
  businessId: string;
  keyword: string;
  packetHash: string;
  firstParty: RetrievedClaimEvidence[];
  authoritative: RetrievedClaimEvidence[];
}): Promise<ReusableBlogEvidence> {
  const liveFirstParty = deduplicateRetrievedClaimEvidence(input.firstParty);
  const liveAuthoritative = deduplicateRetrievedClaimEvidence(
    input.authoritative,
  );
  if (liveFirstParty.length >= 3 && liveAuthoritative.length > 0) {
    return {
      firstParty: liveFirstParty,
      authoritative: liveAuthoritative,
      source: "live",
    };
  }
  const snapshot = await loadReusableBlogEvidence(input);
  if (!snapshot) {
    return {
      firstParty: liveFirstParty,
      authoritative: liveAuthoritative,
      source: "live",
    };
  }
  const firstParty = deduplicateRetrievedClaimEvidence([
    ...liveFirstParty,
    ...snapshot.firstParty,
  ]);
  const authoritative = deduplicateRetrievedClaimEvidence([
    ...liveAuthoritative,
    ...snapshot.authoritative,
  ]);
  return {
    firstParty,
    authoritative,
    source:
      liveFirstParty.length > 0 || liveAuthoritative.length > 0
        ? "live+snapshot"
        : "snapshot",
    snapshotId: snapshot.snapshotId,
  };
}

export async function persistBlogEvidenceSnapshot(input: {
  businessId: string;
  keyword: string;
  packet: CanonicalBlogFactPacket;
  profilePacketHash?: string;
  firstParty: RetrievedClaimEvidence[];
  authoritative: RetrievedClaimEvidence[];
}): Promise<string | null> {
  const firstParty = deduplicateRetrievedClaimEvidence(input.firstParty);
  const authoritative = deduplicateRetrievedClaimEvidence(input.authoritative);
  if (firstParty.length === 0 && authoritative.length === 0) return null;
  const hash = evidenceHash({
    packetHash: input.profilePacketHash ?? input.packet.packetHash,
    firstParty,
    authoritative,
  });
  const sourceUrls = [
    ...new Set(
      [...firstParty, ...authoritative].map((entry) =>
        entry.url.replace(/\/$/, ""),
      ),
    ),
  ];
  try {
    const snapshot = await prisma.blogEvidenceSnapshot.upsert({
      where: {
        businessId_keywordKey_evidenceHash: {
          businessId: input.businessId,
          keywordKey: keywordKey(input.keyword),
          evidenceHash: hash,
        },
      },
      create: {
        businessId: input.businessId,
        keyword: input.keyword,
        keywordKey: keywordKey(input.keyword),
        websiteUrl: input.packet.identity.website,
        packetVersion: input.packet.version,
        packetHash: input.profilePacketHash ?? input.packet.packetHash,
        evidenceHash: hash,
        firstPartyEvidence: json(firstParty),
        authoritativeEvidence: json(authoritative),
        claimIds: input.packet.claims.map((claim) => claim.id),
        sourceUrls,
        counts: json({
          firstPartyPassages: firstParty.length,
          authoritativePassages: authoritative.length,
          claims: input.packet.claims.length,
        }),
        expiresAt: new Date(Date.now() + snapshotTtlMs()),
      },
      update: {
        keyword: input.keyword,
        websiteUrl: input.packet.identity.website,
        packetVersion: input.packet.version,
        packetHash: input.profilePacketHash ?? input.packet.packetHash,
        status: "READY",
        firstPartyEvidence: json(firstParty),
        authoritativeEvidence: json(authoritative),
        claimIds: input.packet.claims.map((claim) => claim.id),
        sourceUrls,
        counts: json({
          firstPartyPassages: firstParty.length,
          authoritativePassages: authoritative.length,
          claims: input.packet.claims.length,
        }),
        expiresAt: new Date(Date.now() + snapshotTtlMs()),
      },
    });
    return snapshot.id;
  } catch (error) {
    console.warn(
      "Blog evidence snapshot persistence unavailable; generation will continue:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
