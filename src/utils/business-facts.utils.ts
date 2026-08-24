/**
 * business-facts.utils.ts
 *
 * Pure extractors for the concrete facts that are NOT stored in our DB but ARE
 * stated on a business's own website — price-from, price range, group size /
 * capacity, lead time, founding year, dietary/options. These unlock the
 * high-ranking modules (At-a-Glance table, pricing Quick Answer, "since YYYY"
 * E-E-A-T) that we otherwise could not fill without fabricating.
 *
 * Business-type-agnostic: the same extractors work for a caterer ("$18/person",
 * "groups of 10–500"), a SaaS ("from $29/mo", "founded 2018"), or a clinic — and
 * simply return nothing for fields a given site doesn't mention. Nothing here is
 * invented: every field is a verbatim/normalised lift from the page text or its
 * structured data, or it is omitted.
 *
 * Total + dependency-light (regex + the existing product-schema parser). No I/O.
 */

import { parseProductSchema } from "./product-schema.utils";

export interface BusinessFacts {
  /** Verbatim "from $X" / "$X per person" style price entry point. */
  priceFrom?: string;
  /** Verbatim price range, e.g. "$15–$40 per person". */
  priceRange?: string;
  /** Group size / capacity phrase, e.g. "10–500 guests", "up to 200 seats". */
  groupSize?: string;
  /** Lead time / notice phrase, e.g. "48 hours notice", "2 weeks in advance". */
  leadTime?: string;
  /** Four-digit founding year, e.g. 2019. */
  foundingYear?: number;
  /** Recognised dietary / option tokens, e.g. ["halal","vegan","gluten-free"]. */
  dietaryOptions?: string[];
}

function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "since 2019" / "established 2010" / "founded in 1998" / "est. 2005". 4-digit, plausible. */
export function extractFoundingYear(text: string): number | undefined {
  const t = String(text ?? "");
  const re =
    /\b(?:since|established|founded(?:\s+in)?|est\.?|serving\s+\w+\s+since|in\s+business\s+since)\s+(19\d{2}|20\d{2})\b/gi;
  let m: RegExpExecArray | null;
  let best: number | undefined;
  while ((m = re.exec(t)) !== null) {
    const year = Number(m[1]);
    // Plausible founding year window; prefer the earliest stated (oldest = real founding).
    if (year >= 1900 && year <= 2099 && (best === undefined || year < best)) {
      best = year;
    }
  }
  return best;
}

/** "from $18", "starting at $29/mo", "$18 per person", "$18/person". */
export function extractPriceFrom(text: string): string | undefined {
  const t = String(text ?? "");
  const patterns = [
    /\b(?:from|starting\s+at|starts\s+at|as\s+low\s+as)\s+\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per)\s?[a-z]+)?/i,
    /\$\s?\d[\d,]*(?:\.\d{2})?\s?(?:\/|per)\s?(?:person|head|guest|month|mo|user|seat|hour|hr)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return clean(m[0]);
  }
  return undefined;
}

/** "$15–$40", "$15 to $40 per person". */
export function extractPriceRange(text: string): string | undefined {
  const t = String(text ?? "");
  const m = t.match(
    /\$\s?\d[\d,]*(?:\.\d{2})?\s?(?:-|–|—|to)\s?\$?\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per)\s?[a-z]+)?/i,
  );
  return m ? clean(m[0]) : undefined;
}

/** "groups of 10–500", "10 to 500 guests", "up to 200 guests/people/seats". */
export function extractGroupSize(text: string): string | undefined {
  const t = String(text ?? "");
  const patterns = [
    /\b(?:groups?\s+of|serving|serves|seats?|accommodate[s]?)\s+\d[\d,]*\s*(?:-|–|—|to)\s*\d[\d,]*\s*(?:guests|people|persons|seats|pax)?/i,
    /\b\d[\d,]*\s*(?:-|–|—|to)\s*\d[\d,]*\s+(?:guests|people|persons|seats|attendees|pax)\b/i,
    /\bup\s+to\s+\d[\d,]*\s+(?:guests|people|persons|seats|attendees|pax)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return clean(m[0]);
  }
  return undefined;
}

/** "48 hours notice", "2 weeks in advance", "3 days lead time", "book 24h ahead". */
export function extractLeadTime(text: string): string | undefined {
  const t = String(text ?? "");
  const patterns = [
    /\b\d{1,3}\s*(?:hours?|hrs?|days?|weeks?)\s+(?:notice|in\s+advance|ahead|lead\s*time)\b/i,
    /\b(?:notice|advance|lead\s*time)\s+of\s+\d{1,3}\s*(?:hours?|hrs?|days?|weeks?)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return clean(m[0]);
  }
  return undefined;
}

const DIETARY_TOKENS = [
  "halal",
  "kosher",
  "vegan",
  "vegetarian",
  "gluten-free",
  "gluten free",
  "dairy-free",
  "dairy free",
  "nut-free",
  "nut free",
  "organic",
  "keto",
  "paleo",
];

/** Recognised dietary/option tokens actually mentioned on the page. */
export function extractDietaryOptions(text: string): string[] | undefined {
  const t = String(text ?? "").toLowerCase();
  const found = new Set<string>();
  for (const token of DIETARY_TOKENS) {
    if (new RegExp(`\\b${token.replace(/[-/]/g, "[-\\s]?")}\\b`, "i").test(t)) {
      // normalise "gluten free" → "gluten-free"
      found.add(token.replace(/\s/g, "-"));
    }
  }
  return found.size > 0 ? Array.from(found) : undefined;
}

/** Founding year from ld+json (Organization.foundingDate). */
function foundingYearFromJsonLd(html: string): number | undefined {
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return undefined;
  for (const block of blocks) {
    const m = block.match(/"foundingDate"\s*:\s*"(\d{4})/);
    if (m) {
      const y = Number(m[1]);
      if (y >= 1900 && y <= 2099) return y;
    }
  }
  return undefined;
}

/** Merge a into b, preferring already-present (earlier-source) values. */
export function mergeFacts(a: BusinessFacts, b: BusinessFacts): BusinessFacts {
  const out: BusinessFacts = { ...a };
  for (const k of Object.keys(b) as (keyof BusinessFacts)[]) {
    if (out[k] === undefined || (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0)) {
      // @ts-expect-error indexed assignment across the union is safe here
      out[k] = b[k];
    }
  }
  return out;
}

/** Run every extractor over one page's HTML; returns only the fields found. */
export function parseFactsFromHtml(html: string): BusinessFacts {
  const raw = String(html ?? "");
  const text = stripHtml(raw);
  const facts: BusinessFacts = {};

  const founding = extractFoundingYear(text) ?? foundingYearFromJsonLd(raw);
  if (founding) facts.foundingYear = founding;

  const priceFrom = extractPriceFrom(text);
  if (priceFrom) facts.priceFrom = priceFrom;
  else {
    // ld+json Offer price as a fallback "from $X".
    const details = parseProductSchema(raw);
    if (details?.price) {
      facts.priceFrom = `${details.currency ? `${details.currency} ` : "$"}${details.price}`;
    }
  }

  const priceRange = extractPriceRange(text);
  if (priceRange) facts.priceRange = priceRange;

  const groupSize = extractGroupSize(text);
  if (groupSize) facts.groupSize = groupSize;

  const leadTime = extractLeadTime(text);
  if (leadTime) facts.leadTime = leadTime;

  const dietary = extractDietaryOptions(text);
  if (dietary) facts.dietaryOptions = dietary;

  return facts;
}

export function hasAnyFact(facts: BusinessFacts | null | undefined): boolean {
  if (!facts) return false;
  return Object.values(facts).some(
    (v) => v !== undefined && (!Array.isArray(v) || v.length > 0),
  );
}

/** Render the real, scraped facts for the generation prompt (use-these-only). */
export function buildBusinessFactsPromptBlock(facts: BusinessFacts | null | undefined): string {
  if (!hasAnyFact(facts)) {
    return [
      "REAL BUSINESS FACTS: none could be verified from the website.",
      "- Do NOT state a price, group size, lead time, or founding year. Make qualitative points instead.",
    ].join("\n");
  }
  const f = facts as BusinessFacts;
  const rows: string[] = [];
  if (f.priceFrom) rows.push(`  - Price from: ${f.priceFrom}`);
  if (f.priceRange) rows.push(`  - Price range: ${f.priceRange}`);
  if (f.groupSize) rows.push(`  - Group size / capacity: ${f.groupSize}`);
  if (f.leadTime) rows.push(`  - Lead time: ${f.leadTime}`);
  if (f.foundingYear) rows.push(`  - In business since: ${f.foundingYear}`);
  if (f.dietaryOptions?.length) rows.push(`  - Options: ${f.dietaryOptions.join(", ")}`);
  return [
    "REAL BUSINESS FACTS (verified from this business's own website — use these EXACT values where relevant; do NOT alter or invent others):",
    rows.join("\n"),
  ].join("\n");
}
