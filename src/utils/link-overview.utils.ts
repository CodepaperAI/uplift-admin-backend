import {
  extractExternalContentLinksFromHtml,
  normalizeManagedLinkUrl,
} from "./managed-backlinks.utils";

export type LinkOverviewBlogInput = {
  id: string;
  title: string;
  slug: string;
  status: "DRAFT" | "PUBLISH";
  content: string;
  canonicalUrl: string | null;
  updatedAt: Date | string;
  publishedBlogs: Array<{
    externalPostUrl: string | null;
  }>;
};

export type ManagedBacklinkInput = {
  id: string;
  sourceBlogUrl: string;
  sourceBusinessId: string;
  referredBlogUrl: string;
  referredBusinessId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type OutboundContentLinkRecord = {
  id: string;
  blogId: string;
  blogTitle: string;
  blogSlug: string;
  blogStatus: "DRAFT" | "PUBLISH";
  sourceUrl: string;
  destinationUrl: string;
  destinationDomain: string;
  anchorText: string;
  updatedAt: Date | string;
};

export type ManagedBacklinkRecord = ManagedBacklinkInput & {
  sourceDomain: string;
  targetDomain: string;
};

export type LinkOverview = {
  outboundContentLinks: OutboundContentLinkRecord[];
  managedBacklinks: ManagedBacklinkRecord[];
  summary: {
    outboundLinks: number;
    outboundDomains: number;
    articlesWithOutboundLinks: number;
    managedBacklinks: number;
    managedSourceDomains: number;
    managedTargetPages: number;
    latestActivityAt: Date | string | null;
  };
};

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function fallbackBlogUrl(websiteUrl: string, slug: string): string | null {
  const normalizedWebsiteUrl = normalizeManagedLinkUrl(websiteUrl);
  if (!normalizedWebsiteUrl) {
    return null;
  }

  try {
    return new URL(`blog/${slug}`, normalizedWebsiteUrl).toString();
  } catch {
    return null;
  }
}

function latestDate(values: Array<Date | string>): Date | string | null {
  let latest: { value: Date | string; timestamp: number } | null = null;

  for (const value of values) {
    const timestamp = new Date(value).getTime();
    if (!Number.isNaN(timestamp) && (!latest || timestamp > latest.timestamp)) {
      latest = { value, timestamp };
    }
  }

  return latest?.value ?? null;
}

export function buildLinkOverview(input: {
  businessWebsiteUrl: string;
  blogs: LinkOverviewBlogInput[];
  managedBacklinks: ManagedBacklinkInput[];
}): LinkOverview {
  const outboundContentLinks = input.blogs.flatMap((blog) => {
    const fallbackSourceUrl = fallbackBlogUrl(
      input.businessWebsiteUrl,
      blog.slug,
    );
    const sourceUrl =
      normalizeManagedLinkUrl(blog.canonicalUrl ?? "") ||
      normalizeManagedLinkUrl(
        blog.publishedBlogs.find((publication) => publication.externalPostUrl)
          ?.externalPostUrl ?? "",
      ) ||
      fallbackSourceUrl;

    const sourceBaseUrl = fallbackSourceUrl || sourceUrl;
    if (!sourceUrl || !sourceBaseUrl) {
      return [];
    }

    return extractExternalContentLinksFromHtml({
      html: blog.content,
      sourceBaseUrl,
      currentBusinessWebsiteUrl: input.businessWebsiteUrl,
    }).map((link) => ({
      id: `${blog.id}:${link.url}`,
      blogId: blog.id,
      blogTitle: blog.title,
      blogSlug: blog.slug,
      blogStatus: blog.status,
      sourceUrl,
      destinationUrl: link.url,
      destinationDomain: domainFromUrl(link.url),
      anchorText: link.anchorText,
      updatedAt: blog.updatedAt,
    }));
  });

  const managedBacklinks = input.managedBacklinks.map((backlink) => ({
    ...backlink,
    sourceDomain: domainFromUrl(backlink.sourceBlogUrl),
    targetDomain: domainFromUrl(backlink.referredBlogUrl),
  }));

  return {
    outboundContentLinks,
    managedBacklinks,
    summary: {
      outboundLinks: outboundContentLinks.length,
      outboundDomains: new Set(
        outboundContentLinks.map((link) => link.destinationDomain),
      ).size,
      articlesWithOutboundLinks: new Set(
        outboundContentLinks.map((link) => link.blogId),
      ).size,
      managedBacklinks: managedBacklinks.length,
      managedSourceDomains: new Set(
        managedBacklinks.map((link) => link.sourceDomain),
      ).size,
      managedTargetPages: new Set(
        managedBacklinks.map((link) => link.referredBlogUrl),
      ).size,
      latestActivityAt: latestDate([
        ...outboundContentLinks.map((link) => link.updatedAt),
        ...managedBacklinks.map((link) => link.createdAt),
      ]),
    },
  };
}

export function emptyLinkOverview(): LinkOverview {
  return buildLinkOverview({
    businessWebsiteUrl: "",
    blogs: [],
    managedBacklinks: [],
  });
}
