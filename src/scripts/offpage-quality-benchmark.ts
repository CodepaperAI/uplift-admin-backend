import { createPrismaClient } from "../config/prisma-client.factory";
/**
 * offpage-quality-benchmark.ts
 *
 * Builds the 20-business Off-Page Quality V2 manual QA sample from cached
 * opportunities. Use after V2 cache regeneration, then fill manualScore values
 * and run offpage:qa:summary.
 *
 * Usage:
 *   OFFPAGE_QA_LIMIT=20 OFFPAGE_QA_OUTPUT=/private/tmp/offpage-quality-benchmark-20.json bun --env-file=.env.production run offpage:qa:benchmark
 */

import {
  PrismaClient,
  type PrismaClient as PrismaClientType,
} from "@prisma/client";
import { writeFile } from "node:fs/promises";
import {
  MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
  REQUIRED_OFFPAGE_QA_LEVERS,
  REQUIRED_OFFPAGE_QA_SEGMENTS,
  classifyOffPageQaBusinessSegment,
  selectStratifiedOffPageBenchmarkRows,
  summarizeBusinessSegments,
  type OffPageQaBusinessSegment,
  type OffPageQaLever,
} from "../services/offpage/offpage-qa.service";
import { sanitizeRedditDraft } from "../llm/offpage/reddit-draft-safety";

const LIMIT = Number(process.env.OFFPAGE_QA_LIMIT || "20");
const SCAN_LIMIT = Number(process.env.OFFPAGE_QA_SCAN_LIMIT || Math.max(100, LIMIT * 5));
const OUTPUT = process.env.OFFPAGE_QA_OUTPUT || "";
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_OFFPAGE_QA_LAST_CHECKED_AGE_DAYS = 14;

export type OffPageQualityBucket =
  | "good"
  | "okay"
  | "needs_review"
  | "bad"
  | "needs_refresh";

export type CachedOpportunity = {
  leverKey?: string;
  key?: string;
  title?: string;
  url?: string;
  confidence?: number;
  confidenceLevel?: string;
  whyRecommended?: string;
  sourceType?: string;
  evidenceSources?: string[];
  source?: string;
  validatorReason?: string;
  lastCheckedAt?: string;
  qualitySignals?: string[];
  qualityWarnings?: string[];
  draft?: string | null;
  threadTitle?: string | null;
  threads?: Array<{
    url?: string;
    title?: string;
    draft?: string | null;
    ageDays?: number | null;
    commentCount?: number | null;
    locked?: boolean;
    archived?: boolean;
    deleted?: boolean;
    unavailable?: boolean;
    detailCheckedAt?: string | null;
    qualityScore?: number;
    qualityWarnings?: string[];
  }>;
  submissionUrl?: string;
  submissionUrlType?: string;
  pricingModel?: string;
};

export type BenchmarkReviewSummaryInput = {
  automatedBucket: OffPageQualityBucket;
  criticalFlags?: string[];
  leverKey?: string | null;
};

export type BenchmarkReviewTotals = ReturnType<typeof summarizeBenchmarkReviewItems>;

export type BenchmarkPreManualGateOptions = {
  requiredLevers?: OffPageQaLever[];
  requiredSegments?: OffPageQaBusinessSegment[];
  businessSegments?: Record<OffPageQaBusinessSegment, number> | null;
  benchmarkBusinesses?: number | null;
  minimumBusinesses?: number | null;
  minimumReviewItemsPerRequiredLever?: number | null;
};

export function benchmarkPreManualGate(
  totals: BenchmarkReviewTotals,
  options: BenchmarkPreManualGateOptions = {},
) {
  const failures: string[] = [];
  const requiredLevers = options.requiredLevers ?? [];
  const requiredSegments = options.requiredSegments ?? [];
  const businessSegments = options.businessSegments ?? null;
  const benchmarkBusinesses =
    typeof options.benchmarkBusinesses === "number"
      ? options.benchmarkBusinesses
      : null;
  const minimumBusinesses =
    typeof options.minimumBusinesses === "number" ? options.minimumBusinesses : null;
  const minimumReviewItemsPerRequiredLever =
    typeof options.minimumReviewItemsPerRequiredLever === "number"
      ? options.minimumReviewItemsPerRequiredLever
      : null;
  const missingRequiredLevers = requiredLevers.filter((lever) =>
    lever === "reddit" ? totals.reddit <= 0 : totals.directory <= 0,
  );
  const missingRequiredSegments = requiredSegments.filter(
    (segment) => (businessSegments?.[segment] ?? 0) <= 0,
  );
  const shallowRequiredLevers =
    minimumReviewItemsPerRequiredLever === null
      ? []
      : requiredLevers.filter((lever) => {
          const count = lever === "reddit" ? totals.reddit : totals.directory;
          return count > 0 && count < minimumReviewItemsPerRequiredLever;
        });
  if (
    minimumBusinesses !== null &&
    benchmarkBusinesses !== null &&
    benchmarkBusinesses < minimumBusinesses
  ) {
    failures.push(
      `${benchmarkBusinesses} benchmark businesses is below required ${minimumBusinesses}`,
    );
  }
  if (minimumBusinesses !== null && benchmarkBusinesses === null) {
    failures.push("Benchmark business count is missing");
  }
  if (totals.total === 0) failures.push("No review items found");
  if (totals.needs_refresh > 0) {
    failures.push(`${totals.needs_refresh} review items still need V2 refresh`);
  }
  if (totals.withCriticalFlags > 0) {
    failures.push(`${totals.withCriticalFlags} review items have automated critical flags`);
  }
  if (missingRequiredLevers.length > 0) {
    failures.push(`Missing required benchmark levers: ${missingRequiredLevers.join(", ")}`);
  }
  if (missingRequiredSegments.length > 0) {
    failures.push(`Missing required benchmark segments: ${missingRequiredSegments.join(", ")}`);
  }
  for (const lever of shallowRequiredLevers) {
    const count = lever === "reddit" ? totals.reddit : totals.directory;
    failures.push(
      `${lever} review item count ${count} is below required ${minimumReviewItemsPerRequiredLever}`,
    );
  }
  return {
    readyForManualScoring: failures.length === 0,
    requiredLevers,
    missingRequiredLevers,
    requiredSegments,
    missingRequiredSegments,
    minimumReviewItemsPerRequiredLever,
    shallowRequiredLevers,
    failures,
  };
}

export function opportunitiesFromPayload(payload: unknown): CachedOpportunity[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const opportunities = record.opportunities;
  return Array.isArray(opportunities) ? (opportunities as CachedOpportunity[]) : [];
}

export function rowsWithReviewableOpportunities<Row extends { payload: unknown }>(
  rows: Row[],
): Row[] {
  return rows.filter((row) => opportunitiesFromPayload(row.payload).length > 0);
}

export function qualityBucket(score?: number): OffPageQualityBucket {
  if (typeof score !== "number") return "needs_refresh";
  if (score >= 82) return "good";
  if (score >= 65) return "okay";
  if (score >= 50) return "needs_review";
  return "bad";
}

function checkedAgeDays(value: string | undefined, now: Date): number | null {
  if (!value?.trim()) return null;
  const checkedAt = new Date(value);
  const checkedMs = checkedAt.getTime();
  if (!Number.isFinite(checkedMs)) return null;
  return Math.floor((now.getTime() - checkedMs) / DAY_MS);
}

function isRedditThreadUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
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

function isHttpUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function criticalFlags(o: CachedOpportunity, now = new Date()): string[] {
  const flags: string[] = [];
  const warningText = [
    ...(o.qualityWarnings ?? []),
    o.validatorReason ?? "",
  ].join(" ");
  const ageDays = checkedAgeDays(o.lastCheckedAt, now);
  if (!o.url) flags.push("missing_url");
  if (o.url?.trim() && !isHttpUrl(o.url)) flags.push("invalid_url");
  if (typeof o.confidence !== "number") flags.push("missing_confidence");
  if (!o.confidenceLevel?.trim()) flags.push("missing_confidence_level");
  if (!o.sourceType?.trim()) flags.push("missing_source_type");
  if (!o.lastCheckedAt?.trim()) flags.push("missing_last_checked_at");
  if (o.lastCheckedAt?.trim() && ageDays === null) flags.push("invalid_last_checked_at");
  if (typeof ageDays === "number" && ageDays > MAX_OFFPAGE_QA_LAST_CHECKED_AGE_DAYS) {
    flags.push("stale_last_checked_at");
  }
  if (typeof ageDays === "number" && ageDays < -1) {
    flags.push("future_last_checked_at");
  }
  if (!Array.isArray(o.evidenceSources) || o.evidenceSources.length === 0) {
    flags.push("missing_evidence_sources");
  }
  if (!o.whyRecommended?.trim()) {
    flags.push("missing_why_recommended");
  }
  if (typeof o.confidence === "number" && o.confidence < 50) {
    flags.push("low_confidence_visible");
  }
  if (o.leverKey === "reddit") {
    if (!isRedditThreadUrl(o.url)) {
      flags.push("invalid_reddit_opportunity_url");
    }
    if (!Array.isArray(o.threads) || o.threads.length === 0) {
      flags.push("reddit_without_threads");
    }
    if (o.threads?.some((t) => !isRedditThreadUrl(t.url))) {
      flags.push("invalid_reddit_thread_url");
    }
    if (o.threads?.some((t) => (t.ageDays ?? 0) > 1460)) {
      flags.push("very_old_reddit_thread");
    }
    if (
      o.threads?.some(
        (t) =>
          t.locked ||
          t.archived ||
          t.qualityWarnings?.some((w) => /locked|archived/i.test(w)),
      )
    ) {
      flags.push("locked_or_archived_thread");
    }
    if (o.threads?.some((t) => t.deleted || t.unavailable)) {
      flags.push("deleted_or_unavailable_thread");
    }
    if (o.threads?.some((t) => !t.detailCheckedAt)) {
      flags.push("reddit_thread_detail_unchecked");
    }
    const drafts = [
      o.draft,
      ...(o.threads ?? []).map((thread) => thread.draft),
    ].filter((draft): draft is string => typeof draft === "string" && draft.trim().length > 0);
    if (drafts.some((draft) => sanitizeRedditDraft(draft) === null)) {
      flags.push("spammy_or_unsafe_reddit_draft");
    }
    if (/\b(spam|spammy|hard[-\s]?sell|link[-\s]?drop|promotional)\b/i.test(warningText)) {
      flags.push("spammy_or_unsafe_reddit_intent");
    }
  }
  if (o.leverKey === "directory") {
    if (!o.submissionUrl?.trim()) flags.push("missing_submission_url");
    if (o.submissionUrl?.trim() && !isHttpUrl(o.submissionUrl)) {
      flags.push("invalid_submission_url");
    }
    if (!o.submissionUrlType?.trim()) flags.push("missing_submission_url_type");
    if (!o.pricingModel?.trim()) flags.push("missing_pricing_model");
    if (o.submissionUrlType === "homepage" || o.submissionUrlType === "unknown") {
      flags.push("directory_homepage_or_unknown_submission");
    }
  }
  if (/\b(wrong business|different business|not this business|competitor)\b/i.test(warningText)) {
    flags.push("wrong_business_warning");
  }
  if (/\b(wrong location|wrong country|wrong market|off[-\s]?location|foreign|non[-\s]?english|mistranslated)\b/i.test(warningText)) {
    flags.push("location_or_language_warning");
  }
  if (/\b(dead|404|soft 404|unreachable|not found|unavailable|could not reach|invalid url)\b/i.test(warningText)) {
    flags.push("dead_or_unreachable_url_warning");
  }
  return flags;
}

export function summarizeBenchmarkReviewItems(reviewItems: BenchmarkReviewSummaryInput[]) {
  return reviewItems.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.automatedBucket] += 1;
      const criticalFlags = (item.criticalFlags ?? []).filter((flag) => flag.trim().length > 0);
      if (criticalFlags.length > 0) {
        acc.withCriticalFlags += 1;
        for (const flag of criticalFlags) {
          acc.criticalFlagCounts[flag] = (acc.criticalFlagCounts[flag] ?? 0) + 1;
        }
      }
      if (item.leverKey === "reddit") acc.reddit += 1;
      if (item.leverKey === "directory") acc.directory += 1;
      return acc;
    },
    {
      total: 0,
      reddit: 0,
      directory: 0,
      good: 0,
      okay: 0,
      needs_review: 0,
      bad: 0,
      needs_refresh: 0,
      withCriticalFlags: 0,
      criticalFlagCounts: {} as Record<string, number>,
    },
  );
}

async function main(prisma: PrismaClientType = createPrismaClient()) {
  const rows = await prisma.offPageResearchCache.findMany({
    orderBy: { generatedAt: "desc" },
    take: SCAN_LIMIT,
    select: {
      businessId: true,
      generatedAt: true,
      expiresAt: true,
      payload: true,
    },
  });

  const eligibleRows = rowsWithReviewableOpportunities(rows);
  const businessIds = eligibleRows.map((row) => row.businessId);
  const businesses = await prisma.business.findMany({
    where: { id: { in: businessIds } },
    select: {
      id: true,
      businessName: true,
      businessType: true,
      businessWebsiteUrl: true,
      businessCity: true,
      businessCountry: true,
    },
  });
  const businessById = new Map(businesses.map((b) => [b.id, b]));
  const selectedRows = selectStratifiedOffPageBenchmarkRows(
    eligibleRows,
    businessById,
    LIMIT,
  );
  const selectedBusinesses = selectedRows
    .map((row) => businessById.get(row.businessId))
    .filter((business): business is NonNullable<typeof business> => Boolean(business));

  const reviewItems = selectedRows.flatMap((row) => {
    const business = businessById.get(row.businessId);
    const businessSegment = classifyOffPageQaBusinessSegment(business);
    return opportunitiesFromPayload(row.payload).map((o) => {
      const flags = criticalFlags(o);
      return {
        businessId: row.businessId,
        businessName: business?.businessName ?? null,
        businessType: business?.businessType ?? null,
        businessWebsiteUrl: business?.businessWebsiteUrl ?? null,
        businessCity: business?.businessCity ?? null,
        businessCountry: business?.businessCountry ?? null,
        businessSegment,
        generatedAt: row.generatedAt.toISOString(),
        leverKey: o.leverKey ?? null,
        title: o.title ?? null,
        url: o.url ?? null,
        confidence: o.confidence ?? null,
        confidenceLevel: o.confidenceLevel ?? null,
        whyRecommended: o.whyRecommended ?? null,
        automatedBucket: qualityBucket(o.confidence),
        sourceType: o.sourceType ?? null,
        evidenceSources: o.evidenceSources ?? [],
        source: o.source ?? null,
        validatorReason: o.validatorReason ?? null,
        submissionUrl: o.submissionUrl ?? null,
        submissionUrlType: o.submissionUrlType ?? null,
        pricingModel: o.pricingModel ?? null,
        lastCheckedAt: o.lastCheckedAt ?? null,
        qualitySignals: o.qualitySignals ?? [],
        qualityWarnings: o.qualityWarnings ?? [],
        criticalFlags: flags,
        manualScore: null as null | "good" | "okay" | "bad",
        manualNotes: "",
      };
    });
  });

  const totals = summarizeBenchmarkReviewItems(reviewItems);

  const businessSegments = summarizeBusinessSegments(selectedBusinesses);

  const summary = {
    checkedAt: new Date().toISOString(),
    businesses: selectedRows.length,
    scannedBusinesses: rows.length,
    cacheRowsWithoutReviewableOpportunities: rows.length - eligibleRows.length,
    sampleStrategy: "stratified_latest_by_business_segment",
    businessSegments,
    totals,
    preManualGate: benchmarkPreManualGate(totals, {
      requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
      requiredSegments: REQUIRED_OFFPAGE_QA_SEGMENTS,
      businessSegments,
      benchmarkBusinesses: selectedRows.length,
      minimumBusinesses: LIMIT,
      minimumReviewItemsPerRequiredLever: MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
    }),
    passTargets: {
      goodRateTarget: ">= 80% manual good",
      badRateTarget: "< 10% manual bad",
      criticalBadTarget: "0 critical bad results",
    },
    manualReviewInstructions:
      "Open each URL and set manualScore to good, okay, or bad. The sample is stratified across business segments when available. A critical bad result is wrong business, wrong country, dead URL, locked Reddit thread, or spammy reply intent.",
    reviewItems,
  };

  try {
    if (OUTPUT) {
      await writeFile(OUTPUT, JSON.stringify(summary, null, 2));
      console.log(`Wrote ${reviewItems.length} review items to ${OUTPUT}`);
    }
    console.log(JSON.stringify({ ...summary, reviewItems: reviewItems.slice(0, 20) }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
