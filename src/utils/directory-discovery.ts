/**
 * directory-discovery.ts
 *
 * Discovers REAL directory domains for a business by searching its category +
 * location the way a customer would ("shawarma toronto", "best mexican
 * restaurant toronto") and seeing which domains keep ranking. Directories (Yelp,
 * TripAdvisor, BlogTO, OpenTable, G2, Clutch...) rank repeatedly across those
 * searches; a single business site appears once. So the cross-query frequency is
 * a strong "this is a directory for this niche" signal — and it's grounded in
 * live search, not the model's memory. Feeds the directory AI agent so its list
 * is real, not invented. Fails soft (returns []).
 */

import axios from "axios";
import type {
  BusinessResearchBrief,
  OffPageResearchStrategy,
} from "../services/offpage/offpage-types";

const SCRAPER_API_URL = "https://api.scraperapi.com";
const MAX_QUERIES = 3;
const MAX_DOMAINS = 20;

/** Not directories — search engines, social, UGC, encyclopedias. */
const EXCLUDE_DOMAINS = new Set([
  "google.com", "google.ca", "youtube.com", "facebook.com", "m.facebook.com",
  "instagram.com", "twitter.com", "x.com", "linkedin.com", "pinterest.com",
  "tiktok.com", "wikipedia.org", "reddit.com", "quora.com", "medium.com",
  "blogspot.com", "wordpress.com",
]);

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

async function googleResultDomains(query: string): Promise<string[]> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return [];
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;
  const url = `${SCRAPER_API_URL}/?api_key=${key}&url=${encodeURIComponent(
    googleUrl,
  )}&autoparse=true`;
  try {
    const res = await axios.get(url, { timeout: 30_000 });
    const data = res.data as { organic_results?: Array<{ link?: string }> };
    const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
    const domains: string[] = [];
    const seen = new Set<string>();
    for (const r of organic) {
      const d = domainOf(typeof r.link === "string" ? r.link : "");
      if (!d || seen.has(d)) continue; // count each domain once per query
      seen.add(d);
      domains.push(d);
    }
    return domains;
  } catch (err) {
    console.warn("[offpage/dir-discovery] search failed:", (err as Error).message);
    return [];
  }
}

/** Discover candidate directory domains (most frequently-ranking first). [] on failure. */
export async function discoverDirectoryDomains(
  brief: BusinessResearchBrief,
  strategy?: OffPageResearchStrategy,
): Promise<string[]> {
  const category = (brief.category ?? "").trim();
  const city = (brief.location.city ?? "").trim();
  const country = (brief.location.country ?? "").trim();
  const keyword = (brief.keywords[0] ?? "").trim();
  if (!category && !keyword) return [];

  const plannerQueries = strategy?.directory.enabled
    ? strategy.directory.searchQueries
    : [];

  const queries = uniq([
    ...plannerQueries,
    [category, city].filter(Boolean).join(" "),
    ["best", category, city].filter(Boolean).join(" "),
    [keyword, city].filter(Boolean).join(" "),
    [category, "directory", country].filter(Boolean).join(" "),
  ])
    .filter((q) => q.length > 2)
    .slice(0, MAX_QUERIES);

  if (queries.length === 0) return [];

  const ownDomain = domainOf(brief.websiteUrl ?? "");
  const counts = new Map<string, number>();

  const perQuery = await Promise.all(queries.map((q) => googleResultDomains(q)));
  for (const domains of perQuery) {
    for (const d of domains) {
      if (d === ownDomain || EXCLUDE_DOMAINS.has(d)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }

  // Directories rank across multiple category searches → sort by frequency.
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d)
    .slice(0, MAX_DOMAINS);
}
