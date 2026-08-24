import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient();

type PlanRow = Awaited<ReturnType<typeof loadDuePlans>>[number];

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateArg(index: number, fallback: string): Date {
  const raw = process.argv[index] ?? fallback;
  const date = new Date(`${raw.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date argument: ${raw}`);
  }
  return date;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(date: Date): Date {
  return new Date(`${dayKey(date)}T00:00:00.000Z`);
}

function parsePlanDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((dayStart(later).getTime() - dayStart(earlier).getTime()) / DAY_MS);
}

function ageBucket(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 0) return "future";
  if (days === 0) return "same_day";
  if (days <= 2) return "1_2_days_old";
  if (days <= 7) return "3_7_days_old";
  if (days <= 14) return "8_14_days_old";
  if (days <= 30) return "15_30_days_old";
  if (days <= 60) return "31_60_days_old";
  return "over_60_days_old";
}

function addCount(map: Map<string, number>, key: string, count = 1) {
  map.set(key, (map.get(key) ?? 0) + count);
}

function toSortedCounts(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function minString(current: string | null, next: string | null | undefined): string | null {
  if (!next) return current;
  if (!current) return next;
  return next < current ? next : current;
}

function maxString(current: string | null, next: string | null | undefined): string | null {
  if (!next) return current;
  if (!current) return next;
  return next > current ? next : current;
}

function isStaffRole(role: string | null | undefined) {
  return role === "ADMIN" || role === "SUPERADMIN";
}

function getAccessReason(plan: PlanRow, now: Date): string {
  if (!plan.businessId) return "skipped_legacy_no_business_id";
  if (!plan.business) return "skipped_missing_business";
  if (!plan.business.isActive) return "skipped_inactive_business";
  if (isStaffRole(plan.user.role)) return "accessible_staff_role";

  const websiteSubscription = plan.business.websiteSubscription;
  if (websiteSubscription?.status === "active") {
    return "accessible_website_subscription_active";
  }
  if (
    websiteSubscription?.trialStatus === "trialing" &&
    websiteSubscription.trialEndDate &&
    websiteSubscription.trialEndDate > now
  ) {
    return "accessible_website_trial_active";
  }

  if (plan.user.Subscription?.status === "active") {
    return "accessible_user_subscription_active";
  }
  if (
    plan.user.trialStatus === "active" &&
    plan.user.trialEndDate &&
    plan.user.trialEndDate > now
  ) {
    return "accessible_user_trial_active";
  }

  if (
    websiteSubscription?.trialStatus === "trialing" &&
    websiteSubscription.trialEndDate &&
    websiteSubscription.trialEndDate <= now
  ) {
    return "blocked_website_trial_expired";
  }
  if (websiteSubscription?.status) {
    return `blocked_website_subscription_${websiteSubscription.status}`;
  }
  if (
    plan.user.trialStatus === "active" &&
    plan.user.trialEndDate &&
    plan.user.trialEndDate <= now
  ) {
    return "blocked_user_trial_expired";
  }
  if (plan.user.trialStatus && plan.user.trialStatus !== "none") {
    return `blocked_user_trial_${plan.user.trialStatus}`;
  }
  if (plan.user.Subscription?.status) {
    return `blocked_user_subscription_${plan.user.Subscription.status}`;
  }

  return "blocked_no_active_access_record";
}

async function loadDuePlans(now: Date) {
  return prisma.plan.findMany({
    where: {
      publishDate: { lte: dayKey(now) },
      deletedAt: null,
      blogId: null,
    },
    orderBy: [{ publishDate: "asc" }],
    select: {
      id: true,
      publishDate: true,
      createdAt: true,
      updatedAt: true,
      businessId: true,
      keywordSource: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          trialStatus: true,
          trialEndDate: true,
          createdAt: true,
          Subscription: {
            select: {
              status: true,
              createdAt: true,
              startDate: true,
              currentPeriodEnd: true,
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
          onboardingStatus: true,
          createdAt: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              trialEndDate: true,
              createdAt: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
            },
          },
        },
      },
    },
  });
}

async function main() {
  const now = parseDateArg(2, "2026-07-11");
  const plans = await loadDuePlans(now);

  const byReason = new Map<string, number>();
  const byPublishAge = new Map<string, number>();
  const byCreatedAge = new Map<string, number>();
  const byKeywordSource = new Map<string, number>();
  const byUserTrialStatus = new Map<string, number>();
  const byWebsiteSubscriptionStatus = new Map<string, number>();
  const byBusinessStatus = new Map<string, number>();
  const byPlanCreatedMonth = new Map<string, number>();
  const byPlanPublishMonth = new Map<string, number>();
  const topUsers = new Map<
    string,
    {
      userId: string;
      email: string;
      name: string;
      count: number;
      accessibleCount: number;
      oldestPublishDate: string | null;
      newestPublishDate: string | null;
      oldestPlanCreatedAt: string | null;
      newestPlanCreatedAt: string | null;
      reasons: Map<string, number>;
      businesses: Map<string, number>;
    }
  >();
  const topBusinesses = new Map<
    string,
    {
      businessId: string;
      businessName: string;
      userEmail: string;
      count: number;
      accessibleCount: number;
      oldestPublishDate: string | null;
      newestPublishDate: string | null;
      reasons: Map<string, number>;
    }
  >();

  for (const plan of plans) {
    const reason = getAccessReason(plan, now);
    const accessible = reason.startsWith("accessible_");
    const publishDate = parsePlanDate(plan.publishDate);
    const publishAge = publishDate ? daysBetween(now, publishDate) : null;
    const createdAge = daysBetween(now, plan.createdAt);

    addCount(byReason, reason);
    addCount(byPublishAge, ageBucket(publishAge));
    addCount(byCreatedAge, ageBucket(createdAge));
    addCount(byKeywordSource, plan.keywordSource ?? "(empty)");
    addCount(byUserTrialStatus, plan.user.trialStatus ?? "(null)");
    addCount(byWebsiteSubscriptionStatus, plan.business?.websiteSubscription?.status ?? "(none)");
    addCount(byBusinessStatus, plan.business ? `${plan.business.websiteStatus}|active=${plan.business.isActive}` : "(missing)");
    addCount(byPlanCreatedMonth, plan.createdAt.toISOString().slice(0, 7));
    addCount(byPlanPublishMonth, plan.publishDate.slice(0, 7));

    const userBucket =
      topUsers.get(plan.user.id) ??
      {
        userId: plan.user.id,
        email: plan.user.email,
        name: plan.user.name,
        count: 0,
        accessibleCount: 0,
        oldestPublishDate: null,
        newestPublishDate: null,
        oldestPlanCreatedAt: null,
        newestPlanCreatedAt: null,
        reasons: new Map<string, number>(),
        businesses: new Map<string, number>(),
      };
    userBucket.count += 1;
    if (accessible) userBucket.accessibleCount += 1;
    userBucket.oldestPublishDate = minString(userBucket.oldestPublishDate, plan.publishDate);
    userBucket.newestPublishDate = maxString(userBucket.newestPublishDate, plan.publishDate);
    userBucket.oldestPlanCreatedAt = minString(userBucket.oldestPlanCreatedAt, plan.createdAt.toISOString());
    userBucket.newestPlanCreatedAt = maxString(userBucket.newestPlanCreatedAt, plan.createdAt.toISOString());
    addCount(userBucket.reasons, reason);
    addCount(userBucket.businesses, plan.business?.businessName ?? "(missing business)");
    topUsers.set(plan.user.id, userBucket);

    if (plan.business) {
      const businessBucket =
        topBusinesses.get(plan.business.id) ??
        {
          businessId: plan.business.id,
          businessName: plan.business.businessName,
          userEmail: plan.user.email,
          count: 0,
          accessibleCount: 0,
          oldestPublishDate: null,
          newestPublishDate: null,
          reasons: new Map<string, number>(),
        };
      businessBucket.count += 1;
      if (accessible) businessBucket.accessibleCount += 1;
      businessBucket.oldestPublishDate = minString(businessBucket.oldestPublishDate, plan.publishDate);
      businessBucket.newestPublishDate = maxString(businessBucket.newestPublishDate, plan.publishDate);
      addCount(businessBucket.reasons, reason);
      topBusinesses.set(plan.business.id, businessBucket);
    }
  }

  const accessibleTotal = Array.from(byReason.entries())
    .filter(([reason]) => reason.startsWith("accessible_"))
    .reduce((sum, [, count]) => sum + count, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    asOfDate: dayKey(now),
    semantics:
      "Due Plan rows with deletedAt=null, blogId=null, and publishDate <= asOfDate. These are content calendar rows, not necessarily active generation jobs.",
    totals: {
      duePlansWithoutBlog: plans.length,
      accessibleDuePlansWithoutBlog: accessibleTotal,
      blockedOrSkippedDuePlansWithoutBlog: plans.length - accessibleTotal,
    },
    byReason: toSortedCounts(byReason),
    byPublishAge: toSortedCounts(byPublishAge),
    byCreatedAge: toSortedCounts(byCreatedAge),
    byKeywordSource: toSortedCounts(byKeywordSource),
    byUserTrialStatus: toSortedCounts(byUserTrialStatus),
    byWebsiteSubscriptionStatus: toSortedCounts(byWebsiteSubscriptionStatus),
    byBusinessStatus: toSortedCounts(byBusinessStatus),
    byPlanCreatedMonth: toSortedCounts(byPlanCreatedMonth),
    byPlanPublishMonth: toSortedCounts(byPlanPublishMonth),
    topUsers: Array.from(topUsers.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 25)
      .map((bucket) => ({
        ...bucket,
        reasons: toSortedCounts(bucket.reasons),
        businesses: toSortedCounts(bucket.businesses).slice(0, 12),
      })),
    topBusinesses: Array.from(topBusinesses.values())
      .sort((left, right) => right.count - left.count)
      .slice(0, 25)
      .map((bucket) => ({
        ...bucket,
        reasons: toSortedCounts(bucket.reasons),
      })),
  };

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, `plan-backlog-sources-${dayKey(now)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath: path, ...report }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
