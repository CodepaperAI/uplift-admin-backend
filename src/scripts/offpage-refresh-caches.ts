/**
 * offpage-refresh-caches.ts
 *
 * Dry-run-first helper for regenerating Off-Page Opportunity Quality V2 caches.
 * It finds expired or legacy non-V2 cache rows using the same selector as the
 * scheduled cron. By default it only prints candidates. To actually queue
 * refresh jobs, set OFFPAGE_REFRESH_BACKFILL_COMMIT=true.
 *
 * Usage:
 *   bun --env-file=.env.production run offpage:refresh
 *   OFFPAGE_REFRESH_BACKFILL_LIMIT=20 OFFPAGE_REFRESH_BACKFILL_COMMIT=true bun --env-file=.env.production run offpage:refresh
 */

import { prisma } from "../config/db.config";
import {
  getOffPageRefreshCandidates,
  type OffPageRefreshCandidate,
} from "../services/offpage/offpage-maintenance.service";

export interface OffPageRefreshBackfillOptions {
  commit: boolean;
  batchLimit: number;
  scanLimit: number;
}

export interface OffPageRefreshBackfillSummary {
  commit: boolean;
  candidateCount: number;
  queued: number;
  reasons: Record<string, number>;
  note: string;
  candidates: OffPageRefreshCandidate[];
}

function readEnv(name: string): string {
  return process.env[name]?.trim() || "";
}

function readPositiveInt(name: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(readEnv(name), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

export function getOffPageRefreshBackfillOptions(): OffPageRefreshBackfillOptions {
  return {
    commit: readEnv("OFFPAGE_REFRESH_BACKFILL_COMMIT").toLowerCase() === "true",
    batchLimit: readPositiveInt("OFFPAGE_REFRESH_BACKFILL_LIMIT", 20, 100),
    scanLimit: readPositiveInt("OFFPAGE_REFRESH_BACKFILL_SCAN_LIMIT", 200, 1000),
  };
}

export function summarizeOffPageRefreshBackfill(
  candidates: OffPageRefreshCandidate[],
  options: Pick<OffPageRefreshBackfillOptions, "commit">,
  queued: number,
): OffPageRefreshBackfillSummary {
  return {
    commit: options.commit,
    candidateCount: candidates.length,
    queued,
    reasons: candidates.reduce<Record<string, number>>((acc, candidate) => {
      acc[candidate.reason] = (acc[candidate.reason] ?? 0) + 1;
      return acc;
    }, {}),
    note: options.commit
      ? "Queued off-page regeneration events for these businesses."
      : "Dry run only. Set OFFPAGE_REFRESH_BACKFILL_COMMIT=true to queue regeneration events.",
    candidates,
  };
}

async function enqueueRefreshes(candidates: OffPageRefreshCandidate[]): Promise<number> {
  const { inngest } = await import("../inngest/client");
  let queued = 0;
  for (const candidate of candidates) {
    await inngest.send({
      name: "off-page/generate",
      data: {
        userId: candidate.userId,
        businessId: candidate.businessId,
        reason: candidate.reason,
        source: "manual-backfill",
      },
    });
    queued += 1;
  }
  return queued;
}

async function main() {
  const options = getOffPageRefreshBackfillOptions();
  const candidates = await getOffPageRefreshCandidates({
    batchLimit: options.batchLimit,
    scanLimit: options.scanLimit,
  });
  const queued = options.commit ? await enqueueRefreshes(candidates) : 0;
  console.log(
    JSON.stringify(
      summarizeOffPageRefreshBackfill(candidates, options, queued),
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
