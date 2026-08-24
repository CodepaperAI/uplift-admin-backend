/**
 * offpage-cache.service.ts
 *
 * Persists the validated + live-enriched opportunity set per business so the
 * expensive multi-agent + live-scraping pipeline runs once, not on every page
 * load. Keyed by businessId with an inputHash fingerprint of the business inputs
 * (so a changed profile invalidates the cache) and a TTL. All calls fail soft.
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.config";
import type {
  BusinessResearchBrief,
  OffPageResearchStrategy,
  OffPageQualitySummary,
  Opportunity,
} from "./offpage-types";

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Fingerprint the business inputs that drive research, so changes bust the cache. */
export function computeInputHash(brief: BusinessResearchBrief): string {
  const basis = JSON.stringify({
    name: brief.businessName,
    category: brief.category,
    services: brief.services,
    keywords: brief.keywords,
    location: brief.location,
    audience: brief.targetAudience,
    differentiators: brief.differentiators,
    painPoints: brief.painPoints,
    competitors: brief.competitors.map((c) => c.name),
    model: brief.businessModelType,
    scope: brief.scope,
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
}

export interface CachedResearch {
  opportunities: Opportunity[];
  appliedLevers: string[];
  generatedAt: string;
  strategy?: OffPageResearchStrategy;
  qualitySummary?: OffPageQualitySummary;
  rejectedOpportunities?: Array<{
    key: string;
    leverKey: string;
    title: string;
    reason: string;
    score: number;
  }>;
}

/** Read the cache; returns null on miss, stale (inputHash changed), or expired. */
export async function readResearchCache(
  businessId: string,
  inputHash: string,
): Promise<CachedResearch | null> {
  try {
    const row = await prisma.offPageResearchCache.findUnique({
      where: { businessId },
    });
    if (!row || row.inputHash !== inputHash) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    const payload = row.payload as unknown as CachedResearch;
    if (!payload || !Array.isArray(payload.opportunities)) return null;
    return payload;
  } catch (err) {
    console.warn("[offpage/cache] read failed:", (err as Error).message);
    return null;
  }
}

export interface ResearchCacheRow {
  payload: CachedResearch;
  inputHash: string;
  expiresAt: Date;
}

/**
 * Read the raw cache row regardless of freshness (so callers can show stale
 * results while a background regeneration runs). Returns null on miss.
 */
export async function readResearchCacheRow(
  businessId: string,
): Promise<ResearchCacheRow | null> {
  try {
    const row = await prisma.offPageResearchCache.findUnique({
      where: { businessId },
    });
    if (!row) return null;
    const payload = row.payload as unknown as CachedResearch;
    if (!payload || !Array.isArray(payload.opportunities)) return null;
    return { payload, inputHash: row.inputHash, expiresAt: row.expiresAt };
  } catch (err) {
    console.warn("[offpage/cache] row read failed:", (err as Error).message);
    return null;
  }
}

export async function writeResearchCache(
  businessId: string,
  inputHash: string,
  data: CachedResearch,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    const payload = data as unknown as Prisma.InputJsonValue;
    await prisma.offPageResearchCache.upsert({
      where: { businessId },
      create: { businessId, inputHash, payload, expiresAt },
      update: { inputHash, payload, expiresAt, generatedAt: new Date() },
    });
  } catch (err) {
    console.warn("[offpage/cache] write failed:", (err as Error).message);
  }
}
