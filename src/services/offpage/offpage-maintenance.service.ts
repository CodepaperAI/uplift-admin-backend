/**
 * offpage-maintenance.service.ts
 *
 * Scheduled maintenance helpers for off-page research. The cron only enqueues
 * the existing generation event; it does not run live Reddit/directory work
 * inline. Selection is conservative and capped so production cannot stampede.
 */

import { prisma } from "../../config/db.config";
import type {
  DirectoryPricingModel,
  DirectorySubmissionType,
  OffPageEvidenceSource,
  OffPageSourceType,
  OpportunityConfidenceLevel,
} from "./offpage-types";

export type OffPageRefreshReason =
  | "expired"
  | "legacy_v2_metadata"
  | "expired_and_legacy_v2_metadata";

export interface OffPageRefreshCandidate {
  businessId: string;
  userId: string;
  businessName: string | null;
  generatedAt: string;
  expiresAt: string;
  reason: OffPageRefreshReason;
}

type CacheRowLike = {
  businessId: string;
  generatedAt: Date;
  expiresAt: Date;
  payload: unknown;
};

type BusinessLike = {
  id: string;
  userId: string;
  businessName: string | null;
  isActive: boolean | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function opportunitiesFromPayload(payload: unknown): unknown[] {
  const opportunities = asRecord(payload).opportunities;
  return Array.isArray(opportunities) ? opportunities : [];
}

const VALID_CONFIDENCE_LEVELS = new Set<OpportunityConfidenceLevel>([
  "high",
  "medium",
  "needs_review",
  "low",
]);
const VALID_SOURCE_TYPES = new Set<OffPageSourceType>([
  "reddit_thread",
  "business_profile",
  "review_platform",
  "marketplace",
  "directory",
  "manual_play",
]);
const VALID_EVIDENCE_SOURCES = new Set<OffPageEvidenceSource>([
  "ai_research",
  "baseline_seed",
  "live_search",
  "thread_page",
  "directory_reachability",
  "directory_page_scan",
  "known_submission_map",
  "already_listed_search",
  "strict_reviewer",
]);
const VALID_DIRECTORY_SUBMISSION_TYPES = new Set<DirectorySubmissionType>([
  "direct_claim",
  "add_business",
  "homepage",
  "unknown",
]);
const ACTIONABLE_DIRECTORY_SUBMISSION_TYPES = new Set<DirectorySubmissionType>([
  "direct_claim",
  "add_business",
]);
const VALID_DIRECTORY_PRICING_MODELS = new Set<DirectoryPricingModel>([
  "free",
  "freemium",
  "paid",
  "unknown",
]);

function isValidIsoDateString(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(new Date(value).getTime());
}

function isHttpUrlString(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRedditThreadUrlString(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      /(^|\.)reddit\.com$/i.test(url.hostname) &&
      /\/r\/[^/]+\/comments\/[^/]+/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function hasV2RedditMetadata(record: Record<string, unknown>): boolean {
  const threads = Array.isArray(record.threads) ? record.threads : [];
  return (
    isRedditThreadUrlString(record.url) &&
    threads.length > 0 &&
    threads.every((thread) => {
      const threadRecord = asRecord(thread);
      return (
        isRedditThreadUrlString(threadRecord.url) &&
        isValidIsoDateString(threadRecord.detailCheckedAt) &&
        threadRecord.locked !== true &&
        threadRecord.archived !== true &&
        threadRecord.deleted !== true &&
        threadRecord.unavailable !== true
      );
    })
  );
}

function hasV2DirectoryMetadata(record: Record<string, unknown>): boolean {
  return (
    isHttpUrlString(record.url) &&
    isHttpUrlString(record.submissionUrl) &&
    typeof record.submissionUrlType === "string" &&
    VALID_DIRECTORY_SUBMISSION_TYPES.has(
      record.submissionUrlType as DirectorySubmissionType,
    ) &&
    ACTIONABLE_DIRECTORY_SUBMISSION_TYPES.has(
      record.submissionUrlType as DirectorySubmissionType,
    ) &&
    typeof record.pricingModel === "string" &&
    VALID_DIRECTORY_PRICING_MODELS.has(record.pricingModel as DirectoryPricingModel)
  );
}

function payloadHasV2QualitySummary(payload: unknown): boolean {
  const summary = asRecord(asRecord(payload).qualitySummary);
  const averageConfidence = summary.averageConfidence;
  const evidenceSourceCounts = asRecord(summary.evidenceSourceCounts);
  return (
    typeof summary.totalCandidates === "number" &&
    typeof summary.shown === "number" &&
    typeof summary.hiddenLowConfidence === "number" &&
    typeof summary.rejected === "number" &&
    (averageConfidence === null || typeof averageConfidence === "number") &&
    typeof summary.highConfidence === "number" &&
    typeof summary.mediumConfidence === "number" &&
    typeof summary.needsReview === "number" &&
    typeof summary.lowConfidence === "number" &&
    Object.keys(asRecord(summary.byLever)).length > 0 &&
    Object.keys(asRecord(summary.byConfidenceLevel)).length > 0 &&
    Object.keys(asRecord(summary.bySourceType)).length > 0 &&
    Object.keys(evidenceSourceCounts).length > 0 &&
    summary.rejectionReasons !== null &&
    typeof summary.rejectionReasons === "object" &&
    !Array.isArray(summary.rejectionReasons)
  );
}

export function opportunityHasV2QualityMetadata(opportunity: unknown): boolean {
  const record = asRecord(opportunity);
  const leverKey = record.leverKey;
  if (leverKey !== "reddit" && leverKey !== "directory") return true;
  const confidence = record.confidence;
  const evidenceSources = record.evidenceSources;
  return (
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 100 &&
    typeof record.confidenceLevel === "string" &&
    VALID_CONFIDENCE_LEVELS.has(record.confidenceLevel as OpportunityConfidenceLevel) &&
    typeof record.sourceType === "string" &&
    VALID_SOURCE_TYPES.has(record.sourceType as OffPageSourceType) &&
    Array.isArray(evidenceSources) &&
    evidenceSources.length > 0 &&
    evidenceSources.every(
      (source) =>
        typeof source === "string" &&
        VALID_EVIDENCE_SOURCES.has(source as OffPageEvidenceSource),
    ) &&
    typeof record.whyRecommended === "string" &&
    record.whyRecommended.trim().length > 0 &&
    isValidIsoDateString(record.lastCheckedAt) &&
    Array.isArray(record.qualitySignals) &&
    Array.isArray(record.qualityWarnings) &&
    (leverKey !== "reddit" || hasV2RedditMetadata(record)) &&
    (leverKey !== "directory" || hasV2DirectoryMetadata(record))
  );
}

export function cacheNeedsV2Refresh(payload: unknown): boolean {
  const opportunities = opportunitiesFromPayload(payload);
  if (opportunities.length === 0) return false;
  if (!payloadHasV2QualitySummary(payload)) return true;
  return opportunities.some((opportunity) => !opportunityHasV2QualityMetadata(opportunity));
}

export function classifyOffPageRefreshReason(
  row: Pick<CacheRowLike, "expiresAt" | "payload">,
  now = new Date(),
): OffPageRefreshReason | null {
  const expired = row.expiresAt.getTime() <= now.getTime();
  const legacy = cacheNeedsV2Refresh(row.payload);
  if (expired && legacy) return "expired_and_legacy_v2_metadata";
  if (expired) return "expired";
  if (legacy) return "legacy_v2_metadata";
  return null;
}

export function selectOffPageRefreshCandidates(
  rows: CacheRowLike[],
  businesses: BusinessLike[],
  options?: { now?: Date; limit?: number; includeInactive?: boolean },
): OffPageRefreshCandidate[] {
  const now = options?.now ?? new Date();
  const limit = Math.max(1, Math.min(options?.limit ?? 10, 100));
  const businessById = new Map(businesses.map((business) => [business.id, business]));

  return rows
    .map((row) => {
      const business = businessById.get(row.businessId);
      if (!business?.userId) return null;
      if (!options?.includeInactive && business.isActive === false) return null;
      const reason = classifyOffPageRefreshReason(row, now);
      if (!reason) return null;
      return {
        businessId: row.businessId,
        userId: business.userId,
        businessName: business.businessName ?? null,
        generatedAt: row.generatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        reason,
      } satisfies OffPageRefreshCandidate;
    })
    .filter((candidate): candidate is OffPageRefreshCandidate => candidate !== null)
    .sort((a, b) => {
      const reasonPriority = (reason: OffPageRefreshReason) =>
        reason === "expired_and_legacy_v2_metadata"
          ? 0
          : reason === "expired"
            ? 1
            : 2;
      return (
        reasonPriority(a.reason) - reasonPriority(b.reason) ||
        new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()
      );
    })
    .slice(0, limit);
}

function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

export async function getOffPageRefreshCandidates(options?: {
  now?: Date;
  batchLimit?: number;
  scanLimit?: number;
}): Promise<OffPageRefreshCandidate[]> {
  const now = options?.now ?? new Date();
  const batchLimit =
    options?.batchLimit ?? readPositiveIntEnv("OFFPAGE_REFRESH_BATCH_LIMIT", 10, 100);
  const scanLimit =
    options?.scanLimit ?? readPositiveIntEnv("OFFPAGE_REFRESH_SCAN_LIMIT", 200, 1000);

  const [expiredRows, recentRows] = await Promise.all([
    prisma.offPageResearchCache.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { generatedAt: "asc" }],
      take: scanLimit,
      select: {
        businessId: true,
        generatedAt: true,
        expiresAt: true,
        payload: true,
      },
    }),
    prisma.offPageResearchCache.findMany({
      orderBy: [{ generatedAt: "desc" }],
      take: scanLimit,
      select: {
        businessId: true,
        generatedAt: true,
        expiresAt: true,
        payload: true,
      },
    }),
  ]);

  const rowByBusinessId = new Map<string, CacheRowLike>();
  for (const row of [...expiredRows, ...recentRows]) {
    if (!rowByBusinessId.has(row.businessId)) {
      rowByBusinessId.set(row.businessId, row);
    }
  }
  const rows = Array.from(rowByBusinessId.values());
  if (rows.length === 0) return [];

  const businesses = await prisma.business.findMany({
    where: { id: { in: rows.map((row) => row.businessId) } },
    select: {
      id: true,
      userId: true,
      businessName: true,
      isActive: true,
    },
  });

  return selectOffPageRefreshCandidates(rows, businesses, {
    now,
    limit: batchLimit,
  });
}
