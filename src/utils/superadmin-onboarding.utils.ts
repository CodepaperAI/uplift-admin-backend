import type { Prisma } from "@prisma/client";

export const ONBOARDING_FOLLOW_UP_HOURS = 24;
export const ONBOARDING_QUESTION_COUNT = 6;

export const ONBOARDING_STEPS = [
  { key: "welcome", label: "Welcome" },
  { key: "website", label: "Website" },
  { key: "services", label: "Services" },
  { key: "brand", label: "Brand" },
  { key: "questions", label: "Marketing questions" },
  { key: "contact", label: "Contact details" },
  { key: "author", label: "Author profile" },
  { key: "review", label: "Review" },
  { key: "preview", label: "Content preview" },
  { key: "payment", label: "Payment" },
  { key: "complete", label: "Complete" },
] as const;

export type AdminOnboardingState =
  | "not_started"
  | "in_progress"
  | "completed"
  | "failed";

export type AdminOnboardingFilter =
  | AdminOnboardingState
  | "needs_follow_up";

type DateLike = Date | string | null | undefined;

export type QuickScrapeOnboardingInput = {
  id: string;
  businessName: string | null;
  businessWebsiteUrl: string | null;
  detectedServices: string[];
  selectedServices: string[];
  onboardingV2Flow: string;
  onboardingV2Step: string;
  onboardingV2QuestionIndex: number;
  onboardingV2Status: string;
  onboardingV2LastSeenAt: DateLike;
  onboardingV2GenerationStartedAt: DateLike;
  onboardingV2BusinessId: string | null;
  onboardingV2BlogId: string | null;
  onboardingV2SocialRunId: string | null;
  onboardingV2BlogStatus: string;
  onboardingV2SocialStatus: string;
  onboardingV2GenerationError: Prisma.JsonValue | null;
  onboardingV2CompletedAt: DateLike;
  onboardingV2SelectedPlanTier: string | null;
  contactDetailsConfirmedAt: DateLike;
  createdAt: DateLike;
  updatedAt: DateLike;
};

export type TrialOnboardingInput = {
  onboardingStartedAt: DateLike;
  onboardingCompletedAt: DateLike;
  quickScrapeCompletedAt: DateLike;
  servicesSelectedAt: DateLike;
  trialEnrolledAt: DateLike;
};

export type BusinessOnboardingInput = {
  id: string;
  businessName: string;
  businessWebsiteUrl: string;
  isPrimary: boolean;
  isActive: boolean;
  websiteStatus: string;
  onboardingFlow: string | null;
  onboardingStatus: string;
  onboardingAttemptCount: number;
  onboardingLastAttemptAt: DateLike;
  onboardingCompletedAt: DateLike;
  onboardingLastError: Prisma.JsonValue | null;
  secondaryDetailsConfirmed: boolean;
  keywordGenerationStatus: string;
  keywordGenerationStartedAt: DateLike;
  keywordGenerationCompletedAt: DateLike;
  createdAt: DateLike;
  updatedAt: DateLike;
};

export type AdminOnboardingSummary = {
  state: AdminOnboardingState;
  stateLabel: string;
  currentStep: string;
  currentStepLabel: string;
  questionPosition: number | null;
  questionCount: number | null;
  progressPercent: number;
  flow: string | null;
  flowLabel: string | null;
  lastActivityAt: string | null;
  inactiveHours: number | null;
  needsFollowUp: boolean;
  followUpReason: string | null;
  sessionCount: number;
};

export type AdminOnboardingSession = {
  id: string;
  businessName: string | null;
  businessWebsiteUrl: string | null;
  flow: string;
  flowLabel: string;
  status: string;
  state: AdminOnboardingState;
  currentStep: string;
  currentStepLabel: string;
  questionPosition: number | null;
  questionCount: number | null;
  progressPercent: number;
  lastActivityAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  detectedServiceCount: number;
  selectedServiceCount: number;
  selectedPlanTier: string | null;
  generation: {
    startedAt: string | null;
    blogStatus: string;
    socialStatus: string;
    businessId: string | null;
    blogId: string | null;
    socialRunId: string | null;
    error: { code: string | null; stage: string | null } | null;
  };
};

export type AdminBusinessOnboarding = {
  id: string;
  businessName: string;
  businessWebsiteUrl: string;
  isPrimary: boolean;
  isActive: boolean;
  websiteStatus: string;
  flow: string | null;
  flowLabel: string | null;
  status: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  completedAt: string | null;
  secondaryDetailsConfirmed: boolean;
  keywordGenerationStatus: string;
  keywordGenerationStartedAt: string | null;
  keywordGenerationCompletedAt: string | null;
  error: { code: string | null; stage: string | null } | null;
};

export type AdminOnboardingTimelineEntry = {
  key: string;
  label: string;
  status: "completed" | "current" | "pending" | "failed";
  timestamp: string | null;
};

export type AdminOnboardingBreakdown = {
  summary: AdminOnboardingSummary;
  sessions: AdminOnboardingSession[];
  businesses: AdminBusinessOnboarding[];
  timeline: AdminOnboardingTimelineEntry[];
  followUpThresholdHours: number;
};

function toIso(value: DateLike): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIso(...values: DateLike[]): string | null {
  return values
    .map(toIso)
    .filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function flowLabel(flow: string | null): string | null {
  if (flow === "trial_primary") return "Primary business";
  if (flow === "website_secondary") return "Additional website";
  return flow ? flow.replaceAll("_", " ") : null;
}

function stateLabel(state: AdminOnboardingState): string {
  if (state === "not_started") return "Not started";
  if (state === "in_progress") return "In progress";
  if (state === "completed") return "Completed";
  return "Failed";
}

function normalizedStep(step: string): (typeof ONBOARDING_STEPS)[number]["key"] {
  return ONBOARDING_STEPS.some((item) => item.key === step)
    ? (step as (typeof ONBOARDING_STEPS)[number]["key"])
    : "website";
}

function stepDetails(step: string, questionIndex: number) {
  const key = normalizedStep(step);
  const index = ONBOARDING_STEPS.findIndex((item) => item.key === key);
  const baseLabel = ONBOARDING_STEPS[index]?.label ?? "Website";
  const questionPosition =
    key === "questions"
      ? Math.min(ONBOARDING_QUESTION_COUNT, Math.max(1, questionIndex + 1))
      : null;
  const label = questionPosition
    ? `${baseLabel} (${questionPosition} of ${ONBOARDING_QUESTION_COUNT})`
    : baseLabel;
  const baseProgress = (index / (ONBOARDING_STEPS.length - 1)) * 100;
  const questionProgress =
    key === "questions" && questionPosition
      ? (questionPosition / ONBOARDING_QUESTION_COUNT) *
        (100 / (ONBOARDING_STEPS.length - 1))
      : 0;

  return {
    key,
    label,
    questionPosition,
    questionCount: questionPosition ? ONBOARDING_QUESTION_COUNT : null,
    progressPercent: Math.min(100, Math.round(baseProgress + questionProgress)),
  };
}

function safeError(
  value: Prisma.JsonValue | null,
): { code: string | null; stage: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.errorCode === "string"
        ? record.errorCode
        : null;
  const stage = typeof record.stage === "string" ? record.stage : null;
  return code || stage ? { code, stage } : null;
}

function sessionState(session: QuickScrapeOnboardingInput): AdminOnboardingState {
  if (session.onboardingV2Status === "failed") return "failed";
  if (
    session.onboardingV2Status === "completed" ||
    session.onboardingV2CompletedAt
  ) {
    return "completed";
  }
  return "in_progress";
}

function serializeSession(
  session: QuickScrapeOnboardingInput,
): AdminOnboardingSession {
  const state = sessionState(session);
  const step = stepDetails(
    state === "completed" ? "complete" : session.onboardingV2Step,
    session.onboardingV2QuestionIndex,
  );
  return {
    id: session.id,
    businessName: session.businessName,
    businessWebsiteUrl: session.businessWebsiteUrl,
    flow: session.onboardingV2Flow,
    flowLabel: flowLabel(session.onboardingV2Flow) ?? "Onboarding",
    status: session.onboardingV2Status,
    state,
    currentStep: step.key,
    currentStepLabel: step.label,
    questionPosition: step.questionPosition,
    questionCount: step.questionCount,
    progressPercent: state === "completed" ? 100 : step.progressPercent,
    lastActivityAt: latestIso(
      session.onboardingV2LastSeenAt,
      session.updatedAt,
      session.createdAt,
    ),
    createdAt: toIso(session.createdAt),
    completedAt: toIso(session.onboardingV2CompletedAt),
    detectedServiceCount: session.detectedServices.length,
    selectedServiceCount: session.selectedServices.length,
    selectedPlanTier: session.onboardingV2SelectedPlanTier,
    generation: {
      startedAt: toIso(session.onboardingV2GenerationStartedAt),
      blogStatus: session.onboardingV2BlogStatus,
      socialStatus: session.onboardingV2SocialStatus,
      businessId: session.onboardingV2BusinessId,
      blogId: session.onboardingV2BlogId,
      socialRunId: session.onboardingV2SocialRunId,
      error: safeError(session.onboardingV2GenerationError),
    },
  };
}

function serializeBusiness(
  business: BusinessOnboardingInput,
): AdminBusinessOnboarding {
  return {
    id: business.id,
    businessName: business.businessName,
    businessWebsiteUrl: business.businessWebsiteUrl,
    isPrimary: business.isPrimary,
    isActive: business.isActive,
    websiteStatus: business.websiteStatus,
    flow: business.onboardingFlow,
    flowLabel: flowLabel(business.onboardingFlow),
    status: business.onboardingStatus,
    attemptCount: business.onboardingAttemptCount,
    lastAttemptAt: toIso(business.onboardingLastAttemptAt),
    completedAt: toIso(business.onboardingCompletedAt),
    secondaryDetailsConfirmed: business.secondaryDetailsConfirmed,
    keywordGenerationStatus: business.keywordGenerationStatus,
    keywordGenerationStartedAt: toIso(business.keywordGenerationStartedAt),
    keywordGenerationCompletedAt: toIso(
      business.keywordGenerationCompletedAt,
    ),
    error: safeError(business.onboardingLastError),
  };
}

function timelineFromSession(
  session: AdminOnboardingSession,
): AdminOnboardingTimelineEntry[] {
  const currentIndex = ONBOARDING_STEPS.findIndex(
    (step) => step.key === session.currentStep,
  );
  return ONBOARDING_STEPS.map((step, index) => {
    const completed = session.state === "completed" || index < currentIndex;
    const current = index === currentIndex && session.state !== "completed";
    return {
      key: step.key,
      label:
        step.key === "questions" && session.questionPosition
          ? `${step.label} (${session.questionPosition} of ${ONBOARDING_QUESTION_COUNT})`
          : step.label,
      status: completed
        ? "completed"
        : current && session.state === "failed"
          ? "failed"
          : current
            ? "current"
            : "pending",
      timestamp:
        step.key === "welcome"
          ? session.createdAt
          : step.key === "complete"
            ? session.completedAt
            : current
              ? session.lastActivityAt
              : null,
    };
  });
}

function timelineFromLegacy(
  trial: TrialOnboardingInput | null,
): AdminOnboardingTimelineEntry[] {
  const milestones = [
    ["welcome", "Onboarding started", trial?.onboardingStartedAt],
    ["website", "Website scanned", trial?.quickScrapeCompletedAt],
    ["services", "Services selected", trial?.servicesSelectedAt],
    ["payment", "Trial enrolled", trial?.trialEnrolledAt],
    ["complete", "Onboarding completed", trial?.onboardingCompletedAt],
  ] as const;
  const firstIncomplete = milestones.findIndex(([, , timestamp]) => !timestamp);
  return milestones.map(([key, label, timestamp], index) => ({
    key,
    label,
    status: timestamp
      ? "completed"
      : firstIncomplete === index
        ? "current"
        : "pending",
    timestamp: toIso(timestamp),
  }));
}

function legacyStep(trial: TrialOnboardingInput | null) {
  if (trial?.onboardingCompletedAt) return stepDetails("complete", 0);
  if (trial?.trialEnrolledAt) return stepDetails("payment", 0);
  if (trial?.servicesSelectedAt) return stepDetails("services", 0);
  if (trial?.quickScrapeCompletedAt) return stepDetails("website", 0);
  return stepDetails("welcome", 0);
}

export function buildAdminOnboardingBreakdown(input: {
  accountCreatedAt: DateLike;
  accountOnboardingComplete: boolean;
  followUpEligible?: boolean;
  now?: Date;
  sessions: QuickScrapeOnboardingInput[];
  trial: TrialOnboardingInput | null;
  businesses: BusinessOnboardingInput[];
}): AdminOnboardingBreakdown {
  const now = input.now ?? new Date();
  const sessions = input.sessions
    .map(serializeSession)
    .sort((a, b) =>
      (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0) -
      (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0),
    );
  const unfinishedSession = sessions.find(
    (session) => session.state !== "completed",
  );
  const selectedSession = unfinishedSession ?? sessions[0] ?? null;
  const failedBusiness = input.businesses.find(
    (business) => business.onboardingStatus === "failed",
  );
  const activeBusinessSetup = input.businesses.find((business) =>
    ["queued", "running", "awaiting_confirmation"].includes(
      business.onboardingStatus,
    ),
  );
  const hasCompletedBusiness = input.businesses.some(
    (business) => business.onboardingStatus === "completed",
  );
  const hasLegacyStart = Boolean(input.trial?.onboardingStartedAt);
  const hasCompletedLegacy = Boolean(input.trial?.onboardingCompletedAt);

  let state: AdminOnboardingState;
  let currentStep: ReturnType<typeof stepDetails>;
  let currentStepLabelOverride: string | null = null;
  let selectedFlow: string | null = null;
  let lastActivityAt: string | null;

  if (selectedSession && selectedSession.state !== "completed") {
    state = selectedSession.state;
    currentStep = stepDetails(
      selectedSession.currentStep,
      (selectedSession.questionPosition ?? 1) - 1,
    );
    selectedFlow = selectedSession.flow;
    lastActivityAt = selectedSession.lastActivityAt;
  } else if (failedBusiness) {
    state = "failed";
    currentStep = stepDetails("website", 0);
    currentStepLabelOverride = "Business setup";
    selectedFlow = failedBusiness.onboardingFlow;
    lastActivityAt = latestIso(
      failedBusiness.onboardingLastAttemptAt,
      failedBusiness.updatedAt,
    );
  } else if (activeBusinessSetup) {
    state = "in_progress";
    currentStep = stepDetails("website", 0);
    currentStepLabelOverride = "Business setup";
    selectedFlow = activeBusinessSetup.onboardingFlow;
    lastActivityAt = latestIso(
      activeBusinessSetup.onboardingLastAttemptAt,
      activeBusinessSetup.updatedAt,
    );
  } else if (
    selectedSession?.state === "completed" ||
    input.accountOnboardingComplete ||
    hasCompletedLegacy ||
    hasCompletedBusiness
  ) {
    state = "completed";
    currentStep = stepDetails("complete", 0);
    selectedFlow = selectedSession?.flow ?? null;
    lastActivityAt = latestIso(
      selectedSession?.completedAt,
      input.trial?.onboardingCompletedAt,
      ...input.businesses.map((business) => business.onboardingCompletedAt),
    );
  } else if (hasLegacyStart) {
    state = "in_progress";
    currentStep = legacyStep(input.trial);
    lastActivityAt = latestIso(
      input.trial?.onboardingCompletedAt,
      input.trial?.trialEnrolledAt,
      input.trial?.servicesSelectedAt,
      input.trial?.quickScrapeCompletedAt,
      input.trial?.onboardingStartedAt,
    );
  } else {
    state = "not_started";
    currentStep = stepDetails("welcome", 0);
    lastActivityAt = toIso(input.accountCreatedAt);
  }

  const inactiveHours = lastActivityAt
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(lastActivityAt)) / 3_600_000))
    : null;
  const followUpEligible = input.followUpEligible ?? true;
  const needsFollowUp =
    followUpEligible &&
    (state === "failed" ||
      (state !== "completed" &&
        inactiveHours !== null &&
        inactiveHours >= ONBOARDING_FOLLOW_UP_HOURS));
  const currentStepLabel = currentStepLabelOverride ?? currentStep.label;
  const followUpReason = !needsFollowUp
    ? null
    : state === "failed"
      ? `${currentStepLabel} failed and needs review.`
      : state === "not_started"
        ? `Account has not started onboarding after ${inactiveHours} hours.`
        : `Stopped at ${currentStepLabel} for ${inactiveHours} hours.`;

  const summary: AdminOnboardingSummary = {
    state,
    stateLabel: stateLabel(state),
    currentStep: currentStep.key,
    currentStepLabel,
    questionPosition: currentStep.questionPosition,
    questionCount: currentStep.questionCount,
    progressPercent: state === "completed" ? 100 : currentStep.progressPercent,
    flow: selectedFlow,
    flowLabel: flowLabel(selectedFlow),
    lastActivityAt,
    inactiveHours,
    needsFollowUp,
    followUpReason,
    sessionCount: sessions.length,
  };

  return {
    summary,
    sessions,
    businesses: input.businesses.map(serializeBusiness),
    timeline: selectedSession
      ? timelineFromSession(selectedSession)
      : timelineFromLegacy(input.trial),
    followUpThresholdHours: ONBOARDING_FOLLOW_UP_HOURS,
  };
}
