/**
 * product-catalog.service.ts
 *
 * Grounds e-commerce blog generation in REAL products instead of guesses:
 *  - the business's own products come from the already-crawled SitemapUrls table
 *    (free, no fetching);
 *  - competitor products are fetched from their sitemaps on demand (best-effort,
 *    capped, in-memory TTL-cached) so the model can write genuine "X vs Y"
 *    comparison posts using real product names on both sides.
 *
 * All functions are best-effort: any failure returns an empty list and never
 * throws, so catalog enrichment can never break blog generation.
 */

import { prisma } from "../config/db.config";
import {
  discoverSitemapUrl,
  fetchSitemapUrls,
  fetchWithScraperAPI,
} from "../utils/tools.utils";
import {
  extractProductsFromUrls,
  type CatalogProduct,
} from "../utils/product-catalog.utils";
import {
  extractProductDetailsFromHtml,
  type ProductDetails,
} from "../utils/product-schema.utils";
import type { BusinessSubstance } from "../utils/blog-substance.utils";

const COMPETITOR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const competitorProductCache = new Map<
  string,
  { products: CatalogProduct[]; at: number }
>();

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function normalizeDomain(url: string): string {
  if (typeof url !== "string") return "";
  return url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    ?.toLowerCase() ?? "";
}

/** Business's own products from the already-stored sitemap URL list. */
export async function getBusinessProductsFromSitemap(
  userId: string,
  businessId: string,
  max = 25,
): Promise<CatalogProduct[]> {
  try {
    const row = await prisma.sitemapUrls.findFirst({
      where: { userId, businessId },
      select: { urls: true },
    });
    if (!row || !Array.isArray(row.urls)) return [];
    return extractProductsFromUrls(row.urls, max);
  } catch (err) {
    console.error(
      "⚠️ getBusinessProductsFromSitemap failed:",
      (err as Error).message,
    );
    return [];
  }
}

/** Competitor products from their sitemap. Best-effort, cached, time-boxed. */
export async function getCompetitorProducts(
  competitorUrl: string,
  max = 12,
): Promise<CatalogProduct[]> {
  const domain = normalizeDomain(competitorUrl);
  if (!domain) return [];

  const cached = competitorProductCache.get(domain);
  if (cached && Date.now() - cached.at < COMPETITOR_CACHE_TTL_MS) {
    return cached.products.slice(0, max);
  }

  try {
    const sitemapUrl = await withTimeout(
      discoverSitemapUrl(`https://${domain}`),
      8000,
      null,
    );
    if (!sitemapUrl) {
      competitorProductCache.set(domain, { products: [], at: Date.now() });
      return [];
    }
    const urls = await withTimeout(
      fetchSitemapUrls(sitemapUrl),
      12000,
      [] as string[],
    );
    const products = extractProductsFromUrls(urls, max);
    competitorProductCache.set(domain, { products, at: Date.now() });
    return products;
  } catch (err) {
    console.error(
      `⚠️ getCompetitorProducts failed for ${domain}:`,
      (err as Error).message,
    );
    // Cache the empty result so a flaky competitor doesn't retry every blog.
    competitorProductCache.set(domain, { products: [], at: Date.now() });
    return [];
  }
}

/** Test seam: clear the in-memory competitor cache. */
export function _clearCompetitorProductCache(): void {
  competitorProductCache.clear();
}

const productDetailsCache = new Map<
  string,
  { details: ProductDetails; at: number }
>();

/** Fetch a product page and parse its ld+json Product (price/brand). Best-effort. */
export async function fetchProductDetails(url: string): Promise<ProductDetails> {
  if (!url) return {};
  const cached = productDetailsCache.get(url);
  if (cached && Date.now() - cached.at < COMPETITOR_CACHE_TTL_MS) {
    return cached.details;
  }
  let details: ProductDetails = {};
  try {
    const html = await withTimeout(fetchWithScraperAPI(url), 12000, "");
    details = (html && extractProductDetailsFromHtml(html)) || {};
  } catch (err) {
    console.error(
      `⚠️ fetchProductDetails failed for ${url}:`,
      (err as Error).message,
    );
  }
  productDetailsCache.set(url, { details, at: Date.now() });
  return details;
}

/** Enrich the top-N products with ld+json price/brand. Best-effort, capped. */
async function enrichProductsWithDetails(
  products: CatalogProduct[],
  max = 5,
): Promise<CatalogProduct[]> {
  const out = [...products];
  const limit = Math.min(max, out.length);
  await Promise.all(
    Array.from({ length: limit }, (_, i) => i).map(async (i) => {
      const p = out[i]!;
      const details = await fetchProductDetails(p.url);
      out[i] = {
        ...p,
        name: details.name || p.name,
        price: details.price ?? p.price,
        currency: details.currency ?? p.currency,
        brand: details.brand ?? p.brand,
      };
    }),
  );
  return out;
}

export interface CatalogEnrichmentContext {
  userId: string;
  businessId: string;
  /** Fetch competitor sitemaps too (more expensive — gate behind a flag). */
  includeCompetitorProducts: boolean;
  /** How many competitors to fetch products for. */
  maxCompetitorsToFetch?: number;
  /** Fetch product pages to attach real price/brand (network — gate behind a flag). */
  includeProductDetails?: boolean;
}

/**
 * Returns a NEW substance with real catalog products attached, for product /
 * mixed businesses only. Pure-service businesses are returned unchanged (no
 * sitemap-product concept applies).
 */
export async function enrichSubstanceWithCatalog(
  substance: BusinessSubstance,
  ctx: CatalogEnrichmentContext,
): Promise<BusinessSubstance> {
  const isProductLike =
    substance.offering.type === "product" || substance.offering.type === "mixed";
  if (!isProductLike) return substance;

  let businessProducts = await getBusinessProductsFromSitemap(
    ctx.userId,
    ctx.businessId,
  );

  // Optionally attach real price/brand from each product's ld+json (capped).
  if (ctx.includeProductDetails && businessProducts.length > 0) {
    businessProducts = await enrichProductsWithDetails(businessProducts, 5);
  }

  let competitors = substance.competitors;
  if (ctx.includeCompetitorProducts && substance.competitors.length > 0) {
    const limit = ctx.maxCompetitorsToFetch ?? 2;
    const targets = substance.competitors.slice(0, limit);
    const fetched = await Promise.all(
      targets.map(async (c) => {
        if (!c.url) return c;
        const products = await getCompetitorProducts(c.url);
        return products.length > 0 ? { ...c, products } : c;
      }),
    );
    // Keep any competitors beyond the fetch limit unchanged.
    competitors = [...fetched, ...substance.competitors.slice(limit)];
  }

  return {
    ...substance,
    competitors,
    offering: {
      ...substance.offering,
      products: businessProducts.length > 0 ? businessProducts : substance.offering.products,
    },
  };
}
