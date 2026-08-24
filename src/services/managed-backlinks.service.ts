import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  extractExternalLinkUrlsFromHtml,
  matchManagedBusinessForUrl,
  normalizeManagedLinkUrl,
} from "../utils/managed-backlinks.utils";

type SyncManagedBacklinksResult = {
  success: boolean;
  blogId: string;
  sourceBlogUrl: string | null;
  totalExternalLinks: number;
  managedCrossLinksCount: number;
  backlinksCreated: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildFallbackBlogUrl(websiteUrl: string | null, slug: string): string | null {
  const normalizedWebsiteUrl = normalizeManagedLinkUrl(websiteUrl ?? "");
  if (!normalizedWebsiteUrl) {
    return null;
  }

  try {
    return new URL(`blog/${slug}`, normalizedWebsiteUrl).toString();
  } catch {
    return null;
  }
}

async function listManagedBusinessCandidates(excludeBusinessId: string) {
  const businesses = await prisma.business.findMany({
    where: {
      isActive: true,
      id: { not: excludeBusinessId },
      businessWebsiteUrl: {
        not: "",
      },
    },
    select: {
      id: true,
      businessWebsiteUrl: true,
    },
  });

  return businesses
    .map((business) => ({
      businessId: business.id,
      websiteUrl: business.businessWebsiteUrl,
    }))
    .filter((candidate) => Boolean(candidate.websiteUrl));
}

function mergeAnalytics(
  existingAnalytics: Prisma.JsonValue | null,
  patch: Record<string, unknown>,
) {
  const base = isPlainRecord(existingAnalytics) ? existingAnalytics : {};
  return JSON.parse(JSON.stringify({ ...base, ...patch })) as Prisma.InputJsonValue;
}

export function getBlogExternalLinkMetrics(params: {
  html: string;
  sourceBaseUrl: string;
  currentBusinessWebsiteUrl: string;
}) {
  const externalUrls = extractExternalLinkUrlsFromHtml(params);

  return {
    totalExternalLinks: externalUrls.length,
    externalUrls,
  };
}

export async function syncManagedBacklinksForPublishedBlog(params: {
  blogId: string;
  publishedUrl?: string | null;
  /**
   * When supplied by a guarded recovery import, persist only this exact
   * approved cross-business URL set. Research citations can legitimately point
   * at another active client domain and must not become managed Backlink rows.
   * Omit this field to retain the normal publishing-time discovery behavior.
   */
  approvedManagedUrls?: string[];
}): Promise<SyncManagedBacklinksResult> {
  const blog = await prisma.blog.findUnique({
    where: { id: params.blogId },
    select: {
      id: true,
      slug: true,
      content: true,
      analytics: true,
      businessId: true,
      business: {
        select: {
          businessWebsiteUrl: true,
        },
      },
      publishedBlogs: {
        select: {
          externalPostUrl: true,
          publishedAt: true,
        },
        orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      },
    },
  });

  if (!blog) {
    throw new Error(`Blog ${params.blogId} not found`);
  }

  const sourceBlogUrl =
    normalizeManagedLinkUrl(params.publishedUrl ?? "") ||
    normalizeManagedLinkUrl(blog.publishedBlogs.find((item) => item.externalPostUrl)?.externalPostUrl ?? "") ||
    buildFallbackBlogUrl(blog.business.businessWebsiteUrl, blog.slug);

  const currentBusinessWebsiteUrl =
    blog.business.businessWebsiteUrl || sourceBlogUrl || "";

  if (!sourceBlogUrl || !currentBusinessWebsiteUrl) {
    return {
      success: false,
      blogId: blog.id,
      sourceBlogUrl: sourceBlogUrl ?? null,
      totalExternalLinks: 0,
      managedCrossLinksCount: 0,
      backlinksCreated: 0,
    };
  }

  const { totalExternalLinks, externalUrls } = getBlogExternalLinkMetrics({
    html: blog.content,
    sourceBaseUrl: sourceBlogUrl,
    currentBusinessWebsiteUrl,
  });

  const managedBusinessCandidates = await listManagedBusinessCandidates(blog.businessId);
  const resolvedManagedLinks = new Map<
    string,
    { referredBusinessId: string; referredBlogUrl: string }
  >();
  const approvedManagedUrls = Array.isArray(params.approvedManagedUrls)
    ? new Set(
        params.approvedManagedUrls
          .map((url) => normalizeManagedLinkUrl(url))
          .filter((url): url is string => Boolean(url)),
      )
    : null;

  for (const externalUrl of externalUrls) {
    const normalizedExternalUrl = normalizeManagedLinkUrl(externalUrl);
    if (
      approvedManagedUrls &&
      (!normalizedExternalUrl || !approvedManagedUrls.has(normalizedExternalUrl))
    ) {
      continue;
    }
    const match = matchManagedBusinessForUrl(externalUrl, managedBusinessCandidates);
    if (!match || match.businessId === blog.businessId) {
      continue;
    }

    const key = `${match.businessId}::${match.normalizedUrl}`;
    if (!resolvedManagedLinks.has(key)) {
      resolvedManagedLinks.set(key, {
        referredBusinessId: match.businessId,
        referredBlogUrl: match.normalizedUrl,
      });
    }
  }

  const guessedSourceBlogUrl = buildFallbackBlogUrl(
    blog.business.businessWebsiteUrl,
    blog.slug,
  );

  const records = Array.from(resolvedManagedLinks.values()).map((link) => ({
    sourceBlogId: blog.id,
    sourceBlogUrl,
    sourceBusinessId: blog.businessId,
    referredBlogUrl: link.referredBlogUrl,
    referredBusinessId: link.referredBusinessId,
  }));

  await prisma.$transaction(async (tx) => {
    await tx.backlinks.deleteMany({
      where: {
        OR: [
          { sourceBlogId: blog.id },
          {
            sourceBlogId: null,
            sourceBusinessId: blog.businessId,
            sourceBlogUrl: {
              in: [sourceBlogUrl, guessedSourceBlogUrl].filter(
                (value): value is string => Boolean(value),
              ),
            },
          },
        ],
      },
    });

    if (records.length > 0) {
      await tx.backlinks.createMany({
        data: records,
        skipDuplicates: true,
      });
    }

    await tx.blog.update({
      where: { id: blog.id },
      data: {
        analytics: mergeAnalytics(blog.analytics, {
          externalLinksCount: totalExternalLinks,
          managedCrossLinksCount: records.length,
        }),
      },
    });
  });

  return {
    success: true,
    blogId: blog.id,
    sourceBlogUrl,
    totalExternalLinks,
    managedCrossLinksCount: records.length,
    backlinksCreated: records.length,
  };
}

export async function backfillManagedBacklinkSourceBlogIds(params?: {
  limit?: number;
}) {
  const legacyRows = await prisma.backlinks.findMany({
    where: {
      sourceBlogId: null,
    },
    take: params?.limit ?? 1000,
    orderBy: { createdAt: "asc" },
  });

  let matched = 0;
  let unmatched = 0;

  for (const row of legacyRows) {
    const normalizedSourceUrl = normalizeManagedLinkUrl(row.sourceBlogUrl);
    if (!normalizedSourceUrl) {
      unmatched += 1;
      continue;
    }

    let matchedBlogId: string | null = null;

    const publishedBlogs = await prisma.publishedBlog.findMany({
      where: {
        blog: {
          businessId: row.sourceBusinessId,
        },
      },
      select: {
        blogId: true,
        externalPostUrl: true,
      },
    });

    const publishedMatch = publishedBlogs.find(
      (publishedBlog) =>
        normalizeManagedLinkUrl(publishedBlog.externalPostUrl ?? "") === normalizedSourceUrl,
    );

    if (publishedMatch) {
      matchedBlogId = publishedMatch.blogId;
    } else {
      const sourceBlogs = await prisma.blog.findMany({
        where: {
          businessId: row.sourceBusinessId,
        },
        select: {
          id: true,
          slug: true,
          business: {
            select: {
              businessWebsiteUrl: true,
            },
          },
        },
      });

      const slugMatch = sourceBlogs.find((blog) => {
        const guessedUrl = buildFallbackBlogUrl(
          blog.business.businessWebsiteUrl,
          blog.slug,
        );
        return guessedUrl === normalizedSourceUrl;
      });

      if (slugMatch) {
        matchedBlogId = slugMatch.id;
      }
    }

    if (!matchedBlogId) {
      unmatched += 1;
      continue;
    }

    await prisma.backlinks.update({
      where: { id: row.id },
      data: { sourceBlogId: matchedBlogId },
    });
    matched += 1;
  }

  return {
    scanned: legacyRows.length,
    matched,
    unmatched,
  };
}
