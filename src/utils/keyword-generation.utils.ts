import type {
  CanonicalBusinessArea,
  KeywordCandidate,
} from "./dataforseo-keyword-plan.utils";
import {
  mapKeywordToBusinessArea,
  mapKeywordToService,
  normalizeKeywordText,
} from "./dataforseo-keyword-plan.utils";
import type { PlanKeywordSaveSkip } from "./plan-keyword-save.utils";

export const KEYWORD_CANDIDATE_POOL_LIMIT = 420;
export const KEYWORD_CANDIDATE_GROUP_LIMIT = 60;

type KeywordPlanIdentity = {
  keyword: string;
  publishDate: string;
};

function getCandidateGroupingKey(params: {
  candidate: KeywordCandidate;
  businessAreas: CanonicalBusinessArea[];
  primaryServices: string[];
  focusAreas: string[];
}): string {
  const { candidate, businessAreas, primaryServices, focusAreas } = params;

  return (
    candidate.canonicalBusinessArea ||
    mapKeywordToBusinessArea(candidate.keyword, businessAreas) ||
    candidate.matchedService ||
    mapKeywordToService(candidate.keyword, primaryServices, focusAreas) ||
    "__ungrouped__"
  );
}

export function capKeywordCandidates(params: {
  candidates: KeywordCandidate[];
  businessAreas: CanonicalBusinessArea[];
  primaryServices: string[];
  focusAreas?: string[];
  totalLimit?: number;
  perGroupLimit?: number;
}): KeywordCandidate[] {
  const {
    candidates,
    businessAreas,
    primaryServices,
    focusAreas = [],
    totalLimit = KEYWORD_CANDIDATE_POOL_LIMIT,
    perGroupLimit = KEYWORD_CANDIDATE_GROUP_LIMIT,
  } = params;

  if (candidates.length <= totalLimit) {
    return candidates;
  }

  const selected: KeywordCandidate[] = [];
  const selectedKeys = new Set<string>();
  const perGroupCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const key = normalizeKeywordText(candidate.keyword);
    if (selectedKeys.has(key)) {
      continue;
    }

    const groupingKey = getCandidateGroupingKey({
      candidate,
      businessAreas,
      primaryServices,
      focusAreas,
    });
    const currentGroupCount = perGroupCounts.get(groupingKey) ?? 0;
    if (currentGroupCount >= perGroupLimit) {
      continue;
    }

    selected.push(candidate);
    selectedKeys.add(key);
    perGroupCounts.set(groupingKey, currentGroupCount + 1);
  }

  if (selected.length >= totalLimit) {
    return selected.slice(0, totalLimit);
  }

  for (const candidate of candidates) {
    if (selected.length >= totalLimit) {
      break;
    }

    const key = normalizeKeywordText(candidate.keyword);
    if (selectedKeys.has(key)) {
      continue;
    }

    selected.push(candidate);
    selectedKeys.add(key);
  }

  return selected.slice(0, totalLimit);
}

export function getPersistedKeywordPlanItems<T extends KeywordPlanIdentity>(
  items: T[],
  skippedDetails: PlanKeywordSaveSkip[],
): T[] {
  const skippedKeys = new Set(
    skippedDetails.map(
      (skipped) =>
        `${normalizeKeywordText(skipped.keyword)}::${skipped.date.trim()}`,
    ),
  );

  return items.filter(
    (item) =>
      !skippedKeys.has(
        `${normalizeKeywordText(item.keyword)}::${item.publishDate.trim()}`,
      ),
  );
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency)),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );

  return results;
}
