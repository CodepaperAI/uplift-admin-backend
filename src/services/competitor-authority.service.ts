import { LlmQueryDifficulty } from "@prisma/client";
import { fetchDomainRankFromDataForSEO } from "../utils/dataforseo-backlinks.utils";
import { getCached, setCache } from "../utils/dataforseo-cache";

/**
 * Competitor authority service
 *
 * Provides a "how hard is it to outrank this set of competitors" signal
 * used by LLM query discovery to grade each discovered query as
 * EASY / MEDIUM / HARD.
 *
 * Previous behaviour: pure competitor COUNT. A query with 2 competitors
 * was MEDIUM even if those competitors were wikipedia.org + yelp.com
 * (unrealistic to outrank).
 *
 * New behaviour: fetch DataForSEO domain rank (0–1000) per competitor and
 * sum authority weights:
 *
 *     rank ≥ 600     → weight 2.0   (authority — hard to outrank)
 *     rank ≥ 300     → weight 1.0   (moderate)
 *     rank < 300
 *       or unknown   → weight 0.5   (weak / unknown — easy to outrank)
 *
 * Totals: < 2 → EASY, < 5 → MEDIUM, ≥ 5 → HARD.
 *
 * Rank lookups are cached per-domain for 7 days to bound DataForSEO cost.
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTHORITY_THRESHOLD = 600;
const MODERATE_THRESHOLD = 300;
const EASY_WEIGHT_CAP = 2;
const MEDIUM_WEIGHT_CAP = 5;

function cacheKey(domain: string): string {
  return `domain-authority:${domain.toLowerCase()}`;
}

/**
 * Fetch the DataForSEO rank for a single domain. Uses the existing
 * `fetchDomainRankFromDataForSEO` helper and caches the result.
 *
 * Returns `null` on any failure — DataForSEO being unconfigured, rate-
 * limited, or simply not having data about the domain. Null is cached
 * too, so repeated lookups for "unknown" domains don't keep hitting the
 * API.
 */
export async function getDomainAuthority(
  domain: string,
): Promise<number | null> {
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  if (!normalized) return null;

  const key = cacheKey(normalized);
  const cached = getCached<{ value: number | null }>(key);
  if (cached !== null) return cached.value;

  let value: number | null = null;
  try {
    const result = await fetchDomainRankFromDataForSEO(normalized);
    if (result) {
      // DataForSEO returns several fields depending on endpoint version.
      // Prefer `rank` (0–1000 internal), fall back to `domain_rank`, then
      // `domain_authority` (Moz-style 0–100 rescaled to 0–1000).
      const raw =
        typeof result.rank === "number"
          ? result.rank
          : typeof result.domain_rank === "number"
            ? result.domain_rank
            : typeof result.domain_authority === "number"
              ? result.domain_authority * 10
              : null;
      if (typeof raw === "number" && raw >= 0) {
        value = raw;
      }
    }
  } catch {
    value = null;
  }

  setCache(key, { value }, CACHE_TTL_MS);
  return value;
}

/**
 * Fetch authorities for a batch of domains. Individual failures resolve
 * to `null` in the returned map; the batch never throws.
 */
export async function getBulkDomainAuthorities(
  domains: string[],
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  const unique = Array.from(new Set(domains.map((d) => d.toLowerCase())));
  if (unique.length === 0) return map;

  const settled = await Promise.all(
    unique.map(async (domain) => {
      try {
        const rank = await getDomainAuthority(domain);
        return [domain, rank] as const;
      } catch {
        return [domain, null] as const;
      }
    }),
  );

  for (const [domain, rank] of settled) {
    map.set(domain, rank);
  }
  return map;
}

/**
 * Map a DataForSEO rank (or null) to the authority weight that will feed
 * the difficulty threshold.
 */
export function authorityWeight(rank: number | null): number {
  if (rank === null) return 0.5;
  if (rank >= AUTHORITY_THRESHOLD) return 2.0;
  if (rank >= MODERATE_THRESHOLD) return 1.0;
  return 0.5;
}

/**
 * Compute an authority-weighted LlmQueryDifficulty from a list of
 * competitor domains.
 *
 *  total < 2  → EASY
 *  total < 5  → MEDIUM
 *  total ≥ 5  → HARD
 *
 * Empty list → EASY.
 */
export async function computeAuthorityWeightedDifficulty(
  competitorDomains: string[],
): Promise<LlmQueryDifficulty> {
  if (competitorDomains.length === 0) return "EASY";

  const authorities = await getBulkDomainAuthorities(competitorDomains);
  let total = 0;
  for (const domain of competitorDomains) {
    const rank = authorities.get(domain.toLowerCase()) ?? null;
    total += authorityWeight(rank);
  }

  if (total < EASY_WEIGHT_CAP) return "EASY";
  if (total < MEDIUM_WEIGHT_CAP) return "MEDIUM";
  return "HARD";
}
