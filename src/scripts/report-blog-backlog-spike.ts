import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient();

type Bucket = {
  label: string;
  count: number;
};

type UserBucket = {
  userId: string;
  email: string;
  name: string;
  blogCount: number;
  backlogBlogCount: number;
  recentActivationBlogCount: number;
  businesses: Record<string, number>;
  oldestPublishDate: string | null;
  newestPublishDate: string | null;
  activationSignals: string[];
};

type BusinessBacklogBucket = {
  businessId: string;
  businessName: string;
  userEmail: string;
  duePlanCount: number;
  oldestPublishDate: string | null;
  newestPublishDate: string | null;
};

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

function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((dayStart(later).getTime() - dayStart(earlier).getTime()) / DAY_MS);
}

function parsePlanDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function bucketByAge(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 0) return "future";
  if (days === 0) return "same_day";
  if (days <= 2) return "1_2_days_old";
  if (days <= 7) return "3_7_days_old";
  if (days <= 14) return "8_14_days_old";
  if (days <= 30) return "15_30_days_old";
  return "over_30_days_old";
}

function addBucket(map: Map<string, number>, label: string, count = 1) {
  map.set(label, (map.get(label) ?? 0) + count);
}

function toBuckets(map: Map<string, number>): Bucket[] {
  return Array.from(map.entries()).map(([label, count]) => ({ label, count }));
}

function isWithinPreviousDays(value: Date | null | undefined, anchor: Date, days: number): boolean {
  if (!value) return false;
  const ageMs = anchor.getTime() - value.getTime();
  return ageMs >= 0 && ageMs <= days * DAY_MS;
}

function addSignal(signals: Set<string>, label: string, value: Date | null | undefined, anchor: Date) {
  if (value && isWithinPreviousDays(value, anchor, 7)) {
    signals.add(`${label}:${value.toISOString()}`);
  }
}

function compareNullableDates(current: string | null, next: string | null, mode: "min" | "max"): string | null {
  if (!next) return current;
  if (!current) return next;
  return mode === "min" ? (next < current ? next : current) : next > current ? next : current;
}

async function hasGenerationAccess(plan: {
  user: { role: string; trialStatus: string | null; trialEndDate: Date | null; Subscription: { status: string } | null };
  business: { isActive: boolean; websiteSubscription: { status: string; trialStatus: string; trialEndDate: Date | null } | null } | null;
}) {
  if (plan.user.role === "ADMIN" || plan.user.role === "SUPERADMIN") return true;
  if (!plan.business?.isActive) return false;

  const ws = plan.business.websiteSubscription;
  if (
    ws &&
    (ws.status === "active" ||
      (ws.trialStatus === "trialing" && ws.trialEndDate !== null && ws.trialEndDate > new Date()))
  ) {
    return true;
  }

  if (plan.user.Subscription?.status === "active") return true;

  return Boolean(
    plan.user.trialStatus === "active" &&
      plan.user.trialEndDate &&
      plan.user.trialEndDate > new Date(),
  );
}

async function summarizeGeneratedBlogs(from: Date, to: Date) {
  const blogs = await prisma.blog.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      Plan: { some: {} },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          trialStartDate: true,
          trialStatus: true,
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
          createdAt: true,
          websiteSubscription: {
            select: {
              status: true,
              createdAt: true,
              updatedAt: true,
              currentPeriodStart: true,
              trialStartDate: true,
              trialStatus: true,
            },
          },
        },
      },
      Plan: {
        select: {
          id: true,
          keyword: true,
          publishDate: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const byDay = new Map<
    string,
    {
      generatedBlogs: number;
      backlogBlogs: number;
      recentActivationBlogs: number;
      planPublishAge: Map<string, number>;
      planCreatedAge: Map<string, number>;
      topUsers: Map<string, UserBucket>;
    }
  >();

  for (const blog of blogs) {
    const key = dayKey(blog.createdAt);
    const day =
      byDay.get(key) ??
      {
        generatedBlogs: 0,
        backlogBlogs: 0,
        recentActivationBlogs: 0,
        planPublishAge: new Map<string, number>(),
        planCreatedAge: new Map<string, number>(),
        topUsers: new Map<string, UserBucket>(),
      };
    byDay.set(key, day);

    const plan = blog.Plan[0];
    const publishDate = parsePlanDate(plan?.publishDate);
    const publishAge = publishDate ? daysBetween(blog.createdAt, publishDate) : null;
    const createdAge = plan ? daysBetween(blog.createdAt, plan.createdAt) : null;
    const publishAgeBucket = bucketByAge(publishAge);
    const createdAgeBucket = bucketByAge(createdAge);
    const isBacklog = publishAge !== null && publishAge > 0;

    const signals = new Set<string>();
    addSignal(signals, "user.createdAt", blog.user.createdAt, blog.createdAt);
    addSignal(signals, "user.trialStartDate", blog.user.trialStartDate, blog.createdAt);
    addSignal(signals, "subscription.createdAt", blog.user.Subscription?.createdAt, blog.createdAt);
    addSignal(signals, "subscription.startDate", blog.user.Subscription?.startDate, blog.createdAt);
    addSignal(signals, "websiteSubscription.createdAt", blog.business.websiteSubscription?.createdAt, blog.createdAt);
    addSignal(
      signals,
      "websiteSubscription.currentPeriodStart",
      blog.business.websiteSubscription?.currentPeriodStart,
      blog.createdAt,
    );
    addSignal(signals, "websiteSubscription.trialStartDate", blog.business.websiteSubscription?.trialStartDate, blog.createdAt);
    const recentActivation = signals.size > 0;

    day.generatedBlogs += 1;
    if (isBacklog) day.backlogBlogs += 1;
    if (recentActivation) day.recentActivationBlogs += 1;
    addBucket(day.planPublishAge, publishAgeBucket);
    addBucket(day.planCreatedAge, createdAgeBucket);

    const userBucket =
      day.topUsers.get(blog.user.id) ??
      {
        userId: blog.user.id,
        email: blog.user.email,
        name: blog.user.name,
        blogCount: 0,
        backlogBlogCount: 0,
        recentActivationBlogCount: 0,
        businesses: {},
        oldestPublishDate: null,
        newestPublishDate: null,
        activationSignals: [],
      };

    userBucket.blogCount += 1;
    if (isBacklog) userBucket.backlogBlogCount += 1;
    if (recentActivation) userBucket.recentActivationBlogCount += 1;
    userBucket.businesses[blog.business.businessName] =
      (userBucket.businesses[blog.business.businessName] ?? 0) + 1;
    userBucket.oldestPublishDate = compareNullableDates(
      userBucket.oldestPublishDate,
      plan?.publishDate ?? null,
      "min",
    );
    userBucket.newestPublishDate = compareNullableDates(
      userBucket.newestPublishDate,
      plan?.publishDate ?? null,
      "max",
    );
    for (const signal of signals) {
      if (!userBucket.activationSignals.includes(signal)) {
        userBucket.activationSignals.push(signal);
      }
    }
    day.topUsers.set(blog.user.id, userBucket);
  }

  return Array.from(byDay.entries()).map(([date, value]) => ({
    date,
    generatedBlogs: value.generatedBlogs,
    backlogBlogs: value.backlogBlogs,
    recentActivationBlogs: value.recentActivationBlogs,
    planPublishAge: toBuckets(value.planPublishAge),
    planCreatedAge: toBuckets(value.planCreatedAge),
    topUsers: Array.from(value.topUsers.values())
      .sort((left, right) => right.blogCount - left.blogCount)
      .slice(0, 15),
  }));
}

async function summarizeCurrentBacklog(now: Date) {
  const plans = await prisma.plan.findMany({
    where: {
      publishDate: { lte: dayKey(now) },
      deletedAt: null,
      blogId: null,
      businessId: { not: null },
    },
    orderBy: [{ publishDate: "asc" }],
    select: {
      id: true,
      publishDate: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          trialStatus: true,
          trialEndDate: true,
          Subscription: { select: { status: true } },
        },
      },
      business: {
        select: {
          id: true,
          businessName: true,
          isActive: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              trialEndDate: true,
            },
          },
        },
      },
    },
  });

  const publishAge = new Map<string, number>();
  const accessiblePublishAge = new Map<string, number>();
  const topBusinesses = new Map<string, BusinessBacklogBucket>();
  let accessible = 0;

  for (const plan of plans) {
    const parsedDate = parsePlanDate(plan.publishDate);
    const age = parsedDate ? daysBetween(now, parsedDate) : null;
    addBucket(publishAge, bucketByAge(age));

    const hasAccess = await hasGenerationAccess(plan);
    if (!hasAccess || !plan.business) continue;
    accessible += 1;
    addBucket(accessiblePublishAge, bucketByAge(age));

    const businessBucket =
      topBusinesses.get(plan.business.id) ??
      {
        businessId: plan.business.id,
        businessName: plan.business.businessName,
        userEmail: plan.user.email,
        duePlanCount: 0,
        oldestPublishDate: null,
        newestPublishDate: null,
      };
    businessBucket.duePlanCount += 1;
    businessBucket.oldestPublishDate = compareNullableDates(
      businessBucket.oldestPublishDate,
      plan.publishDate,
      "min",
    );
    businessBucket.newestPublishDate = compareNullableDates(
      businessBucket.newestPublishDate,
      plan.publishDate,
      "max",
    );
    topBusinesses.set(plan.business.id, businessBucket);
  }

  return {
    totalDueWithoutBlog: plans.length,
    accessibleDueWithoutBlog: accessible,
    publishAge: toBuckets(publishAge),
    accessiblePublishAge: toBuckets(accessiblePublishAge),
    topAccessibleBacklogBusinesses: Array.from(topBusinesses.values())
      .sort((left, right) => right.duePlanCount - left.duePlanCount)
      .slice(0, 20),
  };
}

async function main() {
  const from = parseDateArg(2, "2026-07-07");
  const to = parseDateArg(3, "2026-07-11");
  const now = to;

  const generated = await summarizeGeneratedBlogs(from, to);
  const currentBacklog = await summarizeCurrentBacklog(now);

  const report = {
    generatedAt: new Date().toISOString(),
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      semantics: "Blog.createdAt >= from and < to; age buckets compare Plan.publishDate / Plan.createdAt against Blog.createdAt UTC day.",
    },
    generated,
    currentBacklog,
  };

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const path = join(
    reportDir,
    `blog-backlog-spike-${dayKey(from)}_${dayKey(to)}.json`,
  );
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
