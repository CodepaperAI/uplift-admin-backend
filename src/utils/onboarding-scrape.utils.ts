import { load, type CheerioAPI } from "cheerio";
import {
  fetchWithScraperAPI,
  scrapeWebsite,
  type ScrapedLink,
  type ScrapedMetaTag,
  type ScrapedScript,
  type ScrapeWebsiteResult,
} from "./tools.utils";
import { guardUrl } from "./ssrf-guard";
import { normalizeWebsiteUrl } from "./url-normalizer";

const APP_SHELL_MARKERS = [
  "enable javascript",
  "please turn on javascript",
  "loading...",
  "loading",
  "just a moment",
  "application error",
];
const CLOUDFLARE_MARKERS = [
  "attention required! | cloudflare",
  "just a moment...",
  "checking your browser before accessing",
  "verify you are human",
  "cf-browser-verification",
  "cf_chl_",
  "__cf_chl_",
  "cloudflare ray id",
  "sorry, you have been blocked",
];

const MARKDOWN_MIN_VISIBLE_CHARS = 400;
const MARKDOWN_MIN_HEADING_COUNT = 1;
const MARKDOWN_MIN_LINK_COUNT = 3;
const MARKDOWN_CHARS_PER_CHUNK = 120_000;
const MAX_TOOL_PAYLOAD_CHARS = 220_000;
const MAX_SCHEMA_BLOCKS = 10;
const MAX_SCHEMA_BLOCK_LENGTH = 2_000;
const MAX_NAV_LINKS = 20;
const MAX_META_VALUE_LENGTH = 1_000;

export type OnboardingScrapeMode =
  | "markdown"
  | "markdown+render"
  | "html"
  | "html+render"
  | "structured-fallback";

export type OnboardingSeoSignals = {
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  openGraph?: Record<string, string>;
  twitterCard?: Record<string, string>;
  schema?: Record<string, string>[];
  verification?: Record<string, string>;
  favicon?: string;
  navigation?: Array<{ text: string; url: string }>;
};

export type OnboardingScrapeSnapshot = {
  normalizedUrl: string;
  finalUrl: string;
  markdown: string;
  markdownMode: OnboardingScrapeMode;
  renderFallbackReason: string | null;
  structuredFallbackUsed: boolean;
  puppeteerFallbackUsed: boolean;
  seoSignals: OnboardingSeoSignals;
};

export type OnboardingWebsiteInfoPayload = {
  chunked: boolean;
  totalLength: number;
  totalChunks: number;
  currentChunk: number;
  content: {
    format: "markdown";
    markdown: string;
    mode: OnboardingScrapeMode;
    truncated: boolean;
  };
  seoSignals: OnboardingSeoSignals | null;
  diagnostics: {
    canonicalUrl: string;
    finalUrl: string;
    renderUsed: boolean;
    renderFallbackReason: string | null;
    structuredFallbackUsed: boolean;
    puppeteerFallbackUsed: boolean;
    payloadSize: number;
    markdownLength: number;
    seoSignalsIncluded: boolean;
  };
  message: string;
};

export type OnboardingScrapeDeps = {
  fetchWithScraperAPI: typeof fetchWithScraperAPI;
  scrapeWebsite: typeof scrapeWebsite;
};

type OnboardingScrapeFailureCode =
  | "site_inaccessible"
  | "scrape_blocked"
  | "insufficient_content_after_fallback";

export class OnboardingScrapeError extends Error {
  code: OnboardingScrapeFailureCode;
  stage: string;
  details?: unknown;

  constructor(args: {
    code: OnboardingScrapeFailureCode;
    stage: string;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "OnboardingScrapeError";
    this.code = args.code;
    this.stage = args.stage;
    this.details = args.details;
  }
}

const defaultOnboardingScrapeDeps: OnboardingScrapeDeps = {
  fetchWithScraperAPI,
  scrapeWebsite,
};

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Legacy domain-forwarding pages can contain no body at all and delegate the
 * whole document through a top-level HTML frameset. Follow only that explicit
 * document target; ordinary iframes are intentionally ignored. The eventual
 * request still goes through fetchWithScraperAPI, which applies the shared
 * SSRF guard before contacting the provider.
 */
export function resolveTopLevelFramesetUrl(
  html: string,
  baseUrl: string,
): string | null {
  const $ = load(html);
  const frameset = $("html > frameset").first();
  if (frameset.length === 0) return null;

  const rawSrc = frameset.find("frame[src]").first().attr("src")?.trim();
  if (!rawSrc) return null;

  try {
    const resolved = new URL(rawSrc, baseUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

type OnboardingWebsiteIdentityDeps = {
  fetchHtml: (url: string) => Promise<string>;
  validatePublicUrl: (url: string) => Promise<string>;
};

const defaultOnboardingWebsiteIdentityDeps: OnboardingWebsiteIdentityDeps = {
  fetchHtml: (url) => fetchWithScraperAPI(url, { render: false }),
  validatePublicUrl: async (url) => (await guardUrl(url)).url.toString(),
};

/**
 * Resolve only an explicit top-level frameset target for website identity.
 * This bounded preflight lets account-level duplicate validation treat a
 * legacy forwarding document and its real public website as one onboarding
 * target. Provider failures preserve the submitted URL so an optional
 * identity hint can never make onboarding unavailable.
 */
export async function resolveOnboardingWebsiteIdentityUrl(
  url: string,
  deps: OnboardingWebsiteIdentityDeps = defaultOnboardingWebsiteIdentityDeps,
): Promise<string> {
  const normalizedUrl = normalizeWebsiteUrl(url);
  try {
    const html = await deps.fetchHtml(normalizedUrl);
    const framedUrl = resolveTopLevelFramesetUrl(html, normalizedUrl);
    if (!framedUrl) return normalizedUrl;

    const guardedUrl = await deps.validatePublicUrl(framedUrl);
    return normalizeWebsiteUrl(guardedUrl) || normalizedUrl;
  } catch (error) {
    console.warn("[OnboardingScrape] Website identity preflight fell back", {
      websiteUrl: normalizedUrl,
      message: error instanceof Error ? error.message : String(error),
    });
    return normalizedUrl;
  }
}

function stripMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countMarkdownHeadings(markdown: string): number {
  return (markdown.match(/^#{1,6}\s+/gm) ?? []).length;
}

function countMarkdownLinks(markdown: string): number {
  return (markdown.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
}

export function shouldRetryMarkdownWithRender(markdown: string): {
  shouldRetry: boolean;
  reason: string | null;
} {
  const normalized = normalizeMarkdown(markdown);
  const visibleText = stripMarkdownSyntax(normalized).toLowerCase();
  const rawText = normalized.toLowerCase();

  if (!visibleText) {
    return { shouldRetry: true, reason: "empty_markdown" };
  }

  if (isLikelyCloudflareBlock(rawText) || isLikelyCloudflareBlock(visibleText)) {
    return { shouldRetry: true, reason: "cloudflare_markdown_challenge" };
  }

  if (
    APP_SHELL_MARKERS.some((marker) => visibleText.includes(marker)) &&
    visibleText.length < 2_000
  ) {
    return { shouldRetry: true, reason: "app_shell_markdown" };
  }

  if (visibleText.length < MARKDOWN_MIN_VISIBLE_CHARS) {
    return { shouldRetry: true, reason: "markdown_too_short" };
  }

  if (
    countMarkdownHeadings(normalized) < MARKDOWN_MIN_HEADING_COUNT &&
    countMarkdownLinks(normalized) < MARKDOWN_MIN_LINK_COUNT &&
    visibleText.length < 1_200
  ) {
    return { shouldRetry: true, reason: "thin_markdown_structure" };
  }

  return { shouldRetry: false, reason: null };
}

export function isLikelyCloudflareBlock(content: string): boolean {
  const normalized = content.toLowerCase();
  return CLOUDFLARE_MARKERS.some((marker) => normalized.includes(marker));
}

function normalizeRecordEntryValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim().slice(0, MAX_META_VALUE_LENGTH);
  }

  return JSON.stringify(value).slice(0, MAX_META_VALUE_LENGTH);
}

function normalizeStringRecord(
  record: Record<string, unknown>,
): Record<string, string> | undefined {
  const entries = Object.entries(record)
    .map(([key, value]) => {
      const normalizedValue = normalizeRecordEntryValue(value);
      if (!normalizedValue) {
        return null;
      }

      return [key, normalizedValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveAbsoluteUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return undefined;
  }

  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function extractMetaContent(
  $: CheerioAPI,
  selector: string,
): string | undefined {
  const content = $(selector).attr("content")?.trim();
  return content && content.length > 0 ? content.slice(0, MAX_META_VALUE_LENGTH) : undefined;
}

function extractMetaPrefixRecord(
  $: CheerioAPI,
  attribute: "property" | "name",
  prefix: string,
): Record<string, string> | undefined {
  const record: Record<string, string> = {};

  $(`meta[${attribute}]`).each((_, element) => {
    const key = $(element).attr(attribute)?.trim();
    const content = $(element).attr("content")?.trim();
    if (!key || !content || !key.startsWith(prefix)) {
      return;
    }

    const normalizedKey = key.slice(prefix.length);
    if (!normalizedKey) {
      return;
    }

    record[normalizedKey] = content.slice(0, MAX_META_VALUE_LENGTH);
  });

  return Object.keys(record).length > 0 ? record : undefined;
}

function extractVerificationRecord(
  $: CheerioAPI,
): Record<string, string> | undefined {
  const record: Record<string, string> = {};

  $("meta[name], meta[property]").each((_, element) => {
    const name =
      $(element).attr("name")?.trim() ?? $(element).attr("property")?.trim();
    const content = $(element).attr("content")?.trim();
    if (!name || !content) {
      return;
    }

    if (
      name.includes("verification") ||
      name.includes("site-verification") ||
      name === "msvalidate.01"
    ) {
      record[name] = content.slice(0, MAX_META_VALUE_LENGTH);
    }
  });

  return Object.keys(record).length > 0 ? record : undefined;
}

function extractSchemaRecords(
  $: CheerioAPI,
): Record<string, string>[] | undefined {
  const records: Record<string, string>[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    if (records.length >= MAX_SCHEMA_BLOCKS) {
      return false;
    }

    const text = $(element).text().trim();
    if (!text) {
      return;
    }

    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (records.length >= MAX_SCHEMA_BLOCKS) {
          break;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }

        const normalized = normalizeStringRecord(item as Record<string, unknown>);
        if (normalized) {
          const serializedLength = JSON.stringify(normalized).length;
          if (serializedLength <= MAX_SCHEMA_BLOCK_LENGTH) {
            records.push(normalized);
          }
        }
      }
    } catch {
      const fallback = normalizeStringRecord({ raw: text.slice(0, MAX_SCHEMA_BLOCK_LENGTH) });
      if (fallback) {
        records.push(fallback);
      }
    }
  });

  return records.length > 0 ? records : undefined;
}

function extractNavigationLinks(
  $: CheerioAPI,
  baseUrl: string,
): Array<{ text: string; url: string }> | undefined {
  const links: Array<{ text: string; url: string }> = [];

  $("a[href]").each((_, element) => {
    if (links.length >= MAX_NAV_LINKS) {
      return false;
    }

    const text = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href")?.trim();
    if (!text || !href) {
      return;
    }

    const absoluteUrl = resolveAbsoluteUrl(href, baseUrl);
    if (!absoluteUrl) {
      return;
    }

    if (links.some((link) => link.url === absoluteUrl && link.text === text)) {
      return;
    }

    links.push({ text: text.slice(0, 200), url: absoluteUrl });
  });

  return links.length > 0 ? links : undefined;
}

function shouldUseRenderedHtmlForSeo(html: string): boolean {
  if (!html.trim()) {
    return true;
  }

  if (isLikelyCloudflareBlock(html)) {
    return true;
  }

  const $ = load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const headingCount = $("h1, h2, h3").length;
  const linkCount = $("a[href]").length;

  if (bodyText.length < 120) {
    return true;
  }

  if (headingCount === 0 && linkCount < 3) {
    return true;
  }

  return false;
}

function buildMarkdownFromHtml(html: string, baseUrl: string): string {
  const $ = load(html);
  const sections: string[] = [];

  const title = $("title").text().replace(/\s+/g, " ").trim();
  if (title) {
    sections.push(`# ${title}`);
  }

  const headingLines = $("h1, h2, h3")
    .toArray()
    .map((element) => {
      const tagName = element.tagName?.toLowerCase() ?? "h2";
      const level = Math.min(Math.max(Number(tagName.replace("h", "")) || 2, 1), 3);
      const prefix = "#".repeat(level + 1);
      const text = $(element).text().replace(/\s+/g, " ").trim();
      return text ? `${prefix} ${text}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 20);
  if (headingLines.length > 0) {
    sections.push(headingLines.join("\n"));
  }

  const navigation = extractNavigationLinks($, baseUrl);
  if (navigation) {
    sections.push(
      [
        "## Navigation",
        ...navigation.map((link) => `- [${link.text}](${link.url})`),
      ].join("\n"),
    );
  }

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  if (bodyText) {
    sections.push(bodyText.slice(0, 10_000));
  }

  return normalizeMarkdown(sections.join("\n\n"));
}

export function extractSeoSignalsFromHtml(
  html: string,
  baseUrl: string,
): OnboardingSeoSignals {
  const $ = load(html);
  const title = $("title").text().replace(/\s+/g, " ").trim() || undefined;
  const metaDescription = extractMetaContent($, 'meta[name="description"]');
  const canonicalHref = $('link[rel="canonical"]').attr("href")?.trim();
  const faviconHref =
    $('link[rel="icon"]').attr("href")?.trim() ??
    $('link[rel="shortcut icon"]').attr("href")?.trim() ??
    $('link[rel="apple-touch-icon"]').attr("href")?.trim();

  const canonicalUrl = resolveAbsoluteUrl(canonicalHref, baseUrl);
  const favicon = resolveAbsoluteUrl(faviconHref, baseUrl);
  const openGraph = extractMetaPrefixRecord($, "property", "og:");
  const twitterCard = extractMetaPrefixRecord($, "name", "twitter:");
  const schema = extractSchemaRecords($);
  const verification = extractVerificationRecord($);
  const navigation = extractNavigationLinks($, baseUrl);

  return {
    ...(title ? { title } : {}),
    ...(metaDescription ? { metaDescription } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(favicon ? { favicon } : {}),
    ...(openGraph ? { openGraph } : {}),
    ...(twitterCard ? { twitterCard } : {}),
    ...(schema ? { schema } : {}),
    ...(verification ? { verification } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

function extractMetaContentFromStructuredScrape(
  metaTags: ScrapedMetaTag[],
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  const match = metaTags.find((tag) => tag.name?.toLowerCase() === normalizedName);
  return match?.content?.trim() || undefined;
}

function extractMetaPrefixRecordFromStructuredScrape(
  metaTags: ScrapedMetaTag[],
  prefix: string,
): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  const normalizedPrefix = prefix.toLowerCase();

  for (const tag of metaTags) {
    const key = tag.name?.trim();
    const content = tag.content?.trim();
    if (!key || !content || !key.toLowerCase().startsWith(normalizedPrefix)) {
      continue;
    }

    const normalizedKey = key.slice(prefix.length);
    if (!normalizedKey) {
      continue;
    }

    record[normalizedKey] = content.slice(0, MAX_META_VALUE_LENGTH);
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function extractVerificationRecordFromStructuredScrape(
  metaTags: ScrapedMetaTag[],
): Record<string, string> | undefined {
  const record: Record<string, string> = {};

  for (const tag of metaTags) {
    const name = tag.name?.trim();
    const content = tag.content?.trim();
    if (!name || !content) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (
      normalizedName.includes("verification") ||
      normalizedName.includes("site-verification") ||
      normalizedName === "msvalidate.01"
    ) {
      record[name] = content.slice(0, MAX_META_VALUE_LENGTH);
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function extractSchemaRecordsFromStructuredScrape(
  scripts: ScrapedScript[],
): Record<string, string>[] | undefined {
  const records: Record<string, string>[] = [];

  for (const script of scripts) {
    if (records.length >= MAX_SCHEMA_BLOCKS) {
      break;
    }

    const text = script.jsonLD?.trim();
    if (!text) {
      continue;
    }

    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (records.length >= MAX_SCHEMA_BLOCKS) {
          break;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }

        const normalized = normalizeStringRecord(item as Record<string, unknown>);
        if (!normalized) {
          continue;
        }

        if (JSON.stringify(normalized).length <= MAX_SCHEMA_BLOCK_LENGTH) {
          records.push(normalized);
        }
      }
    } catch {
      const fallback = normalizeStringRecord({
        raw: text.slice(0, MAX_SCHEMA_BLOCK_LENGTH),
      });
      if (fallback) {
        records.push(fallback);
      }
    }
  }

  return records.length > 0 ? records : undefined;
}

function extractNavigationLinksFromStructuredScrape(
  links: ScrapedLink[],
  baseUrl: string,
): Array<{ text: string; url: string }> | undefined {
  const navigation: Array<{ text: string; url: string }> = [];

  for (const link of links) {
    if (navigation.length >= MAX_NAV_LINKS) {
      break;
    }

    const text = link.text.replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    const absoluteUrl = resolveAbsoluteUrl(link.href, baseUrl);
    if (!absoluteUrl) {
      continue;
    }

    if (navigation.some((entry) => entry.url === absoluteUrl && entry.text === text)) {
      continue;
    }

    navigation.push({ text: text.slice(0, 200), url: absoluteUrl });
  }

  return navigation.length > 0 ? navigation : undefined;
}

function buildMarkdownFromStructuredScrape(scraped: ScrapeWebsiteResult): string {
  const sections: string[] = [];
  const title = scraped.title.replace(/\s+/g, " ").trim();
  if (title) {
    sections.push(`# ${title}`);
  }

  const headingLines = Object.entries(scraped.headers ?? {})
    .flatMap(([tag, values]) =>
      values
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((value) => `## ${tag.toUpperCase()}: ${value}`),
    )
    .slice(0, 20);
  if (headingLines.length > 0) {
    sections.push(headingLines.join("\n"));
  }

  const bodyText = scraped.bodyText.replace(/\s+/g, " ").trim();
  if (bodyText) {
    sections.push(bodyText);
  }

  const navigation = extractNavigationLinksFromStructuredScrape(
    scraped.links ?? [],
    scraped.finalUrl || scraped.canonical || "https://example.com",
  );
  if (navigation) {
    sections.push(
      [
        "## Navigation",
        ...navigation.map((link) => `- [${link.text}](${link.url})`),
      ].join("\n"),
    );
  }

  return normalizeMarkdown(sections.join("\n\n"));
}

function extractSeoSignalsFromStructuredScrape(
  scraped: ScrapeWebsiteResult,
  baseUrl: string,
): OnboardingSeoSignals {
  const finalUrl = scraped.finalUrl || baseUrl;
  const canonicalUrl = resolveAbsoluteUrl(scraped.canonical ?? undefined, finalUrl);
  const favicon = resolveAbsoluteUrl(
    extractMetaContentFromStructuredScrape(scraped.metaTags ?? [], "icon") ??
      extractMetaContentFromStructuredScrape(scraped.metaTags ?? [], "shortcut icon") ??
      extractMetaContentFromStructuredScrape(scraped.metaTags ?? [], "apple-touch-icon"),
    finalUrl,
  );
  const openGraph = extractMetaPrefixRecordFromStructuredScrape(
    scraped.metaTags ?? [],
    "og:",
  );
  const twitterCard = extractMetaPrefixRecordFromStructuredScrape(
    scraped.metaTags ?? [],
    "twitter:",
  );
  const schema = extractSchemaRecordsFromStructuredScrape(scraped.scripts ?? []);
  const verification = extractVerificationRecordFromStructuredScrape(
    scraped.metaTags ?? [],
  );
  const navigation = extractNavigationLinksFromStructuredScrape(
    scraped.links ?? [],
    finalUrl,
  );

  return {
    ...(scraped.title ? { title: scraped.title.replace(/\s+/g, " ").trim() } : {}),
    ...(extractMetaContentFromStructuredScrape(scraped.metaTags ?? [], "description")
      ? {
          metaDescription: extractMetaContentFromStructuredScrape(
            scraped.metaTags ?? [],
            "description",
          ),
        }
      : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(favicon ? { favicon } : {}),
    ...(openGraph ? { openGraph } : {}),
    ...(twitterCard ? { twitterCard } : {}),
    ...(schema ? { schema } : {}),
    ...(verification ? { verification } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

function buildScrapeFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("403")) {
      return "scraperapi_403";
    }
    if (message.includes("cloudflare")) {
      return "cloudflare_block";
    }
    if (message.includes("timeout")) {
      return "scrape_timeout";
    }
    if (message.includes("blocked")) {
      return "scrape_blocked";
    }
  }

  return "scrape_request_failed";
}

async function fetchMarkdown(
  normalizedUrl: string,
  render: boolean,
  deps: OnboardingScrapeDeps,
): Promise<string> {
  return normalizeMarkdown(
    await deps.fetchWithScraperAPI(normalizedUrl, {
      outputFormat: "markdown",
      render,
      ...(render ? { deviceType: "desktop" as const } : {}),
    }),
  );
}

async function fetchHtmlForSeoSignals(
  normalizedUrl: string,
  preferRendered: boolean,
  deps: OnboardingScrapeDeps,
): Promise<string> {
  const initialHtml = await deps.fetchWithScraperAPI(normalizedUrl, {
    render: preferRendered,
    ...(preferRendered ? { deviceType: "desktop" as const } : {}),
  });

  if (preferRendered || !shouldUseRenderedHtmlForSeo(initialHtml)) {
    return initialHtml;
  }

  return deps.fetchWithScraperAPI(normalizedUrl, {
    render: true,
    deviceType: "desktop",
  });
}

export async function scrapeWebsiteForOnboarding(
  url: string,
  deps: OnboardingScrapeDeps = defaultOnboardingScrapeDeps,
): Promise<OnboardingScrapeSnapshot> {
  const normalizedUrl = normalizeWebsiteUrl(url);
  let markdown: string | null = null;
  let markdownMode: OnboardingScrapeMode = "markdown";
  let renderFallbackReason: string | null = null;
  let structuredFallbackUsed = false;
  let puppeteerFallbackUsed = false;
  let finalUrl = normalizedUrl;
  let renderedHtmlForSeo: string | null = null;

  try {
    const initialMarkdown = await fetchMarkdown(normalizedUrl, false, deps);
    const initialDecision = shouldRetryMarkdownWithRender(initialMarkdown);

    if (!initialDecision.shouldRetry) {
      markdown = initialMarkdown;
    } else {
      renderFallbackReason = initialDecision.reason;
    }
  } catch (error) {
    renderFallbackReason = buildScrapeFailureReason(error);
  }

  if (!markdown) {
    try {
      const renderedMarkdown = await fetchMarkdown(normalizedUrl, true, deps);
      const renderedDecision = shouldRetryMarkdownWithRender(renderedMarkdown);

      if (isLikelyCloudflareBlock(renderedMarkdown)) {
        throw new OnboardingScrapeError({
          code: "scrape_blocked",
          stage: "markdown_render_scrape",
          message: `Cloudflare challenge page detected in onboarding markdown scrape for ${normalizedUrl}.`,
          details: {
            websiteUrl: normalizedUrl,
            renderFallbackReason,
          },
        });
      }

      if (!renderedDecision.shouldRetry) {
        markdown = renderedMarkdown;
        markdownMode = "markdown+render";
      } else {
        renderFallbackReason = renderFallbackReason ?? renderedDecision.reason;
      }
    } catch (error) {
      renderFallbackReason = renderFallbackReason ?? buildScrapeFailureReason(error);
    }
  }

  if (!markdown) {
    try {
      let documentUrl = normalizedUrl;
      let htmlRenderUsed = false;
      let renderedHtml = await deps.fetchWithScraperAPI(normalizedUrl, {
        render: false,
      });
      const framedDocumentUrl = resolveTopLevelFramesetUrl(
        renderedHtml,
        documentUrl,
      );

      if (framedDocumentUrl && framedDocumentUrl !== documentUrl) {
        documentUrl = framedDocumentUrl;
        renderedHtml = await deps.fetchWithScraperAPI(documentUrl, {
          render: false,
        });
        finalUrl = documentUrl;
      }

      if (shouldUseRenderedHtmlForSeo(renderedHtml)) {
        renderedHtml = await deps.fetchWithScraperAPI(documentUrl, {
          render: true,
          deviceType: "desktop",
        });
        htmlRenderUsed = true;
      }

      if (isLikelyCloudflareBlock(renderedHtml)) {
        throw new OnboardingScrapeError({
          code: "scrape_blocked",
          stage: "html_render_scrape",
          message: `Cloudflare challenge page detected in rendered HTML onboarding scrape for ${normalizedUrl}.`,
          details: {
            websiteUrl: normalizedUrl,
            renderFallbackReason,
          },
        });
      }

      const htmlDerivedMarkdown = buildMarkdownFromHtml(renderedHtml, normalizedUrl);
      const htmlDecision = shouldRetryMarkdownWithRender(htmlDerivedMarkdown);

      if (!htmlDecision.shouldRetry) {
        markdown = htmlDerivedMarkdown;
        markdownMode = htmlRenderUsed ? "html+render" : "html";
        renderedHtmlForSeo = renderedHtml;
      } else {
        renderFallbackReason = renderFallbackReason ?? htmlDecision.reason;
      }
    } catch (error) {
      renderFallbackReason = renderFallbackReason ?? buildScrapeFailureReason(error);
    }
  }

  let structuredFallback: ScrapeWebsiteResult | null = null;

  if (!markdown) {
    structuredFallbackUsed = true;
    try {
      structuredFallback = await deps.scrapeWebsite(normalizedUrl);
      markdown = buildMarkdownFromStructuredScrape(structuredFallback);
      markdownMode = "structured-fallback";
      puppeteerFallbackUsed = structuredFallback.source === "puppeteer";
      finalUrl = structuredFallback.finalUrl || normalizedUrl;
    } catch (error) {
      throw new OnboardingScrapeError({
        code: "site_inaccessible",
        stage: "structured_fallback_scrape",
        message: `Unable to access site content for ${normalizedUrl} after deterministic onboarding scrape fallbacks.`,
        details: {
          websiteUrl: normalizedUrl,
          renderFallbackReason,
          scraperFailureReason: buildScrapeFailureReason(error),
        },
        cause: error,
      });
    }

    const fallbackDecision = shouldRetryMarkdownWithRender(markdown);
    if (fallbackDecision.shouldRetry) {
      throw new OnboardingScrapeError({
        code: "insufficient_content_after_fallback",
        stage: "structured_fallback_validation",
        message: `Unable to gather enough grounded website content for ${normalizedUrl} after deterministic onboarding scrape fallbacks.`,
        details: {
          websiteUrl: normalizedUrl,
          renderFallbackReason,
          validationReason: fallbackDecision.reason,
        },
      });
    }
  }

  let seoSignals: OnboardingSeoSignals = {};
  try {
    const html =
      renderedHtmlForSeo ??
      (await fetchHtmlForSeoSignals(
        normalizedUrl,
        markdownMode === "markdown+render" || markdownMode === "html+render",
        deps,
      ));
    seoSignals = isLikelyCloudflareBlock(html)
      ? {}
      : extractSeoSignalsFromHtml(html, normalizedUrl);
  } catch {
    if (!structuredFallback) {
      try {
        structuredFallback = await deps.scrapeWebsite(normalizedUrl);
        structuredFallbackUsed = true;
        puppeteerFallbackUsed =
          puppeteerFallbackUsed || structuredFallback.source === "puppeteer";
        finalUrl = structuredFallback.finalUrl || finalUrl;
      } catch {
        structuredFallback = null;
      }
    }

    if (structuredFallback) {
      seoSignals = extractSeoSignalsFromStructuredScrape(
        structuredFallback,
        structuredFallback.finalUrl || normalizedUrl,
      );
    }
  }

  return {
    normalizedUrl,
    finalUrl,
    markdown,
    markdownMode,
    renderFallbackReason,
    structuredFallbackUsed,
    puppeteerFallbackUsed,
    seoSignals,
  };
}

export function buildOnboardingWebsiteInfoPayload(
  snapshot: OnboardingScrapeSnapshot,
  chunkInput?: number | null,
): { payload: OnboardingWebsiteInfoPayload; serialized: string } {
  const totalLength = snapshot.markdown.length;
  const totalChunks = Math.max(1, Math.ceil(totalLength / MARKDOWN_CHARS_PER_CHUNK));
  const currentChunk = Math.min(Math.max(chunkInput ?? 1, 1), totalChunks);
  const start = (currentChunk - 1) * MARKDOWN_CHARS_PER_CHUNK;
  const end = Math.min(start + MARKDOWN_CHARS_PER_CHUNK, totalLength);
  const markdownChunk = snapshot.markdown.slice(start, end);
  const seoSignalsIncluded = currentChunk === 1;

  const payload: OnboardingWebsiteInfoPayload = {
    chunked: totalChunks > 1,
    totalLength,
    totalChunks,
    currentChunk,
    content: {
      format: "markdown",
      markdown: markdownChunk,
      mode: snapshot.markdownMode,
      truncated: totalChunks > 1,
    },
    seoSignals: seoSignalsIncluded ? snapshot.seoSignals : null,
      diagnostics: {
        canonicalUrl: snapshot.normalizedUrl,
        finalUrl: snapshot.finalUrl,
        renderUsed:
          snapshot.markdownMode === "markdown+render" ||
          snapshot.markdownMode === "html+render",
        renderFallbackReason: snapshot.renderFallbackReason,
        structuredFallbackUsed: snapshot.structuredFallbackUsed,
        puppeteerFallbackUsed: snapshot.puppeteerFallbackUsed,
      payloadSize: 0,
      markdownLength: totalLength,
      seoSignalsIncluded,
    },
    message:
      currentChunk >= totalChunks
        ? `This is chunk ${currentChunk}/${totalChunks}. It is the final markdown chunk. Combine all chunks into one final analysis. Use seoSignals for exact SEO fields when present.`
        : `This is chunk ${currentChunk}/${totalChunks}. Analyze this markdown chunk, then call get-website-info again with chunk=${currentChunk + 1}. Use seoSignals for exact SEO fields when present.`,
  };

  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_TOOL_PAYLOAD_CHARS) {
    throw new Error(
      `Onboarding website info payload exceeds safe size budget (${serialized.length} chars > ${MAX_TOOL_PAYLOAD_CHARS}).`,
    );
  }

  payload.diagnostics.payloadSize = serialized.length;

  return {
    payload,
    serialized: JSON.stringify(payload),
  };
}
