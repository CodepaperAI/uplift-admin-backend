/**
 * directory-verifier.ts
 *
 * Live checks for directory opportunities — "validate, don't blind-trust":
 *  - checkUrlReachable: is the directory actually live?
 *  - findDirectoryListingCandidates: Google `site:` search → CANDIDATE profile
 *    pages on the directory's domain (mega-domains skipped, sitemaps/search/
 *    category pages dropped). It does NOT decide if any is a real match — an AI
 *    verifier (directory-listing-verifier.llm) confirms the identity before the
 *    UI ever claims "already listed", because blindly trusting Google's first
 *    on-domain result surfaced wrong businesses, sitemaps, and unrelated pages.
 *
 * Candidate search uses ScraperAPI's structured Google output (autoparse=true →
 * JSON organic results). All functions fail soft (never throw) so the pipeline
 * degrades gracefully when ScraperAPI/credentials are unavailable.
 */

import axios from "axios";
import { load } from "cheerio";
import type {
  DirectoryPricingModel,
  DirectorySubmissionType,
} from "../services/offpage/offpage-types";

const SCRAPER_API_URL = "https://api.scraperapi.com";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * GET the directory URL; true when it's a live page. Catches hard not-found
 * responses (404/410) and soft 404s (HTTP 200 but a "page not found" page —
 * many directories serve a branded 404 with a 200 status). Bot-protection
 * statuses like 401/403/429 are treated as indeterminate/live so we do not drop
 * real directories simply because their CDN blocks server-side checks.
 */
export async function checkUrlReachable(url: string): Promise<boolean> {
  if (!isHttpUrl(url)) return false;
  try {
    const res = await axios.get<string>(url, {
      timeout: 12_000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
      responseType: "text",
    });
    if (res.status === 404 || res.status === 410) return false;
    if (res.status >= 400) return true;

    // Soft-404: 200 response whose <title> says not-found.
    const titleMatch = String(res.data ?? "").match(/<title[^>]*>([^<]{0,200})<\/title>/i);
    const title = (titleMatch?.[1] ?? "").toLowerCase();
    if (/\b404\b|page not found|not found|page cannot be found|page unavailable/.test(title)) {
      return false;
    }
    return true;
  } catch {
    // Network error / timeout — indeterminate, NOT confirmed dead. Be lenient so
    // a transient blip doesn't drop a good directory (e.g. Google Business Profile).
    return true;
  }
}

export interface DirectorySubmissionLink {
  url: string;
  text: string;
  submissionUrlType: DirectorySubmissionType;
  pricingModel: DirectoryPricingModel;
}

function isSameDirectoryHost(baseUrl: string, targetUrl: string): boolean {
  const base = domainOf(baseUrl);
  const target = domainOf(targetUrl);
  return Boolean(base && target && (target === base || target.endsWith(`.${base}`)));
}

function normalizeLink(baseUrl: string, href: string): string | null {
  const raw = href.trim();
  if (!raw || /^#/.test(raw)) return null;
  if (/^(mailto|tel|javascript):/i.test(raw)) return null;
  try {
    const url = new URL(raw, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function classifySubmissionType(text: string, href: string): DirectorySubmissionType | null {
  const combined = `${text} ${href}`.toLowerCase();
  if (
    /\b(claim|manage|owner|business owner|verify|unlock)\b/.test(combined) &&
    /\b(business|listing|profile|page|place)\b/.test(combined)
  ) {
    return "direct_claim";
  }
  if (
    /\b(add|submit|create|register|list|get listed|suggest)\b/.test(combined) &&
    /\b(business|listing|profile|company|place|vendor|professional|pro)\b/.test(combined)
  ) {
    return "add_business";
  }
  return null;
}

function classifyPricingModel(text: string, href: string): DirectoryPricingModel {
  const combined = `${text} ${href}`.toLowerCase();
  if (/\bfree\b/.test(combined)) return "free";
  if (/\b(pricing|plans?|advertis(e|ing)|sponsor(ed)?|paid|promote)\b/.test(combined)) {
    return "paid";
  }
  return "unknown";
}

function submissionLinkScore(link: DirectorySubmissionLink): number {
  let score = link.submissionUrlType === "direct_claim" ? 100 : 80;
  if (link.pricingModel === "free") score += 8;
  if (link.pricingModel === "paid") score -= 10;
  if (/login|signin|sign-in|account/i.test(link.url)) score -= 6;
  return score;
}

export function parseDirectorySubmissionLinks(
  html: string,
  baseUrl: string,
  limit = 5,
): DirectorySubmissionLink[] {
  const $ = load(html);
  const links: DirectorySubmissionLink[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") ?? "");
    const url = normalizeLink(baseUrl, href);
    if (!url || seen.has(url)) return;
    if (!isSameDirectoryHost(baseUrl, url)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const submissionUrlType = classifySubmissionType(text, href);
    if (!submissionUrlType) return;
    seen.add(url);
    links.push({
      url,
      text,
      submissionUrlType,
      pricingModel: classifyPricingModel(text, href),
    });
  });

  return links
    .sort((a, b) => submissionLinkScore(b) - submissionLinkScore(a))
    .slice(0, limit);
}

export async function findDirectorySubmissionLinks(
  directoryUrl: string,
): Promise<DirectorySubmissionLink[]> {
  if (!directoryUrl) return [];
  try {
    const res = await axios.get<string>(directoryUrl, {
      timeout: 12_000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
      responseType: "text",
    });
    if (res.status >= 400) return [];
    return parseDirectorySubmissionLinks(String(res.data ?? ""), directoryUrl);
  } catch {
    return [];
  }
}

interface GoogleOrganicResult {
  link?: string;
  title?: string;
  snippet?: string;
}

/** Structured Google results via ScraperAPI autoparse. [] on any failure. */
async function googleResultsViaScraperApi(
  query: string,
): Promise<GoogleOrganicResult[]> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return [];
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`;
  const url = `${SCRAPER_API_URL}/?api_key=${key}&url=${encodeURIComponent(
    googleUrl,
  )}&autoparse=true`;
  try {
    const res = await axios.get(url, { timeout: 30_000 });
    const data = res.data as { organic_results?: unknown };
    const organic = Array.isArray(data?.organic_results)
      ? (data.organic_results as GoogleOrganicResult[])
      : [];
    return organic;
  } catch (err) {
    console.warn(
      "[offpage/directory] google lookup failed:",
      (err as Error).message,
    );
    return [];
  }
}

/** A candidate listing page found on the directory's domain (pre-verification). */
export interface ListingCandidate {
  title: string;
  link: string;
  snippet?: string;
}

/**
 * Mega-domains where a `site:` search is meaningless for "is this business
 * listed" — site:google.com matches Groups/Maps/Sites/everything, so it returns
 * garbage (a random google.com page). We never claim already-listed for these
 * (detecting a Google Business Profile needs the Places API, a separate build).
 */
const MEGA_DOMAINS = new Set([
  "google.com", "google.ca", "apple.com", "bing.com", "microsoft.com",
  "facebook.com", "fb.com", "instagram.com",
]);

/** Sitemaps, search-result pages, category/index pages — never a real profile. */
function isNonProfileUrl(link: string): boolean {
  const l = link.toLowerCase();
  if (/\.xml(\?|$)/.test(l)) return true; // sitemap files
  if (/\/sitemap|\/search\b|\/recherche\b|\/category\b|\/categories\b/.test(l)) return true;
  if (/[?&](q|query|mot|search|keyword|s)=/.test(l)) return true; // search-result pages
  return false;
}

/**
 * Find CANDIDATE listing pages for a business on a directory: a Google
 * `site:<domain> "<business>" <city>` search, kept to on-domain, profile-LIKE
 * URLs (mega-domains skipped, sitemaps/search/category pages dropped). It does
 * NOT decide whether any candidate is a genuine match — that's the AI verifier's
 * job. [] on failure (so the pipeline degrades to "not listed").
 */
export async function findDirectoryListingCandidates(
  directoryUrl: string,
  businessName: string,
  city?: string | null,
): Promise<ListingCandidate[]> {
  const domain = domainOf(directoryUrl);
  if (!domain || !businessName.trim()) return [];
  if (MEGA_DOMAINS.has(domain)) return []; // site: is meaningless here

  const query = `site:${domain} "${businessName.trim()}"${city ? ` ${city}` : ""}`;
  const results = await googleResultsViaScraperApi(query);

  const candidates: ListingCandidate[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const link = typeof r.link === "string" ? r.link : "";
    if (!link || seen.has(link)) continue;
    const d = domainOf(link);
    if (d !== domain && !d.endsWith(`.${domain}`)) continue; // on-domain only
    if (isNonProfileUrl(link)) continue; // drop sitemaps/search/category pages
    seen.add(link);
    candidates.push({
      title: typeof r.title === "string" ? r.title : "",
      link,
      snippet: typeof r.snippet === "string" ? r.snippet : undefined,
    });
  }
  return candidates.slice(0, 6);
}
