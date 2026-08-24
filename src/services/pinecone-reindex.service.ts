import { STATUS } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  buildSitemapVectorId,
  deleteSitemapVectors,
  listSitemapVectorIdsForBusiness,
  upsertBlog,
  upsertSitemapUrls,
} from "../config/pinecone.config";
import { filterAliveUrls } from "../utils/link-validator";
import {
  discoverSitemapUrl,
  fetchSitemapUrls,
} from "../utils/tools.utils";

/**
 * Pinecone re-index service
 *
 * Keeps Pinecone in sync with the authoritative state of each business's
 * website and blog content. Runs as a scheduled Inngest cron job once a
 * week (Sunday 3 AM UTC) for every paid-subscriber business.
 *
 * Two sub-jobs per business:
 *
 *   1. Sitemap URL diff:
 *        - (re-)discover the sitemap URL from the business website
 *        - fetch the current URL set
 *        - upsert URLs that aren't already in Pinecone (by deterministic vector id)
 *        - delete vectors whose URLs are no longer present in the live sitemap
 *
 *   2. Blog content refresh:
 *        - re-embed published blogs whose `updatedAt` is newer than
 *          `pineconeIndexedAt` (or whose `pineconeIndexedAt` is NULL)
 *        - capped per run to keep OpenAI embedding spend bounded
 *        - updates `pineconeIndexedAt = now()` after successful upsert
 *
 * Design notes:
 * - Both sub-jobs are isolated by try/catch: one failing never blocks the other.
 * - Never throws out of the top-level handler — always returns a structured
 *   summary so the Inngest cron can log outcomes per business.
 */

export type BusinessReindexResult = {
  businessId: string;
  sitemap: {
    ran: boolean;
    skippedReason?: string;
    discoveredSitemapUrl?: string | null;
    /** URLs returned by the sitemap crawl (pre-validation). */
    liveUrls?: number;
    /** URLs that passed the live-URL HTTP check (what actually reaches Pinecone). */
    aliveUrls?: number;
    /** URLs dropped by the live-URL check (404 / unreachable). */
    droppedDeadUrls?: number;
    upserted?: number;
    deleted?: number;
    error?: string;
  };
  blogs: {
    ran: boolean;
    skippedReason?: string;
    candidates?: number;
    reindexed?: number;
    failed?: number;
    cappedAt?: number;
    error?: string;
  };
};

const DEFAULT_BLOG_CAP_PER_RUN = 50;

export class PineconeReindexService {
  /**
   * Re-index sitemap and changed blogs for a single business.
   * Resolves with a structured result; never throws.
   */
  async reindexBusiness(args: {
    businessId: string;
    businessWebsiteUrl: string | null;
    userId: string;
    blogCapPerRun?: number;
  }): Promise<BusinessReindexResult> {
    const { businessId, businessWebsiteUrl, userId } = args;
    const blogCap = args.blogCapPerRun ?? DEFAULT_BLOG_CAP_PER_RUN;

    const result: BusinessReindexResult = {
      businessId,
      sitemap: { ran: false },
      blogs: { ran: false },
    };

    // ---- 1. Sitemap diff ----
    try {
      result.sitemap = await this.reindexSitemapForBusiness({
        businessId,
        businessWebsiteUrl,
        userId,
      });
    } catch (err: any) {
      console.error(
        `[PineconeReindexService] sitemap phase failed for business=${businessId}:`,
        err,
      );
      result.sitemap = { ran: false, error: err?.message ?? "unknown error" };
    }

    // ---- 2. Blogs: re-embed changed published blogs ----
    try {
      result.blogs = await this.reindexChangedBlogsForBusiness({
        businessId,
        maxBlogs: blogCap,
      });
    } catch (err: any) {
      console.error(
        `[PineconeReindexService] blog phase failed for business=${businessId}:`,
        err,
      );
      result.blogs = { ran: false, error: err?.message ?? "unknown error" };
    }

    return result;
  }

  /**
   * Sitemap diff for a single business.
   * Returns counts; skip reasons if we couldn't run.
   */
  async reindexSitemapForBusiness(args: {
    businessId: string;
    businessWebsiteUrl: string | null;
    userId: string;
  }): Promise<BusinessReindexResult["sitemap"]> {
    const { businessId, businessWebsiteUrl, userId } = args;

    if (!businessWebsiteUrl) {
      return { ran: false, skippedReason: "no_website_url" };
    }

    const sitemapUrl = await discoverSitemapUrl(businessWebsiteUrl);
    if (!sitemapUrl) {
      return {
        ran: false,
        skippedReason: "sitemap_not_found",
        discoveredSitemapUrl: null,
      };
    }

    const crawledUrls = await fetchSitemapUrls(sitemapUrl);
    if (crawledUrls.length === 0) {
      return {
        ran: false,
        skippedReason: "empty_sitemap",
        discoveredSitemapUrl: sitemapUrl,
      };
    }

    // Validate URLs BEFORE upserting to Pinecone. Dead URLs (404 / DNS /
    // unreachable / network error) never enter the index. The validator
    // reuses the same 24h in-memory cache as the LLM-read-time filter,
    // so if the same URL has been recently checked elsewhere the cost
    // here is ~0. See `filterAliveUrls` in utils/link-validator.ts.
    const aliveWrapped = await filterAliveUrls(
      crawledUrls.map((url) => ({ url })),
    );
    const aliveUrls = aliveWrapped.map((w) => w.url);
    const droppedDeadUrls = crawledUrls.length - aliveUrls.length;
    console.log(
      `[reindexSitemapForBusiness] business=${businessId} ` +
        `crawled=${crawledUrls.length} alive=${aliveUrls.length} ` +
        `dropped_dead=${droppedDeadUrls}`,
    );

    if (aliveUrls.length === 0) {
      // Every URL in the sitemap is unreachable. Don't upsert anything
      // and don't delete existing vectors either — that would wipe the
      // index on a transient outage. Skip this run.
      return {
        ran: false,
        skippedReason: "all_sitemap_urls_unreachable",
        discoveredSitemapUrl: sitemapUrl,
        liveUrls: crawledUrls.length,
        aliveUrls: 0,
        droppedDeadUrls,
      };
    }

    // Build the set of expected vector IDs for the LIVE (alive) sitemap.
    const expectedIdByUrl = new Map<string, string>();
    for (const url of aliveUrls) {
      expectedIdByUrl.set(url, buildSitemapVectorId(businessId, url));
    }
    const expectedIds = new Set(expectedIdByUrl.values());

    // Enumerate what's currently in Pinecone for this business.
    const existingIds = await listSitemapVectorIdsForBusiness(businessId);
    const existingIdSet = new Set(existingIds);

    // Diff — compare against the validated set, not the raw crawl.
    const urlsToUpsert: string[] = [];
    for (const [url, id] of expectedIdByUrl) {
      if (!existingIdSet.has(id)) urlsToUpsert.push(url);
    }

    const idsToDelete: string[] = [];
    for (const id of existingIds) {
      if (!expectedIds.has(id)) idsToDelete.push(id);
    }

    // Apply. Upsert first (additive), then delete (subtractive).
    if (urlsToUpsert.length > 0) {
      await upsertSitemapUrls(businessId, userId, urlsToUpsert);
    }
    if (idsToDelete.length > 0) {
      await deleteSitemapVectors(idsToDelete);
    }

    return {
      ran: true,
      discoveredSitemapUrl: sitemapUrl,
      liveUrls: crawledUrls.length,
      aliveUrls: aliveUrls.length,
      droppedDeadUrls,
      upserted: urlsToUpsert.length,
      deleted: idsToDelete.length,
    };
  }

  /**
   * Re-embed published blogs whose content has changed since their last
   * Pinecone index. Capped per run to bound embedding cost.
   */
  async reindexChangedBlogsForBusiness(args: {
    businessId: string;
    maxBlogs: number;
  }): Promise<BusinessReindexResult["blogs"]> {
    const { businessId, maxBlogs } = args;

    if (maxBlogs <= 0) {
      return { ran: false, skippedReason: "cap_is_zero" };
    }

    // Candidate set: published blogs that have never been indexed OR
    // whose content changed after last index.
    const candidates = await prisma.blog.findMany({
      where: {
        businessId,
        status: STATUS.PUBLISH,
        OR: [
          { pineconeIndexedAt: null },
          { updatedAt: { gt: prisma.blog.fields.pineconeIndexedAt } },
        ],
      },
      // Prefer never-indexed first, then oldest-indexed. Most stale wins.
      orderBy: [
        { pineconeIndexedAt: { sort: "asc", nulls: "first" } },
        { updatedAt: "asc" },
      ],
      take: maxBlogs,
      select: {
        id: true,
        title: true,
        content: true,
        tags: true,
        categories: true,
        userId: true,
        businessId: true,
        meta: { select: { seo_description: true } },
        // Preserve the canonical published URL on the re-embedded vector
        // if one exists. `upsertBlog` replaces metadata, so we must pass it
        // through explicitly.
        publishedBlogs: {
          where: { externalPostUrl: { not: null } },
          orderBy: { publishedAt: "desc" },
          take: 1,
          select: { externalPostUrl: true },
        },
      },
    });

    if (candidates.length === 0) {
      return { ran: true, candidates: 0, reindexed: 0, failed: 0 };
    }

    let reindexed = 0;
    let failed = 0;

    for (const blog of candidates) {
      try {
        const canonicalUrl = blog.publishedBlogs?.[0]?.externalPostUrl ?? null;
        await upsertBlog(blog.id, {
          title: blog.title,
          content: blog.content,
          tags: blog.tags,
          categories: blog.categories,
          seoDescription: blog.meta?.seo_description ?? "",
          url: canonicalUrl,
          userId: blog.userId,
          businessId: blog.businessId,
        });
        await prisma.blog.update({
          where: { id: blog.id },
          data: { pineconeIndexedAt: new Date() },
        });
        reindexed++;
      } catch (err: any) {
        failed++;
        console.error(
          `[PineconeReindexService] blog re-embed failed id=${blog.id}:`,
          err?.message ?? err,
        );
      }
    }

    const result: BusinessReindexResult["blogs"] = {
      ran: true,
      candidates: candidates.length,
      reindexed,
      failed,
    };
    if (candidates.length >= maxBlogs) {
      result.cappedAt = maxBlogs;
    }
    return result;
  }
}
