import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import { getCached, setCache } from "./dataforseo-cache";

/**
 * Link validator
 *
 * Given a URL, decides whether it is "alive" — i.e. a real, reachable page
 * that can safely be used as a backlink in generated blog content.
 *
 * Strategy:
 *   1. Validate URL shape (reject malformed strings fast).
 *   2. HEAD request first (cheap, no body download).
 *   3. If HEAD comes back with 403 / 405 / 429 / 5xx, some servers simply
 *      don't support HEAD or block it behind bot protection. Retry with
 *      GET (body streamed and discarded) before deciding.
 *   4. 2xx / 3xx final status = alive. Anything else = dead.
 *
 * Results are cached in the shared in-memory cache for 24h to avoid
 * re-probing the same URL on every blog generation.
 */

const USER_AGENT =
  "Mozilla/5.0 (compatible; SEO Tool Bot; +https://uplift-ai)";
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_CONCURRENCY = 8;

const baseConfig: AxiosRequestConfig = {
  timeout: TIMEOUT_MS,
  maxRedirects: 5,
  // Never throw on status code — we make the alive/dead decision ourselves.
  validateStatus: () => true,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
  },
};

// Statuses where HEAD is likely lying — retry with GET before giving up.
const GET_FALLBACK_STATUSES = new Set([403, 405, 429, 500, 501, 502, 503]);

function isAliveStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

async function probe(url: string): Promise<boolean> {
  // Reject malformed URLs synchronously, no network call.
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return false;
  }

  try {
    const head = await axios.head(url, baseConfig);
    if (isAliveStatus(head.status)) return true;

    if (GET_FALLBACK_STATUSES.has(head.status)) {
      try {
        const get = await axios.get(url, {
          ...baseConfig,
          responseType: "stream",
        });
        // Close the stream immediately — we only care about status.
        const stream = get.data as { destroy?: () => void } | undefined;
        stream?.destroy?.();
        return isAliveStatus(get.status);
      } catch {
        return false;
      }
    }

    return false;
  } catch {
    // DNS failure, timeout, connection reset, etc.
    return false;
  }
}

/**
 * Check whether a URL is live. Results cached for 24h.
 *
 * Returns `true` if the page responds with 2xx/3xx (HEAD or GET),
 * `false` for 4xx, 5xx, network errors, or malformed URLs.
 */
export async function isUrlAlive(url: string): Promise<boolean> {
  const cacheKey = `url-alive:${url}`;
  const cached = getCached<boolean>(cacheKey);
  if (cached !== null) return cached;

  const alive = await probe(url);
  setCache(cacheKey, alive, CACHE_TTL_MS);
  return alive;
}

/**
 * Probe every item in parallel and return the boolean alive/dead map,
 * preserving input order. Private helper for the partition + filter
 * functions below.
 */
async function computeLiveness<T extends { url: string }>(
  items: T[],
  concurrency: number,
): Promise<boolean[]> {
  const results: boolean[] = new Array(items.length).fill(false);
  if (items.length === 0) return results;

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        const item = items[i];
        if (!item) return;
        try {
          results[i] = await isUrlAlive(item.url);
        } catch {
          results[i] = false;
        }
      }
    }),
  );

  return results;
}

/**
 * Filter a list of items to only those whose `url` is live.
 * Preserves the original order.
 */
export async function filterAliveUrls<T extends { url: string }>(
  items: T[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<T[]> {
  const aliveMap = await computeLiveness(items, concurrency);
  return items.filter((_, i) => aliveMap[i]);
}

/**
 * Split a list of items into alive and dead buckets by probing each URL.
 * Preserves original order within each bucket. Use this when the caller
 * also needs to act on the dead items (e.g. delete them from an index).
 */
export async function partitionAliveUrls<T extends { url: string }>(
  items: T[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<{ alive: T[]; dead: T[] }> {
  const aliveMap = await computeLiveness(items, concurrency);
  const alive: T[] = [];
  const dead: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (aliveMap[i]) alive.push(item);
    else dead.push(item);
  }
  return { alive, dead };
}
