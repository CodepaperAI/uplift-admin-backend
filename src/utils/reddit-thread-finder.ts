/**
 * reddit-thread-finder.ts
 *
 * Finds REAL, on-topic Reddit thread permalinks for an off-page opportunity so
 * the UI links the user to an actual discussion to contribute to — not the
 * subreddit landing page. Reddit blocked its unauthenticated .json API (403), so
 * we render old.reddit's search page through ScraperAPI and parse permalinks.
 *
 * IMPORTANT (learned the hard way): old.reddit search appends a "more results
 * from across Reddit" group from OTHER subreddits, plus a promoted post — so the
 * first /comments/ link on the page is often a cross-subreddit, off-topic thread.
 * We therefore:
 *   1. accept ONLY /r/<targetSubreddit>/comments/ permalinks (scope), and
 *   2. keep ONLY threads whose title (derived from the URL slug) matches the
 *      business's core topic terms (relevance).
 * If nothing passes, we return [] and the caller keeps the subreddit-level
 * suggestion rather than linking a random thread.
 */

import axios from "axios";
import { fetchWithScraperAPI } from "./tools.utils";

export interface RedditThread {
  url: string;
  title: string;
  /** A tailored, value-first reply suggestion for THIS specific thread. */
  draft?: string | null;
  source?: "old_reddit" | "google";
  createdAt?: string | null;
  ageDays?: number | null;
  commentCount?: number | null;
  locked?: boolean;
  archived?: boolean;
  deleted?: boolean;
  unavailable?: boolean;
  detailCheckedAt?: string | null;
  buyerIntent?: boolean;
  qualityScore?: number;
  qualitySignals?: string[];
  qualityWarnings?: string[];
}

/** Turn a permalink slug ("best_shawarma_in_toronto") into a readable title. */
function deslug(slug: string): string {
  const text = slug.replace(/_+/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ageDaysFromDate(date: Date | null): number | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

function parseCommentCount(text: string): number | null {
  const compact = text.replace(/,/g, "");
  const match = compact.match(/(\d+)\s+(?:comments?|replies?)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDatetime(text: string): string | null {
  const attr = text.match(/datetime=["']([^"']+)["']/i)?.[1];
  if (attr) {
    const d = new Date(attr);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const absolute = text.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i,
  )?.[0];
  if (absolute) {
    const d = new Date(absolute);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const relative = text.match(/\b(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]?.toLowerCase();
    if (Number.isFinite(amount) && unit) {
      const days =
        unit === "minute" || unit === "hour"
          ? 0
          : unit === "day"
            ? amount
            : unit === "week"
              ? amount * 7
              : unit === "month"
                ? amount * 30
                : amount * 365;
      return new Date(Date.now() - days * 86_400_000).toISOString();
    }
  }
  return null;
}

function parseOldRedditMetadata(
  html: string,
  startIndex: number,
): Pick<RedditThread, "createdAt" | "ageDays" | "commentCount" | "locked" | "archived"> {
  const slice = html.slice(Math.max(0, startIndex - 1200), startIndex + 3200);
  const createdAt = parseDatetime(slice);
  return {
    createdAt,
    ageDays: ageDaysFromDate(createdAt ? new Date(createdAt) : null),
    commentCount: parseCommentCount(slice),
    locked: /\blocked\b|comments locked|thread locked/i.test(slice),
    archived: /\barchived\b|comments are archived/i.test(slice),
  };
}

function parseGoogleMetadata(
  title: string,
  snippet?: string,
): Pick<RedditThread, "createdAt" | "ageDays" | "commentCount" | "locked" | "archived"> {
  const text = `${title} ${snippet ?? ""}`;
  const createdAt = parseDatetime(text);
  return {
    createdAt,
    ageDays: ageDaysFromDate(createdAt ? new Date(createdAt) : null),
    commentCount: parseCommentCount(text),
    locked: /\blocked\b|comments locked|thread locked/i.test(text),
    archived: /\barchived\b|comments are archived/i.test(text),
  };
}

function redditToOldRedditUrl(url: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?reddit\.com/i, "https://old.reddit.com");
}

function firstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function parseRedditThreadDetail(
  html: string,
): Pick<
  RedditThread,
  | "createdAt"
  | "ageDays"
  | "commentCount"
  | "locked"
  | "archived"
  | "deleted"
  | "unavailable"
> {
  const page = String(html ?? "");
  const main = page.slice(0, 20_000);
  const createdAt = parseDatetime(main);
  const deleted =
    /\b(?:this post was deleted|post has been deleted|this post has been removed|removed by moderators?|removed by reddit|content unavailable|\[deleted\]|\[removed\])\b/i.test(main);
  const unavailable =
    /\b(?:page not found|subreddit is private|you must be invited|forbidden|not available|this community has been banned|this post is no longer available)\b/i.test(main);

  return {
    createdAt,
    ageDays: ageDaysFromDate(createdAt ? new Date(createdAt) : null),
    commentCount: parseCommentCount(main),
    locked: /\b(?:comments locked|thread locked|this thread has been locked|locked post|class=["'][^"']*locked)\b/i.test(main),
    archived: /\b(?:this thread is archived|comments are archived|new comments cannot be posted|archived post)\b/i.test(main),
    deleted,
    unavailable,
  };
}

export async function verifyRedditThreadDetails(
  threads: RedditThread[],
): Promise<RedditThread[]> {
  const checkedAt = new Date().toISOString();
  const verified: RedditThread[] = [];

  for (const thread of threads) {
    try {
      const html = await fetchWithScraperAPI(redditToOldRedditUrl(thread.url), {
        render: false,
      });
      const detail = parseRedditThreadDetail(html);
      verified.push({
        ...thread,
        createdAt: firstNonNull(detail.createdAt, thread.createdAt),
        ageDays: firstNonNull(detail.ageDays, thread.ageDays),
        commentCount: firstNonNull(detail.commentCount, thread.commentCount),
        locked: Boolean(thread.locked || detail.locked),
        archived: Boolean(thread.archived || detail.archived),
        deleted: Boolean(thread.deleted || detail.deleted),
        unavailable: Boolean(thread.unavailable || detail.unavailable),
        detailCheckedAt: checkedAt,
      });
    } catch (err) {
      verified.push({
        ...thread,
        qualityWarnings: Array.from(
          new Set([
            ...(thread.qualityWarnings ?? []),
            "Thread detail check unavailable",
          ]),
        ),
      });
      console.warn(
        `[offpage/reddit-threads] detail check failed for ${thread.url}:`,
        (err as Error).message,
      );
    }
  }

  return verified;
}

/**
 * Pure parser (exported for tests): extract on-topic threads for `subreddit`
 * from old.reddit search HTML. Scoped to the subreddit, relevance-filtered by
 * `coreTerms` (lowercased topic words). When coreTerms is empty, relevance is
 * not enforced.
 */
export function parseRedditThreads(
  html: string,
  subreddit: string,
  coreTerms: string[],
  limit = 6,
): RedditThread[] {
  const targetSub = subreddit.replace(/^\/?r\//i, "").trim().toLowerCase();
  if (!targetSub) return [];

  const terms = coreTerms
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length >= 3);

  const permalinkRe =
    /\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)/gi;

  const seen = new Set<string>();
  const scored: { thread: RedditThread; score: number; order: number }[] = [];
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = permalinkRe.exec(html)) !== null) {
    const sub = (m[1] ?? "").toLowerCase();
    const id = m[2] ?? "";
    const slug = m[3] ?? "";
    if (sub !== targetSub) continue; // SCOPE: same subreddit only
    if (!id || !slug || seen.has(id)) continue;

    const title = deslug(slug);
    const titleLower = title.toLowerCase();
    // RELEVANCE score = number of business topic terms found in the title.
    const score = terms.filter((t) => titleLower.includes(t)).length;
    if (terms.length > 0 && score === 0) continue;

    seen.add(id);
    const metadata = parseOldRedditMetadata(html, m.index);
    scored.push({
      thread: {
        url: `https://www.reddit.com/r/${m[1]}/comments/${id}/${slug}`,
        title,
        source: "old_reddit",
        ...metadata,
      },
      score:
        score +
        (metadata.commentCount ? 0.1 : 0) +
        (typeof metadata.ageDays === "number" && metadata.ageDays <= 180 ? 0.2 : 0),
      order: order++,
    });
  }

  // Most relevant first (more topic-term matches), stable on ties.
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.thread);
}

/** Clean a Google result title like "Best shawarma? : r/toronto" → "Best shawarma?". */
function cleanGoogleTitle(t: string): string {
  return t
    .replace(/\s*[:|\-–]\s*r\/[A-Za-z0-9_]+.*$/i, "")
    .replace(/\s*[-–|]\s*Reddit\s*$/i, "")
    .trim();
}

/**
 * Pure parser (exported for tests): extract on-topic threads for `subreddit`
 * from Google organic results (a `site:reddit.com` search). Same scope +
 * relevance rules as parseRedditThreads, but uses the REAL thread title Google
 * provides instead of the URL slug.
 */
export function parseGoogleRedditThreads(
  results: Array<{ link: string; title: string; snippet?: string }>,
  subreddit: string,
  coreTerms: string[],
  limit = 6,
): RedditThread[] {
  const targetSub = subreddit.replace(/^\/?r\//i, "").trim().toLowerCase();
  if (!targetSub) return [];

  const terms = coreTerms
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length >= 3);
  const permalinkRe =
    /reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)/i;

  const seen = new Set<string>();
  const scored: { thread: RedditThread; score: number; order: number }[] = [];
  let order = 0;
  for (const r of results) {
    const m = (r.link ?? "").match(permalinkRe);
    if (!m) continue;
    const sub = (m[1] ?? "").toLowerCase();
    const id = m[2] ?? "";
    const slug = m[3] ?? "";
    if (sub !== targetSub) continue; // SCOPE: same subreddit only
    if (!id || seen.has(id)) continue;

    const title = r.title?.trim() ? cleanGoogleTitle(r.title) : deslug(slug);
    const score = terms.filter((t) => title.toLowerCase().includes(t)).length;
    if (terms.length > 0 && score === 0) continue; // RELEVANCE

    seen.add(id);
    const metadata = parseGoogleMetadata(title, r.snippet);
    scored.push({
      thread: {
        url: `https://www.reddit.com/r/${m[1]}/comments/${id}/${slug}`,
        title,
        source: "google",
        ...metadata,
      },
      score:
        score +
        (metadata.commentCount ? 0.1 : 0) +
        (typeof metadata.ageDays === "number" && metadata.ageDays <= 180 ? 0.2 : 0),
      order: order++,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.thread);
}

const SCRAPER_API_URL = "https://api.scraperapi.com";

/** Google `site:reddit.com/r/<sub>` search via ScraperAPI autoparse. [] on failure. */
async function googleRedditResults(
  sub: string,
  query: string,
): Promise<Array<{ link: string; title: string; snippet?: string }>> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return [];
  const q = `site:reddit.com/r/${sub} ${query}`;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20`;
  const url = `${SCRAPER_API_URL}/?api_key=${key}&url=${encodeURIComponent(
    googleUrl,
  )}&autoparse=true`;
  try {
    const res = await axios.get(url, { timeout: 30_000 });
    const data = res.data as {
      organic_results?: Array<{ link?: string; title?: string; snippet?: string }>;
    };
    const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
    return organic
      .map((r) => ({ link: String(r.link ?? ""), title: String(r.title ?? "") }))
      .map((r, i) => ({
        ...r,
        snippet: typeof organic[i]?.snippet === "string" ? organic[i]?.snippet : undefined,
      }))
      .filter((r) => r.link);
  } catch (err) {
    console.warn(
      `[offpage/reddit-threads] google fallback failed for r/${sub}:`,
      (err as Error).message,
    );
    return [];
  }
}

/** Fetch old.reddit search (one retry) and parse on-topic threads. [] on failure. */
async function findThreadsViaOldReddit(
  sub: string,
  query: string,
  coreTerms: string[],
  limit: number,
): Promise<RedditThread[]> {
  const searchUrl =
    `https://old.reddit.com/r/${encodeURIComponent(sub)}/search/` +
    `?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&t=all`;

  // old.reddit + render through ScraperAPI is flaky (transient 500/429 when its
  // proxy gets blocked or the render times out). Retry once before giving up.
  const ATTEMPTS = 2;
  let html: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      html = await fetchWithScraperAPI(searchUrl, {
        render: true,
        deviceType: "desktop",
      });
      break;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === ATTEMPTS) {
        console.warn(
          `[offpage/reddit-threads] old.reddit fetch failed for r/${sub} after ${ATTEMPTS} tries:`,
          msg,
        );
        return [];
      }
      console.warn(
        `[offpage/reddit-threads] r/${sub} attempt ${attempt} failed (${msg}); retrying…`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
  if (!html) return [];
  return parseRedditThreads(html, sub, coreTerms, limit);
}

/**
 * Find up to `limit` on-topic threads in a subreddit. `query` drives the search;
 * `coreTerms` drives the relevance filter. Tries old.reddit first (server-rendered
 * HTML, freshest results), then falls back to Google's index of Reddit
 * (`site:reddit.com`, stable + survives old.reddit getting deprecated, and gives
 * the real thread titles) when old.reddit is flaky or returns nothing on-topic.
 */
export async function findRedditThreads(
  subreddit: string,
  query: string,
  coreTerms: string[],
  limit = 3,
): Promise<RedditThread[]> {
  const sub = subreddit.replace(/^\/?r\//i, "").trim();
  if (!sub || !query.trim()) return [];

  const viaOld = await findThreadsViaOldReddit(sub, query, coreTerms, limit);
  if (viaOld.length > 0) return viaOld;

  const results = await googleRedditResults(sub, query);
  if (results.length === 0) return [];
  console.log(
    `[offpage/reddit-threads] r/${sub}: old.reddit empty → google site:reddit fallback`,
  );
  return parseGoogleRedditThreads(results, sub, coreTerms, limit);
}
