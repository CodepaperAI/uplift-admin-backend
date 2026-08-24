import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  BLOG_PIPELINE_V2_PROMPT_VERSION,
  BLOG_PIPELINE_V2_VERSION,
} from "./constants";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export async function getProductionBlogPipelineCostReport(input: {
  planIds?: string[];
  prisma?: PrismaClient;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const planIds = input.planIds ? new Set(input.planIds) : null;
  const allRuns = await prisma.blogGenerationRun.findMany({
    where: { promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION },
    orderBy: { createdAt: "asc" },
  });
  const runs = allRuns.filter((run) => {
    const metadata = record(run.metadata);
    return (
      metadata.pipelineVersion === BLOG_PIPELINE_V2_VERSION &&
      (!planIds || planIds.has(String(metadata.planId ?? "")))
    );
  });
  const blogIds = runs.map((run) => run.blogId).filter((id): id is string => Boolean(id));
  const published = blogIds.length
    ? await prisma.publishedBlog.findMany({
        where: {
          blogId: { in: blogIds },
          status: { in: ["PUBLISHED", "UPDATED"] },
        },
        select: { blogId: true, status: true, externalPostUrl: true },
      })
    : [];
  const publishedByBlog = new Map(published.map((row) => [row.blogId, row]));
  const rows = runs.map((run) => {
    const metadata = record(run.metadata);
    const checkpoint = record(metadata.checkpoint);
    const cost = record(metadata.cost);
    const estimatedUsd = Number(run.estimatedUsd ?? cost.totalUsd ?? 0);
    return {
      correlationId: run.correlationId,
      planId: String(metadata.planId ?? ""),
      businessId: run.businessId,
      blogId: run.blogId,
      status: run.status,
      finalSaveStatus: run.finalSaveStatus,
      attempted: true,
      generated: Boolean(checkpoint.draft),
      imported: Boolean(run.blogId),
      externallyPublished: Boolean(run.blogId && publishedByBlog.has(run.blogId)),
      externalPostUrl: run.blogId
        ? publishedByBlog.get(run.blogId)?.externalPostUrl ?? null
        : null,
      textUsd: Number(cost.textUsd ?? 0),
      webSearchUsd: Number(cost.webSearchUsd ?? 0),
      imageUsd: Number(cost.imageUsd ?? 0),
      embeddingUsd: Number(cost.embeddingUsd ?? 0),
      estimatedUsd,
      retries: Number(cost.failures ?? run.repairCount ?? 0),
    };
  });
  const count = (key: "attempted" | "generated" | "imported" | "externallyPublished") =>
    rows.filter((row) => row[key]).length;
  const total = (key: "textUsd" | "webSearchUsd" | "imageUsd" | "embeddingUsd" | "estimatedUsd") =>
    rows.reduce((sum, row) => sum + row[key], 0);
  const per = (key: "attempted" | "generated" | "imported" | "externallyPublished") => {
    const selected = rows.filter((row) => row[key]);
    return selected.length
      ? selected.reduce((sum, row) => sum + row.estimatedUsd, 0) / selected.length
      : null;
  };
  return {
    pipelineVersion: BLOG_PIPELINE_V2_VERSION,
    counts: {
      attempted: count("attempted"),
      generated: count("generated"),
      imported: count("imported"),
      externallyPublished: count("externallyPublished"),
    },
    totals: {
      textUsd: total("textUsd"),
      webSearchUsd: total("webSearchUsd"),
      imageUsd: total("imageUsd"),
      embeddingUsd: total("embeddingUsd"),
      estimatedUsd: total("estimatedUsd"),
    },
    averageUsd: {
      attempted: per("attempted"),
      generated: per("generated"),
      imported: per("imported"),
      externallyPublished: per("externallyPublished"),
    },
    rows,
  };
}
