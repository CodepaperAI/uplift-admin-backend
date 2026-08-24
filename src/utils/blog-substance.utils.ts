/**
 * blog-substance.utils.ts
 *
 * Extracts the REAL substance a blog should be grounded in — the business's
 * actual competitors and its actual offerings (products for e-commerce,
 * services for service businesses) — and formats it into prompt blocks.
 *
 * Why this exists: the generator used to be fed only a website scrape and
 * competitor SERP *titles*, so it produced hedged, generic prose and
 * fabricated "Brand A vs Brand B" comparisons. This module surfaces the real
 * named competitors (already loaded on the business as `competitiors`) and the
 * real offerings (`effectiveServices`) so the model can write like an expert
 * who knows THIS business — and so the expert-voice judge can check it did.
 *
 * Every function here is total and defensive: malformed / missing input never
 * throws, it just yields an empty/neutral result. It does no I/O, so it is
 * fully unit-testable.
 */

import type { CatalogProduct } from "./product-catalog.utils";

export type BusinessModelType = "service" | "product" | "mixed";

export interface CompetitorSubstance {
  name: string;
  url?: string;
  /** From the richer CompetitorIntelligence table, when available. */
  strengthAreas?: string[];
  contentTopics?: string[];
  /** Real products from the competitor's sitemap (for "X vs Y" comparisons). */
  products?: CatalogProduct[];
}

export interface OfferingSubstance {
  type: BusinessModelType;
  /** Top-level categories (e-commerce) or primary service lines. */
  categories: string[];
  /** Specific products / sub-services (label-level fallback). */
  items: string[];
  /** Real products from the business's own sitemap, when available. */
  products?: CatalogProduct[];
}

export interface BusinessSubstance {
  businessName: string;
  competitors: CompetitorSubstance[];
  offering: OfferingSubstance;
}

const MAX_COMPETITORS = 6;
const MAX_CATEGORIES = 12;
const MAX_ITEMS = 16;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of v) {
    const s = cleanString(entry);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Classify the business as service / product / mixed. Mirrors the heuristic in
 * business-context-analyzer.ts but is self-contained and defensive. Defaults to
 * "service" because the customer base is predominantly local service businesses.
 */
export function detectBusinessModelType(businessInfo: unknown): BusinessModelType {
  if (!isRecord(businessInfo)) return "service";

  const enhanced = isRecord(businessInfo.enhancedBusinessInfo)
    ? businessInfo.enhancedBusinessInfo
    : undefined;

  const haystack = [
    cleanString(businessInfo.businessType),
    cleanString(enhanced?.businessModel),
    cleanString(businessInfo.businessModel),
  ]
    .join(" ")
    .toLowerCase();

  const productSignal =
    /\b(e-?commerce|ecommerce|online store|shop|store|retail|marketplace|product|catalog|catalogue|dropship|sell(s|ing)? products|d2c|dtc)\b/.test(
      haystack,
    );
  const serviceSignal =
    /\b(service|services|agency|consult|repair|clinic|salon|contractor|catering|installation|maintenance|provider|firm|studio)\b/.test(
      haystack,
    );

  if (productSignal && serviceSignal) return "mixed";
  if (productSignal) return "product";
  return "service";
}

/**
 * Pull real competitors. Reads the (misspelled) `competitiors` relation that is
 * already loaded for blog generation, falls back to a correctly-spelled
 * `competitors` key, and enriches with CompetitorIntelligence when present.
 */
export function extractCompetitors(businessInfo: unknown): CompetitorSubstance[] {
  if (!isRecord(businessInfo)) return [];

  const raw =
    (Array.isArray(businessInfo.competitiors) && businessInfo.competitiors) ||
    (Array.isArray(businessInfo.competitors) && businessInfo.competitors) ||
    [];

  // Index richer intelligence by lowercased name / domain for enrichment.
  const intel = new Map<string, Record<string, unknown>>();
  const intelSource =
    (Array.isArray(businessInfo.CompetitorIntelligences) &&
      businessInfo.CompetitorIntelligences) ||
    (Array.isArray(businessInfo.competitorIntelligence) &&
      businessInfo.competitorIntelligence) ||
    [];
  for (const row of intelSource as unknown[]) {
    if (!isRecord(row)) continue;
    const name = cleanString(row.competitorName).toLowerCase();
    const domain = cleanString(row.competitorDomain).toLowerCase();
    if (name) intel.set(name, row);
    if (domain) intel.set(domain, row);
  }

  const seen = new Set<string>();
  const out: CompetitorSubstance[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const name = cleanString(entry.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const url = cleanString(entry.url) || undefined;
    let domainKey = "";
    if (url) {
      domainKey = (
        url
          .replace(/^https?:\/\//i, "")
          .replace(/^www\./i, "")
          .split("/")[0] ?? ""
      ).toLowerCase();
    }
    const enrichment = intel.get(key) || (domainKey ? intel.get(domainKey) : undefined);

    out.push({
      name,
      url,
      strengthAreas: enrichment
        ? cleanStringArray(enrichment.strengthAreas, 5)
        : undefined,
      contentTopics: enrichment
        ? cleanStringArray(enrichment.contentTopics, 5)
        : undefined,
    });
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}

/** Pull real offerings from effectiveServices / coreServices. */
export function extractOfferings(businessInfo: unknown): OfferingSubstance {
  const type = detectBusinessModelType(businessInfo);
  const empty: OfferingSubstance = { type, categories: [], items: [] };
  if (!isRecord(businessInfo)) return empty;

  const services =
    (isRecord(businessInfo.effectiveServices) && businessInfo.effectiveServices) ||
    (isRecord(businessInfo.coreServices) && businessInfo.coreServices) ||
    undefined;

  if (!services) {
    // Last resort: selectedServices / detectedServices string arrays.
    const fallback = cleanStringArray(businessInfo.selectedServices, MAX_CATEGORIES);
    return { type, categories: fallback, items: [] };
  }

  const categories = cleanStringArray(
    Array.isArray(services.orderedPrimaryServices) &&
      services.orderedPrimaryServices.length > 0
      ? services.orderedPrimaryServices
      : services.topLevel,
    MAX_CATEGORIES,
  );
  const items = cleanStringArray(services.subOfferings, MAX_ITEMS);

  return { type, categories, items };
}

export function extractBusinessSubstance(businessInfo: unknown): BusinessSubstance {
  const businessName = isRecord(businessInfo)
    ? cleanString(businessInfo.businessName)
    : "";
  return {
    businessName,
    competitors: extractCompetitors(businessInfo),
    offering: extractOfferings(businessInfo),
  };
}

function bullets(items: string[]): string {
  return items.map((i) => `  - ${i}`).join("\n");
}

function productBullets(products: CatalogProduct[]): string {
  return products
    .map((p) => {
      const price = p.price
        ? ` — ${p.currency ? `${p.currency} ` : ""}${p.price}`
        : "";
      const brand = p.brand ? ` [${p.brand}]` : "";
      return `  - ${p.name}${brand}${p.url ? ` (${p.url})` : ""}${price}`;
    })
    .join("\n");
}

/** Competitor prompt block — uses real names, forbids fabricated vs. */
export function buildCompetitorPromptBlock(
  competitors: CompetitorSubstance[],
  businessName: string,
): string {
  const who = businessName || "this business";
  if (competitors.length === 0) {
    return [
      "REAL COMPETITORS: none verified for this business.",
      `- Do NOT fabricate named competitor comparisons (no invented "Brand A vs Brand B").`,
      "- If the topic calls for comparison, compare real, well-known industry-standard",
      "  approaches or options generically — never invent brand names or fake rivals.",
    ].join("\n");
  }

  const lines = competitors.map((c) => {
    const parts = [`  - ${c.name}${c.url ? ` (${c.url})` : ""}`];
    if (c.strengthAreas && c.strengthAreas.length > 0) {
      parts.push(`      known for: ${c.strengthAreas.join(", ")}`);
    }
    if (c.contentTopics && c.contentTopics.length > 0) {
      parts.push(`      ranks on: ${c.contentTopics.join(", ")}`);
    }
    if (c.products && c.products.length > 0) {
      parts.push(
        `      real products: ${c.products
          .slice(0, 6)
          .map((p) => p.name)
          .join(", ")}`,
      );
    }
    return parts.join("\n");
  });

  const anyCompetitorProducts = competitors.some(
    (c) => c.products && c.products.length > 0,
  );

  const out = [
    `REAL COMPETITORS of ${who} (use for genuine, honest differentiation):`,
    lines.join("\n"),
    "- When the topic warrants comparison, compare against these REAL named",
    "  competitors (or well-known industry-standard options) — never invent rivals.",
    `- Position ${who}'s real strengths against them honestly; do not disparage.`,
    `- Do NOT write generic "X vs Y" filler about brands not listed here.`,
  ];

  if (anyCompetitorProducts) {
    out.push(
      `- For "X vs Y" / comparison topics, write GENUINE head-to-head comparisons`,
      `  between ${who}'s real products and the real competitor products listed`,
      "  above, by name. Be fair and accurate — this is what ranks for comparison",
      "  queries. Never compare against invented or misattributed products.",
    );
  }

  return out.join("\n");
}

/** Offering prompt block — business-type aware (products vs services). */
export function buildOfferingPromptBlock(
  offering: OfferingSubstance,
  businessName: string,
): string {
  const who = businessName || "this business";
  const hasCategories = offering.categories.length > 0;
  const hasItems = offering.items.length > 0;
  const realProducts = offering.products ?? [];
  const hasProducts = realProducts.length > 0;

  if (!hasCategories && !hasItems && !hasProducts) {
    return [
      "REAL OFFERINGS: none explicitly listed.",
      `- Reference only what the business data supports; do not invent ${
        offering.type === "product" ? "products or SKUs" : "services"
      } that are not implied by the business description.`,
    ].join("\n");
  }

  if (offering.type === "product") {
    return [
      `${who} is a PRODUCT / E-COMMERCE business. Ground the article in its real catalog:`,
      hasCategories ? `Real product categories:\n${bullets(offering.categories)}` : "",
      hasProducts
        ? `ACTUAL products from this store's catalog (use these by name; link where natural):\n${productBullets(
            realProducts,
          )}`
        : hasItems
          ? `Specific products / lines:\n${bullets(offering.items)}`
          : "",
      "- Frame content as buying guides, comparisons, or how-to-choose pieces that",
      "  reference these REAL categories and products by name.",
      "- Do NOT invent product names, SKUs, specs, or prices not implied by the data.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (offering.type === "mixed") {
    return [
      `${who} offers BOTH products and services. Ground the article in both:`,
      hasCategories ? `Real categories / service lines:\n${bullets(offering.categories)}` : "",
      hasProducts
        ? `ACTUAL products from this store's catalog (use by name):\n${productBullets(realProducts)}`
        : hasItems
          ? `Specific products / sub-services:\n${bullets(offering.items)}`
          : "",
      "- Use these REAL offerings in examples and recommendations; do not invent new ones.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // service (default)
  return [
    `${who} is a SERVICE business. Ground the article in its real services:`,
    hasCategories ? `Primary services:\n${bullets(offering.categories)}` : "",
    hasItems ? `Specific sub-services:\n${bullets(offering.items)}` : "",
    "- Reference these REAL services in examples and recommendations; frame the content",
    "  around how they solve the reader's problem. Do NOT invent services not listed.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The full substance section injected into the generation task message. */
export function buildBusinessSubstanceSection(substance: BusinessSubstance): string {
  return [
    "        **REAL SUBSTANCE TO GROUND THIS ARTICLE (use it; do not fabricate around it):**",
    "",
    buildOfferingPromptBlock(substance.offering, substance.businessName)
      .split("\n")
      .map((l) => `        ${l}`)
      .join("\n"),
    "",
    buildCompetitorPromptBlock(substance.competitors, substance.businessName)
      .split("\n")
      .map((l) => `        ${l}`)
      .join("\n"),
  ].join("\n");
}
