/**
 * product-schema.utils.ts
 *
 * Pure parser for schema.org Product JSON-LD, so the catalog can carry real
 * prices/brand/specs (not just slug-derived names) for sharper "X vs Y" blogs.
 * Robust to @graph wrappers, arrays of nodes, and offers-as-array. No I/O.
 */

export interface ProductDetails {
  name?: string;
  price?: string;
  currency?: string;
  brand?: string;
  description?: string;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walk a parsed JSON-LD value and return the first node whose @type is Product. */
function findProductNode(parsed: unknown): Record<string, unknown> | null {
  const stack: unknown[] = asArray(parsed);
  let guard = 0;
  while (stack.length > 0 && guard < 5000) {
    guard++;
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    if (node["@graph"]) stack.push(...asArray(node["@graph"]));
    const types = asArray(node["@type"]).map((t) => String(t).toLowerCase());
    if (types.includes("product")) return node;
  }
  return null;
}

export function parseProductSchema(jsonLdText: string): ProductDetails | null {
  if (typeof jsonLdText !== "string" || jsonLdText.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLdText);
  } catch {
    return null;
  }

  const node = findProductNode(parsed);
  if (!node) return null;

  const details: ProductDetails = {};
  if (typeof node.name === "string" && node.name.trim()) {
    details.name = node.name.trim();
  }
  if (typeof node.description === "string" && node.description.trim()) {
    details.description = node.description.trim().slice(0, 300);
  }

  const brand = node.brand;
  if (typeof brand === "string" && brand.trim()) {
    details.brand = brand.trim();
  } else if (isRecord(brand) && typeof brand.name === "string") {
    details.brand = brand.name.trim();
  }

  const offer = asArray(node.offers).find(isRecord);
  if (offer) {
    const price = offer.price ?? offer.lowPrice;
    if (price !== undefined && price !== null && String(price).trim()) {
      details.price = String(price).trim();
    }
    if (typeof offer.priceCurrency === "string") {
      details.currency = offer.priceCurrency.trim();
    }
  }

  return Object.keys(details).length > 0 ? details : null;
}

/** Extract the first Product's details from a page's HTML (all ld+json blocks). */
export function extractProductDetailsFromHtml(html: string): ProductDetails | null {
  if (typeof html !== "string" || html.length === 0) return null;
  const blocks =
    html.match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  for (const block of blocks) {
    const inner = block
      .replace(/<script[^>]*>/i, "")
      .replace(/<\/script>/i, "");
    const details = parseProductSchema(inner);
    if (details) return details;
  }
  return null;
}
