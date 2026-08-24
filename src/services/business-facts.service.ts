/**
 * business-facts.service.ts
 *
 * Best-effort extraction of concrete business facts (price-from, group size,
 * lead time, founding year, dietary/options) from the business's OWN website,
 * for facts we don't store in the DB. Pure parsing lives in
 * `business-facts.utils.ts`; this module does the (cached, time-boxed) I/O.
 *
 * Strictly omit-if-not-found: any fetch/parse failure yields an empty/partial
 * result and NEVER throws, so it can't break blog generation. Cached 7 days per
 * domain (same pattern as the competitor-product catalog).
 */

import { fetchWithScraperAPI } from "../utils/tools.utils";
import {
  buildBusinessFactsPromptBlock,
  hasAnyFact,
  mergeFacts,
  parseFactsFromHtml,
  type BusinessFacts,
} from "../utils/business-facts.utils";

export { buildBusinessFactsPromptBlock, hasAnyFact, type BusinessFacts };

const FACTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAGE_TIMEOUT_MS = 10000;
const factsCache = new Map<string, { facts: BusinessFacts; at: number }>();

/** Candidate paths likely to state pricing / founding / capacity, by any business type. */
const CANDIDATE_PATHS = ["", "/about", "/about-us", "/pricing", "/services", "/menu"];
const MAX_PAGES = 3;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function normalizeWebsite(url: unknown): string | null {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function domainKey(origin: string): string {
  return origin.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
}

/**
 * Get real facts for a business by scraping its own site. Best-effort + cached.
 * `business` only needs a website field; accepts the loose blog-generation object.
 */
export async function getBusinessFacts(business: unknown): Promise<BusinessFacts> {
  const rec = (business ?? {}) as Record<string, unknown>;
  const origin = normalizeWebsite(
    rec.businessWebsiteUrl ?? rec.websiteUrl ?? rec.website,
  );
  if (!origin) return {};

  const key = domainKey(origin);
  const cached = factsCache.get(key);
  if (cached && Date.now() - cached.at < FACTS_CACHE_TTL_MS) {
    return cached.facts;
  }

  let facts: BusinessFacts = {};
  try {
    const urls = CANDIDATE_PATHS.slice(0, MAX_PAGES).map((p) => `${origin}${p}`);
    const htmls = await Promise.all(
      urls.map((u) =>
        withTimeout(fetchWithScraperAPI(u).catch(() => ""), PAGE_TIMEOUT_MS, ""),
      ),
    );
    for (const html of htmls) {
      if (!html) continue;
      facts = mergeFacts(facts, parseFactsFromHtml(html));
    }
  } catch {
    // best-effort: keep whatever we have (possibly empty)
  }

  factsCache.set(key, { facts, at: Date.now() });
  return facts;
}

/** Test seam: clear the in-memory facts cache. */
export function __clearBusinessFactsCache(): void {
  factsCache.clear();
}
