/**
 * offpage-quality-summary.ts
 *
 * Summarizes a filled manual QA benchmark JSON file produced by
 * offpage-quality-benchmark.ts. Exits non-zero when the reviewed sample does
 * not meet the V2 quality bar.
 *
 * Usage:
 *   bun run offpage:qa:summary /private/tmp/offpage-quality-benchmark-20.json
 *   OFFPAGE_QA_INPUT=/private/tmp/offpage-quality-benchmark-20.json bun run offpage:qa:summary
 */

import { readFile } from "node:fs/promises";
import {
  MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
  REQUIRED_OFFPAGE_QA_LEVERS,
  REQUIRED_OFFPAGE_QA_SEGMENTS,
  summarizeOffPageManualQa,
  type OffPageQaBusinessSegment,
} from "../services/offpage/offpage-qa.service";

function inputPath(): string {
  return process.argv[2] || process.env.OFFPAGE_QA_INPUT || "";
}

function reviewItemsFromPayload(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const items = (payload as Record<string, unknown>).reviewItems;
  return Array.isArray(items) ? items : [];
}

function benchmarkBusinessesFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const businesses = (payload as Record<string, unknown>).businesses;
  return typeof businesses === "number" && Number.isFinite(businesses)
    ? businesses
    : null;
}

async function main() {
  const path = inputPath();
  if (!path) {
    throw new Error("Pass a benchmark JSON path or set OFFPAGE_QA_INPUT.");
  }

  const payload = JSON.parse(await readFile(path, "utf8")) as unknown;
  const reviewItems = reviewItemsFromPayload(payload);
  const summary = summarizeOffPageManualQa(
    reviewItems.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as {
            businessId?: string | null;
            manualScore?: "good" | "okay" | "bad" | null;
            criticalFlags?: string[];
            automatedBucket?: string | null;
            leverKey?: string | null;
            businessSegment?: OffPageQaBusinessSegment | null;
          })
        : {},
    ),
    {
      benchmarkBusinesses: benchmarkBusinessesFromPayload(payload),
      minimumBusinesses: 20,
      requiredSegments: REQUIRED_OFFPAGE_QA_SEGMENTS,
      requiredLevers: REQUIRED_OFFPAGE_QA_LEVERS,
      minimumReviewItemsPerRequiredLever: MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER,
    },
  );

  console.log(JSON.stringify({ input: path, summary }, null, 2));
  if (!summary.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
