/**
 * ranking-correlation.utils.ts
 *
 * Pure helpers for the data-driven calibration: match a blog's live URL to its
 * Google Search Console rows, extract content features, and correlate those
 * features with real ranking outcomes. No I/O, fully unit-testable.
 *
 * The goal: stop guessing what makes content rank. Learn it from the system's
 * own SearchConsoleMetric data (real position/clicks/impressions per page).
 */

/** Canonicalize a URL for matching: drop protocol, leading www, query/hash, trailing slash; lowercase host. */
export function normalizeUrl(url: string): string {
  if (typeof url !== "string") return "";
  let u = url.trim();
  if (!u) return "";
  u = u.replace(/^[a-z]+:\/\//i, ""); // drop protocol
  u = u.split(/[?#]/)[0] ?? ""; // drop query/hash
  u = u.replace(/^www\./i, ""); // drop leading www
  // lowercase host only (keep path case — some CMSs are case-sensitive)
  const slash = u.indexOf("/");
  if (slash === -1) return u.toLowerCase().replace(/\/+$/, "");
  const host = u.slice(0, slash).toLowerCase();
  let path = u.slice(slash).replace(/\/+$/, "");
  if (path === "") path = "";
  return `${host}${path}`;
}

export function urlsMatch(a: string, b: string): boolean {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  return na.length > 0 && na === nb;
}

/**
 * Candidate absolute forms of a URL, for an indexed `page: { in: [...] }` GSC
 * query (Search Console stores absolute URLs; we don't know which exact form).
 */
export function urlVariants(url: string): string[] {
  const norm = normalizeUrl(url);
  if (!norm) return [];
  const slash = norm.indexOf("/");
  const host = slash === -1 ? norm : norm.slice(0, slash);
  const path = slash === -1 ? "" : norm.slice(slash);
  const hosts = [host, `www.${host}`];
  const paths = path === "" ? ["", "/"] : [path, `${path}/`];
  const out = new Set<string>();
  for (const h of hosts) {
    for (const p of paths) {
      out.add(`https://${h}${p}`);
      out.add(`http://${h}${p}`);
    }
  }
  return [...out];
}

/** Pearson correlation. Returns 0 for n<2 or zero variance. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] ?? 0;
    sy += ys[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  const r = num / Math.sqrt(dx2 * dy2);
  return Math.round(r * 1000) / 1000;
}

/** Convert values to ranks, averaging ties. */
function toRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank for the tie group
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation — robust to outliers, good for position data. */
export function spearman(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  return pearson(toRanks(xs.slice(0, n)), toRanks(ys.slice(0, n)));
}

function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countMatches(html: string, re: RegExp): number {
  const m = html.match(re);
  return m ? m.length : 0;
}

export interface ContentFeatures {
  wordCount: number;
  h2Count: number;
  h3Count: number;
  faqCount: number;
  listItemCount: number;
  externalLinkCount: number;
  internalLinkCount: number;
  imageCount: number;
  paragraphCount: number;
  hasSchema: number; // 0/1
}

/** Structural content features from blog HTML. Pure. */
export function extractContentFeatures(
  content: string,
  businessDomain = "",
): ContentFeatures {
  const html = String(content ?? "");
  const text = stripHtml(html);
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  const anchors = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi) ?? [];
  let externalLinkCount = 0;
  let internalLinkCount = 0;
  const domainNorm = normalizeUrl(businessDomain);
  for (const a of anchors) {
    const href = a.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
    const isHttp = /^https?:\/\//i.test(href);
    if (!isHttp) {
      internalLinkCount++;
      continue;
    }
    const hrefNorm = normalizeUrl(href);
    if (domainNorm && hrefNorm.startsWith(domainNorm.split("/")[0] ?? "\0")) {
      internalLinkCount++;
    } else {
      externalLinkCount++;
    }
  }

  return {
    wordCount,
    h2Count: countMatches(html, /<h2\b/gi),
    h3Count: countMatches(html, /<h3\b/gi),
    faqCount: countMatches(html, /class=["'][^"']*faq-question[^"']*["']/gi),
    listItemCount: countMatches(html, /<li\b/gi),
    externalLinkCount,
    internalLinkCount,
    imageCount: countMatches(html, /<img\b/gi),
    paragraphCount: countMatches(html, /<p\b/gi),
    hasSchema: /application\/ld\+json/i.test(html) ? 1 : 0,
  };
}

export interface FeatureCorrelation {
  feature: string;
  /** Spearman correlation with the outcome. */
  correlation: number;
  /** Sample size used. */
  n: number;
}

export interface CorrelationRow {
  features: Record<string, number>;
  outcome: number;
}

/**
 * Correlate every numeric feature against the outcome across rows. Uses
 * Spearman (rank) correlation. Returns features sorted by |correlation| desc.
 *
 * Interpretation depends on the outcome: for GSC `position` (lower = better),
 * a NEGATIVE correlation means "more of this feature → better rank".
 */
export interface ScoreBucket {
  label: string;
  /** inclusive lower, inclusive upper */
  lo: number;
  hi: number;
}

export interface BucketAverage {
  label: string;
  n: number;
  avgOutcome: number;
}

/**
 * Average outcome per score bucket — e.g. "do blogs scoring 7-8 on expert-voice
 * actually have a better avg GSC position than those scoring 3-4?". Pure.
 */
export function bucketAverages(
  points: { score: number; outcome: number }[],
  buckets: ScoreBucket[],
): BucketAverage[] {
  return buckets.map((b) => {
    const inBucket = points.filter(
      (p) =>
        Number.isFinite(p.score) &&
        Number.isFinite(p.outcome) &&
        p.score >= b.lo &&
        p.score <= b.hi,
    );
    const n = inBucket.length;
    const avgOutcome =
      n === 0
        ? 0
        : Math.round((inBucket.reduce((s, p) => s + p.outcome, 0) / n) * 100) / 100;
    return { label: b.label, n, avgOutcome };
  });
}

export function correlateFeatures(rows: CorrelationRow[]): FeatureCorrelation[] {
  if (rows.length === 0) return [];
  const featureKeys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.features)) featureKeys.add(k);
  }
  const out: FeatureCorrelation[] = [];
  for (const key of featureKeys) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rows) {
      const v = r.features[key];
      if (typeof v === "number" && Number.isFinite(v) && Number.isFinite(r.outcome)) {
        xs.push(v);
        ys.push(r.outcome);
      }
    }
    out.push({ feature: key, correlation: spearman(xs, ys), n: xs.length });
  }
  out.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  return out;
}
