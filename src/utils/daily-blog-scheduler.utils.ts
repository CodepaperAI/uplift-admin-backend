import {
  hasActiveBlogGenerationAccess,
  isBlogGenerationBusinessLifecycleActive,
} from "./blog-generation-access.utils";

export const DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_RUN = 250;
export const DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS = 5;

type DailyBlogAccessUser = {
  role: string;
  trialStatus: string | null;
  trialStartDate?: Date | null;
  trialEndDate: Date | null;
  Subscription: {
    status: string;
  } | null;
};

type DailyBlogAccessBusiness = {
  isActive: boolean;
  websiteStatus: string | null;
  websiteSubscription: {
    status: string;
    trialStatus: string;
    trialStartDate?: Date | null;
    trialEndDate: Date | null;
  } | null;
};

export type DailyBlogSchedulerAccessCandidate = {
  userId: string;
  businessId: string | null;
  user: DailyBlogAccessUser;
  business: DailyBlogAccessBusiness | null;
};

export type DailyBlogSchedulerEligibilityReason =
  | "eligible"
  | "no_access"
  | "no_business"
  | "skipped_legacy_no_business_id";

export function hasDailyBlogGenerationAccess(
  candidate: DailyBlogSchedulerAccessCandidate,
  now: Date,
): boolean {
  return hasActiveBlogGenerationAccess({
    user: candidate.user,
    websiteSubscription: candidate.business?.websiteSubscription ?? null,
    now,
  });
}

export function getDailyBlogSchedulerEligibilityReason(
  candidate: DailyBlogSchedulerAccessCandidate,
  now: Date,
): DailyBlogSchedulerEligibilityReason {
  if (!candidate.businessId) {
    return "skipped_legacy_no_business_id";
  }

  if (
    !candidate.business ||
    !isBlogGenerationBusinessLifecycleActive({
      isActive: candidate.business.isActive,
      websiteStatus: candidate.business.websiteStatus,
      websiteSubscription: candidate.business.websiteSubscription,
      now,
    })
  ) {
    return "no_business";
  }

  return hasDailyBlogGenerationAccess(candidate, now)
    ? "eligible"
    : "no_access";
}

export function prepareDailyBlogSchedulerBatch<
  T extends DailyBlogSchedulerAccessCandidate,
>(
  candidates: T[],
  params: {
    now: Date;
    maxPerRun: number;
    maxPerBusiness: number;
  },
): {
  selected: T[];
  eligibleCandidates: number;
  excludedNoAccess: number;
  excludedNoBusiness: number;
  excludedLegacyNoBusinessId: number;
  skippedByBusinessCap: number;
  skippedByRunCap: number;
  maxPerRun: number;
  maxPerBusiness: number;
} {
  const maxPerRun =
    Number.isFinite(params.maxPerRun) && params.maxPerRun > 0
      ? Math.floor(params.maxPerRun)
      : 1;
  const maxPerBusiness =
    Number.isFinite(params.maxPerBusiness) && params.maxPerBusiness > 0
      ? Math.floor(params.maxPerBusiness)
      : 1;
  const eligible: T[] = [];
  let excludedNoAccess = 0;
  let excludedNoBusiness = 0;
  let excludedLegacyNoBusinessId = 0;

  for (const candidate of candidates) {
    const reason = getDailyBlogSchedulerEligibilityReason(
      candidate,
      params.now,
    );
    if (reason === "eligible") {
      eligible.push(candidate);
    } else if (reason === "no_access") {
      excludedNoAccess += 1;
    } else if (reason === "no_business") {
      excludedNoBusiness += 1;
    } else {
      excludedLegacyNoBusinessId += 1;
    }
  }

  const selected: T[] = [];
  const selectedByBusiness = new Map<string, number>();
  let skippedByBusinessCap = 0;
  let skippedByRunCap = 0;

  // Eligibility must be resolved before either cap is applied. Otherwise an
  // old expired-account backlog can consume the entire run and starve active
  // customers whose candidates sort later.
  for (const candidate of eligible) {
    if (selected.length >= maxPerRun) {
      skippedByRunCap += 1;
      continue;
    }

    const businessKey = candidate.businessId ?? `legacy:${candidate.userId}`;
    const selectedForBusiness = selectedByBusiness.get(businessKey) ?? 0;
    if (selectedForBusiness >= maxPerBusiness) {
      skippedByBusinessCap += 1;
      continue;
    }

    selected.push(candidate);
    selectedByBusiness.set(businessKey, selectedForBusiness + 1);
  }

  return {
    selected,
    eligibleCandidates: eligible.length,
    excludedNoAccess,
    excludedNoBusiness,
    excludedLegacyNoBusinessId,
    skippedByBusinessCap,
    skippedByRunCap,
    maxPerRun,
    maxPerBusiness,
  };
}
