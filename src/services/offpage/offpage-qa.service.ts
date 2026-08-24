/**
 * offpage-qa.service.ts
 *
 * Pure helpers for evaluating the manual QA benchmark. The benchmark script
 * generates review items; this layer decides whether the reviewed sample meets
 * the product quality bar from the Off-Page Opportunity Quality V2 goal.
 */

export type OffPageManualScore = "good" | "okay" | "bad";
export type OffPageQaBusinessSegment =
  | "local_service"
  | "restaurant_hospitality"
  | "saas"
  | "ecommerce"
  | "agency_professional"
  | "other";
export type OffPageQaLever = "reddit" | "directory";

export interface OffPageQaBusinessLike {
  id?: string;
  businessName?: string | null;
  businessType?: string | null;
  businessWebsiteUrl?: string | null;
}

export interface OffPageManualReviewItem {
  businessId?: string | null;
  manualScore?: OffPageManualScore | null;
  criticalFlags?: string[];
  automatedBucket?: string | null;
  leverKey?: string | null;
  businessSegment?: OffPageQaBusinessSegment | null;
}

export interface OffPageManualQaOptions {
  benchmarkBusinesses?: number | null;
  minimumBusinesses?: number;
  requiredSegments?: OffPageQaBusinessSegment[];
  requiredLevers?: OffPageQaLever[];
  minimumReviewItemsPerRequiredLever?: number;
}

export interface OffPageManualQaSummary {
  benchmarkBusinesses: number | null;
  uniqueBenchmarkBusinesses: number | null;
  minimumBusinesses: number | null;
  requiredSegments: OffPageQaBusinessSegment[];
  missingRequiredSegments: OffPageQaBusinessSegment[];
  requiredLevers: OffPageQaLever[];
  missingRequiredLevers: OffPageQaLever[];
  minimumReviewItemsPerRequiredLever: number | null;
  shallowRequiredLevers: OffPageQaLever[];
  total: number;
  scored: number;
  unscored: number;
  good: number;
  okay: number;
  bad: number;
  reddit: number;
  directory: number;
  criticalBad: number;
  withCriticalFlags: number;
  criticalFlagCounts: Record<string, number>;
  needsRefresh: number;
  goodRate: number;
  badRate: number;
  complete: boolean;
  passed: boolean;
  failures: string[];
  targets: {
    goodRate: ">= 80%";
    badRate: "< 10%";
    criticalBad: 0;
  };
  /** Review-item counts by segment. Useful for workload visibility. */
  businessSegments: Record<OffPageQaBusinessSegment, number>;
  /** Unique business counts by segment. Used to prove benchmark coverage. */
  uniqueBusinessSegments: Record<OffPageQaBusinessSegment, number>;
}

function roundRate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function summarizeOffPageManualQa(
  reviewItems: OffPageManualReviewItem[],
  options: OffPageManualQaOptions = {},
): OffPageManualQaSummary {
  const minimumBusinesses = options.minimumBusinesses ?? null;
  const benchmarkBusinesses =
    typeof options.benchmarkBusinesses === "number"
      ? options.benchmarkBusinesses
      : null;
  const requiredSegments = options.requiredSegments ?? [];
  const requiredLevers = options.requiredLevers ?? [];
  const minimumReviewItemsPerRequiredLever =
    typeof options.minimumReviewItemsPerRequiredLever === "number"
      ? options.minimumReviewItemsPerRequiredLever
      : null;
  const uniqueBusinessIds = new Set(
    reviewItems
      .map((item) => item.businessId?.trim())
      .filter((businessId): businessId is string => Boolean(businessId)),
  );
  const uniqueBusinessIdsBySegment = new Map<OffPageQaBusinessSegment, Set<string>>();
  for (const segment of OFFPAGE_QA_SEGMENT_ORDER) {
    uniqueBusinessIdsBySegment.set(segment, new Set<string>());
  }
  for (const item of reviewItems) {
    const businessId = item.businessId?.trim();
    if (!businessId || !item.businessSegment) continue;
    uniqueBusinessIdsBySegment.get(item.businessSegment)?.add(businessId);
  }
  const uniqueBenchmarkBusinesses =
    uniqueBusinessIds.size > 0 ? uniqueBusinessIds.size : null;
  const totals = reviewItems.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.leverKey === "reddit") acc.reddit += 1;
      if (item.leverKey === "directory") acc.directory += 1;
      if (item.businessSegment) acc.businessSegments[item.businessSegment] += 1;
      const criticalFlags = (item.criticalFlags ?? []).filter((flag) => flag.trim().length > 0);
      const hasCriticalFlags = criticalFlags.length > 0;
      const needsRefresh = item.automatedBucket === "needs_refresh";
      if (hasCriticalFlags) {
        acc.withCriticalFlags += 1;
        for (const flag of criticalFlags) {
          acc.criticalFlagCounts[flag] = (acc.criticalFlagCounts[flag] ?? 0) + 1;
        }
      }
      if (hasCriticalFlags || needsRefresh) {
        acc.criticalBad += 1;
      }
      if (needsRefresh) acc.needsRefresh += 1;

      if (item.manualScore === "good") {
        acc.scored += 1;
        acc.good += 1;
      } else if (item.manualScore === "okay") {
        acc.scored += 1;
        acc.okay += 1;
      } else if (item.manualScore === "bad") {
        acc.scored += 1;
        acc.bad += 1;
      } else {
        acc.unscored += 1;
      }
      return acc;
    },
    {
      total: 0,
      scored: 0,
      unscored: 0,
      good: 0,
      okay: 0,
      bad: 0,
      reddit: 0,
      directory: 0,
      criticalBad: 0,
      withCriticalFlags: 0,
      criticalFlagCounts: {} as Record<string, number>,
      needsRefresh: 0,
      businessSegments: emptySegmentCounts(),
    },
  );

  const goodRate = totals.scored > 0 ? roundRate(totals.good / totals.scored) : 0;
  const badRate = totals.scored > 0 ? roundRate(totals.bad / totals.scored) : 0;
  const uniqueBusinessSegments = emptySegmentCounts();
  for (const [segment, businessIds] of uniqueBusinessIdsBySegment) {
    uniqueBusinessSegments[segment] = businessIds.size;
  }
  const missingRequiredSegments = requiredSegments.filter(
    (segment) => uniqueBusinessSegments[segment] <= 0,
  );
  const missingRequiredLevers = requiredLevers.filter((lever) =>
    lever === "reddit" ? totals.reddit <= 0 : totals.directory <= 0,
  );
  const shallowRequiredLevers =
    minimumReviewItemsPerRequiredLever === null
      ? []
      : requiredLevers.filter((lever) => {
          const count = lever === "reddit" ? totals.reddit : totals.directory;
          return count > 0 && count < minimumReviewItemsPerRequiredLever;
        });
  const failures: string[] = [];

  if (
    minimumBusinesses !== null &&
    benchmarkBusinesses !== null &&
    benchmarkBusinesses < minimumBusinesses
  ) {
    failures.push(
      `${benchmarkBusinesses} benchmark businesses is below required ${minimumBusinesses}`,
    );
  }
  if (
    minimumBusinesses !== null &&
    uniqueBenchmarkBusinesses !== null &&
    uniqueBenchmarkBusinesses < minimumBusinesses
  ) {
    failures.push(
      `${uniqueBenchmarkBusinesses} unique benchmark businesses is below required ${minimumBusinesses}`,
    );
  }
  if (
    minimumBusinesses !== null &&
    benchmarkBusinesses === null &&
    uniqueBenchmarkBusinesses === null
  ) {
    failures.push("Benchmark business count is missing");
  }
  if (missingRequiredSegments.length > 0) {
    failures.push(`Missing required benchmark segments: ${missingRequiredSegments.join(", ")}`);
  }
  if (missingRequiredLevers.length > 0) {
    failures.push(`Missing required benchmark levers: ${missingRequiredLevers.join(", ")}`);
  }
  for (const lever of shallowRequiredLevers) {
    const count = lever === "reddit" ? totals.reddit : totals.directory;
    failures.push(
      `${lever} review item count ${count} is below required ${minimumReviewItemsPerRequiredLever}`,
    );
  }
  if (totals.total === 0) failures.push("No review items found");
  if (totals.unscored > 0) failures.push(`${totals.unscored} review items are unscored`);
  if (goodRate < 0.8) failures.push(`Good rate ${Math.round(goodRate * 100)}% is below 80%`);
  if (badRate >= 0.1) failures.push(`Bad rate ${Math.round(badRate * 100)}% is not below 10%`);
  if (totals.needsRefresh > 0) {
    failures.push(`${totals.needsRefresh} review items still need V2 refresh`);
  }
  if (totals.criticalBad > 0) {
    failures.push(`${totals.criticalBad} critical bad results found`);
  }

  return {
    benchmarkBusinesses,
    uniqueBenchmarkBusinesses,
    minimumBusinesses,
    requiredSegments,
    missingRequiredSegments,
    requiredLevers,
    missingRequiredLevers,
    minimumReviewItemsPerRequiredLever,
    shallowRequiredLevers,
    ...totals,
    uniqueBusinessSegments,
    goodRate,
    badRate,
    complete: totals.total > 0 && totals.unscored === 0,
    passed: failures.length === 0,
    failures,
    targets: {
      goodRate: ">= 80%",
      badRate: "< 10%",
      criticalBad: 0,
    },
  };
}

export const OFFPAGE_QA_SEGMENT_ORDER: OffPageQaBusinessSegment[] = [
  "local_service",
  "restaurant_hospitality",
  "saas",
  "ecommerce",
  "agency_professional",
  "other",
];

export const REQUIRED_OFFPAGE_QA_SEGMENTS: OffPageQaBusinessSegment[] = [
  "local_service",
  "restaurant_hospitality",
  "saas",
  "ecommerce",
  "agency_professional",
];

export const REQUIRED_OFFPAGE_QA_LEVERS: OffPageQaLever[] = [
  "reddit",
  "directory",
];

export const MIN_OFFPAGE_QA_REVIEW_ITEMS_PER_REQUIRED_LEVER = 5;

export function emptySegmentCounts(): Record<OffPageQaBusinessSegment, number> {
  return {
    local_service: 0,
    restaurant_hospitality: 0,
    saas: 0,
    ecommerce: 0,
    agency_professional: 0,
    other: 0,
  };
}

export function classifyOffPageQaBusinessSegment(
  business: OffPageQaBusinessLike | null | undefined,
): OffPageQaBusinessSegment {
  const text = [
    business?.businessName ?? "",
    business?.businessType ?? "",
    business?.businessWebsiteUrl ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (/\b(restaurant|pizza|shawarma|grill|cafe|coffee|bakery|bar|catering|hotel|hospitality|salon|spa|waxing|wellness|gym|fitness|venue|events?)\b/.test(text)) {
    return "restaurant_hospitality";
  }
  if (/\b(saas|software|platform|app|ai-powered|automation|crm|dashboard|analytics|developer|api|online platform)\b/.test(text)) {
    return "saas";
  }
  if (/\b(ecommerce|e-commerce|shop|store|retail|product|marketplace|jewelry|diamond|fashion|merchant)\b/.test(text)) {
    return "ecommerce";
  }
  if (/\b(agency|marketing|seo|design|development|consulting|consultant|law|legal|accounting|bookkeeping|tax|firm|studio)\b/.test(text)) {
    return "agency_professional";
  }
  if (/\b(plumbing|plumber|hvac|roof|roofing|electrician|electrical|contractor|construction|concrete|moving|movers|flooring|tiles?|cleaning|window|security|protective|landscaping|repair|demolition|ndis|clinic|medical|dental)\b/.test(text)) {
    return "local_service";
  }
  return "other";
}

export function summarizeBusinessSegments(
  businesses: OffPageQaBusinessLike[],
): Record<OffPageQaBusinessSegment, number> {
  const counts = emptySegmentCounts();
  for (const business of businesses) {
    counts[classifyOffPageQaBusinessSegment(business)] += 1;
  }
  return counts;
}

export function selectStratifiedOffPageBenchmarkRows<
  Row extends { businessId: string; generatedAt: Date },
>(
  rows: Row[],
  businessById: Map<string, OffPageQaBusinessLike>,
  limit: number,
): Row[] {
  const target = Math.max(1, Math.min(Math.floor(limit), rows.length || 1));
  const sortedRows = [...rows].sort(
    (a, b) => b.generatedAt.getTime() - a.generatedAt.getTime(),
  );
  const bySegment = new Map<OffPageQaBusinessSegment, Row[]>();
  for (const segment of OFFPAGE_QA_SEGMENT_ORDER) bySegment.set(segment, []);
  for (const row of sortedRows) {
    const segment = classifyOffPageQaBusinessSegment(businessById.get(row.businessId));
    bySegment.get(segment)?.push(row);
  }

  const selected: Row[] = [];
  const selectedBusinessIds = new Set<string>();
  const addRow = (row: Row | undefined) => {
    if (!row || selectedBusinessIds.has(row.businessId)) return;
    selected.push(row);
    selectedBusinessIds.add(row.businessId);
  };

  for (const segment of OFFPAGE_QA_SEGMENT_ORDER) {
    addRow(bySegment.get(segment)?.[0]);
    if (selected.length >= target) return selected;
  }

  for (const row of sortedRows) {
    addRow(row);
    if (selected.length >= target) break;
  }

  return selected;
}
