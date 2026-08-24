import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import {
  SEO_AUDIT_PARSER_VERSION,
  buildAuditParserChecks,
  normalizeAuditUrl,
  parseAuditPageFacts,
  shouldUseRenderedFetch,
} from "./seo-audit.runtime";
import { fetchWithScraperAPI } from "../utils/tools.utils";
import type {
  SeoAuditCheckStatus,
  SeoAuditFindingSeverity,
  SeoAuditPageFacts,
  SeoAuditParserCheck,
} from "../validators/seo-audit.validation";
import {
  guardUrl,
  readResponseTextLimited,
  safeFetch,
} from "../utils/ssrf-guard";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const PUBLIC_TOOL_USER_AGENT = "Mozilla/5.0 (compatible; UpliftPublicSEOTool/1.0)";
const CLOUDFLARE_BLOCK_PATTERNS = [
  "Just a moment...",
  "cf-browser-verification",
  "Attention Required! | Cloudflare",
  "Checking if the site connection is secure",
];

export type PublicToolSummaryStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "unavailable";

export type PublicToolCheckStatus = "pass" | "warning" | "fail" | "info";

export type PublicToolMetric = {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "critical";
};

export type PublicToolCheck = {
  key: string;
  label: string;
  status: PublicToolCheckStatus;
  details: string;
  value?: string;
};

export type PublicToolRecommendation = {
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
};

export type PublicToolSource = {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  contentType: string;
  fetchMode: "static" | "rendered";
  notes: string[];
  parserVersion?: string;
  facts?: Array<{ label: string; value: string }>;
};

export type PublicToolResult = {
  summary: {
    status: PublicToolSummaryStatus;
    title: string;
    description: string;
    score: number | null;
  };
  metrics: PublicToolMetric[];
  checks: PublicToolCheck[];
  recommendations: PublicToolRecommendation[];
  source: PublicToolSource;
  limitations: string[];
};

type PageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  contentType: string;
  html: string;
  fetchMode: "static" | "rendered";
  notes: string[];
};

type PageAnalyzerContext = {
  snapshot: PageSnapshot;
  pageFacts: SeoAuditPageFacts;
  parserChecks: SeoAuditParserCheck[];
  $: ReturnType<typeof load>;
};

type RawCheck = {
  key: string;
  label: string;
  status: PublicToolCheckStatus;
  details: string;
  value?: string;
  priority?: "high" | "medium" | "low";
  recommendedFix?: string;
};

type NormalizedCheckInput = RawCheck | SeoAuditParserCheck;

function parseUrl(input: string): string | null {
  try {
    return new URL(input.startsWith("http") ? input : `https://${input}`).toString();
  } catch {
    return null;
  }
}

function isCloudflareBlock(html: string): boolean {
  return CLOUDFLARE_BLOCK_PATTERNS.some((pattern) => html.includes(pattern));
}

async function fetchStaticPage(url: string): Promise<PageSnapshot> {
  const response = await safeFetch(url, {
    headers: {
      "User-Agent": PUBLIC_TOOL_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  }, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, maxRedirects: 3 });

  const html = await readResponseTextLimited(response, 5 * 1024 * 1024);
  return {
    requestedUrl: url,
    finalUrl: response.url || url,
    httpStatus: response.status,
    contentType: response.headers.get("content-type") || "text/html",
    html,
    fetchMode: "static",
    notes: [],
  };
}

async function fetchRenderedPage(url: string, reason: string): Promise<PageSnapshot> {
  await guardUrl(url);
  const html = await fetchWithScraperAPI(url, { render: true });
  return {
    requestedUrl: url,
    finalUrl: url,
    httpStatus: 200,
    contentType: "text/html",
    html,
    fetchMode: "rendered",
    notes: [`Render fallback used: ${reason}.`],
  };
}

function shouldRetryWithRender(html: string): { useRender: boolean; reason: string | null } {
  if (!html.trim()) {
    return { useRender: true, reason: "empty HTML response" };
  }
  if (isCloudflareBlock(html)) {
    return { useRender: true, reason: "blocked by a bot-protection interstitial" };
  }
  if (shouldUseRenderedFetch(html)) {
    return { useRender: true, reason: "JS-heavy or app-shell markup detected" };
  }
  return { useRender: false, reason: null };
}

async function analyzePage(url: string): Promise<PageAnalyzerContext> {
  const normalizedUrl = parseUrl(url);
  if (!normalizedUrl) {
    throw new Error("Invalid URL");
  }

  let snapshot: PageSnapshot;
  try {
    snapshot = await fetchStaticPage(normalizedUrl);
  } catch (error) {
    if (!process.env.SCRAPER_API_KEY) {
      throw new Error("Could not fetch the page");
    }
    snapshot = await fetchRenderedPage(normalizedUrl, "static fetch failed");
  }

  const renderDecision = shouldRetryWithRender(snapshot.html);
  if (renderDecision.useRender && process.env.SCRAPER_API_KEY) {
    try {
      snapshot = await fetchRenderedPage(snapshot.finalUrl || normalizedUrl, renderDecision.reason!);
    } catch {
      snapshot.notes.push("Render fallback was attempted but the rendered fetch failed.");
    }
  }

  if (!snapshot.html.trim()) {
    throw new Error("Website returned empty content.");
  }

  const origin = new URL(snapshot.finalUrl || normalizedUrl).origin;
  const pageFacts = parseAuditPageFacts(
    {
      requestedUrl: normalizedUrl,
      finalUrl: snapshot.finalUrl || normalizedUrl,
      pageKey: "home",
      fetchMode: snapshot.fetchMode,
      httpStatus: snapshot.httpStatus,
      contentType: snapshot.contentType,
      durationMs: 0,
      htmlLength: snapshot.html.length,
      bodyTextLength: 0,
      error: null,
      html: snapshot.html,
    },
    origin,
    "home",
  );

  const parserChecks = buildAuditParserChecks(
    {
      websiteUrl: normalizedUrl,
      origin,
      sitemapDiscovered: false,
      sitemapUrl: "",
      sitemapUrlCount: 0,
      sitemapSampleUrls: [],
      robotsTxtFetched: false,
      robotsTxtUrl: `${origin}/robots.txt`,
      robotsTxtSnippet: "",
      robotsTxtRawText: "",
      robotsSitemapDeclarations: [],
      llmsTxtFound: false,
      crawlAttemptedCount: 1,
      crawlSucceededCount: snapshot.httpStatus && snapshot.httpStatus < 400 ? 1 : 0,
      crawlFailedCount: snapshot.httpStatus && snapshot.httpStatus >= 400 ? 1 : 0,
      renderedPageCount: snapshot.fetchMode === "rendered" ? 1 : 0,
    },
    [pageFacts],
  );

  return {
    snapshot,
    pageFacts,
    parserChecks,
    $: load(snapshot.html),
  };
}

function parserCheckStatusToToolStatus(status: SeoAuditCheckStatus): PublicToolCheckStatus {
  if (status === "pass") {
    return "pass";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "fail") {
    return "fail";
  }
  return "info";
}

function parserSeverityToPriority(severity: SeoAuditFindingSeverity): "high" | "medium" | "low" {
  if (severity === "critical") {
    return "high";
  }
  if (severity === "warning") {
    return "medium";
  }
  return "low";
}

function normalizeCheck(input: NormalizedCheckInput): RawCheck {
  if ("verifiedBy" in input) {
    return {
      key: input.key,
      label: input.label,
      status: parserCheckStatusToToolStatus(input.status),
      details: input.details || input.value || "",
      value: input.value || undefined,
      priority: parserSeverityToPriority(input.severity),
      recommendedFix: defaultRecommendationForCheck(input.label, input.details || input.value || ""),
    };
  }

  return {
    priority: "medium",
    ...input,
  };
}

function summarizeChecks(checks: RawCheck[]): PublicToolResult["summary"] {
  const passCount = checks.filter((check) => check.status === "pass").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const failCount = checks.filter((check) => check.status === "fail").length;
  const score = checks.length > 0 ? Math.max(0, Math.round((passCount / checks.length) * 100)) : null;

  if (failCount > 0) {
    return {
      status: "critical",
      title: "Critical issues found",
      description: `${failCount} high-severity checks need attention before this page is fully healthy.`,
      score,
    };
  }

  if (warningCount > 0) {
    return {
      status: "warning",
      title: "Actionable SEO improvements found",
      description: `${warningCount} checks are worth improving to strengthen crawlability, metadata, and structured data quality.`,
      score,
    };
  }

  return {
    status: "healthy",
    title: "Core SEO signals look healthy",
    description: "The analyzed checks passed without notable metadata or crawlability issues.",
    score,
  };
}

function buildRecommendations(checks: RawCheck[]): PublicToolRecommendation[] {
  const prioritized = checks
    .filter((check) => check.status !== "pass")
    .slice(0, 5)
    .map((check) => ({
      priority: check.priority ?? "medium",
      title: check.label,
      description: check.recommendedFix || defaultRecommendationForCheck(check.label, check.details),
    }));

  return prioritized;
}

function defaultRecommendationForCheck(label: string, details: string): string {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes("title")) {
    return "Tighten the title tag so it is descriptive, keyword-aligned, and within the recommended length range.";
  }
  if (lowerLabel.includes("meta description")) {
    return "Add or revise the meta description so it clearly explains the page and stays within the recommended length range.";
  }
  if (lowerLabel.includes("canonical")) {
    return "Use one absolute, self-referencing canonical tag that matches the preferred live URL.";
  }
  if (lowerLabel.includes("viewport")) {
    return "Add a viewport meta tag so mobile browsers and search engines receive a mobile-friendly layout hint.";
  }
  if (lowerLabel.includes("json-ld") || lowerLabel.includes("schema")) {
    return "Publish valid JSON-LD that matches the page type and fix any malformed structured data blocks.";
  }
  if (lowerLabel.includes("h1")) {
    return "Use one clear H1 that matches the page topic, then structure supporting sections under H2s/H3s.";
  }
  if (lowerLabel.includes("alt")) {
    return "Add descriptive alt text to meaningful images so search engines and assistive technologies understand them.";
  }
  if (lowerLabel.includes("robots")) {
    return "Adjust the robots directives so important pages remain crawlable and supporting files like the sitemap are discoverable.";
  }
  if (lowerLabel.includes("sitemap")) {
    return "Fix sitemap reachability and XML validity, then make sure important URLs and lastmod dates are included.";
  }
  if (lowerLabel.includes("internal")) {
    return "Add more relevant internal links so users and crawlers can discover related content from this page.";
  }
  return details || `Resolve the issue surfaced by "${label}" and re-check the page afterward.`;
}

function toPublicToolResult(params: {
  checks: Array<NormalizedCheckInput>;
  metrics: PublicToolMetric[];
  source: PublicToolSource;
  limitations: string[];
  unavailableTitle?: string;
  unavailableDescription?: string;
}): PublicToolResult {
  const checks = params.checks.map(normalizeCheck);
  const summary = summarizeChecks(checks);
  const source = {
    ...params.source,
    facts:
      params.source.facts ??
      [
        { label: "Fetch mode", value: params.source.fetchMode },
        {
          label: "HTTP status",
          value:
            params.source.httpStatus === null
              ? "unknown"
              : String(params.source.httpStatus),
        },
        {
          label: "Final URL",
          value: params.source.finalUrl,
        },
      ],
  };

  return {
    summary,
    metrics: params.metrics,
    checks: checks.map((check) => ({
      key: check.key,
      label: check.label,
      status: check.status,
      details: check.details,
      value: check.value,
    })),
    recommendations: buildRecommendations(checks),
    source,
    limitations: params.limitations,
  };
}

function buildUnavailableResult(params: {
  requestedUrl: string;
  message: string;
  limitations?: string[];
}): PublicToolResult {
  return {
    summary: {
      status: "unavailable",
      title: "We could not analyze this URL",
      description: params.message,
      score: null,
    },
    metrics: [],
    checks: [
      {
        key: "unavailable",
        label: "Page reachability",
        status: "fail",
        details: params.message,
      },
    ],
    recommendations: [
      {
        priority: "high",
        title: "Verify the page is publicly reachable",
        description:
          "Make sure the URL loads without authentication or bot blocking, then run the check again.",
      },
    ],
    source: {
      requestedUrl: params.requestedUrl,
      finalUrl: params.requestedUrl,
      httpStatus: null,
      contentType: "",
      fetchMode: "static",
      notes: [],
      parserVersion: SEO_AUDIT_PARSER_VERSION,
    },
    limitations: params.limitations ?? [
      "This tool can only evaluate URLs that are publicly reachable at crawl time.",
    ],
  };
}

function inferTone(value: number, warningThreshold: number, criticalThreshold: number): PublicToolMetric["tone"] {
  if (value >= criticalThreshold) {
    return "critical";
  }
  if (value >= warningThreshold) {
    return "warning";
  }
  return "success";
}

function countSocialTags(pageFacts: SeoAuditPageFacts): number {
  const socialFields = [
    pageFacts.openGraph.title,
    pageFacts.openGraph.description,
    pageFacts.openGraph.image,
    pageFacts.openGraph.url,
    pageFacts.twitter.card,
    pageFacts.twitter.title,
    pageFacts.twitter.description,
    pageFacts.twitter.image,
  ];
  return socialFields.filter(Boolean).length;
}

function parserCheckBySuffix(
  checks: SeoAuditParserCheck[],
  suffix: string,
): SeoAuditParserCheck | undefined {
  return checks.find((check) => check.key.endsWith(suffix));
}

export async function analyzeMetadataTool(url: string) {
  try {
    const { snapshot, pageFacts, parserChecks, $ } = await analyzePage(url);
    const charset =
      $('meta[charset]').attr("charset")?.trim() ||
      snapshot.html.match(/charset=["']?([^"'\s>]+)/i)?.[1] ||
      null;

    const socialChecks: RawCheck[] = [
      {
        key: "social.og.title",
        label: "Open Graph title",
        status: pageFacts.openGraph.title ? "pass" : "warning",
        details: pageFacts.openGraph.title
          ? "An og:title value is present."
          : "Add og:title so link previews use a stable title.",
        value: pageFacts.openGraph.title || undefined,
      },
      {
        key: "social.og.description",
        label: "Open Graph description",
        status: pageFacts.openGraph.description ? "pass" : "warning",
        details: pageFacts.openGraph.description
          ? "An og:description value is present."
          : "Add og:description so social previews explain the page.",
        value: pageFacts.openGraph.description || undefined,
      },
      {
        key: "social.og.image",
        label: "Open Graph image",
        status: pageFacts.openGraph.image ? "pass" : "warning",
        details: pageFacts.openGraph.image
          ? "An og:image value is present."
          : "Add og:image so social shares can render a preview image.",
        value: pageFacts.openGraph.image || undefined,
      },
      {
        key: "social.twitter.card",
        label: "Twitter card",
        status: pageFacts.twitter.card ? "pass" : "warning",
        details: pageFacts.twitter.card
          ? "A twitter:card value is present."
          : "Add twitter:card so X/Twitter can render an explicit card type.",
        value: pageFacts.twitter.card || undefined,
      },
    ];

    const checks = [
      parserCheckBySuffix(parserChecks, "title.length"),
      parserCheckBySuffix(parserChecks, "meta.description.length"),
      parserCheckBySuffix(parserChecks, "meta.viewport.present"),
      parserCheckBySuffix(parserChecks, "canonical.present"),
      parserCheckBySuffix(parserChecks, "schema.jsonld.present"),
      parserCheckBySuffix(parserChecks, "schema.jsonld.validity"),
      parserCheckBySuffix(parserChecks, "schema.types"),
      ...socialChecks,
    ].filter(Boolean) as Array<NormalizedCheckInput>;

    const result = toPublicToolResult({
      checks,
      metrics: [
        {
          label: "Title length",
          value: `${pageFacts.title.length} chars`,
          hint: "Aim for 20-65 characters in this audit baseline.",
          tone:
            pageFacts.title.length >= 20 && pageFacts.title.length <= 65
              ? "success"
              : "warning",
        },
        {
          label: "Meta description",
          value: pageFacts.metaDescription
            ? `${pageFacts.metaDescription.length} chars`
            : "Missing",
          hint: "Aim for roughly 70-170 characters.",
          tone: pageFacts.metaDescription ? "success" : "warning",
        },
        {
          label: "Schema types",
          value: pageFacts.jsonLd.schemaTypes.length
            ? pageFacts.jsonLd.schemaTypes.join(", ")
            : "None detected",
          tone: pageFacts.jsonLd.schemaTypes.length ? "success" : "warning",
        },
        {
          label: "Social tags found",
          value: `${countSocialTags(pageFacts)}/8`,
          hint: "Open Graph and Twitter coverage combined.",
          tone: inferTone(8 - countSocialTags(pageFacts), 1, 4),
        },
      ],
      source: {
        requestedUrl: snapshot.requestedUrl,
        finalUrl: snapshot.finalUrl,
        httpStatus: snapshot.httpStatus,
        contentType: snapshot.contentType,
        fetchMode: snapshot.fetchMode,
        notes: snapshot.notes,
        parserVersion: SEO_AUDIT_PARSER_VERSION,
      },
      limitations: [
        "Checks the requested page URL only; it does not evaluate every page on the site.",
        "Social preview rendering can still vary slightly by platform even when tags are present.",
      ],
    });

    const issues = result.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.details || check.label);

    return {
      url: snapshot.requestedUrl,
      title: pageFacts.title || null,
      titleLength: pageFacts.title.length,
      description: pageFacts.metaDescription || null,
      descriptionLength: pageFacts.metaDescription.length,
      openGraph: {
        title: pageFacts.openGraph.title || null,
        description: pageFacts.openGraph.description || null,
        image: pageFacts.openGraph.image || null,
        url: pageFacts.openGraph.url || null,
        type: $('meta[property="og:type"]').attr("content")?.trim() || null,
        siteName: $('meta[property="og:site_name"]').attr("content")?.trim() || null,
      },
      twitterCard: {
        card: pageFacts.twitter.card || null,
        title: pageFacts.twitter.title || null,
        description: pageFacts.twitter.description || null,
        image: pageFacts.twitter.image || null,
      },
      canonical: pageFacts.canonicalUrl || null,
      viewport: pageFacts.viewportContent || null,
      robots: pageFacts.metaRobots || null,
      charset,
      issues,
      status: snapshot.httpStatus,
      summary: result.summary,
      metrics: result.metrics,
      checks: result.checks,
      recommendations: result.recommendations,
      source: result.source,
      limitations: result.limitations,
    };
  } catch (error: any) {
    const fallback = buildUnavailableResult({
      requestedUrl: parseUrl(url) || url,
      message: error?.message || "Could not fetch the page",
    });

    return {
      url: parseUrl(url) || url,
      title: null,
      titleLength: 0,
      description: null,
      descriptionLength: 0,
      openGraph: {
        title: null,
        description: null,
        image: null,
        url: null,
        type: null,
        siteName: null,
      },
      twitterCard: {
        card: null,
        title: null,
        description: null,
        image: null,
      },
      canonical: null,
      viewport: null,
      robots: null,
      charset: null,
      issues: [fallback.summary.description],
      status: null,
      ...fallback,
    };
  }
}

export async function analyzeCanonicalTool(url: string) {
  try {
    const { snapshot, pageFacts, $, parserChecks } = await analyzePage(url);
    const canonicalHref = pageFacts.canonicalUrl || null;
    const canonicalCount = $('link[rel="canonical"]').length;
    const normalizedCanonical = canonicalHref
      ? normalizeAuditUrl(canonicalHref, snapshot.finalUrl)
      : null;
    const normalizedFinalUrl = normalizeAuditUrl(snapshot.finalUrl, snapshot.finalUrl);
    const isSelfReferencing =
      Boolean(normalizedCanonical) && normalizedCanonical === normalizedFinalUrl;
    const isAbsolute = canonicalHref ? /^https?:\/\//i.test(canonicalHref) : false;

    const customChecks: RawCheck[] = [
      {
        key: "canonical.self_reference",
        label: "Self-referencing canonical",
        status: canonicalHref ? (isSelfReferencing ? "pass" : "warning") : "fail",
        details: canonicalHref
          ? isSelfReferencing
            ? "The canonical URL points back to the live page URL."
            : "The canonical URL points to a different page."
          : "No canonical tag was found on the page.",
        value: canonicalHref || undefined,
        priority: canonicalHref ? "medium" : "high",
      },
      {
        key: "canonical.absolute_url",
        label: "Absolute canonical URL",
        status: canonicalHref ? (isAbsolute ? "pass" : "warning") : "fail",
        details: canonicalHref
          ? isAbsolute
            ? "The canonical URL is absolute."
            : "Canonical URLs should be absolute rather than relative."
          : "No canonical URL is available to validate.",
        value: canonicalHref || undefined,
        priority: "medium",
      },
      {
        key: "canonical.count",
        label: "Single canonical tag",
        status:
          canonicalCount === 1 ? "pass" : canonicalCount === 0 ? "fail" : "warning",
        details:
          canonicalCount === 1
            ? "Exactly one canonical tag is present."
            : canonicalCount === 0
              ? "No canonical tags were found."
              : `${canonicalCount} canonical tags were found. Keep exactly one.`,
        value: String(canonicalCount),
        priority: canonicalCount === 0 ? "high" : "medium",
      },
      {
        key: "canonical.redirect",
        label: "Redirect alignment",
        status: snapshot.finalUrl === snapshot.requestedUrl ? "pass" : "warning",
        details:
          snapshot.finalUrl === snapshot.requestedUrl
            ? "The requested URL resolved directly without a redirect."
            : "The requested URL redirected. Make sure the canonical matches the preferred final URL.",
        value: snapshot.finalUrl,
        priority: "low",
      },
    ];

    const checks = [
      parserCheckBySuffix(parserChecks, "canonical.present"),
      ...customChecks,
    ].filter(Boolean) as Array<NormalizedCheckInput>;

    const result = toPublicToolResult({
      checks,
      metrics: [
        {
          label: "Canonical tags found",
          value: String(canonicalCount),
          tone:
            canonicalCount === 1 ? "success" : canonicalCount === 0 ? "critical" : "warning",
        },
        {
          label: "Canonical target",
          value: canonicalHref || "Missing",
          tone: canonicalHref ? "success" : "critical",
        },
        {
          label: "Redirected",
          value: snapshot.finalUrl === snapshot.requestedUrl ? "No" : "Yes",
          tone: snapshot.finalUrl === snapshot.requestedUrl ? "success" : "warning",
        },
      ],
      source: {
        requestedUrl: snapshot.requestedUrl,
        finalUrl: snapshot.finalUrl,
        httpStatus: snapshot.httpStatus,
        contentType: snapshot.contentType,
        fetchMode: snapshot.fetchMode,
        notes: snapshot.notes,
        parserVersion: SEO_AUDIT_PARSER_VERSION,
      },
      limitations: [
        "Checks the canonical setup on a single URL and does not compare every duplicate variant site-wide.",
      ],
    });

    const issues = result.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.details || check.label);

    return {
      url: snapshot.requestedUrl,
      finalUrl: snapshot.finalUrl,
      canonical: canonicalHref,
      canonicalCount,
      isRedirected: snapshot.finalUrl !== snapshot.requestedUrl,
      isSelfReferencing,
      issues,
      status: snapshot.httpStatus,
      summary: result.summary,
      metrics: result.metrics,
      checks: result.checks,
      recommendations: result.recommendations,
      source: result.source,
      limitations: result.limitations,
    };
  } catch (error: any) {
    const fallback = buildUnavailableResult({
      requestedUrl: parseUrl(url) || url,
      message: error?.message || "Could not fetch the page",
    });

    return {
      url: parseUrl(url) || url,
      finalUrl: parseUrl(url) || url,
      canonical: null,
      canonicalCount: 0,
      isRedirected: false,
      isSelfReferencing: false,
      issues: [fallback.summary.description],
      status: null,
      ...fallback,
    };
  }
}

export async function analyzeCrawlerTool(url: string) {
  try {
    const { snapshot, pageFacts, parserChecks } = await analyzePage(url);

    const checks = [
      {
        key: "crawler.http_status",
        label: "Page returned a successful HTTP status",
        status:
          snapshot.httpStatus && snapshot.httpStatus >= 200 && snapshot.httpStatus < 400
            ? "pass"
            : "fail",
        details:
          snapshot.httpStatus && snapshot.httpStatus >= 200 && snapshot.httpStatus < 400
            ? `Crawler received HTTP ${snapshot.httpStatus}.`
            : `Crawler received HTTP ${snapshot.httpStatus ?? "unknown"}.`,
        value: snapshot.httpStatus ? String(snapshot.httpStatus) : undefined,
        priority: "high",
      },
      parserCheckBySuffix(parserChecks, "headings.h1.count"),
      parserCheckBySuffix(parserChecks, "title.length"),
      parserCheckBySuffix(parserChecks, "meta.description.length"),
      parserCheckBySuffix(parserChecks, "images.alt_coverage"),
      parserCheckBySuffix(parserChecks, "links.internal_count"),
      parserCheckBySuffix(parserChecks, "schema.jsonld.present"),
      parserCheckBySuffix(parserChecks, "meta.viewport.present"),
    ].filter(Boolean) as Array<NormalizedCheckInput>;

    const result = toPublicToolResult({
      checks,
      metrics: [
        {
          label: "Visible word count",
          value: pageFacts.content.wordCount.toLocaleString(),
          tone: pageFacts.content.wordCount >= 150 ? "success" : "warning",
        },
        {
          label: "Internal links",
          value: String(pageFacts.links.internalCount),
          tone: pageFacts.links.internalCount >= 2 ? "success" : "warning",
        },
        {
          label: "Images missing alt",
          value: `${pageFacts.images.missingAltCount}/${pageFacts.images.count}`,
          tone:
            pageFacts.images.missingAltCount === 0
              ? "success"
              : pageFacts.images.missingAltCount >= Math.max(1, Math.ceil(pageFacts.images.count / 2))
                ? "critical"
                : "warning",
        },
        {
          label: "Structured data",
          value: pageFacts.jsonLd.schemaTypes.length
            ? pageFacts.jsonLd.schemaTypes.join(", ")
            : "None detected",
          tone: pageFacts.jsonLd.schemaTypes.length ? "success" : "warning",
        },
      ],
      source: {
        requestedUrl: snapshot.requestedUrl,
        finalUrl: snapshot.finalUrl,
        httpStatus: snapshot.httpStatus,
        contentType: snapshot.contentType,
        fetchMode: snapshot.fetchMode,
        notes: snapshot.notes,
        parserVersion: SEO_AUDIT_PARSER_VERSION,
      },
      limitations: [
        "This tool inspects the fetched page snapshot only and does not emulate every Google rendering nuance.",
      ],
    });

    return {
      url: snapshot.requestedUrl,
      finalUrl: snapshot.finalUrl,
      status: snapshot.httpStatus,
      isRedirected: snapshot.finalUrl !== snapshot.requestedUrl,
      title: pageFacts.title || null,
      headings: {
        h1: pageFacts.headings.h1,
        h2: pageFacts.headings.h2,
      },
      linkCount: pageFacts.links.internalCount,
      imageCount: pageFacts.images.count,
      imagesWithoutAlt: pageFacts.images.missingAltCount,
      hasJsonLd: pageFacts.jsonLd.parseableCount > 0,
      estimatedWordCount: pageFacts.content.wordCount,
      contentLength: snapshot.html.length,
      contentType: snapshot.contentType,
      summary: result.summary,
      metrics: result.metrics,
      checks: result.checks,
      recommendations: result.recommendations,
      source: result.source,
      limitations: result.limitations,
    };
  } catch (error: any) {
    const fallback = buildUnavailableResult({
      requestedUrl: parseUrl(url) || url,
      message: error?.message || "Could not crawl the page",
    });

    return {
      url: parseUrl(url) || url,
      finalUrl: parseUrl(url) || url,
      status: null,
      isRedirected: false,
      title: null,
      headings: { h1: [], h2: [] },
      linkCount: 0,
      imageCount: 0,
      imagesWithoutAlt: 0,
      hasJsonLd: false,
      estimatedWordCount: 0,
      contentLength: 0,
      contentType: "",
      error: fallback.summary.description,
      ...fallback,
    };
  }
}

export async function analyzeRobotsTool(url: string) {
  const normalizedUrl = parseUrl(url);
  if (!normalizedUrl) {
    return {
      url,
      found: false,
      content: "",
      userAgents: [],
      sitemaps: [],
      disallowed: [],
      allowed: [],
      aiCrawlersFound: [],
      issues: ["Invalid URL"],
      status: null,
      ...buildUnavailableResult({
        requestedUrl: url,
        message: "Invalid URL",
      }),
    };
  }

  const origin = new URL(normalizedUrl).origin;
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const response = await safeFetch(robotsUrl, {
      headers: { "User-Agent": PUBLIC_TOOL_USER_AGENT },
    }, { timeoutMs: 10_000, maxRedirects: 3 });
    const text = await readResponseTextLimited(response, 512 * 1024);
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const userAgents: string[] = [];
    const sitemaps: string[] = [];
    const disallowed: string[] = [];
    const allowed: string[] = [];

    let currentAgent = "";
    let wildcardBlocksRoot = false;
    let wildcardAllowsRoot = false;

    for (const line of lines) {
      if (/^User-agent:/i.test(line)) {
        currentAgent = line.split(":").slice(1).join(":").trim();
        userAgents.push(currentAgent);
      } else if (/^Disallow:/i.test(line)) {
        const path = line.split(":").slice(1).join(":").trim();
        disallowed.push(path);
        if (currentAgent === "*" && path === "/") {
          wildcardBlocksRoot = true;
        }
      } else if (/^Allow:/i.test(line)) {
        const path = line.split(":").slice(1).join(":").trim();
        allowed.push(path);
        if (currentAgent === "*" && path === "/") {
          wildcardAllowsRoot = true;
        }
      } else if (/^Sitemap:/i.test(line)) {
        sitemaps.push(line.split(":").slice(1).join(":").trim());
      }
    }

    const aiCrawlers = [
      "GPTBot",
      "ChatGPT-User",
      "Google-Extended",
      "PerplexityBot",
      "ClaudeBot",
      "anthropic-ai",
    ];
    const aiCrawlersFound = aiCrawlers.filter((crawler) => text.includes(crawler));

    const checks: RawCheck[] = [
      {
        key: "robots.reachable",
        label: "robots.txt reachable",
        status: response.ok ? "pass" : "fail",
        details: response.ok
          ? "robots.txt responded successfully."
          : `robots.txt returned HTTP ${response.status}.`,
        value: response.status.toString(),
        priority: "high",
      },
      {
        key: "robots.wildcard",
        label: "Wildcard user-agent rule",
        status: userAgents.includes("*") ? "pass" : "warning",
        details: userAgents.includes("*")
          ? "A wildcard user-agent rule is present."
          : "Add a User-agent: * block so crawlers inherit default rules.",
      },
      {
        key: "robots.global_block",
        label: "Site-wide crawl block",
        status:
          wildcardBlocksRoot && !wildcardAllowsRoot ? "fail" : "pass",
        details:
          wildcardBlocksRoot && !wildcardAllowsRoot
            ? "The wildcard rule blocks the entire site with Disallow: /."
            : "No full-site wildcard crawl block was detected.",
        priority: "high",
      },
      {
        key: "robots.sitemap",
        label: "Sitemap declaration",
        status: sitemaps.length > 0 ? "pass" : "warning",
        details:
          sitemaps.length > 0
            ? `${sitemaps.length} sitemap declaration(s) found.`
            : "No sitemap declaration was found in robots.txt.",
      },
      {
        key: "robots.ai_crawlers",
        label: "AI crawler directives",
        status: aiCrawlersFound.length > 0 ? "pass" : "info",
        details:
          aiCrawlersFound.length > 0
            ? `${aiCrawlersFound.join(", ")} rules found.`
            : "No explicit AI crawler directives were found.",
        priority: "low",
      },
    ];

    const result = toPublicToolResult({
      checks,
      metrics: [
        {
          label: "User-agents",
          value: String(userAgents.length),
          tone: userAgents.length > 0 ? "success" : "warning",
        },
        {
          label: "Sitemaps declared",
          value: String(sitemaps.length),
          tone: sitemaps.length > 0 ? "success" : "warning",
        },
        {
          label: "Disallow rules",
          value: String(disallowed.length),
        },
        {
          label: "AI crawler rules",
          value: String(aiCrawlersFound.length),
          tone: aiCrawlersFound.length > 0 ? "success" : "default",
        },
      ],
      source: {
        requestedUrl: normalizedUrl,
        finalUrl: robotsUrl,
        httpStatus: response.status,
        contentType: response.headers.get("content-type") || "text/plain",
        fetchMode: "static",
        notes: [],
      },
      limitations: [
        "Validates the robots.txt file only; it does not prove every blocked path is intentional.",
      ],
    });

    const issues = result.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.details || check.label);

    return {
      url: robotsUrl,
      found: response.ok,
      content: text.slice(0, 5000),
      userAgents,
      sitemaps,
      disallowed,
      allowed,
      aiCrawlersFound,
      issues,
      status: response.status,
      summary: result.summary,
      metrics: result.metrics,
      checks: result.checks,
      recommendations: result.recommendations,
      source: result.source,
      limitations: result.limitations,
    };
  } catch (error: any) {
    const fallback = buildUnavailableResult({
      requestedUrl: normalizedUrl,
      message: "robots.txt not found or unreachable",
      limitations: [
        "This validator checks only the robots.txt endpoint and cannot infer rules that are served conditionally.",
      ],
    });

    return {
      url: robotsUrl,
      found: false,
      content: "",
      userAgents: [],
      sitemaps: [],
      disallowed: [],
      allowed: [],
      aiCrawlersFound: [],
      issues: [fallback.summary.description],
      status: null,
      ...fallback,
    };
  }
}

export async function analyzeSitemapTool(url: string) {
  const normalizedUrl = parseUrl(url);
  if (!normalizedUrl) {
    return {
      url,
      found: false,
      isSitemapIndex: false,
      urlCount: 0,
      lastmodCount: 0,
      hasLastmod: false,
      status: null,
      contentType: "",
      issues: ["Invalid URL"],
      preview: "",
      ...buildUnavailableResult({ requestedUrl: url, message: "Invalid URL" }),
    };
  }

  let sitemapUrl = normalizedUrl;
  const parsed = new URL(normalizedUrl);
  if (!parsed.pathname.includes("sitemap")) {
    sitemapUrl = `${parsed.origin}/sitemap.xml`;
  }

  try {
    const response = await safeFetch(sitemapUrl, {
      headers: { "User-Agent": PUBLIC_TOOL_USER_AGENT },
    }, { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, maxRedirects: 3 });
    const text = await readResponseTextLimited(response, 5 * 1024 * 1024);
    const parser = new XMLParser({
      ignoreAttributes: false,
      allowBooleanAttributes: true,
      processEntities: true,
    });

    let parsedXml: any = null;
    let xmlValid = true;
    try {
      parsedXml = parser.parse(text);
    } catch {
      xmlValid = false;
    }

    const isSitemapIndex = Boolean(parsedXml?.sitemapindex);
    const urlEntries = Array.isArray(parsedXml?.urlset?.url)
      ? parsedXml.urlset.url
      : parsedXml?.urlset?.url
        ? [parsedXml.urlset.url]
        : [];
    const sitemapEntries = Array.isArray(parsedXml?.sitemapindex?.sitemap)
      ? parsedXml.sitemapindex.sitemap
      : parsedXml?.sitemapindex?.sitemap
        ? [parsedXml.sitemapindex.sitemap]
        : [];
    const urlCount = isSitemapIndex ? sitemapEntries.length : urlEntries.length;
    const lastmodCount = (isSitemapIndex ? sitemapEntries : urlEntries).filter(
      (entry: any) => entry?.lastmod,
    ).length;

    const checks: RawCheck[] = [
      {
        key: "sitemap.reachable",
        label: "Sitemap reachable",
        status: response.ok ? "pass" : "fail",
        details: response.ok
          ? "The sitemap responded successfully."
          : `The sitemap returned HTTP ${response.status}.`,
        value: response.status.toString(),
        priority: "high",
      },
      {
        key: "sitemap.xml_valid",
        label: "Valid XML structure",
        status: xmlValid ? "pass" : "fail",
        details: xmlValid
          ? "The sitemap parsed as valid XML."
          : "The response could not be parsed as valid XML.",
        priority: "high",
      },
      {
        key: "sitemap.url_entries",
        label: isSitemapIndex ? "Sitemap index entries" : "URL entries",
        status: urlCount > 0 ? "pass" : "warning",
        details:
          urlCount > 0
            ? `${urlCount} ${isSitemapIndex ? "child sitemap" : "URL"} entries found.`
            : "No sitemap entries were found.",
      },
      {
        key: "sitemap.lastmod",
        label: "lastmod coverage",
        status: urlCount === 0 || lastmodCount > 0 ? "pass" : "warning",
        details:
          urlCount === 0
            ? "No entries were available for lastmod analysis."
            : `${lastmodCount} of ${urlCount} entries include lastmod.`,
      },
      {
        key: "sitemap.size_limit",
        label: "50,000 URL sitemap limit",
        status: urlCount <= 50_000 ? "pass" : "fail",
        details:
          urlCount <= 50_000
            ? "The sitemap is within the standard 50,000 URL limit."
            : `The sitemap has ${urlCount} entries, which exceeds the recommended limit.`,
        priority: urlCount <= 50_000 ? "low" : "high",
      },
    ];

    const result = toPublicToolResult({
      checks,
      metrics: [
        {
          label: isSitemapIndex ? "Child sitemaps" : "URL entries",
          value: urlCount.toLocaleString(),
          tone: urlCount > 0 ? "success" : "warning",
        },
        {
          label: "Entries with lastmod",
          value: lastmodCount.toLocaleString(),
          tone: lastmodCount > 0 ? "success" : "warning",
        },
        {
          label: "Sitemap type",
          value: isSitemapIndex ? "Sitemap index" : "URL sitemap",
        },
        {
          label: "Content type",
          value: response.headers.get("content-type") || "unknown",
        },
      ],
      source: {
        requestedUrl: normalizedUrl,
        finalUrl: sitemapUrl,
        httpStatus: response.status,
        contentType: response.headers.get("content-type") || "",
        fetchMode: "static",
        notes: normalizedUrl !== sitemapUrl ? ["Checked the default /sitemap.xml path."] : [],
      },
      limitations: [
        "This validator inspects a single sitemap URL and does not recursively audit every linked sitemap.",
      ],
    });

    const issues = result.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.details || check.label);

    return {
      url: sitemapUrl,
      found: response.ok && xmlValid,
      isSitemapIndex,
      urlCount,
      lastmodCount,
      hasLastmod: lastmodCount > 0,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      issues,
      preview: text.slice(0, 2000),
      summary: result.summary,
      metrics: result.metrics,
      checks: result.checks,
      recommendations: result.recommendations,
      source: result.source,
      limitations: result.limitations,
    };
  } catch (error: any) {
    const fallback = buildUnavailableResult({
      requestedUrl: normalizedUrl,
      message: "Sitemap not found or unreachable",
      limitations: [
        "This validator checks one sitemap endpoint at a time and cannot infer hidden or auth-protected sitemap variants.",
      ],
    });

    return {
      url: sitemapUrl,
      found: false,
      isSitemapIndex: false,
      urlCount: 0,
      lastmodCount: 0,
      hasLastmod: false,
      status: null,
      contentType: "",
      issues: [fallback.summary.description],
      preview: "",
      ...fallback,
    };
  }
}
