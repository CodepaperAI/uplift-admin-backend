import {
  Prisma,
  PublishStatus,
  STATUS,
  type PrismaClient,
  type WebsitePlanTier,
} from "@prisma/client";
import { Inngest, NonRetriableError, type ClientOptions } from "inngest";
import type StripeSdk from "stripe";
import { createPrismaClient, prisma } from "../config/db.config";
import { updateBlogUrl } from "../config/pinecone.config";
import { generateNewKeywordLLM } from "../llm/keywords/generate-new-keyword.llm";
import {
  buildKeywordPlanForPersistence,
  collectKeywordCandidatesForPlan,
  selectKeywordsForPlan,
  type KeywordCandidateCollectionResult,
  type KeywordCandidateSelectionResult,
  type KeywordPlanBuildResult,
} from "../llm/keywords/keyword.llm";
import { BrandAnalysisService } from "../services/brand-analysis.service";
import {
  canonicalizeRemoteBusinessBrandLogo,
  isCanonicalBunnyBrandLogoUrl,
} from "../services/onboarding-v2-brand-logo.service";
import { ExternalBacklinksService } from "../services/external-backlinks.service";
import { PineconeReindexService } from "../services/pinecone-reindex.service";
import {
  hasActivePaidWebsiteSubscription,
} from "../utils/backlink-access.utils";
import { KeywordAllocationService } from "../services/keyword-allocation.service";
import {
  getActiveAgencyPricingConfigId,
  getAgencyAssignmentForBusiness,
} from "../utils/agency-context.utils";
import { normalizeWebsiteUrl } from "../utils/url-normalizer";
import { syncManagedBacklinksForPublishedBlog } from "../services/managed-backlinks.service";
import {
  savePlanKeywords,
  type PlanKeywordSaveItem,
} from "../utils/plan-keyword-save.utils";
import {
  PublishingService,
  releasePublishLock,
  tryAcquirePublishLock,
} from "../services/publishing.service";
import { getBlogDispatchDecision } from "../utils/publishing-dispatch.utils";
import {
  evaluateScheduleDue,
  getUtcScheduleQueryCeiling,
} from "../utils/blog-schedule.utils";
import {
  buildExtendedBlogMeta,
  extractStoredSeoMeta,
} from "../utils/blog-seo.utils";
import { normalizeCloudinaryImageUrl } from "../lib/cloudinary";
import { sanitizeBlogContentImageSources } from "../utils/blog-image-url.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";
import { getBusinessBacklinkServiceEligibility } from "../utils/backlink-access.utils";
import {
  buildServicesPriorityFromOrder,
  resolveEffectiveServices,
  resolveOrderedSelectedServices,
  resolveServicesPriorityMap,
} from "../utils/effective-services.utils";
import {
  getTodayPlanDate,
  hasPaidKeywordTopUpAccess,
  isStaleKeywordGeneration,
  KEYWORD_RUNWAY_TOP_UP_THRESHOLD,
  resolveKeywordGenerationStaleMinutes,
  shouldQueueKeywordTopUp,
} from "../utils/keyword-plan-runway.utils";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";
import {
  DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS,
  DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_RUN,
  hasDailyBlogGenerationAccess,
  prepareDailyBlogSchedulerBatch,
} from "../utils/daily-blog-scheduler.utils";
import {
  getPrismaErrorMessage,
  isTransientPrismaConnectionError,
  runWithTransientPrismaRetry,
} from "../utils/prisma-resilience.utils";
import {
  chunkArray,
  getPersistedKeywordPlanItems,
} from "../utils/keyword-generation.utils";
import { getGmbReviewWindowStart } from "../utils/gmb-review-window.utils";
import {
  BLOG_PIPELINE_V2_VERSION,
  buildPinnedBlogGenerateEventData,
  generateProductionV2Blog,
  getProductionPublishingHandoffDecision,
  resolvePinnedBlogPipelineVersion,
} from "../services/blog-pipeline-v2";
import { isSocialCreativeGenerationEnabled } from "../services/social-creative/constants";
import { estimateSocialCreativeImageBudget } from "../services/social-creative/pipeline";
import { createOrGetSocialCreativeRun } from "../services/social-creative/repository";
import type { SocialPlatform } from "../services/social-creative/types";
import { createSocialCreativeInngestFunctions } from "./social-creative";
import { createZernioSocialPublishingFunctions } from "./zernio-social-publishing";
import { createContentApprovalNotificationFunctions } from "./content-approval-notifications";
import { invalidateCommandCache } from "../utils/command-cache";
import { clearOnboardingV2GenerationError } from "../utils/onboarding-v2-generation-state";
import {
  lockPrimaryWorkspaceSelection,
  reconcilePrimaryWorkspace,
} from "../services/primary-workspace-reconciliation.service";

const ROLES_EXCLUDED_FROM_TRIAL_LIFECYCLE_EMAILS: Array<
  "ADMIN" | "SUPERADMIN" | "AGENCY_ADMIN"
> = ["ADMIN", "SUPERADMIN", "AGENCY_ADMIN"];

const PRODUCTION_ENVS = new Set(["production", "prod"]);

function getRuntimeEnvironment() {
  return (
    process.env.APP_ENV?.trim() ||
    process.env.DEPLOY_ENV?.trim() ||
    process.env.ENVIRONMENT?.trim() ||
    process.env.NODE_ENV?.trim() ||
    ""
  ).toLowerCase();
}

function envFlag(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function isProductionRuntime() {
  return PRODUCTION_ENVS.has(getRuntimeEnvironment());
}

function isQuickTrialSampleBlog(analytics: unknown): boolean {
  return Boolean(
    analytics &&
      typeof analytics === "object" &&
      !Array.isArray(analytics) &&
      (analytics as Record<string, unknown>).quickTrialSample === true,
  );
}

function getRuntimeEnvironmentDiagnostics() {
  return {
    appEnv: process.env.APP_ENV?.trim() || null,
    deployEnv: process.env.DEPLOY_ENV?.trim() || null,
    environment: process.env.ENVIRONMENT?.trim() || null,
    nodeEnv: process.env.NODE_ENV?.trim() || null,
    resolvedRuntimeEnvironment: getRuntimeEnvironment() || null,
  };
}

function getBackgroundAutomationState(envName: string) {
  const flagValue = envFlag(envName);
  return {
    enabled: flagValue ?? isProductionRuntime(),
    flagName: envName,
    flagValue,
    enabledBy: flagValue === null ? "runtime_environment" : "explicit_flag",
    ...getRuntimeEnvironmentDiagnostics(),
  };
}

function isBackgroundAutomationEnabled(envName: string) {
  return getBackgroundAutomationState(envName).enabled;
}

export const BLOG_GENERATION_WORKER_FLAG =
  "BLOG_GENERATION_WORKER_ENABLED" as const;

export const AUTO_PUBLISH_BLOG_TASK_FLAG =
  "AUTO_PUBLISH_BLOG_TASK_ENABLED" as const;

export const ONBOARDING_V2_PREVIEW_GENERATION_FLAG =
  "ONBOARDING_V2_PREVIEW_GENERATION_ENABLED" as const;

export const ONBOARDING_V2_PREVIEW_PLATFORMS: SocialPlatform[] = [
  "instagram",
  "facebook",
  "linkedin",
  "x",
];

export function isOnboardingV2PreviewGenerationEnabled(): boolean {
  return envFlag(ONBOARDING_V2_PREVIEW_GENERATION_FLAG) === true;
}

export function onboardingV2PreviewIdempotencyKey(
  quickBusinessId: string,
  revision: number,
  kind: "blog" | "social",
): string {
  return `onboarding-v2:${quickBusinessId}:r${revision}:${kind}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validPublicAssetUrl(value: unknown): string | null {
  const raw = boundedString(value, 2_000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function colorList(...values: unknown[]): string[] {
  const strings = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return [];
  });
  return [
    ...new Set(
      strings
        .map((value) =>
          typeof value === "string"
            ? value.trim()
            : optionalString(recordValue(value).hex, recordValue(value).value),
        )
        .filter(
          (value): value is string =>
            Boolean(value) &&
            /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(
              value ?? "",
            ),
        ),
    ),
  ].slice(0, 12);
}

function firstAssetUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const record = recordValue(candidate);
      const url = validPublicAssetUrl(
        typeof candidate === "string"
          ? candidate
          : record.url ?? record.src ?? record.imageUrl,
      );
      if (url) return url;
    }
  }
  return null;
}

function positiveSchemaVersion(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export type OnboardingV2BrandAnalysisData = {
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  logoAltText: string | null;
  faviconUrl: string | null;
  referenceImageUrl: string | null;
  analysisVersion: string;
  slogan: string | null;
  identityRetrievedAt: Date | null;
};

export function buildOnboardingV2BrandAnalysisData(
  brandContext: unknown,
): OnboardingV2BrandAnalysisData | null {
  const root = recordValue(brandContext);
  const snapshot = recordValue(root.snapshot ?? root.data ?? root.context);
  const retrieveEnvelope = recordValue(
    root.brandRetrieve ??
      root.brand_retrieve ??
      snapshot.brandRetrieve ??
      snapshot.brand_retrieve,
  );
  const brand = recordValue(
    retrieveEnvelope.brand ?? root.brand ?? root.brandIdentity ?? snapshot.brand,
  );
  const typography = recordValue(
    root.typography ?? root.fonts ?? brand.typography ?? brand.fonts,
  );
  const logo = recordValue(root.logo ?? brand.logo);
  const logos = [
    ...(Array.isArray(root.logos) ? root.logos : []),
    ...(Array.isArray(brand.logos) ? brand.logos : []),
  ];
  const firstLogo =
    logos.find(
      (value) =>
        recordValue(value).type === "logo" && Boolean(firstAssetUrl(value)),
    ) ??
    logos.find(
      (value) =>
        (typeof value === "string" && Boolean(validPublicAssetUrl(value))) ||
        Boolean(firstAssetUrl(value)),
    );
  const palette = recordValue(root.palette ?? brand.palette);
  let primaryColors = colorList(
    root.primaryColors,
    brand.primaryColors,
    palette.primary,
  );
  let secondaryColors = colorList(
    root.secondaryColors,
    brand.secondaryColors,
    palette.secondary,
    palette.accent,
  );
  if (primaryColors.length === 0 && secondaryColors.length === 0) {
    const colors = colorList(root.colors, brand.colors, palette);
    primaryColors = colors.slice(0, 2);
    secondaryColors = colors.slice(2);
  }
  const logoUrl = firstAssetUrl(
    root.logoUrl,
    root.logo_url,
    brand.logoUrl,
    brand.logo_url,
    logo,
    firstLogo,
  );
  const fontFamily = boundedString(
    optionalString(
      root.fontFamily,
      brand.fontFamily,
      typography.fontFamily,
      typography.primaryFont,
      typography.headingFont,
    ),
    160,
  );
  const faviconUrl = firstAssetUrl(root.faviconUrl, brand.faviconUrl);
  const referenceImageUrl = firstAssetUrl(
    root.referenceImageUrl,
    root.referenceImage,
    brand.referenceImageUrl,
    brand.referenceImage,
    root.backdrop,
    root.backdrops,
    brand.backdrop,
    brand.backdrops,
  );
  if (
    !logoUrl &&
    !fontFamily &&
    primaryColors.length === 0 &&
    secondaryColors.length === 0 &&
    !faviconUrl &&
    !referenceImageUrl
  ) {
    return null;
  }
  const provenance = recordValue(root.provenance ?? snapshot.provenance);
  const schemaVersion =
    positiveSchemaVersion(root.schemaVersion ?? snapshot.schemaVersion) ?? 1;
  const isContextDevBrandRetrieve =
    boundedString(provenance.identitySource, 120) ===
    "context.dev.brand.retrieve";
  const retrievedAtValue = boundedString(provenance.identityRetrievedAt, 100);
  const retrievedAt = retrievedAtValue ? new Date(retrievedAtValue) : null;
  return {
    primaryColors,
    secondaryColors,
    fontFamily,
    logoUrl,
    logoAltText: boundedString(
      optionalString(
        root.logoAltText,
        brand.logoAltText,
        logo.alt,
        recordValue(firstLogo).alt,
      ),
      300,
    ),
    faviconUrl,
    referenceImageUrl,
    analysisVersion: isContextDevBrandRetrieve
      ? `onboarding-v2-context-dev-brand-v${schemaVersion}`
      : schemaVersion > 1
        ? `onboarding-v2-context-v${schemaVersion}`
        : "onboarding-v2-context-v1",
    slogan: boundedString(root.slogan ?? brand.slogan, 300),
    identityRetrievedAt:
      retrievedAt && Number.isFinite(retrievedAt.getTime()) ? retrievedAt : null,
  };
}

export function isOnboardingV2Unfinished(
  status: string,
  completedAt: Date | string | null,
): boolean {
  return (
    completedAt === null &&
    !["complete", "completed"].includes(status.trim().toLowerCase())
  );
}

export function selectOnboardingV2PreviewTopic(input: {
  selectedServices: string[];
  detectedServices: string[];
  businessType: string;
  businessName: string;
}): string {
  return (
    [...input.selectedServices, ...input.detectedServices]
      .map((value) => value.trim())
      .find(Boolean) ||
    input.businessType.trim() ||
    input.businessName.trim()
  );
}

/**
 * Runtime kill switch shared by every full blog-generation entry point.
 *
 * Explicit true/false values always win. When unset, the worker remains
 * enabled in every environment so this kill switch does not silently break
 * existing manual/local generation. Scheduled fan-out retains its separate
 * production-aware DAILY_BLOG_SCHEDULER_ENABLED gate.
 */
export function getBlogGenerationWorkerState() {
  const state = getBackgroundAutomationState(BLOG_GENERATION_WORKER_FLAG);
  if (state.flagValue !== null) return state;
  return {
    ...state,
    enabled: true,
    enabledBy: "default_enabled" as const,
  };
}

/**
 * Task-entry kill switch for queued CMS publishing events.
 *
 * Disabling the hourly publishing scanner prevents new fan-out, but an event
 * that was queued before the scanner stopped can still reach this worker.
 * This independent gate is checked before any step, database read, lock, or
 * external publishing call so recovery imports can remain safely draft-only.
 */
export function getAutoPublishBlogTaskState() {
  return getBackgroundAutomationState(AUTO_PUBLISH_BLOG_TASK_FLAG);
}

export function getBlogGenerationPausedResult(
  context: Record<string, unknown> = {},
) {
  return {
    success: true,
    skipped: true,
    paused: true,
    status: "paused" as const,
    message: "Blog generation paused",
    reason: "blog_generation_worker_disabled",
    ...context,
  };
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const INNGEST_ONBOARDING_CONCURRENCY = getPositiveIntegerEnv(
  "INNGEST_ONBOARDING_CONCURRENCY",
  20,
);
export const INNGEST_BLOG_GENERATION_CONCURRENCY = getPositiveIntegerEnv(
  "INNGEST_BLOG_GENERATION_CONCURRENCY",
  10,
);
export const INNGEST_BLOG_GENERATION_PER_BUSINESS_CONCURRENCY =
  getPositiveIntegerEnv(
    "INNGEST_BLOG_GENERATION_PER_BUSINESS_CONCURRENCY",
    2,
  );
export const INNGEST_BRAND_ANALYSIS_CONCURRENCY = getPositiveIntegerEnv(
  "INNGEST_BRAND_ANALYSIS_CONCURRENCY",
  5,
);
export const INNGEST_ONBOARDING_PRIORITY_SECONDS = Math.min(
  getPositiveIntegerEnv("INNGEST_ONBOARDING_PRIORITY_SECONDS", 600),
  600,
);

const INNGEST_ONBOARDING_QUEUE_KEY = '"uplift-onboarding"';
const INNGEST_BLOG_GENERATION_QUEUE_KEY = '"uplift-blog-generation"';

function onboardingFlowControl(perCustomerKey: string) {
  return {
    priority: { run: String(INNGEST_ONBOARDING_PRIORITY_SECONDS) },
    concurrency: [
      {
        scope: "env" as const,
        key: INNGEST_ONBOARDING_QUEUE_KEY,
        limit: INNGEST_ONBOARDING_CONCURRENCY,
      },
      {
        scope: "fn" as const,
        key: perCustomerKey,
        limit: 1,
      },
    ] as const,
  };
}

function blogGenerationFlowControl() {
  return {
    concurrency: [
      {
        scope: "env" as const,
        key: INNGEST_BLOG_GENERATION_QUEUE_KEY,
        limit: INNGEST_BLOG_GENERATION_CONCURRENCY,
      },
      {
        scope: "fn" as const,
        key: "event.data.businessId",
        limit: INNGEST_BLOG_GENERATION_PER_BUSINESS_CONCURRENCY,
      },
    ] as const,
  };
}

const inngestSigningKey = process.env.INNGEST_SIGNING_KEY?.trim();
const inngestOpts: ClientOptions = {
  id: "seo-be",
  isDev: Boolean(
    process.env.NODE_ENV === "development" ||
    process.env.INNGEST_DEV === "true",
  ),
  ...(inngestSigningKey ? { signingKey: inngestSigningKey } : {}),
};
export const inngest = new Inngest(inngestOpts);

type LegacyInngestTrigger = { event: string } | { cron: string };
type LegacyInngestTriggers =
  | LegacyInngestTrigger
  | LegacyInngestTrigger[];

function createInngestFunction(
  rawOptions: { id: string; [key: string]: unknown },
  trigger: LegacyInngestTriggers,
  handler: (...args: any[]) => Promise<unknown>,
) {
  return inngest.createFunction(
    {
      ...rawOptions,
      triggers: trigger,
    },
    handler,
  );
}

type ScheduledBusiness = {
  id: string;
  businessName: string | null;
  isActive: boolean;
  websiteStatus: string | null;
  defaultLocale: string | null;
  businessCountry: string | null;
  businessState: string | null;
  businessCity: string | null;
  websiteSubscription: {
    status: string;
    trialStatus: string;
    trialEndDate: Date | null;
  } | null;
};

type ScheduledAccessUser = {
  role: string;
  trialStatus: string | null;
  trialStartDate: Date | null;
  trialEndDate: Date | null;
  Subscription: {
    status: string;
  } | null;
};

type KeywordGenerationCandidate = {
  id: string;
  userId: string;
  keyword: string;
  publishDate: string;
  publishTime: string;
  blogId: string | null;
  businessId: string | null;
  user: ScheduledAccessUser;
  business: ScheduledBusiness | null;
};

async function getKeywordGenerationCandidates(params?: {
  userId?: string;
  businessId?: string;
  now?: Date;
}): Promise<KeywordGenerationCandidate[]> {
  const now = params?.now ?? new Date();

  return prisma.plan.findMany({
    where: {
      ...(params?.userId ? { userId: params.userId } : {}),
      ...(params?.businessId ? { businessId: params.businessId } : {}),
      publishDate: {
        lte: getUtcScheduleQueryCeiling(now, 0),
      },
      deletedAt: null,
      blogId: null,
      isUsed: false,
      usedAt: null,
    },
    select: {
      id: true,
      userId: true,
      keyword: true,
      publishDate: true,
      publishTime: true,
      blogId: true,
      businessId: true,
      user: {
        select: {
          role: true,
          trialStatus: true,
          trialStartDate: true,
          trialEndDate: true,
          Subscription: {
            select: {
              status: true,
            },
          },
        },
      },
      business: {
        select: {
          id: true,
          businessName: true,
          isActive: true,
          websiteStatus: true,
          defaultLocale: true,
          businessCountry: true,
          businessState: true,
          businessCity: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              trialStartDate: true,
              trialEndDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ publishDate: "asc" }, { publishTime: "asc" }],
  });
}

async function disconnectKeywordRetryPrismaClient(
  dbClient: PrismaClient,
  operationName: string,
): Promise<void> {
  try {
    await dbClient.$disconnect();
  } catch (error) {
    console.warn(
      `[KeywordGeneration] Failed to disconnect retry Prisma client for ${operationName}: ${getPrismaErrorMessage(
        error,
      )}`,
    );
  }
}

async function runKeywordPrismaRetry<T>(
  operationName: string,
  operation: (dbClient: PrismaClient, attempt: number) => Promise<T>,
): Promise<T> {
  return runWithTransientPrismaRetry(
    async (attempt) => {
      const dbClient = createPrismaClient();

      try {
        await dbClient.$connect();
        return await operation(dbClient, attempt);
      } finally {
        await disconnectKeywordRetryPrismaClient(dbClient, operationName);
      }
    },
    {
      operationName,
      maxAttempts: 3,
      retryDelayMs: 250,
      onRetry: ({ attempt, nextAttempt, error }) => {
        console.warn(
          `[KeywordGeneration] Transient Prisma connection error during ${operationName} on attempt ${attempt}; retrying attempt ${nextAttempt}. ${getPrismaErrorMessage(
            error,
          )}`,
        );
      },
    },
  );
}

async function countActiveKeywordPlansWithRetry(params: {
  userId: string;
  businessId: string;
}): Promise<number> {
  return runKeywordPrismaRetry(
    `countActiveKeywordPlans:${params.businessId}`,
    async (dbClient) =>
      dbClient.plan.count({
        where: {
          userId: params.userId,
          businessId: params.businessId,
          deletedAt: null,
        },
      }),
  );
}

async function updateKeywordGenerationStatusWithRetry(params: {
  businessId: string;
  userId: string;
  status: "completed" | "failed";
}): Promise<void> {
  await runKeywordPrismaRetry(
    `updateKeywordGenerationStatus:${params.businessId}:${params.status}`,
    async (dbClient) => {
      await dbClient.business.updateMany({
        where: {
          id: params.businessId,
          userId: params.userId,
        },
        data: {
          keywordGenerationStatus: params.status,
          keywordGenerationCompletedAt: new Date(),
        },
      });
    },
  );
  await Promise.all([
    invalidateTenantCache(params.userId),
    invalidateTenantCache(params.userId, params.businessId),
  ]);
}

type KeywordGenerationStageTiming = {
  stage: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  counts?: Record<string, number>;
};

type KeywordGenerationLoadedContext = {
  cancelled?: boolean;
  message?: string;
  businessId: string;
  userId: string;
  businessDisplayName: string;
  businessInfo: any;
  lastKeywords: Array<{ keyword: string; publishDate?: string | Date | null }>;
  existingKeywordCountBefore: number;
  keywordGenerationMode: "llm_first" | "dataforseo_ai";
  timing: KeywordGenerationStageTiming;
};

type KeywordGenerationSaveStage = {
  savedCount: number;
  skippedCount: number;
  skippedDetails: Array<{ keyword: string; date: string; reason: string }>;
  persistedPlanItems: KeywordPlanBuildResult["keywordPlanToSave"];
  fallbackReason: string | null;
  method: string;
  timing: KeywordGenerationStageTiming;
};

type KeywordGenerationAllocationStage = {
  allocatedCount: number;
  attemptedCount: number;
  failures: Array<{ keyword: string; error: string }>;
  timing: KeywordGenerationStageTiming;
};

type KeywordGenerationFinalizeStage = {
  verifiedKeywordCount: number;
  expectedKeywordCountAfterSave: number;
  timing: KeywordGenerationStageTiming;
};

type KeywordGenerationFirstBlogStage = {
  triggered: boolean;
  keywordId: string | null;
  keyword: string | null;
  reason?: string;
  timing: KeywordGenerationStageTiming;
};

const KEYWORD_GENERATION_STARTABLE_STATUSES = [
  "pending",
  "failed",
] as const;

export const KEYWORD_GENERATION_FINISH_TIMEOUT = "30m";
export const KEYWORD_GENERATION_RECOVERY_CRON = "*/5 * * * *";

function createKeywordStageTiming(params: {
  stage: string;
  startedAt: Date;
  startMs: number;
  counts?: Record<string, number>;
}): KeywordGenerationStageTiming {
  const endedAt = new Date();

  return {
    stage: params.stage,
    startedAt: params.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - params.startMs,
    ...(params.counts ? { counts: params.counts } : {}),
  };
}

export const generateKeywordsTask = createInngestFunction(
  {
    id: "generate-keywords",
    timeouts: { finish: KEYWORD_GENERATION_FINISH_TIMEOUT },
    singleton: { key: "event.data.businessId", mode: "skip" },
  },
  { event: "keywords/generate" },
  async ({ event, step }) => {
    const {
      userId,
      businessId,
      triggerFirstBlog = true,
      isTopUp = false,
    } = event.data as {
      userId: string;
      businessId: string;
      triggerFirstBlog?: boolean;
      isTopUp?: boolean;
    };

    let existingKeywordCountBefore = 0;
    let savedKeywordCount = 0;
    let completedBusinessId = businessId;
    let businessDisplayName = businessId;
    let finalizedKeywordGeneration = false;

    try {
      if (!businessId) {
        throw new Error("businessId is required for keyword generation");
      }

      console.log(
        `🔄 Starting keyword generation for user ${userId}, business ${businessId}`,
      );

      const loadContext = await step.run(
        "load-keyword-context",
        async (): Promise<KeywordGenerationLoadedContext> => {
          const startedAt = new Date();
          const startMs = Date.now();

          console.log(
            `🧱 [KeywordGeneration] load-keyword-context:start user=${userId} business=${businessId}`,
          );

          const currentBusiness = await prisma.business.findUnique({
            where: { id: businessId, userId, isActive: true },
            select: {
              keywordGenerationStatus: true,
              keywordGenerationStartedAt: true,
            },
          });

          const currentKeywordGenerationStatus =
            currentBusiness?.keywordGenerationStatus;
          if (
            !currentKeywordGenerationStatus ||
            !KEYWORD_GENERATION_STARTABLE_STATUSES.includes(
              currentKeywordGenerationStatus as (typeof KEYWORD_GENERATION_STARTABLE_STATUSES)[number],
            )
          ) {
            const timing = createKeywordStageTiming({
              stage: "load-keyword-context",
              startedAt,
              startMs,
            });

            console.log(
              `⏭️ [KeywordGeneration] load-keyword-context:skip user=${userId} business=${businessId} status=${currentBusiness?.keywordGenerationStatus}`,
            );

            return {
              cancelled: true,
              message: `Skipped - status is ${currentBusiness?.keywordGenerationStatus}`,
              businessId,
              userId,
              businessDisplayName: businessId,
              businessInfo: null,
              lastKeywords: [],
              existingKeywordCountBefore: 0,
              keywordGenerationMode:
                process.env.KEYWORD_GENERATION_MODE?.toLowerCase() === "llm_first"
                  ? "llm_first"
                  : "dataforseo_ai",
              timing,
            };
          }

          const updatedBusiness = await prisma.business.updateMany({
            where: {
              id: businessId,
              userId,
              keywordGenerationStatus: {
                in: [...KEYWORD_GENERATION_STARTABLE_STATUSES],
              },
            },
            data: {
              keywordGenerationStatus: "processing",
              keywordGenerationStartedAt: new Date(),
            },
          });

          if (updatedBusiness.count === 0) {
            const timing = createKeywordStageTiming({
              stage: "load-keyword-context",
              startedAt,
              startMs,
            });

            console.log(
              `⏭️ [KeywordGeneration] load-keyword-context:skip user=${userId} business=${businessId} reason=already-processing`,
            );

            return {
              cancelled: true,
              message: "Another instance is already processing",
              businessId,
              userId,
              businessDisplayName: businessId,
              businessInfo: null,
              lastKeywords: [],
              existingKeywordCountBefore: 0,
              keywordGenerationMode:
                process.env.KEYWORD_GENERATION_MODE?.toLowerCase() === "llm_first"
                  ? "llm_first"
                  : "dataforseo_ai",
              timing,
            };
          }

          await Promise.all([
            invalidateTenantCache(userId),
            invalidateTenantCache(userId, businessId),
          ]);

          const businessInfo = await prisma.business.findFirst({
            where: {
              id: businessId,
              userId,
              isActive: true,
            },
            include: {
              keywords: true,
              competitiors: true,
              competitiveAdvantage: true,
              currentRanking: true,
              websiteAnalysis: {
                include: {
                  coreServices: true,
                },
              },
            },
          });

          if (!businessInfo) {
            throw new Error(
              `Business not found for user ${userId}, businessId: ${businessId}`,
            );
          }

          const existingKeywordCountBefore =
            await countActiveKeywordPlansWithRetry({
              userId,
              businessId: businessInfo.id,
            });

          const lastKeywords = await prisma.plan.findMany({
            where: {
              userId,
              businessId: businessInfo.id,
              deletedAt: null,
            },
            orderBy: {
              publishDate: "desc",
            },
            take: 30,
          });

          const keywordGenerationMode =
            process.env.KEYWORD_GENERATION_MODE?.toLowerCase() === "llm_first"
              ? "llm_first"
              : "dataforseo_ai";

          const timing = createKeywordStageTiming({
            stage: "load-keyword-context",
            startedAt,
            startMs,
            counts: {
              existingKeywordCountBefore,
              lastKeywordCount: lastKeywords.length,
            },
          });

          console.log(
            `✅ [KeywordGeneration] load-keyword-context:done user=${userId} business=${businessInfo.id} existingKeywords=${existingKeywordCountBefore} lastKeywords=${lastKeywords.length} mode=${keywordGenerationMode}`,
          );

          return {
            businessId: businessInfo.id,
            userId,
            businessDisplayName:
              businessInfo.businessName ??
              businessInfo.businessWebsiteUrl ??
              businessInfo.id,
            businessInfo,
            lastKeywords,
            existingKeywordCountBefore,
            keywordGenerationMode,
            timing,
          };
        },
      );

      if (loadContext.cancelled) {
        return {
          success: false,
          cancelled: true,
          message: loadContext.message,
          userId,
          businessId,
          stageTimings: {
            loadKeywordContext: loadContext.timing,
          },
        };
      }

      completedBusinessId = loadContext.businessId;
      businessDisplayName = loadContext.businessDisplayName;
      existingKeywordCountBefore = loadContext.existingKeywordCountBefore;

      console.log(
        `✅ Using business: ${loadContext.businessId} (${loadContext.businessInfo.businessName}) - Website: ${loadContext.businessInfo.businessWebsiteUrl}`,
      );

      if (loadContext.keywordGenerationMode === "llm_first") {
        const legacyGeneration = await step.run(
          "legacy-llm-first-generate-keywords",
          async (): Promise<KeywordGenerationSaveStage> => {
            const startedAt = new Date();
            const startMs = Date.now();

            console.log(
              `🧠 [KeywordGeneration] legacy-llm-first-generate-keywords:start user=${userId} business=${loadContext.businessId}`,
            );

            const generationResult = await generateNewKeywordLLM(
              JSON.stringify(loadContext.businessInfo),
              JSON.stringify(loadContext.lastKeywords),
              userId,
              loadContext.businessId,
            );

            const savedCount =
              typeof generationResult === "object" &&
              generationResult !== null &&
              "count" in generationResult
                ? Number((generationResult as { count?: number }).count || 0)
                : 0;
            const skippedCount =
              typeof generationResult === "object" &&
              generationResult !== null &&
              "skipped" in generationResult
                ? Number((generationResult as { skipped?: number }).skipped || 0)
                : 0;
            const fallbackReason =
              typeof generationResult === "object" &&
              generationResult !== null &&
              "fallbackReason" in generationResult &&
              typeof (generationResult as { fallbackReason?: string })
                .fallbackReason === "string" &&
              (generationResult as { fallbackReason?: string }).fallbackReason!
                .length > 0
                ? (generationResult as { fallbackReason?: string }).fallbackReason!
                : null;
            const method =
              typeof generationResult === "object" &&
              generationResult !== null &&
              "method" in generationResult
                ? String((generationResult as { method?: string }).method || "llm_first")
                : "llm_first";

            const timing = createKeywordStageTiming({
              stage: "legacy-llm-first-generate-keywords",
              startedAt,
              startMs,
              counts: {
                savedCount,
                skippedCount,
              },
            });

            console.log(
              `✅ [KeywordGeneration] legacy-llm-first-generate-keywords:done user=${userId} business=${loadContext.businessId} saved=${savedCount} skipped=${skippedCount}`,
            );

            return {
              savedCount,
              skippedCount,
              skippedDetails: [],
              persistedPlanItems: [],
              fallbackReason,
              method,
              timing,
            };
          },
        );

        savedKeywordCount = legacyGeneration.savedCount;

        const finalizeStage = await step.run(
          "finalize-keyword-generation",
          async (): Promise<KeywordGenerationFinalizeStage> => {
            const startedAt = new Date();
            const startMs = Date.now();
            const expectedKeywordCountAfterSave =
              existingKeywordCountBefore + legacyGeneration.savedCount;

            await runKeywordPrismaRetry(
              `finalizeKeywordGeneration:${loadContext.businessId}`,
              async (dbClient) => {
                const verifiedKeywordCount = await dbClient.plan.count({
                  where: {
                    userId,
                    businessId: loadContext.businessId,
                    deletedAt: null,
                  },
                });

                if (
                  legacyGeneration.savedCount > 0 &&
                  verifiedKeywordCount < expectedKeywordCountAfterSave
                ) {
                  throw new Error(
                    `KEYWORD_SAVE_NOT_CONFIRMED: expected at least ${expectedKeywordCountAfterSave} active keywords after save, found ${verifiedKeywordCount}`,
                  );
                }

                await dbClient.business.update({
                  where: { id: loadContext.businessId },
                  data: {
                    keywordGenerationStatus: "completed",
                    keywordGenerationCompletedAt: new Date(),
                  },
                });
              },
            );

            const verifiedKeywordCount = await countActiveKeywordPlansWithRetry({
              userId,
              businessId: loadContext.businessId,
            });
            await Promise.all([
              invalidateTenantCache(userId),
              invalidateTenantCache(userId, loadContext.businessId),
            ]);

            const timing = createKeywordStageTiming({
              stage: "finalize-keyword-generation",
              startedAt,
              startMs,
              counts: {
                verifiedKeywordCount,
                expectedKeywordCountAfterSave,
              },
            });

            return {
              verifiedKeywordCount,
              expectedKeywordCountAfterSave,
              timing,
            };
          },
        );

        finalizedKeywordGeneration = true;

        const firstBlogStage = await step.run(
          "trigger-first-blog",
          async (): Promise<KeywordGenerationFirstBlogStage> => {
            const startedAt = new Date();
            const startMs = Date.now();

            if (!triggerFirstBlog) {
              return {
                triggered: false,
                keywordId: null,
                keyword: null,
                timing: createKeywordStageTiming({
                  stage: "trigger-first-blog",
                  startedAt,
                  startMs,
                }),
              };
            }

            const generationWorkerState = getBlogGenerationWorkerState();
            if (!generationWorkerState.enabled) {
              console.log(
                `⏭️ Skipping onboarding first-blog enqueue for business ${loadContext.businessId}: ${BLOG_GENERATION_WORKER_FLAG} is disabled.`,
                generationWorkerState,
              );
              return {
                triggered: false,
                keywordId: null,
                keyword: null,
                reason: "blog_generation_worker_disabled",
                timing: createKeywordStageTiming({
                  stage: "trigger-first-blog",
                  startedAt,
                  startMs,
                }),
              };
            }

            try {
              const allKeywordsForFirstBlog = await prisma.plan.findMany({
                where: {
                  userId,
                  businessId: loadContext.businessId,
                },
                orderBy: [{ publishDate: "asc" }, { createdAt: "asc" }],
                select: {
                  id: true,
                  keyword: true,
                  blogId: true,
                  deletedAt: true,
                  publishDate: true,
                  publishTime: true,
                },
              });

              const activeKeywords = allKeywordsForFirstBlog.filter(
                (kw) => kw.deletedAt === null || kw.deletedAt === undefined,
              );
              const dueKeywordsWithoutBlog = activeKeywords.filter(
                (kw) =>
                  (kw.blogId === null || kw.blogId === undefined) &&
                  evaluateScheduleDue({
                    publishDate: kw.publishDate,
                    publishTime: kw.publishTime,
                    defaultLocale: loadContext.businessInfo.defaultLocale,
                    businessCountry: loadContext.businessInfo.businessCountry,
                    businessState: loadContext.businessInfo.businessState,
                    businessCity: loadContext.businessInfo.businessCity,
                  }).isDue,
              );
              const firstKeyword = dueKeywordsWithoutBlog[0] ?? null;

              if (!firstKeyword) {
                return {
                  triggered: false,
                  keywordId: null,
                  keyword: null,
                  timing: createKeywordStageTiming({
                    stage: "trigger-first-blog",
                    startedAt,
                    startMs,
                    counts: {
                      activeKeywords: activeKeywords.length,
                      dueKeywordsWithoutBlog: dueKeywordsWithoutBlog.length,
                    },
                  }),
                };
              }

              await inngest.send({
                name: "blog/generate",
                data: buildPinnedBlogGenerateEventData(firstKeyword.id, {
                  userId,
                  keywordId: firstKeyword.id,
                  businessId: loadContext.businessId,
                }),
              });

              return {
                triggered: true,
                keywordId: firstKeyword.id,
                keyword: firstKeyword.keyword,
                timing: createKeywordStageTiming({
                  stage: "trigger-first-blog",
                  startedAt,
                  startMs,
                  counts: {
                    activeKeywords: activeKeywords.length,
                    dueKeywordsWithoutBlog: dueKeywordsWithoutBlog.length,
                  },
                }),
              };
            } catch (error) {
              console.error(
                `⚠️ Failed to trigger first blog generation for user ${userId}, business ${loadContext.businessId}:`,
                error,
              );

              return {
                triggered: false,
                keywordId: null,
                keyword: null,
                timing: createKeywordStageTiming({
                  stage: "trigger-first-blog",
                  startedAt,
                  startMs,
                }),
              };
            }
          },
        );

        const message = `Generated ${legacyGeneration.savedCount} keywords for ${businessDisplayName} domain (${legacyGeneration.savedCount} saved)`;

        return {
          success: true,
          message,
          userId,
          businessId: loadContext.businessId,
          completedAt: new Date(),
          counts: {
            existingKeywordCountBefore,
            savedCount: legacyGeneration.savedCount,
            skippedCount: legacyGeneration.skippedCount,
            verifiedKeywordCount: finalizeStage.verifiedKeywordCount,
          },
          stageTimings: {
            loadKeywordContext: loadContext.timing,
            legacyLlmFirstGenerateKeywords: legacyGeneration.timing,
            finalizeKeywordGeneration: finalizeStage.timing,
            triggerFirstBlog: firstBlogStage.timing,
          },
          firstBlogTriggered: firstBlogStage.triggered,
        };
      }

      const collection = await step.run(
        "collect-keyword-candidates",
        async (): Promise<{
          collection: KeywordCandidateCollectionResult;
          timing: KeywordGenerationStageTiming;
        }> => {
          const startedAt = new Date();
          const startMs = Date.now();

          console.log(
            `📥 [KeywordGeneration] collect-keyword-candidates:start user=${userId} business=${loadContext.businessId}`,
          );

          const collection = await collectKeywordCandidatesForPlan({
            business: loadContext.businessInfo,
            userId,
            businessId: loadContext.businessId,
            isPrimary: Boolean(loadContext.businessInfo.isPrimary),
            lastKeywords: loadContext.lastKeywords,
            isTopUp,
          });

          const timing = createKeywordStageTiming({
            stage: "collect-keyword-candidates",
            startedAt,
            startMs,
            counts: {
              rawCandidateCount: collection.counts.raw,
              filteredCandidateCount: collection.counts.filtered,
              preFilteredCandidateCount: collection.counts.preFiltered,
              cappedCandidateCount: collection.counts.capped,
            },
          });

          console.log(
            `✅ [KeywordGeneration] collect-keyword-candidates:done user=${userId} business=${loadContext.businessId} raw=${collection.counts.raw} filtered=${collection.counts.filtered} preFiltered=${collection.counts.preFiltered} capped=${collection.counts.capped}`,
          );

          return {
            collection,
            timing,
          };
        },
      );

      const selection = await step.run(
        "select-keywords",
        async (): Promise<{
          selection: KeywordCandidateSelectionResult;
          timing: KeywordGenerationStageTiming;
        }> => {
          const startedAt = new Date();
          const startMs = Date.now();

          console.log(
            `🎯 [KeywordGeneration] select-keywords:start user=${userId} business=${loadContext.businessId}`,
          );

          const selection = await selectKeywordsForPlan({
            business: loadContext.businessInfo,
            collection: collection.collection,
          });

          const timing = createKeywordStageTiming({
            stage: "select-keywords",
            startedAt,
            startMs,
            counts: {
              classificationBatchCount: selection.counts.classificationBatches,
              areaFilteredCount: selection.counts.areaFiltered,
              retainedCount: selection.counts.retained,
              selectedCount: selection.counts.selected,
              selectedByLlmCount: selection.counts.selectedByLlm,
            },
          });

          console.log(
            `✅ [KeywordGeneration] select-keywords:done user=${userId} business=${loadContext.businessId} selected=${selection.counts.selected} fallback=${selection.fallbackCandidates.length}`,
          );

          return {
            selection,
            timing,
          };
        },
      );

      const builtPlan = await step.run(
        "verify-and-build-plan",
        async (): Promise<{
          plan: KeywordPlanBuildResult;
          timing: KeywordGenerationStageTiming;
        }> => {
          const startedAt = new Date();
          const startMs = Date.now();

          console.log(
            `🧪 [KeywordGeneration] verify-and-build-plan:start user=${userId} business=${loadContext.businessId}`,
          );

          const plan = await buildKeywordPlanForPersistence({
            business: loadContext.businessInfo,
            userId,
            businessId: loadContext.businessId,
            collection: collection.collection,
            selection: selection.selection,
          });

          const timing = createKeywordStageTiming({
            stage: "verify-and-build-plan",
            startedAt,
            startMs,
            counts: {
              verifiedCandidateCount: plan.counts.verified,
              plannedKeywordCount: plan.counts.planned,
              dedupedKeywordCount: plan.counts.deduped,
            },
          });

          console.log(
            `✅ [KeywordGeneration] verify-and-build-plan:done user=${userId} business=${loadContext.businessId} verified=${plan.counts.verified} deduped=${plan.counts.deduped}`,
          );

          return {
            plan,
            timing,
          };
        },
      );

      const saveStage = await step.run(
        "save-keywords",
        async (): Promise<KeywordGenerationSaveStage> => {
          const startedAt = new Date();
          const startMs = Date.now();

          console.log(
            `💾 [KeywordGeneration] save-keywords:start user=${userId} business=${loadContext.businessId} planned=${builtPlan.plan.keywordPlanToSave.length}`,
          );

          const keywordPlanToSave =
            builtPlan.plan
              .keywordPlanToSave as KeywordPlanBuildResult["keywordPlanToSave"];
          const planItemsToSave: PlanKeywordSaveItem[] =
            keywordPlanToSave.map((item) => ({
              ...item,
              selectionMetadata:
                (item.selectionMetadata as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput
                  | null) ?? null,
              keywordTrend:
                (item.keywordTrend as
                  | Prisma.InputJsonValue
                  | Prisma.NullableJsonNullValueInput
                  | null) ?? null,
              clusterId: item.clusterId ?? undefined,
              clusterRole: item.clusterRole ?? undefined,
            }));

          const saveResult = await savePlanKeywords(planItemsToSave);
          const persistedPlanItems = getPersistedKeywordPlanItems<
            KeywordPlanBuildResult["keywordPlanToSave"][number]
          >(
            keywordPlanToSave,
            saveResult.skippedDetails,
          );

          const timing = createKeywordStageTiming({
            stage: "save-keywords",
            startedAt,
            startMs,
            counts: {
              savedCount: saveResult.count,
              skippedCount: saveResult.skipped,
              persistedPlanItems: persistedPlanItems.length,
            },
          });

          console.log(
            `✅ [KeywordGeneration] save-keywords:done user=${userId} business=${loadContext.businessId} saved=${saveResult.count} skipped=${saveResult.skipped}`,
          );

          return {
            savedCount: saveResult.count,
            skippedCount: saveResult.skipped,
            skippedDetails: saveResult.skippedDetails,
            persistedPlanItems,
            fallbackReason: null,
            method: "dataforseo_ai",
            timing,
          };
        },
      );

      savedKeywordCount = saveStage.savedCount;

      const finalizeStage = await step.run(
        "finalize-keyword-generation",
        async (): Promise<KeywordGenerationFinalizeStage> => {
          const startedAt = new Date();
          const startMs = Date.now();
          const expectedKeywordCountAfterSave =
            existingKeywordCountBefore + saveStage.savedCount;

          console.log(
            `🏁 [KeywordGeneration] finalize-keyword-generation:start user=${userId} business=${loadContext.businessId} expected=${expectedKeywordCountAfterSave}`,
          );

          await runKeywordPrismaRetry(
            `finalizeKeywordGeneration:${loadContext.businessId}`,
            async (dbClient) => {
              const verifiedKeywordCount = await dbClient.plan.count({
                where: {
                  userId,
                  businessId: loadContext.businessId,
                  deletedAt: null,
                },
              });

              if (
                saveStage.savedCount > 0 &&
                verifiedKeywordCount < expectedKeywordCountAfterSave
              ) {
                throw new Error(
                  `KEYWORD_SAVE_NOT_CONFIRMED: expected at least ${expectedKeywordCountAfterSave} active keywords after save, found ${verifiedKeywordCount}`,
                );
              }

              await dbClient.business.update({
                where: { id: loadContext.businessId },
                data: {
                  keywordGenerationStatus: "completed",
                  keywordGenerationCompletedAt: new Date(),
                },
              });
            },
          );

          const verifiedKeywordCount = await countActiveKeywordPlansWithRetry({
            userId,
            businessId: loadContext.businessId,
          });
          await Promise.all([
            invalidateTenantCache(userId),
            invalidateTenantCache(userId, loadContext.businessId),
          ]);

          const timing = createKeywordStageTiming({
            stage: "finalize-keyword-generation",
            startedAt,
            startMs,
            counts: {
              verifiedKeywordCount,
              expectedKeywordCountAfterSave,
            },
          });

          console.log(
            `✅ [KeywordGeneration] finalize-keyword-generation:done user=${userId} business=${loadContext.businessId} verified=${verifiedKeywordCount}`,
          );

          return {
            verifiedKeywordCount,
            expectedKeywordCountAfterSave,
            timing,
          };
        },
      );

      finalizedKeywordGeneration = true;

      // Keyword allocation enriches the already-persisted plan. It must not
      // keep the content calendar in a processing state or undo a valid plan
      // if one of its downstream provider calls is slow.
      const allocationStage = await step.run(
        "allocate-keywords",
        async (): Promise<KeywordGenerationAllocationStage> => {
          const startedAt = new Date();
          const startMs = Date.now();
          const keywordAllocation = new KeywordAllocationService();
          const failures: Array<{ keyword: string; error: string }> = [];
          let allocatedCount = 0;

          console.log(
            `🗂️ [KeywordGeneration] allocate-keywords:start user=${userId} business=${loadContext.businessId} persisted=${saveStage.persistedPlanItems.length}`,
          );

          const persistedPlanItems =
            saveStage.persistedPlanItems as KeywordPlanBuildResult["keywordPlanToSave"];

          if (persistedPlanItems.length > 0) {
            for (const batch of chunkArray(persistedPlanItems, 5)) {
              const batchResults = await Promise.all(
                batch.map(async (item) => {
                  try {
                    // GEO-FIX-1: use per-keyword GEO scope when available
                    // (from selectionMetadata.geo.targetCity persisted by GEO-KW-7).
                    // Falls back to the collection-level locationScope for non-GEO keywords.
                    let keywordLocationScope = collection.collection.locationScope;
                    if (
                      item.selectionMetadata &&
                      typeof item.selectionMetadata === "object"
                    ) {
                      const meta = item.selectionMetadata as Record<
                        string,
                        unknown
                      >;
                      const geo = meta.geo as
                        | {
                            targetCity?: string;
                            targetLocationCode?: number;
                          }
                        | undefined;
                      if (geo?.targetCity) {
                        keywordLocationScope = geo.targetCity;
                      }
                    }

                    return {
                      item,
                      result: await keywordAllocation.allocateKeyword(
                        item.keyword,
                        loadContext.businessId,
                        userId,
                        loadContext.businessInfo.businessType ||
                          loadContext.businessInfo.businessName ||
                          "general",
                        keywordLocationScope,
                        Number(item.keywordSearchVolume) || undefined,
                        Number(item.keywordDiffculty) || undefined,
                      ),
                    };
                  } catch (error) {
                    return {
                      item,
                      result: {
                        success: false,
                        error: getPrismaErrorMessage(error),
                      },
                    };
                  }
                }),
              );

              for (const { item, result } of batchResults) {
                if (result.success) {
                  allocatedCount += 1;
                } else {
                  failures.push({
                    keyword: item.keyword,
                    error: result.error || "Failed to allocate keyword",
                  });
                }
              }
            }
          }

          const timing = createKeywordStageTiming({
            stage: "allocate-keywords",
            startedAt,
            startMs,
            counts: {
              attemptedCount: saveStage.persistedPlanItems.length,
              allocatedCount,
              allocationFailureCount: failures.length,
            },
          });

          if (failures.length > 0) {
            console.warn(
              `⚠️ [KeywordGeneration] allocate-keywords:partial user=${userId} business=${loadContext.businessId} allocated=${allocatedCount} failed=${failures.length}`,
            );
          } else {
            console.log(
              `✅ [KeywordGeneration] allocate-keywords:done user=${userId} business=${loadContext.businessId} allocated=${allocatedCount}`,
            );
          }

          return {
            allocatedCount,
            attemptedCount: saveStage.persistedPlanItems.length,
            failures,
            timing,
          };
        },
      );

      const firstBlogStage = await step.run(
        "trigger-first-blog",
        async (): Promise<KeywordGenerationFirstBlogStage> => {
          const startedAt = new Date();
          const startMs = Date.now();

          if (!triggerFirstBlog) {
            console.log(
              `ℹ️ [KeywordGeneration] trigger-first-blog:skip user=${userId} business=${loadContext.businessId}`,
            );
            return {
              triggered: false,
              keywordId: null,
              keyword: null,
              timing: createKeywordStageTiming({
                stage: "trigger-first-blog",
                startedAt,
                startMs,
              }),
            };
          }

          const generationWorkerState = getBlogGenerationWorkerState();
          if (!generationWorkerState.enabled) {
            console.log(
              `⏭️ [KeywordGeneration] trigger-first-blog:paused user=${userId} business=${loadContext.businessId} flag=${BLOG_GENERATION_WORKER_FLAG}`,
              generationWorkerState,
            );
            return {
              triggered: false,
              keywordId: null,
              keyword: null,
              reason: "blog_generation_worker_disabled",
              timing: createKeywordStageTiming({
                stage: "trigger-first-blog",
                startedAt,
                startMs,
              }),
            };
          }

          console.log(
            `📝 [KeywordGeneration] trigger-first-blog:start user=${userId} business=${loadContext.businessId}`,
          );

          try {
            const allKeywordsForFirstBlog = await prisma.plan.findMany({
              where: {
                userId,
                businessId: loadContext.businessId,
              },
              orderBy: [{ publishDate: "asc" }, { createdAt: "asc" }],
              select: {
                id: true,
                keyword: true,
                blogId: true,
                deletedAt: true,
                publishDate: true,
                publishTime: true,
              },
            });

            const activeKeywords = allKeywordsForFirstBlog.filter(
              (kw) => kw.deletedAt === null || kw.deletedAt === undefined,
            );
            const dueKeywordsWithoutBlog = activeKeywords.filter(
              (kw) =>
                (kw.blogId === null || kw.blogId === undefined) &&
                evaluateScheduleDue({
                  publishDate: kw.publishDate,
                  publishTime: kw.publishTime,
                  defaultLocale: loadContext.businessInfo.defaultLocale,
                  businessCountry: loadContext.businessInfo.businessCountry,
                  businessState: loadContext.businessInfo.businessState,
                  businessCity: loadContext.businessInfo.businessCity,
                }).isDue,
            );
            const firstKeyword = dueKeywordsWithoutBlog[0] ?? null;

            if (!firstKeyword) {
              console.warn(
                `⚠️ [KeywordGeneration] trigger-first-blog:no-due-keyword user=${userId} business=${loadContext.businessId}`,
              );
              return {
                triggered: false,
                keywordId: null,
                keyword: null,
                timing: createKeywordStageTiming({
                  stage: "trigger-first-blog",
                  startedAt,
                  startMs,
                  counts: {
                    activeKeywords: activeKeywords.length,
                    dueKeywordsWithoutBlog: dueKeywordsWithoutBlog.length,
                  },
                }),
              };
            }

            await inngest.send({
              name: "blog/generate",
              data: buildPinnedBlogGenerateEventData(firstKeyword.id, {
                userId,
                keywordId: firstKeyword.id,
                businessId: loadContext.businessId,
              }),
            });

            console.log(
              `✅ [KeywordGeneration] trigger-first-blog:done user=${userId} business=${loadContext.businessId} keyword=${firstKeyword.keyword}`,
            );

            return {
              triggered: true,
              keywordId: firstKeyword.id,
              keyword: firstKeyword.keyword,
              timing: createKeywordStageTiming({
                stage: "trigger-first-blog",
                startedAt,
                startMs,
                counts: {
                  activeKeywords: activeKeywords.length,
                  dueKeywordsWithoutBlog: dueKeywordsWithoutBlog.length,
                },
              }),
            };
          } catch (error) {
            console.error(
              `⚠️ Failed to trigger first blog generation for user ${userId}, business ${loadContext.businessId}:`,
              error,
            );

            return {
              triggered: false,
              keywordId: null,
              keyword: null,
              timing: createKeywordStageTiming({
                stage: "trigger-first-blog",
                startedAt,
                startMs,
              }),
            };
          }
        },
      );

      if (saveStage.savedCount === 0) {
        console.warn(
          `⚠️ Keyword generation completed without new saved rows for business ${loadContext.businessId}. Existing runway likely already satisfied.`,
        );
      } else {
        console.log(
          `✅ Verified keyword persistence for business ${loadContext.businessId}: expected ${finalizeStage.expectedKeywordCountAfterSave} active plan rows after save`,
        );
      }

      return {
        success: true,
        message: `Generated ${saveStage.savedCount} keywords for ${businessDisplayName} domain (${saveStage.savedCount} saved)`,
        userId,
        businessId: loadContext.businessId,
        completedAt: new Date(),
        counts: {
          existingKeywordCountBefore,
          rawCandidateCount: collection.collection.counts.raw,
          filteredCandidateCount: collection.collection.counts.filtered,
          preFilteredCandidateCount: collection.collection.counts.preFiltered,
          cappedCandidateCount: collection.collection.counts.capped,
          selectedCount: selection.selection.counts.selected,
          verifiedCount: builtPlan.plan.counts.verified,
          plannedCount: builtPlan.plan.counts.deduped,
          savedCount: saveStage.savedCount,
          skippedCount: saveStage.skippedCount,
          allocatedCount: allocationStage.allocatedCount,
          verifiedKeywordCount: finalizeStage.verifiedKeywordCount,
        },
        stageTimings: {
          loadKeywordContext: loadContext.timing,
          collectKeywordCandidates: collection.timing,
          selectKeywords: selection.timing,
          verifyAndBuildPlan: builtPlan.timing,
          saveKeywords: saveStage.timing,
          finalizeKeywordGeneration: finalizeStage.timing,
          allocateKeywords: allocationStage.timing,
          triggerFirstBlog: firstBlogStage.timing,
        },
        allocationFailures: allocationStage.failures,
        firstBlogTriggered: firstBlogStage.triggered,
      };
    } catch (error) {
      console.error(`❌ Error generating keywords for user ${userId}:`, error);

      if (finalizedKeywordGeneration) {
        console.warn(
          `⚠️ Keyword generation already finalized for business ${completedBusinessId}; preserving completed status despite post-finalize error.`,
        );

        return {
          success: true,
          reconciled: true,
          message: `Generated ${savedKeywordCount} keywords for ${businessDisplayName} domain (${savedKeywordCount} saved)`,
          userId,
          businessId: completedBusinessId,
          completedAt: new Date(),
        };
      }

      if (
        savedKeywordCount > 0 &&
        isTransientPrismaConnectionError(error) &&
        completedBusinessId
      ) {
        try {
          const reconciledKeywordCount = await countActiveKeywordPlansWithRetry({
            userId,
            businessId: completedBusinessId,
          });
          const expectedKeywordCountAfterSave =
            existingKeywordCountBefore + savedKeywordCount;

          if (reconciledKeywordCount >= expectedKeywordCountAfterSave) {
            await updateKeywordGenerationStatusWithRetry({
              businessId: completedBusinessId,
              userId,
              status: "completed",
            });

            console.warn(
              `⚠️ Reconciled keyword generation after transient Prisma failure. Found ${reconciledKeywordCount} active plan rows (expected at least ${expectedKeywordCountAfterSave}) for business ${completedBusinessId}.`,
            );

            return {
              success: true,
              reconciled: true,
              message: `Generated ${savedKeywordCount} keywords for ${businessDisplayName} domain (${savedKeywordCount} saved)`,
              userId,
              businessId: completedBusinessId,
              completedAt: new Date(),
            };
          }
        } catch (reconciliationError) {
          console.error(
            `[KeywordGeneration] Failed to reconcile transient Prisma error for business ${completedBusinessId}:`,
            reconciliationError,
          );
        }
      }

      await updateKeywordGenerationStatusWithRetry({
        businessId,
        userId,
        status: "failed",
      });

      throw error;
    }
  },
);

export const dailyKeywordTopUpTask = createInngestFunction(
  {
    id: "daily-keyword-top-up",
    name: "Top Up Paid Keyword Plans",
    retries: 1,
  },
  { cron: "15 1 * * *" },
  async ({ step }) => {
    return await step.run("queue-keyword-top-ups", async () => {
      const today = getTodayPlanDate();

      try {
        console.log("🔄 Starting daily paid keyword top-up scan...");

        const businesses = await prisma.business.findMany({
          where: {
            isActive: true,
          },
          select: {
            id: true,
            userId: true,
            businessName: true,
            keywordGenerationStatus: true,
            websiteSubscription: {
              select: {
                status: true,
                trialStatus: true,
              },
            },
            User: {
              select: {
                role: true,
                Subscription: {
                  select: {
                    status: true,
                  },
                },
              },
            },
          },
        });

        const results: Array<{
          businessId: string;
          businessName: string;
          futureKeywordCount?: number;
          status:
            | "queued"
            | "skipped_no_access"
            | "skipped_runway_healthy"
            | "skipped_generation_in_progress";
        }> = [];

        for (const business of businesses) {
          const hasPaidAccess = hasPaidKeywordTopUpAccess({
            role: business.User.role,
            websiteSubscription: business.websiteSubscription,
            accountSubscription: business.User.Subscription,
          });

          if (!hasPaidAccess) {
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              status: "skipped_no_access",
            });
            continue;
          }

          const futureKeywordCount = await prisma.plan.count({
            where: {
              businessId: business.id,
              deletedAt: null,
              publishDate: {
                gte: today,
              },
            },
          });

          if (
            !shouldQueueKeywordTopUp({
              futureKeywordCount,
              keywordGenerationStatus: business.keywordGenerationStatus,
              hasPaidAccess,
            })
          ) {
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              futureKeywordCount,
              status:
                business.keywordGenerationStatus === "pending" ||
                business.keywordGenerationStatus === "processing"
                  ? "skipped_generation_in_progress"
                  : "skipped_runway_healthy",
            });
            continue;
          }

          const updateResult = await prisma.business.updateMany({
            where: {
              id: business.id,
              userId: business.userId,
              keywordGenerationStatus: {
                notIn: ["pending", "processing"],
              },
            },
            data: {
              keywordGenerationStatus: "pending",
              keywordGenerationStartedAt: null,
              keywordGenerationCompletedAt: null,
            },
          });

          if (updateResult.count === 0) {
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              futureKeywordCount,
              status: "skipped_generation_in_progress",
            });
            continue;
          }

          await inngest.send({
            name: "keywords/generate",
            data: {
              userId: business.userId,
              businessId: business.id,
              triggerFirstBlog: false,
              isTopUp: true,
            },
          });

          console.log(
            `🗓️ Queued keyword top-up for ${business.businessName} (${business.id}) with ${futureKeywordCount} future keywords remaining`,
          );

          results.push({
            businessId: business.id,
            businessName: business.businessName,
            futureKeywordCount,
            status: "queued",
          });
        }

        const queued = results.filter(
          (result) => result.status === "queued",
        ).length;
        const skippedNoAccess = results.filter(
          (result) => result.status === "skipped_no_access",
        ).length;
        const skippedRunwayHealthy = results.filter(
          (result) => result.status === "skipped_runway_healthy",
        ).length;
        const skippedInProgress = results.filter(
          (result) => result.status === "skipped_generation_in_progress",
        ).length;

        console.log(
          `📊 Keyword top-up scan complete: ${queued} queued, ${skippedRunwayHealthy} runway healthy, ${skippedInProgress} already generating, ${skippedNoAccess} no paid access (threshold: ${KEYWORD_RUNWAY_TOP_UP_THRESHOLD})`,
        );

        return {
          message: "Daily paid keyword top-up scan complete",
          totalBusinesses: businesses.length,
          queued,
          skippedNoAccess,
          skippedRunwayHealthy,
          skippedGenerationInProgress: skippedInProgress,
          threshold: KEYWORD_RUNWAY_TOP_UP_THRESHOLD,
          results,
        };
      } catch (error) {
        console.error("❌ Error in daily keyword top-up scan:", error);
        throw error;
      }
    });
  },
);

export const staleKeywordGenerationVerifierTask = createInngestFunction(
  {
    id: "verify-stale-keyword-generation",
    name: "Verify Stale Keyword Generation",
    retries: 1,
  },
  { cron: KEYWORD_GENERATION_RECOVERY_CRON },
  async ({ step }) => {
    return await step.run("reconcile-stale-keyword-generation", async () => {
      const today = getTodayPlanDate();
      const staleMinutes = resolveKeywordGenerationStaleMinutes();
      const now = new Date();

      console.log(
        `🔎 Starting stale keyword generation verifier (stale after ${staleMinutes} minutes)...`,
      );

      const businesses = await prisma.business.findMany({
        where: {
          isActive: true,
          keywordGenerationStatus: {
            in: ["pending", "processing"],
          },
        },
        select: {
          id: true,
          userId: true,
          businessName: true,
          keywordGenerationStatus: true,
          keywordGenerationStartedAt: true,
          updatedAt: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
            },
          },
          User: {
            select: {
              role: true,
              Subscription: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
      });

      const results: Array<{
        businessId: string;
        businessName: string;
        previousStatus: string;
        futureKeywordCount?: number;
        status:
          | "fresh_in_progress"
          | "requeued"
          | "reconciled_completed_runway_healthy"
          | "reconciled_completed_no_access"
          | "failed_to_reconcile"
          | "failed_to_queue";
        reason?: string;
      }> = [];

      for (const business of businesses) {
        const previousStatus = business.keywordGenerationStatus;

        if (
          !isStaleKeywordGeneration({
            keywordGenerationStatus: business.keywordGenerationStatus,
            keywordGenerationStartedAt: business.keywordGenerationStartedAt,
            updatedAt: business.updatedAt,
            now,
            staleMinutes,
          })
        ) {
          results.push({
            businessId: business.id,
            businessName: business.businessName,
            previousStatus,
            status: "fresh_in_progress",
          });
          continue;
        }

        const futureKeywordCount = await prisma.plan.count({
          where: {
            businessId: business.id,
            deletedAt: null,
            publishDate: {
              gte: today,
            },
          },
        });
        const hasPaidAccess = hasPaidKeywordTopUpAccess({
          role: business.User.role,
          websiteSubscription: business.websiteSubscription,
          accountSubscription: business.User.Subscription,
        });
        const shouldRequeue =
          hasPaidAccess &&
          futureKeywordCount <= KEYWORD_RUNWAY_TOP_UP_THRESHOLD;

        if (!shouldRequeue) {
          const updateResult = await prisma.business.updateMany({
            where: {
              id: business.id,
              userId: business.userId,
              keywordGenerationStatus: previousStatus,
            },
            data: {
              keywordGenerationStatus: "completed",
              keywordGenerationCompletedAt: now,
            },
          });

          if (updateResult.count === 0) {
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              previousStatus,
              futureKeywordCount,
              status: "failed_to_reconcile",
              reason: "Status changed before verifier could reconcile it",
            });
            continue;
          }

          results.push({
            businessId: business.id,
            businessName: business.businessName,
            previousStatus,
            futureKeywordCount,
            status: hasPaidAccess
              ? "reconciled_completed_runway_healthy"
              : "reconciled_completed_no_access",
          });
          continue;
        }

        const updateResult = await prisma.business.updateMany({
          where: {
            id: business.id,
            userId: business.userId,
            keywordGenerationStatus: previousStatus,
          },
          data: {
            keywordGenerationStatus: "pending",
            keywordGenerationStartedAt: null,
            keywordGenerationCompletedAt: null,
          },
        });

        if (updateResult.count === 0) {
          results.push({
            businessId: business.id,
            businessName: business.businessName,
            previousStatus,
            futureKeywordCount,
            status: "failed_to_reconcile",
            reason: "Status changed before verifier could requeue it",
          });
          continue;
        }

        try {
          await inngest.send({
            name: "keywords/generate",
            data: {
              userId: business.userId,
              businessId: business.id,
              triggerFirstBlog: false,
              isTopUp: true,
            },
          });

          results.push({
            businessId: business.id,
            businessName: business.businessName,
            previousStatus,
            futureKeywordCount,
            status: "requeued",
          });
        } catch (error) {
          const errorMessage = getPrismaErrorMessage(error);

          await prisma.business.updateMany({
            where: {
              id: business.id,
              userId: business.userId,
              keywordGenerationStatus: "pending",
            },
            data: {
              keywordGenerationStatus: "completed",
              keywordGenerationCompletedAt: new Date(),
            },
          });

          results.push({
            businessId: business.id,
            businessName: business.businessName,
            previousStatus,
            futureKeywordCount,
            status: "failed_to_queue",
            reason: errorMessage,
          });
        }
      }

      const requeued = results.filter(
        (result) => result.status === "requeued",
      ).length;
      const reconciled = results.filter((result) =>
        result.status.startsWith("reconciled_completed"),
      ).length;
      const fresh = results.filter(
        (result) => result.status === "fresh_in_progress",
      ).length;
      const failed = results.filter((result) =>
        result.status.startsWith("failed"),
      ).length;

      console.log(
        `📊 Stale keyword verifier complete: ${requeued} requeued, ${reconciled} completed, ${fresh} still fresh, ${failed} failed`,
      );

      return {
        message: "Stale keyword generation verifier complete",
        totalInProgressBusinesses: businesses.length,
        staleMinutes,
        requeued,
        reconciled,
        fresh,
        failed,
        results,
      };
    });
  },
);

export const generateBlogTask = createInngestFunction(
  {
    id: "generate-blog",
    ...blogGenerationFlowControl(),
    singleton: {
      key: "event.data.keywordId",
      mode: "skip",
    },
  },
  { event: "blog/generate" },
  async ({ event, step }) => {
    const { userId, keywordId, businessId, pipelineVersion } = event.data;

    const generationWorkerState = getBlogGenerationWorkerState();
    if (!generationWorkerState.enabled) {
      console.log(
        `⏭️ Skipping blog generation for keyword ${keywordId}: ${BLOG_GENERATION_WORKER_FLAG} is disabled.`,
        generationWorkerState,
      );
      return getBlogGenerationPausedResult({
        userId,
        keywordId,
        businessId,
        automationState: generationWorkerState,
      });
    }

    const userStatus = await step.run("check-user-trial-status", async () => {
      const userData = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          trialStatus: true,
          trialEndDate: true,
          role: true,
        },
      });

      if (!userData) {
        throw new NonRetriableError("Cannot generate blog: User not found");
      }

      if (isPlatformStaffSubscriptionBypassRole(userData.role)) {
        console.log(`ℹ️ Admin user ${userId} - bypassing subscription check`);
        return { userData, hasActiveTrial: false, isAdmin: true };
      }

      const ws = businessId
        ? await prisma.websiteSubscription.findUnique({
            where: { businessId },
          })
        : null;

      const hasActiveWebsiteSub =
        ws !== null &&
        (ws.status === "active" ||
          (ws.trialStatus === "trialing" &&
            ws.trialEndDate !== null &&
            ws.trialEndDate > new Date()));

      if (hasActiveWebsiteSub) {
        const hasActiveTrial =
          ws!.trialStatus === "trialing" &&
          ws!.trialEndDate !== null &&
          ws!.trialEndDate > new Date();
        return { userData, hasActiveTrial, isAdmin: false };
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          userId: userId,
          status: "active",
        },
      });

      const hasActiveSubscription = subscription !== null;
      const hasActiveTrial =
        userData.trialStatus === "active" &&
        userData.trialEndDate &&
        userData.trialEndDate > new Date();

      if (!hasActiveSubscription && !hasActiveTrial) {
        throw new NonRetriableError(
          "Cannot generate blog: No active website subscription or trial",
        );
      }

      return { userData, hasActiveTrial, isAdmin: false };
    });

    const resolvedPipelineVersion = resolvePinnedBlogPipelineVersion({
      planId: keywordId,
      pinnedVersion: pipelineVersion,
    });
    if (resolvedPipelineVersion !== BLOG_PIPELINE_V2_VERSION) {
      throw new NonRetriableError(
        `Unsupported blog pipeline version: ${resolvedPipelineVersion}`,
      );
    }

    // Events queued before the cutover may be retried after the retired writer
    // already persisted a Blog. Keep this quick ownership check durable, then
    // run new generation through provider-sized steps below.
    const existingBlog =
      pipelineVersion !== BLOG_PIPELINE_V2_VERSION
        ? await step.run("check-existing-v2-blog", async () => {
            const existingPlan = await prisma.plan.findUnique({
              where: { id: keywordId },
              select: {
                userId: true,
                businessId: true,
                blog: {
                  select: {
                    id: true,
                    userId: true,
                    businessId: true,
                    status: true,
                  },
                },
              },
            });
            const blog = existingPlan?.blog;
            return existingPlan &&
              blog &&
              existingPlan.userId === userId &&
              existingPlan.businessId === businessId &&
              blog.userId === userId &&
              blog.businessId === businessId &&
              blog.status === "PUBLISH"
              ? blog
              : null;
          })
        : null;

    let blogResult;
    if (existingBlog) {
      blogResult = {
        success: true as const,
        blog: existingBlog,
        blogId: existingBlog.id,
        alreadyExisted: true,
      };
    } else {
      try {
        const generated = await generateProductionV2Blog({
          planId: keywordId,
          userId,
          businessId,
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          correlationId: `${BLOG_PIPELINE_V2_VERSION}:${keywordId}`,
          durableStep: (id, handler) => step.run(id, handler),
        });
        blogResult = {
          success: true as const,
          blog: generated,
          blogId: generated.blogId,
          alreadyExisted: generated.alreadyExisted,
        };
      } catch (error: unknown) {
        const err = error as {
          status?: number;
          code?: string;
          error?: { code?: string };
          message?: string;
          name?: string;
        };
        console.error("Error generating blog with the production pipeline:", error);

        const isQuotaError =
          err?.status === 429 ||
          err?.code === "insufficient_quota" ||
          err?.error?.code === "insufficient_quota" ||
          err?.message?.includes("quota") ||
          err?.message?.includes("429") ||
          err?.name === "InsufficientQuotaError";

        if (isQuotaError) {
          console.warn(
            `⚠️ OpenAI quota exceeded for keyword ${keywordId}; leaving the Inngest run failed so it remains visible and retryable.`,
          );
          try {
            const { sendQuotaAlert } = await import("../utils/quota-alert");
            await sendQuotaAlert({
              service: "OpenAI",
              errorType: "OPENAI_QUOTA_EXCEEDED",
              errorMessage:
                "Production blog generation failed due to OpenAI quota exhaustion",
              userId,
              businessId,
              keywordId,
              additionalDetails: `Optimized pipeline failed for keyword ${keywordId}. Error: ${err?.message || "Unknown error"}`,
            });
          } catch (emailError) {
            console.error("Failed to send quota alert email:", emailError);
          }
        }

        throw error;
      }
    }

    if (blogResult.blogId) {
      await step.run("handoff-v2-blog-to-publishing", async () => {
        const queuedBlog = await prisma.blog.findUnique({
          where: { id: blogResult.blogId },
          select: {
            id: true,
            status: true,
            blogPublishDate: true,
            blogPublishTime: true,
            business: {
              select: {
                defaultLocale: true,
                businessCountry: true,
                businessState: true,
                businessCity: true,
              },
            },
          },
        });
        if (!queuedBlog) throw new Error("Production-v2 Blog was not found");
        const due = evaluateScheduleDue({
          publishDate: queuedBlog.blogPublishDate,
          publishTime: queuedBlog.blogPublishTime,
          defaultLocale: queuedBlog.business.defaultLocale,
          businessCountry: queuedBlog.business.businessCountry,
          businessState: queuedBlog.business.businessState,
          businessCity: queuedBlog.business.businessCity,
        });
        const decision = getProductionPublishingHandoffDecision({
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          blogId: queuedBlog.id,
          blogStatus: queuedBlog.status,
          isDue: due.isDue,
        });
        if (!decision.queued) return { ...decision, blogId: queuedBlog.id };
        await inngest.send(decision.event);
        await prisma.blogGenerationRun.updateMany({
          where: {
            correlationId: `${BLOG_PIPELINE_V2_VERSION}:${keywordId}`,
            blogId: queuedBlog.id,
          },
          data: { finalSaveStatus: "PUBLISH_HANDOFF_QUEUED" },
        });
        return { queued: true, blogId: queuedBlog.id };
      });
    }

    if (
      userStatus.hasActiveTrial &&
      !userStatus.isAdmin &&
      !(blogResult as { alreadyExisted?: boolean }).alreadyExisted
    ) {
      await step.run("send-blog-email-to-trial-user", async () => {
        try {
          const userData = await prisma.user.findUnique({
            where: { id: userId },
            select: {
              email: true,
              name: true,
              trialStartDate: true,
            },
          });

          const latestBlog = await prisma.blog.findFirst({
            where: {
              userId: userId,
              businessId: businessId,
            },
            orderBy: {
              createdAt: "desc",
            },
            select: {
              title: true,
              slug: true,
              excerpt: true,
            },
          });

          if (userData && latestBlog) {
            const { sendBlogEmail } =
              await import("../services/trial-email.service");

            const existingBlogs = await prisma.blog.count({
              where: { userId: userId },
            });

            const isFirstBlog = existingBlogs === 1;
            const userEmail: string = userData.email ?? "";
            const userName: string =
              (userData.name ?? userEmail.split("@")[0]) || "";

            await sendBlogEmail(
              userEmail,
              userName,
              latestBlog.title || "Your New Blog",
              latestBlog.slug || "",
              latestBlog.excerpt || "",
              isFirstBlog,
              userData.trialStartDate,
            );

            console.log(
              `✅ Blog email sent to trial user ${userData.email} - Blog: "${latestBlog.title}"`,
            );
          } else if (userData && !latestBlog) {
            console.warn(
              `⚠️ No blog found for user ${userId}, business ${businessId} - skipping email`,
            );
          }
        } catch (emailError) {
          console.error(
            `❌ Failed to send blog email to trial user:`,
            emailError,
          );
        }
      });
    }

    const resultData = (blogResult as { blog?: string }).blog;
    return {
      success: true,
      message: "Blog generated successfully",
      data: resultData,
      blogId: (blogResult as { blogId?: string }).blogId,
      alreadyExisted: (blogResult as { alreadyExisted?: boolean })
        .alreadyExisted,
    };
  },
);

export const dailyBlogScheduler = createInngestFunction(
  { id: "daily-blog-scheduler" },
  { cron: "0 2 * * *" },
  async ({ step }) => {
    return await step.run("schedule-due-blogs", async () => {
      try {
        const generationWorkerState = getBlogGenerationWorkerState();
        if (!generationWorkerState.enabled) {
          console.log(
            `⏭️ Skipping daily blog scheduler: ${BLOG_GENERATION_WORKER_FLAG} is disabled.`,
            generationWorkerState,
          );
          return getBlogGenerationPausedResult({
            automationState: generationWorkerState,
          });
        }

        const automationState = getBackgroundAutomationState(
          "DAILY_BLOG_SCHEDULER_ENABLED",
        );
        if (!automationState.enabled) {
          console.log(
            "⏭️ Skipping daily blog scheduler: DAILY_BLOG_SCHEDULER_ENABLED is disabled.",
            automationState,
          );
          return {
            message: "Daily blog scheduler disabled",
            skipped: true,
            reason: "daily_blog_scheduler_disabled",
            automationState,
          };
        }

        const now = new Date();
        const todayUtc = now.toISOString().split("T")[0] ?? "";
        console.log(
          `🕛 Starting daily blog generation scan for ${todayUtc} (2 AM UTC)...`,
        );

        const allCandidateKeywords = await getKeywordGenerationCandidates({ now });
        const batch = prepareDailyBlogSchedulerBatch(allCandidateKeywords, {
          now,
          maxPerRun: getPositiveIntegerEnv(
            "DAILY_BLOG_SCHEDULER_MAX_PER_RUN",
            DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_RUN,
          ),
          maxPerBusiness: getPositiveIntegerEnv(
            "DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS",
            DEFAULT_DAILY_BLOG_SCHEDULER_MAX_PER_BUSINESS,
          ),
        });
        const candidateKeywords = batch.selected;

        if (allCandidateKeywords.length === 0) {
          console.log("📝 No blog-generation keyword candidates found");
          return {
            message: "No blogs due for generation",
            count: 0,
            evaluatedAt: now.toISOString(),
            dateFilter: todayUtc,
            maxPerRun: batch.maxPerRun,
            maxPerBusiness: batch.maxPerBusiness,
          };
        }

        const uniqueUsers = new Set(candidateKeywords.map((k) => k.userId));
        console.log(
          `📊 Found ${allCandidateKeywords.length} due keywords; ${batch.eligibleCandidates} eligible; selected ${candidateKeywords.length} across ${uniqueUsers.size} users for ${todayUtc} (maxPerRun=${batch.maxPerRun}, maxPerBusiness=${batch.maxPerBusiness}, noAccess=${batch.excludedNoAccess}, noBusiness=${batch.excludedNoBusiness}, legacyNoBusinessId=${batch.excludedLegacyNoBusinessId}, skippedByBusinessCap=${batch.skippedByBusinessCap}, skippedByRunCap=${batch.skippedByRunCap})`,
        );

        const results: Array<{
          userId: string;
          keywordId: string;
          status: string;
          error?: string;
        }> = [];

        for (const keyword of candidateKeywords) {
          try {
            if (keyword.blogId) {
              console.log(
                `ℹ️ Blog already exists for keyword ${keyword.id} (blogId: ${keyword.blogId}), skipping`,
              );
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "already_exists",
              });
              continue;
            }

            if (!keyword.businessId) {
              console.log(
                `⏭️ [Daily Scheduler] Skipping keyword ${keyword.id} (businessId null) - no multi-business fan-out`,
                { keywordId: keyword.id, userId: keyword.userId },
              );
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "skipped_legacy_no_business_id",
              });
              continue;
            }

            if (!keyword.business || !keyword.business.isActive) {
              console.warn(
                `⚠️ Business ${keyword.businessId} not found or inactive for keyword ${keyword.id}, skipping`,
              );
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "no_business",
              });
              continue;
            }

            const hasAccess = hasDailyBlogGenerationAccess(keyword, now);
            if (!hasAccess) {
              console.log(
                `⏭️ [Daily Scheduler] Skipping blog generation for user ${keyword.userId} - no active website subscription or trial`,
              );
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "no_access",
              });
              continue;
            }

            console.log(
              `🔄 Scheduling blog for keyword ${keyword.id} (${keyword.keyword}) for business ${keyword.business.id} (${keyword.business.businessName})`,
            );

            await inngest.send({
              name: "blog/generate",
              data: buildPinnedBlogGenerateEventData(keyword.id, {
                userId: keyword.userId,
                keywordId: keyword.id,
                businessId: keyword.businessId,
                scheduledTime: keyword.publishTime,
              }),
            });

            results.push({
              userId: keyword.userId,
              keywordId: keyword.id,
              status: "scheduled",
            });
          } catch (error: any) {
            console.error(
              `❌ Error scheduling blog for keyword ${keyword.id} (user ${keyword.userId}):`,
              error,
            );
            results.push({
              userId: keyword.userId,
              keywordId: keyword.id,
              status: "error",
              error: error.message,
            });
          }
        }

        const successful = results.filter(
          (r) => r.status === "scheduled",
        ).length;
        const failed = results.filter((r) => r.status === "error").length;
        const skipped = results.filter(
          (r) => r.status === "already_exists",
        ).length;
        const noBusiness =
          batch.excludedNoBusiness +
          results.filter((r) => r.status === "no_business").length;
        const skippedLegacy =
          batch.excludedLegacyNoBusinessId +
          results.filter(
            (r) => r.status === "skipped_legacy_no_business_id",
          ).length;
        const noAccess =
          batch.excludedNoAccess +
          results.filter((r) => r.status === "no_access").length;

        console.log(
          `✅ Daily generation scan complete: ${successful} scheduled, ${noAccess} no access, ${failed} failed, ${skipped} skipped (already exist), ${noBusiness} no business, ${skippedLegacy} skipped (legacy no businessId), ${batch.skippedByBusinessCap} skipped by business cap, ${batch.skippedByRunCap} skipped by run cap`,
        );

        return {
          message: "Daily blog generation scan complete",
          evaluatedAt: now.toISOString(),
          dateFilter: todayUtc,
          totalDueKeywords: allCandidateKeywords.length,
          eligibleDueKeywords: batch.eligibleCandidates,
          totalKeywords: candidateKeywords.length,
          totalUsers: uniqueUsers.size,
          successful,
          failed,
          skipped,
          noBusiness,
          noAccess,
          skippedLegacyNoBusinessId: skippedLegacy,
          skippedByBusinessCap: batch.skippedByBusinessCap,
          skippedByRunCap: batch.skippedByRunCap,
          maxPerRun: batch.maxPerRun,
          maxPerBusiness: batch.maxPerBusiness,
          results,
        };
      } catch (error) {
        console.error("❌ Error in daily blog scheduler:", error);
        throw error;
      }
    });
  },
);

export const manualDailyBlogTrigger = createInngestFunction(
  { id: "manual-daily-blog-trigger" },
  { event: "blog/trigger-daily-generation" },
  async ({ event, step }) => {
    return await step.run("manual-daily-blog-trigger", async () => {
      try {
        const generationWorkerState = getBlogGenerationWorkerState();
        if (!generationWorkerState.enabled) {
          console.log(
            `⏭️ Skipping manual daily blog trigger: ${BLOG_GENERATION_WORKER_FLAG} is disabled.`,
            generationWorkerState,
          );
          return getBlogGenerationPausedResult({
            automationState: generationWorkerState,
          });
        }

        const { userId: scopeUserId, businessId: scopeBusinessId } =
          event.data as {
            userId?: string;
            businessId?: string;
          };
        if (!scopeUserId || !scopeBusinessId) {
          console.warn(
            "🔄 Manual trigger: userId and businessId required; skipping global run.",
          );
          return {
            message:
              "Manual daily trigger requires userId and businessId in event data.",
            count: 0,
            evaluatedAt: new Date().toISOString(),
          };
        }

        const now = new Date();
        const todayUtc = now.toISOString().split("T")[0] ?? "";
        console.log(
          `🔄 Manual trigger: scanning blog generation for ${todayUtc}`,
          scopeUserId,
          scopeBusinessId,
        );

        const candidateKeywords = await getKeywordGenerationCandidates({
          userId: scopeUserId,
          businessId: scopeBusinessId,
          now,
        });

        if (candidateKeywords.length === 0) {
          console.log(
            "📝 No candidate keywords found for manual daily trigger",
          );
          return {
            message: "No blogs due for generation",
            count: 0,
            evaluatedAt: now.toISOString(),
            dateFilter: todayUtc,
          };
        }

        const uniqueUsers = new Set(candidateKeywords.map((k) => k.userId));
        console.log(
          `📊 Found ${candidateKeywords.length} candidate keywords across ${uniqueUsers.size} users`,
        );

        const results: Array<{
          userId: string;
          keywordId: string;
          status: string;
          error?: string;
        }> = [];

        for (const keyword of candidateKeywords) {
          try {
            if (keyword.blogId) {
              console.log(
                `ℹ️ Blog already exists for keyword ${keyword.id} (blogId: ${keyword.blogId}), skipping`,
              );
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "already_exists",
              });
              continue;
            }

            if (!keyword.businessId) {
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "skipped_legacy_no_business_id",
              });
              continue;
            }

            if (!keyword.business || !keyword.business.isActive) {
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "no_business",
              });
              continue;
            }

            const hasAccess = hasDailyBlogGenerationAccess(keyword, now);
            if (!hasAccess) {
              results.push({
                userId: keyword.userId,
                keywordId: keyword.id,
                status: "no_access",
              });
              continue;
            }

            await inngest.send({
              name: "blog/generate",
              data: buildPinnedBlogGenerateEventData(keyword.id, {
                userId: keyword.userId,
                keywordId: keyword.id,
                businessId: keyword.businessId,
                scheduledTime: keyword.publishTime,
              }),
            });
            results.push({
              userId: keyword.userId,
              keywordId: keyword.id,
              status: "scheduled",
            });
          } catch (error: any) {
            console.error(
              `❌ Error scheduling blog for keyword ${keyword.id}:`,
              error,
            );
            results.push({
              userId: keyword.userId,
              keywordId: keyword.id,
              status: "error",
              error: error.message,
            });
          }
        }

        const successful = results.filter(
          (r) => r.status === "scheduled",
        ).length;
        const failed = results.filter((r) => r.status === "error").length;
        const skipped = results.filter(
          (r) => r.status === "already_exists",
        ).length;
        const noBusiness = results.filter(
          (r) => r.status === "no_business",
        ).length;
        const noAccess = results.filter((r) => r.status === "no_access").length;

        console.log(
          `✅ Manual trigger complete: ${successful} scheduled, ${noAccess} no access, ${failed} failed, ${skipped} skipped, ${noBusiness} no business`,
        );

        return {
          message: "Daily blog generation triggered manually",
          evaluatedAt: now.toISOString(),
          dateFilter: todayUtc,
          totalKeywords: candidateKeywords.length,
          totalUsers: uniqueUsers.size,
          successful,
          failed,
          skipped,
          noBusiness,
          noAccess,
          results,
        };
      } catch (error) {
        console.error("❌ Error in manual daily blog trigger:", error);
        throw error;
      }
    });
  },
);

export const brandAnalysisTask = createInngestFunction(
  {
    id: "brand-analysis",
    retries: 3,
    concurrency: {
      scope: "env",
      key: '"uplift-brand-analysis"',
      limit: INNGEST_BRAND_ANALYSIS_CONCURRENCY,
    },
    singleton: {
      key: "event.data.businessId",
      mode: "skip",
    },
  },
  { event: "brand/analyze" },
  async ({ event, step }) => {
    const { businessId, websiteUrl, userId } = event.data;
    const forceRefresh = event.data.forceRefresh === true;

    if (
      !websiteUrl ||
      typeof websiteUrl !== "string" ||
      websiteUrl.trim() === ""
    ) {
      console.warn(
        `⚠️ Skipping brand analysis for business ${businessId}: no valid websiteUrl provided`,
      );
      return {
        success: false,
        message: "Skipped: no valid website URL",
        businessId,
      };
    }

    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(
        websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`,
      );
    } catch {
      console.warn(
        `⚠️ Skipping brand analysis for business ${businessId}: invalid URL "${websiteUrl}"`,
      );
      return {
        success: false,
        message: "Skipped: invalid website URL",
        businessId,
      };
    }

    const resolvedUrl = parsedUrl.toString();

    const verifiedBusiness = await step.run(
      "verify-brand-analysis-business",
      async () => {
        const business = await prisma.business.findFirst({
          where: {
            id: businessId,
            isActive: true,
            ...(userId ? { userId } : {}),
          },
          select: { id: true, userId: true },
        });
        if (!business) {
          throw new NonRetriableError(
            "Brand analysis business was not found or is not owned by the requesting user",
          );
        }
        return business;
      },
    );

    const brandData = await step.run("analyze-brand", async () => {
      try {
        console.log(`🔄 Starting brand analysis for business ${businessId}`);

        const existingAnalysis = await prisma.brandAnalysis.findUnique({
          where: { businessId },
        });

        if (existingAnalysis && !forceRefresh) {
          console.log(
            `✅ Brand analysis already exists for business ${businessId}`,
          );
          return existingAnalysis;
        }

        const brandAnalysis = new BrandAnalysisService();
        const analyzedBrand = await brandAnalysis.analyzeBrand(resolvedUrl);

        // Analysis can take long enough for an owner to upload a preferred
        // logo while it is running. Re-read before persisting so that explicit
        // user choice is retained instead of an older scraped reference.
        const currentAnalysis = await prisma.brandAnalysis.findUnique({
          where: { businessId },
        });

        const preserveApprovedLogo = isCanonicalBunnyBrandLogoUrl(
          currentAnalysis?.logoUrl,
        );
        const preserveApprovedIdentity =
          preserveApprovedLogo &&
          currentAnalysis?.analysisVersion.startsWith("onboarding-v2-") ===
            true;
        let canonicalLogoUrl = preserveApprovedLogo
          ? currentAnalysis?.logoUrl ?? null
          : analyzedBrand.logoUrl ?? currentAnalysis?.logoUrl ?? null;
        if (
          canonicalLogoUrl &&
          !isCanonicalBunnyBrandLogoUrl(canonicalLogoUrl)
        ) {
          try {
            const canonical = await canonicalizeRemoteBusinessBrandLogo({
              businessId,
              logoUrl: canonicalLogoUrl,
              userId: verifiedBusiness.userId,
            });
            canonicalLogoUrl = canonical.url;
          } catch (error) {
            console.warn(
              `Brand logo canonicalization failed for business ${businessId}; preserving the best existing reference`,
              error,
            );
          }
        }

        const analysisFields = {
          primaryColors: preserveApprovedIdentity
            ? currentAnalysis?.primaryColors ?? []
            : analyzedBrand.primaryColors.length > 0
              ? analyzedBrand.primaryColors
              : currentAnalysis?.primaryColors ?? [],
          secondaryColors: preserveApprovedIdentity
            ? currentAnalysis?.secondaryColors ?? []
            : analyzedBrand.secondaryColors.length > 0
              ? analyzedBrand.secondaryColors
              : currentAnalysis?.secondaryColors ?? [],
          fontFamily: preserveApprovedIdentity
            ? currentAnalysis?.fontFamily ?? null
            : analyzedBrand.fontFamily ?? currentAnalysis?.fontFamily ?? null,
          logoUrl: canonicalLogoUrl,
          logoAltText: preserveApprovedLogo
            ? currentAnalysis?.logoAltText ?? analyzedBrand.logoAltText
            : analyzedBrand.logoAltText ?? currentAnalysis?.logoAltText,
          faviconUrl:
            analyzedBrand.faviconUrl ?? currentAnalysis?.faviconUrl ?? null,
          referenceImageUrl: preserveApprovedIdentity
            ? currentAnalysis?.referenceImageUrl ?? null
            : analyzedBrand.referenceImageUrl ??
              currentAnalysis?.referenceImageUrl ??
              null,
          lastAnalyzed: new Date(),
          analysisVersion: preserveApprovedIdentity
            ? currentAnalysis?.analysisVersion ??
              "onboarding-v2-context-v1"
            : analyzedBrand.analysisSource?.startsWith(
                  "context.dev.brand.retrieve",
                )
              ? "context-dev-brand-v1"
              : "3.0",
        };
        const brandData = await prisma.brandAnalysis.upsert({
          where: { businessId },
          create: {
            businessId,
            ...analysisFields,
          },
          update: analysisFields,
        });

        if (analyzedBrand.blogImages && analyzedBrand.blogImages.length > 0) {
          try {
            await prisma.blogImage.deleteMany({
              where: { businessId, source: "scraped" },
            });

            await prisma.blogImage.createMany({
              data: analyzedBrand.blogImages.map((img) => ({
                businessId,
                imageUrl: img.url,
                imageAlt: img.alt,
                blogUrl: img.blogUrl,
                blogTitle: img.blogTitle,
                imageType: img.type,
                width: img.width,
                height: img.height,
              })),
            });

            console.log(
              `✅ Saved ${analyzedBrand.blogImages.length} blog images for business ${businessId}`,
            );
          } catch (error) {
            console.error("❌ Failed to save blog images:", error);
          }
        }

        console.log(`✅ Brand analysis completed for business ${businessId}`);
        console.log(
          `   - Extracted ${brandData.primaryColors.length} primary colors`,
        );
        console.log(`   - Logo URL: ${brandData.logoUrl || "not found"}`);
        console.log(`   - Favicon URL: ${brandData.faviconUrl || "not found"}`);
        return brandData;
      } catch (error) {
        console.error("❌ Brand analysis failed:", error);

        // Save error state to database
        await prisma.brandAnalysis.upsert({
          where: { businessId },
          create: {
            businessId,
            primaryColors: ["#000000", "#ffffff", "#007bff"],
            secondaryColors: ["#6c757d", "#28a745", "#dc3545"],
            fontFamily: "Arial, sans-serif",
            logoUrl: null,
            logoAltText: null,
            faviconUrl: null,
            lastAnalyzed: new Date(),
            analysisVersion: "3.0-error",
          },
          update: {
            lastAnalyzed: new Date(),
            analysisVersion: "3.0-error",
          },
        });

        throw error;
      }
    });

    console.log(`✅ Brand analysis completed for business ${businessId}`);

    return {
      success: true,
      message: "Brand analysis completed successfully",
      businessId,
      brandData: {
        primaryColors: brandData.primaryColors,
        secondaryColors: brandData.secondaryColors,
        fontFamily: brandData.fontFamily,
        logoUrl: brandData.logoUrl,
        logoAltText: brandData.logoAltText,
        faviconUrl: brandData.faviconUrl,
      },
    };
  },
);

export const scheduledBlogDistributionScannerTask = createInngestFunction(
  {
    id: "scheduled-blog-distribution-scanner",
    name: "Dispatch Due Blog Publishing And GMB Work",
    retries: 1,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    return await step.run("dispatch-due-publishing-work", async () => {
      const automationState = getBackgroundAutomationState(
        "PUBLISHING_DISPATCH_CRON_ENABLED",
      );
      if (!automationState.enabled) {
        console.log(
          "⏭️ Skipping scheduled publishing dispatch: PUBLISHING_DISPATCH_CRON_ENABLED is not enabled for this runtime.",
        );
        return {
          skipped: true,
          reason: "publishing_dispatch_cron_disabled",
          automationState,
        };
      }

      const now = new Date();
      const queryDateCeiling = getUtcScheduleQueryCeiling(now, 1);

      try {
        console.log(
          "🕒 Scanning due blog publishing and standalone scheduled GMB work...",
        );

        const [hasCandidateBlogs, hasScheduledGmbPosts] = await Promise.all([
          prisma.blog.findFirst({
            where: {
              status: STATUS.PUBLISH,
              blogPublishDate: {
                lte: queryDateCeiling,
              },
              business: {
                isActive: true,
              },
            },
            select: { id: true },
          }),
          prisma.gMBPostSuggestion.findFirst({
            where: {
              status: "SCHEDULED",
              scheduledAt: {
                lte: now,
              },
            },
            select: { id: true },
          }),
        ]);

        if (!hasCandidateBlogs && !hasScheduledGmbPosts) {
          return {
            message: "No due publishing work",
            evaluatedAt: now.toISOString(),
            queryDateCeiling,
            totalCandidateBlogs: 0,
            dueBlogsScanned: 0,
            blogsQueuedForCms: 0,
            blogsQueuedForGmb: 0,
            blogsAlreadyDispatched: 0,
            blogsNotDueYet: 0,
            standaloneScheduledGmbFound: 0,
            standaloneScheduledGmbPublished: 0,
            standaloneScheduledGmbSkipped: 0,
            failures: 0,
            blogResults: [],
            standaloneGmbResults: [],
          };
        }

        const candidateBlogs = hasCandidateBlogs
          ? await prisma.blog.findMany({
              where: {
                status: STATUS.PUBLISH,
                blogPublishDate: {
                  lte: queryDateCeiling,
                },
                business: {
                  isActive: true,
                },
              },
              select: {
                id: true,
                userId: true,
                businessId: true,
                title: true,
                analytics: true,
                blogPublishDate: true,
                blogPublishTime: true,
                createdAt: true,
                business: {
                  select: {
                    id: true,
                    businessName: true,
                    isActive: true,
                    defaultLocale: true,
                    businessCountry: true,
                    businessState: true,
                    businessCity: true,
                  },
                },
                publishedBlogs: {
                  select: {
                    integrationId: true,
                    status: true,
                  },
                },
                GMBPostSuggestions: {
                  select: {
                    status: true,
                  },
                },
              },
              orderBy: [
                { blogPublishDate: "asc" },
                { blogPublishTime: "asc" },
                { createdAt: "asc" },
              ],
            })
          : [];

        const businessIds = Array.from(
          new Set(candidateBlogs.map((blog) => blog.businessId)),
        );

        const [activeIntegrations, activeGmbConnections] =
          businessIds.length > 0
            ? await Promise.all([
                prisma.publishingIntegration.findMany({
                  where: {
                    businessId: { in: businessIds },
                    isActive: true,
                    autoPublish: true,
                  },
                  select: {
                    id: true,
                    businessId: true,
                  },
                }),
                prisma.googleMyBusiness.findMany({
                  where: {
                    businessId: { in: businessIds },
                    isActive: true,
                    postAutomationMode: "auto_publish",
                    accountId: { not: null },
                    locationId: { not: null },
                  },
                  select: {
                    businessId: true,
                  },
                }),
              ])
            : [[], []];

        const integrationIdsByBusiness = new Map<string, string[]>();
        for (const integration of activeIntegrations) {
          if (!integration.businessId) {
            continue;
          }

          const current =
            integrationIdsByBusiness.get(integration.businessId) ?? [];
          current.push(integration.id);
          integrationIdsByBusiness.set(integration.businessId, current);
        }

        const gmbBusinessIds = new Set(
          activeGmbConnections
            .map((connection) => connection.businessId)
            .filter((businessId): businessId is string => Boolean(businessId)),
        );

        const results: Array<{
          blogId: string;
          businessId: string;
          status: string;
          queuedAutoPublish: boolean;
          queuedGmb: boolean;
          timeZone?: string;
          localDate?: string;
          localTime?: string;
          error?: string;
        }> = [];
        let dueBlogsScanned = 0;
        let blogsQueuedForCms = 0;
        let blogsQueuedForGmb = 0;

        for (const blog of candidateBlogs) {
          try {
            if (isQuickTrialSampleBlog(blog.analytics)) {
              results.push({
                blogId: blog.id,
                businessId: blog.businessId,
                status: "quick_trial_sample",
                queuedAutoPublish: false,
                queuedGmb: false,
              });
              continue;
            }

            const dueEvaluation = evaluateScheduleDue({
              publishDate: blog.blogPublishDate,
              publishTime: blog.blogPublishTime,
              defaultLocale: blog.business.defaultLocale,
              businessCountry: blog.business.businessCountry,
              businessState: blog.business.businessState,
              businessCity: blog.business.businessCity,
              now,
            });

            if (!dueEvaluation.isDue) {
              results.push({
                blogId: blog.id,
                businessId: blog.businessId,
                status: "not_due_yet",
                queuedAutoPublish: false,
                queuedGmb: false,
                timeZone: dueEvaluation.timeZone,
                localDate: dueEvaluation.date,
                localTime: dueEvaluation.time,
              });
              continue;
            }

            dueBlogsScanned++;

            const decision = getBlogDispatchDecision({
              activeIntegrationIds:
                integrationIdsByBusiness.get(blog.businessId) ?? [],
              publishedBlogs: blog.publishedBlogs,
              hasGmbConnection: gmbBusinessIds.has(blog.businessId),
              gmbPostStatuses: blog.GMBPostSuggestions.map(
                (entry) => entry.status,
              ),
            });

            if (decision.status === "already_dispatched") {
              results.push({
                blogId: blog.id,
                businessId: blog.businessId,
                status: "already_dispatched",
                queuedAutoPublish: false,
                queuedGmb: false,
                timeZone: dueEvaluation.timeZone,
                localDate: dueEvaluation.date,
                localTime: dueEvaluation.time,
              });
              continue;
            }

            let queuedAutoPublish = false;
            let queuedGmb = false;

            if (decision.needsAutoPublish) {
              await inngest.send({
                name: "publishing/auto-publish",
                data: {
                  blogId: blog.id,
                },
              });
              queuedAutoPublish = true;
              blogsQueuedForCms++;
            }

            if (decision.needsGmb) {
              await inngest.send({
                name: "gmb/auto-post-from-blog",
                data: {
                  blogId: blog.id,
                  businessId: blog.businessId,
                },
              });
              queuedGmb = true;
              blogsQueuedForGmb++;
            }

            results.push({
              blogId: blog.id,
              businessId: blog.businessId,
              status: "queued",
              queuedAutoPublish,
              queuedGmb,
              timeZone: dueEvaluation.timeZone,
              localDate: dueEvaluation.date,
              localTime: dueEvaluation.time,
            });
          } catch (error: any) {
            console.error(
              `❌ Error queueing scheduled distribution for blog ${blog.id}:`,
              error,
            );
            results.push({
              blogId: blog.id,
              businessId: blog.businessId,
              status: "error",
              queuedAutoPublish: false,
              queuedGmb: false,
              error: error.message,
            });
          }
        }

        let standaloneScheduledGmbFound = 0;
        let standaloneScheduledGmbPublished = 0;
        let standaloneScheduledGmbSkipped = 0;
        let standaloneScheduledGmbFailed = 0;
        const standaloneGmbResults: Array<{
          suggestionId: string;
          businessId: string;
          status: "published" | "failed" | "skipped";
          error?: string;
        }> = [];

        if (hasScheduledGmbPosts) {
          console.log("📅 Checking for standalone scheduled GMB posts...");

          const scheduledPosts = await prisma.gMBPostSuggestion.findMany({
            where: {
              status: "SCHEDULED",
              scheduledAt: {
                lte: now,
              },
            },
            include: {
              business: {
                select: {
                  id: true,
                  businessName: true,
                  businessType: true,
                  GoogleMyBusiness: {
                    select: {
                      id: true,
                      isActive: true,
                      postAutomationMode: true,
                    },
                  },
                },
              },
            },
            take: 10,
          });

          standaloneScheduledGmbFound = scheduledPosts.length;

          if (scheduledPosts.length > 0) {
            const { GoogleMyBusinessService } =
              await import("../services/google-my-business.service");
            const { imageGenerationService } =
              await import("../services/image-generation.service");
            const gmbService = new GoogleMyBusinessService();

            for (const suggestion of scheduledPosts) {
              try {
                if (
                  !suggestion.business?.GoogleMyBusiness?.isActive ||
                  !suggestion.business?.GoogleMyBusiness?.id ||
                  suggestion.business?.GoogleMyBusiness?.postAutomationMode !==
                    "auto_publish"
                ) {
                  const skipReason = suggestion.business?.GoogleMyBusiness
                    ?.postAutomationMode &&
                    suggestion.business.GoogleMyBusiness.postAutomationMode !==
                      "auto_publish"
                    ? `GMB auto-post requires auto_publish mode (currently ${suggestion.business.GoogleMyBusiness.postAutomationMode})`
                    : "No active GMB connection";
                  console.log(
                    `⏭️ Skipping standalone scheduled GMB suggestion ${suggestion.id} - ${skipReason}`,
                  );
                  standaloneScheduledGmbSkipped++;
                  standaloneGmbResults.push({
                    suggestionId: suggestion.id,
                    businessId: suggestion.businessId,
                    status: "skipped",
                    error: skipReason,
                  });
                  continue;
                }

                let mediaUrls = (suggestion.mediaUrls as string[]) || [];

                if (mediaUrls.length === 0 && suggestion.business) {
                  const imageResult =
                    await imageGenerationService.generateGMBPostImage(
                      suggestion.business.businessName,
                      suggestion.title || suggestion.summary.substring(0, 50),
                      suggestion.postType,
                      suggestion.business.businessType || undefined,
                      suggestion.summary || undefined,
                    );

                  if (imageResult.success && imageResult.imageUrl) {
                    mediaUrls = [imageResult.imageUrl];
                    console.log(
                      `🖼️ Auto-generated image for standalone scheduled GMB post ${suggestion.id}`,
                    );
                  }
                }

                const post = await gmbService.createPost(suggestion.businessId, {
                  postType: suggestion.postType as
                    | "UPDATE"
                    | "EVENT"
                    | "OFFER"
                    | "PRODUCT",
                  summary: suggestion.summary,
                  callToAction: suggestion.callToAction || undefined,
                  mediaUrls,
                  title: suggestion.title || undefined,
                });

                await prisma.gMBPostSuggestion.update({
                  where: { id: suggestion.id },
                  data: {
                    status: "PUBLISHED",
                    publishedAt: new Date(),
                    gmbPostId: post.id || null,
                    mediaUrls,
                  },
                });

                standaloneScheduledGmbPublished++;
                standaloneGmbResults.push({
                  suggestionId: suggestion.id,
                  businessId: suggestion.businessId,
                  status: "published",
                });
                console.log(
                  `✅ Published standalone scheduled GMB post ${suggestion.id} for business ${suggestion.business?.businessName}`,
                );
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : "Unknown error";
                console.error(
                  `❌ Failed to publish standalone scheduled GMB post ${suggestion.id}:`,
                  error,
                );

                await prisma.gMBPostSuggestion.update({
                  where: { id: suggestion.id },
                  data: {
                    status: "PENDING",
                  },
                });

                standaloneScheduledGmbFailed++;
                standaloneGmbResults.push({
                  suggestionId: suggestion.id,
                  businessId: suggestion.businessId,
                  status: "failed",
                  error: errorMessage,
                });
              }
            }
          }
        }

        const notDueYet = results.filter(
          (result) => result.status === "not_due_yet",
        ).length;
        const alreadyDispatched = results.filter(
          (result) => result.status === "already_dispatched",
        ).length;
        const blogFailures = results.filter(
          (result) => result.status === "error",
        ).length;
        const failures = blogFailures + standaloneScheduledGmbFailed;

        console.log(
          `✅ Unified publishing dispatch complete: ${dueBlogsScanned} due blogs scanned, ${blogsQueuedForCms} blogs queued for CMS publish, ${blogsQueuedForGmb} blogs queued for blog-to-GMB, ${alreadyDispatched} blogs already dispatched, ${standaloneScheduledGmbFound} standalone scheduled GMB posts found, ${standaloneScheduledGmbPublished} standalone scheduled GMB posts published, ${standaloneScheduledGmbSkipped} standalone scheduled GMB posts skipped, ${failures} failures`,
        );

        return {
          message: "Unified publishing dispatch complete",
          evaluatedAt: now.toISOString(),
          queryDateCeiling,
          totalCandidateBlogs: candidateBlogs.length,
          dueBlogsScanned,
          blogsQueuedForCms,
          blogsQueuedForGmb,
          blogsAlreadyDispatched: alreadyDispatched,
          blogsNotDueYet: notDueYet,
          standaloneScheduledGmbFound,
          standaloneScheduledGmbPublished,
          standaloneScheduledGmbSkipped,
          failures,
          blogResults: results,
          standaloneGmbResults,
        };
      } catch (error) {
        console.error("❌ Error in unified publishing dispatch scan:", error);
        throw error;
      }
    });
  },
);

export const autoPublishBlogTask = createInngestFunction(
  {
    id: "auto-publish-blog",
    singleton: {
      key: "event.data.blogId",
      mode: "skip",
    },
  },
  { event: "publishing/auto-publish" },
  async ({ event, step }) => {
    const { blogId } = event.data;

    const automationState = getAutoPublishBlogTaskState();
    if (!automationState.enabled) {
      console.log(
        `⏭️ Skipping queued auto-publish for blog ${blogId}: ${AUTO_PUBLISH_BLOG_TASK_FLAG} is disabled.`,
      );
      return {
        success: true,
        skipped: true,
        paused: true,
        status: "paused",
        reason: "auto_publish_blog_task_disabled",
        blogId,
        automationState,
      };
    }

    return await step.run("auto-publish-blog", async () => {
      try {
        console.log(`🔄 Starting auto-publish for blog ${blogId}`);

        // Fetch blog with all related data including business
        const blog = await prisma.blog.findUnique({
          where: { id: blogId },
          include: {
            meta: true,
            customField: true,
            user: true,
            business: true,
          },
        });

        if (!blog) {
          throw new Error(`Blog ${blogId} not found`);
        }

        if (isQuickTrialSampleBlog(blog.analytics)) {
          console.log(
            `⏭️ Skipping auto-publish for blog ${blogId} — quick trial sample blogs remain dashboard previews`,
          );
          return {
            success: false,
            skipped: true,
            message: "Skipped: quick trial sample blog",
          };
        }

        // Legacy quick/sample trial blogs have no explicit marker or featured image.
        if (!blog.featured_media || blog.featured_media.trim() === "") {
          console.log(
            `⏭️ Skipping auto-publish for blog ${blogId} — no featured image (likely a quick trial/sample blog)`,
          );
          return {
            success: false,
            skipped: true,
            message: "Skipped: quick trial/sample blog with no featured image",
          };
        }

        const dueEvaluation = evaluateScheduleDue({
          publishDate: blog.blogPublishDate,
          publishTime: blog.blogPublishTime,
          defaultLocale: blog.business.defaultLocale,
          businessCountry: blog.business.businessCountry,
          businessState: blog.business.businessState,
          businessCity: blog.business.businessCity,
        });

        if (!dueEvaluation.isDue) {
          console.log(
            `⏳ Skipping auto-publish for blog ${blogId}; not due until ${blog.blogPublishDate} ${blog.blogPublishTime} (${dueEvaluation.timeZone}; local now ${dueEvaluation.date} ${dueEvaluation.time})`,
          );
          return {
            success: false,
            deferred: true,
            message: "Blog is not due for publishing yet",
            publishDate: blog.blogPublishDate,
            publishTime: blog.blogPublishTime,
            timeZone: dueEvaluation.timeZone,
            localDate: dueEvaluation.date,
            localTime: dueEvaluation.time,
          };
        }

        // Use blog.userId (database User ID) instead of event userId
        // Get active integrations with auto-publish enabled for this specific business ONLY
        // Note: autoPublish must be explicitly true (not null or false)
        // STRICT: Only match integrations with the EXACT businessId - no legacy fallback
        // This prevents publishing to multiple sites when user has multiple businesses

        console.log(
          `🔍 Looking for integrations with businessId: ${blog.businessId}`,
        );

        const integrations = await prisma.publishingIntegration.findMany({
          where: {
            userId: blog.userId,
            businessId: blog.businessId,
            isActive: true,
            autoPublish: true,
          },
          include: {
            wordpressOAuthToken: true,
            shopifyOAuthToken: true,
            webflowOAuthToken: true,
          },
        });

        console.log(
          `🔍 Found ${integrations.length} integrations for businessId: ${blog.businessId}`,
        );

        if (integrations.length === 0) {
          console.log(
            `ℹ️ No auto-publish integrations found for user ${blog.userId}, business ${blog.businessId}`,
          );
          return {
            success: true,
            message:
              "No auto-publish integrations configured for this business",
            publishedCount: 0,
          };
        }

        console.log(
          `📤 Publishing blog ${blogId} (business: ${blog.business?.businessName || blog.businessId}) to ${integrations.length} platform(s)`,
        );
        const normalizedFeaturedMedia = normalizeCloudinaryImageUrl(
          blog.featured_media || "",
        );
        const normalizedContent = sanitizeBlogContentImageSources(
          blog.content,
        ).content;

        // Prepare blog data
        const blogData = {
          id: blog.id,
          title: blog.title,
          content: normalizedContent,
          excerpt: blog.excerpt,
          slug: blog.slug,
          featured_media: normalizedFeaturedMedia,
          status: blog.status === "PUBLISH" ? "publish" : "draft",
          userId: blog.userId,
          blogPublishDate: blog.blogPublishDate,
          blogPublishTime: blog.blogPublishTime,
          meta: blog.meta
            ? buildExtendedBlogMeta({
                title: blog.title,
                excerpt: blog.excerpt,
                slug: blog.slug,
                meta: {
                  ...blog.meta,
                  ...extractStoredSeoMeta(blog.analytics),
                },
                categories: blog.categories,
                tags: blog.tags,
                authorName: blog.authorName,
                businessName: blog.business?.businessName,
                businessWebsiteUrl: blog.business?.businessWebsiteUrl,
                defaultLocale: blog.business?.defaultLocale,
              })
            : undefined,
          custom_fields: blog.customField
            ? {
                reading_time: blog.customField.reading_time,
                rating: blog.customField.rating,
              }
            : undefined,
          categories: blog.categories,
          tags: blog.tags,
        };

        const publishingService = new PublishingService();
        const results = [];

        for (const integration of integrations) {
          const attemptId = `${blog.id}:${integration.id}:${Date.now()}`;
          const lockResult = await tryAcquirePublishLock(
            blog.id,
            integration.id,
            attemptId,
            integration.platform,
          );

          if (!lockResult.acquired && lockResult.alreadyPublishing) {
            console.log(
              `[auto-publish] lock_skipped blogId=${blog.id} integrationId=${integration.id} reason=already_publishing`,
            );
            results.push({
              integrationId: integration.id,
              platform: integration.platform,
              success: false,
              message: "already publishing",
              skipped: true,
            });
            continue;
          }
          if (lockResult.staleRecovered) {
            console.log(
              `[auto-publish] stale_lock_recovered blogId=${blog.id} integrationId=${integration.id}`,
            );
          }
          console.log(
            `[auto-publish] lock_acquired blogId=${blog.id} integrationId=${integration.id} attemptId=${attemptId}`,
          );

          let publishedBlog = await prisma.publishedBlog.findUnique({
            where: {
              blogId_integrationId: {
                blogId: blog.id,
                integrationId: integration.id,
              },
            },
          });

          if (
            publishedBlog &&
            publishedBlog.status === PublishStatus.PUBLISHED &&
            publishedBlog.externalPostId
          ) {
            await releasePublishLock(blog.id, integration.id);
            results.push({
              integrationId: integration.id,
              platform: integration.platform,
              success: true,
              postId: publishedBlog.externalPostId,
              postUrl: publishedBlog.externalPostUrl ?? undefined,
              message: "Already published",
              skipped: true,
            });
            continue;
          }

          if (!publishedBlog) {
            publishedBlog = await prisma.publishedBlog.create({
              data: {
                blogId: blog.id,
                integrationId: integration.id,
                platform: integration.platform,
                status: PublishStatus.PUBLISHING,
              },
            });
          } else {
            await prisma.publishedBlog.update({
              where: { id: publishedBlog.id },
              data: { status: PublishStatus.PUBLISHING },
            });
          }

          try {
            const publishData = { ...blogData, attemptId };
            const publishResult = await publishingService.publishBlogWithRetry(
              publishData,
              integration as any,
            );

            const resolvedStatus = publishResult.success
              ? PublishStatus.PUBLISHED
              : publishResult.inProgress
                ? PublishStatus.PENDING
                : PublishStatus.FAILED;

            await prisma.publishedBlog.update({
              where: { id: publishedBlog.id },
              data: {
                status: resolvedStatus,
                externalPostId: publishResult.postId,
                externalPostUrl: publishResult.postUrl,
                publishStatus: publishResult.status,
                lastError: publishResult.error || publishResult.message,
                lastSyncedAt: new Date(),
                publishedAt: publishResult.success ? new Date() : null,
                platformResponse: publishResult.platformResponse,
                retryCount: publishResult.success
                  ? 0
                  : publishedBlog.retryCount + 1,
              },
            });

            if (publishResult.success && publishResult.postUrl) {
              try {
                await updateBlogUrl(blog.id, publishResult.postUrl);
              } catch (err) {
                console.error("Failed to update blog URL in Pinecone:", err);
              }

              try {
                await syncManagedBacklinksForPublishedBlog({
                  blogId: blog.id,
                  publishedUrl: publishResult.postUrl,
                });
              } catch (err) {
                console.error(
                  "Failed to sync managed cross-links after auto-publish:",
                  err,
                );
              }

              // Trigger DR content optimization for the published blog
              try {
                await inngest.send({
                  name: "dr/optimize-content",
                  data: {
                    blogId: blog.id,
                    businessId: blog.businessId,
                  },
                });
                console.log(
                  `[auto-publish] DR content optimization queued for blog ${blog.id}`,
                );
              } catch (err) {
                console.error(
                  "Failed to queue DR content optimization:",
                  err,
                );
              }
            }

            if (publishResult.success) {
              console.log(
                `[auto-publish] publish_success blogId=${blog.id} integrationId=${integration.id} postId=${publishResult.postId ?? ""}`,
              );
            } else {
              console.log(
                `[auto-publish] publish_failed blogId=${blog.id} integrationId=${integration.id} error=${publishResult.error ?? ""}`,
              );
            }
            results.push({
              integrationId: integration.id,
              platform: integration.platform,
              success: publishResult.success,
              postId: publishResult.postId,
              postUrl: publishResult.postUrl,
              error: publishResult.error,
            });
          } catch (error: unknown) {
            const errMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `Error publishing to integration ${integration.id}:`,
              error,
            );

            if (publishedBlog) {
              try {
                await prisma.publishedBlog.update({
                  where: { id: publishedBlog.id },
                  data: {
                    status: PublishStatus.FAILED,
                    lastError: errMsg,
                    lastSyncedAt: new Date(),
                    retryCount: publishedBlog.retryCount + 1,
                  },
                });
                console.log(
                  `[auto-publish] Updated PublishedBlog ${publishedBlog.id} to FAILED status after exception`,
                );
              } catch (updateError) {
                console.error(
                  `[auto-publish] Failed to update PublishedBlog status to FAILED:`,
                  updateError,
                );
              }
            }

            results.push({
              integrationId: integration.id,
              platform: integration.platform,
              success: false,
              error: errMsg,
            });
          } finally {
            await releasePublishLock(blog.id, integration.id);
          }
        }

        const successCount = results.filter((r) => r.success).length;

        console.log(
          `✅ Auto-publish completed: ${successCount}/${results.length} successful`,
        );

        return {
          success: true,
          message: `Published to ${successCount}/${results.length} platforms`,
          results,
          publishedCount: successCount,
        };
      } catch (error: any) {
        console.error(`❌ Error in auto-publish task:`, error);
        throw error;
      }
    });
  },
);

/**
 * Scheduled task to sync external backlinks daily
 */
export const syncExternalBacklinksTask = createInngestFunction(
  { id: "sync-external-backlinks" },
  {
    cron: "0 4 * * *", // Daily at 4 AM (moved from 2 AM to avoid conflicts)
  },
  async ({ step }) => {
    return await step.run("sync-all-businesses", async () => {
      try {
        console.log("🔄 Starting daily external backlinks sync...");

        // Get backlink-enabled candidates, then enforce paid eligibility per business.
        const candidateBusinesses = await prisma.business.findMany({
          where: {
            isActive: true,
            businessWebsiteUrl: { not: "" },
            User: {
              backlinkEnabled: true,
            },
          },
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            isActive: true,
            websiteSubscription: {
              select: {
                status: true,
                trialStatus: true,
                stripeSubscriptionId: true,
                stripeSubscriptionItemId: true,
                stripePriceId: true,
              },
            },
            User: {
              select: {
                backlinkEnabled: true,
                Subscription: {
                  select: {
                    status: true,
                    currentPeriodEnd: true,
                  },
                },
              },
            },
          },
        });
        const businesses = candidateBusinesses.filter((business) =>
          getBusinessBacklinkServiceEligibility(business).eligible,
        );

        console.log(
          `📊 Found ${businesses.length}/${candidateBusinesses.length} paid businesses with backlinks enabled`,
        );

        if (businesses.length === 0) {
          return {
            success: true,
            message: "No paid businesses with backlinks enabled",
            synced: 0,
            total: 0,
          };
        }

        const service = new ExternalBacklinksService();
        const results = [];

        for (const business of businesses) {
          try {
            const result = await service.syncBacklinksForBusiness(
              business.id,
              business.businessWebsiteUrl,
            );
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              success: result.success,
              backlinksCount: result.backlinksCount,
            });

            // Trigger DR lost link processing after successful sync
            if (result.success) {
              try {
                await inngest.send({
                  name: "dr/backlink-sync-complete",
                  data: { businessId: business.id },
                });
              } catch (drErr) {
                console.error("Failed to trigger DR lost link processing:", drErr);
              }
            }
          } catch (error: any) {
            console.error(
              `❌ Failed to sync backlinks for business ${business.id}:`,
              error,
            );
            results.push({
              businessId: business.id,
              businessName: business.businessName,
              success: false,
              error: error.message,
            });
          }

          // Add delay between businesses to respect rate limits (except for the last one)
          if (businesses.indexOf(business) < businesses.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 seconds
            console.log(`⏳ Waiting 5 seconds before next business...`);
          }
        }

        const successCount = results.filter((r) => r.success).length;

        console.log(
          `✅ Daily backlinks sync completed: ${successCount}/${results.length} successful`,
        );

        return {
          success: true,
          message: `Synced ${successCount}/${results.length} businesses`,
          synced: successCount,
          total: results.length,
          results,
        };
      } catch (error: any) {
        console.error("❌ Error in daily backlinks sync:", error);
        throw error;
      }
    });
  },
);

/**
 * Manual sync triggered by user
 */
export const manualSyncBacklinksTask = createInngestFunction(
  { id: "manual-sync-backlinks" },
  { event: "backlinks/manual-sync" },
  async ({ event, step }) => {
    const { businessId, targetDomain } = event.data;

    return await step.run("sync-backlinks", async () => {
      try {
        console.log(
          `🔄 Starting manual backlink sync for business ${businessId}`,
        );

        if (!businessId) {
          throw new Error("businessId is required");
        }

        // Get business to find target domain and enforce paid backlink eligibility.
        const business = await prisma.business.findUnique({
          where: { id: businessId },
          select: {
            id: true,
            businessWebsiteUrl: true,
            isActive: true,
            websiteSubscription: {
              select: {
                status: true,
                trialStatus: true,
                stripeSubscriptionId: true,
                stripeSubscriptionItemId: true,
                stripePriceId: true,
              },
            },
            User: {
              select: {
                backlinkEnabled: true,
                Subscription: {
                  select: {
                    status: true,
                    currentPeriodEnd: true,
                  },
                },
              },
            },
          },
        });

        if (!business) {
          throw new Error(`Business ${businessId} not found`);
        }

        const eligibility = getBusinessBacklinkServiceEligibility(business);
        if (!eligibility.eligible) {
          throw new Error(
            eligibility.message || "Backlink analysis is not available.",
          );
        }

        const domain = targetDomain || business.businessWebsiteUrl;

        const service = new ExternalBacklinksService();
        const result = await service.syncBacklinksForBusiness(
          businessId,
          domain,
        );

        console.log(
          `✅ Manual backlink sync completed for business ${businessId}`,
        );

        return result;
      } catch (error: any) {
        console.error(`❌ Error in manual backlink sync:`, error);
        throw error;
      }
    });
  },
);

// ============================================
// Pinecone re-index task (weekly + manual)
// ============================================

/**
 * Weekly Pinecone re-index.
 *
 * Sunday 3 AM UTC. For every paid-subscriber business:
 *   1. Rediscover and diff the sitemap against Pinecone's "sitemaps" namespace
 *      (add new URLs, delete vectors for URLs no longer in the sitemap).
 *   2. Re-embed up to 50 published blogs per business whose content has changed
 *      since the last time we indexed them.
 *
 * Businesses are processed sequentially with a 5s gap between them to stay
 * within OpenAI embedding + Pinecone write rate limits, mirroring the pattern
 * used by syncExternalBacklinksTask.
 */
export const weeklyPineconeReindexTask = createInngestFunction(
  { id: "weekly-pinecone-reindex" },
  { cron: "0 3 * * 0" }, // Sundays at 03:00 UTC
  async ({ step }) => {
    return await step.run("reindex-all-paid-businesses", async () => {
      console.log("🔄 Starting weekly Pinecone re-index...");
      const now = new Date();

      // Pull candidate businesses; filter to paid in-memory (same shape as
      // the daily backlinks sync query for consistency).
      const candidateBusinesses = await prisma.business.findMany({
        where: {
          isActive: true,
          businessWebsiteUrl: { not: "" },
        },
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          isActive: true,
          userId: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              stripeSubscriptionId: true,
              stripeSubscriptionItemId: true,
              stripePriceId: true,
            },
          },
          User: {
            select: {
              id: true,
            },
          },
        },
      });

      const businesses = candidateBusinesses.filter((b) => {
        const websitePaid = hasActivePaidWebsiteSubscription(
          b.websiteSubscription ?? null,
        );
        return websitePaid;
      });

      console.log(
        `📊 Pinecone re-index: ${businesses.length}/${candidateBusinesses.length} paid businesses`,
      );

      if (businesses.length === 0) {
        return { success: true, total: 0, results: [] };
      }

      const service = new PineconeReindexService();
      const results = [];

      for (let i = 0; i < businesses.length; i++) {
        const business = businesses[i]!;
        try {
          const result = await service.reindexBusiness({
            businessId: business.id,
            businessWebsiteUrl: business.businessWebsiteUrl,
            userId: business.userId,
          });
          console.log(
            `[weeklyPineconeReindexTask] business=${business.id} ` +
              `sitemap=${JSON.stringify(result.sitemap)} ` +
              `blogs=${JSON.stringify(result.blogs)}`,
          );
          results.push({
            ...result,
            businessName: business.businessName,
          });
        } catch (err: any) {
          console.error(
            `❌ Pinecone re-index failed for business ${business.id}:`,
            err,
          );
          results.push({
            businessId: business.id,
            businessName: business.businessName,
            error: err?.message ?? "unknown error",
          });
        }

        if (i < businesses.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      const success = results.filter((r) => !("error" in r && r.error)).length;
      console.log(
        `✅ Weekly Pinecone re-index done: ${success}/${results.length}`,
      );
      return { success: true, total: results.length, results };
    });
  },
);

/**
 * Manual trigger for Pinecone re-index.
 *
 * Emit event `pinecone/manual-reindex` with `{ businessId }` to force a
 * re-index for a single business on demand (e.g. after a sitemap overhaul).
 * Does NOT check paid-eligibility — assumes the caller (an admin endpoint
 * or internal tool) has already authorized it.
 */
export const manualPineconeReindexTask = createInngestFunction(
  { id: "manual-pinecone-reindex" },
  { event: "pinecone/manual-reindex" },
  async ({ event, step }) => {
    return await step.run("manual-reindex", async () => {
      const { businessId } = event.data as { businessId?: string };
      if (!businessId) throw new Error("businessId is required");

      // Same paid-only gate as the weekly cron. Kept consistent so a
      // user-triggered event can't sidestep the weekly cron's policy.
      // Pulls the minimal subscription shape needed by the access
      // primitives (matches the query used by syncExternalBacklinksTask).
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: {
          id: true,
          businessWebsiteUrl: true,
          userId: true,
          isActive: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              stripeSubscriptionId: true,
              stripeSubscriptionItemId: true,
              stripePriceId: true,
            },
          },
          User: {
            select: {
              id: true,
            },
          },
        },
      });
      if (!business) throw new Error(`Business ${businessId} not found`);
      if (business.isActive === false) {
        throw new Error(`Business ${businessId} is not active`);
      }

      const websitePaid = hasActivePaidWebsiteSubscription(
        business.websiteSubscription ?? null,
      );
      if (!websitePaid) {
        throw new Error(
          `Business ${businessId} is not on a paid plan — Pinecone re-index is paid-only.`,
        );
      }

      const service = new PineconeReindexService();
      const result = await service.reindexBusiness({
        businessId: business.id,
        businessWebsiteUrl: business.businessWebsiteUrl,
        userId: business.userId,
      });
      console.log(
        `[manualPineconeReindexTask] business=${businessId} result=${JSON.stringify(result)}`,
      );
      return result;
    });
  },
);

// ============================================
// Guest Posting Automation Tasks
// ============================================

/**
 * Send pitch email task
 * Triggered when user wants to send a pitch email
 */
export const sendPitchEmailTask = createInngestFunction(
  { id: "send-pitch-email" },
  { event: "guest-posting/send-pitch" },
  async ({ event, step }) => {
    const { submissionId, userId } = event.data;

    return await step.run("send-pitch-email", async () => {
      try {
        console.log(`📧 Sending pitch email for submission ${submissionId}`);

        // Import here to avoid circular dependencies
        const { EmailService } = await import("../services/email.service");
        const emailService = new EmailService();

        // Get submission with all related data
        const submission = await prisma.guestPostSubmission.findUnique({
          where: { id: submissionId },
          include: {
            publisher: true,
            blog: true,
            campaign: {
              include: {
                business: true,
              },
            },
          },
        });

        if (!submission) {
          throw new Error(`Submission ${submissionId} not found`);
        }

        if (!submission.publisher.contactEmail) {
          throw new Error("Publisher contact email is required");
        }

        const {
          buildSubmissionComplianceSnapshot,
          evaluateGuestPostPublisher,
        } = await import("../services/guest-posting-quality.service");
        const evaluation = evaluateGuestPostPublisher(
          submission.publisher,
          submission.campaign,
        );
        const compliance = buildSubmissionComplianceSnapshot(
          submission.publisher,
          submission.campaign,
        );

        await prisma.guestPostSubmission.update({
          where: { id: submissionId },
          data: compliance,
        });

        if (compliance.complianceStatus === "BLOCKED") {
          throw new Error(
            evaluation.complianceNotes ||
              "Publisher is blocked by guest-posting compliance policy",
          );
        }

        if (!submission.pitchEmail) {
          throw new Error("Pitch email content is required");
        }

        // Generate subject
        const subject = `Guest Post Pitch: ${submission.title}`;

        // Send email
        const result = await emailService.sendPitchEmail(
          submissionId,
          submission.publisher.contactEmail,
          subject,
          submission.pitchEmail.replace(/\n/g, "<br>"),
          submission.pitchEmail,
        );

        if (!result.success) {
          throw new Error(result.error || "Failed to send email");
        }

        console.log(`✅ Pitch email sent for submission ${submissionId}`);

        return {
          success: true,
          emailId: result.emailId,
          submissionId: submissionId,
        };
      } catch (error: any) {
        console.error(`❌ Error sending pitch email:`, error);
        throw error;
      }
    });
  },
);

/**
 * Check email replies task (runs every 6 hours)
 * Monitors for email replies and updates submission status
 */
export const checkEmailRepliesTask = createInngestFunction(
  { id: "check-email-replies" },
  { cron: "0 */6 * * *" }, // Every 6 hours
  async ({ step }) => {
    return await step.run("check-email-replies", async () => {
      try {
        console.log("📬 Checking for email replies...");

        // Get all submissions with email sent but no reply yet
        const submissions = await prisma.guestPostSubmission.findMany({
          where: {
            status: "PITCHED",
            emailSentAt: {
              not: null,
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
            emailRepliedAt: null,
          },
          include: {
            publisher: true,
          },
          take: 50, // Process 50 at a time
        });

        // Import email reply service
        const { EmailReplyService } =
          await import("../services/email-reply.service");
        const replyService = new EmailReplyService();

        if (!replyService.isConfigured()) {
          console.log("ℹ️ IMAP not configured. Skipping email reply check.");
          return {
            success: true,
            checked: submissions.length,
            found: 0,
            updated: 0,
            message: "IMAP not configured",
          };
        }

        // Check all pending replies
        const result = await replyService.checkAllPendingReplies();

        return {
          success: true,
          ...result,
        };
      } catch (error: any) {
        console.error("❌ Error checking email replies:", error);
        throw error;
      }
    });
  },
);

/**
 * Check published posts task (runs daily)
 * Monitors publisher websites for published guest posts
 */
export const checkPublishedPostsTask = createInngestFunction(
  { id: "check-published-posts" },
  { cron: "0 0 * * *" }, // Daily at midnight
  async ({ step }) => {
    return await step.run("check-published-posts", async () => {
      try {
        console.log("🔍 Checking for published guest posts...");

        // Get all accepted submissions that haven't been published yet
        const submissions = await prisma.guestPostSubmission.findMany({
          where: {
            status: "ACCEPTED",
            publishedAt: null,
            // Check submissions from last 90 days
            acceptedAt: {
              gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
            },
          },
          include: {
            publisher: true,
            blog: true,
            campaign: {
              include: {
                business: true,
              },
            },
          },
          take: 20, // Process 20 at a time to avoid rate limits
        });

        console.log(
          `Found ${submissions.length} accepted submissions to check`,
        );

        // Import published post detector
        const { detectPublishedPost } =
          await import("../utils/published-post-detector");

        let publishedCount = 0;

        for (const submission of submissions) {
          try {
            const result = await detectPublishedPost(
              submission.publisher,
              submission,
            );

            if (result.found && result.publishedUrl) {
              // Extract backlinks if we have the business website
              let backlinks: string[] = [];
              let businessWebsiteUrl: string | null = null;

              // Try to get business website from campaign first
              if (submission.campaign?.business?.businessWebsiteUrl) {
                businessWebsiteUrl =
                  submission.campaign.business.businessWebsiteUrl;
              } else {
                // If no campaign, fetch business directly from user
                const business = await prisma.business.findFirst({
                  where: {
                    userId: submission.userId,
                    isPrimary: true,
                    isActive: true,
                  },
                  select: { businessWebsiteUrl: true },
                });
                businessWebsiteUrl = business?.businessWebsiteUrl || null;
              }

              if (businessWebsiteUrl) {
                const { extractBacklinks: extractBacklinksUtil } =
                  await import("../utils/backlink-extractor");
                const backlinkResult = await extractBacklinksUtil(
                  result.publishedUrl,
                  businessWebsiteUrl,
                );
                backlinks = backlinkResult.backlinks || [];
              }

              // Update submission status
              await prisma.guestPostSubmission.update({
                where: { id: submission.id },
                data: {
                  status: "PUBLISHED",
                  publishedAt: new Date(),
                  publishedUrl: result.publishedUrl,
                  publishedTitle: result.publishedTitle || submission.title,
                  backlinksReceived: backlinks,
                },
              });

              publishedCount++;
              console.log(
                `✅ Found published post for submission ${submission.id}`,
              );
            }

            // Update last checked timestamp
            await prisma.guestPostSubmission.update({
              where: { id: submission.id },
              data: {
                lastCheckedAt: new Date(),
              },
            });

            // Small delay to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error: any) {
            console.error(`Error checking submission ${submission.id}:`, error);
            // Continue with next submission
          }
        }

        console.log(
          `✅ Published post check completed. Found ${publishedCount} published posts`,
        );

        return {
          success: true,
          checked: submissions.length,
          published: publishedCount,
        };
      } catch (error: any) {
        console.error("❌ Error checking published posts:", error);
        throw error;
      }
    });
  },
);

/**
 * Automatic publisher discovery task (runs weekly)
 * Discovers new guest posting opportunities for all active users
 */
export const autoDiscoverPublishersTask = createInngestFunction(
  { id: "auto-discover-publishers" },
  { cron: "0 2 * * 1" }, // Every Monday at 2 AM
  async ({ step }) => {
    return await step.run("auto-discover-publishers", async () => {
      try {
        console.log(
          "🔍 Starting automatic publisher discovery for all users...",
        );

        // Get all users with businesses and keywords
        const users = await prisma.user.findMany({
          where: {
            onboarding: true, // Only users who completed onboarding
          },
          include: {
            business: {
              include: {
                keywords: {
                  where: {
                    keywordType: "MUST_HAVE", // Use MUST_HAVE keywords for discovery
                  },
                  take: 10, // Top 10 keywords
                },
                competitiors: {
                  take: 5, // Get competitors for discovery
                },
              },
            },
            GuestPostCampaigns: {
              where: {
                status: "ACTIVE", // Only active campaigns
              },
              take: 1, // Check if user has active campaigns
            },
          },
        });

        console.log(`Found ${users.length} users to discover publishers for`);

        const { PublisherDiscoveryService } =
          await import("../services/publisher-discovery.service");
        const discoveryService = new PublisherDiscoveryService();

        const results = [];

        for (const user of users) {
          try {
            const business = Array.isArray(user.business)
              ? user.business[0]
              : undefined;
            if (!business) {
              console.log(`⏭️ Skipping user ${user.id} - no business data`);
              continue;
            }

            if (!business.keywords || !Array.isArray(business.keywords)) {
              console.log(`⏭️ Skipping user ${user.id} - no keywords data`);
              continue;
            }

            const keywords = business.keywords.map(
              (k: { keyword: string }) => k.keyword,
            );
            if (keywords.length === 0) {
              console.log(`⏭️ Skipping user ${user.id} - no keywords`);
              continue;
            }

            const niche =
              business.businessType?.split(",")[0]?.trim() || keywords[0];

            console.log(
              `🔍 Discovering publishers for user ${
                user.id
              } with keywords: ${keywords.slice(0, 3).join(", ")}...`,
            );

            const competitorDomains =
              business.competitiors && business.competitiors.length > 0
                ? business.competitiors
                    .map((c: { url: string }) => c.url)
                    .filter((url: string) => url && url.trim().length > 0)
                    .slice(0, 3)
                : [];

            const sources = ["reddit", "medium"] as string[];
            if (competitorDomains.length > 0) {
              sources.push("competitors");
            }

            const discoveryResult = await discoveryService.discoverPublishers(
              sources,
              keywords,
              niche,
              {
                minDomainAuthority: 20, // Minimum DA 20
                minAIConfidence: 0.5, // Minimum AI confidence 50%
              },
              25,
              competitorDomains,
            );

            const discoveredPublishers = discoveryResult.publishers;

            if (discoveredPublishers.length === 0) {
              console.log(`ℹ️ No publishers found for user ${user.id}`);
              results.push({
                userId: user.id,
                discovered: 0,
                created: 0,
                skipped: 0,
                warnings: discoveryResult.warnings,
                sourceStatuses: discoveryResult.sourceStatuses,
              });
              continue;
            }

            // Bulk create publishers and mark as suggested (auto-discovery)
            const bulkResult = await discoveryService.bulkCreatePublishers(
              user.id,
              discoveredPublishers,
              true, // Mark as suggested for auto-discovery
            );

            results.push({
              userId: user.id,
              discovered: discoveredPublishers.length,
              created: bulkResult.created,
              skipped: bulkResult.skipped,
              errors: bulkResult.errors,
              warnings: discoveryResult.warnings,
              sourceStatuses: discoveryResult.sourceStatuses,
            });

            // Add delay between users to respect rate limits
            await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 seconds
          } catch (error: any) {
            console.error(
              `❌ Error discovering publishers for user ${user.id}:`,
              error,
            );
            results.push({
              userId: user.id,
              error: error.message,
            });
          }
        }

        const totalDiscovered = results.reduce(
          (sum, r) => sum + (r.discovered || 0),
          0,
        );
        const totalCreated = results.reduce(
          (sum, r) => sum + (r.created || 0),
          0,
        );

        console.log(
          `✅ Automatic publisher discovery completed: ${totalCreated} new publishers suggested across ${results.length} users`,
        );

        return {
          success: true,
          message: `Discovered ${totalDiscovered} publishers, created ${totalCreated} new suggestions`,
          totalUsers: users.length,
          results,
        };
      } catch (error: any) {
        console.error("❌ Error in automatic publisher discovery:", error);
        throw error;
      }
    });
  },
);

/**
 * Auto-discover publishers for active campaigns
 * Runs daily to find new opportunities for active campaigns
 */
export const autoDiscoverForCampaignsTask = createInngestFunction(
  { id: "auto-discover-for-campaigns" },
  { cron: "0 3 * * *" }, // Daily at 3 AM
  async ({ step }) => {
    return await step.run("auto-discover-for-campaigns", async () => {
      try {
        console.log("🎯 Starting publisher discovery for active campaigns...");

        // Get all active campaigns
        const campaigns = await prisma.guestPostCampaign.findMany({
          where: {
            status: "ACTIVE",
            endDate: {
              gte: new Date(), // Not expired
            },
          },
          include: {
            business: {
              include: {
                keywords: {
                  where: {
                    keywordType: "MUST_HAVE",
                  },
                  take: 10,
                },
              },
            },
            submissions: {
              select: {
                publisherId: true,
              },
            },
          },
        });

        console.log(`Found ${campaigns.length} active campaigns`);

        const { PublisherDiscoveryService } =
          await import("../services/publisher-discovery.service");
        const discoveryService = new PublisherDiscoveryService();

        const results = [];

        for (const campaign of campaigns) {
          try {
            if (!campaign.business) {
              continue;
            }

            const businessKeywords =
              campaign.business.keywords &&
              Array.isArray(campaign.business.keywords)
                ? campaign.business.keywords.map((k) => k.keyword)
                : [];

            const keywords = campaign.targetKeywords?.length
              ? campaign.targetKeywords
              : businessKeywords;

            if (keywords.length === 0) {
              continue;
            }

            // Get already used publisher IDs to avoid duplicates
            const usedPublisherIds = new Set(
              campaign.submissions.map((s) => s.publisherId),
            );

            // Discover publishers
            const discoveredPublishers =
              await discoveryService.discoverPublishers(
                ["reddit", "medium"],
                keywords,
                campaign.targetNiche || undefined,
                {
                  minDomainAuthority: campaign.minDomainAuthority || 20,
                  minAIConfidence: 0.5,
                },
                10, // 10 per campaign
              );

            if (discoveredPublishers.publishers.length === 0) {
              continue;
            }

            // Create publishers and mark as suggested (auto-discovery for campaign)
            const bulkResult = await discoveryService.bulkCreatePublishers(
              campaign.userId,
              discoveredPublishers.publishers,
              true, // Mark as suggested for auto-discovery
            );

            results.push({
              campaignId: campaign.id,
              campaignName: campaign.name,
              discovered: discoveredPublishers.publishers.length,
              created: bulkResult.created,
              warnings: discoveredPublishers.warnings,
              sourceStatuses: discoveredPublishers.sourceStatuses,
            });

            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch (error: any) {
            console.error(
              `❌ Error discovering for campaign ${campaign.id}:`,
              error,
            );
          }
        }

        console.log(
          `✅ Campaign discovery completed: ${results.length} campaigns processed`,
        );

        return {
          success: true,
          campaignsProcessed: results.length,
          results,
        };
      } catch (error: any) {
        console.error("❌ Error in campaign publisher discovery:", error);
        throw error;
      }
    });
  },
);

/**
 * Auto-create submissions for campaigns with automation enabled
 * Runs daily to create submissions for matched publishers
 */
export const autoCreateSubmissionsTask = createInngestFunction(
  { id: "auto-create-submissions" },
  { cron: "0 4 * * *" }, // Daily at 4 AM
  async ({ step }) => {
    return await step.run("auto-create-submissions", async () => {
      try {
        console.log("📝 Starting auto-submission creation for campaigns...");

        const campaigns = await prisma.guestPostCampaign.findMany({
          where: {
            status: "ACTIVE",
            autoCreateSubmissions: true,
            endDate: {
              gte: new Date(),
            },
          },
          include: {
            business: {
              include: {
                keywords: true,
              },
            },
            submissions: {
              select: {
                id: true,
                publisherId: true,
                createdAt: true,
              },
            },
          },
        });

        console.log(
          `Found ${campaigns.length} campaigns with auto-create enabled`,
        );

        const results = [];
        const {
          buildSubmissionComplianceSnapshot,
          evaluateGuestPostPublisher,
        } = await import("../services/guest-posting-quality.service");

        for (const campaign of campaigns) {
          try {
            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);
            const submissionsToday = campaign.submissions.filter(
              (s) => new Date(s.createdAt) >= today,
            ).length;

            const maxPerDay = campaign.maxSubmissionsPerDay || 5;
            if (submissionsToday >= maxPerDay) {
              console.log(
                `⏭️ Campaign ${campaign.id} reached daily limit (${submissionsToday}/${maxPerDay})`,
              );
              continue;
            }

            const publishers = await prisma.guestPostPublisher.findMany({
              where: {
                userId: campaign.userId,
                isActive: true,
                OR: [{ isSuggested: true }, { isVerified: true }],
                domainAuthority: campaign.minDomainAuthority
                  ? { gte: campaign.minDomainAuthority }
                  : undefined,
                niche: campaign.targetNiche
                  ? { contains: campaign.targetNiche, mode: "insensitive" }
                  : undefined,
                id: {
                  notIn: campaign.submissions.map((s) => s.publisherId),
                },
              },
              take: Math.max(1, maxPerDay - submissionsToday) * 5,
            });

            if (publishers.length === 0) {
              console.log(
                `ℹ️ No matching publishers for campaign ${campaign.id}`,
              );
              continue;
            }

            const blogs = await prisma.blog.findMany({
              where: {
                userId: campaign.userId,
                businessId: campaign.businessId,
              },
              orderBy: {
                createdAt: "desc",
              },
              take: 10,
            });

            let created = 0;

            for (const publisher of publishers) {
              try {
                if (created >= maxPerDay - submissionsToday) break;

                let publisherForEvaluation = publisher;
                if (campaign.autoApprovePublishers && publisher.isSuggested) {
                  publisherForEvaluation = await prisma.guestPostPublisher.update({
                    where: { id: publisher.id },
                    data: {
                      isSuggested: false,
                      isVerified: true,
                    },
                  });
                }

                const evaluation = evaluateGuestPostPublisher(
                  publisherForEvaluation,
                  campaign,
                );
                if (!evaluation.canCreateSubmission) {
                  await prisma.guestPostPublisher.update({
                    where: { id: publisher.id },
                    data: {
                      qualityScore: evaluation.score,
                      qualityGateStatus: evaluation.status,
                      qualityGateReasons: [
                        ...evaluation.reasons,
                        ...evaluation.warnings,
                      ],
                      complianceNotes: evaluation.complianceNotes,
                    },
                  });
                  console.log(
                    `⏭️ Publisher ${publisher.id} blocked for campaign ${campaign.id}: ${evaluation.complianceNotes}`,
                  );
                  continue;
                }

                const selectedBlog =
                  blogs.length > 0
                    ? blogs[Math.floor(Math.random() * blogs.length)]
                    : null;

                const campaignBusinessKeywords =
                  campaign.business?.keywords &&
                  Array.isArray(campaign.business.keywords)
                    ? campaign.business.keywords.map((k) => k.keyword)
                    : [];
                const keywords = campaign.targetKeywords?.length
                  ? campaign.targetKeywords
                  : campaignBusinessKeywords;
                const titleKeyword =
                  keywords.length > 0
                    ? keywords[Math.floor(Math.random() * keywords.length)]
                    : "Guest Post";
                const title = `Guest Post: ${titleKeyword} - ${campaign.name}`;

                const submission = await prisma.guestPostSubmission.create({
                  data: {
                    userId: campaign.userId,
                    campaignId: campaign.id,
                    publisherId: publisher.id,
                    blogId: selectedBlog?.id,
                    title: title,
                    status: "DRAFT",
                    proposedTopic: `Guest post about ${titleKeyword} for ${publisher.name}`,
                    ...buildSubmissionComplianceSnapshot(
                      publisherForEvaluation,
                      campaign,
                    ),
                  },
                });

                created++;

                if (campaign.autoGeneratePitch && evaluation.canGeneratePitch) {
                  await inngest.send({
                    name: "guest-posting/auto-pitch",
                    data: {
                      submissionId: submission.id,
                      campaignId: campaign.id,
                      autoSend:
                        campaign.autoSendPitch && evaluation.canAutoSend,
                      delayHours: campaign.autoPitchDelayHours || 0,
                    },
                  });
                }

                console.log(
                  `✅ Created submission ${submission.id} for campaign ${campaign.id}`,
                );
              } catch (error: any) {
                console.error(
                  `❌ Error creating submission for publisher ${publisher.id}:`,
                  error,
                );
              }
            }

            results.push({
              campaignId: campaign.id,
              campaignName: campaign.name,
              created,
            });
          } catch (error: any) {
            console.error(
              `❌ Error processing campaign ${campaign.id}:`,
              error,
            );
          }
        }

        return {
          success: true,
          campaignsProcessed: results.length,
          results,
        };
      } catch (error: any) {
        console.error("❌ Error in auto-submission creation:", error);
        throw error;
      }
    });
  },
);

/**
 * Auto-generate and send pitch emails for submissions
 * Triggered when auto-generate-pitch is enabled
 */
export const autoGenerateAndSendPitchTask = createInngestFunction(
  { id: "auto-generate-and-send-pitch" },
  { event: "guest-posting/auto-pitch" },
  async ({ event, step }) => {
    const { submissionId, campaignId, autoSend, delayHours } = event.data;

    return await step.run("auto-generate-pitch", async () => {
      try {
        console.log(`🤖 Auto-generating pitch for submission ${submissionId}`);

        const submission = await prisma.guestPostSubmission.findUnique({
          where: { id: submissionId },
          include: {
            publisher: true,
            blog: true,
            campaign: {
              include: {
                business: {
                  include: {
                    User: true,
                  },
                },
              },
            },
          },
        });

        if (!submission || submission.status !== "DRAFT") {
          throw new Error("Submission not found or not in DRAFT status");
        }

        if (!submission.publisher.contactEmail) {
          throw new Error("Publisher contact email is required");
        }

        const {
          buildSubmissionComplianceSnapshot,
          evaluateGuestPostPublisher,
        } = await import("../services/guest-posting-quality.service");
        const evaluation = evaluateGuestPostPublisher(
          submission.publisher,
          submission.campaign,
        );
        const compliance = buildSubmissionComplianceSnapshot(
          submission.publisher,
          submission.campaign,
        );

        await prisma.guestPostSubmission.update({
          where: { id: submissionId },
          data: compliance,
        });

        if (!evaluation.canGeneratePitch) {
          throw new Error(
            evaluation.complianceNotes ||
              "Publisher is not qualified for automated pitch generation",
          );
        }

        const { generatePitchEmailLLM } =
          await import("../llm/guest-posting/generate-pitch-email.llm");

        // Get business if not in campaign
        let business = submission.campaign?.business;
        let userData:
          | { firstName?: string; lastName?: string; email?: string }
          | undefined;

        if (business && "User" in business && business.User) {
          const user = business.User as {
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
          };
          userData = {
            firstName: user.firstName || undefined,
            lastName: user.lastName || undefined,
            email: user.email || undefined,
          };
        } else if (!business) {
          // Fetch business with user data
          const fetchedBusiness = await prisma.business.findFirst({
            where: {
              userId: submission.userId,
              isPrimary: true,
              isActive: true,
            },
            include: {
              User: true,
            },
          });

          if (fetchedBusiness) {
            business = fetchedBusiness;
            if (fetchedBusiness.User) {
              const user = fetchedBusiness.User as {
                firstName?: string | null;
                lastName?: string | null;
                email?: string | null;
              };
              userData = {
                firstName: user.firstName || undefined,
                lastName: user.lastName || undefined,
                email: user.email || undefined,
              };
            }
          }
        }

        if (!business) {
          throw new Error("Business not found for pitch generation");
        }

        // Prepare data for pitch generation
        const pitchData = {
          publisher: submission.publisher,
          business: business,
          submission: {
            title: submission.title,
            proposedTopic: submission.proposedTopic || undefined,
            blogId: submission.blogId || undefined,
          },
          blog: submission.blog || null,
          user: userData || {
            firstName: undefined,
            lastName: undefined,
            email: undefined,
          },
        };

        const pitchResult = await generatePitchEmailLLM(pitchData as any);

        await prisma.guestPostSubmission.update({
          where: { id: submissionId },
          data: {
            pitchEmail: pitchResult.textContent,
            autoGeneratedPitch: true,
          },
        });

        console.log(`✅ Pitch generated for submission ${submissionId}`);

        const canAutoSend =
          autoSend &&
          evaluation.canAutoSend &&
          compliance.complianceStatus === "APPROVED";

        if (canAutoSend) {
          const delayMs = (delayHours || 0) * 60 * 60 * 1000;

          if (delayMs > 0) {
            await inngest.send({
              name: "guest-posting/send-pitch",
              data: {
                submissionId: submissionId,
                userId: submission.userId,
              },
              ts: Date.now() + delayMs,
            });
          } else {
            await inngest.send({
              name: "guest-posting/send-pitch",
              data: {
                submissionId: submissionId,
                userId: submission.userId,
              },
            });
          }
        } else if (autoSend) {
          console.warn(
            `⏸️ Auto-send held for submission ${submissionId}: ${evaluation.complianceNotes ?? "compliance approval required"}`,
          );
        }

        return {
          success: true,
          submissionId,
          autoSend: canAutoSend,
        };
      } catch (error: any) {
        console.error(`❌ Error auto-generating pitch:`, error);
        throw error;
      }
    });
  },
);

/**
 * Discover and process sitemap in the background
 * Runs after onboarding to avoid blocking the response
 */
export const discoverSitemapTask = createInngestFunction(
  { id: "discover-sitemap" },
  { event: "sitemap/discover" },
  async ({ event, step }) => {
    const { userId, websiteUrl, businessId } = event.data;

    return await step.run("discover-sitemap", async () => {
      try {
        console.log(
          `🔍 Starting sitemap discovery for user ${userId}, businessId: ${businessId || "not provided"}`,
        );

        const { discoverSitemapUrl, fetchSitemapUrls } =
          await import("../utils/tools.utils");
        const { upsertSitemapUrls } = await import("../config/pinecone.config");

        // Discover sitemap URL
        const discoveredSitemapUrl = await discoverSitemapUrl(websiteUrl);

        if (!discoveredSitemapUrl) {
          console.log(`ℹ️ No sitemap found for: ${websiteUrl}`);
          return {
            success: true,
            message: "No sitemap found",
            discovered: false,
            userId,
          };
        }

        console.log(`✅ Sitemap discovered: ${discoveredSitemapUrl}`);

        // Fetch all URLs from sitemap
        const sitemapUrls = await fetchSitemapUrls(discoveredSitemapUrl);
        console.log(`📋 Found ${sitemapUrls.length} URLs in sitemap`);

        // Get business ID - use provided businessId or find by websiteUrl
        let business;
        if (businessId) {
          business = await prisma.business.findFirst({
            where: {
              id: businessId,
              userId,
              isActive: true,
            },
          });
        } else {
          // Fallback: find business by websiteUrl
          business = await prisma.business.findFirst({
            where: {
              userId,
              businessWebsiteUrl: websiteUrl,
              isActive: true,
            },
          });
        }

        if (!business) {
          console.warn(
            `⚠️ Business not found for user ${userId}, websiteUrl: ${websiteUrl}`,
          );
          return {
            success: false,
            message: "Business not found",
            userId,
          };
        }

        if (sitemapUrls.length > 0) {
          // Update or create SitemapUrls record using composite unique constraint
          await prisma.sitemapUrls.upsert({
            where: {
              userId_businessId: {
                userId,
                businessId: business.id,
              },
            },
            update: {
              urls: sitemapUrls,
            },
            create: {
              urls: sitemapUrls,
              businessId: business.id,
              userId,
            },
          });

          // Upsert to Pinecone for vector search
          await upsertSitemapUrls(business.id, userId, sitemapUrls);
          console.log(`✅ Sitemap URLs saved to database and Pinecone`);
        }

        const result = {
          success: true,
          message: "Sitemap discovered and processed successfully",
          discovered: true,
          totalUrls: sitemapUrls.length,
          userId,
          businessId: business.id,
        };

        // 🆕 NEW: After sitemap completes, trigger blog image extraction
        // Note: Using inngest.send() directly (not in a step) to avoid nested steps
        if (result.success && result.discovered && sitemapUrls.length > 0) {
          try {
            await inngest.send({
              name: "blog-images/extract",
              data: {
                businessId: result.businessId,
                userId: result.userId,
                websiteUrl,
                useSitemap: true,
              },
            });
            console.log(
              `✅ Triggered blog image extraction after sitemap discovery`,
            );
          } catch (extractError) {
            console.error(
              "⚠️ Failed to trigger blog image extraction:",
              extractError,
            );
            // Don't fail sitemap task if image extraction trigger fails
          }
        }

        return result;
      } catch (error: any) {
        // Don't fail - sitemap discovery is non-critical
        console.error(`⚠️ Sitemap discovery failed for user ${userId}:`, error);
        return {
          success: false,
          message: error.message || "Sitemap discovery failed",
          userId,
        };
      }
    });
  },
);

export const extractBlogImagesTask = createInngestFunction(
  { id: "extract-blog-images" },
  { event: "blog-images/extract" },
  async ({ event, step }) => {
    const { businessId, userId, websiteUrl, useSitemap = true } = event.data;

    return await step.run("extract-blog-images", async () => {
      try {
        console.log(
          `📸 Starting blog image extraction for business ${businessId}`,
        );
        console.log(`   Using ${useSitemap ? "sitemap" : "homepage"} approach`);

        const { BlogImageExtractionService } =
          await import("../services/blog-image-extraction.service");
        const service = new BlogImageExtractionService();

        // Get website URL if not provided
        let siteUrl = websiteUrl;
        if (!siteUrl) {
          const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { businessWebsiteUrl: true },
          });
          siteUrl = business?.businessWebsiteUrl;
        }

        if (!siteUrl) {
          throw new Error("Website URL not found");
        }

        const result = await service.extractBlogImages(
          businessId,
          siteUrl,
          useSitemap,
        );

        console.log(
          `✅ Extracted ${result.imageCount} blog images from ${result.source}`,
        );

        return {
          success: true,
          imageCount: result.imageCount,
          source: result.source,
          businessId,
        };
      } catch (error: any) {
        console.error("❌ Blog image extraction failed:", error);
        throw error;
      }
    });
  },
);

export const checkTrialExpiryTask = createInngestFunction(
  {
    id: "check-trial-expiry",
    name: "Check Trial Expiry Daily",
  },
  { cron: "0 0 * * *" },
  async ({ step }) => {
    const { PER_SITE_TRIALS_ENABLED } = await import("../config/feature-flags");

    const perSiteResult = await step.run(
      "check-per-site-trial-expiry",
      async () => {
        if (!PER_SITE_TRIALS_ENABLED) {
          return { siteExpired: 0, siteConverted: 0 };
        }

        const now = new Date();
        let siteExpired = 0;
        let siteConverted = 0;

        const expiredSiteSubs = await prisma.websiteSubscription.findMany({
          where: {
            trialStatus: "trialing",
            trialEndDate: { lte: now },
          },
          include: {
            business: {
              include: {
                User: { include: { Subscription: true } },
              },
            },
          },
        });

        for (const ws of expiredSiteSubs) {
          const userSub = ws.business.User.Subscription;
          const hasPaidSub =
            userSub != null &&
            userSub.status === "active" &&
            userSub.stripeSubscriptionId != null;

          if (hasPaidSub) {
            await prisma.websiteSubscription.update({
              where: { id: ws.id },
              data: { trialStatus: "converted", status: "active" },
            });
            await prisma.business.update({
              where: { id: ws.businessId },
              data: { websiteStatus: "active" },
            });
            siteConverted++;
            console.log(
              `[Trial Expiry] Site ${ws.businessId} trial converted (user has paid subscription)`,
            );
          } else {
            await prisma.websiteSubscription.update({
              where: { id: ws.id },
              data: { trialStatus: "expired", status: "expired" },
            });
            await prisma.business.update({
              where: { id: ws.businessId },
              data: { websiteStatus: "expired" },
            });
            siteExpired++;
            console.log(`[Trial Expiry] Site ${ws.businessId} trial expired`);
          }
        }

        return { siteExpired, siteConverted };
      },
    );

    const accountResult = await step.run(
      "check-account-trial-expiry",
      async () => {
        const now = new Date();
        const twoDaysFromNow = new Date();
        twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

        const expiringTrials = await prisma.user.findMany({
          where: {
            trialStatus: "active",
            trialEndDate: { gte: now, lte: twoDaysFromNow },
            role: { notIn: [...ROLES_EXCLUDED_FROM_TRIAL_LIFECYCLE_EMAILS] },
          },
        });

        for (const user of expiringTrials) {
          try {
            const { sendTrialExpiringEmail } =
              await import("../services/trial-email.service");
            const { TrialAnalyticsService } =
              await import("../services/trial-analytics.service");
            const daysLeft: number = Math.ceil(
              (user.trialEndDate!.getTime() - now.getTime()) /
                (1000 * 60 * 60 * 24),
            );
            const email = (user.email ?? "") as string;
            const name = (user.name || email.split("@")[0]) as string;
            await sendTrialExpiringEmail(email, name, daysLeft);
            await TrialAnalyticsService.trackEmailSent(user.id, "expiring");
          } catch (error) {
            console.error(
              `Failed to send expiring email to ${user.email}:`,
              error,
            );
          }
        }

        const expiredTrials = await prisma.user.findMany({
          where: {
            trialStatus: "active",
            trialEndDate: { lte: now },
            role: { notIn: [...ROLES_EXCLUDED_FROM_TRIAL_LIFECYCLE_EMAILS] },
          },
          include: { Subscription: true },
        });

        let converted = 0;
        let expired = 0;

        for (const user of expiredTrials) {
          const hasPaidWebsiteSubscription = await prisma.websiteSubscription.findFirst({
            where: {
              business: { userId: user.id },
              status: "active",
              NOT: {
                trialStatus: { in: ["trialing", "expired"] },
              },
            },
            select: { id: true },
          });

          if (hasPaidWebsiteSubscription) {
            await prisma.user.update({
              where: { id: user.id },
              data: { trialStatus: "converted" },
            });
            converted++;
          } else {
            await prisma.user.update({
              where: { id: user.id },
              data: { trialStatus: "expired" },
            });
            if (PER_SITE_TRIALS_ENABLED) {
              await prisma.websiteSubscription.updateMany({
                where: {
                  business: { userId: user.id },
                  trialStatus: "trialing",
                },
                data: { trialStatus: "expired", status: "expired" },
              });
              await prisma.business.updateMany({
                where: { userId: user.id, websiteStatus: "trial" },
                data: { websiteStatus: "expired" },
              });
            }
            expired++;

            try {
              const { sendTrialExpiredEmail } =
                await import("../services/trial-email.service");
              const { TrialAnalyticsService } =
                await import("../services/trial-analytics.service");
              const email = (user.email ?? "") as string;
              const name = (user.name || email.split("@")[0]) as string;
              await sendTrialExpiredEmail(email, name);
              await TrialAnalyticsService.trackTrialExpired(user.id);
              await TrialAnalyticsService.trackEmailSent(user.id, "expired");
            } catch (emailError) {
              console.error(
                `[Trial Expiry] Failed to send expired email for user ${user.id}:`,
                emailError,
              );
            }
          }
        }

        return { checked: expiredTrials.length, converted, expired };
      },
    );

    return { ...accountResult, perSite: perSiteResult };
  },
);

export const trialStartedTask = createInngestFunction(
  {
    id: "trial-started",
    name: "Handle Trial Started Event",
  },
  { event: "trial/started" },
  async ({ event, step }) => {
    const { userId, trialEndDate } = event.data;

    return await step.run("send-trial-welcome-email", async () => {
      console.log(`[Trial Started] Processing for user ${userId}`);

      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        console.error(`[Trial Started] User ${userId} not found`);
        return { success: false, error: "User not found" };
      }

      // TODO: Send welcome email with trial details
      console.log(
        `[Trial Started] Welcome email would be sent to ${user.email}`,
      );
      console.log(`[Trial Started] Trial expires: ${trialEndDate}`);

      return {
        success: true,
        userId,
        trialEndDate,
      };
    });
  },
);

type OnboardingV2PreviewEventData = {
  quickBusinessId: string;
  userId: string;
  businessId: string;
  revision: number;
};

type OnboardingV2PreviewContext = OnboardingV2PreviewEventData & {
  skipped: boolean;
  reason?: string;
  topic: string;
  websiteUrl: string;
  brandContext: unknown;
  blogStatus: string;
  socialStatus: string;
  blogId: string | null;
  socialRunId: string | null;
};

function parseOnboardingV2PreviewEventData(
  value: unknown,
): OnboardingV2PreviewEventData {
  const data = recordValue(value);
  const quickBusinessId = optionalString(data.quickBusinessId);
  const userId = optionalString(data.userId);
  const businessId = optionalString(data.businessId);
  const revision = Number(data.revision);
  if (
    !quickBusinessId ||
    !userId ||
    !businessId ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new NonRetriableError(
      "onboarding-v2/preview.requested requires quickBusinessId, userId, businessId, and a non-negative integer revision",
    );
  }
  return { quickBusinessId, userId, businessId, revision };
}

function onboardingV2GenerationError(input: {
  stage: "orchestration" | "blog" | "social";
  code: string;
  error: unknown;
  revision: number;
}) {
  return {
    stage: input.stage,
    code: input.code,
    message: getPrismaErrorMessage(input.error).slice(0, 2_000),
    revision: input.revision,
    recordedAt: new Date().toISOString(),
  };
}

async function loadOnboardingV2PreviewContext(
  eventData: OnboardingV2PreviewEventData,
  claimGeneration: boolean,
): Promise<OnboardingV2PreviewContext> {
  const quickBusiness = await prisma.quickScrapeBusiness.findUnique({
    where: { id: eventData.quickBusinessId },
    select: {
      id: true,
      userId: true,
      businessName: true,
      businessType: true,
      businessWebsiteUrl: true,
      selectedServices: true,
      detectedServices: true,
      brandContext: true,
      onboardingV2Status: true,
      onboardingV2CompletedAt: true,
      onboardingV2AnswerRevision: true,
      onboardingV2GenerationRevision: true,
      onboardingV2GenerationStartedAt: true,
      onboardingV2BusinessId: true,
      onboardingV2BlogId: true,
      onboardingV2SocialRunId: true,
      onboardingV2BlogStatus: true,
      onboardingV2SocialStatus: true,
    },
  });
  if (!quickBusiness || quickBusiness.userId !== eventData.userId) {
    throw new NonRetriableError(
      "Quick onboarding business not found or ownership mismatch",
    );
  }
  if (quickBusiness.onboardingV2BusinessId !== eventData.businessId) {
    throw new NonRetriableError(
      "Quick onboarding business does not match preview business",
    );
  }
  if (
    !isOnboardingV2Unfinished(
      quickBusiness.onboardingV2Status,
      quickBusiness.onboardingV2CompletedAt,
    )
  ) {
    return {
      ...eventData,
      skipped: true,
      reason: "onboarding_finished",
      topic: "",
      websiteUrl: quickBusiness.businessWebsiteUrl,
      brandContext: quickBusiness.brandContext,
      blogStatus: quickBusiness.onboardingV2BlogStatus,
      socialStatus: quickBusiness.onboardingV2SocialStatus,
      blogId: quickBusiness.onboardingV2BlogId,
      socialRunId: quickBusiness.onboardingV2SocialRunId,
    };
  }
  if (
    quickBusiness.onboardingV2GenerationRevision !== null &&
    quickBusiness.onboardingV2GenerationRevision !== eventData.revision
  ) {
    return {
      ...eventData,
      skipped: true,
      reason: "generation_revision_superseded",
      topic: "",
      websiteUrl: quickBusiness.businessWebsiteUrl,
      brandContext: quickBusiness.brandContext,
      blogStatus: quickBusiness.onboardingV2BlogStatus,
      socialStatus: quickBusiness.onboardingV2SocialStatus,
      blogId: quickBusiness.onboardingV2BlogId,
      socialRunId: quickBusiness.onboardingV2SocialRunId,
    };
  }
  if (
    quickBusiness.onboardingV2GenerationRevision === null &&
    quickBusiness.onboardingV2AnswerRevision !== eventData.revision
  ) {
    return {
      ...eventData,
      skipped: true,
      reason: "answer_revision_changed_before_generation",
      topic: "",
      websiteUrl: quickBusiness.businessWebsiteUrl,
      brandContext: quickBusiness.brandContext,
      blogStatus: quickBusiness.onboardingV2BlogStatus,
      socialStatus: quickBusiness.onboardingV2SocialStatus,
      blogId: quickBusiness.onboardingV2BlogId,
      socialRunId: quickBusiness.onboardingV2SocialRunId,
    };
  }
  const business = await prisma.business.findFirst({
    where: { id: eventData.businessId, userId: eventData.userId },
    select: { id: true },
  });
  if (!business) {
    throw new NonRetriableError(
      "Onboarding preview business not found or ownership mismatch",
    );
  }
  const topic = selectOnboardingV2PreviewTopic(quickBusiness);
  if (!topic) {
    throw new NonRetriableError("Onboarding preview topic is unavailable");
  }
  const blogStatus =
    quickBusiness.onboardingV2BlogStatus === "complete"
      ? "complete"
      : claimGeneration
        ? "queued"
        : quickBusiness.onboardingV2BlogStatus;
  const socialStatus =
    quickBusiness.onboardingV2SocialStatus === "complete"
      ? "complete"
      : claimGeneration
        ? "queued"
        : quickBusiness.onboardingV2SocialStatus;
  if (claimGeneration) {
    const claimed = await prisma.quickScrapeBusiness.updateMany({
      where: {
        id: eventData.quickBusinessId,
        userId: eventData.userId,
        onboardingV2CompletedAt: null,
        OR: [
          { onboardingV2GenerationRevision: null },
          { onboardingV2GenerationRevision: eventData.revision },
        ],
      },
      data: {
        onboardingV2BusinessId: eventData.businessId,
        onboardingV2GenerationRevision: eventData.revision,
        onboardingV2GenerationStartedAt:
          quickBusiness.onboardingV2GenerationStartedAt ?? new Date(),
        onboardingV2BlogStatus: blogStatus,
        onboardingV2SocialStatus: socialStatus,
        onboardingV2GenerationError: Prisma.DbNull,
      },
    });
    if (claimed.count !== 1) {
      return {
        ...eventData,
        skipped: true,
        reason: "generation_claim_lost",
        topic,
        websiteUrl: quickBusiness.businessWebsiteUrl,
        brandContext: quickBusiness.brandContext,
        blogStatus: quickBusiness.onboardingV2BlogStatus,
        socialStatus: quickBusiness.onboardingV2SocialStatus,
        blogId: quickBusiness.onboardingV2BlogId,
        socialRunId: quickBusiness.onboardingV2SocialRunId,
      };
    }
  }
  return {
    ...eventData,
    skipped: false,
    topic,
    websiteUrl: quickBusiness.businessWebsiteUrl,
    brandContext: quickBusiness.brandContext,
    blogStatus,
    socialStatus,
    blogId: quickBusiness.onboardingV2BlogId,
    socialRunId: quickBusiness.onboardingV2SocialRunId,
  };
}

type ExistingOnboardingBrandAnalysis = {
  id: string;
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  logoAltText: string | null;
  faviconUrl: string | null;
  referenceImageUrl: string | null;
  analysisVersion: string;
};

function isContextDevBrandRetrieveAnalysis(
  data: OnboardingV2BrandAnalysisData,
): boolean {
  return data.analysisVersion.startsWith(
    "onboarding-v2-context-dev-brand-v",
  );
}

function isMateriallyRicherBrandAnalysis(
  incoming: OnboardingV2BrandAnalysisData,
  existing: ExistingOnboardingBrandAnalysis,
): boolean {
  return (
    incoming.primaryColors.length > existing.primaryColors.length ||
    incoming.secondaryColors.length > existing.secondaryColors.length ||
    Boolean(incoming.fontFamily && !existing.fontFamily) ||
    Boolean(incoming.logoUrl && !existing.logoUrl) ||
    Boolean(incoming.logoAltText && !existing.logoAltText) ||
    Boolean(incoming.faviconUrl && !existing.faviconUrl) ||
    Boolean(incoming.referenceImageUrl && !existing.referenceImageUrl)
  );
}

function persistedBrandAnalysisFields(
  data: OnboardingV2BrandAnalysisData,
  existing?: ExistingOnboardingBrandAnalysis | null,
) {
  return {
    primaryColors:
      data.primaryColors.length > 0
        ? data.primaryColors
        : (existing?.primaryColors ?? []),
    secondaryColors:
      data.secondaryColors.length > 0
        ? data.secondaryColors
        : (existing?.secondaryColors ?? []),
    fontFamily: data.fontFamily ?? existing?.fontFamily ?? null,
    logoUrl: data.logoUrl ?? existing?.logoUrl ?? null,
    logoAltText: data.logoAltText ?? existing?.logoAltText ?? null,
    faviconUrl: data.faviconUrl ?? existing?.faviconUrl ?? null,
    referenceImageUrl:
      data.referenceImageUrl ?? existing?.referenceImageUrl ?? null,
    analysisVersion: data.analysisVersion,
  };
}

export async function ensureOnboardingV2BrandAnalysis(
  context: OnboardingV2PreviewContext,
  prismaClient: PrismaClient = prisma,
  analyzeBrand: (websiteUrl: string) => Promise<
    Awaited<ReturnType<BrandAnalysisService["analyzeBrand"]>>
  > = (websiteUrl) => new BrandAnalysisService().analyzeBrand(websiteUrl),
) {
  const existing = await prismaClient.brandAnalysis.findUnique({
    where: { businessId: context.businessId },
    select: {
      id: true,
      primaryColors: true,
      secondaryColors: true,
      fontFamily: true,
      logoUrl: true,
      logoAltText: true,
      faviconUrl: true,
      referenceImageUrl: true,
      analysisVersion: true,
    },
  });
  const persisted = buildOnboardingV2BrandAnalysisData(context.brandContext);

  if (persisted && existing) {
    const shouldRefresh =
      isContextDevBrandRetrieveAnalysis(persisted) &&
      (existing.analysisVersion !== persisted.analysisVersion ||
        isMateriallyRicherBrandAnalysis(persisted, existing));
    if (!shouldRefresh) {
      return {
        available: true,
        created: false,
        refreshed: false,
        id: existing.id,
      };
    }
    const refreshedFields = persistedBrandAnalysisFields(persisted, existing);
    const lastAnalyzed = persisted.identityRetrievedAt ?? new Date();
    const refreshed = await prismaClient.brandAnalysis.upsert({
      where: { businessId: context.businessId },
      create: {
        businessId: context.businessId,
        ...refreshedFields,
        lastAnalyzed,
      },
      update: {
        ...refreshedFields,
        lastAnalyzed,
      },
      select: { id: true },
    });
    return {
      available: true,
      created: false,
      refreshed: true,
      id: refreshed.id,
    };
  }

  if (existing) {
    return {
      available: true,
      created: false,
      refreshed: false,
      id: existing.id,
    };
  }

  const analyzed = persisted ? null : await analyzeBrand(context.websiteUrl);
  const data = persisted
    ? persistedBrandAnalysisFields(persisted)
    : analyzed
      ? {
          primaryColors: analyzed.primaryColors,
          secondaryColors: analyzed.secondaryColors,
          fontFamily: analyzed.fontFamily ?? null,
          logoUrl: analyzed.logoUrl ?? null,
          logoAltText: analyzed.logoAltText ?? null,
          faviconUrl: analyzed.faviconUrl ?? null,
          referenceImageUrl: analyzed.referenceImageUrl ?? null,
          analysisVersion: analyzed.analysisSource?.startsWith(
            "context.dev.brand.retrieve",
          )
            ? "onboarding-v2-context-dev-brand-v1"
            : "onboarding-v2-deterministic-v1",
        }
      : null;
  if (!data) {
    return {
      available: false,
      created: false,
      refreshed: false,
      id: null,
    };
  }
  const analysis = await prismaClient.brandAnalysis.upsert({
    where: { businessId: context.businessId },
    create: {
      businessId: context.businessId,
      ...data,
      lastAnalyzed: persisted?.identityRetrievedAt ?? new Date(),
    },
    update: {},
    select: { id: true },
  });
  return {
    available: true,
    created: true,
    refreshed: false,
    id: analysis.id,
  };
}

export const onboardingV2PreviewRequestedTask = createInngestFunction(
  {
    id: "onboarding-v2-preview-requested",
    name: "Queue Onboarding V2 Preview Generation",
    retries: 2,
    singleton: {
      key: "event.data.quickBusinessId + ':' + event.data.revision",
      mode: "skip",
    },
    ...onboardingFlowControl("event.data.quickBusinessId"),
  },
  { event: "onboarding-v2/preview.requested" },
  async ({ event, step }) => {
    if (!isOnboardingV2PreviewGenerationEnabled()) {
      return { skipped: true, reason: "preview_generation_disabled" };
    }
    const eventData = parseOnboardingV2PreviewEventData(event.data);
    const context = await step.run("claim-onboarding-v2-preview", () =>
      loadOnboardingV2PreviewContext(eventData, true),
    );
    if (context.skipped) return context;
    try {
      const brand = await step.run(
        "persist-onboarding-v2-brand-analysis",
        () => ensureOnboardingV2BrandAnalysis(context),
      );
      const events: Array<{
        name: string;
        data: OnboardingV2PreviewEventData;
      }> = [];
      if (context.blogStatus !== "complete") {
        events.push({
          name: "onboarding-v2/blog-preview.requested",
          data: eventData,
        });
      }
      if (context.socialStatus !== "complete") {
        events.push({
          name: "onboarding-v2/social-preview.requested",
          data: eventData,
        });
      }
      if (events.length > 0) {
        await step.sendEvent("dispatch-onboarding-v2-previews", events);
      }
      await step.run("clear-onboarding-v2-orchestration-error", () =>
        clearOnboardingV2GenerationError(prisma, {
          quickBusinessId: eventData.quickBusinessId,
          userId: eventData.userId,
          businessId: eventData.businessId,
          revision: eventData.revision,
          stage: "orchestration",
        }),
      );
      return {
        success: true,
        queued: events.map((queuedEvent) => queuedEvent.name),
        brand,
        ...eventData,
      };
    } catch (error) {
      await step.run("fail-onboarding-v2-preview-orchestration", () =>
        prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
            onboardingV2CompletedAt: null,
          },
          data: {
            onboardingV2BlogStatus:
              context.blogStatus === "complete" ? "complete" : "failed",
            onboardingV2SocialStatus:
              context.socialStatus === "complete" ? "complete" : "failed",
            onboardingV2GenerationError: onboardingV2GenerationError({
              stage: "orchestration",
              code: "ONBOARDING_V2_PREVIEW_ORCHESTRATION_FAILED",
              error,
              revision: eventData.revision,
            }),
          },
        }),
      );
      throw error;
    }
  },
);

export const onboardingV2BlogPreviewTask = createInngestFunction(
  {
    id: "onboarding-v2-blog-preview",
    name: "Generate Onboarding V2 Blog Preview",
    retries: 2,
    singleton: {
      key: "event.data.quickBusinessId + ':' + event.data.revision",
      mode: "skip",
    },
    ...onboardingFlowControl("event.data.quickBusinessId"),
    timeouts: { finish: "15m" },
  },
  { event: "onboarding-v2/blog-preview.requested" },
  async ({ event, step }) => {
    if (!isOnboardingV2PreviewGenerationEnabled()) {
      return { skipped: true, reason: "preview_generation_disabled" };
    }
    const eventData = parseOnboardingV2PreviewEventData(event.data);
    const context = await step.run("load-onboarding-v2-blog-context", () =>
      loadOnboardingV2PreviewContext(eventData, false),
    );
    if (context.skipped) return context;
    if (context.blogStatus === "complete" && context.blogId) {
      return { success: true, alreadyExisted: true, blogId: context.blogId };
    }
    await step.run("mark-onboarding-v2-blog-running", () =>
      prisma.quickScrapeBusiness.updateMany({
        where: {
          id: eventData.quickBusinessId,
          userId: eventData.userId,
          onboardingV2BusinessId: eventData.businessId,
          onboardingV2GenerationRevision: eventData.revision,
          onboardingV2CompletedAt: null,
        },
        data: { onboardingV2BlogStatus: "running" },
      }),
    );
    try {
      const generated = await step.run("generate-onboarding-v2-blog-preview", async () => {
        const { generateQuickBlogForTrial } = await import(
          "../utils/quick-blog-generator"
        );
        return generateQuickBlogForTrial(
          eventData.userId,
          eventData.businessId,
          context.topic,
          {
            suppressEmail: true,
            status: "DRAFT",
            onboardingPreviewKey: onboardingV2PreviewIdempotencyKey(
              eventData.quickBusinessId,
              eventData.revision,
              "blog",
            ),
          },
        );
      });
      await step.run("complete-onboarding-v2-blog-preview", async () => {
        await prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
          },
          data: {
            onboardingV2BlogId: generated.blogId,
            onboardingV2BlogStatus: "complete",
          },
        });
        await clearOnboardingV2GenerationError(prisma, {
          quickBusinessId: eventData.quickBusinessId,
          userId: eventData.userId,
          businessId: eventData.businessId,
          revision: eventData.revision,
          stage: "blog",
        });
      });
      return { success: true, ...generated };
    } catch (error) {
      await step.run("fail-onboarding-v2-blog-preview", () =>
        prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
          },
          data: {
            onboardingV2BlogStatus: "failed",
            onboardingV2GenerationError: onboardingV2GenerationError({
              stage: "blog",
              code: "ONBOARDING_V2_BLOG_PREVIEW_FAILED",
              error,
              revision: eventData.revision,
            }),
          },
        }),
      );
      throw error;
    }
  },
);

export const onboardingV2SocialPreviewTask = createInngestFunction(
  {
    id: "onboarding-v2-social-preview",
    name: "Queue Onboarding V2 Social Preview",
    retries: 2,
    singleton: {
      key: "event.data.quickBusinessId + ':' + event.data.revision",
      mode: "skip",
    },
    ...onboardingFlowControl("event.data.quickBusinessId"),
  },
  { event: "onboarding-v2/social-preview.requested" },
  async ({ event, step }) => {
    if (!isOnboardingV2PreviewGenerationEnabled()) {
      return { skipped: true, reason: "preview_generation_disabled" };
    }
    const eventData = parseOnboardingV2PreviewEventData(event.data);
    const context = await step.run("load-onboarding-v2-social-context", () =>
      loadOnboardingV2PreviewContext(eventData, false),
    );
    if (context.skipped) return context;
    if (!isSocialCreativeGenerationEnabled()) {
      await step.run("mark-onboarding-v2-social-disabled", () =>
        prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
          },
          data: {
            onboardingV2SocialStatus: "failed",
            onboardingV2GenerationError: onboardingV2GenerationError({
              stage: "social",
              code: "SOCIAL_CREATIVE_GENERATION_DISABLED",
              error: new Error("Social creative generation is disabled"),
              revision: eventData.revision,
            }),
          },
        }),
      );
      return { skipped: true, reason: "social_generation_disabled" };
    }
    try {
      const idempotencyKey = onboardingV2PreviewIdempotencyKey(
        eventData.quickBusinessId,
        eventData.revision,
        "social",
      );
      const run = await step.run("create-onboarding-v2-social-run", () =>
        createOrGetSocialCreativeRun(
          {
            userId: eventData.userId,
            businessId: eventData.businessId,
            topic: context.topic,
            kind: "single",
            source: "ONBOARDING",
            sourceBlogId: null,
            sourcePlanId: null,
            platforms: ONBOARDING_V2_PREVIEW_PLATFORMS,
            idempotencyKey,
            estimatedBudgetUsd: estimateSocialCreativeImageBudget({
              kind: "single",
              platforms: ONBOARDING_V2_PREVIEW_PLATFORMS,
            }),
          },
          prisma,
        ),
      );
      const shouldDispatch = run.status === "PENDING" || run.status === "FAILED";
      const socialStatus =
        run.status === "COMPLETE"
          ? "complete"
          : shouldDispatch
            ? "queued"
            : "running";
      await step.run("record-onboarding-v2-social-run", async () => {
        await prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
          },
          data: {
            onboardingV2SocialRunId: run.id,
            onboardingV2SocialStatus: socialStatus,
          },
        });
        await clearOnboardingV2GenerationError(prisma, {
          quickBusinessId: eventData.quickBusinessId,
          userId: eventData.userId,
          businessId: eventData.businessId,
          revision: eventData.revision,
          stage: "social",
        });
      });
      if (shouldDispatch) {
        await step.sendEvent("dispatch-onboarding-v2-social-run", {
          name: "social/creative.requested",
          data: { runId: run.id, businessId: run.businessId },
        });
      }
      return {
        success: true,
        runId: run.id,
        status: socialStatus,
        dispatched: shouldDispatch,
      };
    } catch (error) {
      await step.run("fail-onboarding-v2-social-preview", () =>
        prisma.quickScrapeBusiness.updateMany({
          where: {
            id: eventData.quickBusinessId,
            userId: eventData.userId,
            onboardingV2BusinessId: eventData.businessId,
            onboardingV2GenerationRevision: eventData.revision,
          },
          data: {
            onboardingV2SocialStatus: "failed",
            onboardingV2GenerationError: onboardingV2GenerationError({
              stage: "social",
              code: "ONBOARDING_V2_SOCIAL_PREVIEW_FAILED",
              error,
              revision: eventData.revision,
            }),
          },
        }),
      );
      throw error;
    }
  },
);

export const quickBlogGenerationTask = createInngestFunction(
  {
    id: "quick-blog-generation",
    name: "Generate Quick Blog for Trial User",
    ...onboardingFlowControl("event.data.businessId"),
  },
  { event: "trial/quick-blog" },
  async ({ event, step }) => {
    const { userId, businessId, selectedService } = event.data;

    return await step.run("generate-quick-blog", async () => {
      try {
        console.log(
          `🚀 [Quick Blog] Generating quick blog for trial user ${userId}, service: ${selectedService}`,
        );

        const { generateQuickBlogForTrial } =
          await import("../utils/quick-blog-generator");

        await generateQuickBlogForTrial(userId, businessId, selectedService);

        console.log(
          `✅ [Quick Blog] Quick blog generated successfully for trial user ${userId}`,
        );

        return {
          success: true,
          userId,
          businessId,
          selectedService,
        };
      } catch (error: any) {
        console.error(
          `❌ [Quick Blog] Failed to generate quick blog for trial user ${userId}:`,
          error,
        );
        throw error;
      }
    });
  },
);

export const completeOnboardingTask = createInngestFunction(
  {
    id: "complete-onboarding",
    name: "Complete Onboarding for Trial User",
    retries: 3,
    timeouts: { finish: "60m" },
    ...onboardingFlowControl("event.data.userId"),
  },
  { event: "trial/complete-onboarding" },
  async ({ event, step }) => {
    const {
      userId,
      businessId,
      websiteUrl,
      selectedServices,
      servicesPriority,
      detectedServices,
      quickScrapeBusinessId,
      planTier,
      correlationId,
    } = event.data as {
      userId: string;
      businessId?: string | null;
      websiteUrl: string;
      selectedServices?: unknown;
      servicesPriority?: unknown;
      detectedServices?: unknown;
      quickScrapeBusinessId?: string | null;
      planTier?: WebsitePlanTier;
      correlationId?: string | null;
    };
    const resolvedPlanTier: WebsitePlanTier =
      planTier === "SEO_SOCIAL" ? "SEO_SOCIAL" : "SEO";

    const { getEquivalentWebsiteUrls, normalizeWebsiteUrl } =
      await import("../utils/url-normalizer");
    let onboardingBusinessId = businessId ?? null;

    if (!websiteUrl || websiteUrl.trim() === "") {
      console.error(
        `❌ [Complete Onboarding] Missing websiteUrl for user ${userId}. Cannot proceed.`,
      );
      return { success: false, userId, error: "Missing websiteUrl" };
    }

    const normalizedUrl = normalizeWebsiteUrl(websiteUrl);
    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);
    const normalizedSelectedServices = resolveOrderedSelectedServices(
      selectedServices,
      servicesPriority,
    );
    const explicitServicesPriority =
      resolveServicesPriorityMap(servicesPriority);
    const normalizedServicesPriority =
      Object.keys(explicitServicesPriority).length > 0
        ? explicitServicesPriority
        : buildServicesPriorityFromOrder(normalizedSelectedServices);
    const normalizedDetectedServices = Array.isArray(detectedServices)
      ? detectedServices.filter(
          (service): service is string => typeof service === "string",
        )
      : [];

    if (!normalizedUrl || normalizedUrl.trim() === "") {
      console.error(
        `❌ [Complete Onboarding] URL normalization resulted in empty URL for user ${userId}, input: ${websiteUrl}`,
      );
      return {
        success: false,
        userId,
        error: "Invalid websiteUrl after normalization",
      };
    }

    try {
      type IdempotencyResult =
        | { skipped: true; businessId: string }
        | { skipped: false };
      const idempotent = await step.run(
        "idempotency-check",
        async (): Promise<IdempotencyResult> => {
          const existing = await prisma.business.findFirst({
            where: {
              userId,
              businessWebsiteUrl: { in: websiteUrlCandidates },
              isActive: true,
              websiteStatus: { in: ["active", "trial"] },
            },
            include: {
              websiteAnalysis: { select: { id: true } },
              websiteSubscription: { select: { id: true } },
            },
          });

          if (
            existing &&
            existing.websiteAnalysis &&
            existing.keywordGenerationStatus === "completed" &&
            (existing.websiteStatus === "trial" ||
              existing.websiteSubscription != null)
          ) {
            return { skipped: true, businessId: existing.id };
          }

          return { skipped: false };
        },
      );

      if (idempotent.skipped && "businessId" in idempotent) {
        onboardingBusinessId = idempotent.businessId;

        await step.run("sync-existing-business-services", async () => {
          await prisma.business.update({
            where: { id: idempotent.businessId },
            data: {
              selectedServices: normalizedSelectedServices,
              servicesPriority: normalizedServicesPriority,
              detectedServices: normalizedDetectedServices,
            },
          });

          // Bust the GMB profile-proposal cache so the next read regenerates
          // with the new service list. Best-effort — never blocks the write.
          const { gmbAIService } = await import("../services/gmb-ai.service");
          await gmbAIService
            .invalidateProfileProposalCache(idempotent.businessId)
            .catch(() => undefined);
        });

        await step.run("mark-idempotent-business-complete", async () => {
          await reconcilePrimaryWorkspace(userId);
          const { markBusinessOnboardingCompleted } =
            await import("../services/onboarding-state.service");
          await markBusinessOnboardingCompleted(prisma, {
            businessId: idempotent.businessId,
            correlationId,
          });
        });

        if (resolvedPlanTier === "SEO_SOCIAL") {
          await step.sendEvent("plan-idempotent-social-topics", {
            name: "social/topics.plan.requested",
            data: {
              userId,
              businessId: idempotent.businessId,
              source: "INITIAL",
            },
          });
        }

        await step.sendEvent("refresh-idempotent-brand-analysis", {
          name: "brand/analyze",
          data: {
            businessId: idempotent.businessId,
            websiteUrl: normalizedUrl,
            userId,
            forceRefresh: true,
            source: "complete_onboarding_idempotent",
          },
        });

        await step.run("cleanup-quick-scrape-business-after-sync", async () => {
          if (quickScrapeBusinessId) {
            const quick = await prisma.quickScrapeBusiness.findFirst({
              where: { id: quickScrapeBusinessId, userId },
              select: { id: true },
            });
            if (quick) {
              await prisma.quickScrapeBusiness.delete({
                where: { id: quick.id },
              });
            }
            return;
          }

          await prisma.quickScrapeBusiness.deleteMany({
            where: {
              userId,
              businessWebsiteUrl: { in: websiteUrlCandidates },
            },
          });
        });

        await step.run("queue-signup-audit-email", async () => {
          try {
            await inngest.send({
              name: "signup-audit/run-and-email",
              data: {
                userId,
                businessId: idempotent.businessId,
                correlationId,
              },
            });
          } catch (auditQueueError) {
            console.error(
              `⚠️ [Complete Onboarding] Failed to queue signup audit email for existing business ${idempotent.businessId}:`,
              auditQueueError,
            );
          }
        });

        console.log(
          `⏭️ [Complete Onboarding] Idempotency: already completed for user ${userId}, url ${normalizedUrl}, business ${idempotent.businessId}`,
        );
        return {
          success: true,
          userId,
          businessId: idempotent.businessId,
          skipped: true,
        };
      }

      console.log(
        `🔄 [Complete Onboarding] Starting for trial user ${userId}, website: ${normalizedUrl}, quickScrapeBusinessId: ${quickScrapeBusinessId ?? "none"}`,
      );

      const trialAnchorBusiness = await step.run(
        "resolve-trial-anchor",
        async () => {
          const anchor = onboardingBusinessId
            ? await prisma.business.findFirst({
                where: { id: onboardingBusinessId, userId },
                select: { id: true },
              })
            : await prisma.business.findFirst({
                where: {
                  userId,
                  businessWebsiteUrl: { in: websiteUrlCandidates },
                  websiteStatus: "trial",
                },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              });

          return anchor;
        },
      );

      onboardingBusinessId = trialAnchorBusiness?.id ?? onboardingBusinessId;

      if (onboardingBusinessId) {
        await step.run("mark-onboarding-running", async () => {
          const { markBusinessOnboardingRunning } =
            await import("../services/onboarding-state.service");
          await markBusinessOnboardingRunning(prisma, {
            businessId: onboardingBusinessId!,
            correlationId,
          });
        });
      }

      const persistedBusiness = await step.run(
        "execute-llm-analysis",
        async () => {
          const { executeLLM } = await import("../llm/index.llm");

          console.log(
            `🔄 [Complete Onboarding] Running executeLLM for website: ${normalizedUrl}`,
          );

          const result = await executeLLM({
            websiteUrl: normalizedUrl,
            userId,
            preferredBusinessId: onboardingBusinessId,
            correlationId,
            onboardingFlow: "trial_primary",
          });

          console.log(
            `✅ [Complete Onboarding] Complete LLM analysis finished for trial user ${userId} -> business ${result.businessId}`,
          );

          return result;
        },
      );

      onboardingBusinessId = persistedBusiness.businessId;

      if (
        trialAnchorBusiness &&
        trialAnchorBusiness.id !== persistedBusiness.businessId
      ) {
        await step.run("merge-trial-business", async () => {
          await prisma.blog.updateMany({
            where: { businessId: trialAnchorBusiness.id },
            data: { businessId: persistedBusiness.businessId },
          });

          await prisma.plan.updateMany({
            where: { businessId: trialAnchorBusiness.id },
            data: { businessId: persistedBusiness.businessId },
          });

          await prisma.socialCreativeRun.updateMany({
            where: { businessId: trialAnchorBusiness.id },
            data: { businessId: persistedBusiness.businessId },
          });

          await prisma.socialTopicPlan.updateMany({
            where: { businessId: trialAnchorBusiness.id },
            data: { businessId: persistedBusiness.businessId },
          });

          const [trialSocialSettings, persistedSocialSettings] =
            await Promise.all([
              prisma.socialAutomationSettings.findUnique({
                where: { businessId: trialAnchorBusiness.id },
              }),
              prisma.socialAutomationSettings.findUnique({
                where: { businessId: persistedBusiness.businessId },
              }),
            ]);
          if (trialSocialSettings && !persistedSocialSettings) {
            await prisma.socialAutomationSettings.update({
              where: { id: trialSocialSettings.id },
              data: { businessId: persistedBusiness.businessId },
            });
          }

          const existingTrialWebsiteSub =
            await prisma.websiteSubscription.findUnique({
              where: { businessId: trialAnchorBusiness.id },
            });
          const newBusinessWebsiteSub =
            await prisma.websiteSubscription.findUnique({
              where: { businessId: persistedBusiness.businessId },
            });

          if (existingTrialWebsiteSub && !newBusinessWebsiteSub) {
            await prisma.websiteSubscription.update({
              where: { id: existingTrialWebsiteSub.id },
              data: { businessId: persistedBusiness.businessId },
            });
          }

          await prisma.business.delete({
            where: { id: trialAnchorBusiness.id },
          });

          console.log(
            `✅ [Complete Onboarding] Merged trial business ${trialAnchorBusiness.id} into full business ${persistedBusiness.businessId}`,
          );
        });
      }

      await step.run("update-business-with-services", async () => {
        const { PER_SITE_TRIALS_ENABLED } =
          await import("../config/feature-flags");
        const existingPrimary = await prisma.business.findFirst({
          where: {
            userId: userId,
            isPrimary: true,
            id: { not: persistedBusiness.businessId },
          },
          select: { id: true },
        });
        const shouldBePrimary = existingPrimary === null;
        const userEntitlement = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            trialEndDate: true,
            trialStatus: true,
            Subscription: {
              select: {
                currentPeriodEnd: true,
                status: true,
              },
            },
          },
        });
        const trialEndDate =
          userEntitlement?.trialEndDate ??
          userEntitlement?.Subscription?.currentPeriodEnd ??
          null;
        const hasPaidSubscription =
          userEntitlement?.Subscription?.status === "active";
        const hasActiveTrial =
          PER_SITE_TRIALS_ENABLED &&
          (userEntitlement?.Subscription?.status === "trialing" ||
            userEntitlement?.trialStatus === "active") &&
          (!trialEndDate || trialEndDate > new Date());
        const targetWebsiteStatus =
          hasPaidSubscription || !hasActiveTrial ? "active" : "trial";

        await prisma.business.update({
          where: { id: persistedBusiness.businessId },
          data: {
            isPrimary: shouldBePrimary,
            websiteStatus: targetWebsiteStatus,
            isActive: true,
            selectedServices: normalizedSelectedServices,
            servicesPriority: normalizedServicesPriority,
            detectedServices: normalizedDetectedServices,
          },
        });

        // Bust the GMB profile-proposal cache so the next read regenerates
        // with the new service list. Best-effort — never blocks the write.
        const { gmbAIService } = await import("../services/gmb-ai.service");
        await gmbAIService
          .invalidateProfileProposalCache(persistedBusiness.businessId)
          .catch(() => undefined);
      });

      await step.sendEvent("trigger-brand-analysis", {
        name: "brand/analyze",
        data: {
          businessId: persistedBusiness.businessId,
          websiteUrl: normalizedUrl,
          userId,
          forceRefresh: true,
          source: "complete_onboarding",
        },
      });

      await step.run("create-website-subscription", async () => {
        const { PER_SITE_TRIALS_ENABLED } =
          await import("../config/feature-flags");
        if (!PER_SITE_TRIALS_ENABLED) return;

        const agencyAssignment = await getAgencyAssignmentForBusiness(
          persistedBusiness.businessId,
        );
        const agencyPricingConfigId = await getActiveAgencyPricingConfigId(
          agencyAssignment.agencyId,
          resolvedPlanTier,
        );

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            trialStartDate: true,
            trialEndDate: true,
            trialStatus: true,
            Subscription: {
              select: {
                currentPeriodEnd: true,
                startDate: true,
                status: true,
              },
            },
          },
        });

        const hasPaidSubscription = user?.Subscription?.status === "active";
        const trialStart: Date =
          user?.trialStartDate ?? user?.Subscription?.startDate ?? new Date();
        const trialEnd: Date =
          user?.trialEndDate ??
          user?.Subscription?.currentPeriodEnd ??
          (() => {
            const d = new Date();
            d.setDate(d.getDate() + 7);
            return d;
          })();

        await prisma.websiteSubscription.upsert({
          where: { businessId: persistedBusiness.businessId },
          create: {
            businessId: persistedBusiness.businessId,
            planTier: resolvedPlanTier,
            status: hasPaidSubscription ? "active" : "trialing",
            trialStartDate: hasPaidSubscription ? null : trialStart,
            trialEndDate: hasPaidSubscription ? null : trialEnd,
            trialStatus: hasPaidSubscription
              ? user?.trialStatus === "converted"
                ? "converted"
                : "none"
              : "trialing",
            currentPeriodStart: hasPaidSubscription
              ? (user?.Subscription?.startDate ?? null)
              : null,
            currentPeriodEnd: hasPaidSubscription
              ? (user?.Subscription?.currentPeriodEnd ?? null)
              : null,
            agencyId: agencyAssignment.agencyId,
            agencyPricingConfigId,
          },
          update: {
            planTier: resolvedPlanTier,
            status: hasPaidSubscription ? "active" : "trialing",
            trialStartDate: hasPaidSubscription ? null : trialStart,
            trialEndDate: hasPaidSubscription ? null : trialEnd,
            trialStatus: hasPaidSubscription
              ? user?.trialStatus === "converted"
                ? "converted"
                : "none"
              : "trialing",
            currentPeriodStart: hasPaidSubscription
              ? (user?.Subscription?.startDate ?? null)
              : null,
            currentPeriodEnd: hasPaidSubscription
              ? (user?.Subscription?.currentPeriodEnd ?? null)
              : null,
            agencyId: agencyAssignment.agencyId,
            agencyPricingConfigId,
          },
        });

        console.log(
          `✅ [Complete Onboarding] Upserted WebsiteSubscription (${hasPaidSubscription ? "paid" : "trial"}) for business ${persistedBusiness.businessId}`,
        );
      });

      await step.run("reconcile-primary-workspace", () =>
        reconcilePrimaryWorkspace(userId),
      );

      const keywordPreparation = await step.run(
        "prepare-initial-keyword-generation",
        async () => {
        // Verify business exists, is active, and has websiteAnalysis before
        // invoking the durable keyword workflow.
        const verifiedBusiness = await prisma.business.findUnique({
          where: {
            id: persistedBusiness.businessId,
            userId: userId,
            isActive: true,
          },
          include: {
            websiteAnalysis: {
              include: {
                coreServices: true,
              },
            },
          },
        });

        if (!verifiedBusiness) {
          console.error(
            `❌ [Complete Onboarding] Business ${persistedBusiness.businessId} not found or not active for user ${userId}. Cannot trigger keyword generation.`,
          );
          throw new Error(
            `Business ${persistedBusiness.businessId} not found or not active after onboarding completion`,
          );
        }

        if (!verifiedBusiness.websiteAnalysis) {
          console.error(
            `❌ [Complete Onboarding] Business ${verifiedBusiness.id} does not have websiteAnalysis. Cannot trigger keyword generation.`,
          );
          throw new Error(
            `Business ${verifiedBusiness.id} missing websiteAnalysis data required for keyword generation`,
          );
        }

        console.log(
          `✅ [Complete Onboarding] Verified business ${verifiedBusiness.id} (${verifiedBusiness.businessName}) is active and has websiteAnalysis. Ready for keyword generation.`,
        );

        if (verifiedBusiness.keywordGenerationStatus === "completed") {
          return { businessId: verifiedBusiness.id, alreadyCompleted: true };
        }
        await prisma.business.update({
          where: { id: verifiedBusiness.id },
          data: {
            keywordGenerationStatus: "pending",
            keywordGenerationStartedAt: null,
            keywordGenerationCompletedAt: null,
          },
        });
        return { businessId: verifiedBusiness.id, alreadyCompleted: false };
      });

      if (!keywordPreparation.alreadyCompleted) {
        await step.invoke("generate-initial-keywords", {
          function: generateKeywordsTask,
          data: {
            userId,
            businessId: keywordPreparation.businessId,
          },
          timeout: "30m",
        });
      }

      await step.run("verify-initial-keywords-completed", async () => {
        const business = await prisma.business.findUnique({
          where: { id: keywordPreparation.businessId },
          select: { keywordGenerationStatus: true },
        });
        if (business?.keywordGenerationStatus !== "completed") {
          throw new Error(
            `Keyword generation did not complete for business ${keywordPreparation.businessId}`,
          );
        }
      });

      await step.run("delete-quick-scrape-business", async () => {
        if (quickScrapeBusinessId) {
          const quick = await prisma.quickScrapeBusiness.findFirst({
            where: { id: quickScrapeBusinessId, userId },
            select: { id: true },
          });
          if (quick) {
            await prisma.quickScrapeBusiness.delete({
              where: { id: quick.id },
            });
            console.log(
              `🗑️ [Complete Onboarding] Deleted quick scrape business ${quick.id}`,
            );
          }
          return;
        }

        const deleted = await prisma.quickScrapeBusiness.deleteMany({
          where: {
            userId,
            businessWebsiteUrl: { in: websiteUrlCandidates },
          },
        });
        if (deleted.count > 0) {
          console.log(
            `🗑️ [Complete Onboarding] Deleted ${deleted.count} quick scrape record(s) for ${normalizedUrl}`,
          );
        }
      });

      if (resolvedPlanTier === "SEO_SOCIAL") {
        await step.sendEvent("trigger-initial-social-topic-plan", {
          name: "social/topics.plan.requested",
          data: {
            userId,
            businessId: persistedBusiness.businessId,
            source: "INITIAL",
          },
        });
      }

      await step.run("trigger-sitemap-discovery", async () => {
        try {
          await inngest.send({
            name: "sitemap/discover",
            data: {
              userId,
              websiteUrl: normalizedUrl,
              businessId: persistedBusiness.businessId,
            },
          });
          console.log(
            `✅ [Complete Onboarding] Sitemap discovery triggered for user ${userId}, business ${persistedBusiness.businessId}`,
          );
        } catch (e) {
          console.error(
            `⚠️ [Complete Onboarding] Failed to trigger sitemap discovery:`,
            e,
          );
        }
      });

      await step.run("set-user-onboarding-complete", async () => {
        await prisma.user.update({
          where: { id: userId },
          data: { onboarding: true },
        });
        const { TrialAnalyticsService } =
          await import("../services/trial-analytics.service");
        await TrialAnalyticsService.trackOnboardingCompleted(userId);
        console.log(
          `✅ [Complete Onboarding] Set onboarding=true for user ${userId}`,
        );
      });

      await step.run("mark-onboarding-completed", async () => {
        const { markBusinessOnboardingCompleted } =
          await import("../services/onboarding-state.service");
        await markBusinessOnboardingCompleted(prisma, {
          businessId: persistedBusiness.businessId,
          correlationId,
        });
      });

      await step.run("send-onboarding-complete-email", async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true },
          });
          const business = await prisma.business.findUnique({
            where: { id: persistedBusiness.businessId },
            select: { businessName: true, businessWebsiteUrl: true },
          });
          if (user?.email) {
            const { EmailService } = await import("../services/email.service");
            const emailService = new EmailService();
            await emailService.sendOnboardingCompleteEmail({
              userName: user.name || "there",
              userEmail: user.email,
              businessName: business?.businessName || normalizedUrl,
              websiteUrl: business?.businessWebsiteUrl || normalizedUrl,
            });
            console.log(
              `✅ [Complete Onboarding] Onboarding completion email sent to ${user.email}`,
            );
          }
        } catch (emailError) {
          console.error(
            `⚠️ [Complete Onboarding] Failed to send onboarding completion email:`,
            emailError,
          );
        }
      });

      await step.run("queue-signup-audit-email", async () => {
        try {
          await inngest.send({
            name: "signup-audit/run-and-email",
            data: {
              userId,
              businessId: persistedBusiness.businessId,
              correlationId,
            },
          });
          console.log(
            `✅ [Complete Onboarding] Signup audit email queued for business ${persistedBusiness.businessId}`,
          );
        } catch (auditQueueError) {
          console.error(
            `⚠️ [Complete Onboarding] Failed to queue signup audit email for business ${persistedBusiness.businessId}:`,
            auditQueueError,
          );
        }
      });

      console.log(
        `✅ [Complete Onboarding] Complete onboarding finished for trial user ${userId}`,
      );

      console.log(
        `[Onboarding] ${JSON.stringify({
          stage: "complete_onboarding_completed",
          userId,
          businessId: persistedBusiness.businessId,
          quickScrapeBusinessId: quickScrapeBusinessId ?? undefined,
          websiteUrl: normalizedUrl,
          correlationId: correlationId ?? undefined,
          timestamp: new Date().toISOString(),
        })}`,
      );

      return {
        success: true,
        userId,
        businessId: persistedBusiness.businessId,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      if (onboardingBusinessId) {
        await step.run("mark-onboarding-failed", async () => {
          try {
            const { markBusinessOnboardingFailed, serializeOnboardingError } =
              await import("../services/onboarding-state.service");
            await markBusinessOnboardingFailed(prisma, {
              businessId: onboardingBusinessId!,
              correlationId,
              error: serializeOnboardingError(error, "complete_onboarding"),
            });
          } catch (markError) {
            console.error(
              `⚠️ [Complete Onboarding] Failed to mark onboarding as failed for business ${onboardingBusinessId}:`,
              markError,
            );
          }
        });
      }
      const { logOnboardingAlert } = await import("../utils/onboarding-logger");
      logOnboardingAlert("complete_onboarding_failed", {
        userId,
        quickScrapeBusinessId: quickScrapeBusinessId ?? undefined,
        correlationId: correlationId ?? undefined,
        message: reason,
      });
      console.log(
        `[Onboarding] ${JSON.stringify({
          stage: "complete_onboarding_failed",
          userId,
          quickScrapeBusinessId: quickScrapeBusinessId ?? undefined,
          websiteUrl: normalizedUrl,
          reason,
          correlationId: correlationId ?? undefined,
          timestamp: new Date().toISOString(),
        })}`,
      );
      console.error(
        `❌ [Complete Onboarding] Failed to complete onboarding for trial user ${userId}:`,
        error,
      );
      throw error;
    }
  },
);

export const secondaryOnboardingV2InitializeTask = createInngestFunction(
  {
    id: "website-secondary-onboarding-v2-initialize",
    name: "Initialize Resumable Secondary Onboarding v2",
    retries: 3,
    ...onboardingFlowControl("event.data.businessId"),
  },
  { event: "website-secondary/onboarding-v2.initialize" },
  async ({ event, step }) => {
    const { userId, businessId, quickScrapeBusinessId, correlationId } =
      event.data as {
        userId: string;
        businessId: string;
        quickScrapeBusinessId: string;
        correlationId?: string | null;
      };

    const contract = await step.run("validate-secondary-initialize-contract", async () => {
      const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
        where: {
          id: quickScrapeBusinessId,
          userId,
          onboardingV2BusinessId: businessId,
          onboardingV2Flow: "website_secondary",
        },
      });
      const business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          onboardingFlow: "website_secondary",
          removalStatus: "active",
        },
        include: { websiteSubscription: { select: { status: true } } },
      });
      if (!quickBusiness || !business) {
        throw new NonRetriableError("Secondary onboarding session was not found");
      }
      if (
        !business.websiteSubscription ||
        !["active", "trialing"].includes(business.websiteSubscription.status)
      ) {
        throw new NonRetriableError("Secondary website subscription is not active");
      }
      if (quickBusiness.onboardingV2Status === "completed") {
        return { skipped: true as const, quickBusiness, business };
      }
      return { skipped: false as const, quickBusiness, business };
    });
    if (contract.skipped) {
      return { success: true, skipped: true, businessId, quickScrapeBusinessId };
    }

    try {
      const scan = await step.run("scan-secondary-website", async () => {
        const { quickScrapeServices } = await import("../utils/quick-scrape.utils");
        const result = await quickScrapeServices(
          contract.quickBusiness.businessWebsiteUrl,
        );
        if (!result.success) {
          throw new Error(result.error || "Failed to scan secondary website");
        }
        return result;
      });

      await step.run("persist-secondary-scan", async () => {
        const now = new Date();
        const quickData = {
          businessName: scan.businessName || contract.quickBusiness.businessName,
          businessType: scan.businessType || contract.quickBusiness.businessType,
          detectedServices: scan.detectedServices || [],
          businessAddress: scan.businessAddress || null,
          businessCity: scan.businessCity || null,
          businessState: scan.businessState || null,
          businessCountry: scan.businessCountry || null,
          businessPhone: scan.businessPhone || null,
          serviceArea: scan.serviceArea || null,
          serviceAreaLocations: scan.serviceAreaLocations || [],
          businessLocationMode: scan.businessLocationMode || "unknown",
          businessDescription: scan.businessDescription || null,
          targetAudience: scan.targetAudience || null,
          brandContext: scan.brandContext
            ? (scan.brandContext as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          onboardingV2Step: "services",
          onboardingV2Status: "in_progress",
          onboardingV2LastSeenAt: now,
          onboardingV2GenerationError: Prisma.DbNull,
        };
        await prisma.$transaction([
          prisma.quickScrapeBusiness.update({
            where: { id: quickScrapeBusinessId },
            data: quickData,
          }),
          prisma.business.update({
            where: { id: businessId },
            data: {
              businessName: quickData.businessName,
              businessType: quickData.businessType,
              businessDescription:
                quickData.businessDescription || quickData.businessName,
              businessAddress: quickData.businessAddress,
              businessCity: quickData.businessCity,
              businessState: quickData.businessState,
              businessCountry: quickData.businessCountry,
              businessPhone: quickData.businessPhone,
              serviceArea: quickData.serviceArea,
              serviceAreaLocations: quickData.serviceAreaLocations,
              detectedServices: quickData.detectedServices,
              isPrimary: false,
              isActive: false,
              websiteStatus: "pending",
              onboardingStatus: "awaiting_confirmation",
              onboardingCorrelationId: correlationId ?? undefined,
            },
          }),
        ]);
      });

      return { success: true, businessId, quickScrapeBusinessId };
    } catch (error) {
      await step.run("preserve-secondary-initialize-failure", async () => {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.$transaction([
          prisma.quickScrapeBusiness.updateMany({
            where: {
              id: quickScrapeBusinessId,
              userId,
              onboardingV2Flow: "website_secondary",
            },
            data: {
              onboardingV2Status: "in_progress",
              onboardingV2LastSeenAt: new Date(),
              onboardingV2GenerationError: {
                code: "secondary_scan_failed",
                stage: "secondary_initialize",
                message,
              },
            },
          }),
          prisma.business.updateMany({
            where: { id: businessId, userId },
            data: {
              isPrimary: false,
              isActive: false,
              websiteStatus: "pending",
              onboardingStatus: "awaiting_confirmation",
              onboardingLastError: {
                code: "secondary_scan_failed",
                stage: "secondary_initialize",
                message,
              },
            },
          }),
        ]);
      });
      throw error;
    }
  },
);

export const secondaryOnboardingV2CompleteTask = createInngestFunction(
  {
    id: "website-secondary-onboarding-v2-complete",
    name: "Complete Resumable Secondary Onboarding v2",
    retries: 3,
    timeouts: { finish: "60m" },
    ...onboardingFlowControl("event.data.businessId"),
  },
  { event: "website-secondary/onboarding-v2.complete" },
  async ({ event, step }) => {
    const { userId, businessId, quickScrapeBusinessId, correlationId } =
      event.data as {
        userId: string;
        businessId: string;
        quickScrapeBusinessId: string;
        correlationId?: string | null;
      };

    const contract = await step.run("validate-secondary-completion-contract", async () => {
      const quickBusiness = await prisma.quickScrapeBusiness.findFirst({
        where: {
          id: quickScrapeBusinessId,
          userId,
          onboardingV2BusinessId: businessId,
          onboardingV2Flow: "website_secondary",
        },
      });
      const business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          onboardingFlow: "website_secondary",
          removalStatus: "active",
        },
        include: { websiteSubscription: true },
      });
      if (!quickBusiness || !business) {
        throw new NonRetriableError("Secondary onboarding session was not found");
      }
      if (
        quickBusiness.onboardingV2BlogStatus !== "complete" ||
        quickBusiness.onboardingV2SocialStatus !== "complete" ||
        !quickBusiness.onboardingV2BlogId ||
        !quickBusiness.onboardingV2SocialRunId
      ) {
        throw new NonRetriableError("Secondary onboarding preview is incomplete");
      }
      if (
        !business.websiteSubscription ||
        !["active", "trialing"].includes(business.websiteSubscription.status)
      ) {
        throw new NonRetriableError("Secondary website subscription is not active");
      }
      if (
        quickBusiness.onboardingV2Status === "completed" &&
        business.onboardingStatus === "completed" &&
        business.keywordGenerationStatus === "completed" &&
        business.isActive
      ) {
        return { skipped: true as const, quickBusiness, business };
      }
      return { skipped: false as const, quickBusiness, business };
    });

    try {
      let persistedBusinessId = businessId;

      if (!contract.skipped) {
        await step.run("mark-secondary-onboarding-running", async () => {
          await prisma.business.update({
            where: { id: businessId },
            data: {
              isPrimary: false,
              isActive: false,
              websiteStatus: "pending",
              onboardingStatus: "running",
              onboardingLastAttemptAt: new Date(),
              onboardingCorrelationId: correlationId ?? undefined,
              onboardingLastError: Prisma.DbNull,
            },
          });
        });

        const persisted = await step.run("analyze-secondary-website", async () => {
          const { executeLLM } = await import("../llm/index.llm");
          const result = await executeLLM({
            websiteUrl: contract.quickBusiness.businessWebsiteUrl,
            userId,
            preferredBusinessId: businessId,
            correlationId,
            onboardingFlow: "website_secondary",
          });
          if (result.businessId !== businessId) {
            throw new Error("Secondary analysis persisted to an unexpected business");
          }
          return result;
        });
        persistedBusinessId = persisted.businessId;

        await step.run("activate-secondary-for-keywords", async () => {
          const latestSubscription = await prisma.websiteSubscription.findUnique({
            where: { businessId },
            select: { status: true },
          });
          if (
            !latestSubscription ||
            !["active", "trialing"].includes(latestSubscription.status)
          ) {
            throw new Error("Secondary website subscription became inactive");
          }
          const answers =
            contract.quickBusiness.onboardingV2Answers &&
            typeof contract.quickBusiness.onboardingV2Answers === "object" &&
            !Array.isArray(contract.quickBusiness.onboardingV2Answers)
              ? (contract.quickBusiness.onboardingV2Answers as Record<
                  string,
                  unknown
                >)
              : {};
          const author =
            contract.quickBusiness.onboardingV2Author &&
            typeof contract.quickBusiness.onboardingV2Author === "object" &&
            !Array.isArray(contract.quickBusiness.onboardingV2Author)
              ? (contract.quickBusiness.onboardingV2Author as Record<
                  string,
                  unknown
                >)
              : {};
          const selectedServices = contract.quickBusiness.selectedServices.length
            ? contract.quickBusiness.selectedServices
            : contract.quickBusiness.detectedServices;
          const contentTypes = Array.isArray(answers.a5_content)
            ? answers.a5_content.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          const expertise = Array.isArray(author.expertise)
            ? author.expertise.filter(
                (value): value is string => typeof value === "string",
              )
            : [];

          await prisma.$transaction([
            prisma.business.update({
              where: { id: businessId },
              data: {
                isPrimary: false,
                isActive: true,
                websiteStatus:
                  latestSubscription.status === "trialing" ? "trial" : "active",
                onboardingFlow: "website_secondary",
                onboardingStatus: "running",
                onboardingCompletedAt: null,
                onboardingLastError: Prisma.DbNull,
                selectedServices,
                servicesPriority:
                  contract.quickBusiness.servicesPriority ?? Prisma.JsonNull,
                detectedServices: contract.quickBusiness.detectedServices,
                authorName:
                  typeof author.name === "string"
                    ? author.name.trim() || null
                    : null,
                authorBio:
                  typeof author.bio === "string"
                    ? author.bio.trim() || null
                    : null,
                authorJobTitle:
                  typeof author.title === "string"
                    ? author.title.trim() || null
                    : null,
                authorImage:
                  typeof author.imageUrl === "string"
                    ? author.imageUrl.trim() || null
                    : null,
                authorExpertise: expertise,
                preferredContentTypes: contentTypes,
              },
            }),
          ]);
        });
      }

      const keywordPreparation = await step.run(
        "prepare-secondary-keywords",
        async () => {
          const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { keywordGenerationStatus: true },
          });
          if (business?.keywordGenerationStatus === "completed") {
            return { alreadyCompleted: true };
          }
          await prisma.business.update({
            where: { id: businessId },
            data: {
              keywordGenerationStatus: "pending",
              keywordGenerationStartedAt: null,
              keywordGenerationCompletedAt: null,
            },
          });
          return { alreadyCompleted: false };
        },
      );
      if (!keywordPreparation.alreadyCompleted) {
        await step.invoke("generate-secondary-keywords", {
          function: generateKeywordsTask,
          data: { userId, businessId },
          timeout: "30m",
        });
      }

      await step.run("complete-secondary-onboarding", async () => {
        const completedAt = new Date();
        await prisma.$transaction(async (tx) => {
          await lockPrimaryWorkspaceSelection(tx, userId);
          const business = await tx.business.findFirst({
            where: {
              id: businessId,
              userId,
              onboardingFlow: "website_secondary",
              removalStatus: "active",
            },
            select: { keywordGenerationStatus: true },
          });
          if (business?.keywordGenerationStatus !== "completed") {
            throw new Error(
              `Keyword generation did not complete for secondary business ${businessId}`,
            );
          }

          await tx.business.updateMany({
            where: { userId, isPrimary: true },
            data: { isPrimary: false },
          });
          await tx.business.update({
            where: { id: businessId },
            data: {
              isPrimary: true,
              onboardingStatus: "completed",
              onboardingCompletedAt: completedAt,
              onboardingLastError: Prisma.DbNull,
            },
          });
          await tx.quickScrapeBusiness.update({
            where: { id: quickScrapeBusinessId },
            data: {
              onboardingV2Step: "complete",
              onboardingV2Status: "completed",
              onboardingV2CompletedAt: completedAt,
              onboardingV2LastSeenAt: completedAt,
              onboardingV2GenerationError: Prisma.DbNull,
            },
          });
        });
      });

      if (contract.business.websiteSubscription?.planTier === "SEO_SOCIAL") {
        await step.sendEvent("queue-secondary-social-topics", {
          id: `secondary-onboarding-v2-social-topics:${quickScrapeBusinessId}`,
          name: "social/topics.plan.requested",
          data: { userId, businessId, source: "INITIAL" },
        });
      }

      await step.sendEvent("queue-secondary-sitemap", {
        id: `secondary-onboarding-v2-sitemap:${quickScrapeBusinessId}`,
        name: "sitemap/discover",
        data: {
          userId,
          businessId,
          websiteUrl: contract.quickBusiness.businessWebsiteUrl,
        },
      });

      return {
        success: true,
        businessId: persistedBusinessId,
        quickScrapeBusinessId,
        analysisAlreadyCompleted: contract.skipped,
      };
    } catch (error) {
      await step.run("preserve-secondary-completion-failure", async () => {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.business.updateMany({
          where: {
            id: businessId,
            userId,
            onboardingStatus: { not: "completed" },
          },
          data: {
            isPrimary: false,
            isActive: false,
            websiteStatus: "pending",
            onboardingStatus: "awaiting_confirmation",
            onboardingLastError: {
              code: "secondary_completion_failed",
              stage: "secondary_onboarding_v2_complete",
              message,
            },
          },
        });
      });
      throw error;
    }
  },
);

export const websiteOnboardTask = createInngestFunction(
  {
    id: "website-onboard",
    name: "Onboard Additional Website in Background",
    retries: 2,
    ...onboardingFlowControl("event.data.businessId"),
  },
  { event: "website/onboard" },
  async ({ event, step }) => {
    const { userId, businessId, websiteUrl, correlationId } = event.data as {
      userId: string;
      businessId: string;
      websiteUrl: string;
      correlationId?: string | null;
    };

    const { getEquivalentWebsiteUrls, normalizeWebsiteUrl } =
      await import("../utils/url-normalizer");
    const normalizedUrl = normalizeWebsiteUrl(websiteUrl);
    const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);
    let onboardingBusinessId = businessId;

    type IdempotencyResult =
      | { skipped: true; businessId: string }
      | { skipped: false };

    const idempotent = await step.run(
      "idempotency-check",
      async (): Promise<IdempotencyResult> => {
        const existing = await prisma.business.findFirst({
          where: {
            userId,
            businessWebsiteUrl: { in: websiteUrlCandidates },
            isActive: true,
            websiteStatus: { in: ["active", "trial"] },
          },
          include: {
            websiteAnalysis: { select: { id: true } },
            websiteSubscription: { select: { id: true } },
          },
        });

        if (
          existing &&
          existing.websiteAnalysis &&
          (existing.websiteStatus === "trial" ||
            existing.websiteSubscription != null)
        ) {
          return { skipped: true, businessId: existing.id };
        }

        return { skipped: false };
      },
    );

    if (idempotent.skipped && "businessId" in idempotent) {
      onboardingBusinessId = idempotent.businessId;
      await step.run("mark-idempotent-business-complete", async () => {
        const { markBusinessOnboardingCompleted } =
          await import("../services/onboarding-state.service");
        await markBusinessOnboardingCompleted(prisma, {
          businessId: idempotent.businessId,
          correlationId,
        });
      });
      console.log(
        `⏭️ [Website Onboard] Idempotency: already completed for user ${userId}, url ${normalizedUrl}, business ${idempotent.businessId}`,
      );

      const shouldPlanSocialTopics = await step.run(
        "resolve-idempotent-secondary-social-entitlement",
        async () => {
          const websiteSubscription =
            await prisma.websiteSubscription.findUnique({
              where: { businessId: idempotent.businessId },
              select: { planTier: true },
            });
          return websiteSubscription?.planTier === "SEO_SOCIAL";
        },
      );

      if (shouldPlanSocialTopics) {
        await step.sendEvent("trigger-idempotent-secondary-social-topic-plan", {
          name: "social/topics.plan.requested",
          data: {
            userId,
            businessId: idempotent.businessId,
            source: "INITIAL",
          },
        });
      }

      return {
        success: true,
        userId,
        businessId: idempotent.businessId,
        skipped: true,
      };
    }

    const initialBusiness = await step.run("load-initial-business", async () => {
      return prisma.business.findUnique({
        where: { id: businessId },
        select: {
          id: true,
          isPrimary: true,
          onboardingFlow: true,
          onboardingStatus: true,
          secondaryDetailsConfirmed: true,
          websiteStatus: true,
          businessWebsiteUrl: true,
        },
      });
    });

    try {
      console.log(
        `🔄 [Website Onboard] Starting background onboarding for user ${userId}, business ${businessId}, website: ${normalizedUrl}`,
      );

      await step.run("mark-onboarding-running", async () => {
        const { markBusinessOnboardingRunning } =
          await import("../services/onboarding-state.service");
        await markBusinessOnboardingRunning(prisma, {
          businessId: onboardingBusinessId,
          correlationId,
        });
      });

      const persistedBusiness = await step.run(
        "execute-llm-analysis",
        async () => {
          const { executeLLM } = await import("../llm/index.llm");
          const result = await executeLLM({
            websiteUrl: normalizedUrl,
            userId,
            preferredBusinessId: onboardingBusinessId,
            correlationId,
            onboardingFlow: "website_secondary",
          });
          console.log(
            `✅ [Website Onboard] LLM analysis completed for user ${userId}, website: ${normalizedUrl}, business: ${result.businessId}`,
          );
          return result;
        },
      );

      onboardingBusinessId = persistedBusiness.businessId;

      const pendingBusiness = await step.run(
        "merge-pending-business",
        async () => {
          if (persistedBusiness.businessId === businessId) {
            return null;
          }
          const pending = await prisma.business.findUnique({
            where: { id: businessId },
          });
          if (pending && pending.id !== persistedBusiness.businessId) {
            await prisma.blog.updateMany({
              where: { businessId: pending.id },
              data: { businessId: persistedBusiness.businessId },
            });
            await prisma.plan.updateMany({
              where: { businessId: pending.id },
              data: { businessId: persistedBusiness.businessId },
            });
            if (pending.stripeSubscriptionItemId) {
              await prisma.business.update({
                where: { id: persistedBusiness.businessId },
                data: {
                  stripeSubscriptionItemId: pending.stripeSubscriptionItemId,
                },
              });
            }
            const wSub = await prisma.websiteSubscription.findUnique({
              where: { businessId: pending.id },
            });
            if (wSub) {
              await prisma.websiteSubscription.update({
                where: { id: wSub.id },
                data: { businessId: persistedBusiness.businessId },
              });
            }
            await prisma.business.delete({ where: { id: pending.id } });
            console.log(
              `✅ [Website Onboard] Merged pending business ${pending.id} into analyzed business ${persistedBusiness.businessId}`,
            );
          }
          return pending;
        },
      );

      const finalBusinessId = persistedBusiness.businessId;

      const shouldPauseForSecondaryConfirmation =
        initialBusiness?.onboardingFlow === "website_secondary" &&
        initialBusiness?.isPrimary === false &&
        initialBusiness?.secondaryDetailsConfirmed !== true;

      if (shouldPauseForSecondaryConfirmation) {
        await step.run("mark-awaiting-secondary-confirmation", async () => {
          const { markBusinessOnboardingAwaitingConfirmation } =
            await import("../services/onboarding-state.service");

          await prisma.business.update({
            where: { id: finalBusinessId },
            data: {
              isActive: true,
              isPrimary: false,
              websiteStatus: "pending",
              secondaryDetailsConfirmed: false,
            },
          });

          await markBusinessOnboardingAwaitingConfirmation(prisma, {
            businessId: finalBusinessId,
            correlationId,
          });
        });

        console.log(
          `⏸️ [Website Onboard] Draft ready for confirmation for user ${userId}, business ${finalBusinessId}`,
        );

        return {
          success: true,
          userId,
          businessId: finalBusinessId,
          awaitingConfirmation: true,
        };
      }

      await step.run("activate-business", async () => {
        const { PER_SITE_TRIALS_ENABLED } =
          await import("../config/feature-flags");

        const existingPrimary = await prisma.business.findFirst({
          where: { userId, isPrimary: true },
          select: { id: true },
        });
        const shouldBePrimary = existingPrimary === null;

        const existingWs = PER_SITE_TRIALS_ENABLED
          ? await prisma.websiteSubscription.findUnique({
              where: { businessId: finalBusinessId },
            })
          : null;

        const isTrialSite =
          existingWs != null && existingWs.trialStatus === "trialing";

        const targetStatus: string = isTrialSite ? "trial" : "active";

        await prisma.business.update({
          where: { id: finalBusinessId },
          data: {
            isPrimary: shouldBePrimary,
            isActive: true,
            websiteStatus: targetStatus,
          },
        });
      });

      await step.run("mark-onboarding-completed", async () => {
        const { markBusinessOnboardingCompleted } =
          await import("../services/onboarding-state.service");
        await markBusinessOnboardingCompleted(prisma, {
          businessId: finalBusinessId,
          correlationId,
        });
      });

      await step.run("trigger-keyword-generation", async () => {
        const verifiedBusiness = await prisma.business.findUnique({
          where: { id: finalBusinessId, userId, isActive: true },
          include: { websiteAnalysis: { select: { id: true } } },
        });
        if (!verifiedBusiness || !verifiedBusiness.websiteAnalysis) {
          console.error(
            `❌ [Website Onboard] Business ${finalBusinessId} missing websiteAnalysis, skipping keyword generation`,
          );
          return;
        }
        await prisma.business.update({
          where: { id: finalBusinessId },
          data: {
            keywordGenerationStatus: "pending",
            keywordGenerationStartedAt: null,
            keywordGenerationCompletedAt: null,
          },
        });
        await inngest.send({
          name: "keywords/generate",
          data: { userId, businessId: finalBusinessId },
        });
        console.log(
          `✅ [Website Onboard] Keyword generation triggered for business ${finalBusinessId}`,
        );
      });

      const shouldPlanSocialTopics = await step.run(
        "resolve-secondary-social-entitlement",
        async () => {
          const websiteSubscription =
            await prisma.websiteSubscription.findUnique({
              where: { businessId: finalBusinessId },
              select: { planTier: true },
            });
          return websiteSubscription?.planTier === "SEO_SOCIAL";
        },
      );

      if (shouldPlanSocialTopics) {
        await step.sendEvent("trigger-secondary-social-topic-plan", {
          name: "social/topics.plan.requested",
          data: {
            userId,
            businessId: finalBusinessId,
            source: "INITIAL",
          },
        });
      }

      await step.run("trigger-sitemap-discovery", async () => {
        try {
          await inngest.send({
            name: "sitemap/discover",
            data: {
              userId,
              websiteUrl: normalizedUrl,
              businessId: finalBusinessId,
            },
          });
        } catch (e) {
          console.error(
            `⚠️ [Website Onboard] Failed to trigger sitemap discovery:`,
            e,
          );
        }
      });

      await step.run("send-website-onboarded-email", async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true },
          });
          const business = await prisma.business.findUnique({
            where: { id: finalBusinessId },
            select: { businessName: true, businessWebsiteUrl: true },
          });
          if (user?.email) {
            const { EmailService } = await import("../services/email.service");
            const emailService = new EmailService();
            const totalWebsites = await prisma.business.count({
              where: { userId, isActive: true },
            });
            await emailService.sendWebsiteAddedEmail({
              userName: user.name || "there",
              userEmail: user.email,
              websiteName: business?.businessName || normalizedUrl,
              websiteUrl: business?.businessWebsiteUrl || normalizedUrl,
              totalWebsites,
            });
            console.log(
              `✅ [Website Onboard] Email sent to ${user.email} for new website ${normalizedUrl}`,
            );
          }
        } catch (emailError) {
          console.error(
            `⚠️ [Website Onboard] Failed to send website onboarded email:`,
            emailError,
          );
        }
      });

      console.log(
        `✅ [Website Onboard] Background onboarding completed for user ${userId}, business ${finalBusinessId}`,
      );

      return { success: true, userId, businessId: finalBusinessId };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `❌ [Website Onboard] Failed for user ${userId}, website: ${normalizedUrl}:`,
        error,
      );

      const shouldFallbackToManualConfirmation =
        initialBusiness?.onboardingFlow === "website_secondary" &&
        initialBusiness?.isPrimary === false &&
        initialBusiness?.secondaryDetailsConfirmed !== true;

      if (shouldFallbackToManualConfirmation) {
        await step.run("mark-awaiting-confirmation-after-error", async () => {
          try {
            const {
              markBusinessOnboardingAwaitingConfirmation,
              serializeOnboardingError,
            } = await import("../services/onboarding-state.service");

            await prisma.business.update({
              where: { id: onboardingBusinessId },
              data: {
                websiteStatus: "pending",
                secondaryDetailsConfirmed: false,
              },
            });

            await markBusinessOnboardingAwaitingConfirmation(prisma, {
              businessId: onboardingBusinessId,
              correlationId,
              error: serializeOnboardingError(error, "website_onboard"),
            });
          } catch {
            // business may have been merged/deleted
          }
        });

        console.log(
          `⚠️ [Website Onboard] Falling back to manual confirmation for business ${onboardingBusinessId}`,
        );

        return {
          success: false,
          userId,
          businessId: onboardingBusinessId,
          awaitingConfirmation: true,
          reason,
        };
      }

      await step.run("mark-business-failed", async () => {
        try {
          const { markBusinessOnboardingFailed, serializeOnboardingError } =
            await import("../services/onboarding-state.service");
          await markBusinessOnboardingFailed(prisma, {
            businessId: onboardingBusinessId,
            correlationId,
            error: serializeOnboardingError(error, "website_onboard"),
          });
          await prisma.business.update({
            where: { id: onboardingBusinessId },
            data: { websiteStatus: "failed" },
          });
        } catch {
          // business may have been merged/deleted
        }
      });

      await step.run("compensate-billing", async () => {
        try {
          const failedBusiness = await prisma.business.findUnique({
            where: { id: onboardingBusinessId },
            select: { stripeSubscriptionItemId: true, userId: true },
          });
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
            apiVersion: "2026-03-25.dahlia" as StripeSdk.LatestApiVersion,
          });
          const { compensateWebsiteOnboardFailure } =
            await import("../utils/website-onboard-compensation");
          await compensateWebsiteOnboardFailure({
            prisma,
            stripe,
            businessId: onboardingBusinessId,
            userId,
            stripeSubscriptionItemId:
              failedBusiness?.stripeSubscriptionItemId ?? null,
            decrementWebsiteCount: true,
            markFailed: false,
            correlationId:
              correlationId ?? `website-onboard-fail-${onboardingBusinessId}`,
          });
          console.log(
            `✅ [Website Onboard] Billing compensation completed for failed business ${onboardingBusinessId}`,
          );
        } catch (compError) {
          console.error(
            `⚠️ [Website Onboard] Billing compensation failed for business ${onboardingBusinessId}:`,
            compError,
          );
        }
      });

      throw error;
    }
  },
);

export const websiteFinalizeSecondaryTask = createInngestFunction(
  {
    id: "website-finalize-secondary",
    name: "Finalize Confirmed Secondary Website",
    retries: 2,
    ...onboardingFlowControl("event.data.businessId"),
  },
  { event: "website/finalize-secondary" },
  async ({ event, step }) => {
    const { userId, businessId, websiteUrl, correlationId } = event.data as {
      userId: string;
      businessId: string;
      websiteUrl: string;
      correlationId?: string | null;
    };

    const normalizedUrl = normalizeWebsiteUrl(websiteUrl);

    await step.run("mark-onboarding-running", async () => {
      const { markBusinessOnboardingRunning } = await import(
        "../services/onboarding-state.service"
      );
      await markBusinessOnboardingRunning(prisma, {
        businessId,
        correlationId,
      });
    });

    await step.run("activate-business", async () => {
      const { PER_SITE_TRIALS_ENABLED } = await import("../config/feature-flags");

      const existingPrimary = await prisma.business.findFirst({
        where: { userId, isPrimary: true },
        select: { id: true },
      });
      const shouldBePrimary = existingPrimary === null;

      const existingWs = PER_SITE_TRIALS_ENABLED
        ? await prisma.websiteSubscription.findUnique({
            where: { businessId },
          })
        : null;

      const isTrialSite =
        existingWs != null && existingWs.trialStatus === "trialing";
      const targetStatus: string = isTrialSite ? "trial" : "active";

      await prisma.business.update({
        where: { id: businessId },
        data: {
          isPrimary: shouldBePrimary,
          isActive: true,
          websiteStatus: targetStatus,
        },
      });
    });

    await step.run("mark-onboarding-completed", async () => {
      const { markBusinessOnboardingCompleted } = await import(
        "../services/onboarding-state.service"
      );
      await markBusinessOnboardingCompleted(prisma, {
        businessId,
        correlationId,
      });
    });

    await step.run("trigger-keyword-generation", async () => {
      const verifiedBusiness = await prisma.business.findUnique({
        where: { id: businessId, userId, isActive: true },
        include: { websiteAnalysis: { select: { id: true } } },
      });
      if (!verifiedBusiness || !verifiedBusiness.websiteAnalysis) {
        console.error(
          `❌ [Website Finalize] Business ${businessId} missing websiteAnalysis, skipping keyword generation`,
        );
        return;
      }
      await prisma.business.update({
        where: { id: businessId },
        data: {
          keywordGenerationStatus: "pending",
          keywordGenerationStartedAt: null,
          keywordGenerationCompletedAt: null,
        },
      });
      await inngest.send({
        name: "keywords/generate",
        data: { userId, businessId },
      });
      console.log(
        `✅ [Website Finalize] Keyword generation triggered for business ${businessId}`,
      );
    });

    const shouldPlanSocialTopics = await step.run(
      "resolve-finalized-secondary-social-entitlement",
      async () => {
        const websiteSubscription =
          await prisma.websiteSubscription.findUnique({
            where: { businessId },
            select: { planTier: true },
          });
        return websiteSubscription?.planTier === "SEO_SOCIAL";
      },
    );

    if (shouldPlanSocialTopics) {
      await step.sendEvent("trigger-finalized-secondary-social-topic-plan", {
        name: "social/topics.plan.requested",
        data: {
          userId,
          businessId,
          source: "INITIAL",
        },
      });
    }

    await step.run("trigger-sitemap-discovery", async () => {
      try {
        await inngest.send({
          name: "sitemap/discover",
          data: {
            userId,
            websiteUrl: normalizedUrl,
            businessId,
          },
        });
      } catch (e) {
        console.error(`⚠️ [Website Finalize] Failed to trigger sitemap discovery:`, e);
      }
    });

    await step.run("send-website-onboarded-email", async () => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true, name: true },
        });
        const business = await prisma.business.findUnique({
          where: { id: businessId },
          select: { businessName: true, businessWebsiteUrl: true },
        });
        if (user?.email) {
          const { EmailService } = await import("../services/email.service");
          const emailService = new EmailService();
          const totalWebsites = await prisma.business.count({
            where: { userId, isActive: true },
          });
          await emailService.sendWebsiteAddedEmail({
            userName: user.name || "there",
            userEmail: user.email,
            websiteName: business?.businessName || normalizedUrl,
            websiteUrl: business?.businessWebsiteUrl || normalizedUrl,
            totalWebsites,
          });
        }
      } catch (emailError) {
        console.error(
          `⚠️ [Website Finalize] Failed to send website onboarded email:`,
          emailError,
        );
      }
    });

    return { success: true, userId, businessId };
  },
);

export const dailyBlogSummaryTask = createInngestFunction(
  { id: "daily-blog-summary" },
  { cron: "0 18 * * *" },
  async ({ step }) => {
    return await step.run("send-daily-blog-summaries", async () => {
      try {
        console.log("📧 Starting daily blog summary emails for trial users...");

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const activeTrialUsers = await prisma.user.findMany({
          where: {
            trialStatus: "active",
            trialEndDate: {
              gt: new Date(),
            },
            role: { notIn: [...ROLES_EXCLUDED_FROM_TRIAL_LIFECYCLE_EMAILS] },
          },
          select: {
            id: true,
            email: true,
            name: true,
            trialStartDate: true,
          },
        });

        console.log(
          `📊 Found ${activeTrialUsers.length} active trial users for daily summary`,
        );

        const results = [];

        for (const user of activeTrialUsers) {
          try {
            const blogsGeneratedToday = await prisma.blog.findMany({
              where: {
                userId: user.id,
                createdAt: {
                  gte: yesterday,
                  lt: today,
                },
              },
              select: {
                title: true,
                slug: true,
                excerpt: true,
              },
              orderBy: {
                createdAt: "desc",
              },
            });

            if (blogsGeneratedToday.length > 0) {
              const { sendDailyBlogSummaryEmail } =
                await import("../services/trial-email.service");

              const summaryEmail = (user.email ?? "") as string;
              const userName = (user.name ||
                summaryEmail.split("@")[0]) as string;
              const dateStr = yesterday.toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              });

              await sendDailyBlogSummaryEmail(
                summaryEmail,
                userName,
                blogsGeneratedToday,
                dateStr,
                user.trialStartDate,
              );

              console.log(
                `✅ Daily summary sent to ${user.email} with ${blogsGeneratedToday.length} blogs`,
              );

              results.push({
                userId: user.id,
                email: user.email,
                blogsCount: blogsGeneratedToday.length,
                status: "sent",
              });
            } else {
              console.log(
                `ℹ️ No blogs generated for ${user.email} today, skipping summary`,
              );
              results.push({
                userId: user.id,
                email: user.email,
                blogsCount: 0,
                status: "no_blogs",
              });
            }
          } catch (error: any) {
            console.error(
              `❌ Failed to send daily summary to ${user.email}:`,
              error,
            );
            results.push({
              userId: user.id,
              email: user.email,
              status: "error",
              error: error.message,
            });
          }
        }

        return {
          message: "Daily blog summaries sent",
          totalUsers: activeTrialUsers.length,
          summariesSent: results.filter((r) => r.status === "sent").length,
          results,
        };
      } catch (error: any) {
        console.error("❌ Error in daily blog summary task:", error);
        throw error;
      }
    });
  },
);

const PENDING_WEBSITE_STUCK_THRESHOLD_MS = 60 * 60 * 1000;

export const pendingWebsiteReconcilerTask = createInngestFunction(
  {
    id: "pending-website-reconciler",
    name: "Reconcile Stuck Onboarding Businesses",
    retries: 0,
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    const correlationId = `reconciler-${Date.now()}`;

    const stuck = await step.run("find-stuck-onboarding", async () => {
      const threshold = new Date(
        Date.now() - PENDING_WEBSITE_STUCK_THRESHOLD_MS,
      );
      const list = await prisma.business.findMany({
        where: {
          onboardingStatus: { in: ["queued", "running"] },
          websiteAnalysis: null,
          OR: [
            { onboardingLastAttemptAt: { lt: threshold } },
            {
              onboardingLastAttemptAt: null,
              createdAt: { lt: threshold },
            },
          ],
          isActive: true,
        },
        select: {
          id: true,
          userId: true,
          businessWebsiteUrl: true,
          createdAt: true,
          stripeSubscriptionItemId: true,
          onboardingFlow: true,
          websiteStatus: true,
          isPrimary: true,
          selectedServices: true,
          servicesPriority: true,
          detectedServices: true,
        },
      });
      return list;
    });

    if (stuck.length === 0) {
      return {
        correlationId,
        repaired: 0,
        message: "No stuck onboarding businesses",
      };
    }

    const results: { businessId: string; userId: string; action: string }[] =
      [];

    for (const business of stuck) {
      await step.run(`retry-onboard-${business.id}`, async () => {
        const url = business.businessWebsiteUrl ?? "";
        const createdAtStr = String(business.createdAt ?? "");
        const onboardingFlow =
          business.onboardingFlow ??
          (business.isPrimary && business.websiteStatus === "trial"
            ? "trial_primary"
            : "website_secondary");
        console.log(
          `[Reconciler] correlationId=${correlationId} businessId=${business.id} userId=${business.userId} retrying ${onboardingFlow} onboarding (stuck since ${createdAtStr})`,
        );
        await inngest.send({
          name:
            onboardingFlow === "trial_primary"
              ? "trial/complete-onboarding"
              : "website/onboard",
          data:
            onboardingFlow === "trial_primary"
              ? {
                  userId: business.userId,
                  businessId: business.id,
                  websiteUrl: url,
                  selectedServices: business.selectedServices,
                  servicesPriority: business.servicesPriority,
                  detectedServices: business.detectedServices,
                  quickScrapeBusinessId: null,
                  correlationId,
                }
              : {
                  userId: business.userId,
                  businessId: business.id,
                  websiteUrl: url,
                  correlationId,
                },
        });
        const { markBusinessOnboardingQueued } =
          await import("../services/onboarding-state.service");
        await markBusinessOnboardingQueued(prisma, {
          businessId: business.id,
          flow: onboardingFlow,
          correlationId,
        });
        results.push({
          businessId: business.id,
          userId: business.userId,
          action: "retry_queued",
        });
      });
    }

    console.log(
      `[Reconciler] correlationId=${correlationId} repaired=${results.length} businessIds=${results.map((r) => r.businessId).join(",")}`,
    );
    return { correlationId, repaired: results.length, results };
  },
);

export const websiteRemovalRetryTask = createInngestFunction(
  {
    id: "website-removal-retry",
    name: "Retry Pending Website Billing Removal",
    retries: 0,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    if (!isBackgroundAutomationEnabled("WEBSITE_REMOVAL_RETRY_CRON_ENABLED")) {
      return { skipped: true, reason: "website_removal_retry_disabled" };
    }
    return step.run("process-website-removal-retries", async () => {
      const { processWebsiteRemovalRetryBatch } = await import(
        "../services/website-removal.service"
      );
      return processWebsiteRemovalRetryBatch({ limit: 20 });
    });
  },
);

export const siteIntegrityCheckTask = createInngestFunction(
  {
    id: "site-integrity-check",
    retries: 0,
  },
  { cron: "0 1 * * *" },
  async ({ step }) => {
    return await step.run("check-integrity", async () => {
      const { PER_SITE_TRIALS_ENABLED } =
        await import("../config/feature-flags");

      const now = new Date();

      const businessesWithoutSubscription = await prisma.business.findMany({
        where: {
          isActive: true,
          websiteStatus: { in: ["active", "trial"] },
          websiteSubscription: null,
        },
        select: {
          id: true,
          userId: true,
          businessName: true,
          businessWebsiteUrl: true,
          websiteStatus: true,
        },
      });

      const expiredTrialingSubscriptions = PER_SITE_TRIALS_ENABLED
        ? await prisma.websiteSubscription.findMany({
            where: {
              trialStatus: "trialing",
              trialEndDate: { lte: now },
            },
            include: {
              business: {
                select: {
                  id: true,
                  userId: true,
                  businessName: true,
                  businessWebsiteUrl: true,
                  websiteStatus: true,
                },
              },
            },
          })
        : [];

      for (const business of businessesWithoutSubscription) {
        console.warn(
          `[Site Integrity] Business ${business.id} (${business.businessName}) has isActive=true and websiteStatus=${business.websiteStatus} but no websiteSubscription`,
        );
      }

      if (PER_SITE_TRIALS_ENABLED) {
        for (const subscription of expiredTrialingSubscriptions) {
          console.warn(
            `[Site Integrity] WebsiteSubscription ${subscription.id} for business ${subscription.businessId} (${subscription.business.businessName}) has trialStatus=trialing but trialEndDate (${subscription.trialEndDate}) <= now`,
          );
        }
      }

      return {
        businessesWithoutSubscriptionCount:
          businessesWithoutSubscription.length,
        expiredTrialingSubscriptionsCount: expiredTrialingSubscriptions.length,
        businessesWithoutSubscription: businessesWithoutSubscription.map(
          (b) => ({
            id: b.id,
            userId: b.userId,
            businessName: b.businessName,
            businessWebsiteUrl: b.businessWebsiteUrl,
            websiteStatus: b.websiteStatus,
          }),
        ),
        expiredTrialingSubscriptions: expiredTrialingSubscriptions.map((s) => ({
          id: s.id,
          businessId: s.businessId,
          trialEndDate: s.trialEndDate,
          businessName: s.business.businessName,
          businessWebsiteUrl: s.business.businessWebsiteUrl,
          websiteStatus: s.business.websiteStatus,
        })),
      };
    });
  },
);

export const autoReplyGMBReviewsTask = createInngestFunction(
  {
    id: "auto-reply-gmb-reviews",
    name: "Auto-Reply to Unresponded GMB Reviews",
    retries: 2,
  },
  { cron: "0 */4 * * *" },
  async ({ step }) => {
    return await step.run("auto-reply-gmb-reviews", async () => {
      const automationState = getBackgroundAutomationState(
        "GMB_REVIEW_REPLY_CRON_ENABLED",
      );
      if (!automationState.enabled) {
        return {
          skipped: true,
          reason: "gmb_review_reply_cron_disabled",
          automationState,
        };
      }

      try {
        console.log("💬 Starting auto-reply for unresponded GMB reviews...");

        const { GoogleMyBusinessService } =
          await import("../services/google-my-business.service");
        const { EmailService } = await import("../services/email.service");
        const gmbService = new GoogleMyBusinessService();
        const emailService = new EmailService();

        const gmbConnections = await prisma.googleMyBusiness.findMany({
          where: {
            isActive: true,
            reviewReplyMode: "auto_publish",
            accountId: { not: null },
            locationId: { not: null },
          },
          select: {
            businessId: true,
            businessName: true,
          },
        });

        if (gmbConnections.length === 0) {
          console.log("📝 No active GMB connections found");
          return { message: "No active GMB connections", count: 0 };
        }

        console.log(
          `📊 Found ${gmbConnections.length} active GMB connections to check`,
        );

        type AutoReplyResult = {
          businessId: string;
          businessName: string | null;
          synced: number;
          replied: number;
          skipped: number;
          failed: number;
          error?: string;
        };

        const results: AutoReplyResult[] = [];

        for (const connection of gmbConnections) {
          try {
            const result = await gmbService.syncAndAutoReplyReviews(
              connection.businessId,
            );

            const replied = result.autoReplyResults?.repliedCount ?? 0;

            results.push({
              businessId: connection.businessId,
              businessName: connection.businessName,
              synced: result.syncedCount,
              replied,
              skipped: result.autoReplyResults?.skippedCount ?? 0,
              failed: result.autoReplyResults?.failedCount ?? 0,
            });

            if (replied > 0) {
              console.log(
                `✅ Auto-replied to ${replied} reviews for ${connection.businessName}`,
              );

              try {
                const business = await prisma.business.findUnique({
                  where: { id: connection.businessId },
                  select: { businessName: true, userId: true },
                });

                if (business?.userId) {
                  const user = await prisma.user.findUnique({
                    where: { id: business.userId },
                    select: { email: true, name: true },
                  });

                  if (user?.email) {
                    const successfulReviewIds =
                      result.autoReplyResults?.results
                        .filter((r) => r.success && r.status === "posted")
                        .map((r) => r.reviewId) ?? [];

                    const repliedReviews =
                      successfulReviewIds.length > 0
                        ? await prisma.gMBReview.findMany({
                            where: {
                              reviewId: { in: successfulReviewIds },
                            },
                            take: 5,
                            select: {
                              reviewerName: true,
                              rating: true,
                              response: true,
                            },
                          })
                        : [];

                    const replyDetails = repliedReviews.map((r) => ({
                      reviewerName: r.reviewerName,
                      rating: r.rating,
                      replySnippet:
                        (r.response?.length ?? 0) > 100
                          ? r.response!.substring(0, 100) + "..."
                          : r.response || "",
                    }));

                    await emailService.sendGMBReviewReplyEmail({
                      userName: user.name || "there",
                      userEmail: user.email,
                      businessName:
                        business.businessName ||
                        connection.businessName ||
                        "Your Business",
                      totalRepliesPosted: replied,
                      replies: replyDetails,
                    });
                    console.log(
                      `📧 Sent review reply notification to ${user.email} for ${connection.businessName}`,
                    );
                  }
                }
              } catch (emailError) {
                console.error(
                  `⚠️ Failed to send review reply email for ${connection.businessName}:`,
                  emailError,
                );
              }
            }
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown error";
            console.error(
              `❌ Failed to process reviews for ${connection.businessName}:`,
              error,
            );
            results.push({
              businessId: connection.businessId,
              businessName: connection.businessName,
              synced: 0,
              replied: 0,
              skipped: 0,
              failed: 0,
              error: errorMessage,
            });
          }
        }

        const totalReplied = results.reduce((sum, r) => sum + r.replied, 0);
        const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
        const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

        console.log(
          `📊 GMB auto-reply complete: ${totalReplied} replied, ${totalSkipped} skipped, ${totalFailed} failed across ${gmbConnections.length} businesses`,
        );

        return {
          message: "GMB auto-reply complete",
          totalBusinesses: gmbConnections.length,
          totalReplied,
          totalSkipped,
          totalFailed,
          results,
        };
      } catch (error) {
        console.error("❌ Error in auto-reply GMB reviews:", error);
        throw error;
      }
    });
  },
);

export const autoGenerateGMBAIRepliesTask = createInngestFunction(
  {
    id: "auto-generate-gmb-ai-replies",
    name: "Auto-Generate & Post AI Replies for Unresponded GMB Reviews",
    retries: 2,
  },
  { cron: "30 */6 * * *" },
  async ({ step }) => {
    return await step.run("generate-and-post-ai-replies-batch", async () => {
      const automationState = getBackgroundAutomationState(
        "GMB_REVIEW_REPLY_CRON_ENABLED",
      );
      if (!automationState.enabled) {
        return {
          skipped: true,
          reason: "gmb_review_reply_cron_disabled",
          automationState,
        };
      }

      try {
        console.log(
          "🤖 Starting auto-generate & post AI replies for unresponded reviews...",
        );

        const { gmbAIService } = await import("../services/gmb-ai.service");
        const { GoogleMyBusinessService } =
          await import("../services/google-my-business.service");
        const { EmailService } = await import("../services/email.service");
        const gmbService = new GoogleMyBusinessService();
        const emailService = new EmailService();

        const gmbConnections = await prisma.googleMyBusiness.findMany({
          where: {
            isActive: true,
            reviewReplyMode: "auto_publish",
            accountId: { not: null },
            locationId: { not: null },
          },
          select: {
            id: true,
            businessId: true,
            businessName: true,
          },
        });

        if (gmbConnections.length === 0) {
          console.log("📝 No active GMB connections found");
          return {
            message: "No active GMB connections",
            generated: 0,
            posted: 0,
          };
        }

        type PostedReplyDetail = {
          reviewerName: string;
          rating: number;
          replySnippet: string;
        };

        type BusinessSummary = {
          businessId: string;
          businessName: string | null;
          generated: number;
          postedFromNew: number;
          postedFromPending: number;
          skippedAlreadyReplied: number;
          failed: number;
          postedReplies: PostedReplyDetail[];
        };

        const summaries: BusinessSummary[] = [];
        const BATCH_SIZE = 10;

        for (const connection of gmbConnections) {
          try {
            const business = await prisma.business.findUnique({
              where: { id: connection.businessId },
              select: { businessName: true, businessType: true, userId: true },
            });

            if (!business) {
              console.warn(
                `⚠️ Business not found for GMB ${connection.businessName}, skipping`,
              );
              continue;
            }

            let generated = 0;
            let postedFromNew = 0;
            let postedFromPending = 0;
            let skippedAlreadyReplied = 0;
            let failed = 0;
            const postedReplies: PostedReplyDetail[] = [];

            const reviewsNeedingAI = await prisma.gMBReview.findMany({
              where: {
                gmbId: connection.id,
                reviewDate: { gte: getGmbReviewWindowStart() },
                isResponded: false,
                aiResponse: null,
              },
              select: {
                id: true,
                reviewId: true,
                reviewerName: true,
                rating: true,
                comment: true,
              },
            });

            if (reviewsNeedingAI.length > 0) {
              console.log(
                `🤖 Generating & posting AI replies for ${reviewsNeedingAI.length} new reviews for ${connection.businessName}`,
              );

              for (let i = 0; i < reviewsNeedingAI.length; i += BATCH_SIZE) {
                const batch = reviewsNeedingAI.slice(i, i + BATCH_SIZE);

                for (const review of batch) {
                  try {
                    const aiResult = await gmbAIService.generateReviewResponse({
                      reviewerName: review.reviewerName,
                      rating: review.rating,
                      comment: review.comment,
                      businessName: business.businessName,
                      businessType: business.businessType || undefined,
                      reviewId: review.reviewId,
                    });
                    generated++;

                    try {
                      const replyResult = await gmbService.respondToReview(
                        connection.businessId,
                        review.reviewId,
                        aiResult.response,
                      );
                      if (replyResult.status === "posted") {
                        postedFromNew++;
                        postedReplies.push({
                          reviewerName: review.reviewerName,
                          rating: review.rating,
                          replySnippet:
                            aiResult.response.length > 100
                              ? aiResult.response.substring(0, 100) + "..."
                              : aiResult.response,
                        });
                        console.log(
                          `✅ Generated & posted reply for review ${review.reviewId} (rating: ${review.rating}, intent: ${aiResult.intent})`,
                        );
                      } else {
                        skippedAlreadyReplied++;
                        console.log(
                          `ℹ️ Skipped posting AI reply for review ${review.reviewId} because the review already has a reply`,
                        );
                      }
                    } catch (postError) {
                      failed++;
                      console.error(
                        `⚠️ Generated AI reply but failed to post for review ${review.reviewId}:`,
                        postError,
                      );
                    }
                  } catch (genError) {
                    failed++;
                    console.error(
                      `❌ Failed to generate AI reply for review ${review.reviewId}:`,
                      genError,
                    );
                  }
                }
              }
            }

            const pendingReviews = await prisma.gMBReview.findMany({
              where: {
                gmbId: connection.id,
                reviewDate: { gte: getGmbReviewWindowStart() },
                isResponded: false,
                aiResponse: { isNot: null },
              },
              select: {
                id: true,
                reviewId: true,
                reviewerName: true,
                rating: true,
                aiResponse: {
                  select: { response: true },
                },
              },
            });

            if (pendingReviews.length > 0) {
              console.log(
                `📤 Auto-posting ${pendingReviews.length} pending AI replies for ${connection.businessName}`,
              );

              for (let i = 0; i < pendingReviews.length; i += BATCH_SIZE) {
                const batch = pendingReviews.slice(i, i + BATCH_SIZE);

                for (const review of batch) {
                  if (!review.aiResponse?.response) continue;

                  try {
                    const replyResult = await gmbService.respondToReview(
                      connection.businessId,
                      review.reviewId,
                      review.aiResponse.response,
                    );
                    if (replyResult.status === "posted") {
                      postedFromPending++;
                      postedReplies.push({
                        reviewerName: review.reviewerName,
                        rating: review.rating,
                        replySnippet:
                          review.aiResponse.response.length > 100
                            ? review.aiResponse.response.substring(0, 100) +
                              "..."
                            : review.aiResponse.response,
                      });
                      console.log(
                        `✅ Posted pending AI reply for review ${review.reviewId}`,
                      );
                    } else {
                      skippedAlreadyReplied++;
                      console.log(
                        `ℹ️ Pending AI reply skipped for review ${review.reviewId} because a reply already exists`,
                      );
                    }
                  } catch (postError) {
                    failed++;
                    console.error(
                      `❌ Failed to post pending AI reply for review ${review.reviewId}:`,
                      postError,
                    );
                  }
                }
              }
            }

            const totalPostedForBusiness = postedFromNew + postedFromPending;

            summaries.push({
              businessId: connection.businessId,
              businessName: connection.businessName,
              generated,
              postedFromNew,
              postedFromPending,
              skippedAlreadyReplied,
              failed,
              postedReplies,
            });

            if (totalPostedForBusiness > 0 && business.userId) {
              try {
                const user = await prisma.user.findUnique({
                  where: { id: business.userId },
                  select: { email: true, name: true },
                });

                if (user?.email) {
                  await emailService.sendGMBReviewReplyEmail({
                    userName: user.name || "there",
                    userEmail: user.email,
                    businessName: business.businessName,
                    totalRepliesPosted: totalPostedForBusiness,
                    replies: postedReplies.slice(0, 5),
                  });
                  console.log(
                    `📧 Sent review reply notification to ${user.email} for ${business.businessName}`,
                  );
                }
              } catch (emailError) {
                console.error(
                  `⚠️ Failed to send review reply email for ${connection.businessName}:`,
                  emailError,
                );
              }
            }

            console.log(
              `✅ ${connection.businessName}: Generated ${generated}, Posted (new: ${postedFromNew}, pending: ${postedFromPending}), Skipped ${skippedAlreadyReplied}, Failed ${failed}`,
            );
          } catch (error) {
            console.error(
              `❌ Failed to process AI replies for ${connection.businessName}:`,
              error,
            );
            summaries.push({
              businessId: connection.businessId,
              businessName: connection.businessName,
              generated: 0,
              postedFromNew: 0,
              postedFromPending: 0,
              skippedAlreadyReplied: 0,
              failed: 0,
              postedReplies: [],
            });
          }
        }

        const totalGenerated = summaries.reduce(
          (sum, s) => sum + s.generated,
          0,
        );
        const totalPosted = summaries.reduce(
          (sum, s) => sum + s.postedFromNew + s.postedFromPending,
          0,
        );
        const totalSkipped = summaries.reduce(
          (sum, s) => sum + s.skippedAlreadyReplied,
          0,
        );
        const totalFailed = summaries.reduce((sum, s) => sum + s.failed, 0);

        console.log(
          `📊 AI reply auto-generate & post complete: ${totalGenerated} generated, ${totalPosted} posted, ${totalSkipped} skipped, ${totalFailed} failed across ${gmbConnections.length} businesses`,
        );

        return {
          message: "AI reply auto-generate & post complete",
          totalBusinesses: gmbConnections.length,
          totalGenerated,
          totalPosted,
          totalSkipped,
          totalFailed,
          summaries,
        };
      } catch (error) {
        console.error("❌ Error in auto-generate & post AI replies:", error);
        throw error;
      }
    });
  },
);

export const autoGMBPostFromBlogTask = createInngestFunction(
  {
    id: "auto-gmb-post-from-blog",
    name: "Auto-Post to GMB from Blog",
    retries: 2,
    singleton: {
      key: "event.data.blogId",
      mode: "skip",
    },
  },
  { event: "gmb/auto-post-from-blog" },
  async ({ event, step }) => {
    if (!isBackgroundAutomationEnabled("GMB_AUTO_POST_FROM_BLOG_ENABLED")) {
      console.log(
        "⏭️ Skipping blog-to-GMB auto-post: GMB_AUTO_POST_FROM_BLOG_ENABLED is not enabled for this runtime.",
      );
      return {
        success: false,
        skipped: true,
        reason: "gmb_auto_post_from_blog_disabled",
        runtimeEnvironment: getRuntimeEnvironment(),
      };
    }

    const { blogId, businessId } = event.data;

    const gmbConnection = await step.run("check-gmb-connection", async () => {
      const gmb = await prisma.googleMyBusiness.findUnique({
        where: { businessId },
        select: {
          id: true,
          accountId: true,
          locationId: true,
          isActive: true,
          postAutomationMode: true,
          businessName: true,
        },
      });

      if (
        !gmb ||
        !gmb.isActive ||
        gmb.postAutomationMode !== "auto_publish" ||
        !gmb.accountId ||
        !gmb.locationId
      ) {
        return null;
      }

      return gmb;
    });

    if (!gmbConnection) {
      console.log(
        `ℹ️ No active GMB connection or GMB auto-post is disabled for business ${businessId}, skipping auto-post`,
      );
      return {
        success: false,
        message: "No active GMB connection or GMB auto-post is disabled",
      };
    }

    const existingPost = await step.run("check-duplicate-post", async () => {
      const existing = await prisma.gMBPostSuggestion.findFirst({
        where: {
          blogId,
          businessId,
          status: { in: ["PUBLISHED", "SCHEDULED", "PENDING"] },
        },
        select: { id: true, status: true },
      });
      return existing;
    });

    if (existingPost) {
      console.log(
        `ℹ️ GMB post already exists for blog ${blogId} (status: ${existingPost.status}), skipping duplicate`,
      );
      return {
        success: false,
        message: "GMB post already exists for this blog",
        existingPostId: existingPost.id,
      };
    }

    const blogData = await step.run("fetch-blog-data", async () => {
      const blog = await prisma.blog.findUnique({
        where: { id: blogId },
        select: {
          id: true,
          userId: true,
          title: true,
          excerpt: true,
          categories: true,
          tags: true,
          slug: true,
          blogPublishDate: true,
          blogPublishTime: true,
          business: {
            select: {
              defaultLocale: true,
              businessCountry: true,
              businessState: true,
              businessCity: true,
            },
          },
        },
      });

      return blog;
    });

    if (!blogData) {
      return { success: false, message: "Blog not found" };
    }

    const dueEvaluation = evaluateScheduleDue({
      publishDate: blogData.blogPublishDate,
      publishTime: blogData.blogPublishTime,
      defaultLocale: blogData.business.defaultLocale,
      businessCountry: blogData.business.businessCountry,
      businessState: blogData.business.businessState,
      businessCity: blogData.business.businessCity,
    });

    if (!dueEvaluation.isDue) {
      console.log(
        `⏳ Skipping GMB auto-post for blog ${blogId}; not due until ${blogData.blogPublishDate} ${blogData.blogPublishTime} (${dueEvaluation.timeZone}; local now ${dueEvaluation.date} ${dueEvaluation.time})`,
      );
      return {
        success: false,
        deferred: true,
        message: "Blog is not due for GMB auto-post yet",
      };
    }

    const postContent = await step.run("generate-gmb-post", async () => {
      const { gmbAIService } = await import("../services/gmb-ai.service");
      const { createGPT56LunaModel } = await import("../config/llm.config");
      const { SystemMessage, HumanMessage } =
        await import("@langchain/core/messages");

      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: {
          businessName: true,
          businessType: true,
          businessWebsiteUrl: true,
        },
      });

      if (!business) {
        throw new Error("Business not found");
      }

      const previousPosts = await prisma.gMBPost.findMany({
        where: {
          googleMyBusiness: { businessId },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          summary: true,
          callToAction: true,
          postType: true,
        },
      });

      const hasPreviousPosts = previousPosts.length > 0;
      const previousPostsContext = hasPreviousPosts
        ? `\n\nMatch the tone and style of these previous posts:\n${JSON.stringify(
            previousPosts.map((p) => ({
              content: p.summary,
              type: p.postType,
              cta: p.callToAction,
            })),
            null,
            2,
          )}`
        : "";

      const llm = createGPT56LunaModel();

      const systemPrompt = `You are a social media content strategist. Create exactly ONE Google My Business post from the provided blog content.

The post must:
- Summarize key points in a compelling, social-media-friendly format
- Be between 100-300 characters for optimal engagement
- Include a destination URL on the business website when there is an obvious landing page, otherwise use an empty string
- Use only supported internal post types:
  - UPDATE for general updates and educational recaps
  - PRODUCT for product or service highlights
${hasPreviousPosts ? "- MATCH the tone and style of the previous posts provided" : ""}

Return a JSON object (NOT an array) with:
- postType: "UPDATE" or "PRODUCT"
- title: short attention-grabbing title (max 50 chars)
- summary: post content (100-300 chars)
- callToAction: absolute destination URL on the business website, or empty string if no destination URL is obvious

Return ONLY valid JSON, no other text.`;

      const userPrompt = `Create ONE GMB post for "${business.businessName}" (${business.businessType}) based on this blog.

Business website URL: ${business.businessWebsiteUrl || "Not available"}

Title: ${blogData.title}
Excerpt: ${blogData.excerpt || ""}
Categories: ${blogData.categories || ""}
Tags: ${blogData.tags || ""}
${previousPostsContext}`;

      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const { recordLlmUsageFromLangChainMessage } =
        await import("../services/llm-usage.service");
      const { LLM_MODELS } = await import("../config/llm.config");
      void recordLlmUsageFromLangChainMessage(response, {
        purpose: "gmb_post",
        provider: "openai",
        userId: blogData.userId,
        businessId,
        blogId: blogData.id,
        modelFallback: LLM_MODELS.GPT56_LUNA,
      });

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse LLM response for GMB post");
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        postType: string;
        title: string;
        summary: string;
        callToAction: string;
      };

      return {
        postType: parsed.postType || "UPDATE",
        title: parsed.title,
        summary: parsed.summary,
        callToAction: parsed.callToAction || business.businessWebsiteUrl || "",
        businessName: business.businessName,
        businessType: business.businessType,
      };
    });

    const imageUrl = await step.run("generate-image", async () => {
      try {
        const { imageGenerationService } =
          await import("../services/image-generation.service");

        const result = await imageGenerationService.generateGMBPostImage(
          postContent.businessName,
          postContent.title,
          postContent.postType,
          postContent.businessType || undefined,
          postContent.summary || undefined,
        );

        if (result.success && result.imageUrl) {
          return result.imageUrl;
        }

        return null;
      } catch (error) {
        console.warn("[GMB Auto-Post] Image generation failed:", error);
        return null;
      }
    });

    const publishResult = await step.run("publish-to-google", async () => {
      const { GoogleMyBusinessService } =
        await import("../services/google-my-business.service");
      const gmbService = new GoogleMyBusinessService();

      const mediaUrls: string[] = imageUrl ? [imageUrl] : [];

      const post = await gmbService.createPost(businessId, {
        postType: postContent.postType as
          | "UPDATE"
          | "EVENT"
          | "OFFER"
          | "PRODUCT",
        summary: postContent.summary,
        callToAction: postContent.callToAction,
        mediaUrls,
        title: postContent.title,
      });

      await prisma.gMBPostSuggestion.create({
        data: {
          businessId,
          blogId,
          postType: postContent.postType,
          title: postContent.title,
          summary: postContent.summary,
          callToAction: postContent.callToAction,
          mediaUrls,
          status: "PUBLISHED",
          publishedAt: new Date(),
          gmbPostId: post.id || null,
          generatedAt: new Date(),
          expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        },
      });

      return { postId: post.id, success: true };
    });

    console.log(
      `✅ Auto-posted to GMB for blog "${blogData.title}" (business: ${gmbConnection.businessName})`,
    );

    return {
      success: true,
      message: "GMB post published from blog",
      blogTitle: blogData.title,
      postId: publishResult.postId,
    };
  },
);

export const signupAuditEmailTask = createInngestFunction(
  {
    id: "signup-audit-email",
    name: "Run Signup Website Audit and Send Issue Emails",
    retries: 1,
  },
  { event: "signup-audit/run-and-email" },
  async ({ event, step }) => {
    const { userId, businessId, correlationId } = event.data as {
      userId: string;
      businessId: string;
      correlationId?: string | null;
    };

    let runId: string | null = null;

    try {
      const claim = await step.run("claim-signup-audit-email", async () => {
        const existingLog = await prisma.signupAuditEmailLog.findUnique({
          where: { businessId },
          select: {
            id: true,
            status: true,
            issueCount: true,
            internalEmailCount: true,
          },
        });

        if (
          existingLog &&
          ["running", "completed", "skipped"].includes(existingLog.status)
        ) {
          return {
            skip: true as const,
            status: existingLog.status,
            issueCount: existingLog.issueCount,
            internalEmailCount: existingLog.internalEmailCount,
          };
        }

        const [user, business] = await Promise.all([
          prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true },
          }),
          prisma.business.findFirst({
            where: { id: businessId, userId, isActive: true },
            select: {
              id: true,
              businessName: true,
              businessWebsiteUrl: true,
            },
          }),
        ]);

        if (!user?.email) {
          throw new NonRetriableError(
            `Cannot run signup audit email: user ${userId} missing email`,
          );
        }

        if (!business?.businessWebsiteUrl) {
          throw new NonRetriableError(
            `Cannot run signup audit email: business ${businessId} missing website URL`,
          );
        }

        const auditRun = await prisma.seoAuditRun.create({
          data: {
            userId,
            businessId,
            status: "pending",
            modulesRequested: [
              "technical",
              "schema",
              "geo",
              "sitemap",
              "hreflang",
              "competitorPages",
              "plan",
            ],
            progress: 0,
          },
        });

        await prisma.signupAuditEmailLog.upsert({
          where: { businessId },
          create: {
            userId,
            businessId,
            seoAuditRunId: auditRun.id,
            status: "running",
          },
          update: {
            seoAuditRunId: auditRun.id,
            status: "running",
            issueCount: 0,
            internalEmailCount: 0,
            prospectEmailId: null,
            lastError: null,
            completedAt: null,
          },
        });

        return {
          skip: false as const,
          runId: auditRun.id,
          user,
          business,
        };
      });

      if (claim.skip) {
        console.log(
          `⏭️ [Signup Audit] Skipped business ${businessId}; log status already ${claim.status}`,
        );
        return {
          success: true,
          skipped: true,
          businessId,
          status: claim.status,
          issueCount: claim.issueCount,
          internalEmailCount: claim.internalEmailCount,
        };
      }

      runId = claim.runId;

      return await step.run("run-audit-and-send-emails", async () => {
        const { runCompleteAudit } = await import("../services/seo-audit.service");
        const {
          extractSignupAuditIssues,
          sendSignupAuditInternalIssueEmail,
          sendSignupAuditProspectEmail,
        } = await import("../services/signup-audit-email.service");

        const modules = [
          "technical",
          "schema",
          "geo",
          "sitemap",
          "hreflang",
          "competitorPages",
          "plan",
        ] as import("../validators/seo-audit.validation").SeoAuditModule[];

        await prisma.seoAuditRun.update({
          where: { id: claim.runId },
          data: {
            status: "running",
            currentModule: "crawling",
            progress: 5,
          },
        });

        const startTime = Date.now();
        const report = await runCompleteAudit(
          claim.business.businessWebsiteUrl,
          claim.business.businessName,
          modules,
          async (currentModule: string, progress: number) => {
            await prisma.seoAuditRun.update({
              where: { id: claim.runId },
              data: { currentModule, progress },
            });
          },
          {
            userId,
            businessId,
            seoAuditRunId: claim.runId,
          },
        );

        const runtimeMs = Date.now() - startTime;
        await prisma.seoAuditRun.update({
          where: { id: claim.runId },
          data: {
            status: "completed",
            completedAt: new Date(),
            report: report as any,
            summaryScore: report.overallScore,
            currentModule: null,
            progress: 100,
            modelUsed: report.modelUsed ?? null,
            tokenUsage:
              typeof report.tokenUsage === "number" ? report.tokenUsage : null,
            runtimeMs,
          },
        });

        const issues = extractSignupAuditIssues(report);

        if (issues.length === 0) {
          await prisma.signupAuditEmailLog.update({
            where: { businessId },
            data: {
              status: "skipped",
              issueCount: 0,
              internalEmailCount: 0,
              lastError: null,
              completedAt: new Date(),
            },
          });

          console.log(
            `✅ [Signup Audit] No actionable warning/critical issues found for business ${businessId}`,
          );

          return {
            success: true,
            skipped: true,
            reason: "no_actionable_issues",
            businessId,
            runId: claim.runId,
            issueCount: 0,
            internalEmailCount: 0,
          };
        }

        const prospectResult = await sendSignupAuditProspectEmail({
          userName: claim.user.name || "there",
          userEmail: claim.user.email,
          businessName: claim.business.businessName,
          websiteUrl: claim.business.businessWebsiteUrl,
          overallScore: report.overallScore,
          issues,
        });

        if (!prospectResult.success) {
          throw new Error(
            prospectResult.error || "Failed to send signup audit prospect email",
          );
        }

        let internalEmailCount = 0;
        const internalErrors: string[] = [];

        for (const [index, issue] of issues.entries()) {
          const result = await sendSignupAuditInternalIssueEmail({
            userName: claim.user.name || "there",
            userEmail: claim.user.email,
            businessName: claim.business.businessName,
            websiteUrl: claim.business.businessWebsiteUrl,
            overallScore: report.overallScore,
            issue,
            issueIndex: index,
            issueCount: issues.length,
          });

          if (result.success) {
            internalEmailCount += 1;
          } else {
            internalErrors.push(
              result.error || `Issue ${index + 1} internal email failed`,
            );
          }
        }

        await prisma.signupAuditEmailLog.update({
          where: { businessId },
          data: {
            status: "completed",
            issueCount: issues.length,
            internalEmailCount,
            prospectEmailId: prospectResult.emailId ?? null,
            lastError: internalErrors.length > 0 ? internalErrors.join("; ") : null,
            completedAt: new Date(),
          },
        });

        console.log(
          `✅ [Signup Audit] Sent prospect audit email and ${internalEmailCount}/${issues.length} internal issue alerts for business ${businessId}`,
        );

        return {
          success: true,
          businessId,
          runId: claim.runId,
          issueCount: issues.length,
          internalEmailCount,
          internalErrors: internalErrors.length,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await step.run("mark-signup-audit-email-failed", async () => {
        if (runId) {
          await prisma.seoAuditRun
            .update({
              where: { id: runId },
              data: {
                status: "failed",
                error: message,
                completedAt: new Date(),
                currentModule: null,
              },
            })
            .catch(() => undefined);
        }

        await prisma.signupAuditEmailLog
          .upsert({
            where: { businessId },
            create: {
              userId,
              businessId,
              seoAuditRunId: runId,
              status: "failed",
              lastError: message,
              completedAt: new Date(),
            },
            update: {
              status: "failed",
              lastError: message,
              completedAt: new Date(),
            },
          })
          .catch(() => undefined);
      });

      console.error(
        `❌ [Signup Audit] Failed for business ${businessId}:`,
        error,
      );
      throw error;
    }
  },
);

export const runCompleteSeoAuditTask = createInngestFunction(
  {
    id: "seo-audit-run-complete",
    name: "Run Complete SEO Audit",
    retries: 1,
  },
  { event: "seo-audit/run-complete" },
  async ({ event, step }) => {
    const { runId, userId, businessId, websiteUrl, businessName, modules } =
      event.data as {
        runId: string;
        userId: string;
        businessId: string;
        websiteUrl: string;
        businessName: string;
        modules: string[];
      };

    const startTime = Date.now();

    await step.run("mark-running", async () => {
      await prisma.seoAuditRun.update({
        where: { id: runId },
        data: { status: "running", currentModule: "crawling", progress: 5 },
      });
    });

    try {
      const executionResult = await step.run("execute-audit", async () => {
        const { runCompleteAudit } =
          await import("../services/seo-audit.service");

        const report = await runCompleteAudit(
          websiteUrl,
          businessName,
          modules as import("../validators/seo-audit.validation").SeoAuditModule[],
          async (currentModule: string, progress: number) => {
            await prisma.seoAuditRun.update({
              where: { id: runId },
              data: { currentModule, progress },
            });
          },
          {
            userId,
            businessId,
            seoAuditRunId: runId,
          },
        );

        const runtimeMs = Date.now() - startTime;
        await prisma.seoAuditRun.update({
          where: { id: runId },
          data: {
            status: "completed",
            completedAt: new Date(),
            report: report as any,
            summaryScore: report.overallScore,
            currentModule: null,
            progress: 100,
            modelUsed: report.modelUsed ?? null,
            tokenUsage:
              typeof report.tokenUsage === "number" ? report.tokenUsage : null,
            runtimeMs,
          },
        });

        return {
          overallScore: report.overallScore,
          modulesCompleted: report.modules.length,
          runtimeMs,
        };
      });

      console.log(
        `✅ [SEO Audit] Completed for business ${businessId}, score: ${executionResult.overallScore}, runtime: ${executionResult.runtimeMs}ms`,
      );

      return {
        success: true,
        runId,
        overallScore: executionResult.overallScore,
        modulesCompleted: executionResult.modulesCompleted,
        runtimeMs: executionResult.runtimeMs,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const details =
        err instanceof Error && err.stack
          ? `${err.message}\n${err.stack}`
          : message;
      console.error(`❌ [SEO Audit] Failed for run ${runId}:`, err);

      await step.run("mark-failed", async () => {
        await prisma.seoAuditRun.update({
          where: { id: runId },
          data: {
            status: "failed",
            completedAt: new Date(),
            currentModule: null,
            error: details.slice(0, 2000),
            runtimeMs: Date.now() - startTime,
          },
        });
      });

      return { success: false, runId, error: message };
    }
  },
);

// ===== DR Growth Engine Inngest Functions =====

/**
 * Phase 1: Optimize published blog content for link-worthiness.
 * Triggered after a blog is successfully auto-published.
 */
export const drOptimizeContentTask = createInngestFunction(
  {
    id: "dr-optimize-content-for-links",
    retries: 3,
  },
  { event: "dr/optimize-content" },
  async ({ event, step }: any) => {
    const { blogId, businessId } = event.data;

    return await step.run("optimize-content-for-links", async () => {
      const { optimizeBlogForLinks } = await import(
        "../services/dr-content-optimization.service"
      );
      const result = await optimizeBlogForLinks({ blogId, businessId });
      console.log(
        `[DR] Content optimization for blog ${blogId}: ${result.success ? "success" : "failed"} (strategy: ${result.drRangeStrategy}, sections: ${result.addedSections.join(", ")})`,
      );
      return result;
    });
  },
);

/**
 * Phase 2: Weekly publisher discovery for guest post outreach.
 * Runs on a weekly cron to find new publishers and queue campaigns.
 */
export const drDiscoverPublishersTask = createInngestFunction(
  {
    id: "dr-discover-publishers-weekly",
    retries: 3,
  },
  { cron: "0 9 * * 1" }, // Every Monday at 9am
  async ({ step }: any) => {
    return await step.run("discover-publishers", async () => {
      const { discoverAndQueuePublishers } = await import(
        "../services/dr-outreach.service"
      );

      // Find all active businesses with backlink tracking
      const businesses = await prisma.business.findMany({
        where: {
          isActive: true,
          ExternalBacklinkSummary: { isNot: null },
        },
        select: { id: true },
      });

      const results = [];
      for (const biz of businesses) {
        const result = await discoverAndQueuePublishers(biz.id);
        results.push({ businessId: biz.id, ...result });
      }

      console.log(
        `[DR] Publisher discovery complete: ${results.length} businesses processed`,
      );
      return results;
    });
  },
);

/**
 * Phase 2: Generate pitches for queued outreach campaigns.
 * Runs daily to generate pitches for any DRAFTED campaigns.
 */
export const drGeneratePitchesTask = createInngestFunction(
  {
    id: "dr-generate-pitches-daily",
    retries: 3,
  },
  { cron: "0 10 * * *" }, // Daily at 10am
  async ({ step }: any) => {
    return await step.run("generate-pitches", async () => {
      const { generatePitchForCampaign } = await import(
        "../services/dr-outreach.service"
      );

      const draftedCampaigns = await prisma.dROutreachCampaign.findMany({
        where: {
          status: "DRAFTED",
          pitchContent: null,
        },
        take: 20,
        orderBy: { createdAt: "asc" },
      });

      const results = [];
      for (const campaign of draftedCampaigns) {
        const result = await generatePitchForCampaign(campaign.id);
        results.push({ campaignId: campaign.id, ...result });
      }

      console.log(
        `[DR] Pitch generation complete: ${results.filter((r) => r.success).length}/${results.length} generated`,
      );
      return results;
    });
  },
);

/**
 * Phase 2: Send outreach emails for campaigns with generated pitches.
 * Runs daily after pitch generation to send queued pitches.
 */
export const drSendOutreachTask = createInngestFunction(
  {
    id: "dr-send-outreach-daily",
    retries: 3,
  },
  { cron: "0 11 * * *" }, // Daily at 11am (after pitch generation)
  async ({ step }: any) => {
    return await step.run("send-outreach", async () => {
      const { sendOutreachEmail } = await import(
        "../services/dr-outreach.service"
      );

      const readyCampaigns = await prisma.dROutreachCampaign.findMany({
        where: {
          status: "DRAFTED",
          pitchContent: { not: null },
          publisherEmail: { not: null },
        },
        take: 10,
        orderBy: { createdAt: "asc" },
      });

      const results = [];
      for (const campaign of readyCampaigns) {
        const result = await sendOutreachEmail(campaign.id);
        results.push({ campaignId: campaign.id, ...result });
        // Small delay between sends
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.log(
        `[DR] Outreach send complete: ${results.filter((r) => r.success).length}/${results.length} sent`,
      );
      return results;
    });
  },
);

/**
 * Phase 3: Analyze and process lost links after backlink sync.
 * Triggered by the existing backlink sync task.
 */
export const drProcessLostLinksTask = createInngestFunction(
  {
    id: "dr-process-lost-links",
    retries: 3,
  },
  { event: "dr/backlink-sync-complete" },
  async ({ event, step }: any) => {
    const { businessId } = event.data;

    const detected = await step.run("detect-lost-links", async () => {
      const { detectLostLinks } = await import(
        "../services/dr-link-recovery.service"
      );
      return detectLostLinks(businessId);
    });

    if (detected.recoverable === 0) {
      return { ...detected, analyzed: 0, reclaimsSent: 0 };
    }

    const analyzed = await step.run("analyze-lost-links", async () => {
      const { analyzeLostLink } = await import(
        "../services/dr-link-recovery.service"
      );

      const pendingRecoveries = await prisma.dRLinkRecovery.findMany({
        where: {
          businessId,
          reclaimStatus: "DETECTED",
        },
        orderBy: { domainAuthority: "desc" },
        take: 10,
      });

      const results = [];
      for (const recovery of pendingRecoveries) {
        const result = await analyzeLostLink(recovery.id);
        results.push({ recoveryId: recovery.id, ...result });
      }
      return results;
    });

    const reclaimsSent = await step.run("send-reclaim-emails", async () => {
      const { sendReclaimEmail } = await import(
        "../services/dr-link-recovery.service"
      );

      const recoverableLinks = await prisma.dRLinkRecovery.findMany({
        where: {
          businessId,
          reclaimStatus: "RECOVERABLE",
        },
        orderBy: { domainAuthority: "desc" },
        take: 3,
      });

      const results = [];
      for (const link of recoverableLinks) {
        const result = await sendReclaimEmail(link.id);
        results.push({ recoveryId: link.id, ...result });
      }
      return results;
    });

    console.log(
      `[DR] Lost link processing for ${businessId}: detected=${detected.detected}, recoverable=${detected.recoverable}, reclaims=${reclaimsSent.length}`,
    );

    return { ...detected, analyzed: analyzed.length, reclaimsSent: reclaimsSent.length };
  },
);

/**
 * Phase 2: Generate guest post content when a pitch is accepted.
 * Triggered by the inbound webhook handler.
 */
export const drGenerateGuestContentTask = createInngestFunction(
  {
    id: "dr-generate-guest-content",
    retries: 3,
  },
  { event: "dr/generate-guest-content" },
  async ({ event, step }: any) => {
    const { campaignId } = event.data;

    return await step.run("generate-guest-content", async () => {
      const { generateGuestContent } = await import(
        "../services/dr-outreach.service"
      );
      const result = await generateGuestContent(campaignId);
      console.log(
        `[DR] Guest content generation for campaign ${campaignId}: ${result.success ? `blogId=${result.blogId}` : `error=${result.error}`}`,
      );
      return result;
    });
  },
);

// ============================================
// AI Visibility — Citation Monitoring
// ============================================

export const aiVisibilityScanTask = createInngestFunction(
  { id: "ai-visibility-citation-scan" },
  { cron: "0 6 1 * *" }, // Monthly on the 1st at 6 AM
  async ({ step }) => {
    return await step.run("queue-paid-business-scans", async () => {
      const {
        createOrReuseAiVisibilityJob,
      } = await import("../services/ai-visibility-job.service");
      const {
        getAiVisibilityPeriodKey,
        isAiVisibilityMonthlyCronEnabled,
        listMonthlyPaidAiVisibilityBusinesses,
      } = await import("../services/ai-visibility-run-policy.service");

      if (!isAiVisibilityMonthlyCronEnabled()) {
        console.log(
          "⏸️ AI Visibility monthly citation scan skipped: AI_VISIBILITY_MONTHLY_CRON_ENABLED is not true",
        );
        return { skipped: true, reason: "monthly_cron_disabled" };
      }

      const periodKey = getAiVisibilityPeriodKey();
      const businesses = await listMonthlyPaidAiVisibilityBusinesses();

      console.log(
        `🔍 AI Visibility: queueing paid citation scans for ${businesses.length} businesses (${periodKey})`,
      );

      const results: Array<{
        businessId: string;
        queued: boolean;
        reused: boolean;
        jobId: string;
      }> = [];
      for (const biz of businesses) {
        try {
          const { job, reused } = await createOrReuseAiVisibilityJob({
            businessId: biz.id,
            type: "citation_scan",
            source: "monthly_paid",
            periodKey,
          });

          if (!reused) {
            await inngest.send({
              name: "ai-visibility/monthly-scan-business",
              data: {
                businessId: biz.id,
                jobId: job.id,
                periodKey,
                source: "monthly_paid",
              },
            });
          }

          results.push({
            businessId: biz.id,
            queued: !reused,
            reused,
            jobId: job.id,
          });
        } catch (error: any) {
          console.error(
            `❌ AI Visibility paid monthly scan queue failed for "${biz.businessName}": ${error.message}`,
          );
          throw error;
        }
      }

      return {
        periodKey,
        selected: businesses.length,
        queued: results.filter((r) => r.queued).length,
        reused: results.filter((r) => r.reused).length,
        results,
      };
    });
  },
);

export const aiVisibilityMonthlyScanBusinessTask = createInngestFunction(
  { id: "ai-visibility-monthly-scan-business" },
  { event: "ai-visibility/monthly-scan-business" },
  async ({ event, step }) => {
    const { businessId, jobId, periodKey, source } = event.data as {
      businessId: string;
      jobId?: string;
      periodKey?: string;
      source?: string;
    };
    return await step.run("monthly-paid-scan-business", async () => {
      const { runCitationScan } = await import("../services/ai-citation-monitoring.service");
      const {
        markAiVisibilityJobFinished,
        markAiVisibilityJobRunning,
      } = await import("../services/ai-visibility-job.service");

      const maxKeywordsParsed = Number.parseInt(
        process.env.AI_VISIBILITY_MONTHLY_MAX_KEYWORDS || "10",
        10,
      );
      const runsPerQueryParsed = Number.parseInt(
        process.env.AI_VISIBILITY_MONTHLY_RUNS_PER_QUERY || "1",
        10,
      );
      const maxKeywords = Number.isFinite(maxKeywordsParsed)
        ? Math.max(1, maxKeywordsParsed)
        : 10;
      const runsPerQuery = Number.isFinite(runsPerQueryParsed)
        ? Math.max(1, runsPerQueryParsed)
        : 1;

      try {
        await markAiVisibilityJobRunning(jobId);
        const result = await runCitationScan({
          businessId,
          maxKeywords,
          runsPerQuery,
          jobId,
          source,
          periodKey,
        });
        const jobStatus =
          result.status === "partial"
            ? "partial"
            : result.status === "failed"
              ? "failed"
              : "completed";
        await markAiVisibilityJobFinished({
          jobId,
          status: jobStatus,
          result,
          lastError:
            jobStatus === "failed"
              ? "Citation scan failed for all providers"
              : null,
        });
        if (jobStatus === "failed") {
          throw new Error("Citation scan failed for all providers");
        }
        return result;
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    });
  },
);

export const aiVisibilityManualScanTask = createInngestFunction(
  { id: "ai-visibility-manual-scan" },
  { event: "ai-visibility/scan" },
  async ({ event, step }) => {
    const { businessId, jobId } = event.data as {
      businessId: string;
      jobId?: string;
      source?: string;
      periodKey?: string;
    };
    const { source, periodKey } = event.data as {
      source?: string;
      periodKey?: string;
    };
    return await step.run("manual-scan", async () => {
      const { runCitationScan } = await import("../services/ai-citation-monitoring.service");
      const {
        markAiVisibilityJobFinished,
        markAiVisibilityJobRunning,
      } = await import("../services/ai-visibility-job.service");

      try {
        await markAiVisibilityJobRunning(jobId);
        const result = await runCitationScan({
          businessId,
          maxKeywords: 50,
          jobId,
          source,
          periodKey,
        });
        const jobStatus =
          result.status === "partial"
            ? "partial"
            : result.status === "failed"
              ? "failed"
              : "completed";
        await markAiVisibilityJobFinished({
          jobId,
          status: jobStatus,
          result,
          lastError:
            jobStatus === "failed"
              ? "Citation scan failed for all providers"
              : null,
        });
        if (jobStatus === "failed") {
          throw new Error("Citation scan failed for all providers");
        }
        return result;
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    });
  },
);

export const aiVisibilityScoreContentTask = createInngestFunction(
  { id: "ai-visibility-score-content" },
  { event: "ai-visibility/score-content" },
  async ({ event, step }) => {
    const { businessId, jobId } = event.data as {
      businessId: string;
      jobId?: string;
      source?: string;
      periodKey?: string;
    };
    const { source, periodKey } = event.data as {
      source?: string;
      periodKey?: string;
    };
    return await step.run("score-content", async () => {
      const { scoreAllContentForBusiness } = await import("../services/content-scorecard.service");
      const {
        markAiVisibilityJobFinished,
        markAiVisibilityJobRunning,
      } = await import("../services/ai-visibility-job.service");

      try {
        await markAiVisibilityJobRunning(jobId);
        const result = await scoreAllContentForBusiness(businessId);
        const jobStatus =
          result.failed > 0
            ? result.scored > 0
              ? "partial"
              : "failed"
            : "completed";
        await markAiVisibilityJobFinished({
          jobId,
          status: jobStatus,
          result,
          lastError:
            jobStatus === "failed" ? "Content scoring failed for all blogs" : null,
        });
        if (jobStatus === "failed") {
          throw new Error("Content scoring failed for all blogs");
        }
        return result;
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    });
  },
);

export const aiVisibilityDiscoveryTask = createInngestFunction(
  { id: "ai-visibility-query-discovery" },
  { cron: "0 8 1 * *" }, // Monthly on the 1st at 8 AM UTC, after citation queueing
  async ({ step }) => {
    return await step.run("queue-paid-business-discovery", async () => {
      const {
        createOrReuseAiVisibilityJob,
      } = await import("../services/ai-visibility-job.service");
      const {
        getAiVisibilityPeriodKey,
        isAiVisibilityMonthlyCronEnabled,
        listMonthlyPaidAiVisibilityBusinesses,
      } = await import("../services/ai-visibility-run-policy.service");

      if (!isAiVisibilityMonthlyCronEnabled()) {
        console.log(
          "⏸️ AI Visibility monthly query discovery skipped: AI_VISIBILITY_MONTHLY_CRON_ENABLED is not true",
        );
        return { skipped: true, reason: "monthly_cron_disabled" };
      }

      const periodKey = getAiVisibilityPeriodKey();
      const businesses = await listMonthlyPaidAiVisibilityBusinesses();

      console.log(
        `🔍 AI Query Discovery: queueing paid discovery for ${businesses.length} businesses (${periodKey})`,
      );

      const results: Array<{
        businessId: string;
        queued: boolean;
        reused: boolean;
        jobId: string;
      }> = [];
      for (const biz of businesses) {
        try {
          const { job, reused } = await createOrReuseAiVisibilityJob({
            businessId: biz.id,
            type: "query_discovery",
            source: "monthly_paid",
            periodKey,
          });

          if (!reused) {
            await inngest.send({
              name: "ai-visibility/monthly-discover-business",
              data: {
                businessId: biz.id,
                jobId: job.id,
                periodKey,
                source: "monthly_paid",
              },
            });
          }

          results.push({
            businessId: biz.id,
            queued: !reused,
            reused,
            jobId: job.id,
          });
        } catch (error: any) {
          console.error(
            `❌ AI Visibility paid monthly discovery queue failed for "${biz.businessName}": ${error.message}`,
          );
          throw error;
        }
      }

      return {
        periodKey,
        selected: businesses.length,
        queued: results.filter((r) => r.queued).length,
        reused: results.filter((r) => r.reused).length,
        results,
      };
    });
  },
);

export const aiVisibilityMonthlyDiscoveryBusinessTask = createInngestFunction(
  { id: "ai-visibility-monthly-discover-business" },
  { event: "ai-visibility/monthly-discover-business" },
  async ({ event, step }) => {
    const { businessId, jobId, periodKey, source } = event.data as {
      businessId: string;
      jobId?: string;
      periodKey?: string;
      source?: string;
    };
    return await step.run("monthly-paid-discover-business", async () => {
      const { runLlmQueryDiscovery } = await import("../services/llm-query-discovery.service");
      const {
        markAiVisibilityJobFinished,
        markAiVisibilityJobRunning,
      } = await import("../services/ai-visibility-job.service");

      const maxCandidatesParsed = Number.parseInt(
        process.env.AI_VISIBILITY_MONTHLY_MAX_CANDIDATES || "10",
        10,
      );
      const maxCandidates = Number.isFinite(maxCandidatesParsed)
        ? Math.max(1, maxCandidatesParsed)
        : 10;

      try {
        await markAiVisibilityJobRunning(jobId);
        const result = await runLlmQueryDiscovery({
          businessId,
          maxCandidates,
          jobId,
          source,
          periodKey,
        });
        await markAiVisibilityJobFinished({
          jobId,
          status: "completed",
          result,
        });
        return result;
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    });
  },
);

export const aiVisibilityManualDiscoveryTask = createInngestFunction(
  { id: "ai-visibility-manual-discovery" },
  { event: "ai-visibility/discover" },
  async ({ event, step }) => {
    const { businessId, jobId } = event.data as {
      businessId: string;
      jobId?: string;
      source?: string;
      periodKey?: string;
    };
    const { source, periodKey } = event.data as {
      source?: string;
      periodKey?: string;
    };
    return await step.run("manual-discovery", async () => {
      const { runLlmQueryDiscovery } = await import("../services/llm-query-discovery.service");
      const {
        markAiVisibilityJobFinished,
        markAiVisibilityJobRunning,
      } = await import("../services/ai-visibility-job.service");

      try {
        await markAiVisibilityJobRunning(jobId);
        const result = await runLlmQueryDiscovery({
          businessId,
          maxCandidates: 30,
          jobId,
          source,
          periodKey,
        });
        await markAiVisibilityJobFinished({
          jobId,
          status: "completed",
          result,
        });
        return result;
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    });
  },
);

/**
 * Phase 3: competitive content gap analyzer.
 *
 * Fired by ai-citation-monitoring.service.ts on every successful/partial scan.
 * Fetches each top competitor page cited for a keyword, extracts their
 * outline, and stores diff-based "gap topics" relative to our own content.
 */
export const aiVisibilityAnalyzeGapsTask = createInngestFunction(
  { id: "ai-visibility-analyze-gaps" },
  { event: "ai-visibility/analyze-gaps" },
  async ({ event, step }) => {
    const { scanId } = event.data as { scanId: string; businessId?: string };
    return await step.run("analyze-gaps", async () => {
      const { analyzeGapsForScan } = await import(
        "../services/competitive-gap.service"
      );
      try {
        const result = await analyzeGapsForScan(scanId);
        console.log(
          `🧭 Competitive gap analysis for scan ${scanId}: ${result.gapsStored} stored (${result.analyzed} analyzed, ${result.skipped} skipped)`,
        );
        return result;
      } catch (error: any) {
        console.error(
          `❌ Competitive gap analysis failed for scan ${scanId}: ${error.message}`,
        );
        throw error;
      }
    });
  },
);

/**
 * Phase 4: GA4 AI-referral sync.
 *
 * Daily cron pulls AI-engine referral traffic from GA4 for every business
 * that has a linked analytics config. Runs one hour after the freshness
 * refresh (3 AM UTC) to stay off the same DB window.
 */
export const dailyAiReferralSyncTask = createInngestFunction(
  { id: "daily-ai-referral-sync" },
  { cron: "0 4 * * *" },
  async ({ step }) => {
    return await step.run("sync-ai-referrals", async () => {
      const { syncAiReferralTraffic } = await import(
        "../services/ga4-analytics.service"
      );

      const businesses = await prisma.businessAnalyticsConfig.findMany({
        where: { ga4PropertyId: { not: null } },
        select: { businessId: true },
      });

      const results: Array<{
        businessId: string;
        rowsWritten: number;
        error?: string;
      }> = [];
      for (const { businessId } of businesses) {
        try {
          const r = await syncAiReferralTraffic(businessId, { days: 35 });
          results.push({ businessId, rowsWritten: r.rowsWritten });
        } catch (err) {
          results.push({
            businessId,
            rowsWritten: 0,
            error: (err as Error).message,
          });
          console.error(
            `[ga4-sync] failed for business ${businessId}:`,
            (err as Error).message,
          );
        }
      }
      return { processed: businesses.length, results };
    });
  },
);

/**
 * Manual GA4 sync (fires when a user connects or hits "Sync now").
 */
export const aiReferralManualSyncTask = createInngestFunction(
  { id: "ai-referral-manual-sync" },
  { event: "ai-visibility/ga4-sync" },
  async ({ event, step }) => {
    const { businessId, days } = event.data as {
      businessId: string;
      days?: number;
    };
    return await step.run("manual-ga4-sync", async () => {
      const { syncAiReferralTraffic } = await import(
        "../services/ga4-analytics.service"
      );
      return await syncAiReferralTraffic(businessId, {
        days: typeof days === "number" ? days : 35,
      });
    });
  },
);

/**
 * Daily Search Console sync for connected businesses.
 */
export const dailySearchConsoleSyncTask = createInngestFunction(
  { id: "daily-search-console-sync" },
  { cron: "30 4 * * *" },
  async ({ step }) => {
    return await step.run("sync-search-console-businesses", async () => {
      const { syncSearchConsoleMetrics } = await import(
        "../services/search-console.service"
      );

      const businesses = await prisma.businessAnalyticsConfig.findMany({
        where: {
          gscSiteUrl: { not: null },
          OR: [
            { gscRefreshToken: { not: null } },
            { gscAccessToken: { not: null } },
          ],
        } as any,
        select: { businessId: true },
      });

      const results: Array<{
        businessId: string;
        rowsWritten: number;
        error?: string;
      }> = [];
      for (const { businessId } of businesses) {
        try {
          const result = await syncSearchConsoleMetrics(businessId, {
            days: 35,
          });
          results.push({
            businessId,
            rowsWritten: result.rowsWritten,
            ...(result.reason ? { error: result.reason } : {}),
          });
        } catch (err) {
          const message = (err as Error).message;
          results.push({ businessId, rowsWritten: 0, error: message });
          console.error(
            `[search-console-sync] failed for business ${businessId}:`,
            message,
          );
        }
      }

      return { processed: businesses.length, results };
    });
  },
);

/**
 * Manual Search Console sync (fires when a user connects or hits "Sync now").
 */
export const searchConsoleManualSyncTask = createInngestFunction(
  { id: "search-console-manual-sync" },
  { event: "search-console/sync-business" },
  async ({ event, step }) => {
    const { businessId, days } = event.data as {
      businessId: string;
      days?: number;
    };
    return await step.run("manual-search-console-sync", async () => {
      const { syncSearchConsoleMetrics } = await import(
        "../services/search-console.service"
      );
      return await syncSearchConsoleMetrics(businessId, {
        days: typeof days === "number" ? days : 35,
      });
    });
  },
);

export const aiVisibilityDataRetentionTask = createInngestFunction(
  { id: "ai-visibility-data-retention" },
  { cron: "0 3 * * *" }, // Daily at 3 AM
  async ({ step }) => {
    return await step.run("prune-old-citations", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Delete raw citation rows older than 30 days
      const deleted = await prisma.llmCitation.deleteMany({
        where: {
          createdAt: { lt: thirtyDaysAgo },
        },
      });

      // Delete completed scans older than 30 days
      const deletedScans = await prisma.llmCitationScan.deleteMany({
        where: {
          completedAt: { lt: thirtyDaysAgo },
        },
      });

      console.log(`🗑️ Data retention: pruned ${deleted.count} citations, ${deletedScans.count} scans older than 30 days`);

      return {
        citationsPruned: deleted.count,
        scansPruned: deletedScans.count,
      };
    });
  },
);

/**
 * AI Visibility — provider-failure alert consumer.
 *
 * Acknowledges every `ai-visibility/provider-failure` event emitted by
 * runCitationScan when all LLM providers fail for a business. Consumers
 * (Slack, email, PagerDuty) can be plumbed in later by adding additional
 * handlers for the same event — this default consumer just makes sure
 * the event is never left unacknowledged in the Inngest queue.
 */
export const aiVisibilityProviderFailureLogger = createInngestFunction(
  { id: "ai-visibility-provider-failure-logger" },
  { event: "ai-visibility/provider-failure" },
  async ({ event }) => {
    console.error(
      "[ai-visibility] all providers failed:",
      JSON.stringify(event.data),
    );
    return { acknowledged: true };
  },
);

/**
 * Google Maps breaker visibility.
 *
 * The Places client emits this when repeated 429s open the short cooldown
 * breaker. For now this is a lightweight ops breadcrumb in Inngest; alerting
 * can hook onto the same event later without changing the Places client.
 */
export const googleMapsBreakerLogger = createInngestFunction(
  { id: "google-maps-breaker-logger" },
  { event: "maps/breaker-tripped" },
  async ({ event }) => {
    console.warn("[google-maps] breaker tripped:", JSON.stringify(event.data));
    return { acknowledged: true };
  },
);

// ============================================
// Business Geo Profile — C1a (quality recompute) + C1d (POI refresh)
// ============================================

export const businessGeoProfileQualityRecomputeTask = createInngestFunction(
  { id: "business-geo-profile-quality-recompute" },
  { cron: "0 4 * * *" }, // Daily at 4 AM UTC
  async ({ step }) => {
    return await step.run("recompute-geo-quality", async () => {
      const { recomputeGeoProfileQuality } = await import(
        "../services/business-geo-profile.service"
      );

      const businesses = await prisma.business.findMany({
        where: { isActive: true },
        select: { id: true, businessName: true },
      });

      let recomputed = 0;
      let failures = 0;
      for (const biz of businesses) {
        try {
          await recomputeGeoProfileQuality(biz.id);
          recomputed++;
        } catch (err) {
          failures++;
          console.error(
            `⚠️ Geo quality recompute failed for "${biz.businessName}":`,
            (err as Error).message,
          );
        }
      }
      console.log(
        `🗺️  Geo profile quality: recomputed ${recomputed}/${businesses.length} (${failures} failures)`,
      );
      return { recomputed, failures, total: businesses.length };
    });
  },
);

/**
 * Daily refresh of GMB profile health for every active live connection so
 * ranking signals (snapshot, metrics, discovery keywords, alerts) stay fresh
 * without the user opening the dashboard. Runs the same on-demand pipeline that
 * /profile-health uses, so it benefits from the 60s dedup window in
 * gmbLocalVisibilityService.getProfileHealth.
 *
 * Cron staggering: 5 AM UTC, after the geo-quality recompute at 4 AM but before
 * AI-visibility data retention at 3 AM the next morning.
 */
export const gmbProfileDailyRefreshTask = createInngestFunction(
  {
    id: "gmb-profile-daily-refresh",
    name: "Daily GMB Profile Refresh (live connections)",
    retries: 1,
  },
  { cron: "0 5 * * *" },
  async ({ step }) => {
    return await step.run("gmb-profile-daily-refresh", async () => {
      if (!isBackgroundAutomationEnabled("GMB_DAILY_REFRESH_CRON_ENABLED")) {
        return { skipped: true, reason: "gmb_daily_refresh_disabled" };
      }

      const connections = await prisma.googleMyBusiness.findMany({
        where: {
          isActive: true,
          isDemo: false,
          accountId: { not: null },
          locationId: { not: null },
        },
        select: {
          businessId: true,
          businessName: true,
        },
      });

      if (connections.length === 0) {
        return {
          refreshed: 0,
          failures: 0,
          total: 0,
          message: "No active live GMB connections",
        };
      }

      const { gmbLocalVisibilityService } = await import(
        "../services/gmb-local-visibility.service"
      );

      let refreshed = 0;
      let failures = 0;
      const failureSummaries: Array<{ businessId: string; error: string }> = [];

      // Sequential per-business so we don't blow Google API quota on a fleet.
      // Per-business runRankScan is throttled separately by cadence.
      for (const conn of connections) {
        try {
          await gmbLocalVisibilityService.getProfileHealth(
            conn.businessId,
            true,
          );
          refreshed++;
        } catch (err) {
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          failureSummaries.push({
            businessId: conn.businessId,
            error: message,
          });
          console.error(
            `⚠️ GMB daily refresh failed for "${conn.businessName ?? conn.businessId}": ${message}`,
          );
        }
      }

      console.log(
        `📈 GMB daily refresh: ${refreshed}/${connections.length} live connections refreshed (${failures} failures)`,
      );

      return {
        refreshed,
        failures,
        total: connections.length,
        failureSummaries: failureSummaries.slice(0, 25),
      };
    });
  },
);

// Phase 2 ranking foundations: pairs each baseline rank-snapshot (captured
// when an action was APPLIED) with a 'post' snapshot once the impact window
// has elapsed. Cron-driven so a quiet site still eventually closes its
// pending baselines without depending on user activity.
export const gmbEvaluateEditImpactTask = createInngestFunction(
  { id: "gmb-evaluate-edit-impact" },
  { cron: "0 6 * * *" }, // 6 AM UTC; after daily refresh at 5 AM so rank scans are fresh
  async ({ step }) => {
    return await step.run("evaluate-edit-impact", async () => {
      if (!isBackgroundAutomationEnabled("GMB_EDIT_IMPACT_CRON_ENABLED")) {
        return { skipped: true, reason: "gmb_edit_impact_disabled" };
      }

      const { listBaselinesDueForEvaluation, evaluatePostSnapshot } =
        await import("../services/gmb-edit-impact.service");

      const baselines = await listBaselinesDueForEvaluation();
      if (baselines.length === 0) {
        return { processed: 0, skipped: 0, evaluated: 0 };
      }

      let evaluated = 0;
      let skipped = 0;
      const failures: Array<{ baselineId: string; error: string }> = [];

      for (const baseline of baselines) {
        try {
          const result = await evaluatePostSnapshot(baseline);
          if (result.skipped) skipped += 1;
          else evaluated += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ baselineId: baseline.id, error: message });
          console.error(
            `⚠️ GMB edit-impact evaluation failed for ${baseline.id}: ${message}`,
          );
        }
      }

      console.log(
        `📊 GMB edit-impact: evaluated=${evaluated} skipped=${skipped} failures=${failures.length} / ${baselines.length} eligible baselines`,
      );

      return {
        processed: baselines.length,
        evaluated,
        skipped,
        failures: failures.slice(0, 25),
      };
    });
  },
);

// Review-request campaign sender. Walks ACTIVE GMBReviewCampaigns and
// sends one email per PENDING contact (with token-based unsubscribe).
// Daily, gated by GMB_REVIEW_CAMPAIGN_CRON_ENABLED. Per-business cap is
// enforced inside dispatchPendingReviewRequests, not here.
export const gmbReviewCampaignDispatchTask = createInngestFunction(
  { id: "gmb-review-campaign-dispatch" },
  { cron: "0 15 * * *" }, // 3 PM UTC daily — after weekly post cron at 2 PM
  async ({ step }) => {
    return await step.run("dispatch-review-requests", async () => {
      if (!isBackgroundAutomationEnabled("GMB_REVIEW_CAMPAIGN_CRON_ENABLED")) {
        return { skipped: true, reason: "gmb_review_campaign_cron_disabled" };
      }

      const { dispatchPendingReviewRequests } = await import(
        "../services/gmb-review-campaign.service"
      );
      const result = await dispatchPendingReviewRequests();
      console.log(
        `📧 GMB review-request dispatch: touched=${result.campaignsTouched} sent=${result.sent} failed=${result.failed} skippedNoApiKey=${result.skippedNoApiKey}`,
      );
      return result;
    });
  },
);

// Weekly post cadence: keeps the GMB feed active for every business that
// hasn't published a post in 7+ days. Runs daily so a business goes idle for
// at most 7 days, then gets a draft (or auto-publish, depending on mode) on
// the next run. Vertical-agnostic — generateCadencePost works from business
// type + services + city.
export const gmbWeeklyPostCadenceTask = createInngestFunction(
  { id: "gmb-weekly-post-cadence" },
  { cron: "0 14 * * *" }, // 2 PM UTC daily
  async ({ step }) => {
    return await step.run("gmb-weekly-post-cadence", async () => {
      if (!isBackgroundAutomationEnabled("GMB_WEEKLY_POST_CRON_ENABLED")) {
        return { skipped: true, reason: "gmb_weekly_post_cron_disabled" };
      }

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const connections = await prisma.googleMyBusiness.findMany({
        where: {
          isActive: true,
          isDemo: false,
          accountId: { not: null },
          locationId: { not: null },
        },
        select: {
          id: true,
          businessId: true,
          businessName: true,
          postAutomationMode: true,
        },
      });

      if (connections.length === 0) {
        return { processed: 0, drafted: 0, published: 0, skipped: 0 };
      }

      const { gmbAIService } = await import("../services/gmb-ai.service");
      const { GoogleMyBusinessService } = await import(
        "../services/google-my-business.service"
      );
      const gmbService = new GoogleMyBusinessService();

      let drafted = 0;
      let published = 0;
      let skipped = 0;
      const failures: Array<{ businessId: string; error: string }> = [];

      for (const conn of connections) {
        try {
          const recentPost = await prisma.gMBPost.findFirst({
            where: {
              gmbId: conn.id,
              status: "PUBLISHED",
              publishedAt: { gte: sevenDaysAgo },
            },
            select: { id: true },
          });
          if (recentPost) {
            skipped += 1;
            continue;
          }

          const recentSuggestion = await prisma.gMBPostSuggestion.findFirst({
            where: {
              businessId: conn.businessId,
              status: "PUBLISHED",
              publishedAt: { gte: sevenDaysAgo },
            },
            select: { id: true },
          });
          if (recentSuggestion) {
            skipped += 1;
            continue;
          }

          const business = await prisma.business.findUnique({
            where: { id: conn.businessId },
            select: {
              businessName: true,
              businessType: true,
              businessCity: true,
              businessState: true,
              businessWebsiteUrl: true,
              selectedServices: true,
              detectedServices: true,
            },
          });
          if (!business) {
            skipped += 1;
            continue;
          }

          const services = (
            (business.selectedServices as unknown as string[] | null) ??
            (business.detectedServices as unknown as string[] | null) ??
            []
          )
            .map((s) => (typeof s === "string" ? s : ""))
            .filter(Boolean);

          const post = await gmbAIService.generateCadencePost({
            businessId: conn.businessId,
            businessName: business.businessName,
            businessType: business.businessType,
            city: business.businessCity,
            state: business.businessState,
            services,
            websiteUrl: business.businessWebsiteUrl,
          });

          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 14);

          const suggestion = await prisma.gMBPostSuggestion.create({
            data: {
              businessId: conn.businessId,
              postType: post.postType,
              title: `Weekly post — ${new Date().toISOString().slice(0, 10)}`,
              summary: post.summary,
              callToAction: post.callToAction ?? null,
              mediaUrls: [],
              status: "PENDING",
              expiresAt,
            },
          });

          if (conn.postAutomationMode === "approval_required") {
            await inngest.send({
              id: `approval-ready-gmb:${suggestion.id}`,
              name: "content/approval-ready",
              data: { kind: "gmb_post", contentId: suggestion.id },
            });
          }

          if (conn.postAutomationMode === "auto_publish") {
            try {
              const created = await gmbService.createPost(conn.businessId, {
                postType: post.postType,
                summary: post.summary,
                callToAction: post.callToAction,
              });
              await prisma.gMBPostSuggestion.update({
                where: { id: suggestion.id },
                data: {
                  status: "PUBLISHED",
                  publishedAt: new Date(),
                  gmbPostId: created.id ?? null,
                },
              });
              published += 1;
            } catch (publishError) {
              const message =
                publishError instanceof Error
                  ? publishError.message
                  : String(publishError);
              failures.push({ businessId: conn.businessId, error: message });
              console.error(
                `⚠️ GMB weekly post auto-publish failed for ${conn.businessName ?? conn.businessId}: ${message}`,
              );
              drafted += 1;
            }
          } else {
            drafted += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ businessId: conn.businessId, error: message });
          console.error(
            `⚠️ GMB weekly post cadence failed for ${conn.businessName ?? conn.businessId}: ${message}`,
          );
        }
      }

      console.log(
        `🗓️  GMB weekly post cadence: drafted=${drafted} published=${published} skipped=${skipped} failures=${failures.length} / ${connections.length} connections`,
      );

      return {
        processed: connections.length,
        drafted,
        published,
        skipped,
        failures: failures.slice(0, 25),
      };
    });
  },
);

export const businessGeoPoiRefreshTask = createInngestFunction(
  { id: "business-geo-poi-refresh" },
  { cron: "0 3 * * *" }, // Daily at 3 AM UTC; ≤50 profiles per run
  async ({ step }) => {
    return await step.run("refresh-expiring-pois", async () => {
      const { refreshExpiringPOIs } = await import(
        "../services/business-geo-profile.service"
      );
      // Only attempts when GOOGLE_MAPS_API_KEY is set. Safe no-op otherwise.
      if (!process.env.GOOGLE_MAPS_API_KEY) {
        console.log("🗺️  POI refresh skipped — GOOGLE_MAPS_API_KEY not configured.");
        return { refreshed: 0, failures: 0, skipped: true };
      }
      const result = await refreshExpiringPOIs(50);
      console.log(
        `🗺️  POI refresh: ${result.refreshed} refreshed, ${result.failures} failures`,
      );
      return { ...result, skipped: false };
    });
  },
);

// ============================================
// Blog Freshness Loop — B1
// ============================================

export const dailyBlogFreshnessRefreshTask = createInngestFunction(
  { id: "daily-blog-freshness-refresh" },
  { cron: "0 3 * * *" }, // 3 AM UTC; after dailyBlogScheduler
  async ({ step }) => {
    return await step.run("refresh-stale-blogs", async () => {
      const { runFreshnessRefreshBatch } = await import(
        "../services/blog-freshness.service"
      );
      const result = await runFreshnessRefreshBatch({ limit: 50 });
      console.log(
        `🔄 Blog freshness: ${result.refreshed} refreshed, ${result.skipped} skipped, ${result.failed} failed`,
      );
      return result;
    });
  },
);

export const offPageResearchTask = createInngestFunction(
  {
    id: "off-page-generate",
    // One generation per business at a time — repeated page polls / refreshes
    // that re-send this event are skipped while a run is in flight.
    singleton: {
      key: "event.data.businessId",
      mode: "skip",
    },
    retries: 1,
  },
  { event: "off-page/generate" },
  async ({ event, step }) => {
    const { userId, businessId } = event.data as {
      userId: string;
      businessId: string;
    };
    const { runOffPageGeneration } = await import(
      "../services/offpage/offpage-opportunities.service"
    );
    await step.run("generate-off-page", () =>
      runOffPageGeneration(userId, businessId),
    );
    return { ok: true, businessId };
  },
);

export const offPageScheduledRefreshTask = createInngestFunction(
  {
    id: "off-page-scheduled-refresh",
    retries: 0,
  },
  { cron: "30 5 * * *" },
  async ({ step }) => {
    const automationState = getBackgroundAutomationState(
      "OFFPAGE_REFRESH_CRON_ENABLED",
    );
    if (!automationState.enabled) {
      console.log(
        "⏭️ Skipping off-page scheduled refresh: OFFPAGE_REFRESH_CRON_ENABLED is not enabled for this runtime.",
      );
      return {
        skipped: true,
        reason: "offpage_refresh_cron_disabled",
        automationState,
      };
    }

    const candidates = (await step.run(
      "find-off-page-refresh-candidates",
      async () => {
        const { getOffPageRefreshCandidates } = await import(
          "../services/offpage/offpage-maintenance.service"
        );
        return getOffPageRefreshCandidates();
      },
    )) as Array<{ userId: string; businessId: string; reason: string }>;

    const queued = await step.run("queue-off-page-refreshes", async () => {
      let count = 0;
      for (const candidate of candidates) {
        await inngest.send({
          name: "off-page/generate",
          data: {
            userId: candidate.userId,
            businessId: candidate.businessId,
            reason: candidate.reason,
            source: "scheduled-refresh",
          },
        });
        count += 1;
      }
      return count;
    });

    console.log(
      `✅ Off-page scheduled refresh queued ${queued}/${candidates.length} businesses`,
    );
    return {
      queued,
      candidates: candidates.length,
      reasons: candidates.reduce((acc: Record<string, number>, candidate) => {
        acc[candidate.reason] = (acc[candidate.reason] ?? 0) + 1;
        return acc;
      }, {}),
    };
  },
);

export const commandStripeNightlyReconciliationTask = createInngestFunction(
  {
    id: "command-stripe-nightly-reconciliation",
    retries: 2,
    singleton: { key: '"stripe-command-reconciliation"', mode: "skip" },
  },
  [
    { cron: "15 7 * * *" },
    { event: "command/stripe.reconcile.requested" },
  ],
  async ({ step }) => {
    const automationState = getBackgroundAutomationState(
      "COMMAND_STRIPE_RECONCILIATION_ENABLED",
    );
    if (!automationState.enabled) {
      return {
        skipped: true,
        reason: "command_stripe_reconciliation_disabled",
        automationState,
      };
    }

    const result = await step.run("reconcile-stripe-command-facts", async () => {
      const Stripe = (await import("stripe")).default;
      const { reconcileCommandStripeFacts } = await import(
        "../command/stripe-reconciliation.service"
      );
      const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
      if (!secretKey) {
        throw new Error(
          "STRIPE_SECRET_KEY is required for Command reconciliation",
        );
      }
      const stripe = new Stripe(secretKey, {
        apiVersion: "2026-03-25.dahlia" as StripeSdk.LatestApiVersion,
      });
      return reconcileCommandStripeFacts(stripe);
    });
    await step.run("refresh-command-monthly-rollup", async () => {
      const { currentCommandMonth } = await import(
        "../command/toronto-period"
      );
      const { refreshCommandStripeMonthlyMovement } = await import(
        "../command/stripe-monthly-rollup.service"
      );
      return refreshCommandStripeMonthlyMovement(currentCommandMonth());
    });
    return result;
  },
);

export const commandMetricRollupRefreshTask = createInngestFunction(
  {
    id: "command-metric-rollup-refresh",
    retries: 1,
    singleton: { key: '"command-metric-rollup"', mode: "skip" },
  },
  [
    { cron: "*/5 * * * *" },
    { event: "command/metrics.rollup.requested" },
  ],
  async ({ step }) => {
    const automationState = getBackgroundAutomationState(
      "COMMAND_METRIC_ROLLUP_CRON_ENABLED",
    );
    if (!automationState.enabled) {
      return {
        skipped: true,
        reason: "command_metric_rollup_disabled",
        automationState,
      };
    }
    return step.run("refresh-command-metric-rollup", async () => {
      const { currentCommandMonth } = await import(
        "../command/toronto-period"
      );
      const { refreshCommandStripeMonthlyMovement } = await import(
        "../command/stripe-monthly-rollup.service"
      );
      return refreshCommandStripeMonthlyMovement(currentCommandMonth());
    });
  },
);

export const commandGhlHourlyReadSyncTask = createInngestFunction(
  {
    id: "command-ghl-hourly-read-sync",
    retries: 2,
    singleton: { key: '"ghl-command-read-sync"', mode: "skip" },
  },
  [
    { cron: "5 * * * *" },
    { event: "command/ghl.sync.requested" },
  ],
  async ({ step }) => {
    const automationState = getBackgroundAutomationState(
      "COMMAND_GHL_SYNC_ENABLED",
    );
    if (!automationState.enabled) {
      return {
        skipped: true,
        reason: "command_ghl_sync_disabled",
        automationState,
      };
    }

    return step.run("sync-ghl-read-models", async () => {
      const { GhlReadOnlyClient } = await import(
        "../command/ghl-readonly.client"
      );
      const { syncCommandGhlReadModels } = await import(
        "../command/ghl-sync.service"
      );
      const token = process.env.GHL_COMMAND_READ_TOKEN?.trim();
      const locationId = process.env.GHL_COMMAND_LOCATION_ID?.trim();
      if (!token || !locationId) {
        throw new Error(
          "GHL_COMMAND_READ_TOKEN and GHL_COMMAND_LOCATION_ID are required",
        );
      }
      const client = new GhlReadOnlyClient({
        token,
        locationId,
        baseUrl: process.env.GHL_COMMAND_API_BASE_URL,
        contactsVersion: process.env.GHL_COMMAND_CONTACTS_VERSION,
        opportunitiesVersion: process.env.GHL_COMMAND_OPPORTUNITIES_VERSION,
      });
      return syncCommandGhlReadModels(client);
    });
  },
);

export const commandGhlPaymentsHourlyReadSyncTask = createInngestFunction(
  {
    id: "command-ghl-payments-hourly-read-sync",
    retries: 2,
    singleton: { key: '"ghl-command-payments-read-sync"', mode: "skip" },
  },
  [
    { cron: "10 * * * *" },
    { event: "command/ghl.payments.sync.requested" },
  ],
  async ({ step }) => {
    if (envFlag("COMMAND_GHL_PAYMENTS_SYNC_ENABLED") !== true) {
      return {
        skipped: true,
        reason: "command_ghl_payments_sync_not_explicitly_enabled",
        flagName: "COMMAND_GHL_PAYMENTS_SYNC_ENABLED",
      };
    }

    return step.run("sync-ghl-payment-read-models", async () => {
      const { GhlReadOnlyClient } = await import(
        "../command/ghl-readonly.client"
      );
      const { syncCommandGhlPayments } = await import(
        "../command/ghl-payment-sync.service"
      );
      const token = process.env.GHL_COMMAND_READ_TOKEN?.trim();
      const locationId = process.env.GHL_COMMAND_LOCATION_ID?.trim();
      if (!token || !locationId) {
        throw new Error(
          "GHL_COMMAND_READ_TOKEN and GHL_COMMAND_LOCATION_ID are required",
        );
      }
      const client = new GhlReadOnlyClient({
        token,
        locationId,
        baseUrl: process.env.GHL_COMMAND_API_BASE_URL,
        paymentsVersion: process.env.GHL_COMMAND_PAYMENTS_VERSION,
      });
      return syncCommandGhlPayments(client, locationId);
    });
  },
);

export const commandGhlActivityHourlyReadSyncTask = createInngestFunction(
  {
    id: "command-ghl-activity-hourly-read-sync",
    retries: 2,
    singleton: { key: '"ghl-command-activity-read-sync"', mode: "skip" },
  },
  [
    { cron: "15 * * * *" },
    { event: "command/ghl.activity.sync.requested" },
  ],
  async ({ event, step }) => {
    if (envFlag("COMMAND_GHL_ACTIVITY_SYNC_ENABLED") !== true) {
      return {
        skipped: true,
        reason: "command_ghl_activity_sync_not_explicitly_enabled",
        flagName: "COMMAND_GHL_ACTIVITY_SYNC_ENABLED",
      };
    }

    return step.run("sync-ghl-command-activity", async () => {
      const { GhlReadOnlyClient } = await import(
        "../command/ghl-readonly.client"
      );
      const { syncCommandGhlActivity } = await import(
        "../command/ghl-activity-sync.service"
      );
      const token = process.env.GHL_COMMAND_READ_TOKEN?.trim();
      const locationId = process.env.GHL_COMMAND_LOCATION_ID?.trim();
      if (!token || !locationId) {
        throw new Error(
          "GHL_COMMAND_READ_TOKEN and GHL_COMMAND_LOCATION_ID are required",
        );
      }
      const client = new GhlReadOnlyClient({
        token,
        locationId,
        baseUrl: process.env.GHL_COMMAND_API_BASE_URL,
        conversationsVersion: process.env.GHL_COMMAND_CONVERSATIONS_VERSION,
        calendarsVersion: process.env.GHL_COMMAND_CALENDARS_VERSION,
      });
      const requestedMonth =
        typeof event?.data?.month === "string" ? event.data.month : undefined;
      return syncCommandGhlActivity(client, requestedMonth);
    });
  },
);

export const commandMetaAdsDailyReadSyncTask = createInngestFunction(
  {
    id: "command-meta-ads-daily-read-sync",
    retries: 2,
    singleton: { key: '"meta-ads-command-read-sync"', mode: "skip" },
  },
  [
    { cron: "20 7 * * *" },
    { event: "command/meta-ads.sync.requested" },
  ],
  async ({ event, step }) => {
    if (envFlag("COMMAND_META_ADS_SYNC_ENABLED") !== true) {
      return {
        skipped: true,
        reason: "command_meta_ads_sync_not_explicitly_enabled",
        flagName: "COMMAND_META_ADS_SYNC_ENABLED",
      };
    }

    return step.run("sync-meta-ads-command-costs", async () => {
      const { MetaAdsReadOnlyClient } = await import(
        "../command/meta-ads-readonly.client"
      );
      const { syncCommandMetaAdsCosts } = await import(
        "../command/meta-ads-sync.service"
      );
      const accessToken = process.env.META_ADS_ACCESS_TOKEN?.trim();
      const adAccountId = process.env.META_AD_ACCOUNT_ID?.trim();
      const apiVersion = process.env.META_GRAPH_API_VERSION?.trim();
      if (!accessToken || !adAccountId || !apiVersion) {
        throw new Error(
          "META_ADS_ACCESS_TOKEN, META_AD_ACCOUNT_ID, and META_GRAPH_API_VERSION are required",
        );
      }
      const client = new MetaAdsReadOnlyClient({
        accessToken,
        adAccountId,
        apiVersion,
        baseUrl: process.env.META_GRAPH_API_BASE_URL,
      });
      const requestedMonth =
        typeof event?.data?.month === "string" ? event.data.month : undefined;
      return syncCommandMetaAdsCosts(client, requestedMonth);
    });
  },
);

export const commandCallReviewTask = createInngestFunction(
  {
    id: "command-call-review",
    retries: 3,
    concurrency: { scope: "env", key: '"command-call-review"', limit: 4 },
  },
  { event: "command/call.review.requested" },
  async ({ event, step }) => {
    const callId = typeof event?.data?.callId === "string" ? event.data.callId : "";
    if (!callId) throw new NonRetriableError("callId is required");
    return step.run("generate-versioned-call-review", async () => {
      const { generateCommandCallReview } = await import(
        "../command/call-review.service"
      );
      const review = await generateCommandCallReview(callId);
      return { id: review.id, status: review.status, callId };
    });
  },
);

export const commandCallRetentionTask = createInngestFunction(
  {
    id: "command-call-retention",
    retries: 2,
    singleton: { key: '"command-call-retention"', mode: "skip" },
  },
  { cron: "35 6 * * *" },
  async ({ step }) =>
    step.run("redact-expired-call-content", async () => {
      const now = new Date();
      const expired = await prisma.commandCall.findMany({
        where: { retentionExpiresAt: { lte: now } },
        select: { id: true },
        take: 500,
      });
      if (!expired.length) return { redacted: 0 };
      const result = await prisma.commandCall.updateMany({
        where: { id: { in: expired.map((call) => call.id) } },
        data: {
          participantEmails: [],
          organizerEmail: null,
          summary: null,
          actionItems: Prisma.JsonNull,
          transcriptUrl: null,
          recordingUrl: null,
          retentionExpiresAt: null,
        },
      });
      await invalidateCommandCache();
      return { redacted: result.count };
    }),
);

export const commandCoachingBriefTask = createInngestFunction(
  {
    id: "command-coaching-brief",
    retries: 2,
    concurrency: { scope: "env", key: '"command-coaching-brief"', limit: 2 },
  },
  { event: "command/coaching-brief.requested" },
  async ({ event, step }) => {
    const repId = typeof event?.data?.repId === "string" ? event.data.repId : "";
    const periodMonth =
      typeof event?.data?.periodMonth === "string" ? event.data.periodMonth : "";
    if (!repId || !periodMonth) {
      throw new NonRetriableError("repId and periodMonth are required");
    }
    return step.run("generate-versioned-coaching-brief", async () => {
      const { generateCommandCoachingBrief } = await import(
        "../command/coaching-brief.service"
      );
      const brief = await generateCommandCoachingBrief({ repId, periodMonth });
      return { id: brief.id, status: brief.status, repId, periodMonth };
    });
  },
);

const socialCreativeFunctions = createSocialCreativeInngestFunctions(inngest);
const zernioSocialPublishingFunctions =
  createZernioSocialPublishingFunctions(inngest);
const contentApprovalNotificationFunctions =
  createContentApprovalNotificationFunctions(inngest);

export const functions = [
  generateKeywordsTask,
  staleKeywordGenerationVerifierTask,
  dailyKeywordTopUpTask,
  generateBlogTask,
  dailyBlogScheduler,
  manualDailyBlogTrigger,
  brandAnalysisTask,
  scheduledBlogDistributionScannerTask,
  autoPublishBlogTask,
  syncExternalBacklinksTask,
  manualSyncBacklinksTask,
  weeklyPineconeReindexTask,
  manualPineconeReindexTask,
  discoverSitemapTask,
  extractBlogImagesTask,
  sendPitchEmailTask,
  checkEmailRepliesTask,
  checkPublishedPostsTask,
  autoDiscoverPublishersTask,
  autoDiscoverForCampaignsTask,
  autoCreateSubmissionsTask,
  autoGenerateAndSendPitchTask,
  checkTrialExpiryTask,
  trialStartedTask,
  onboardingV2PreviewRequestedTask,
  onboardingV2BlogPreviewTask,
  onboardingV2SocialPreviewTask,
  quickBlogGenerationTask,
  completeOnboardingTask,
  secondaryOnboardingV2InitializeTask,
  secondaryOnboardingV2CompleteTask,
  websiteOnboardTask,
  websiteFinalizeSecondaryTask,
  dailyBlogSummaryTask,
  pendingWebsiteReconcilerTask,
  websiteRemovalRetryTask,
  siteIntegrityCheckTask,
  autoReplyGMBReviewsTask,
  autoGenerateGMBAIRepliesTask,
  autoGMBPostFromBlogTask,
  ...socialCreativeFunctions,
  ...zernioSocialPublishingFunctions,
  ...contentApprovalNotificationFunctions,
  signupAuditEmailTask,
  runCompleteSeoAuditTask,
  // DR Growth Engine
  drOptimizeContentTask,
  drDiscoverPublishersTask,
  drGeneratePitchesTask,
  drSendOutreachTask,
  drProcessLostLinksTask,
  drGenerateGuestContentTask,
  // AI Visibility
  aiVisibilityScanTask,
  aiVisibilityManualScanTask,
  aiVisibilityScoreContentTask,
  aiVisibilityDiscoveryTask,
  aiVisibilityManualDiscoveryTask,
  aiVisibilityDataRetentionTask,
  aiVisibilityProviderFailureLogger,
  googleMapsBreakerLogger,
  aiVisibilityAnalyzeGapsTask,
  dailyAiReferralSyncTask,
  aiReferralManualSyncTask,
  dailySearchConsoleSyncTask,
  searchConsoleManualSyncTask,
  // Geo profile (C1a + C1d)
  businessGeoProfileQualityRecomputeTask,
  businessGeoPoiRefreshTask,
  // Blog freshness (B1)
  dailyBlogFreshnessRefreshTask,
  // GMB daily refresh — keeps ranking signals fresh without dashboard visits.
  gmbProfileDailyRefreshTask,
  // Off-page opportunities — background generation (research→validate→enrich→cache).
  offPageResearchTask,
  // Off-page opportunities — refresh stale/legacy cache rows without page visits.
  offPageScheduledRefreshTask,
  // Nightly provider-to-database correction pass for Command financial facts.
  commandStripeNightlyReconciliationTask,
  // Five-minute derived rollup keeps leadership reads bounded at provider volume.
  commandMetricRollupRefreshTask,
  // Isolated read-only CRM projection. This task never imports the signup writer.
  commandGhlHourlyReadSyncTask,
  // Opt-in read-only payments projection. Separate scopes/failures cannot block CRM sync.
  commandGhlPaymentsHourlyReadSyncTask,
  // Opt-in read-only call/calendar projection into monthly rep activity.
  commandGhlActivityHourlyReadSyncTask,
  // Opt-in GET-only Meta Insights projection into the acquisition cost ledger.
  commandMetaAdsDailyReadSyncTask,
  // Provider-authenticated call reviews are generated off-page and persisted.
  commandCallReviewTask,
  // Daily redaction enforces the approved call-data retention window.
  commandCallRetentionTask,
  commandCoachingBriefTask,
];
