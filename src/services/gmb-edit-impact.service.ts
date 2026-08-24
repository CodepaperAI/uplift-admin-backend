import { prisma } from "../config/db.config";

// Phase 2 ranking foundations: edit→rank impact attribution.
//
// When an approved action is APPLIED to the live Google profile, we snapshot
// the most recent rank-scan results as the 'baseline'. After 14 days, a daily
// Inngest job captures a 'post' snapshot and computes the per-keyword delta.
// The UI surfaces this as "your category change moved 'shawarma toronto' from
// #14 → #6 in 9 days".

const IMPACT_TRACKED_ACTION_TYPES = new Set([
  "profile_edit",
  "profile_description",
  "hours_update",
  "special_hours_update",
  "services_attributes",
  "attributes_update",
  "category_update",
  "categories_update",
  "services_update",
]);

export const EDIT_IMPACT_WINDOW_DAYS = 14;

type RankSnapshotEntry = {
  scanId: string;
  keyword: string;
  locationLabel: string | null;
  requestedAt: string;
  position: number | null;
  rankAbsolute: number | null;
};

type DeltaTopMove = {
  keyword: string;
  locationLabel: string | null;
  before: number | null;
  after: number | null;
  delta: number; // positive = improved (lower number = better rank)
};

export type EditImpactDeltaSummary = {
  keywordsImproved: number;
  keywordsDeclined: number;
  keywordsUnchanged: number;
  keywordsMissingBaseline: number;
  keywordsMissingPost: number;
  avgPositionDelta: number | null;
  topImprovements: DeltaTopMove[];
  topDeclines: DeltaTopMove[];
  computedAt: string;
};

function entryKey(entry: { keyword: string; locationLabel: string | null }) {
  return `${entry.keyword.toLowerCase()}::${entry.locationLabel ?? ""}`;
}

async function loadRecentClientRanks(
  businessId: string,
  limit = 50,
): Promise<RankSnapshotEntry[]> {
  const scans = await prisma.gMBLocalRankScan.findMany({
    where: { businessId, status: "COMPLETE" },
    orderBy: { requestedAt: "desc" },
    take: limit,
    include: {
      results: {
        where: { isClient: true },
        select: { position: true, rankAbsolute: true },
        take: 1,
      },
    },
  });

  return scans.map((scan) => {
    const clientResult = scan.results[0] ?? null;
    return {
      scanId: scan.id,
      keyword: scan.keyword,
      locationLabel: scan.locationLabel,
      requestedAt: scan.requestedAt.toISOString(),
      position: clientResult?.position ?? null,
      rankAbsolute: clientResult?.rankAbsolute ?? null,
    };
  });
}

export async function captureEditImpactBaseline(action: {
  id: string;
  businessId: string;
  gmbId: string;
  actionType: string;
}): Promise<{ skipped?: string; baselineId?: string }> {
  if (!IMPACT_TRACKED_ACTION_TYPES.has(action.actionType)) {
    return { skipped: "action_type_not_tracked" };
  }

  const rankSnapshot = await loadRecentClientRanks(action.businessId);
  if (rankSnapshot.length === 0) {
    return { skipped: "no_rank_scans" };
  }

  // Idempotent on (actionId, phase). Re-approval (rare) refreshes the snapshot.
  const row = await prisma.gMBEditImpactSnapshot.upsert({
    where: { actionId_phase: { actionId: action.id, phase: "baseline" } },
    create: {
      businessId: action.businessId,
      gmbId: action.gmbId,
      actionId: action.id,
      actionType: action.actionType,
      phase: "baseline",
      rankSnapshot: rankSnapshot as object,
    },
    update: {
      rankSnapshot: rankSnapshot as object,
      capturedAt: new Date(),
    },
    select: { id: true },
  });

  return { baselineId: row.id };
}

export function computeDeltaSummary(
  baseline: RankSnapshotEntry[],
  current: RankSnapshotEntry[],
): EditImpactDeltaSummary {
  const baselineByKey = new Map<string, RankSnapshotEntry>();
  for (const entry of baseline) baselineByKey.set(entryKey(entry), entry);

  const currentByKey = new Map<string, RankSnapshotEntry>();
  for (const entry of current) currentByKey.set(entryKey(entry), entry);

  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let missingPost = 0;
  let positionDeltaSum = 0;
  let positionDeltaCount = 0;
  const moves: DeltaTopMove[] = [];

  for (const [key, before] of baselineByKey.entries()) {
    const after = currentByKey.get(key);
    if (!after) {
      missingPost += 1;
      continue;
    }
    if (before.position == null || after.position == null) continue;

    // Position is 1-based; lower is better. Delta > 0 means improvement.
    const delta = before.position - after.position;
    if (delta > 0) improved += 1;
    else if (delta < 0) declined += 1;
    else unchanged += 1;

    positionDeltaSum += delta;
    positionDeltaCount += 1;
    moves.push({
      keyword: before.keyword,
      locationLabel: before.locationLabel,
      before: before.position,
      after: after.position,
      delta,
    });
  }

  const missingBaseline = Math.max(0, currentByKey.size - baselineByKey.size);

  const topImprovements = [...moves]
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);

  const topDeclines = [...moves]
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 5);

  return {
    keywordsImproved: improved,
    keywordsDeclined: declined,
    keywordsUnchanged: unchanged,
    keywordsMissingBaseline: missingBaseline,
    keywordsMissingPost: missingPost,
    avgPositionDelta:
      positionDeltaCount > 0
        ? Number((positionDeltaSum / positionDeltaCount).toFixed(2))
        : null,
    topImprovements,
    topDeclines,
    computedAt: new Date().toISOString(),
  };
}

export async function evaluatePostSnapshot(baseline: {
  id: string;
  businessId: string;
  gmbId: string;
  actionId: string;
  actionType: string;
  rankSnapshot: unknown;
}): Promise<{ skipped?: string; postId?: string; summary?: EditImpactDeltaSummary }> {
  const current = await loadRecentClientRanks(baseline.businessId);
  if (current.length === 0) {
    return { skipped: "no_current_rank_scans" };
  }

  const baselineRows = Array.isArray(baseline.rankSnapshot)
    ? (baseline.rankSnapshot as RankSnapshotEntry[])
    : [];
  const summary = computeDeltaSummary(baselineRows, current);

  const row = await prisma.gMBEditImpactSnapshot.upsert({
    where: { actionId_phase: { actionId: baseline.actionId, phase: "post" } },
    create: {
      businessId: baseline.businessId,
      gmbId: baseline.gmbId,
      actionId: baseline.actionId,
      actionType: baseline.actionType,
      phase: "post",
      rankSnapshot: current as object,
      deltaSummary: summary as object,
      evaluatedAt: new Date(),
    },
    update: {
      rankSnapshot: current as object,
      deltaSummary: summary as object,
      evaluatedAt: new Date(),
    },
    select: { id: true },
  });

  return { postId: row.id, summary };
}

export type ListedEditImpact = {
  actionId: string;
  actionType: string;
  actionTitle: string | null;
  actionAppliedAt: string | null;
  baselineCapturedAt: string;
  postCapturedAt: string | null;
  postEvaluatedAt: string | null;
  summary: EditImpactDeltaSummary | null;
};

export async function listEditImpactsForBusiness(
  businessId: string,
  limit = 20,
): Promise<ListedEditImpact[]> {
  const baselines = await prisma.gMBEditImpactSnapshot.findMany({
    where: { businessId, phase: "baseline" },
    orderBy: { capturedAt: "desc" },
    take: limit,
    include: { action: { select: { title: true, appliedAt: true } } },
  });

  if (baselines.length === 0) return [];

  const actionIds = baselines.map((b) => b.actionId);
  const posts = await prisma.gMBEditImpactSnapshot.findMany({
    where: { actionId: { in: actionIds }, phase: "post" },
    select: {
      actionId: true,
      capturedAt: true,
      evaluatedAt: true,
      deltaSummary: true,
    },
  });
  const postsByActionId = new Map(posts.map((p) => [p.actionId, p]));

  return baselines.map((b) => {
    const post = postsByActionId.get(b.actionId) ?? null;
    return {
      actionId: b.actionId,
      actionType: b.actionType,
      actionTitle: b.action?.title ?? null,
      actionAppliedAt: b.action?.appliedAt?.toISOString() ?? null,
      baselineCapturedAt: b.capturedAt.toISOString(),
      postCapturedAt: post?.capturedAt?.toISOString() ?? null,
      postEvaluatedAt: post?.evaluatedAt?.toISOString() ?? null,
      summary: (post?.deltaSummary as EditImpactDeltaSummary | null) ?? null,
    };
  });
}

export async function listBaselinesDueForEvaluation(
  windowDays = EDIT_IMPACT_WINDOW_DAYS,
  limit = 50,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  return prisma.gMBEditImpactSnapshot.findMany({
    where: {
      phase: "baseline",
      capturedAt: { lte: cutoff },
      action: { editImpactSnapshots: { none: { phase: "post" } } },
    },
    orderBy: { capturedAt: "asc" },
    take: limit,
    select: {
      id: true,
      businessId: true,
      gmbId: true,
      actionId: true,
      actionType: true,
      rankSnapshot: true,
    },
  });
}
