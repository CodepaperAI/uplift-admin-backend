import { getEquivalentWebsiteUrls, normalizeWebsiteUrl } from "./url-normalizer";

/**
 * Citation domain matcher
 *
 * Shared helpers used by the AI visibility module to decide whether a piece
 * of LLM output text cites the customer's own domain. Two tiers:
 *
 *   Tier A — URL match: does the parsed hostname equal apex or www variant
 *     of the customer's website URL?
 *
 *   Tier B — Brand match: does the text mention the customer's brand name
 *     with a proper word boundary, and is the brand specific enough that
 *     it's unlikely to be an unrelated English word?
 *
 * Previously these checks were done with raw substring matches (e.g.
 * `text.includes("uplift")`), which caused rampant false positives on
 * generic domain prefixes like "help", "shop", "blog", "ai".
 */

/**
 * Common English stopwords + noisy-token denylist. Anything whose lowercase
 * form is in here will NEVER be used as a Tier-B brand pattern, no matter
 * how the domain is shaped.
 *
 * Intentionally conservative: better to miss a few real mentions than to
 * flood the dashboard with false citations.
 */
const BRAND_DENYLIST: Set<string> = new Set([
  // Ultra-generic web / business words — common in domain prefixes.
  "the",
  "app",
  "ai",
  "co",
  "io",
  "me",
  "my",
  "shop",
  "store",
  "blog",
  "help",
  "news",
  "mail",
  "site",
  "web",
  "online",
  "home",
  "best",
  "top",
  "get",
  "go",
  "new",
  "one",
  "two",
  "three",
  // Industry/service nouns that appear in many domains but shouldn't
  // anchor a citation by themselves.
  "plumbing",
  "roofing",
  "cleaning",
  "dental",
  "legal",
  "medical",
  "travel",
  "food",
  "tech",
  "digital",
  "local",
  "auto",
]);

const MIN_BRAND_LENGTH = 4;

export interface DomainMatchSet {
  /** Lowercased hostnames that count as "own domain" (apex + www variant). */
  equivalentHosts: Set<string>;
  /**
   * Word-boundary anchored regexes matching brand mentions in LLM output.
   * Built from the domain's second-level label (if it passes the denylist)
   * plus the business name (if provided).
   */
  brandPatterns: RegExp[];
  /**
   * Readable source label for debugging / logging — the original website URL.
   */
  originalWebsiteUrl: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Strip the `www.` subdomain prefix for comparison, but never alter any
 * deeper hostname.
 */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Extract a plausible brand label from a domain name. E.g.
 *   `acme-plumbing.co` → `acme-plumbing`
 *   `example.com` → `example`
 *
 * Returns null if the resulting label is too short or in the denylist.
 */
function brandLabelFromHost(host: string): string | null {
  const stripped = stripWww(host);
  const secondLevel = stripped.split(".")[0] || "";
  if (!secondLevel) return null;
  if (secondLevel.length < MIN_BRAND_LENGTH) return null;
  if (BRAND_DENYLIST.has(secondLevel)) return null;
  return secondLevel;
}

/**
 * Build all regex variants of a brand label — hyphenated and space-separated
 * forms, anchored with `\b` so we only match on word boundaries.
 */
function buildBrandRegexes(label: string): RegExp[] {
  const variants = new Set<string>();
  variants.add(label);
  if (label.includes("-")) {
    variants.add(label.replace(/-/g, " "));
    variants.add(label.replace(/-/g, ""));
  }
  return Array.from(variants).map(
    (v) => new RegExp(`\\b${escapeRegex(v)}\\b`, "i"),
  );
}

/**
 * Build the full match set for a business, given its website URL and
 * (optionally) its human-readable business name.
 *
 * Business name is added as an additional brand pattern as long as it is
 * long enough and not a pure denylist token — this lets us catch citations
 * like "Acme Plumbing recommends…" even when the customer's domain is a
 * generic `serviceco.com`.
 */
export function buildDomainMatchSet(
  websiteUrl: string,
  businessName?: string | null,
): DomainMatchSet {
  const equivalentHosts = new Set<string>();

  const normalized = normalizeWebsiteUrl(websiteUrl);
  const baseHost = hostFromUrl(normalized);
  if (baseHost) {
    equivalentHosts.add(stripWww(baseHost));
    equivalentHosts.add(baseHost);
  }

  for (const variant of getEquivalentWebsiteUrls(websiteUrl)) {
    const host = hostFromUrl(variant);
    if (host) {
      equivalentHosts.add(stripWww(host));
      equivalentHosts.add(host);
    }
  }

  const brandPatterns: RegExp[] = [];

  const domainBrand = baseHost ? brandLabelFromHost(baseHost) : null;
  if (domainBrand) {
    brandPatterns.push(...buildBrandRegexes(domainBrand));
  }

  if (businessName) {
    const trimmed = businessName.trim();
    // Only accept the business name as a brand pattern if it's long enough
    // and not a lone denylisted token (e.g. "Help").
    if (
      trimmed.length >= MIN_BRAND_LENGTH &&
      !BRAND_DENYLIST.has(trimmed.toLowerCase())
    ) {
      brandPatterns.push(
        new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i"),
      );
    }
  }

  return {
    equivalentHosts,
    brandPatterns,
    originalWebsiteUrl: websiteUrl,
  };
}

/**
 * Does `candidateUrl` point at the customer's own domain?
 * Handles `www.` / apex / path variants via hostname comparison.
 */
export function isOwnDomain(
  candidateUrl: string,
  matchSet: DomainMatchSet,
): boolean {
  const host = hostFromUrl(candidateUrl);
  if (!host) return false;
  if (matchSet.equivalentHosts.has(host)) return true;
  return matchSet.equivalentHosts.has(stripWww(host));
}

/**
 * Search `text` for a word-boundary brand mention. Returns the match
 * location (for extracting surrounding context) or null.
 */
export function matchBrand(
  text: string,
  matchSet: DomainMatchSet,
): { index: number; length: number } | null {
  for (const pattern of matchSet.brandPatterns) {
    const m = pattern.exec(text);
    if (m && typeof m.index === "number") {
      return { index: m.index, length: m[0].length };
    }
  }
  return null;
}
