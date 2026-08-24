/**
 * exa-research.service.ts
 *
 * Authoritative research retrieval via Exa (https://exa.ai) for the blog
 * pipeline. Fills the authoritative-evidence channel that the .gov/.edu-only
 * URL filter leaves structurally empty for local-service SERPs: Exa's neural
 * search returns high-quality informational pages (industry guides,
 * encyclopedias, major publishers) whose passages become cited
 * `authoritative_external` claims — the legal fuel for expert-depth content
 * under the closed-world contract.
 *
 * Flag-gated: requires BLOG_EXA_RESEARCH_ENABLED=true and EXA_API_KEY.
 * Best-effort: any failure returns [] and the pipeline continues on
 * first-party evidence alone.
 */

import {
  isAuthoritativeEvidenceUrl,
  isReputableInformationalHost,
  type RetrievedClaimEvidence,
} from "./blog-claim-evidence.service";

const EXA_API_URL = "https://api.exa.ai/search";
const EXA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const exaCache = new Map<
  string,
  { at: number; evidence: RetrievedClaimEvidence[] }
>();

/** Same URL policy the claim ledger enforces — local competitor sites must
 * never become "authority" citations. */
function isCitableExaHost(url: string): boolean {
  return isAuthoritativeEvidenceUrl(url) || isReputableInformationalHost(url);
}

export function isExaResearchEnabled(): boolean {
  return (
    process.env.BLOG_EXA_RESEARCH_ENABLED === "true" &&
    Boolean(process.env.EXA_API_KEY?.trim())
  );
}

/** Strip local intent from a keyword so queries target transferable industry
 * knowledge ("drain cleaning services hamilton" → "drain cleaning services"). */
function informationalTopic(keyword: string, serviceAreas: string[]): string {
  let topic = keyword.toLowerCase();
  for (const area of serviceAreas) {
    const cleaned = area.trim().toLowerCase();
    if (cleaned.length >= 3) {
      topic = topic.replace(new RegExp(`\\b${cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
    }
  }
  return topic.replace(/\s+/g, " ").trim() || keyword;
}

function buildResearchQueries(input: {
  keyword: string;
  services: string[];
  serviceAreas: string[];
  /** Strategist angle / planned topics — richer queries than fixed templates. */
  researchHints?: string[];
}): string[] {
  const topic = informationalTopic(input.keyword, input.serviceAreas);
  const primaryService = input.services[0]?.toLowerCase() ?? topic;
  const hintQueries = (input.researchHints ?? [])
    .map((hint) => hint.replace(/\s+/g, " ").trim())
    .filter((hint) => hint.length >= 12)
    .slice(0, 3)
    .map((hint) => `${hint} — ${topic}`);
  const max =
    Number.parseInt(process.env.BLOG_EXA_MAX_QUERIES ?? "6", 10) || 6;
  const secondaryService = input.services[1]?.toLowerCase();
  return [
    ...hintQueries,
    `${topic} guide how it works what to expect`,
    `how to choose ${topic} costs and comparison factors`,
    `${primaryService} methods techniques explained`,
    `${topic} common mistakes problems warning signs`,
    ...(secondaryService
      ? [`${secondaryService} when needed how often benefits`]
      : []),
    `${topic} questions to ask before hiring booking`,
  ].slice(0, max);
}

interface ExaSearchResult {
  url?: string;
  title?: string;
  text?: string;
  highlights?: string[];
}

/** Search only within citable hosts: open-web results for local-service
 * topics are dominated by competitor business blogs, which the safety policy
 * rejects — an unrestricted query then yields zero usable passages. */
const EXA_INCLUDE_DOMAINS = [
  "en.wikipedia.org",
  "britannica.com",
  "thespruce.com",
  "familyhandyman.com",
  "bobvila.com",
  "thisoldhouse.com",
  "angi.com",
  "houzz.com",
  "forbes.com",
  "consumerreports.org",
  "healthline.com",
  "investopedia.com",
  "epa.gov",
  "energystar.gov",
  "canada.ca",
  "ontario.ca",
];

async function exaSearch(query: string): Promise<ExaSearchResult[]> {
  const response = await fetch(EXA_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.EXA_API_KEY!.trim(),
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 8,
      includeDomains: EXA_INCLUDE_DOMAINS,
      contents: {
        highlights: { numSentences: 3, highlightsPerUrl: 3 },
        text: { maxCharacters: 4_000 },
      },
    }),
    signal: AbortSignal.timeout(
      Number.parseInt(process.env.BLOG_EXA_TIMEOUT_MS ?? "20000", 10) || 20_000,
    ),
  });
  if (!response.ok) {
    throw new Error(`Exa search failed: ${response.status}`);
  }
  const payload = (await response.json()) as { results?: ExaSearchResult[] };
  return payload.results ?? [];
}

function passagesFromResult(result: ExaSearchResult): string[] {
  // Highlights first (Exa's own relevance ranking), then paragraph-mine the
  // full text — a single 4,000-char text blob never passes the 600-char cap,
  // so without splitting, text contributes nothing.
  const textParagraphs = (result.text ?? "")
    .split(/\n+/)
    .map((value) => value.replace(/\s+/g, " ").trim());
  const candidates = [...(result.highlights ?? []), ...textParagraphs];
  const seen = new Set<string>();
  return candidates
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return (
        value.length >= 60 &&
        value.length <= 600 &&
        /[.!?]/.test(value) &&
        // Same nav-menu guard as first-party extraction.
        (value.match(/[a-z][A-Z]/g) ?? []).length < 2 &&
        // Publisher boilerplate is not industry knowledge.
        !/\b(?:we may be compensated|affiliate (?:links?|commission)|links on our website|editorial (?:team|standards)|advertising polic|cookie|newsletter|subscribe)\b/i.test(
          value,
        )
      );
    })
    // 2 per page, not 4: the word-capacity formula counts DISTINCT SOURCE
    // PAGES (185 words each), so spreading passages across more pages funds
    // more article depth than stacking passages on few pages.
    .slice(0, 2);
}

/**
 * Retrieve authoritative research passages for a blog run. Returns
 * `authoritative_external` evidence ready for the claim ledger; the existing
 * ledger/verification machinery handles atomization, sensitive-claim
 * filtering, section assignment, and citation rendering.
 */
/**
 * Crawl the business's OWN website via Exa contents + subpages: parsed article
 * text per page, no nav-menu noise — a far richer first-party ledger than
 * HTML-selector scraping. Passages are scored against the keyword/services the
 * same way the scraper path scores them.
 */
export async function retrieveExaSiteEvidence(input: {
  website: string | null;
  keyword: string;
  services: string[];
  maxPassages?: number;
}): Promise<RetrievedClaimEvidence[]> {
  if (!isExaResearchEnabled() || !input.website) return [];
  const maxPassages =
    input.maxPassages ??
    (Number.parseInt(process.env.BLOG_EXA_SITE_MAX_PASSAGES ?? "16", 10) || 16);
  const cacheKey = JSON.stringify({
    site: input.website,
    keyword: input.keyword.toLowerCase(),
  });
  const cached = exaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXA_CACHE_TTL_MS) {
    return cached.evidence;
  }
  try {
    const response = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.EXA_API_KEY!.trim(),
      },
      body: JSON.stringify({
        urls: [input.website],
        subpages: Number.parseInt(process.env.BLOG_EXA_SUBPAGES ?? "12", 10) || 12,
        subpageTarget: input.services.slice(0, 6),
        text: { maxCharacters: 6_000 },
      }),
      signal: AbortSignal.timeout(
        Number.parseInt(process.env.BLOG_EXA_TIMEOUT_MS ?? "20000", 10) ||
          20_000,
      ),
    });
    if (!response.ok) throw new Error(`Exa contents failed: ${response.status}`);
    const payload = (await response.json()) as {
      results?: Array<
        ExaSearchResult & { subpages?: ExaSearchResult[] }
      >;
    };
    const pages = (payload.results ?? []).flatMap((result) => [
      result,
      ...(result.subpages ?? []),
    ]);
    const serviceTokens = input.services
      .map((service) => service.toLowerCase())
      .filter((service) => service.length >= 4);
    const keywordTokens = input.keyword
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
    const evidence: RetrievedClaimEvidence[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      if (!page.url || !page.text) continue;
      const paragraphs = page.text
        .split(/\n{1,}/)
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(
          (value) =>
            value.length >= 60 &&
            value.length <= 600 &&
            /[.!?]/.test(value) &&
            (value.match(/[a-z][A-Z]/g) ?? []).length < 2,
        );
      const scored = paragraphs
        .map((excerpt) => {
          const lower = excerpt.toLowerCase();
          const score =
            keywordTokens.filter((token) => lower.includes(token)).length * 4 +
            serviceTokens.filter((service) => lower.includes(service)).length *
              5;
          return { excerpt, score };
        })
        .filter((candidate) => candidate.score >= 4)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);
      for (const candidate of scored) {
        const key = candidate.excerpt.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({
          url: page.url,
          title: page.title ?? null,
          excerpt: candidate.excerpt,
          retrievedAt: new Date().toISOString(),
          authority: "owned_website",
          relevanceScore: candidate.score,
        });
        if (evidence.length >= maxPassages) break;
      }
      if (evidence.length >= maxPassages) break;
    }
    console.log(
      `📡 Exa site crawl: ${evidence.length} first-party passage(s) from ${new Set(evidence.map((item) => item.url)).size} page(s)`,
    );
    exaCache.set(cacheKey, { at: Date.now(), evidence });
    return evidence;
  } catch (err) {
    console.warn(
      `📡 Exa site crawl failed (continuing with scraper evidence): ${(err as Error).message.slice(0, 80)}`,
    );
    return [];
  }
}

export async function retrieveExaResearchEvidence(input: {
  keyword: string;
  services: string[];
  serviceAreas: string[];
  businessWebsite?: string | null;
  researchHints?: string[];
  maxPassages?: number;
}): Promise<RetrievedClaimEvidence[]> {
  if (!isExaResearchEnabled()) return [];
  const maxPassages =
    input.maxPassages ??
    (Number.parseInt(process.env.BLOG_EXA_MAX_PASSAGES ?? "32", 10) || 32);
  const queries = buildResearchQueries({
    keyword: input.keyword,
    services: input.services,
    serviceAreas: input.serviceAreas,
    researchHints: input.researchHints,
  });
  const cacheKey = JSON.stringify({ queries });
  const cached = exaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXA_CACHE_TTL_MS) {
    return cached.evidence;
  }

  let businessHost: string | null = null;
  try {
    businessHost = input.businessWebsite
      ? new URL(input.businessWebsite).hostname.replace(/^www\./, "")
      : null;
  } catch {
    businessHost = null;
  }

  const settled = await Promise.allSettled(queries.map(exaSearch));
  const evidence: RetrievedClaimEvidence[] = [];
  const seenExcerpts = new Set<string>();
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      console.warn(
        `📡 Exa query failed (continuing without it): ${(outcome.reason as Error)?.message?.slice(0, 80)}`,
      );
      continue;
    }
    for (const result of outcome.value) {
      if (!result.url) continue;
      if (!isCitableExaHost(result.url)) continue;
      if (businessHost && result.url.includes(businessHost)) continue;
      for (const excerpt of passagesFromResult(result)) {
        const key = excerpt.toLowerCase();
        if (seenExcerpts.has(key)) continue;
        seenExcerpts.add(key);
        evidence.push({
          url: result.url,
          title: result.title ?? null,
          excerpt,
          retrievedAt: new Date().toISOString(),
          authority: "authoritative_external",
        });
        if (evidence.length >= maxPassages) break;
      }
      if (evidence.length >= maxPassages) break;
    }
    if (evidence.length >= maxPassages) break;
  }

  console.log(
    `📡 Exa research: ${evidence.length} authoritative passage(s) from ${new Set(evidence.map((item) => item.url)).size} source(s)`,
  );
  exaCache.set(cacheKey, { at: Date.now(), evidence });
  return evidence;
}
