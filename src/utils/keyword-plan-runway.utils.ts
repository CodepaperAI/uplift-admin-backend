import { isPlatformStaffSubscriptionBypassRole } from "./platform-role.utils";

export const KEYWORD_RUNWAY_TARGET = 30;
export const KEYWORD_RUNWAY_TOP_UP_THRESHOLD = 7;
// The keyword worker has a 30-minute hard finish timeout. A run that has not
// advanced after this buffer is no longer live and can be safely reconciled.
export const DEFAULT_KEYWORD_GENERATION_STALE_MINUTES = 35;

type KeywordPlanLike = {
  publishDate?: string | Date | null;
  deletedAt?: Date | null;
};

type KeywordTopUpAccessInput = {
  role?: string | null;
  websiteSubscription?:
    | {
        status?: string | null;
        trialStatus?: string | null;
      }
    | null;
  accountSubscription?:
    | {
        status?: string | null;
      }
    | null;
};

export function getTodayPlanDate(now: Date = new Date()): string {
  return now.toISOString().split("T")[0] ?? "";
}

export function normalizePlanDate(
  value: string | Date | null | undefined
): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().split("T")[0] ?? null;
    }

    return null;
  }

  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString().split("T")[0] ?? null;
}

export function isFutureOrTodayKeywordDate(
  publishDate: string | Date | null | undefined,
  today: string = getTodayPlanDate()
): boolean {
  const normalizedDate = normalizePlanDate(publishDate);
  return normalizedDate !== null && normalizedDate >= today;
}

export function countFutureUndeletedKeywordSlots(
  plans: KeywordPlanLike[],
  today: string = getTodayPlanDate()
): number {
  return plans.filter(
    (plan) =>
      !plan.deletedAt && isFutureOrTodayKeywordDate(plan.publishDate ?? null, today)
  ).length;
}

export function getLatestScheduledKeywordDate(
  plans: KeywordPlanLike[]
): string | null {
  let latest: string | null = null;

  for (const plan of plans) {
    if (plan.deletedAt) continue;

    const normalizedDate = normalizePlanDate(plan.publishDate ?? null);
    if (!normalizedDate) continue;

    if (!latest || normalizedDate > latest) {
      latest = normalizedDate;
    }
  }

  return latest;
}

export function hasPaidKeywordTopUpAccess({
  role,
  websiteSubscription,
  accountSubscription,
}: KeywordTopUpAccessInput): boolean {
  if (role && isPlatformStaffSubscriptionBypassRole(role)) {
    return true;
  }

  if (websiteSubscription) {
    return (
      websiteSubscription.status === "active" &&
      websiteSubscription.trialStatus !== "trialing"
    );
  }

  return accountSubscription?.status === "active";
}

export function shouldQueueKeywordTopUp(params: {
  futureKeywordCount: number;
  keywordGenerationStatus?: string | null;
  hasPaidAccess: boolean;
  threshold?: number;
}): boolean {
  if (!params.hasPaidAccess) {
    return false;
  }

  if (
    params.keywordGenerationStatus === "pending" ||
    params.keywordGenerationStatus === "processing"
  ) {
    return false;
  }

  return (
    params.futureKeywordCount <=
    (params.threshold ?? KEYWORD_RUNWAY_TOP_UP_THRESHOLD)
  );
}

export function resolveKeywordGenerationStaleMinutes(
  rawValue: string | undefined = process.env.KEYWORD_GENERATION_STALE_MINUTES
): number {
  if (!rawValue) {
    return DEFAULT_KEYWORD_GENERATION_STALE_MINUTES;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_KEYWORD_GENERATION_STALE_MINUTES;
  }

  return parsed;
}

export function getKeywordGenerationStatusReferenceDate(params: {
  keywordGenerationStartedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): Date | null {
  const rawDate = params.keywordGenerationStartedAt ?? params.updatedAt ?? null;
  if (!rawDate) {
    return null;
  }

  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function isStaleKeywordGeneration(params: {
  keywordGenerationStatus?: string | null;
  keywordGenerationStartedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  now?: Date;
  staleMinutes?: number;
}): boolean {
  if (
    params.keywordGenerationStatus !== "pending" &&
    params.keywordGenerationStatus !== "processing"
  ) {
    return false;
  }

  const referenceDate = getKeywordGenerationStatusReferenceDate(params);
  if (!referenceDate) {
    return true;
  }

  const now = params.now ?? new Date();
  const staleMinutes =
    params.staleMinutes ?? DEFAULT_KEYWORD_GENERATION_STALE_MINUTES;
  const staleMs = staleMinutes * 60 * 1000;

  return now.getTime() - referenceDate.getTime() >= staleMs;
}
