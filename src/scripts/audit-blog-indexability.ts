import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient, PublishStatus, STATUS } from "@prisma/client";
import { readFile, writeFile } from "node:fs/promises";

const prisma = createPrismaClient();

const DEFAULT_APP_URL = "https://upliftai.co";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BLOGS = Number(process.env.INDEX_AUDIT_MAX_BLOGS || "500");
const LOOKBACK_DAYS = Number(process.env.INDEX_AUDIT_GSC_LOOKBACK_DAYS || "90");

type UrlKind = "hosted" | "client_published" | "provided";

type UrlCandidate = {
  blogId: string;
  businessId: string | null;
  businessName: string;
  title: string;
  slug: string;
  kind: UrlKind;
  platform: string;
  url: string;
  expectedCanonical: string;
};

type RobotsInfo = {
  origin: string;
  robotsUrl: string;
  fetched: boolean;
  status: number | null;
  blocksAll: boolean;
  sitemapUrls: string[];
  error: string | null;
};

type SitemapInfo = {
  origin: string;
  sitemapUrls: string[];
  fetched: boolean;
  urlCount: number;
  urls: Set<string>;
  error: string | null;
};

type PageCheck = {
  candidate: UrlCandidate;
  status: number | null;
  finalUrl: string | null;
  indexable: boolean;
  metaRobots: string | null;
  canonical: string | null;
  canonicalMatchesExpected: boolean;
  inSitemap: boolean | null;
  gscChecked: boolean;
  gscSkippedReason: GscSkippedReason | null;
  gscImpressions: number;
  gscClicks: number;
  lastGscDate: Date | null;
  issues: string[];
};

type GscSkippedReason = "missing_business_id" | "not_connected";

type GscSignals = {
  checked: boolean;
  skippedReason: GscSkippedReason | null;
  clicks: number;
  impressions: number;
  lastDate: Date | null;
};

const gscConnectionCache = new Map<string, Promise<boolean>>();

function getAppUrl() {
  const configured =
    process.env.INDEX_AUDIT_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PUBLIC_APP_URL;

  if (!configured) return DEFAULT_APP_URL;

  try {
    const url = new URL(configured);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "0.0.0.0";

    if (isLocalhost && process.env.INDEX_AUDIT_ALLOW_LOCAL !== "true") {
      return DEFAULT_APP_URL;
    }
  } catch {
    return DEFAULT_APP_URL;
  }

  return configured.replace(/\/$/, "");
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.searchParams.sort();
    const serialized = url.toString();
    return serialized.endsWith("/") ? serialized.slice(0, -1) : serialized;
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function normalizePathname(value: string) {
  try {
    const pathname = new URL(value).pathname;
    return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  } catch {
    return value;
  }
}

function isShopifyStorefrontCanonical(
  candidate: UrlCandidate,
  canonical: string,
) {
  if (candidate.platform.toUpperCase() !== "SHOPIFY") return false;

  try {
    const source = new URL(candidate.url);
    const target = new URL(canonical);
    return (
      source.hostname.endsWith(".myshopify.com") &&
      !target.hostname.endsWith(".myshopify.com") &&
      normalizePathname(source.toString()) ===
        normalizePathname(target.toString())
    );
  } catch {
    return false;
  }
}

function buildCanonicalMismatchIssue(
  candidate: UrlCandidate,
  canonical: string,
) {
  if (isShopifyStorefrontCanonical(candidate, canonical)) {
    return [
      `Shopify canonical points to custom storefront domain ${canonical}`,
      `but stored PublishedBlog.externalPostUrl is ${candidate.url}`,
      [
        "update the stored URL/integration to the canonical storefront URL",
        "or confirm this mapping is expected",
      ].join(" "),
    ].join("; ");
  }

  return [
    `Canonical points to ${canonical}`,
    `expected ${candidate.expectedCanonical}`,
  ].join(", ");
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isValidAbsoluteUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function slugFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.at(-1) || "provided-url";
  } catch {
    return "provided-url";
  }
}

function resolveUrl(value: string, base: string) {
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

async function fetchText(url: string): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  text: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "UpliftAI-Indexability-Audit/1.0 (+https://upliftai.co)",
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractAttr(tag: string, attr: string) {
  const pattern = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i");
  return tag.match(pattern)?.[1]?.trim() || null;
}

function extractMetaRobots(html: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = extractAttr(tag, "name") || extractAttr(tag, "property");
    if (name?.toLowerCase() === "robots") {
      return extractAttr(tag, "content");
    }
  }
  return null;
}

function extractCanonical(html: string, baseUrl: string) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = extractAttr(tag, "rel");
    if (rel?.toLowerCase().split(/\s+/).includes("canonical")) {
      const href = extractAttr(tag, "href");
      return href ? resolveUrl(href, baseUrl) : null;
    }
  }
  return null;
}

function extractSitemapUrlsFromRobots(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^sitemap\s*:/i.test(line))
    .map((line) => line.replace(/^sitemap\s*:/i, "").trim())
    .filter(Boolean);
}

function robotsBlocksAll(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"));

  let inWildcard = false;
  for (const line of lines) {
    if (line.startsWith("user-agent:")) {
      inWildcard = line.replace("user-agent:", "").trim() === "*";
      continue;
    }
    if (inWildcard && line.startsWith("disallow:")) {
      const value = line.replace("disallow:", "").trim();
      if (value === "/") return true;
    }
  }
  return false;
}

function extractLocUrls(xml: string) {
  const urls = new Set<string>();
  const locRegex = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = locRegex.exec(xml))) {
    const loc = match[1]?.trim();
    if (loc) urls.add(normalizeUrl(loc));
  }
  return urls;
}

async function getRobotsInfo(origin: string): Promise<RobotsInfo> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const response = await fetchText(robotsUrl);
    return {
      origin,
      robotsUrl,
      fetched: response.ok,
      status: response.status,
      blocksAll: response.ok ? robotsBlocksAll(response.text) : false,
      sitemapUrls: response.ok
        ? extractSitemapUrlsFromRobots(response.text)
        : [],
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      origin,
      robotsUrl,
      fetched: false,
      status: null,
      blocksAll: false,
      sitemapUrls: [],
      error: (error as Error).message,
    };
  }
}

async function getSitemapInfo(
  origin: string,
  robots: RobotsInfo,
): Promise<SitemapInfo> {
  const sitemapUrls =
    robots.sitemapUrls.length > 0
      ? robots.sitemapUrls
      : [`${origin}/sitemap.xml`];

  const urls = new Set<string>();
  const errors: string[] = [];
  let fetched = false;

  for (const sitemapUrl of sitemapUrls) {
    try {
      const response = await fetchText(sitemapUrl);
      if (!response.ok) {
        errors.push(`${sitemapUrl}: HTTP ${response.status}`);
        continue;
      }
      fetched = true;
      for (const loc of extractLocUrls(response.text)) {
        urls.add(loc);
      }
    } catch (error) {
      errors.push(`${sitemapUrl}: ${(error as Error).message}`);
    }
  }

  return {
    origin,
    sitemapUrls,
    fetched,
    urlCount: urls.size,
    urls,
    error: errors.length ? errors.join("; ") : null,
  };
}

async function getGscSignals(candidate: UrlCandidate): Promise<GscSignals> {
  if (!candidate.businessId) {
    return {
      checked: false,
      skippedReason: "missing_business_id",
      clicks: 0,
      impressions: 0,
      lastDate: null,
    };
  }

  const hasConnection = await hasGscConnection(candidate.businessId);
  if (!hasConnection) {
    return {
      checked: false,
      skippedReason: "not_connected",
      clicks: 0,
      impressions: 0,
      lastDate: null,
    };
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);

  const rows = await prisma.searchConsoleMetric.findMany({
    where: {
      businessId: candidate.businessId,
      page: candidate.url,
      date: { gte: since },
    },
    select: {
      clicks: true,
      impressions: true,
      date: true,
    },
  });

  return rows.reduce<GscSignals>(
    (acc, row) => ({
      checked: true,
      skippedReason: null,
      clicks: acc.clicks + row.clicks,
      impressions: acc.impressions + row.impressions,
      lastDate:
        !acc.lastDate || row.date > acc.lastDate ? row.date : acc.lastDate,
    }),
    {
      checked: true,
      skippedReason: null,
      clicks: 0,
      impressions: 0,
      lastDate: null,
    },
  );
}

async function hasGscConnection(businessId: string) {
  const cached = gscConnectionCache.get(businessId);
  if (cached) return cached;

  const promise = prisma.businessAnalyticsConfig
    .findUnique({
      where: { businessId },
      select: {
        gscSiteUrl: true,
        gscAccessToken: true,
        gscRefreshToken: true,
        gscConnectedAt: true,
      },
    })
    .then((config) =>
      Boolean(
        config?.gscSiteUrl ||
          config?.gscAccessToken ||
          config?.gscRefreshToken ||
          config?.gscConnectedAt,
      ),
    );

  gscConnectionCache.set(businessId, promise);
  return promise;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function buildProvidedCandidate(
  row: Record<string, unknown>,
  index: number,
): UrlCandidate | null {
  const url =
    toOptionalString(row.url) ||
    toOptionalString(row.externalPostUrl) ||
    toOptionalString(row.page);

  if (!url || !isValidAbsoluteUrl(url)) return null;

  const normalized = normalizeUrl(url);
  const title = toOptionalString(row.title) || normalized;
  const businessName =
    toOptionalString(row.businessName) ||
    toOptionalString(row.business) ||
    "Provided URL export";

  return {
    blogId: toOptionalString(row.blogId) || `provided-${index + 1}`,
    businessId: toOptionalString(row.businessId),
    businessName,
    title,
    slug: toOptionalString(row.slug) || slugFromUrl(normalized),
    kind: "provided",
    platform: toOptionalString(row.platform) || "PROVIDED",
    url: normalized,
    expectedCanonical:
      toOptionalString(row.expectedCanonical) ||
      toOptionalString(row.canonical) ||
      normalized,
  };
}

function parseJsonUrlFile(raw: string): UrlCandidate[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    return parsed
      .map((item, index) => {
        if (typeof item === "string") {
          return buildProvidedCandidate({ url: item }, index);
        }
        if (item && typeof item === "object") {
          return buildProvidedCandidate(item as Record<string, unknown>, index);
        }
        return null;
      })
      .filter((candidate): candidate is UrlCandidate => Boolean(candidate));
  } catch {
    return null;
  }
}

function parseDelimitedUrlFile(raw: string): UrlCandidate[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (lines.length === 0) return [];

  const firstCells = parseCsvLine(lines[0] || "");
  const lowerHeaders = firstCells.map((cell) => cell.toLowerCase());
  const hasHeader =
    lowerHeaders.includes("url") ||
    lowerHeaders.includes("externalposturl") ||
    lowerHeaders.includes("page");

  const headers = hasHeader ? firstCells : ["url"];
  const rows = hasHeader ? lines.slice(1) : lines;

  return rows
    .map((line, index) => {
      const cells = parseCsvLine(line);
      const row = headers.reduce<Record<string, string>>(
        (acc, header, cellIndex) => {
          acc[header.trim()] = cells[cellIndex]?.trim() || "";
          return acc;
        },
        {},
      );

      return buildProvidedCandidate(row, index);
    })
    .filter((candidate): candidate is UrlCandidate => Boolean(candidate));
}

async function buildCandidatesFromUrlFile(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseJsonUrlFile(raw) ?? parseDelimitedUrlFile(raw);
  const seen = new Set<string>();

  return parsed.filter((candidate) => {
    const normalized = normalizeUrl(candidate.url);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function buildCandidatesFromDatabase(): Promise<UrlCandidate[]> {
  const appUrl = getAppUrl();
  const hostedDomain =
    process.env.INDEX_AUDIT_HOSTED_BUSINESS_DOMAIN ||
    new URL(appUrl).hostname.replace(/^www\./, "");

  const hostedBlogs = await prisma.blog.findMany({
    where: {
      status: STATUS.PUBLISH,
      business: {
        businessWebsiteUrl: {
          contains: hostedDomain,
        },
      },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      canonicalUrl: true,
      businessId: true,
      business: { select: { businessName: true, businessWebsiteUrl: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_BLOGS,
  });

  const publishedBlogs = await prisma.publishedBlog.findMany({
    where: {
      status: { in: [PublishStatus.PUBLISHED, PublishStatus.UPDATED] },
      externalPostUrl: { not: null },
      blog: { status: STATUS.PUBLISH },
    },
    select: {
      platform: true,
      externalPostUrl: true,
      blog: {
        select: {
          id: true,
          title: true,
          slug: true,
          canonicalUrl: true,
          businessId: true,
          business: { select: { businessName: true } },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_BLOGS,
  });

  const candidates: UrlCandidate[] = [];

  for (const blog of hostedBlogs) {
    const hostedUrl = `${appUrl}/blog/${blog.slug}`;
    candidates.push({
      blogId: blog.id,
      businessId: blog.businessId,
      businessName: blog.business.businessName,
      title: blog.title,
      slug: blog.slug,
      kind: "hosted",
      platform: "UPLIFT",
      url: hostedUrl,
      expectedCanonical: blog.canonicalUrl?.trim() || hostedUrl,
    });
  }

  for (const published of publishedBlogs) {
    if (!published.externalPostUrl) continue;
    candidates.push({
      blogId: published.blog.id,
      businessId: published.blog.businessId,
      businessName: published.blog.business.businessName,
      title: published.blog.title,
      slug: published.blog.slug,
      kind: "client_published",
      platform: published.platform,
      url: published.externalPostUrl,
      expectedCanonical:
        published.blog.canonicalUrl?.trim() || published.externalPostUrl,
    });
  }

  return candidates;
}

async function buildCandidates(): Promise<UrlCandidate[]> {
  const urlFile = process.env.INDEX_AUDIT_URL_FILE?.trim();
  if (urlFile) {
    return buildCandidatesFromUrlFile(urlFile);
  }

  return buildCandidatesFromDatabase();
}

async function checkPage(
  candidate: UrlCandidate,
  sitemapInfo: SitemapInfo | null,
): Promise<PageCheck> {
  const issues: string[] = [];
  let status: number | null = null;
  let finalUrl: string | null = null;
  let metaRobots: string | null = null;
  let canonical: string | null = null;
  let canonicalMatchesExpected = false;

  try {
    const response = await fetchText(candidate.url);
    status = response.status;
    finalUrl = response.finalUrl;

    if (!response.ok) {
      issues.push(`Page returned HTTP ${response.status}`);
    } else {
      metaRobots = extractMetaRobots(response.text);
      canonical = extractCanonical(response.text, response.finalUrl);
      canonicalMatchesExpected =
        Boolean(canonical) &&
        normalizeUrl(canonical || "") ===
          normalizeUrl(candidate.expectedCanonical);

      if (metaRobots?.toLowerCase().includes("noindex")) {
        issues.push("Meta robots contains noindex");
      }
      if (!canonical) {
        issues.push("Missing canonical tag");
      } else if (!canonicalMatchesExpected) {
        issues.push(buildCanonicalMismatchIssue(candidate, canonical));
      }
    }
  } catch (error) {
    issues.push(`Fetch failed: ${(error as Error).message}`);
  }

  const normalizedUrl = normalizeUrl(candidate.url);
  const inSitemap = sitemapInfo ? sitemapInfo.urls.has(normalizedUrl) : null;
  if (inSitemap === false) {
    issues.push("URL not found in discovered sitemap URLs");
  }

  const gsc = await getGscSignals(candidate);
  if (gsc.skippedReason === "not_connected") {
    issues.push(
      "GSC metrics unavailable: business has no connected Search Console config",
    );
  } else if (gsc.checked && gsc.impressions === 0) {
    issues.push(`No GSC page impressions in last ${LOOKBACK_DAYS} days`);
  }

  return {
    candidate,
    status,
    finalUrl,
    indexable:
      status !== null &&
      status >= 200 &&
      status < 300 &&
      !metaRobots?.toLowerCase().includes("noindex"),
    metaRobots,
    canonical,
    canonicalMatchesExpected,
    inSitemap,
    gscChecked: gsc.checked,
    gscSkippedReason: gsc.skippedReason,
    gscImpressions: gsc.impressions,
    gscClicks: gsc.clicks,
    lastGscDate: gsc.lastDate,
    issues,
  };
}

function buildSummary(results: PageCheck[]) {
  const total = results.length;
  const issueRows = results.filter((row) => row.issues.length > 0);
  const indexable = results.filter((row) => row.indexable).length;
  const inSitemap = results.filter((row) => row.inSitemap === true).length;
  const gscChecked = results.filter((row) => row.gscChecked).length;
  const withGsc = results.filter((row) => row.gscImpressions > 0).length;
  const gscSkippedMissingBusiness = results.filter(
    (row) => row.gscSkippedReason === "missing_business_id",
  ).length;
  const gscSkippedNotConnected = results.filter(
    (row) => row.gscSkippedReason === "not_connected",
  ).length;

  return {
    total,
    issueCount: issueRows.length,
    indexable,
    inSitemap,
    gscChecked,
    withGsc,
    gscSkippedMissingBusiness,
    gscSkippedNotConnected,
  };
}

function printSummary(
  results: PageCheck[],
  robots: RobotsInfo[],
  sitemaps: SitemapInfo[],
) {
  const summary = buildSummary(results);
  const issueRows = results.filter((row) => row.issues.length > 0);

  console.log("\nBLOG INDEXABILITY AUDIT");
  console.log("=".repeat(72));
  console.log(`URLs checked: ${summary.total}`);
  console.log(`Indexable HTTP/meta: ${summary.indexable}/${summary.total}`);
  console.log(`Found in sitemap: ${summary.inSitemap}/${summary.total}`);
  console.log(
    `Seen in GSC metrics (${LOOKBACK_DAYS}d): ${summary.withGsc}/${summary.gscChecked} checked`,
  );
  if (summary.gscSkippedMissingBusiness > 0) {
    console.log(
      `GSC skipped: ${summary.gscSkippedMissingBusiness} URL(s) without a businessId`,
    );
  }
  if (summary.gscSkippedNotConnected > 0) {
    console.log(
      `GSC unavailable: ${summary.gscSkippedNotConnected} URL(s) without a connected Search Console config`,
    );
  }
  console.log(`URLs with issues/warnings: ${summary.issueCount}`);

  console.log("\nOrigins");
  for (const origin of robots) {
    const sitemap = sitemaps.find((item) => item.origin === origin.origin);
    console.log(
      `- ${origin.origin} | robots: ${
        origin.fetched ? "ok" : origin.error || "failed"
      } | blocks all: ${origin.blocksAll ? "yes" : "no"} | sitemap URLs: ${
        sitemap?.urlCount ?? 0
      }`,
    );
  }

  if (issueRows.length > 0) {
    console.log("\nTop issues");
    for (const row of issueRows.slice(0, 50)) {
      console.log(
        `- [${row.candidate.kind}/${row.candidate.platform}] ${row.candidate.title}`,
      );
      console.log(`  ${row.candidate.url}`);
      console.log(`  Business: ${row.candidate.businessName}`);
      console.log(`  Issues: ${row.issues.join("; ")}`);
    }
  }

  console.log("\nRecommended process");
  console.log("- Run this script weekly against production.");
  console.log(
    "- Treat HTTP errors, noindex, canonical mismatches, and missing sitemap URLs as blockers.",
  );
  console.log(
    "- Connect Search Console before treating GSC metrics as true indexing evidence.",
  );
  console.log(
    "- For pages with no GSC impressions, verify in GSC URL Inspection or request indexing after blockers are fixed.",
  );
}

async function writeJsonReportIfRequested(
  results: PageCheck[],
  robots: RobotsInfo[],
  sitemaps: SitemapInfo[],
) {
  const outputPath = process.env.INDEX_AUDIT_OUTPUT_JSON?.trim();
  if (!outputPath) return;

  const report = {
    generatedAt: new Date().toISOString(),
    source: process.env.INDEX_AUDIT_URL_FILE ? "url_file" : "database",
    lookbackDays: LOOKBACK_DAYS,
    summary: buildSummary(results),
    origins: robots.map((robot) => {
      const sitemap = sitemaps.find((item) => item.origin === robot.origin);
      return {
        origin: robot.origin,
        robotsUrl: robot.robotsUrl,
        robotsFetched: robot.fetched,
        robotsStatus: robot.status,
        robotsBlocksAll: robot.blocksAll,
        robotsError: robot.error,
        sitemapUrls: sitemap?.sitemapUrls ?? [],
        sitemapFetched: sitemap?.fetched ?? false,
        sitemapUrlCount: sitemap?.urlCount ?? 0,
        sitemapError: sitemap?.error ?? null,
      };
    }),
    results: results.map((row) => ({
      candidate: row.candidate,
      status: row.status,
      finalUrl: row.finalUrl,
      indexable: row.indexable,
      metaRobots: row.metaRobots,
      canonical: row.canonical,
      canonicalMatchesExpected: row.canonicalMatchesExpected,
      inSitemap: row.inSitemap,
      gscChecked: row.gscChecked,
      gscSkippedReason: row.gscSkippedReason,
      gscImpressions: row.gscImpressions,
      gscClicks: row.gscClicks,
      lastGscDate: row.lastGscDate?.toISOString() ?? null,
      issues: row.issues,
    })),
  };

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nJSON report written to ${outputPath}`);
}

async function main() {
  const candidates = await buildCandidates();
  if (candidates.length === 0) {
    console.log("No published blog URLs found.");
    return;
  }

  const origins = Array.from(
    new Set(
      candidates.map((candidate) => {
        const url = new URL(candidate.url);
        return url.origin;
      }),
    ),
  );

  const robots = await Promise.all(origins.map(getRobotsInfo));
  const sitemaps = await Promise.all(
    robots.map((info) => getSitemapInfo(info.origin, info)),
  );
  const sitemapByOrigin = new Map(
    sitemaps.map((info) => [info.origin, info] as const),
  );

  const results: PageCheck[] = [];
  for (const candidate of candidates) {
    const origin = new URL(candidate.url).origin;
    const sitemap = sitemapByOrigin.get(origin) ?? null;
    results.push(await checkPage(candidate, sitemap));
  }

  printSummary(results, robots, sitemaps);
  await writeJsonReportIfRequested(results, robots, sitemaps);
}

main()
  .catch((error) => {
    console.error("Blog indexability audit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
