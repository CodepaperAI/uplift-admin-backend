import { shouldShowOpportunity } from "./offpage-quality.service";
import type {
  OffPageQualitySummary,
  Opportunity,
} from "./offpage-types";

interface RejectedOpportunity {
  reason?: string | null;
}

function bump(record: Record<string, number>, key: string | null | undefined): void {
  const normalized = key?.trim() || "unknown";
  record[normalized] = (record[normalized] ?? 0) + 1;
}

function rejectionReasonBucket(reason?: string | null): string {
  const text = reason?.trim().toLowerCase();
  if (!text) return "unknown";
  if (/dismiss|user rejected|previously dismissed/.test(text)) return "dismissed_feedback";
  if (/location|country|city|market/.test(text)) return "wrong_location";
  if (/spam|promot/.test(text)) return "spam_or_promotional";
  if (/irrelevant|off-topic|off topic|not relevant/.test(text)) return "irrelevant";
  if (/dead|404|unavailable|not found/.test(text)) return "unreachable";
  return "strict_reviewer";
}

export function summarizeOffPageQuality(
  candidates: Opportunity[],
  shown: Opportunity[] = candidates.filter(shouldShowOpportunity),
  rejected: RejectedOpportunity[] = [],
): OffPageQualitySummary {
  const byLever: Record<string, number> = {};
  const byConfidenceLevel: Record<string, number> = {};
  const bySourceType: Record<string, number> = {};
  const evidenceSourceCounts: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  const confidenceValues: number[] = [];

  for (const opportunity of candidates) {
    bump(byLever, opportunity.leverKey);
    bump(byConfidenceLevel, opportunity.confidenceLevel);
    bump(bySourceType, opportunity.sourceType);
    if (typeof opportunity.confidence === "number" && Number.isFinite(opportunity.confidence)) {
      confidenceValues.push(opportunity.confidence);
    }
    for (const source of opportunity.evidenceSources ?? []) {
      bump(evidenceSourceCounts, source);
    }
  }

  for (const item of rejected) {
    bump(rejectionReasons, rejectionReasonBucket(item.reason));
  }

  const shownKeys = new Set(shown.map((opportunity) => opportunity.key));
  const hiddenLowConfidence = candidates.filter(
    (opportunity) =>
      !shownKeys.has(opportunity.key) &&
      !shouldShowOpportunity(opportunity),
  ).length;

  const averageConfidence =
    confidenceValues.length === 0
      ? null
      : Math.round(
          confidenceValues.reduce((sum, value) => sum + value, 0) /
            confidenceValues.length,
        );

  return {
    totalCandidates: candidates.length,
    shown: shown.length,
    hiddenLowConfidence,
    rejected: rejected.length,
    averageConfidence,
    highConfidence: byConfidenceLevel.high ?? 0,
    mediumConfidence: byConfidenceLevel.medium ?? 0,
    needsReview: byConfidenceLevel.needs_review ?? 0,
    lowConfidence: byConfidenceLevel.low ?? 0,
    byLever,
    byConfidenceLevel,
    bySourceType,
    evidenceSourceCounts,
    rejectionReasons,
  };
}
