const DEFAULT_OG_TYPE = "article";
const DEFAULT_OG_LOCALE = "en_US";
export const REFRESH_THRESHOLD_DAYS = 90;

export type ExtendedBlogMeta = {
  seo_title: string;
  seo_description: string;
  focus_keyword: string;
  keywords: string[];
  og_title: string;
  og_description: string;
  og_type: string;
  og_url: string;
  og_site_name: string;
  og_locale: string;
  article_author: string;
  article_section: string;
  article_tags: string[];
};

type BasicMetaInput = {
  seo_title?: string | null;
  seo_description?: string | null;
  focus_keyword?: string | null;
  keywords?: string[] | null;
  og_title?: string | null;
  og_description?: string | null;
  og_type?: string | null;
  og_url?: string | null;
  og_site_name?: string | null;
  og_locale?: string | null;
  article_author?: string | null;
  article_section?: string | null;
  article_tags?: string[] | null;
};

type DerivedMetaInput = {
  title: string;
  excerpt?: string | null;
  slug: string;
  meta?: BasicMetaInput | null;
  categories?: string[] | null;
  tags?: string[] | null;
  authorName?: string | null;
  businessName?: string | null;
  businessWebsiteUrl?: string | null;
  defaultLocale?: string | null;
  fallbackUrl?: string | null;
};

type AnalyticsLike = {
  seoMeta?: Partial<ExtendedBlogMeta> | null;
};

function normalizeText(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(values?: string[] | null): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

export function normalizeOgLocale(locale?: string | null): string {
  const trimmed = normalizeText(locale);
  if (!trimmed) {
    return DEFAULT_OG_LOCALE;
  }

  return trimmed.replace("-", "_");
}

export function buildBlogCanonicalUrl(params: {
  websiteUrl?: string | null;
  slug?: string | null;
  fallbackUrl?: string | null;
}): string {
  const candidates = [params.websiteUrl, params.fallbackUrl]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const slug = normalizeText(params.slug);

  for (const candidate of candidates) {
    try {
      const baseUrl = new URL(candidate);
      if (!slug) {
        return baseUrl.toString();
      }
      const normalizedPath = baseUrl.pathname.replace(/\/+$/, "");
      const blogBasePath = normalizedPath.endsWith("/blog")
        ? normalizedPath
        : `${normalizedPath}/blog`;
      return `${baseUrl.origin}${blogBasePath}/${slug}`;
    } catch {
      continue;
    }
  }

  return "";
}

export function extractStoredSeoMeta(analytics: unknown): Partial<ExtendedBlogMeta> {
  if (!analytics || typeof analytics !== "object" || Array.isArray(analytics)) {
    return {};
  }

  const seoMeta = (analytics as AnalyticsLike).seoMeta;
  if (!seoMeta || typeof seoMeta !== "object" || Array.isArray(seoMeta)) {
    return {};
  }

  return seoMeta;
}

export function buildExtendedBlogMeta(params: DerivedMetaInput): ExtendedBlogMeta {
  const meta = params.meta ?? {};
  const fallbackKeywordList = normalizeStringArray(meta.keywords).length
    ? normalizeStringArray(meta.keywords)
    : normalizeStringArray(params.tags);
  const derivedTags = normalizeStringArray(meta.article_tags).length
    ? normalizeStringArray(meta.article_tags)
    : fallbackKeywordList.length
      ? fallbackKeywordList
      : normalizeStringArray(params.categories);

  const ogUrl =
    normalizeText(meta.og_url) ||
    buildBlogCanonicalUrl({
      websiteUrl: params.businessWebsiteUrl,
      slug: params.slug,
      fallbackUrl: params.fallbackUrl,
    });

  return {
    seo_title: normalizeText(meta.seo_title) || normalizeText(params.title),
    seo_description:
      normalizeText(meta.seo_description) || normalizeText(params.excerpt),
    focus_keyword: normalizeText(meta.focus_keyword),
    keywords: fallbackKeywordList,
    og_title:
      normalizeText(meta.og_title) ||
      normalizeText(meta.seo_title) ||
      normalizeText(params.title),
    og_description:
      normalizeText(meta.og_description) ||
      normalizeText(meta.seo_description) ||
      normalizeText(params.excerpt),
    og_type: normalizeText(meta.og_type) || DEFAULT_OG_TYPE,
    og_url: ogUrl,
    og_site_name:
      normalizeText(meta.og_site_name) || normalizeText(params.businessName),
    og_locale: normalizeOgLocale(meta.og_locale || params.defaultLocale),
    article_author:
      normalizeText(meta.article_author) || normalizeText(params.authorName),
    article_section:
      normalizeText(meta.article_section) ||
      normalizeStringArray(params.categories)[0] ||
      "Blog",
    article_tags: derivedTags,
  };
}

export function hasVisibleFreshnessIndicators(content?: string | null): boolean {
  const html = normalizeText(content).toLowerCase();
  if (!html) {
    return false;
  }

  return /last\s+updated|updated\s+on|updated:/i.test(html);
}

export function getBlogFreshnessInfo(params: {
  blogPublishDate?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const updatedAt = params.updatedAt ? new Date(params.updatedAt) : null;
  const createdAt = params.createdAt ? new Date(params.createdAt) : null;
  const publishDate = normalizeText(params.blogPublishDate)
    ? new Date(`${params.blogPublishDate}T00:00:00Z`)
    : null;

  const baseline = updatedAt ?? publishDate ?? createdAt;
  const isValidBaseline = baseline instanceof Date && !Number.isNaN(baseline.getTime());
  const ageDays = isValidBaseline
    ? Math.max(0, Math.floor((now.getTime() - baseline.getTime()) / 86400000))
    : null;

  return {
    lastUpdatedAt: isValidBaseline ? baseline.toISOString() : null,
    ageDays,
    needsRefresh: ageDays !== null ? ageDays >= REFRESH_THRESHOLD_DAYS : false,
    freshnessThresholdDays: REFRESH_THRESHOLD_DAYS,
  };
}
