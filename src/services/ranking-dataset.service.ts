/**
 * ranking-dataset.service.ts
 *
 * READ-ONLY. Joins published blogs to their real Google Search Console ranking
 * outcomes so we can correlate content features with what actually ranks.
 *
 * !!! This module performs NO writes. It only uses prisma.*.findMany /
 * findUnique. It must never create/update/upsert/delete or call any sync*
 * function that writes. Safe to run against the live DB.
 *
 * Join path: Blog -> PublishedBlog.externalPostUrl -> SearchConsoleMetric.page
 * (URLs normalized), focus keyword via Meta.focus_keyword / Plan.keyword.
 */

import { prisma } from "../config/db.config";
import {
  extractContentFeatures,
  urlVariants,
  type ContentFeatures,
} from "../utils/ranking-correlation.utils";
import { resolveEffectiveServices } from "../utils/effective-services.utils";
import {
  extractBusinessSubstance,
  type BusinessSubstance,
} from "../utils/blog-substance.utils";

/** READ-ONLY: build the (non-catalog) substance for a business, for the judge. */
export async function buildSubstanceForBusiness(
  businessId: string,
): Promise<BusinessSubstance> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      competitiors: true,
      CompetitorIntelligences: true,
      websiteAnalysis: { include: { coreServices: true, businessInfo: true } },
    },
  });
  const effectiveServices = resolveEffectiveServices((business ?? {}) as never);
  const businessInfo = {
    ...(business ?? {}),
    enhancedBusinessInfo: business?.websiteAnalysis?.businessInfo ?? null,
    coreServices: effectiveServices,
    effectiveServices,
  };
  return extractBusinessSubstance(businessInfo);
}

export interface PageRankingOutcome {
  /** Impression-weighted average position across all queries for the page. */
  avgPosition: number;
  clicks: number;
  impressions: number;
  ctr: number;
  /** Number of GSC rows aggregated. */
  gscRows: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregate GSC metrics for a single live page URL. READ-ONLY (findMany).
 * Returns null when the page has no GSC data in the window.
 */
export async function getRankingForPage(
  businessId: string,
  pageUrl: string,
  sinceDays = 90,
): Promise<PageRankingOutcome | null> {
  const variants = urlVariants(pageUrl);
  if (variants.length === 0) return null;

  const since = new Date(Date.now() - sinceDays * DAY_MS);
  const rows = await prisma.searchConsoleMetric.findMany({
    where: { businessId, page: { in: variants }, date: { gte: since } },
    select: { clicks: true, impressions: true, position: true },
  });
  if (rows.length === 0) return null;

  let clicks = 0;
  let impressions = 0;
  let posWeightedSum = 0;
  let posWeight = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    const w = Math.max(1, r.impressions); // weight position by impressions
    posWeightedSum += r.position * w;
    posWeight += w;
  }
  const avgPosition = posWeight > 0 ? posWeightedSum / posWeight : 0;
  const ctr = impressions > 0 ? clicks / impressions : 0;

  return {
    avgPosition: Math.round(avgPosition * 100) / 100,
    clicks,
    impressions,
    ctr: Math.round(ctr * 10000) / 10000,
    gscRows: rows.length,
  };
}

export interface RankedBlog {
  blogId: string;
  businessId: string;
  title: string;
  liveUrl: string;
  focusKeyword: string;
  outcome: PageRankingOutcome;
  features: ContentFeatures;
  seoScore: number | null;
  contentLlmScore: number | null;
  content: string;
}

export interface RankedDatasetOptions {
  businessId?: string;
  limit?: number;
  sinceDays?: number;
}

/**
 * Build the joined dataset: every published blog that has BOTH a live URL and
 * GSC ranking data, with its content features attached. READ-ONLY.
 */
export async function buildRankedBlogDataset(
  opts: RankedDatasetOptions = {},
): Promise<RankedBlog[]> {
  const blogs = await prisma.blog.findMany({
    where: {
      status: "PUBLISH",
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
    },
    include: {
      meta: true,
      Plan: true,
      publishedBlogs: true,
      contentLlmScore: true,
      business: { select: { businessWebsiteUrl: true } },
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 200,
  });

  const out: RankedBlog[] = [];
  for (const blog of blogs) {
    const liveUrl =
      blog.publishedBlogs.find((p) => p.externalPostUrl)?.externalPostUrl ?? "";
    if (!liveUrl) continue;

    const outcome = await getRankingForPage(
      blog.businessId,
      liveUrl,
      opts.sinceDays ?? 90,
    );
    if (!outcome) continue; // no real ranking data → cannot correlate

    const focusKeyword =
      blog.meta?.focus_keyword || blog.Plan?.[0]?.keyword || "";
    const features = extractContentFeatures(
      blog.content,
      blog.business?.businessWebsiteUrl ?? "",
    );

    out.push({
      blogId: blog.id,
      businessId: blog.businessId,
      title: blog.title,
      liveUrl,
      focusKeyword,
      outcome,
      features,
      seoScore: blog.seoScore ?? null,
      contentLlmScore: blog.contentLlmScore?.overallScore ?? null,
      content: blog.content,
    });
  }
  return out;
}
