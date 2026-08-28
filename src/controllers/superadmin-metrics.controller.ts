import { LlmUsagePurpose, type Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import Stripe from "stripe";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { getCoreInngestMetrics } from "../services/admin-inngest-metrics-relay.service";
import { estimateUsdFromStoredUsage } from "../services/llm-usage.service";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  classifyUserSubscriptionStatus,
  type UserSubscriptionStatus,
  classifyWebsiteSubscription,
  parseOptionalDate,
} from "../utils/superadmin-metrics.utils";
import {
  buildAdminOnboardingBreakdown,
  type AdminOnboardingFilter,
  type AdminOnboardingSummary,
} from "../utils/superadmin-onboarding.utils";
import {
  getRevenueSummaryWithCache,
  type RevenueSummaryPayload,
} from "../utils/superadmin-revenue-cache";
import {
  commandDayRange,
  commandMonthRange,
  commandMonthsEndingAt,
  currentCommandMonth,
  shiftCommandDay,
  COMMAND_TIME_ZONE,
} from "../command/toronto-period";
import {
  buildDailyPaymentMetrics,
  buildDailyUserMetrics,
} from "../utils/superadmin-daily-metrics";

const OVERVIEW_QUERY = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const REVENUE_SUMMARY_QUERY = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  trendMonths: z.coerce.number().int().min(1).max(12).optional().default(6),
});

const PAGINATION_QUERY = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

const ATTRIBUTION_QUERY = PAGINATION_QUERY.extend({
  agencyId: z.string().uuid().optional(),
});

const LLM_USAGE_QUERY = PAGINATION_QUERY.extend({
  from: z.string().optional(),
  to: z.string().optional(),
  purpose: z.nativeEnum(LlmUsagePurpose).optional(),
  model: z.string().optional(),
  businessId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

/**
 * The window used when a caller names neither end of the range. Thirty days
 * matches the window `metrics/overview` already reads for its usage summary.
 */
const LLM_USAGE_DEFAULT_WINDOW_DAYS = 30;

/**
 * How many events one request will load. Well above the twenty-five a page
 * shows and above a normal month, so truncation is an unusual-density signal
 * rather than a routine one.
 */
const LLM_USAGE_MAX_ROWS = 20_000;

const LLM_USAGE_EXPORT_QUERY = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  purpose: z.nativeEnum(LlmUsagePurpose).optional(),
  model: z.string().optional(),
  businessId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

const BLOG_GENERATION_METRICS_QUERY = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  businessId: z.string().uuid().optional(),
});

const LLM_EXPORT_MAX_ROWS = 50000;

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

type LlmUsageRow = {
  id: string;
  createdAt: Date;
  purpose: LlmUsagePurpose;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedUsd: Prisma.Decimal | null;
  metadata?: Prisma.JsonValue | null;
  userId: string | null;
  businessId: string | null;
  blogId: string | null;
  correlationId?: string | null;
  user?: {
    id: string;
    email: string;
    name: string;
  } | null;
  business?: {
    id: string;
    businessName: string;
    businessWebsiteUrl: string;
  } | null;
};

function asMetadataRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getMetadataUsageType(row: Pick<LlmUsageRow, "metadata">): string {
  const metadata = asMetadataRecord(row.metadata);
  return typeof metadata?.usageType === "string" ? metadata.usageType : "";
}

function getMetadataImageCount(row: Pick<LlmUsageRow, "metadata">): number {
  const metadata = asMetadataRecord(row.metadata);
  const count = metadata?.imageCount;
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : 0;
}

function isImageGenerationUsageRow(
  row: Pick<LlmUsageRow, "model" | "metadata">,
): boolean {
  const usageType = getMetadataUsageType(row);
  return (
    row.model === "gemini-2.5-flash-image" ||
    usageType === "blog_image_generation" ||
    getMetadataImageCount(row) > 0
  );
}

function isAiVisibilityUsageRow(
  row: Pick<LlmUsageRow, "purpose" | "metadata">,
): boolean {
  const usageType = getMetadataUsageType(row);
  return (
    row.purpose === "ai_visibility" || usageType.startsWith("ai_visibility_")
  );
}

function createUsageSummary() {
  return {
    eventCount: 0,
    imageCount: 0,
    sumEstimatedUsd: 0,
    sumInputTokens: 0,
    sumOutputTokens: 0,
    sumTotalTokens: 0,
  };
}

function addRowToUsageSummary(
  summary: ReturnType<typeof createUsageSummary>,
  row: LlmUsageRow,
): void {
  const estimatedUsd = getLlmRowEstimatedUsd(row) ?? 0;
  const inputTokens = row.inputTokens ?? 0;
  const outputTokens = row.outputTokens ?? 0;
  const totalTokens = row.totalTokens ?? inputTokens + outputTokens;

  summary.eventCount += 1;
  summary.imageCount += getMetadataImageCount(row);
  summary.sumEstimatedUsd += estimatedUsd;
  summary.sumInputTokens += inputTokens;
  summary.sumOutputTokens += outputTokens;
  summary.sumTotalTokens += totalTokens;
}

function serializeUsageSummary(summary: ReturnType<typeof createUsageSummary>) {
  return {
    eventCount: summary.eventCount,
    imageCount: summary.imageCount,
    sumEstimatedUsd: summary.sumEstimatedUsd.toFixed(6),
    sumInputTokens: summary.sumInputTokens,
    sumOutputTokens: summary.sumOutputTokens,
    sumTotalTokens: summary.sumTotalTokens,
  };
}

function buildLlmUsageWhere(input: {
  from?: Date;
  to?: Date;
  purpose?: LlmUsagePurpose;
  model?: string;
  businessId?: string;
  userId?: string;
}): Prisma.LlmUsageEventWhereInput {
  const where: Prisma.LlmUsageEventWhereInput = {};

  if (input.from !== undefined || input.to !== undefined) {
    where.createdAt = {};
    if (input.from !== undefined) {
      where.createdAt.gte = input.from;
    }
    if (input.to !== undefined) {
      where.createdAt.lte = input.to;
    }
  }
  if (input.purpose !== undefined) {
    where.purpose = input.purpose;
  }
  if (input.model !== undefined && input.model !== "") {
    where.model = input.model;
  }
  if (input.businessId !== undefined && input.businessId !== "") {
    where.businessId = input.businessId;
  }
  if (input.userId !== undefined && input.userId !== "") {
    where.userId = input.userId;
  }

  return where;
}

function getLlmRowEstimatedUsd(
  row: Pick<LlmUsageRow, "model" | "inputTokens" | "outputTokens" | "estimatedUsd">,
): number | null {
  return estimateUsdFromStoredUsage({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedUsd: row.estimatedUsd?.toString() ?? null,
  });
}

const API_TOKENS_QUERY = PAGINATION_QUERY.extend({
  from: z.string().optional(),
  to: z.string().optional(),
  businessId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  activeOnly: z.enum(["true", "false"]).optional(),
});

/**
 * Same finding as the user list: this endpoint costs about the same per call
 * whatever the page size, so a caller assembling the whole feed pays the fixed
 * cost once per page for no reason. A 30-day range holds ~1,600 publishes,
 * which was 17 pages, and Product Analysis fetches two ranges to compare them —
 * 34 requests to build one comparison. The ceiling goes to 2000 so it is two.
 */
const BLOGS_DAILY_QUERY = z.object({
  from: z.string(),
  to: z.string(),
  userId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(2000).optional().default(50),
});

const DAILY_METRICS_QUERY = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const INNGEST_METRICS_QUERY = z.object({
  limit: z.coerce.number().int().min(5).max(50).optional().default(20),
});

const USER_STATUS_VALUES = ["paid", "trial", "expired"] as const;
const USER_ONBOARDING_VALUES = [
  "not_started",
  "in_progress",
  "completed",
  "failed",
  "needs_follow_up",
] as const;

/**
 * The user list allows a much larger page than the shared default.
 *
 * Measured against production, this endpoint costs the same at limit=1 as at
 * limit=100 — about 330ms either way — because every call recomputes the whole
 * summary block regardless of how many rows it returns. The cost is per
 * request, not per row.
 *
 * The admin has to walk the whole list to build its cohorts, so a 100 cap made
 * it pay that fixed cost nine times for a 30-day range and twenty-one times for
 * everything. Raising the ceiling is backward compatible — existing callers
 * asking for 25 or 100 are unaffected — and turns the walk into one or two
 * calls.
 */
const USERS_QUERY = PAGINATION_QUERY.extend({
  limit: z.coerce.number().int().min(1).max(2000).optional().default(25),
  search: z.string().optional().default(""),
  status: z.enum(USER_STATUS_VALUES).optional(),
  onboarding: z.enum(USER_ONBOARDING_VALUES).optional(),
});

const USERS_EXPORT_QUERY = z.object({
  search: z.string().optional(),
  status: z.enum(USER_STATUS_VALUES).optional(),
  onboarding: z.enum(USER_ONBOARDING_VALUES).optional(),
  format: z.enum(["csv", "json"]).optional().default("csv"),
});

const USERS_EXPORT_MAX_ROWS = 50000;

function startOfUtcDay(d: Date): Date {
  const x: Date = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function endOfUtcDay(d: Date): Date {
  const x: Date = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcMonths(value: Date, months: number): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1),
  );
}

function formatUtcMonth(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}`;
}

function parseRevenueMonth(value: string | undefined): Date {
  if (!value) {
    return startOfUtcMonth(new Date());
  }

  const [yearRaw, monthRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return startOfUtcMonth(new Date());
  }

  return new Date(Date.UTC(year, month - 1, 1));
}

type MonthlyCollectedCurrencyTotals = {
  grossCents: number;
  refundsCents: number;
  disputesCents: number;
  netCents: number;
  chargeCount: number;
  refundCount: number;
  disputeCount: number;
};

type MonthlyCollectedSnapshot = {
  month: string;
  byCurrency: Record<string, MonthlyCollectedCurrencyTotals>;
};

function emptyCollectedTotals(): MonthlyCollectedCurrencyTotals {
  return {
    grossCents: 0,
    refundsCents: 0,
    disputesCents: 0,
    netCents: 0,
    chargeCount: 0,
    refundCount: 0,
    disputeCount: 0,
  };
}

function getCollectedTotals(
  byCurrency: Record<string, MonthlyCollectedCurrencyTotals>,
  currency: string | null | undefined,
): MonthlyCollectedCurrencyTotals {
  const key = (currency || "usd").toLowerCase();
  byCurrency[key] ??= emptyCollectedTotals();
  return byCurrency[key];
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

async function collectStripeMonth(
  stripe: Stripe,
  monthStart: Date,
): Promise<MonthlyCollectedSnapshot> {
  const monthEnd = addUtcMonths(monthStart, 1);
  const created = {
    gte: unixSeconds(monthStart),
    lt: unixSeconds(monthEnd),
  };
  const byCurrency: Record<string, MonthlyCollectedCurrencyTotals> = {};

  for await (const charge of stripe.charges.list({ created, limit: 100 })) {
    if (!charge.paid || charge.status !== "succeeded") {
      continue;
    }

    const totals = getCollectedTotals(byCurrency, charge.currency);
    totals.grossCents += charge.amount;
    totals.chargeCount += 1;
  }

  for await (const refund of stripe.refunds.list({ created, limit: 100 })) {
    if (refund.status && ["failed", "canceled"].includes(refund.status)) {
      continue;
    }

    const totals = getCollectedTotals(byCurrency, refund.currency);
    totals.refundsCents += refund.amount;
    totals.refundCount += 1;
  }

  for await (const dispute of stripe.disputes.list({ created, limit: 100 })) {
    if (dispute.status === "won") {
      continue;
    }

    const totals = getCollectedTotals(byCurrency, dispute.currency);
    totals.disputesCents += dispute.amount;
    totals.disputeCount += 1;
  }

  for (const totals of Object.values(byCurrency)) {
    totals.netCents =
      totals.grossCents - totals.refundsCents - totals.disputesCents;
  }

  return {
    month: formatUtcMonth(monthStart),
    byCurrency,
  };
}

type MetricsUsersDataset = {
  items: Array<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    phone: string | null;
    subscriptionStatus: UserSubscriptionStatus;
    planName: string | null;
    businessCount: number;
    blogCount: number;
    trialStatus: string | null;
    trialStartDate: string | null;
    trialEndDate: string | null;
    createdAt: string;
    primaryBusinessName: string | null;
    primaryBusinessWebsiteUrl: string | null;
    activeBusinessNames: string[];
    activeBusinessUrls: string[];
    websiteStatuses: string[];
    websiteSubscriptionStatuses: string[];
    onboarding: AdminOnboardingSummary;
  }>;
  total: number;
  page: number;
  limit: number;
  summary: {
    totalUsers: number;
    totalPaid: number;
    totalPaidWebsites: number;
    totalTrialWebsites: number;
    totalUsersOnFreeTrial: number;
    totalTrial: number;
    totalExpired: number;
    totalOnboardingNotStarted: number;
    totalOnboardingInProgress: number;
    totalOnboardingCompleted: number;
    totalOnboardingFailed: number;
    totalNeedsFollowUp: number;
  };
};

/**
 * Every user the filters admit, normalised, plus the summary over them.
 *
 * Independent of `page` and `limit` on purpose. The status and onboarding
 * filters and the whole summary are computed here in TypeScript rather than in
 * SQL — `subscriptionStatus` is derived from a trial date, a website status and
 * a website subscription together, and the onboarding state from a session
 * history — so the rows have to be built before they can be counted or
 * filtered. That is why a page of a hundred costs the whole table.
 *
 * Given that, the answer is not to do it per page. Paging is a slice of this,
 * and `metricsUsersDatasetMemo` below makes the twenty-page corpus walk pay for
 * it once.
 */
async function computeMetricsUsersDataset(input: {
  search?: string;
  status?: UserSubscriptionStatus;
  onboarding?: AdminOnboardingFilter;
  maxRows?: number;
}) {
  const search = input.search?.trim() ?? "";
  const statusFilter = input.status;
  const onboardingFilter = input.onboarding;
  const now = new Date();

  const where: Prisma.UserWhereInput = {};
  if (search !== "") {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    take: input.maxRows,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      phone: true,
      trialStatus: true,
      trialStartDate: true,
      trialEndDate: true,
      createdAt: true,
      onboarding: true,
      Subscription: {
        select: {
          planName: true,
        },
      },
      business: {
        where: { isActive: true },
        select: {
          businessName: true,
          businessWebsiteUrl: true,
          websiteStatus: true,
          isPrimary: true,
          websiteSubscription: {
            select: {
              status: true,
              stripeSubscriptionId: true,
              trialStatus: true,
              trialEndDate: true,
            },
          },
        },
      },
      _count: {
        select: { business: true, Blog: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const userIds = users.map((user) => user.id);
  const [quickScrapeSessions, trialAnalytics, onboardingBusinesses] =
    userIds.length > 0
      ? await Promise.all([
          prisma.quickScrapeBusiness.findMany({
            where: { userId: { in: userIds } },
            select: {
              id: true,
              userId: true,
              businessName: true,
              businessWebsiteUrl: true,
              detectedServices: true,
              selectedServices: true,
              onboardingV2Flow: true,
              onboardingV2Step: true,
              onboardingV2QuestionIndex: true,
              onboardingV2Status: true,
              onboardingV2LastSeenAt: true,
              onboardingV2GenerationStartedAt: true,
              onboardingV2BusinessId: true,
              onboardingV2BlogId: true,
              onboardingV2SocialRunId: true,
              onboardingV2BlogStatus: true,
              onboardingV2SocialStatus: true,
              onboardingV2GenerationError: true,
              onboardingV2CompletedAt: true,
              onboardingV2SelectedPlanTier: true,
              contactDetailsConfirmedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          prisma.trialAnalytics.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true,
              onboardingStartedAt: true,
              onboardingCompletedAt: true,
              quickScrapeCompletedAt: true,
              servicesSelectedAt: true,
              trialEnrolledAt: true,
            },
          }),
          prisma.business.findMany({
            where: { userId: { in: userIds } },
            select: {
              id: true,
              userId: true,
              businessName: true,
              businessWebsiteUrl: true,
              isPrimary: true,
              isActive: true,
              websiteStatus: true,
              onboardingFlow: true,
              onboardingStatus: true,
              onboardingAttemptCount: true,
              onboardingLastAttemptAt: true,
              onboardingCompletedAt: true,
              onboardingLastError: true,
              secondaryDetailsConfirmed: true,
              keywordGenerationStatus: true,
              keywordGenerationStartedAt: true,
              keywordGenerationCompletedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
        ])
      : [[], [], []];

  const sessionsByUser = new Map<string, typeof quickScrapeSessions>();
  for (const session of quickScrapeSessions) {
    const current = sessionsByUser.get(session.userId) ?? [];
    current.push(session);
    sessionsByUser.set(session.userId, current);
  }
  const trialByUser = new Map(
    trialAnalytics.map((analytics) => [analytics.userId, analytics]),
  );
  const onboardingBusinessesByUser = new Map<
    string,
    typeof onboardingBusinesses
  >();
  for (const business of onboardingBusinesses) {
    const current = onboardingBusinessesByUser.get(business.userId) ?? [];
    current.push(business);
    onboardingBusinessesByUser.set(business.userId, current);
  }

  const normalizedUsers = users.map((user) => {
    const now = new Date();

    const subscriptionStatus = classifyUserSubscriptionStatus(
      {
        trialStatus: user.trialStatus,
        trialEndDate: user.trialEndDate,
        business: user.business.map((business) => ({
          websiteStatus: business.websiteStatus,
          websiteSubscription: business.websiteSubscription,
        })),
      },
      null,
      now,
    );

    const primaryBusiness =
      user.business.find((business) => business.isPrimary) ?? user.business[0];
    const onboarding = buildAdminOnboardingBreakdown({
      accountCreatedAt: user.createdAt,
      accountOnboardingComplete: user.onboarding,
      followUpEligible: user.role === "USER",
      now,
      sessions: sessionsByUser.get(user.id) ?? [],
      trial: trialByUser.get(user.id) ?? null,
      businesses: onboardingBusinessesByUser.get(user.id) ?? [],
    }).summary;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      subscriptionStatus,
      planName: user.Subscription?.planName ?? null,
      businessCount: user._count.business,
      blogCount: user._count.Blog,
      trialStatus: user.trialStatus,
      trialStartDate: user.trialStartDate?.toISOString() ?? null,
      trialEndDate: user.trialEndDate?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      primaryBusinessName: primaryBusiness?.businessName ?? null,
      primaryBusinessWebsiteUrl: primaryBusiness?.businessWebsiteUrl ?? null,
      activeBusinessNames: user.business
        .map((business) => business.businessName)
        .filter((value): value is string => value !== null && value !== ""),
      activeBusinessUrls: user.business
        .map((business) => business.businessWebsiteUrl)
        .filter((value): value is string => value !== null && value !== ""),
      websiteStatuses: user.business
        .map((business) => business.websiteStatus)
        .filter((value): value is string => value !== null && value !== ""),
      websiteSubscriptionStatuses: user.business
        .map((business) => business.websiteSubscription?.status ?? null)
        .filter((value): value is string => value !== null && value !== ""),
      onboarding,
      businesses: user.business,
    };
  });

  const subscriptionFilteredUsers =
    statusFilter === undefined
      ? normalizedUsers
      : normalizedUsers.filter((user) => user.subscriptionStatus === statusFilter);
  const filteredUsers =
    onboardingFilter === undefined
      ? subscriptionFilteredUsers
      : subscriptionFilteredUsers.filter((user) =>
          onboardingFilter === "needs_follow_up"
            ? user.onboarding.needsFollowUp
            : user.onboarding.state === onboardingFilter,
        );

  const summary = {
    totalUsers: filteredUsers.length,
    totalPaid: 0,
    totalPaidWebsites: 0,
    totalTrialWebsites: 0,
    totalUsersOnFreeTrial: 0,
    totalTrial: 0,
    totalExpired: 0,
    totalOnboardingNotStarted: 0,
    totalOnboardingInProgress: 0,
    totalOnboardingCompleted: 0,
    totalOnboardingFailed: 0,
    totalNeedsFollowUp: 0,
  };

  for (const user of filteredUsers) {
    summary[
      `total${user.subscriptionStatus.charAt(0).toUpperCase() + user.subscriptionStatus.slice(1)}` as
        | "totalPaid"
        | "totalTrial"
        | "totalExpired"
    ] += 1;

    if (user.subscriptionStatus === "trial") {
      summary.totalUsersOnFreeTrial += 1;
    }

    if (user.onboarding.state === "not_started") {
      summary.totalOnboardingNotStarted += 1;
    } else if (user.onboarding.state === "in_progress") {
      summary.totalOnboardingInProgress += 1;
    } else if (user.onboarding.state === "completed") {
      summary.totalOnboardingCompleted += 1;
    } else {
      summary.totalOnboardingFailed += 1;
    }
    if (user.onboarding.needsFollowUp) {
      summary.totalNeedsFollowUp += 1;
    }

    for (const business of user.businesses) {
      const ws = business.websiteSubscription;
      if (!ws) {
        continue;
      }
      const bucket = classifyWebsiteSubscription(ws, now);
      if (bucket === "paid_active") {
        summary.totalPaidWebsites += 1;
      } else if (bucket === "trialing") {
        summary.totalTrialWebsites += 1;
      }
    }
  }

  return { filteredUsers, summary };
}

/**
 * Twenty seconds, which is what a corpus walk plus a reader moving between the
 * panel pages that share it occupies. Long enough to collapse the walk, short
 * enough that a superadmin who just changed something sees it on their next
 * look rather than wondering why the list is stale.
 *
 * Four keys: the filter combinations one reader realistically has open at once.
 */
const metricsUsersDatasetMemo = createSingleFlightMemo<
  Awaited<ReturnType<typeof computeMetricsUsersDataset>>
>({ ttlMs: 20_000, maxEntries: 4 });

async function loadMetricsUsersDataset(input: {
  page: number;
  limit: number;
  search?: string;
  status?: UserSubscriptionStatus;
  onboarding?: AdminOnboardingFilter;
  maxRows?: number;
}): Promise<MetricsUsersDataset> {
  const page = Math.max(1, input.page);
  // The 100 clamp existed to stop a caller asking for the whole table through
  // a paginated endpoint. The validator now caps the public surface at 2000, so
  // this clamps to the same number rather than silently returning a hundred
  // rows to a caller that asked for five hundred — a silent short page is
  // worse than a rejected request.
  const limit =
    input.maxRows !== undefined
      ? Math.max(1, input.limit)
      : Math.min(2000, Math.max(1, input.limit));
  const skip = (page - 1) * limit;
  const filters = {
    search: input.search?.trim() ?? "",
    status: input.status,
    onboarding: input.onboarding,
    maxRows: input.maxRows,
  };
  /**
   * The export path takes its own row cap and is a one-off download, so it does
   * not share a key with the paginated reads and does not want to be held for
   * twenty seconds either.
   */
  const { filteredUsers, summary } =
    input.maxRows !== undefined
      ? await computeMetricsUsersDataset(filters)
      : await metricsUsersDatasetMemo.get(
          JSON.stringify([filters.search, filters.status ?? "", filters.onboarding ?? ""]),
          () => computeMetricsUsersDataset(filters),
        );

  const items = filteredUsers
    .slice(skip, skip + limit)
    .map(({ businesses, ...user }) => user);

  return {
    items,
    total: filteredUsers.length,
    page,
    limit,
    summary,
  };
}

export async function getMetricsOverview(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = OVERVIEW_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const from: Date | undefined = parseOptionalDate(q.data.from);
    const to: Date | undefined = parseOptionalDate(q.data.to);
    const now: Date = new Date();

    const userWhere: Prisma.UserWhereInput = {};
    if (from !== undefined || to !== undefined) {
      userWhere.createdAt = {};
      if (from !== undefined) {
        userWhere.createdAt.gte = from;
      }
      if (to !== undefined) {
        userWhere.createdAt.lte = to;
      }
    }

    const [
      usersByRole,
      websiteSubscriptions,
      usageRows,
      signupsInRange,
    ] = await Promise.all([
      prisma.user.groupBy({
        by: ["role"],
        _count: { id: true },
      }),
      prisma.websiteSubscription.findMany({
        select: {
          status: true,
          stripeSubscriptionId: true,
          trialStatus: true,
          trialEndDate: true,
          business: {
            select: {
              id: true,
              userId: true,
              ownershipType: true,
            },
          },
        },
      }),
      prisma.llmUsageEvent.findMany({
        where: {
          createdAt: {
            gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        select: {
          purpose: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedUsd: true,
          metadata: true,
        },
      }),
      from !== undefined || to !== undefined
        ? prisma.user.count({ where: userWhere })
        : Promise.resolve(null),
    ]);

    const usersWithWebsiteSubscription = new Set<string>();
    let paidSites = 0;
    let trialingSites = 0;
    let otherSites = 0;
    let businessesAgencyManaged = 0;
    let businessesUpliftDirect = 0;

    for (const ws of websiteSubscriptions) {
      usersWithWebsiteSubscription.add(ws.business.userId);
      const bucket = classifyWebsiteSubscription(ws, now);
      if (bucket === "paid_active") {
        paidSites += 1;
      } else if (bucket === "trialing") {
        trialingSites += 1;
      } else {
        otherSites += 1;
      }

      if (bucket === "paid_active" || bucket === "trialing") {
        if (ws.business.ownershipType === "agency_managed") {
          businessesAgencyManaged += 1;
        } else if (ws.business.ownershipType === "uplift_direct") {
          businessesUpliftDirect += 1;
        }
      }
    }

    const imageGenerationUsage = createUsageSummary();
    const aiVisibilityUsage = createUsageSummary();
    for (const row of usageRows as LlmUsageRow[]) {
      if (isImageGenerationUsageRow(row)) {
        addRowToUsageSummary(imageGenerationUsage, row);
      }
      if (isAiVisibilityUsageRow(row)) {
        addRowToUsageSummary(aiVisibilityUsage, row);
      }
    }

    const totalUsers = usersWithWebsiteSubscription.size;
    const totalBusinesses = paidSites + trialingSites;

    const roleCounts: Record<string, number> = {};
    for (const row of usersByRole) {
      roleCounts[row.role] = row._count.id;
    }

    sendSuccess(
      res,
      {
        totals: {
          users: totalUsers,
          activeBusinesses: totalBusinesses,
          expiredBusinesses: otherSites,
          websiteSubscriptions: websiteSubscriptions.length,
        },
        businessesByOwnership: {
          agency_managed: businessesAgencyManaged,
          uplift_direct: businessesUpliftDirect,
        },
        websiteSubscriptionBuckets: {
          paidActive: paidSites,
          trialing: trialingSites,
          expiredOrInactive: otherSites,
        },
        usersByRole: roleCounts,
        usageHighlights: {
          imageGeneration: serializeUsageSummary(imageGenerationUsage),
          aiVisibility: serializeUsageSummary(aiVisibilityUsage),
        },
        signupsInRange: signupsInRange,
      },
      "Overview metrics",
    );
  } catch (e: unknown) {
    sendError(res, "Failed to load overview metrics", 500, e);
  }
}

export async function getMetricsRevenueSummary(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = REVENUE_SUMMARY_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }

    const selectedMonthStart = parseRevenueMonth(q.data.month);
    const selectedMonth = formatUtcMonth(selectedMonthStart);
    const trendMonths = q.data.trendMonths;
    const cacheKey = `revenue-summary:${selectedMonth}:${trendMonths}`;

    const payload: RevenueSummaryPayload = await getRevenueSummaryWithCache(
      cacheKey,
      async (): Promise<RevenueSummaryPayload> => {
        const paying = await prisma.websiteSubscription.findMany({
          where: {
            status: "active",
            stripeSubscriptionId: { not: null },
          },
          select: { stripePriceId: true },
        });
        const countsByPriceId: Record<string, number> = {};
        for (const row of paying) {
          const pid: string = row.stripePriceId ?? "unknown";
          countsByPriceId[pid] = (countsByPriceId[pid] ?? 0) + 1;
        }

        let mrrEstimatedUsd: number | null = null;
        let monthlyCollected: RevenueSummaryPayload["monthlyCollected"] = null;
        const key = process.env.STRIPE_SECRET_KEY;
        if (key) {
          const stripe = new Stripe(key, {
            apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
          });
          let sum = 0;
          let ok = true;
          for (const priceId of Object.keys(countsByPriceId)) {
            if (priceId === "unknown") {
              continue;
            }
            try {
              const price = await stripe.prices.retrieve(priceId);
              const count = countsByPriceId[priceId] ?? 0;
              const unit = price.unit_amount;
              if (unit === null || unit === undefined) {
                continue;
              }
              const dollars = unit / 100;
              if (price.recurring?.interval === "year") {
                sum += (dollars / 12) * count;
              } else {
                sum += dollars * count;
              }
            } catch {
              ok = false;
            }
          }
          if (ok && sum > 0) {
            mrrEstimatedUsd = Math.round(sum * 100) / 100;
          }

          const trendStarts = Array.from({ length: trendMonths }, (_value, index) =>
            addUtcMonths(selectedMonthStart, index - (trendMonths - 1)),
          );
          const trend = await Promise.all(
            trendStarts.map((monthStart) => collectStripeMonth(stripe, monthStart)),
          );
          const selectedSnapshot =
            trend.find((snapshot) => snapshot.month === selectedMonth) ??
            (await collectStripeMonth(stripe, selectedMonthStart));
          monthlyCollected = {
            selectedMonth,
            timezone: "UTC",
            headline: "net",
            byCurrency: selectedSnapshot.byCurrency,
            trend,
          };
        }

        return {
          payingWebsiteSubscriptions: paying.length,
          countsByStripePriceId: countsByPriceId,
          mrrEstimatedUsd,
          monthlyCollected,
        };
      },
    );

    sendSuccess(res, payload, "Revenue summary");
  } catch (e: unknown) {
    sendError(res, "Failed to load revenue summary", 500, e);
  }
}

export async function getMetricsAttribution(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = ATTRIBUTION_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const { page, limit, agencyId } = q.data;
    const skip: number = (page - 1) * limit;
    const where: Prisma.BusinessWhereInput = { isActive: true };
    if (agencyId !== undefined) {
      where.agencyId = agencyId;
    }

    const [total, rows] = await Promise.all([
      prisma.business.count({ where }),
      prisma.business.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          businessName: true,
          businessWebsiteUrl: true,
          ownershipType: true,
          agencyId: true,
          onboardedByUserId: true,
          createdAt: true,
          User: {
            select: { id: true, email: true, name: true },
          },
          agency: { select: { id: true, name: true, slug: true } },
        },
      }),
    ]);

    const onboarderIds: string[] = [
      ...new Set(
        rows
          .map((b) => b.onboardedByUserId)
          .filter((id): id is string => id !== null && id !== ""),
      ),
    ];
    const onboarders =
      onboarderIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: onboarderIds } },
            select: { id: true, email: true, name: true },
          })
        : [];
    const onboarderById: Map<string, { id: string; email: string; name: string }> =
      new Map(onboarders.map((u) => [u.id, u]));

    const items = rows.map((b) => ({
      ...b,
      onboardedBy:
        b.onboardedByUserId !== null
          ? onboarderById.get(b.onboardedByUserId) ?? null
          : null,
    }));

    sendSuccess(
      res,
      {
        page,
        limit,
        total,
        items,
      },
      "Attribution list",
    );
  } catch (e: unknown) {
    sendError(res, "Failed to load attribution", 500, e);
  }
}

export async function getMetricsLlmUsage(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = LLM_USAGE_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const { page, limit, purpose, model, businessId, userId } = q.data;
    /**
     * A window, always.
     *
     * `LlmUsageEvent` gets a row per model call, so it is the fastest-growing
     * table here by a wide margin — and this read loads every matching row, with
     * its JSON metadata and a joined user and business, before slicing out a
     * page of twenty-five. It has to: the summary and the image/AI-visibility
     * classification are derived from that metadata in TypeScript, so the rows
     * must exist before they can be counted.
     *
     * With both dates absent that was the entire table. The panel always sends a
     * range, so the UI never reached it, but the route is relayed and one
     * parameterless request could take the service down. Defaulting the window
     * makes the unparameterised answer bounded and honest — the response says
     * which window it used.
     */
    const requestedFrom = parseOptionalDate(q.data.from);
    const to = parseOptionalDate(q.data.to);
    const from =
      requestedFrom ??
      (to === undefined
        ? new Date(Date.now() - LLM_USAGE_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
        : undefined);
    const skip: number = (page - 1) * limit;

    const baseWhere = buildLlmUsageWhere({
      from,
      to,
      purpose,
      businessId,
    });
    const filteredWhere = buildLlmUsageWhere({
      from,
      to,
      purpose,
      model,
      businessId,
      userId,
    });

    const [allRows, matchingCount, modelOptions, customerOptions] =
      await Promise.all([
      prisma.llmUsageEvent.findMany({
        where: filteredWhere,
        orderBy: { createdAt: "desc" },
        /**
         * A ceiling underneath the window, in case the window is dense.
         *
         * Newest-first, so a truncated read keeps the rows a reader is most
         * likely to want. The count beside it is the real total, so `truncated`
         * below can say the summary covers part of the window rather than
         * quietly reporting a smaller business than there is.
         */
        take: LLM_USAGE_MAX_ROWS,
        select: {
          id: true,
          createdAt: true,
          purpose: true,
          provider: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedUsd: true,
          metadata: true,
          userId: true,
          businessId: true,
          blogId: true,
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          business: {
            select: {
              id: true,
              businessName: true,
              businessWebsiteUrl: true,
            },
          },
        },
      }),
      prisma.llmUsageEvent.count({ where: filteredWhere }),
      prisma.llmUsageEvent.groupBy({
        by: ["model"],
        where: baseWhere,
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.user.findMany({
        where: {
          LlmUsageEvents: {
            some: baseWhere,
          },
        },
        select: {
          id: true,
          email: true,
          name: true,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
      }),
    ]);

    const aggregate = {
      eventCount: 0,
      sumEstimatedUsd: 0,
      sumInputTokens: 0,
      sumOutputTokens: 0,
      sumTotalTokens: 0,
    };
    const byPurpose = new Map<
      string,
      { purpose: string; count: number; sumEstimatedUsd: number }
    >();
    const byModel = new Map<
      string,
      {
        model: string;
        count: number;
        sumEstimatedUsd: number;
        sumInputTokens: number;
        sumOutputTokens: number;
        sumTotalTokens: number;
      }
    >();
    const byCustomer = new Map<
      string,
      {
        userId: string;
        email: string;
        name: string;
        count: number;
        sumEstimatedUsd: number;
        sumInputTokens: number;
        sumOutputTokens: number;
        sumTotalTokens: number;
      }
    >();
    const imageGenerationUsage = createUsageSummary();
    const aiVisibilityUsage = createUsageSummary();

    for (const row of allRows as LlmUsageRow[]) {
      const estimatedUsd = getLlmRowEstimatedUsd(row) ?? 0;
      const inputTokens = row.inputTokens ?? 0;
      const outputTokens = row.outputTokens ?? 0;
      const totalTokens = row.totalTokens ?? inputTokens + outputTokens;

      aggregate.eventCount += 1;
      aggregate.sumEstimatedUsd += estimatedUsd;
      aggregate.sumInputTokens += inputTokens;
      aggregate.sumOutputTokens += outputTokens;
      aggregate.sumTotalTokens += totalTokens;

      if (isImageGenerationUsageRow(row)) {
        addRowToUsageSummary(imageGenerationUsage, row);
      }
      if (isAiVisibilityUsageRow(row)) {
        addRowToUsageSummary(aiVisibilityUsage, row);
      }

      const purposeBucket = byPurpose.get(row.purpose) ?? {
        purpose: row.purpose,
        count: 0,
        sumEstimatedUsd: 0,
      };
      purposeBucket.count += 1;
      purposeBucket.sumEstimatedUsd += estimatedUsd;
      byPurpose.set(row.purpose, purposeBucket);

      const modelBucket = byModel.get(row.model) ?? {
        model: row.model,
        count: 0,
        sumEstimatedUsd: 0,
        sumInputTokens: 0,
        sumOutputTokens: 0,
        sumTotalTokens: 0,
      };
      modelBucket.count += 1;
      modelBucket.sumEstimatedUsd += estimatedUsd;
      modelBucket.sumInputTokens += inputTokens;
      modelBucket.sumOutputTokens += outputTokens;
      modelBucket.sumTotalTokens += totalTokens;
      byModel.set(row.model, modelBucket);

      if (row.userId && row.user) {
        const customerBucket = byCustomer.get(row.userId) ?? {
          userId: row.user.id,
          email: row.user.email,
          name: row.user.name,
          count: 0,
          sumEstimatedUsd: 0,
          sumInputTokens: 0,
          sumOutputTokens: 0,
          sumTotalTokens: 0,
        };
        customerBucket.count += 1;
        customerBucket.sumEstimatedUsd += estimatedUsd;
        customerBucket.sumInputTokens += inputTokens;
        customerBucket.sumOutputTokens += outputTokens;
        customerBucket.sumTotalTokens += totalTokens;
        byCustomer.set(row.userId, customerBucket);
      }
    }

    const pagedRows = allRows.slice(skip, skip + limit);

    sendSuccess(
      res,
      {
        page,
        limit,
        total: matchingCount,
        /**
         * Whether the figures below cover the whole window.
         *
         * `total` is the real count and the summary is computed over the rows
         * actually loaded. When those differ, every aggregate here is a floor,
         * not a total, and the reader is told so rather than shown a number that
         * looks complete.
         */
        truncated: matchingCount > allRows.length,
        loadedRowCount: allRows.length,
        window: {
          from: from?.toISOString() ?? null,
          to: to?.toISOString() ?? null,
          defaultedFrom: q.data.from === undefined && to === undefined,
          defaultWindowDays: LLM_USAGE_DEFAULT_WINDOW_DAYS,
        },
        aggregate: {
          eventCount: aggregate.eventCount,
          sumEstimatedUsd: aggregate.sumEstimatedUsd.toFixed(6),
          sumInputTokens: aggregate.sumInputTokens,
          sumOutputTokens: aggregate.sumOutputTokens,
          sumTotalTokens: aggregate.sumTotalTokens,
        },
        byPurpose: Array.from(byPurpose.values())
          .sort((left, right) => right.sumEstimatedUsd - left.sumEstimatedUsd)
          .map((entry) => ({
            ...entry,
            sumEstimatedUsd: entry.sumEstimatedUsd.toFixed(6),
          })),
        byModel: Array.from(byModel.values())
          .sort((left, right) => right.sumEstimatedUsd - left.sumEstimatedUsd)
          .map((entry) => ({
            ...entry,
            sumEstimatedUsd: entry.sumEstimatedUsd.toFixed(6),
          })),
        byCustomer: Array.from(byCustomer.values())
          .sort((left, right) => right.sumEstimatedUsd - left.sumEstimatedUsd)
          .map((entry) => ({
            ...entry,
            sumEstimatedUsd: entry.sumEstimatedUsd.toFixed(6),
          })),
        specialUsage: {
          imageGeneration: serializeUsageSummary(imageGenerationUsage),
          aiVisibility: serializeUsageSummary(aiVisibilityUsage),
        },
        filters: {
          models: modelOptions.map((entry) => entry.model),
          customers: customerOptions.map((customer) => ({
            id: customer.id,
            email: customer.email,
            name: customer.name,
          })),
        },
        recentEvents: pagedRows.map((row) => ({
          ...row,
          estimatedUsd:
            getLlmRowEstimatedUsd(row as LlmUsageRow)?.toFixed(6) ?? null,
          user: row.user,
          business: row.business,
        })),
      },
      "LLM usage metrics",
    );
  } catch (e: unknown) {
    sendError(res, "Failed to load LLM usage", 500, e);
  }
}

export async function exportMetricsLlmUsageCsv(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId: string | undefined = req.authUserId;
    if (adminUserId === undefined || adminUserId === "") {
      sendError(res, "Unauthorized", 401);
      return;
    }
    const q = LLM_USAGE_EXPORT_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const { purpose, model, businessId, userId } = q.data;
    const from = parseOptionalDate(q.data.from);
    const to = parseOptionalDate(q.data.to);

    const where = buildLlmUsageWhere({
      from,
      to,
      purpose,
      model,
      businessId,
      userId,
    });

    const rows = await prisma.llmUsageEvent.findMany({
      where,
      take: LLM_EXPORT_MAX_ROWS,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        purpose: true,
        provider: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        estimatedUsd: true,
        userId: true,
        businessId: true,
        blogId: true,
        correlationId: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
          },
        },
      },
    });

    await prisma.adminAuditLog.create({
      data: {
        adminUserId,
        action: "metrics.llm_usage.export",
        targetType: "Platform",
        targetId: "llm-usage",
        details: {
          rowCount: rows.length,
          filters: q.data,
        },
      },
    });

    const header: string =
      "id,createdAt,purpose,provider,model,inputTokens,outputTokens,totalTokens,estimatedUsd,userId,userEmail,userName,businessId,businessName,businessWebsiteUrl,blogId,correlationId";
    const lines: string[] = rows.map((r) => {
      const usd = getLlmRowEstimatedUsd(r as LlmUsageRow);
      return [
        csvEscape(r.id),
        csvEscape(r.createdAt.toISOString()),
        csvEscape(r.purpose),
        csvEscape(r.provider),
        csvEscape(r.model),
        csvEscape(r.inputTokens !== null && r.inputTokens !== undefined ? String(r.inputTokens) : ""),
        csvEscape(r.outputTokens !== null && r.outputTokens !== undefined ? String(r.outputTokens) : ""),
        csvEscape(r.totalTokens !== null && r.totalTokens !== undefined ? String(r.totalTokens) : ""),
        csvEscape(usd !== null ? usd.toFixed(6) : ""),
        csvEscape(r.userId ?? ""),
        csvEscape(r.user?.email ?? ""),
        csvEscape(r.user?.name ?? ""),
        csvEscape(r.businessId ?? ""),
        csvEscape(r.business?.businessName ?? ""),
        csvEscape(r.business?.businessWebsiteUrl ?? ""),
        csvEscape(r.blogId ?? ""),
        csvEscape(r.correlationId ?? ""),
      ].join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="llm-usage-export.csv"',
    );
    res.status(200).send([header, ...lines].join("\n"));
  } catch (e: unknown) {
    sendError(res, "Failed to export LLM usage", 500, e);
  }
}

export async function getMetricsApiTokens(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = API_TOKENS_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const { page, limit, businessId, userId } = q.data;
    const from = parseOptionalDate(q.data.from);
    const to = parseOptionalDate(q.data.to);
    const activeOnly = q.data.activeOnly === "true";
    const skip: number = (page - 1) * limit;

    const where: Prisma.ApiTokenWhereInput = {};
    if (from !== undefined || to !== undefined) {
      where.createdAt = {};
      if (from !== undefined) {
        where.createdAt.gte = from;
      }
      if (to !== undefined) {
        where.createdAt.lte = to;
      }
    }
    if (businessId !== undefined) {
      where.businessId = businessId;
    }
    if (userId !== undefined) {
      where.userId = userId;
    }
    if (activeOnly) {
      where.isActive = true;
    }

    const [total, items] = await Promise.all([
      prisma.apiToken.count({ where }),
      prisma.apiToken.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          tokenPrefix: true,
          isActive: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          connectedSiteUrlAtCreation: true,
          connectedBusinessNameAtCreation: true,
          user: { select: { id: true, email: true, name: true } },
          business: {
            select: {
              id: true,
              businessName: true,
              businessWebsiteUrl: true,
            },
          },
        },
      }),
    ]);

    sendSuccess(
      res,
      { page, limit, total, items },
      "API token list",
    );
  } catch (e: unknown) {
    sendError(res, "Failed to load API tokens", 500, e);
  }
}

export async function getMetricsBlogsDaily(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = BLOGS_DAILY_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }
    const fromD = parseOptionalDate(q.data.from);
    const toD = parseOptionalDate(q.data.to);
    if (fromD === undefined || toD === undefined) {
      sendError(res, "from and to (ISO dates) are required", 400);
      return;
    }
    const rangeStart = startOfUtcDay(fromD);
    const rangeEnd = endOfUtcDay(toD);
    const { page, limit, userId } = q.data;
    const skip: number = (page - 1) * limit;

    const where: Prisma.PublishedBlogWhereInput = {
      AND: [
        { publishedAt: { not: null } },
        { publishedAt: { gte: rangeStart, lte: rangeEnd } },
      ],
      ...(userId ? { blog: { userId } } : {}),
    };

    const [total, rows, customers] = await Promise.all([
      prisma.publishedBlog.count({ where }),
      prisma.publishedBlog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { publishedAt: "desc" },
        select: {
          id: true,
          publishedAt: true,
          platform: true,
          externalPostUrl: true,
          status: true,
          blog: {
            select: {
              id: true,
              title: true,
              slug: true,
              userId: true,
              businessId: true,
              user: { select: { id: true, email: true, name: true } },
              business: {
                select: {
                  id: true,
                  businessName: true,
                  businessWebsiteUrl: true,
                },
              },
            },
          },
          integration: {
            select: {
              id: true,
              platform: true,
              wordpressUrl: true,
              webflowSiteId: true,
            },
          },
        },
      }),
      prisma.user.findMany({
        where: {
          Blog: {
            some: {
              publishedBlogs: {
                some: {
                  publishedAt: { gte: rangeStart, lte: rangeEnd },
                },
              },
            },
          },
        },
        select: {
          id: true,
          email: true,
          name: true,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
      }),
    ]);

    sendSuccess(
      res,
      {
        page,
        limit,
        total,
        range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
        items: rows,
        filters: {
          customers: customers.map((customer) => ({
            id: customer.id,
            email: customer.email,
            name: customer.name,
          })),
        },
      },
      "Daily published blogs",
    );
  } catch (e: unknown) {
    sendError(res, "Failed to load daily publishes", 500, e);
  }
}

function parseDailyMetricsRange(query: unknown) {
  const parsed = DAILY_METRICS_QUERY.safeParse(query);
  if (!parsed.success) return { error: parsed.error } as const;
  try {
    const range = commandDayRange(parsed.data.from, parsed.data.to);
    if (range.dayCount > 3_660) {
      return { error: new Error("Date range cannot exceed 3660 days") } as const;
    }
    const previousTo = shiftCommandDay(range.from, -1);
    const previousFrom = shiftCommandDay(previousTo, -(range.dayCount - 1));
    return { range, previousFrom, previousTo } as const;
  } catch (error) {
    return { error } as const;
  }
}

export async function getMetricsUsersDaily(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseDailyMetricsRange(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid query", 400, parsed.error);
      return;
    }

    const users = await prisma.user.findMany({
      select: {
        createdAt: true,
        trialStatus: true,
        trialEndDate: true,
        business: {
          where: { isActive: true },
          select: {
            websiteStatus: true,
            websiteSubscription: {
              select: {
                status: true,
                stripeSubscriptionId: true,
                trialStatus: true,
                trialEndDate: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const now = new Date();
    const metrics = buildDailyUserMetrics({
      users: users.map((user) => ({
        createdAt: user.createdAt,
        status: classifyUserSubscriptionStatus(
          {
            trialStatus: user.trialStatus,
            trialEndDate: user.trialEndDate,
            business: user.business,
          },
          null,
          now,
        ),
      })),
      from: parsed.range.from,
      to: parsed.range.to,
      previousFrom: parsed.previousFrom,
      previousTo: parsed.previousTo,
    });

    sendSuccess(
      res,
      {
        range: {
          from: parsed.range.from,
          to: parsed.range.to,
          start: parsed.range.start.toISOString(),
          endExclusive: parsed.range.end.toISOString(),
          dayCount: parsed.range.dayCount,
          timeZone: parsed.range.timeZone,
        },
        previousRange: {
          from: parsed.previousFrom,
          to: parsed.previousTo,
        },
        ...metrics,
      },
      "Daily user metrics",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to load daily user metrics", 500, error);
  }
}

export async function getMetricsPaymentsDaily(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseDailyMetricsRange(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid query", 400, parsed.error);
      return;
    }

    const payments = await prisma.commandStripeInvoice.findMany({
      where: {
        paidAt: { gte: parsed.range.start, lt: parsed.range.end },
        amountPaidMinor: { gt: 0 },
      },
      select: {
        paidAt: true,
        amountPaidMinor: true,
        currency: true,
        billingReason: true,
      },
      orderBy: { paidAt: "asc" },
    });
    const metrics = buildDailyPaymentMetrics({
      payments: payments.flatMap((payment) => {
        if (!payment.paidAt) return [];
        return [
          {
            paidAt: payment.paidAt,
            amountPaidMinor: Number(payment.amountPaidMinor.toString()),
            currency: payment.currency,
            billingReason: payment.billingReason,
          },
        ];
      }),
      from: parsed.range.from,
      to: parsed.range.to,
    });

    sendSuccess(
      res,
      {
        range: {
          from: parsed.range.from,
          to: parsed.range.to,
          start: parsed.range.start.toISOString(),
          endExclusive: parsed.range.end.toISOString(),
          dayCount: parsed.range.dayCount,
          timeZone: parsed.range.timeZone,
        },
        source: "command_stripe_invoice",
        ...metrics,
      },
      "Daily payment metrics",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to load daily payment metrics", 500, error);
  }
}

export async function getMetricsInngest(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const q = INNGEST_METRICS_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }

    const payload = await getCoreInngestMetrics({
      headers: req.headers,
      limit: q.data.limit,
    });
    sendSuccess(res, payload, "Inngest metrics");
  } catch (e: unknown) {
    sendError(res, "Failed to load Inngest metrics", 500, e);
  }
}

export async function getMetricsUsers(req: Request, res: Response) {
  try {
    const q = USERS_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }

    const data = await loadMetricsUsersDataset({
      page: q.data.page,
      limit: q.data.limit,
      search: q.data.search,
      status: q.data.status,
      onboarding: q.data.onboarding,
    });

    return res.json({
      success: true,
      message: "Users retrieved",
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("getMetricsUsers error:", error);
    return sendError(res, "Failed to fetch users", 500);
  }
}

export async function exportMetricsUsers(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (adminUserId === undefined || adminUserId === "") {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const q = USERS_EXPORT_QUERY.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Invalid query", 400, q.error);
      return;
    }

    const data = await loadMetricsUsersDataset({
      page: 1,
      limit: USERS_EXPORT_MAX_ROWS,
      search: q.data.search,
      status: q.data.status,
      onboarding: q.data.onboarding,
      maxRows: USERS_EXPORT_MAX_ROWS,
    });

    await prisma.adminAuditLog.create({
      data: {
        adminUserId,
        action: "metrics.users.export",
        targetType: "Platform",
        targetId: "users",
        details: {
          rowCount: data.items.length,
          format: q.data.format,
          filters: {
            search: q.data.search ?? "",
            status: q.data.status ?? null,
            onboarding: q.data.onboarding ?? null,
          },
        },
      },
    });

    if (q.data.format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="users-export.json"',
      );
      res.status(200).send(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            filters: {
              search: q.data.search ?? "",
              status: q.data.status ?? null,
              onboarding: q.data.onboarding ?? null,
            },
            summary: data.summary,
            rowCount: data.items.length,
            items: data.items,
          },
          null,
          2,
        ),
      );
      return;
    }

    const header =
      "id,email,name,role,phone,subscriptionStatus,planName,trialStatus,trialStartDate,trialEndDate,createdAt,businessCount,blogCount,onboardingState,onboardingStep,onboardingProgressPercent,onboardingFlow,onboardingLastActivityAt,onboardingInactiveHours,needsFollowUp,followUpReason,onboardingSessionCount,primaryBusinessName,primaryBusinessWebsiteUrl,activeBusinessNames,activeBusinessUrls,websiteStatuses,websiteSubscriptionStatuses";
    const lines = data.items.map((user) =>
      [
        csvEscape(user.id),
        csvEscape(user.email),
        csvEscape(user.name ?? ""),
        csvEscape(user.role),
        csvEscape(user.phone ?? ""),
        csvEscape(user.subscriptionStatus),
        csvEscape(user.planName ?? ""),
        csvEscape(user.trialStatus ?? ""),
        csvEscape(user.trialStartDate ?? ""),
        csvEscape(user.trialEndDate ?? ""),
        csvEscape(user.createdAt),
        csvEscape(String(user.businessCount)),
        csvEscape(String(user.blogCount)),
        csvEscape(user.onboarding.state),
        csvEscape(user.onboarding.currentStepLabel),
        csvEscape(String(user.onboarding.progressPercent)),
        csvEscape(user.onboarding.flowLabel ?? ""),
        csvEscape(user.onboarding.lastActivityAt ?? ""),
        csvEscape(
          user.onboarding.inactiveHours === null
            ? ""
            : String(user.onboarding.inactiveHours),
        ),
        csvEscape(String(user.onboarding.needsFollowUp)),
        csvEscape(user.onboarding.followUpReason ?? ""),
        csvEscape(String(user.onboarding.sessionCount)),
        csvEscape(user.primaryBusinessName ?? ""),
        csvEscape(user.primaryBusinessWebsiteUrl ?? ""),
        csvEscape(user.activeBusinessNames.join(" | ")),
        csvEscape(user.activeBusinessUrls.join(" | ")),
        csvEscape(user.websiteStatuses.join(" | ")),
        csvEscape(user.websiteSubscriptionStatuses.join(" | ")),
      ].join(","),
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="users-export.csv"',
    );
    res.status(200).send([header, ...lines].join("\n"));
  } catch (error: unknown) {
    sendError(res, "Failed to export users", 500, error);
  }
}

export async function getMetricsBlogGeneration(req: Request, res: Response) {
  try {
    const query = BLOG_GENERATION_METRICS_QUERY.parse(req.query);
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = startOfUtcDay(parseOptionalDate(query.from) ?? defaultFrom);
    const to = endOfUtcDay(parseOptionalDate(query.to) ?? now);
    const rows = await prisma.blogGenerationRun.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.model ? { model: query.model } : {}),
        ...(query.businessId ? { businessId: query.businessId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 5_000,
    });

    const statusCounts: Record<string, number> = {};
    const rejectionReasons: Record<string, number> = {};
    let repairedRuns = 0;
    let fallbackRuns = 0;
    let acceptedCost = 0;
    let acceptedRuns = 0;
    let judgeTotal = 0;
    let judgedRuns = 0;

    for (const row of rows) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
      if (row.repairCount > 0) repairedRuns += 1;
      if (row.fallbackUsed) fallbackRuns += 1;
      if (row.status === "ACCEPTED") {
        acceptedRuns += 1;
        acceptedCost += row.estimatedUsd ? Number(row.estimatedUsd) : 0;
      }
      if (typeof row.judgeScore === "number") {
        judgeTotal += row.judgeScore;
        judgedRuns += 1;
      }
      const validation = asMetadataRecord(row.validationFailures);
      const failures = Array.isArray(validation?.failures)
        ? validation.failures
        : [];
      for (const failure of failures) {
        if (!failure || typeof failure !== "object" || Array.isArray(failure)) {
          continue;
        }
        const kind = (failure as Record<string, unknown>).issueKind;
        if (typeof kind === "string") {
          rejectionReasons[kind] = (rejectionReasons[kind] ?? 0) + 1;
        }
      }
    }

    const completed = rows.filter((row) => row.status !== "RUNNING").length;
    return sendSuccess(
      res,
      {
        range: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          runs: rows.length,
          completed,
          accepted: acceptedRuns,
          passRate: completed > 0 ? acceptedRuns / completed : 0,
          repairRate: completed > 0 ? repairedRuns / completed : 0,
          fallbackRate: completed > 0 ? fallbackRuns / completed : 0,
          averageJudgeScore: judgedRuns > 0 ? judgeTotal / judgedRuns : null,
          costPerAcceptedArticle:
            acceptedRuns > 0 ? acceptedCost / acceptedRuns : null,
        },
        statusCounts,
        rejectionReasons,
        recentRuns: rows.slice(0, 100).map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          completedAt: row.completedAt,
          correlationId: row.correlationId,
          businessId: row.businessId,
          provider: row.provider,
          model: row.model,
          approvedTitle: row.approvedTitle,
          status: row.status,
          repairCount: row.repairCount,
          judgeScore: row.judgeScore,
          fallbackUsed: row.fallbackUsed,
          fallbackReason: row.fallbackReason,
          estimatedUsd: row.estimatedUsd ? Number(row.estimatedUsd) : null,
          factPacketHash: row.factPacketHash,
          durationMs: row.durationMs,
          errorCode: row.errorCode,
          errorMessage: row.errorMessage,
        })),
      },
      "Blog generation metrics",
    );
  } catch (error) {
    console.error("getMetricsBlogGeneration error:", error);
    return sendError(
      res,
      "Failed to fetch blog generation metrics",
      500,
      error,
    );
  }
}

export async function getMetricsUserDetail(req: Request, res: Response) {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required", data: null, timestamp: new Date().toISOString() });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        phone: true,
        trialStatus: true,
        trialStartDate: true,
        trialEndDate: true,
        trialUsed: true,
        onboarding: true,
        createdAt: true,
        Subscription: {
          select: {
            planName: true,
            status: true,
            stripeCustomerId: true,
            stripeSubscriptionId: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
          },
        },
        business: {
          where: { isActive: true },
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            websiteStatus: true,
            isPrimary: true,
            createdAt: true,
            websiteSubscription: {
              select: {
                status: true,
                stripeSubscriptionId: true,
                trialStatus: true,
                trialEndDate: true,
              },
            },
            _count: { select: { Plan: true, Blog: true } },
            PublishingIntegrations: {
              where: { isActive: true },
              select: { platform: true, autoPublish: true, wordpressUrl: true },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        Blog: {
          take: 20,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            title: true,
            seoScore: true,
            blogPublishDate: true,
            status: true,
            createdAt: true,
            business: { select: { id: true, businessName: true } },
            publishedBlogs: {
              select: {
                platform: true,
                externalPostUrl: true,
                status: true,
                publishedAt: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found", data: null, timestamp: new Date().toISOString() });
    }

    const [quickScrapeSessions, trialAnalytics, onboardingBusinesses] =
      await Promise.all([
        prisma.quickScrapeBusiness.findMany({
          where: { userId },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            detectedServices: true,
            selectedServices: true,
            onboardingV2Flow: true,
            onboardingV2Step: true,
            onboardingV2QuestionIndex: true,
            onboardingV2Status: true,
            onboardingV2LastSeenAt: true,
            onboardingV2GenerationStartedAt: true,
            onboardingV2BusinessId: true,
            onboardingV2BlogId: true,
            onboardingV2SocialRunId: true,
            onboardingV2BlogStatus: true,
            onboardingV2SocialStatus: true,
            onboardingV2GenerationError: true,
            onboardingV2CompletedAt: true,
            onboardingV2SelectedPlanTier: true,
            contactDetailsConfirmedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.trialAnalytics.findUnique({
          where: { userId },
          select: {
            onboardingStartedAt: true,
            onboardingCompletedAt: true,
            quickScrapeCompletedAt: true,
            servicesSelectedAt: true,
            trialEnrolledAt: true,
            firstLoginAt: true,
            lastLoginAt: true,
            totalLogins: true,
            dashboardVisits: true,
            blogsViewed: true,
            keywordsViewed: true,
            firstBlogGeneratedAt: true,
            totalBlogsGenerated: true,
            totalKeywordsGenerated: true,
            upgradeCTAClicked: true,
            pricingPageVisited: true,
            checkoutStarted: true,
            checkoutCompletedAt: true,
            converted: true,
            convertedAt: true,
            abTestVariant: true,
            abTestGroup: true,
            welcomeEmailSent: true,
            welcomeEmailOpenedAt: true,
            firstBlogEmailSent: true,
            firstBlogEmailOpenedAt: true,
            expiringEmailSent: true,
            expiringEmailOpenedAt: true,
            expiredEmailSent: true,
            expiredEmailOpenedAt: true,
            trialEndedAt: true,
            trialOutcome: true,
            cancellationReason: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.business.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            isPrimary: true,
            isActive: true,
            websiteStatus: true,
            onboardingFlow: true,
            onboardingStatus: true,
            onboardingAttemptCount: true,
            onboardingLastAttemptAt: true,
            onboardingCompletedAt: true,
            onboardingLastError: true,
            secondaryDetailsConfirmed: true,
            keywordGenerationStatus: true,
            keywordGenerationStartedAt: true,
            keywordGenerationCompletedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

    const now = new Date();
    const onboarding = buildAdminOnboardingBreakdown({
      accountCreatedAt: user.createdAt,
      accountOnboardingComplete: user.onboarding,
      followUpEligible: user.role === "USER",
      now,
      sessions: quickScrapeSessions,
      trial: trialAnalytics,
      businesses: onboardingBusinesses,
    });
    const onboardingByBusinessId = new Map(
      onboarding.businesses.map((business) => [business.id, business]),
    );

    const subscriptionStatus = classifyUserSubscriptionStatus(
      {
        trialStatus: user.trialStatus,
        trialEndDate: user.trialEndDate,
        business: user.business.map((business) => ({
          websiteStatus: business.websiteStatus,
          websiteSubscription: business.websiteSubscription,
        })),
      },
      user.Subscription,
      now,
    );

    const stripeDashboardUrl = user.Subscription?.stripeCustomerId
      ? `https://dashboard.stripe.com/customers/${user.Subscription.stripeCustomerId}`
      : null;

    return res.json({
      success: true,
      message: "User detail retrieved",
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          phone: user.phone,
          trialStatus: user.trialStatus,
          trialStartDate: user.trialStartDate,
          trialEndDate: user.trialEndDate,
          trialUsed: user.trialUsed,
          onboarding: user.onboarding,
          createdAt: user.createdAt,
          subscriptionStatus,
        },
        subscription: user.Subscription
          ? {
              planName: user.Subscription.planName,
              status: user.Subscription.status,
              stripeCustomerId: user.Subscription.stripeCustomerId,
              stripeSubscriptionId: user.Subscription.stripeSubscriptionId,
              currentPeriodEnd: user.Subscription.currentPeriodEnd,
              cancelAtPeriodEnd: user.Subscription.cancelAtPeriodEnd,
              stripeDashboardUrl,
            }
          : null,
        businesses: user.business.map((b) => {
          const billingBucket = b.websiteSubscription
            ? classifyWebsiteSubscription(b.websiteSubscription, now)
            : "expired_or_inactive";

          return {
            id: b.id,
            businessName: b.businessName,
            businessWebsiteUrl: b.businessWebsiteUrl,
            websiteStatus: b.websiteStatus,
            isPrimary: b.isPrimary,
            websiteBillingStatus:
              billingBucket === "paid_active"
                ? "paid"
                : billingBucket === "trialing"
                  ? "trial"
                  : "expired",
            websiteSubscriptionStatus: b.websiteSubscription?.status || null,
            keywordCount: b._count.Plan,
            blogCount: b._count.Blog,
            integrations: b.PublishingIntegrations.map((i) => ({
              platform: i.platform,
              autoPublish: i.autoPublish,
              wordpressUrl: i.wordpressUrl,
            })),
            onboarding: onboardingByBusinessId.get(b.id) ?? null,
          };
        }),
        onboarding,
        engagement: trialAnalytics
          ? {
              firstLoginAt: trialAnalytics.firstLoginAt,
              lastLoginAt: trialAnalytics.lastLoginAt,
              totalLogins: trialAnalytics.totalLogins,
              dashboardVisits: trialAnalytics.dashboardVisits,
              blogsViewed: trialAnalytics.blogsViewed,
              keywordsViewed: trialAnalytics.keywordsViewed,
              firstBlogGeneratedAt: trialAnalytics.firstBlogGeneratedAt,
              totalBlogsGenerated: trialAnalytics.totalBlogsGenerated,
              totalKeywordsGenerated: trialAnalytics.totalKeywordsGenerated,
              upgradeCTAClicked: trialAnalytics.upgradeCTAClicked,
              pricingPageVisited: trialAnalytics.pricingPageVisited,
              checkoutStarted: trialAnalytics.checkoutStarted,
              checkoutCompletedAt: trialAnalytics.checkoutCompletedAt,
              converted: trialAnalytics.converted,
              convertedAt: trialAnalytics.convertedAt,
              abTestVariant: trialAnalytics.abTestVariant,
              abTestGroup: trialAnalytics.abTestGroup,
              emails: {
                welcome: {
                  sent: trialAnalytics.welcomeEmailSent,
                  openedAt: trialAnalytics.welcomeEmailOpenedAt,
                },
                firstBlog: {
                  sent: trialAnalytics.firstBlogEmailSent,
                  openedAt: trialAnalytics.firstBlogEmailOpenedAt,
                },
                expiring: {
                  sent: trialAnalytics.expiringEmailSent,
                  openedAt: trialAnalytics.expiringEmailOpenedAt,
                },
                expired: {
                  sent: trialAnalytics.expiredEmailSent,
                  openedAt: trialAnalytics.expiredEmailOpenedAt,
                },
              },
              trialEndedAt: trialAnalytics.trialEndedAt,
              trialOutcome: trialAnalytics.trialOutcome,
              cancellationReason: trialAnalytics.cancellationReason,
              trackingStartedAt: trialAnalytics.createdAt,
              trackingUpdatedAt: trialAnalytics.updatedAt,
            }
          : null,
        recentBlogs: user.Blog.map((blog) => ({
          id: blog.id,
          title: blog.title,
          seoScore: blog.seoScore,
          blogPublishDate: blog.blogPublishDate,
          status: blog.status,
          businessName: blog.business?.businessName || null,
          publishedUrls: blog.publishedBlogs.map((pb) => ({
            platform: pb.platform,
            externalPostUrl: pb.externalPostUrl,
            status: pb.status,
            publishedAt: pb.publishedAt,
          })),
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("getMetricsUserDetail error:", error);
    return sendError(res, "Failed to fetch user detail", 500);
  }
}

/**
 * Signups, publishes and model spend for the last N months, in one call.
 *
 * The admin built this by asking three endpoints per month — metrics/overview,
 * metrics/blogs/daily and metrics/llm-usage — each returning a full envelope so
 * one aggregate could be read off it. Twelve months meant 36 HTTP round trips
 * through the relay, measured at 5.3 seconds of the sixteen the page took to
 * render. The queries were never the problem; the round trips were.
 *
 * Same three aggregations, same definitions, run server-side in parallel and
 * returned once. Month boundaries follow the reporting timezone, so a signup at
 * 8pm on the 31st lands in the month a person would put it in.
 */
export async function getMetricsMonthlyPerformance(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const requested = Number.parseInt(String(req.query.months ?? "12"), 10);
    const monthCount =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, 36) : 12;

    const months = commandMonthsEndingAt(currentCommandMonth(), monthCount);

    const rows = await Promise.all(
      months.map(async (month) => {
        const period = commandMonthRange(month);
        const [signups, blogsPublished, llmCost] = await Promise.all([
          prisma.user.count({
            where: { createdAt: { gte: period.start, lt: period.end } },
          }),
          prisma.publishedBlog.count({
            where: {
              publishedAt: { not: null, gte: period.start, lt: period.end },
            },
          }),
          prisma.llmUsageEvent.aggregate({
            where: { createdAt: { gte: period.start, lt: period.end } },
            _sum: { estimatedUsd: true },
          }),
        ]);
        const cost = llmCost._sum.estimatedUsd;
        return {
          month,
          signups,
          blogsPublished,
          // Null rather than zero when nothing was recorded: a month with no
          // usage rows is not the same as a month that cost nothing.
          llmCostUsd: cost === null ? null : Number(cost.toFixed(6)),
        };
      }),
    );

    sendSuccess(
      res,
      { months: rows, timeZone: COMMAND_TIME_ZONE },
      "Monthly performance",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to load monthly performance", 500, error);
  }
}
