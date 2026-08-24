import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { estimateUsdFromStoredUsage } from "../services/llm-usage.service";

const prisma = createPrismaClient();

type UsageRow = Awaited<ReturnType<typeof loadUsageRows>>[number];

function parseDateArg(index: number, fallback: string): Date {
  const raw = process.argv[index] ?? fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date argument: ${raw}`);
  }
  return date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function estimatedUsd(row: Pick<UsageRow, "model" | "inputTokens" | "outputTokens" | "estimatedUsd">): number {
  return (
    estimateUsdFromStoredUsage({
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedUsd: row.estimatedUsd?.toString() ?? null,
    }) ?? 0
  );
}

function imageCount(row: Pick<UsageRow, "metadata">): number {
  const value = asRecord(row.metadata).imageCount;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function totalTokens(row: Pick<UsageRow, "inputTokens" | "outputTokens" | "totalTokens">): number {
  return row.totalTokens ?? (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
}

async function loadUsageRows(from: Date, to: Date) {
  return prisma.llmUsageEvent.findMany({
    where: {
      createdAt: { gte: from, lt: to },
      purpose: "blog_keyword_pipeline",
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
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
      metadata: true,
      user: { select: { email: true, name: true } },
      business: { select: { businessName: true } },
    },
  });
}

async function main() {
  const from = parseDateArg(2, "2026-07-10");
  const to = parseDateArg(3, "2026-07-11");
  const rows = await loadUsageRows(from, to);
  const generatedBlogs = await prisma.blog.findMany({
    where: { createdAt: { gte: from, lt: to }, Plan: { some: {} } },
    select: {
      id: true,
      createdAt: true,
      title: true,
      user: { select: { email: true, name: true } },
      business: { select: { businessName: true } },
      Plan: { select: { publishDate: true, keyword: true } },
    },
  });

  const groups = new Map<
    string,
    {
      correlationId: string;
      events: number;
      textEvents: number;
      imageEvents: number;
      images: number;
      estimatedUsd: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      userEmail: string | null;
      userName: string | null;
      businessName: string | null;
      blogIds: Set<string>;
      firstAt: Date;
      lastAt: Date;
      models: Record<string, number>;
    }
  >();

  const noCorrelation = {
    events: 0,
    estimatedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  for (const row of rows) {
    const usd = estimatedUsd(row);
    if (!row.correlationId) {
      noCorrelation.events += 1;
      noCorrelation.estimatedUsd += usd;
      noCorrelation.inputTokens += row.inputTokens ?? 0;
      noCorrelation.outputTokens += row.outputTokens ?? 0;
      noCorrelation.totalTokens += totalTokens(row);
      continue;
    }

    const existing =
      groups.get(row.correlationId) ??
      {
        correlationId: row.correlationId,
        events: 0,
        textEvents: 0,
        imageEvents: 0,
        images: 0,
        estimatedUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        userEmail: row.user?.email ?? null,
        userName: row.user?.name ?? null,
        businessName: row.business?.businessName ?? null,
        blogIds: new Set<string>(),
        firstAt: row.createdAt,
        lastAt: row.createdAt,
        models: {},
      };

    const images = imageCount(row);
    existing.events += 1;
    existing.estimatedUsd += usd;
    existing.inputTokens += row.inputTokens ?? 0;
    existing.outputTokens += row.outputTokens ?? 0;
    existing.totalTokens += totalTokens(row);
    existing.firstAt = row.createdAt < existing.firstAt ? row.createdAt : existing.firstAt;
    existing.lastAt = row.createdAt > existing.lastAt ? row.createdAt : existing.lastAt;
    existing.models[row.model] = (existing.models[row.model] ?? 0) + 1;
    if (images > 0) {
      existing.imageEvents += 1;
      existing.images += images;
    } else {
      existing.textEvents += 1;
    }
    if (row.blogId) existing.blogIds.add(row.blogId);
    groups.set(row.correlationId, existing);
  }

  const attempts = Array.from(groups.values()).map((group) => ({
    ...group,
    blogIds: Array.from(group.blogIds),
  }));
  const attemptsByCost = [...attempts].sort((left, right) => right.estimatedUsd - left.estimatedUsd);

  const imageEventsPerAttempt = new Map<number, number>();
  const textEventsPerAttempt = new Map<number, number>();
  for (const attempt of attempts) {
    imageEventsPerAttempt.set(
      attempt.imageEvents,
      (imageEventsPerAttempt.get(attempt.imageEvents) ?? 0) + 1,
    );
    textEventsPerAttempt.set(
      attempt.textEvents,
      (textEventsPerAttempt.get(attempt.textEvents) ?? 0) + 1,
    );
  }

  const totalEstimatedUsd = rows.reduce((sum, row) => sum + estimatedUsd(row), 0);
  const totalImages = rows.reduce((sum, row) => sum + imageCount(row), 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    range: { from: from.toISOString(), to: to.toISOString() },
    totals: {
      usageRows: rows.length,
      generatedBlogs: generatedBlogs.length,
      correlatedAttempts: attempts.length,
      noCorrelation,
      estimatedUsd: Number(totalEstimatedUsd.toFixed(6)),
      images: totalImages,
      avgUsdPerSavedBlog: generatedBlogs.length
        ? Number((totalEstimatedUsd / generatedBlogs.length).toFixed(6))
        : 0,
      avgCorrelatedAttemptsPerSavedBlog: generatedBlogs.length
        ? Number((attempts.length / generatedBlogs.length).toFixed(3))
        : 0,
      avgImagesPerSavedBlog: generatedBlogs.length
        ? Number((totalImages / generatedBlogs.length).toFixed(3))
        : 0,
      avgImagesPerCorrelatedAttempt: attempts.length
        ? Number((totalImages / attempts.length).toFixed(3))
        : 0,
    },
    distribution: {
      imageEventsPerAttempt: Array.from(imageEventsPerAttempt.entries())
        .map(([imageEvents, count]) => ({ imageEvents, count }))
        .sort((left, right) => left.imageEvents - right.imageEvents),
      textEventsPerAttempt: Array.from(textEventsPerAttempt.entries())
        .map(([textEvents, count]) => ({ textEvents, count }))
        .sort((left, right) => left.textEvents - right.textEvents),
    },
    topAttemptsByCost: attemptsByCost.slice(0, 25).map((attempt) => ({
      correlationId: attempt.correlationId,
      estimatedUsd: Number(attempt.estimatedUsd.toFixed(6)),
      events: attempt.events,
      textEvents: attempt.textEvents,
      imageEvents: attempt.imageEvents,
      images: attempt.images,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      totalTokens: attempt.totalTokens,
      userEmail: attempt.userEmail,
      userName: attempt.userName,
      businessName: attempt.businessName,
      firstAt: attempt.firstAt.toISOString(),
      lastAt: attempt.lastAt.toISOString(),
      blogIds: attempt.blogIds,
      models: attempt.models,
    })),
    savedBlogsByTopUsers: generatedBlogs.reduce<Record<string, number>>((acc, blog) => {
      const key = blog.user.email;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const path = join(
    reportDir,
    `blog-generation-fanout-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(path, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ reportPath: path, ...summary }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
