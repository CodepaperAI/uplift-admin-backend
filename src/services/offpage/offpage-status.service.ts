/**
 * offpage-status.service.ts
 *
 * Persists per-business opportunity status (todo/in_progress/done/dismissed) AND
 * outcome-verification state (verified/not_found/...) in the OffPageOpportunity
 * table, keyed by the stable opportunity key, and merges both back into a
 * freshly-computed queue. The merge is pure + tested; the DB calls are thin.
 */

import { prisma } from "../../config/db.config";
import type { Opportunity, OpportunityStatus } from "./offpage-types";

const VALID_STATUSES: OpportunityStatus[] = [
  "todo",
  "in_progress",
  "done",
  "dismissed",
];

export interface PersistedStatus {
  status: OpportunityStatus;
  verificationStatus?: string | null;
  dismissReason?: string | null;
}

export interface DismissedOpportunityFeedback {
  opportunityKey: string;
  leverKey: string;
  reason: string | null;
}

export interface DismissalRejectedOpportunity {
  key: string;
  leverKey: string;
  title: string;
  reason: string;
  score: number;
}

export function isValidStatus(s: unknown): s is OpportunityStatus {
  return typeof s === "string" && VALID_STATUSES.includes(s as OpportunityStatus);
}

function dismissReasonFromEvidence(
  status: string,
  evidence: unknown,
): string | null {
  if (status !== "dismissed") return null;
  const record =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const dismissal =
    record.dismissal &&
    typeof record.dismissal === "object" &&
    !Array.isArray(record.dismissal)
      ? (record.dismissal as Record<string, unknown>)
      : {};
  return typeof dismissal.reason === "string" ? dismissal.reason : null;
}

/** Read persisted status + verification for a business → map of opportunityKey → state. */
export async function getOpportunityStatuses(
  businessId: string,
): Promise<Map<string, PersistedStatus>> {
  const rows = await prisma.offPageOpportunity.findMany({
    where: { businessId },
    select: {
      opportunityKey: true,
      status: true,
      verificationStatus: true,
      evidence: true,
    },
  });
  const map = new Map<string, PersistedStatus>();
  for (const r of rows) {
    if (isValidStatus(r.status)) {
      map.set(r.opportunityKey, {
        status: r.status,
        verificationStatus: r.verificationStatus ?? null,
        dismissReason: dismissReasonFromEvidence(r.status, r.evidence),
      });
    }
  }
  return map;
}

/** Read user dismissal feedback so regenerated queues can avoid exact repeats. */
export async function getDismissedOpportunityFeedback(
  businessId: string,
): Promise<DismissedOpportunityFeedback[]> {
  const rows = await prisma.offPageOpportunity.findMany({
    where: { businessId, status: "dismissed" },
    select: {
      opportunityKey: true,
      leverKey: true,
      status: true,
      evidence: true,
    },
  });

  return rows.map((row) => ({
    opportunityKey: row.opportunityKey,
    leverKey: row.leverKey,
    reason: dismissReasonFromEvidence(row.status, row.evidence),
  }));
}

/** Upsert the status of a single opportunity. */
export async function setOpportunityStatus(
  businessId: string,
  opportunityKey: string,
  leverKey: string,
  status: OpportunityStatus,
  dismissReason?: string | null,
): Promise<void> {
  const evidence =
    status === "dismissed" && dismissReason?.trim()
      ? ({
          dismissal: {
            reason: dismissReason.trim(),
            dismissedAt: new Date().toISOString(),
          },
        } satisfies import("@prisma/client").Prisma.InputJsonValue)
      : undefined;
  await prisma.offPageOpportunity.upsert({
    where: { businessId_opportunityKey: { businessId, opportunityKey } },
    create: { businessId, opportunityKey, leverKey, status, evidence },
    update: evidence ? { status, evidence } : { status },
  });
}

/** Upsert the outcome-verification result of a single opportunity. */
export async function setOpportunityVerification(
  businessId: string,
  opportunityKey: string,
  leverKey: string,
  input: {
    verificationStatus: string;
    evidenceUrl?: string | null;
    evidence?: unknown;
  },
): Promise<void> {
  const verifiedAt = input.verificationStatus === "verified" ? new Date() : null;
  const evidence = (input.evidence ?? undefined) as
    | import("@prisma/client").Prisma.InputJsonValue
    | undefined;
  await prisma.offPageOpportunity.upsert({
    where: { businessId_opportunityKey: { businessId, opportunityKey } },
    create: {
      businessId,
      opportunityKey,
      leverKey,
      status: "done",
      verificationStatus: input.verificationStatus,
      evidenceUrl: input.evidenceUrl ?? undefined,
      evidence,
      verifiedAt: verifiedAt ?? undefined,
    },
    update: {
      verificationStatus: input.verificationStatus,
      evidenceUrl: input.evidenceUrl ?? undefined,
      evidence,
      verifiedAt: verifiedAt ?? undefined,
    },
  });
}

/** Pure: override computed opportunities' status + verification with persisted state. */
export function mergeStatuses(
  opportunities: Opportunity[],
  statuses: Map<string, PersistedStatus>,
): Opportunity[] {
  return opportunities.map((o) => {
    const persisted = statuses.get(o.key);
    if (!persisted) return o;
    return {
      ...o,
      status: persisted.status,
      verificationStatus: persisted.verificationStatus ?? o.verificationStatus ?? null,
      dismissReason:
        persisted.status === "dismissed"
          ? persisted.dismissReason ?? o.dismissReason ?? null
          : null,
    };
  });
}

export function applyDismissalFeedback(
  opportunities: Opportunity[],
  feedback: DismissedOpportunityFeedback[],
): {
  opportunities: Opportunity[];
  rejectedOpportunities: DismissalRejectedOpportunity[];
} {
  if (opportunities.length === 0 || feedback.length === 0) {
    return { opportunities, rejectedOpportunities: [] };
  }

  const feedbackByKey = new Map(
    feedback.map((item) => [item.opportunityKey, item]),
  );
  const kept: Opportunity[] = [];
  const rejectedOpportunities: DismissalRejectedOpportunity[] = [];

  for (const opportunity of opportunities) {
    const dismissal = feedbackByKey.get(opportunity.key);
    if (!dismissal) {
      kept.push(opportunity);
      continue;
    }

    const reason = dismissal.reason?.trim() || "Previously dismissed by user";
    rejectedOpportunities.push({
      key: opportunity.key,
      leverKey: opportunity.leverKey,
      title: opportunity.title,
      reason: `User feedback: ${reason}`,
      score: 0,
    });
  }

  return { opportunities: kept, rejectedOpportunities };
}
