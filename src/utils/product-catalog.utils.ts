/**
 * product-catalog.utils.ts
 *
 * Pure helpers to recognize product pages in a sitemap URL list and derive
 * human-readable product names from their slugs — for both the business's own
 * catalog (already stored in the SitemapUrls table) and competitors' catalogs
 * (fetched from their sitemaps). No I/O here, so it is fully unit-testable.
 *
 * We deliberately derive names from URL slugs rather than scraping each product
 * page: it is free, scales to thousands of URLs, and a slug like
 * `/products/wireless-noise-cancelling-headphones` already yields a usable
 * product name for grounding a blog. Richer extraction (ld+json Product, prices)
 * is a future enhancement layered on scrapeWebsite()'s captured jsonLD.
 */

export interface CatalogProduct {
  name: string;
  url: string;
  /** Optional details from ld+json Product schema (when fetched). */
  price?: string;
  currency?: string;
  brand?: string;
}

/**
 * URL path shapes that denote an individual product across the common
 * platforms (Shopify, WooCommerce, BigCommerce, Amazon, generic). Matches a
 * product SEGMENT followed by a slug, so listing roots like `/products` (no
 * slug) and taxonomy pages like `/product-category/...` are NOT matched.
 */
const PRODUCT_URL_REGEX =
  /\/(?:products?|shop|store|item|p|dp|buy|collections\/[^/]+\/products)\/[^/?#]+/i;

/** Path shapes to explicitly exclude even if they look product-ish. */
const NON_PRODUCT_URL_REGEX =
  /\/(?:product-category|product-tag|product_cat|shop-by|blog|news|article|post|page|category|collections)\/?$/i;

/** Slug tokens that are never real product names. */
const JUNK_NAME_REGEX =
  /^(?:products?|shop|store|item|p|dp|buy|index|home|page|default|cart|checkout|all)$/i;

function lastPathSegment(url: string): string {
  let path = String(url ?? "");
  // Strip protocol/host if present.
  path = path.replace(/^[a-z]+:\/\/[^/]+/i, "");
  // Drop query/hash.
  path = path.split(/[?#]/)[0] ?? "";
  // Drop trailing slash, then take the final segment.
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
}

export function isProductUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (NON_PRODUCT_URL_REGEX.test(url)) return false;
  return PRODUCT_URL_REGEX.test(url);
}

export function filterProductUrls(urls: string[]): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.filter((u) => typeof u === "string" && isProductUrl(u));
}

/**
 * Turn a product URL into a readable name from its slug. Returns "" when the
 * slug is junk or ID-like (e.g. Amazon `/dp/B07ABC123`), so callers can drop it.
 */
export function slugToProductName(url: string): string {
  let slug = lastPathSegment(url);
  if (!slug) return "";

  // Strip a file extension (.html, .aspx, etc.).
  slug = slug.replace(/\.[a-z0-9]{1,5}$/i, "");

  if (JUNK_NAME_REGEX.test(slug)) return "";

  // Reject ID-like slugs: all digits, or short uppercase alphanumerics with no
  // separator (typical SKU/ASIN), which carry no human meaning.
  const hasSeparator = /[-_\s]/.test(slug);
  if (!hasSeparator && /^[0-9]+$/.test(slug)) return "";
  if (!hasSeparator && /^[A-Z0-9]{6,}$/.test(slug)) return "";

  const words = slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length === 0) return "";

  const name = words
    .map((w) =>
      // Preserve already-uppercase tokens (brands/acronyms), title-case the rest.
      w === w.toUpperCase() && w.length > 1
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");

  // Final sanity: needs a couple of real characters.
  if (name.replace(/[^a-z0-9]/gi, "").length < 3) return "";
  return name;
}

/**
 * Extract products from a list of sitemap URLs: keep product URLs, derive a
 * name from each, drop unusable names, dedupe by name (case-insensitive), cap.
 */
export function extractProductsFromUrls(
  urls: string[],
  max = 25,
): CatalogProduct[] {
  const productUrls = filterProductUrls(urls);
  const seen = new Set<string>();
  const out: CatalogProduct[] = [];
  for (const url of productUrls) {
    const name = slugToProductName(url);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url });
    if (out.length >= max) break;
  }
  return out;
}
