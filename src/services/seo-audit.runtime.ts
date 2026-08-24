import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import {
  guardUrl,
  readResponseTextLimited,
  safeFetch,
} from "../utils/ssrf-guard";
import type {
  SeoAuditCheckStatus,
  SeoAuditContradiction,
  SeoAuditCrawlPage,
  SeoAuditCrawlStats,
  SeoAuditFindingSeverity,
  SeoAuditModule,
  SeoAuditModuleFinding,
  SeoAuditModuleReport,
  SeoAuditModuleStatus,
  SeoAuditPageFacts,
  SeoAuditParserCheck,
  SeoAuditRecommendation,
  SeoAuditSiteFacts,
} from "../validators/seo-audit.validation";

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY?.trim() ?? "";
const SCRAPER_API_URL = "https://api.scraperapi.com";

const MAX_AUDIT_PAGES = 20;
const MAX_RENDERED_PAGES = 5;
const MAX_SITEMAP_URLS = 250;
const MAX_SITEMAP_DEPTH = 4;
const FETCH_TIMEOUT_MS = 30_000;
const ROBOTS_TIMEOUT_MS = 8_000;
const HEAD_SNIPPET_LIMIT = 1_600;
const BODY_SNIPPET_LIMIT = 1_200;

// Many CDN-fronted sites (Vercel, Cloudflare, Netlify) return 403/empty to
// requests without a recognizable UA, which previously caused silent sitemap
// and robots.txt failures.
const AUDIT_USER_AGENT =
  "Mozilla/5.0 (compatible; UpliftSEOBot/1.0; +https://upliftai.co/bot)";

export const SEO_AUDIT_PARSER_VERSION = "2026-03-24-r1";

type FetchMode = "static" | "rendered";

type FetchedPage = SeoAuditCrawlPage & {
  html: string;
};

export type SeoAuditRuntimeContext = {
  crawlStats: SeoAuditCrawlStats;
  siteFacts: SeoAuditSiteFacts;
  pageFacts: SeoAuditPageFacts[];
  parserChecks: SeoAuditParserCheck[];
  sources: string[];
};

type RobotsInfo = {
  fetched: boolean;
  url: string;
  text: string;
  sitemapDeclarations: string[];
};

type FinalizedFindingResult = {
  finding: SeoAuditModuleFinding;
  contradiction: SeoAuditContradiction | null;
  scoreEligible: boolean;
};

type ModelFindingDraft = {
  severity: SeoAuditFindingSeverity;
  title: string;
  description: string;
  evidenceRef: string;
  suggestedFix: string;
  affectedUrls: string[];
};

const ASSET_EXTENSIONS =
  /\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|xml|zip|mp4|webm|mp3|json)$/i;
const CTA_PATTERN =
  /\b(contact|call|quote|book|schedule|demo|start|get started|learn more|buy|request)\b/i;
const APP_SHELL_PATTERNS = [
  'id="__next"',
  'id="root"',
  'id="app"',
  'data-reactroot',
  'ng-app',
  "__NUXT",
];
const PHONE_PATTERN =
  /(?:\+?\d{1,2}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;
const HREFLANG_PATTERN = /^(?:x-default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i;
const TITLE_MIN_LENGTH = 20;
const TITLE_MAX_LENGTH = 65;
const META_DESCRIPTION_MIN_LENGTH = 70;
const META_DESCRIPTION_MAX_LENGTH = 170;
const LOW_WORD_COUNT_THRESHOLD = 150;

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export function normalizeAuditUrl(
  value: string,
  baseOrigin?: string,
): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    const normalized = baseOrigin
      ? new URL(value, baseOrigin)
      : /^https?:\/\//i.test(value)
        ? new URL(value)
        : null;

    if (!normalized) {
      return null;
    }

    normalized.hash = "";
    normalized.search = "";
    normalized.hostname = normalized.hostname.toLowerCase();
    normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";

    return normalized.toString();
  } catch {
    return null;
  }
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedOrigin = new URL(origin);
    const normalizeHost = (hostname: string) =>
      hostname.toLowerCase().replace(/^www\./, "");

    return (
      parsedUrl.protocol === parsedOrigin.protocol &&
      parsedUrl.port === parsedOrigin.port &&
      normalizeHost(parsedUrl.hostname) === normalizeHost(parsedOrigin.hostname)
    );
  } catch {
    return false;
  }
}

function isHtmlCandidate(url: string): boolean {
  return !ASSET_EXTENSIONS.test(url);
}

function isLikelyMoneyPage(pathname: string): boolean {
  return /(service|services|pricing|price|contact|location|areas|book|demo|quote|about)/i.test(
    pathname,
  );
}

function isLikelyLowPriorityPath(pathname: string): boolean {
  return /(privacy|terms|policy|login|signup|sign-in|sign-up|cart|checkout|tag|category|feed|wp-admin|admin|account)/i.test(
    pathname,
  );
}

function scoreAuditUrl(url: string, homepageUrl: string): number {
  try {
    const parsed = new URL(url);
    const homepage = new URL(homepageUrl);
    if (parsed.toString() === homepage.toString()) {
      return -100;
    }

    let score = 100;
    if (isLikelyMoneyPage(parsed.pathname)) score -= 40;
    if (isLikelyLowPriorityPath(parsed.pathname)) score += 60;
    if (parsed.pathname.split("/").filter(Boolean).length <= 1) score -= 10;
    if (/blog|post|news/i.test(parsed.pathname)) score += 20;
    score += parsed.pathname.length;
    return score;
  } catch {
    return 999;
  }
}

export function shouldUseRenderedFetch(html: string): boolean {
  if (!html.trim()) {
    return false;
  }

  const $ = load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const headingCount = $("h1, h2, h3").length;
  const linkCount = $("a[href]").length;
  const hasAppShellMarker = APP_SHELL_PATTERNS.some((marker) =>
    html.includes(marker),
  );

  if (bodyText.length < 120) {
    return true;
  }

  if (hasAppShellMarker && bodyText.length < 1_200) {
    return true;
  }

  if (headingCount === 0 && linkCount < 3) {
    return true;
  }

  return false;
}

function derivePageKey(url: string, origin: string, seenKeys: Set<string>): string {
  try {
    const parsed = new URL(url);
    const relativePath = parsed.origin === origin ? parsed.pathname : "/";
    const baseKey =
      relativePath === "/"
        ? "home"
        : relativePath
            .split("/")
            .filter(Boolean)
            .join("_")
            .replace(/[^a-z0-9_]+/gi, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toLowerCase() || "page";

    let candidate = baseKey;
    let suffix = 2;
    while (seenKeys.has(candidate)) {
      candidate = `${baseKey}_${suffix}`;
      suffix += 1;
    }
    seenKeys.add(candidate);
    return candidate;
  } catch {
    let fallback = "page";
    let suffix = 2;
    while (seenKeys.has(fallback)) {
      fallback = `page_${suffix}`;
      suffix += 1;
    }
    seenKeys.add(fallback);
    return fallback;
  }
}

function getBodyTextLength(html: string): number {
  const $ = load(html);
  return $("body").text().replace(/\s+/g, " ").trim().length;
}

async function fetchWithScraper(
  url: string,
  fetchMode: FetchMode,
): Promise<FetchedPage> {
  await guardUrl(url);
  if (!SCRAPER_API_KEY && fetchMode === "rendered") {
    throw new Error("Rendered crawl is unavailable");
  }
  if (!SCRAPER_API_KEY) {
    const start = Date.now();
    const response = await safeFetch(
      url,
      {
        headers: {
          "User-Agent": AUDIT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 3 },
    );
    const html = await readResponseTextLimited(response, 5 * 1024 * 1024);
    return {
      requestedUrl: url,
      finalUrl: response.url || url,
      pageKey: null,
      fetchMode: "static",
      httpStatus: response.status,
      contentType: response.headers.get("content-type") ?? "",
      durationMs: Date.now() - start,
      htmlLength: html.length,
      bodyTextLength: getBodyTextLength(html),
      error: null,
      html,
    };
  }
  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url,
  });

  if (fetchMode === "rendered") {
    params.set("render", "true");
  }

  const start = Date.now();
  const response = await fetch(`${SCRAPER_API_URL}/?${params.toString()}`, {
    signal: createTimeoutSignal(FETCH_TIMEOUT_MS),
  });
  const durationMs = Date.now() - start;
  const html = await readResponseTextLimited(response, 5 * 1024 * 1024);
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    throw new Error(`ScraperAPI failed: ${response.status} ${response.statusText}`);
  }

  return {
    requestedUrl: url,
    finalUrl: url,
    pageKey: null,
    fetchMode,
    httpStatus: response.status,
    contentType,
    durationMs,
    htmlLength: html.length,
    bodyTextLength: getBodyTextLength(html),
    error: null,
    html,
  };
}

export function extractInternalLinks(
  html: string,
  pageUrl: string,
  origin: string,
): string[] {
  const $ = load(html);
  const links = new Set<string>();

  $("a[href]").each((_, node) => {
    const href = $(node).attr("href")?.trim();
    if (!href) {
      return;
    }

    const normalized = normalizeAuditUrl(href, pageUrl);
    if (!normalized || !isSameOrigin(normalized, origin) || !isHtmlCandidate(normalized)) {
      return;
    }

    links.add(normalized);
  });

  return Array.from(links);
}

export function selectAuditUrls(
  homepageUrl: string,
  sitemapUrls: string[],
  internalLinks: string[],
  maxPages: number = MAX_AUDIT_PAGES,
): string[] {
  const homepage = normalizeAuditUrl(homepageUrl);
  if (!homepage) {
    return [];
  }

  const origin = new URL(homepage).origin;
  const results = new Set<string>([homepage]);

  const addCandidates = (candidates: string[]) => {
    const normalizedCandidates = candidates
      .map((candidate) => normalizeAuditUrl(candidate, origin))
      .filter((candidate): candidate is string => candidate !== null)
      .filter((candidate) => isSameOrigin(candidate, origin) && isHtmlCandidate(candidate))
      .sort((left, right) => scoreAuditUrl(left, homepage) - scoreAuditUrl(right, homepage));

    for (const candidate of normalizedCandidates) {
      if (results.size >= maxPages) {
        break;
      }
      results.add(candidate);
    }
  };

  addCandidates(sitemapUrls);
  addCandidates(internalLinks);

  return Array.from(results).slice(0, maxPages);
}

async function fetchTextDocument(url: string, timeoutMs: number): Promise<string> {
  let directFailureReason: string;
  await guardUrl(url);

  try {
    const response = await safeFetch(url, {
      headers: {
        "User-Agent": AUDIT_USER_AGENT,
        Accept: "text/xml,application/xml,text/plain,*/*;q=0.8",
      },
    }, { timeoutMs, maxRedirects: 3 });

    if (response.ok) {
      return await readResponseTextLimited(response, 5 * 1024 * 1024);
    }

    if (response.status === 404 || response.status === 410) {
      throw new Error(`Request failed (${response.status})`);
    }

    directFailureReason = `direct status ${response.status}`;
  } catch (error) {
    if (error instanceof Error && /^Request failed \((?:404|410)\)$/.test(error.message)) {
      throw error;
    }
    directFailureReason = error instanceof Error ? error.message : String(error);
  }

  if (!SCRAPER_API_KEY) {
    throw new Error(`Request failed after ${directFailureReason}`);
  }

  // Fallback path: 403/429/5xx and network/timeout errors are routed through
  // ScraperAPI, which usually clears CDN bot-blocks on robots.txt / sitemap.xml.
  const params = new URLSearchParams({ api_key: SCRAPER_API_KEY, url });
  const response = await fetch(`${SCRAPER_API_URL}/?${params.toString()}`, {
    signal: createTimeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `Request failed via scraper (${response.status}) after ${directFailureReason}`,
    );
  }

  return await readResponseTextLimited(response, 5 * 1024 * 1024);
}

async function fetchRobotsInfo(origin: string): Promise<RobotsInfo> {
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const text = await fetchTextDocument(robotsUrl, ROBOTS_TIMEOUT_MS);
    const sitemapDeclarations = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^sitemap:/i.test(line))
      .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
      .filter(Boolean);

    return {
      fetched: true,
      url: robotsUrl,
      text,
      sitemapDeclarations,
    };
  } catch {
    return {
      fetched: false,
      url: robotsUrl,
      text: "",
      sitemapDeclarations: [],
    };
  }
}

function looksLikeSitemap(xml: string): boolean {
  return /<urlset[\s>]|<sitemapindex[\s>]/i.test(xml);
}

async function discoverSitemapUrl(origin: string, robotsInfo: RobotsInfo): Promise<string> {
  const candidates = [
    ...robotsInfo.sitemapDeclarations,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap/sitemap.xml`,
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeAuditUrl(candidate, origin);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    try {
      const xml = await fetchTextDocument(normalized, ROBOTS_TIMEOUT_MS);
      if (looksLikeSitemap(xml)) {
        return normalized;
      }
    } catch {
      continue;
    }
  }

  return "";
}

async function fetchSitemapUrlsRecursive(
  sitemapUrl: string,
  depth: number = 0,
  visited: Set<string> = new Set<string>(),
  collected: Set<string> = new Set<string>(),
): Promise<string[]> {
  if (
    !sitemapUrl ||
    depth > MAX_SITEMAP_DEPTH ||
    visited.has(sitemapUrl) ||
    collected.size >= MAX_SITEMAP_URLS
  ) {
    return Array.from(collected);
  }

  visited.add(sitemapUrl);

  const xml = await fetchTextDocument(sitemapUrl, ROBOTS_TIMEOUT_MS);
  if (!looksLikeSitemap(xml)) {
    return Array.from(collected);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const sitemapIndex = parsed.sitemapindex as
    | { sitemap?: Array<{ loc?: string }> | { loc?: string } }
    | undefined;
  const urlset = parsed.urlset as
    | { url?: Array<{ loc?: string }> | { loc?: string } }
    | undefined;

  if (sitemapIndex?.sitemap) {
    const children = Array.isArray(sitemapIndex.sitemap)
      ? sitemapIndex.sitemap
      : [sitemapIndex.sitemap];

    for (const child of children) {
      if (typeof child?.loc === "string") {
        await fetchSitemapUrlsRecursive(child.loc, depth + 1, visited, collected);
      }
      if (collected.size >= MAX_SITEMAP_URLS) {
        break;
      }
    }
  }

  if (urlset?.url) {
    const urls = Array.isArray(urlset.url) ? urlset.url : [urlset.url];
    for (const item of urls) {
      if (typeof item?.loc === "string") {
        collected.add(item.loc);
      }
      if (collected.size >= MAX_SITEMAP_URLS) {
        break;
      }
    }
  }

  return Array.from(collected);
}

function extractMetaContent(
  $: ReturnType<typeof load>,
  selector: string,
): string {
  return $(selector).attr("content")?.trim() ?? "";
}

function collectTextValues(
  $: ReturnType<typeof load>,
  selector: string,
): string[] {
  return $(selector)
    .map((_, element) => $(element).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
}

function extractSchemaTypes(value: unknown, accumulator: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => extractSchemaTypes(item, accumulator));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const typeValue = record["@type"];
  if (typeof typeValue === "string") {
    accumulator.add(typeValue);
  } else if (Array.isArray(typeValue)) {
    typeValue
      .filter((item): item is string => typeof item === "string")
      .forEach((item) => accumulator.add(item));
  }

  for (const nestedValue of Object.values(record)) {
    extractSchemaTypes(nestedValue, accumulator);
  }
}

function jsonLdHasArticleDateModified(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => jsonLdHasArticleDateModified(item));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const typeValue = record["@type"];
  const isArticle =
    (typeof typeValue === "string" && /Article/i.test(typeValue)) ||
    (Array.isArray(typeValue) &&
      typeValue.some((t) => typeof t === "string" && /Article/i.test(t)));
  if (isArticle && typeof record["dateModified"] === "string") {
    return true;
  }
  for (const nestedValue of Object.values(record)) {
    if (jsonLdHasArticleDateModified(nestedValue)) {
      return true;
    }
  }
  return false;
}

function normalizeAuditDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function collectArticleDateModifiedValues(
  value: unknown,
  accumulator: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectArticleDateModifiedValues(item, accumulator));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const typeValue = record["@type"];
  const isArticle =
    (typeof typeValue === "string" && /Article/i.test(typeValue)) ||
    (Array.isArray(typeValue) &&
      typeValue.some((t) => typeof t === "string" && /Article/i.test(t)));

  if (isArticle && typeof record["dateModified"] === "string") {
    const normalizedDate = normalizeAuditDate(record["dateModified"]);
    if (normalizedDate) {
      accumulator.push(normalizedDate);
    }
  }

  for (const nestedValue of Object.values(record)) {
    collectArticleDateModifiedValues(nestedValue, accumulator);
  }
}

function buildSnippet(markup: string, limit: number): string {
  return markup.replace(/\s+/g, " ").trim().slice(0, limit);
}

function isMoneyPage(page: SeoAuditPageFacts): boolean {
  try {
    return isLikelyMoneyPage(new URL(page.url).pathname);
  } catch {
    return false;
  }
}

export function parseAuditPageFacts(
  crawledPage: FetchedPage,
  origin: string,
  pageKey: string,
): SeoAuditPageFacts {
  const $ = load(crawledPage.html);

  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const metaDescription = extractMetaContent($, 'meta[name="description"]');
  const metaRobots = extractMetaContent($, 'meta[name="robots"]');
  const viewportContent = extractMetaContent($, 'meta[name="viewport"]');
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href")?.trim() ?? "";
  const htmlLang = $("html").attr("lang")?.trim() ?? "";
  const headings = {
    h1: collectTextValues($, "h1"),
    h2: collectTextValues($, "h2"),
    h3: collectTextValues($, "h3"),
  };

  const hreflangEntries = $('link[rel="alternate"][hreflang]')
    .map((_, element) => {
      const value = $(element).attr("hreflang")?.trim() ?? "";
      const href = $(element).attr("href")?.trim() ?? "";
      return { value, href };
    })
    .get()
    .filter((entry) => entry.value || entry.href);

  const normalizedSelfUrl = normalizeAuditUrl(crawledPage.finalUrl, origin);
  const selfReferencing = hreflangEntries.some((entry) => {
    const normalizedHref = normalizeAuditUrl(entry.href, crawledPage.finalUrl);
    return normalizedHref && normalizedHref === normalizedSelfUrl;
  });

  const invalidHreflangEntries = hreflangEntries
    .filter((entry) => !HREFLANG_PATTERN.test(entry.value))
    .map((entry) => `${entry.value}:${entry.href}`.slice(0, 120));

  const images = $("img")
    .map((_, element) => ({
      alt: $(element).attr("alt")?.trim() ?? "",
      loading: $(element).attr("loading")?.trim() ?? "",
      dataSrc: $(element).attr("data-src")?.trim() ?? "",
    }))
    .get();

  const allLinks = $("a[href]")
    .map((_, element) => {
      const href = $(element).attr("href")?.trim() ?? "";
      const text = $(element).text().replace(/\s+/g, " ").trim();
      return { href, text };
    })
    .get();

  const internalLinks = allLinks.filter((link) => {
    const normalized = normalizeAuditUrl(link.href, crawledPage.finalUrl);
    return Boolean(normalized && isSameOrigin(normalized, origin) && isHtmlCandidate(normalized));
  });

  const ctaCount = allLinks.filter((link) => CTA_PATTERN.test(link.text)).length;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const hasVisibleLastUpdated = /last updated|updated on|updated:/i.test(bodyText);

  const schemaTypes = new Set<string>();
  let parseableJsonLdCount = 0;
  let invalidJsonLdCount = 0;
  let hasArticleDateModified = false;
  const articleDateModifiedValues: string[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      parseableJsonLdCount += 1;
      extractSchemaTypes(parsed, schemaTypes);
      if (jsonLdHasArticleDateModified(parsed)) {
        hasArticleDateModified = true;
      }
      collectArticleDateModifiedValues(parsed, articleDateModifiedValues);
    } catch {
      invalidJsonLdCount += 1;
    }
  });

  const articleModifiedTime = extractMetaContent($, 'meta[property="article:modified_time"]');
  const normalizedArticleModifiedTime = normalizeAuditDate(articleModifiedTime);
  if (normalizedArticleModifiedTime) {
    articleDateModifiedValues.push(normalizedArticleModifiedTime);
  }

  const latestArticleDateModified = articleDateModifiedValues.sort().slice(-1)[0] ?? null;

  const openGraph = {
    title: extractMetaContent($, 'meta[property="og:title"]'),
    description: extractMetaContent($, 'meta[property="og:description"]'),
    image: extractMetaContent($, 'meta[property="og:image"]'),
    url: extractMetaContent($, 'meta[property="og:url"]'),
  };

  const twitter = {
    card: extractMetaContent($, 'meta[name="twitter:card"]'),
    title: extractMetaContent($, 'meta[name="twitter:title"]'),
    description: extractMetaContent($, 'meta[name="twitter:description"]'),
    image: extractMetaContent($, 'meta[name="twitter:image"]'),
  };

  const headHtml = $("head").html() ?? "";
  const bodyHtml = $("body").html() ?? "";
  const hasContactPath = /contact/i.test(new URL(crawledPage.finalUrl).pathname);
  const hasLocationPath = /location|areas|cities|service-area/i.test(
    new URL(crawledPage.finalUrl).pathname,
  );
  const telLinkDetected = $('a[href^="tel:"]').length > 0;
  const phoneDetected = telLinkDetected || PHONE_PATTERN.test(bodyText);

  return {
    pageKey,
    requestedUrl: crawledPage.requestedUrl,
    url: crawledPage.finalUrl,
    fetchMode: crawledPage.fetchMode,
    title,
    metaDescription,
    metaRobots,
    viewportContent,
    canonicalUrl,
    htmlLang,
    headings,
    openGraph,
    twitter,
    hreflang: {
      count: hreflangEntries.length,
      values: hreflangEntries.map((entry) => entry.value),
      hrefs: hreflangEntries.map((entry) => entry.href),
      hasXDefault: hreflangEntries.some((entry) => /^x-default$/i.test(entry.value)),
      selfReferencing,
      invalidEntries: invalidHreflangEntries,
    },
    images: {
      count: images.length,
      missingAltCount: images.filter((image) => !image.alt).length,
      lazyLoadedCount: images.filter(
        (image) => image.loading.toLowerCase() === "lazy" || Boolean(image.dataSrc),
      ).length,
    },
    links: {
      internalCount: internalLinks.length,
      ctaCount,
    },
    content: {
      wordCount,
      bodyTextLength: bodyText.length,
      bodyTextExcerpt: bodyText.slice(0, BODY_SNIPPET_LIMIT),
      hasVisibleLastUpdated,
    },
    jsonLd: {
      count: $('script[type="application/ld+json"]').length,
      parseableCount: parseableJsonLdCount,
      invalidCount: invalidJsonLdCount,
      schemaTypes: Array.from(schemaTypes).sort(),
      hasArticleDateModified,
      latestArticleDateModified,
    },
    geoSignals: {
      phoneDetected,
      contactPageCandidate: hasContactPath,
      locationPageCandidate: hasLocationPath,
    },
    snippets: {
      head: buildSnippet(headHtml, HEAD_SNIPPET_LIMIT),
      body: buildSnippet(bodyHtml, BODY_SNIPPET_LIMIT),
    },
  };
}

function createParserCheck(params: {
  module: SeoAuditModule;
  key: string;
  label: string;
  status: SeoAuditCheckStatus;
  severity: SeoAuditFindingSeverity;
  value: string;
  rawSnippet?: string;
  details?: string;
  pageUrl?: string | null;
  pageKey?: string | null;
}): SeoAuditParserCheck {
  return {
    module: params.module,
    key: params.key,
    label: params.label,
    status: params.status,
    severity: params.severity,
    value: params.value,
    rawSnippet: params.rawSnippet ?? "",
    details: params.details ?? "",
    pageUrl: params.pageUrl ?? null,
    pageKey: params.pageKey ?? null,
    verifiedBy: "parser",
  };
}

function describeCountIssue(count: number, singular: string, plural: string): string {
  if (count === 0) {
    return `No ${plural}`;
  }
  if (count === 1) {
    return `1 ${singular}`;
  }
  return `${count} ${plural}`;
}

export function buildAuditParserChecks(
  siteFacts: SeoAuditSiteFacts,
  pageFacts: SeoAuditPageFacts[],
): SeoAuditParserCheck[] {
  const checks: SeoAuditParserCheck[] = [];
  const homepage = pageFacts.find((page) => page.pageKey === "home") ?? pageFacts[0];

  for (const page of pageFacts) {
    const titleLength = page.title.length;
    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.meta.viewport.present`,
        label: "Viewport meta tag",
        status: page.viewportContent ? "pass" : "warning",
        severity: page.viewportContent ? "pass" : "warning",
        value: page.viewportContent || "Missing viewport meta tag",
        rawSnippet: page.snippets.head,
        details: "Mobile-friendly pages should declare a viewport.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    const h1Count = page.headings.h1.length;
    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.headings.h1.count`,
        label: "Primary H1 heading count",
        status: h1Count === 1 ? "pass" : "warning",
        severity: h1Count === 1 ? "pass" : "warning",
        value: String(h1Count),
        rawSnippet: page.snippets.body,
        details: h1Count === 1 ? "Exactly one H1 detected." : `Detected ${h1Count} H1 tags.`,
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.canonical.present`,
        label: "Canonical link tag",
        status: page.canonicalUrl ? "pass" : "warning",
        severity: page.canonicalUrl ? "pass" : "warning",
        value: page.canonicalUrl || "Missing canonical URL",
        rawSnippet: page.snippets.head,
        details: "Canonical tags help consolidate duplicate URLs.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.meta.robots`,
        label: "Robots meta directives",
        status: /noindex/i.test(page.metaRobots) ? "warning" : "pass",
        severity: /noindex/i.test(page.metaRobots) ? "warning" : "pass",
        value: page.metaRobots || "index,follow (implicit)",
        rawSnippet: page.snippets.head,
        details: /noindex/i.test(page.metaRobots)
          ? "This page includes a noindex directive."
          : "No blocking robots meta detected.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.html.lang`,
        label: "HTML language attribute",
        status: page.htmlLang ? "pass" : "warning",
        severity: page.htmlLang ? "pass" : "warning",
        value: page.htmlLang || "Missing lang attribute",
        rawSnippet: page.snippets.head,
        details: "Set html[lang] to help search engines and accessibility tools.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "technical",
        key: `page.${page.pageKey}.images.alt_coverage`,
        label: "Image alt text coverage",
        status: page.images.missingAltCount === 0 ? "pass" : "warning",
        severity: page.images.missingAltCount === 0 ? "pass" : "warning",
        value: `${page.images.missingAltCount}/${page.images.count}`,
        rawSnippet: page.snippets.body,
        details:
          page.images.count === 0
            ? "No images detected on this page."
            : `${page.images.missingAltCount} of ${page.images.count} images are missing alt text.`,
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.content.word_count`,
        label: "Body content depth",
        status:
          !isMoneyPage(page) || page.content.wordCount >= LOW_WORD_COUNT_THRESHOLD
            ? "pass"
            : "warning",
        severity:
          !isMoneyPage(page) || page.content.wordCount >= LOW_WORD_COUNT_THRESHOLD
            ? "pass"
            : "warning",
        value: String(page.content.wordCount),
        rawSnippet: page.content.bodyTextExcerpt,
        details: `${page.content.wordCount} words detected in visible body text.`,
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.content.heading_depth`,
        label: "Secondary heading depth",
        status:
          page.headings.h2.length + page.headings.h3.length > 0 ? "pass" : "warning",
        severity:
          page.headings.h2.length + page.headings.h3.length > 0 ? "pass" : "warning",
        value: `${page.headings.h2.length} H2 / ${page.headings.h3.length} H3`,
        rawSnippet: page.snippets.body,
        details: "Pages usually benefit from descriptive secondary headings.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.links.internal_count`,
        label: "Internal linking density",
        status: page.links.internalCount >= 2 ? "pass" : "warning",
        severity: page.links.internalCount >= 2 ? "pass" : "warning",
        value: String(page.links.internalCount),
        rawSnippet: page.snippets.body,
        details: `${page.links.internalCount} internal links detected on the page.`,
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.cta.present`,
        label: "Call-to-action coverage",
        status: page.links.ctaCount > 0 || !isMoneyPage(page) ? "pass" : "warning",
        severity: page.links.ctaCount > 0 || !isMoneyPage(page) ? "pass" : "warning",
        value: String(page.links.ctaCount),
        rawSnippet: page.snippets.body,
        details:
          page.links.ctaCount > 0
            ? `${page.links.ctaCount} CTA-style links/buttons detected.`
            : "No CTA-like link text detected on this page.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    const titleHealthy =
      titleLength >= TITLE_MIN_LENGTH && titleLength <= TITLE_MAX_LENGTH;
    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.title.length`,
        label: "Title tag length",
        status: titleHealthy ? "pass" : "warning",
        severity: titleHealthy ? "pass" : "warning",
        value: String(titleLength),
        rawSnippet: page.snippets.head,
        details: `${titleLength} characters in the title tag.`,
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );

    const metaLength = page.metaDescription.length;
    const metaHealthy =
      metaLength >= META_DESCRIPTION_MIN_LENGTH &&
      metaLength <= META_DESCRIPTION_MAX_LENGTH;
    checks.push(
      createParserCheck({
        module: "competitorPages",
        key: `page.${page.pageKey}.meta.description.length`,
        label: "Meta description coverage",
        status: metaHealthy ? "pass" : "warning",
        severity: metaHealthy ? "pass" : "warning",
        value: String(metaLength),
        rawSnippet: page.snippets.head,
        details: metaLength
          ? `${metaLength} characters in the meta description.`
          : "Missing meta description.",
        pageUrl: page.url,
        pageKey: page.pageKey,
      }),
    );
  }

  const totalJsonLd = pageFacts.reduce((sum, page) => sum + page.jsonLd.count, 0);
  const parseableJsonLd = pageFacts.reduce(
    (sum, page) => sum + page.jsonLd.parseableCount,
    0,
  );
  const invalidJsonLd = pageFacts.reduce(
    (sum, page) => sum + page.jsonLd.invalidCount,
    0,
  );
  const schemaTypes = Array.from(
    new Set(pageFacts.flatMap((page) => page.jsonLd.schemaTypes)),
  ).sort();
  checks.push(
    createParserCheck({
      module: "schema",
      key: "site.schema.jsonld.present",
      label: "JSON-LD structured data present",
      status: parseableJsonLd > 0 ? "pass" : "warning",
      severity: parseableJsonLd > 0 ? "pass" : "warning",
      value: `${parseableJsonLd}/${totalJsonLd}`,
      rawSnippet: pageFacts[0]?.snippets.head ?? "",
      details:
        parseableJsonLd > 0
          ? `${parseableJsonLd} parseable JSON-LD blocks detected across the crawl.`
          : "No parseable JSON-LD detected.",
    }),
  );
  checks.push(
    createParserCheck({
      module: "schema",
      key: "site.schema.jsonld.validity",
      label: "JSON-LD validity",
      status: invalidJsonLd === 0 ? "pass" : "warning",
      severity: invalidJsonLd === 0 ? "pass" : "warning",
      value: String(invalidJsonLd),
      rawSnippet: pageFacts.find((page) => page.jsonLd.invalidCount > 0)?.snippets.head ?? "",
      details:
        invalidJsonLd === 0
          ? "All discovered JSON-LD blocks parsed successfully."
          : `${invalidJsonLd} JSON-LD blocks failed parsing.`,
    }),
  );
  checks.push(
    createParserCheck({
      module: "schema",
      key: "site.schema.types",
      label: "Schema type coverage",
      status: schemaTypes.length > 0 ? "pass" : "warning",
      severity: schemaTypes.length > 0 ? "pass" : "warning",
      value: schemaTypes.join(", ") || "No schema types detected",
      rawSnippet: pageFacts[0]?.snippets.head ?? "",
      details: describeCountIssue(schemaTypes.length, "schema type", "schema types"),
    }),
  );

  // Article schema dateModified check
  const articlePages = pageFacts.filter((page) =>
    page.jsonLd.schemaTypes.some((type) => /Article/i.test(type)),
  );
  const articlePagesMissingDateModified = articlePages.filter(
    (page) => !page.jsonLd.hasArticleDateModified,
  );
  const articlePagesMissingVisibleFreshness = articlePages.filter(
    (page) => !page.content.hasVisibleLastUpdated,
  );
  const articlePagesStale = articlePages.filter((page) => {
    if (!page.jsonLd.latestArticleDateModified) {
      return false;
    }

    const modifiedAt = new Date(page.jsonLd.latestArticleDateModified);
    if (Number.isNaN(modifiedAt.getTime())) {
      return false;
    }

    const ageDays = Math.floor((Date.now() - modifiedAt.getTime()) / 86400000);
    return ageDays >= 90;
  });
  if (articlePages.length > 0) {
    checks.push(
      createParserCheck({
        module: "schema",
        key: "site.schema.article_date_modified",
        label: "Article schema dateModified",
        status: articlePagesMissingDateModified.length === 0 ? "pass" : "warning",
        severity: articlePagesMissingDateModified.length === 0 ? "pass" : "warning",
        value:
          articlePagesMissingDateModified.length === 0
            ? "All articles have dateModified"
            : `${articlePagesMissingDateModified.length}/${articlePages.length} missing`,
        rawSnippet: articlePagesMissingDateModified[0]?.snippets.head ?? articlePages[0]?.snippets.head ?? "",
        details:
          articlePagesMissingDateModified.length === 0
            ? "All Article schema blocks include dateModified."
            : "Article schema missing dateModified. Add dateModified to help search engines and AI understand content freshness. Articles without dateModified lose AI citation rate after 3 months.",
      }),
    );
    checks.push(
      createParserCheck({
        module: "schema",
        key: "site.content.visible_last_updated",
        label: "Visible Last updated element",
        status: articlePagesMissingVisibleFreshness.length === 0 ? "pass" : "warning",
        severity: articlePagesMissingVisibleFreshness.length === 0 ? "pass" : "warning",
        value:
          articlePagesMissingVisibleFreshness.length === 0
            ? "Visible on all article pages"
            : `${articlePagesMissingVisibleFreshness.length}/${articlePages.length} missing`,
        rawSnippet:
          articlePagesMissingVisibleFreshness[0]?.snippets.body ??
          articlePages[0]?.snippets.body ??
          "",
        details:
          articlePagesMissingVisibleFreshness.length === 0
            ? "Article pages expose a visible Last updated element in the body."
            : "Article pages should display a visible Last updated date in the body so users and AI crawlers can easily confirm freshness.",
      }),
    );
    checks.push(
      createParserCheck({
        module: "schema",
        key: "site.content.freshness_window",
        label: "Content freshness within 90 days",
        status: articlePagesStale.length === 0 ? "pass" : "warning",
        severity: articlePagesStale.length === 0 ? "pass" : "warning",
        value:
          articlePagesStale.length === 0
            ? "No stale article pages detected"
            : `${articlePagesStale.length}/${articlePages.length} stale`,
        rawSnippet:
          articlePagesStale[0]?.snippets.head ??
          articlePages[0]?.snippets.head ??
          "",
        details:
          articlePagesStale.length === 0
            ? "Article dateModified values indicate content refreshed within the 90-day target."
            : "Some article pages appear older than 90 days based on dateModified/article:modified_time. Refresh stale pages to preserve AI citation strength.",
      }),
    );
  }

  const localBusinessSchema = schemaTypes.some((type) =>
    /LocalBusiness|Dentist|Attorney|MedicalClinic|Store|Restaurant|Organization/i.test(
      type,
    ),
  );
  const phoneDetected = pageFacts.some((page) => page.geoSignals.phoneDetected);
  const contactPages = pageFacts.filter(
    (page) => page.geoSignals.contactPageCandidate || page.geoSignals.locationPageCandidate,
  );
  checks.push(
    createParserCheck({
      module: "geo",
      key: "site.geo.local_business_schema",
      label: "Local business schema",
      status: localBusinessSchema ? "pass" : "warning",
      severity: localBusinessSchema ? "pass" : "warning",
      value: localBusinessSchema ? "Detected" : "Not detected",
      rawSnippet: pageFacts.find((page) =>
        page.jsonLd.schemaTypes.some((type) => /LocalBusiness/i.test(type)),
      )?.snippets.head ?? "",
      details: "Local schema helps reinforce location and entity signals.",
    }),
  );
  checks.push(
    createParserCheck({
      module: "geo",
      key: "site.geo.phone_detected",
      label: "Phone contact signal",
      status: phoneDetected ? "pass" : "warning",
      severity: phoneDetected ? "pass" : "warning",
      value: phoneDetected ? "Detected" : "Not detected",
      rawSnippet: pageFacts.find((page) => page.geoSignals.phoneDetected)?.snippets.body ?? "",
      details: "A visible phone number can strengthen local trust signals.",
    }),
  );
  checks.push(
    createParserCheck({
      module: "geo",
      key: "site.geo.contact_pages",
      label: "Contact or location pages",
      status: contactPages.length > 0 ? "pass" : "warning",
      severity: contactPages.length > 0 ? "pass" : "warning",
      value: String(contactPages.length),
      rawSnippet: contactPages[0]?.snippets.body ?? "",
      details:
        contactPages.length > 0
          ? `${contactPages.length} contact/location page candidates found.`
          : "No contact or location pages were found in the crawl set.",
    }),
  );

  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.sitemap.discovered",
      label: "Sitemap discovered",
      status: siteFacts.sitemapDiscovered ? "pass" : "warning",
      severity: siteFacts.sitemapDiscovered ? "pass" : "warning",
      value: siteFacts.sitemapUrl || "No sitemap discovered",
      rawSnippet: siteFacts.robotsTxtSnippet,
      details: "A crawlable sitemap helps search engines understand site coverage.",
    }),
  );
  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.sitemap.url_count",
      label: "Sitemap URL count",
      status: siteFacts.sitemapUrlCount > 0 ? "pass" : "warning",
      severity: siteFacts.sitemapUrlCount > 0 ? "pass" : "warning",
      value: String(siteFacts.sitemapUrlCount),
      rawSnippet: siteFacts.robotsTxtSnippet,
      details: `${siteFacts.sitemapUrlCount} URLs discovered from sitemap(s).`,
    }),
  );
  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.robots.sitemap_declarations",
      label: "robots.txt sitemap declarations",
      status: siteFacts.robotsSitemapDeclarations.length > 0 ? "pass" : "warning",
      severity: siteFacts.robotsSitemapDeclarations.length > 0 ? "pass" : "warning",
      value: String(siteFacts.robotsSitemapDeclarations.length),
      rawSnippet: siteFacts.robotsTxtSnippet,
      details:
        siteFacts.robotsSitemapDeclarations.length > 0
          ? "robots.txt declares at least one sitemap."
          : "robots.txt does not declare a sitemap.",
    }),
  );

  // AI Crawler robots.txt check
  const AI_CRAWLER_USER_AGENTS = [
    "GPTBot",
    "ChatGPT-User",
    "Google-Extended",
    "PerplexityBot",
    "ClaudeBot",
    "anthropic-ai",
  ];
  const hasAiCrawlerRules =
    siteFacts.robotsTxtFetched &&
    AI_CRAWLER_USER_AGENTS.some((agent) =>
      siteFacts.robotsTxtRawText.toLowerCase().includes(agent.toLowerCase()),
    );
  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.robots.ai_crawler_rules",
      label: "AI crawler rules in robots.txt",
      status: hasAiCrawlerRules ? "pass" : "warning",
      severity: hasAiCrawlerRules ? "pass" : "warning",
      value: hasAiCrawlerRules ? "Detected" : "Not detected",
      rawSnippet: siteFacts.robotsTxtSnippet,
      details: hasAiCrawlerRules
        ? "robots.txt contains rules for AI crawler user-agents."
        : "No AI crawler rules found in robots.txt. Consider adding explicit Allow rules for AI crawlers (GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot) to improve visibility in AI search results.",
    }),
  );

  // llms.txt check
  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.llms_txt",
      label: "llms.txt file",
      status: siteFacts.llmsTxtFound ? "pass" : "warning",
      severity: siteFacts.llmsTxtFound ? "pass" : "info",
      value: siteFacts.llmsTxtFound ? "Found" : "Not found",
      details: siteFacts.llmsTxtFound
        ? "llms.txt file detected at site root."
        : "No llms.txt file found. Consider adding /llms.txt to provide AI crawlers with a structured overview of your site content.",
    }),
  );

  const sitemapCoverage =
    pageFacts.length === 0
      ? 0
      : Math.round(
          (pageFacts.filter((page) =>
            siteFacts.sitemapSampleUrls.includes(page.url),
          ).length /
            pageFacts.length) *
            100,
        );
  checks.push(
    createParserCheck({
      module: "sitemap",
      key: "site.sitemap.crawl_coverage",
      label: "Crawled pages present in sitemap sample",
      status: !siteFacts.sitemapDiscovered || sitemapCoverage >= 50 ? "pass" : "warning",
      severity: !siteFacts.sitemapDiscovered || sitemapCoverage >= 50 ? "pass" : "warning",
      value: `${sitemapCoverage}%`,
      details: `${sitemapCoverage}% of crawled pages matched the sitemap sample set.`,
    }),
  );

  const hreflangPages = pageFacts.filter((page) => page.hreflang.count > 0);
  if (hreflangPages.length === 0) {
    checks.push(
      createParserCheck({
        module: "hreflang",
        key: "site.hreflang.not_required",
        label: "International targeting requirement",
        status: "pass",
        severity: "pass",
        value: "No alternate hreflang cluster detected",
        details: "No international targeting markup was found, so hreflang is treated as not required.",
      }),
    );
  } else {
    const invalidHreflangPages = hreflangPages.filter(
      (page) => page.hreflang.invalidEntries.length > 0,
    );
    const xDefaultPages = hreflangPages.filter((page) => page.hreflang.hasXDefault);
    const selfRefPages = hreflangPages.filter((page) => page.hreflang.selfReferencing);

    checks.push(
      createParserCheck({
        module: "hreflang",
        key: "site.hreflang.valid_entries",
        label: "Valid hreflang values",
        status: invalidHreflangPages.length === 0 ? "pass" : "warning",
        severity: invalidHreflangPages.length === 0 ? "pass" : "warning",
        value: `${invalidHreflangPages.length}`,
        rawSnippet: invalidHreflangPages[0]?.snippets.head ?? "",
        details:
          invalidHreflangPages.length === 0
            ? "All discovered hreflang values match the expected syntax."
            : `${invalidHreflangPages.length} pages have invalid hreflang values.`,
      }),
    );
    checks.push(
      createParserCheck({
        module: "hreflang",
        key: "site.hreflang.x_default",
        label: "x-default coverage",
        status: xDefaultPages.length > 0 ? "pass" : "warning",
        severity: xDefaultPages.length > 0 ? "pass" : "warning",
        value: String(xDefaultPages.length),
        rawSnippet: xDefaultPages[0]?.snippets.head ?? hreflangPages[0]?.snippets.head ?? "",
        details:
          xDefaultPages.length > 0
            ? `${xDefaultPages.length} pages include x-default.`
            : "No x-default hreflang entry detected.",
      }),
    );
    checks.push(
      createParserCheck({
        module: "hreflang",
        key: "site.hreflang.self_reference",
        label: "Self-referencing hreflang",
        status: selfRefPages.length === hreflangPages.length ? "pass" : "warning",
        severity: selfRefPages.length === hreflangPages.length ? "pass" : "warning",
        value: `${selfRefPages.length}/${hreflangPages.length}`,
        rawSnippet: hreflangPages[0]?.snippets.head ?? "",
        details: `${selfRefPages.length} of ${hreflangPages.length} hreflang pages self-reference their own URL.`,
      }),
    );
  }

  if (homepage) {
    checks.push(
      createParserCheck({
        module: "schema",
        key: "page.home.schema.primary_types",
        label: "Homepage schema types",
        status: homepage.jsonLd.schemaTypes.length > 0 ? "pass" : "warning",
        severity: homepage.jsonLd.schemaTypes.length > 0 ? "pass" : "warning",
        value: homepage.jsonLd.schemaTypes.join(", ") || "No homepage schema types",
        rawSnippet: homepage.snippets.head,
        pageUrl: homepage.url,
        pageKey: homepage.pageKey,
        details: "Homepage schema is often the clearest entity signal for the site.",
      }),
    );
  }

  return checks;
}

export function calculateModuleScore(checks: SeoAuditParserCheck[]): number {
  const relevantChecks = checks.filter(
    (check) => check.status !== "not_applicable" && check.status !== "unknown",
  );

  if (relevantChecks.length === 0) {
    return 100;
  }

  const total = relevantChecks.reduce((sum, check) => {
    if (check.status === "pass") {
      return sum + 1;
    }
    if (check.status === "warning") {
      return sum + 0.5;
    }
    return sum;
  }, 0);

  return Math.max(0, Math.min(100, Math.round((total / relevantChecks.length) * 100)));
}

export function calculateVerificationCoverage(checks: SeoAuditParserCheck[]): number {
  const verifiableChecks = checks.filter((check) => check.status !== "not_applicable");
  if (verifiableChecks.length === 0) {
    return 100;
  }

  const verifiedChecks = verifiableChecks.filter((check) => check.status !== "unknown");
  return Math.round((verifiedChecks.length / verifiableChecks.length) * 100);
}

export function deriveModuleStatus(
  checks: SeoAuditParserCheck[],
  hasModuleError: boolean,
): SeoAuditModuleStatus {
  if (hasModuleError) {
    return "failed";
  }

  return checks.some((check) => check.status === "unknown") ? "partial" : "ok";
}

function sanitizeAffectedUrls(urls: string[], fallbackUrl: string | null): string[] {
  const normalized = urls
    .map((url) => normalizeAuditUrl(url))
    .filter((url): url is string => Boolean(url));

  if (normalized.length > 0) {
    return Array.from(new Set(normalized));
  }

  return fallbackUrl ? [fallbackUrl] : [];
}

export function finalizeFindingFromCheck(
  module: SeoAuditModule,
  draft: ModelFindingDraft,
  checkMap: Map<string, SeoAuditParserCheck>,
): FinalizedFindingResult {
  const check = checkMap.get(draft.evidenceRef);

  if (!check) {
    return {
      finding: {
        severity: "info",
        title: draft.title,
        description: draft.description,
        evidenceRef: draft.evidenceRef,
        evidence: "",
        suggestedFix: draft.suggestedFix,
        sourceType: "ai_assessment",
        verificationStatus: "derived",
        affectedUrls: sanitizeAffectedUrls(draft.affectedUrls, null),
      },
      contradiction: {
        module,
        evidenceRef: draft.evidenceRef,
        findingTitle: draft.title,
        reason: "Finding referenced an unknown parser fact key.",
        originalSeverity: draft.severity,
        finalSeverity: "info",
        affectedUrls: sanitizeAffectedUrls(draft.affectedUrls, null),
      },
      scoreEligible: false,
    };
  }

  const affectedUrls = sanitizeAffectedUrls(draft.affectedUrls, check.pageUrl);
  const supportedByParser = check.status === "warning" || check.status === "fail";

  if (!supportedByParser) {
    return {
      finding: {
        severity: "info",
        title: draft.title,
        description: draft.description,
        evidenceRef: check.key,
        evidence: check.rawSnippet || check.value,
        suggestedFix: draft.suggestedFix,
        sourceType: "parser",
        verificationStatus: "contradicted",
        affectedUrls,
      },
      contradiction: {
        module,
        evidenceRef: check.key,
        findingTitle: draft.title,
        reason: `Parser check status is ${check.status}, so the claim was downgraded.`,
        originalSeverity: draft.severity,
        finalSeverity: "info",
        affectedUrls,
      },
      scoreEligible: false,
    };
  }

  return {
    finding: {
      severity: check.severity === "pass" ? "info" : check.severity,
      title: draft.title,
      description: draft.description,
      evidenceRef: check.key,
      evidence: check.rawSnippet || check.value,
      suggestedFix: draft.suggestedFix,
      sourceType: "parser",
      verificationStatus: "verified",
      affectedUrls,
    },
    contradiction: null,
    scoreEligible: true,
  };
}

export function buildRecommendationsFromFindings(
  modules: SeoAuditModuleReport[],
): SeoAuditRecommendation[] {
  const recommendations: SeoAuditRecommendation[] = modules
    .flatMap((moduleReport) =>
      moduleReport.findings
        .filter(
          (finding) =>
            moduleReport.module !== "plan" &&
            finding.verificationStatus === "verified" &&
            (finding.severity === "critical" || finding.severity === "warning"),
        )
        .map((finding): SeoAuditRecommendation => ({
          priority: finding.severity === "critical" ? "P0" : "P1",
          title: finding.title,
          description: finding.suggestedFix || finding.description,
          impact: finding.severity === "critical" ? "high" : "medium",
          effort: "medium" as const,
          module: moduleReport.module,
        })),
    )
    .filter(
      (recommendation, index, list) =>
        list.findIndex(
          (item) =>
            item.module === recommendation.module &&
            item.title === recommendation.title,
        ) === index,
    );

  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  recommendations.sort(
    (left, right) =>
      (priorityOrder[left.priority] ?? 2) - (priorityOrder[right.priority] ?? 2),
  );

  return recommendations;
}

function buildPageArtifact(page: FetchedPage): SeoAuditCrawlPage {
  return {
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    pageKey: page.pageKey,
    fetchMode: page.fetchMode,
    httpStatus: page.httpStatus,
    contentType: page.contentType,
    durationMs: page.durationMs,
    htmlLength: page.htmlLength,
    bodyTextLength: page.bodyTextLength,
    error: page.error,
  };
}

export async function buildSeoAuditRuntimeContext(
  websiteUrl: string,
): Promise<SeoAuditRuntimeContext> {
  const homepage = normalizeAuditUrl(websiteUrl);
  if (!homepage) {
    throw new Error("Invalid website URL for SEO audit");
  }
  await guardUrl(homepage);

  const origin = new URL(homepage).origin;
  const robotsInfo = await fetchRobotsInfo(origin);
  const sitemapUrl = await discoverSitemapUrl(origin, robotsInfo);
  const llmsTxtFound = await fetchTextDocument(`${origin}/llms.txt`, ROBOTS_TIMEOUT_MS)
    .then(() => true)
    .catch(() => false);
  const sitemapUrls = sitemapUrl
    ? (await fetchSitemapUrlsRecursive(sitemapUrl)).filter((url) =>
        isSameOrigin(normalizeAuditUrl(url, origin) ?? "", origin),
      )
    : [];

  let renderedPages = 0;

  let homepageFetched: FetchedPage = await fetchWithScraper(homepage, "static").catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        requestedUrl: homepage,
        finalUrl: homepage,
        pageKey: null,
        fetchMode: "static" as const,
        httpStatus: null,
        contentType: "",
        durationMs: 0,
        htmlLength: 0,
        bodyTextLength: 0,
        error: message,
        html: "",
      };
    },
  );

  // Upgrade the homepage to a rendered fetch up-front when the static HTML
  // looks like an unhydrated SPA shell. Without this, internal-link extraction
  // ran against the empty shell and returned 0 links, leaving the crawler
  // unable to discover /contact, /about, etc.
  if (
    !homepageFetched.error &&
    homepageFetched.html &&
    shouldUseRenderedFetch(homepageFetched.html)
  ) {
    try {
      homepageFetched = await fetchWithScraper(homepage, "rendered");
      renderedPages += 1;
    } catch {
      // Keep the guarded static result when rendered crawling is unavailable.
    }
  }

  const homepageInternalLinks =
    homepageFetched.error || !homepageFetched.html
      ? []
      : extractInternalLinks(homepageFetched.html, homepage, origin);

  const selectedUrls = selectAuditUrls(homepage, sitemapUrls, homepageInternalLinks);

  const crawledPages: FetchedPage[] = [];
  const pageKeyRegistry = new Set<string>();

  for (const selectedUrl of selectedUrls) {
    let fetchedPage: FetchedPage;

    if (selectedUrl === homepage) {
      // Reuse the up-front homepage fetch — avoids paying for two ScraperAPI
      // credits per audit and keeps the rendered HTML we already paid for.
      fetchedPage = homepageFetched;
    } else {
      try {
        fetchedPage = await fetchWithScraper(selectedUrl, "static");
        if (
          renderedPages < MAX_RENDERED_PAGES &&
          fetchedPage.html &&
          shouldUseRenderedFetch(fetchedPage.html)
        ) {
          try {
            fetchedPage = await fetchWithScraper(selectedUrl, "rendered");
            renderedPages += 1;
          } catch {
            // Keep the guarded static response.
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        fetchedPage = {
          requestedUrl: selectedUrl,
          finalUrl: selectedUrl,
          pageKey: null,
          fetchMode: "static",
          httpStatus: null,
          contentType: "",
          durationMs: 0,
          htmlLength: 0,
          bodyTextLength: 0,
          error: message,
          html: "",
        };
      }
    }

    fetchedPage.pageKey = fetchedPage.error
      ? null
      : derivePageKey(fetchedPage.finalUrl, origin, pageKeyRegistry);
    crawledPages.push(fetchedPage);
  }

  const pageFacts = crawledPages
    .filter((page) => !page.error && page.pageKey)
    .map((page) => parseAuditPageFacts(page, origin, page.pageKey as string));

  const crawlStats: SeoAuditCrawlStats = {
    attemptedPages: crawledPages.length,
    successfulPages: crawledPages.filter((page) => !page.error).length,
    failedPages: crawledPages.filter((page) => Boolean(page.error)).length,
    renderedPages,
    pages: crawledPages.map((page) => buildPageArtifact(page)),
  };

  const normalizedSitemapUrls = sitemapUrls
    .map((url) => normalizeAuditUrl(url, origin))
    .filter((url): url is string => Boolean(url));

  const siteFacts: SeoAuditSiteFacts = {
    websiteUrl: homepage,
    origin,
    sitemapDiscovered: Boolean(sitemapUrl),
    sitemapUrl,
    sitemapUrlCount: sitemapUrls.length,
    sitemapSampleUrls: normalizedSitemapUrls,
    robotsTxtFetched: robotsInfo.fetched,
    robotsTxtUrl: robotsInfo.url,
    robotsTxtSnippet: buildSnippet(robotsInfo.text, BODY_SNIPPET_LIMIT),
    robotsTxtRawText: robotsInfo.text,
    robotsSitemapDeclarations: robotsInfo.sitemapDeclarations,
    llmsTxtFound,
    crawlAttemptedCount: crawlStats.attemptedPages,
    crawlSucceededCount: crawlStats.successfulPages,
    crawlFailedCount: crawlStats.failedPages,
    renderedPageCount: renderedPages,
  };

  const parserChecks = buildAuditParserChecks(siteFacts, pageFacts);

  return {
    crawlStats,
    siteFacts,
    pageFacts,
    parserChecks,
    sources: pageFacts.map((page) => page.url),
  };
}
