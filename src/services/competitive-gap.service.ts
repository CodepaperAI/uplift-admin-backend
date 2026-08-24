import { load } from "cheerio";
import { prisma } from "../config/db.config";
import { createGPT5MiniModel } from "../config/llm.config";
import { LlmProvider } from "@prisma/client";

/**
 * Competitive Content Gap Analyzer
 * ----------------------------------------------------------------------------
 * After a citation scan finishes, this service:
 *   1. Collects the top competitor URLs cited for each keyword (across
 *      providers).
 *   2. Fetches each page and extracts the heading outline + FAQ signals
 *      via Cheerio.
 *   3. Compares against the business's own existing content for the same
 *      keyword (by meta.focus_keyword) and emits structured "gap topics".
 *   4. Asks GPT-5 mini to classify which outline headings are actual content
 *      angles we're missing (vs. generic section titles like "Overview").
 *   5. Persists a CompetitiveGap row per (keyword, competitorUrl).
 *
 * Cost controls:
 *   - MAX_GAPS_PER_SCAN caps total fetches per scan.
 *   - A URL is skipped if it was already analyzed in the last 14 days.
 */

const FETCH_TIMEOUT_MS = 12_000;
const MAX_GAPS_PER_SCAN = 20;
const MAX_COMPETITORS_PER_KEYWORD = 3;
const RECENT_ANALYSIS_WINDOW_DAYS = 14;

type ProviderTag = LlmProvider;

type OutlineItem = {
  level: "H1" | "H2" | "H3";
  text: string;
  hasFaq: boolean;
};

type GapTopic = {
  topic: string;
  citedByProviders: ProviderTag[];
};

type CompetitorCandidate = {
  url: string;
  domain: string;
  keyword: string;
  providers: Set<ProviderTag>;
};

/**
 * Entry point called from the Inngest `ai-visibility/analyze-gaps` handler.
 */
export async function analyzeGapsForScan(scanId: string): Promise<{
  analyzed: number;
  skipped: number;
  gapsStored: number;
}> {
  const scan = await prisma.llmCitationScan.findUnique({
    where: { id: scanId },
    select: { id: true, businessId: true },
  });
  if (!scan) {
    console.warn(`[competitive-gap] scan ${scanId} not found, skipping`);
    return { analyzed: 0, skipped: 0, gapsStored: 0 };
  }

  // Pull all citation rows for this scan — per-keyword we need to know
  // which competitor URLs appeared and how often.
  const citations = await prisma.llmCitation.findMany({
    where: { scanId },
    select: {
      keyword: true,
      llmProvider: true,
      competitorsCited: true,
    },
  });

  const candidates = rankCandidates(citations).slice(0, MAX_GAPS_PER_SCAN);
  if (candidates.length === 0) {
    return { analyzed: 0, skipped: 0, gapsStored: 0 };
  }

  // Dedupe against recent analyses so we don't re-fetch the same URL
  // every scan. Keyed by URL + businessId.
  const cutoff = new Date(
    Date.now() - RECENT_ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const recent = await prisma.competitiveGap.findMany({
    where: {
      businessId: scan.businessId,
      competitorUrl: { in: candidates.map((c) => c.url) },
      detectedAt: { gte: cutoff },
    },
    select: { competitorUrl: true },
  });
  const recentSet = new Set(recent.map((r) => r.competitorUrl));

  // Pre-fetch the business's own content per keyword (just titles + outlines)
  // so we can diff later without re-reading rows inside the loop.
  const ownContentByKeyword = await buildOwnOutlineIndex(
    scan.businessId,
    Array.from(new Set(candidates.map((c) => c.keyword))),
  );

  let analyzed = 0;
  let skipped = 0;
  let gapsStored = 0;

  for (const cand of candidates) {
    if (recentSet.has(cand.url)) {
      skipped++;
      continue;
    }
    try {
      const html = await fetchPageHtml(cand.url);
      if (!html) {
        skipped++;
        continue;
      }
      const outline = extractOutline(html);
      const ownOutline = ownContentByKeyword.get(cand.keyword.toLowerCase()) ?? [];

      const candidateGapTitles = diffOutlines(outline, ownOutline);
      if (candidateGapTitles.length === 0) {
        analyzed++;
        continue;
      }
      const chosen = await classifyMeaningfulGaps(
        cand.keyword,
        candidateGapTitles,
      );

      const providers = Array.from(cand.providers);
      const gapTopics: GapTopic[] = chosen.map((topic) => ({
        topic,
        citedByProviders: providers,
      }));

      if (gapTopics.length === 0) {
        analyzed++;
        continue;
      }

      await prisma.competitiveGap.create({
        data: {
          businessId: scan.businessId,
          keyword: cand.keyword,
          competitorUrl: cand.url,
          competitorDomain: cand.domain,
          outline: outline as unknown as object,
          gapTopics: gapTopics as unknown as object,
        },
      });
      analyzed++;
      gapsStored++;
    } catch (err) {
      console.error(
        `[competitive-gap] analysis failed for ${cand.url}:`,
        (err as Error).message,
      );
      skipped++;
    }
  }

  return { analyzed, skipped, gapsStored };
}

// ---- Candidate ranking -----

function rankCandidates(
  citations: {
    keyword: string;
    llmProvider: ProviderTag;
    competitorsCited: unknown;
  }[],
): CompetitorCandidate[] {
  // Aggregate: (keyword, domain) -> { providers, urls }
  const map = new Map<
    string,
    {
      keyword: string;
      domain: string;
      providers: Set<ProviderTag>;
      urls: Map<string, number>;
    }
  >();

  for (const row of citations) {
    const comps = (row.competitorsCited as any[]) || [];
    for (const comp of comps) {
      const domain = (comp?.domain as string | undefined)?.toLowerCase();
      const url = comp?.url as string | undefined;
      if (!domain || !url) continue;
      const key = `${row.keyword}::${domain}`;
      const entry =
        map.get(key) ?? {
          keyword: row.keyword,
          domain,
          providers: new Set<ProviderTag>(),
          urls: new Map<string, number>(),
        };
      entry.providers.add(row.llmProvider);
      entry.urls.set(url, (entry.urls.get(url) ?? 0) + 1);
      map.set(key, entry);
    }
  }

  // Flatten per keyword+domain → top URL per entry. Then take up to
  // MAX_COMPETITORS_PER_KEYWORD per keyword.
  const perKeyword = new Map<string, CompetitorCandidate[]>();
  for (const entry of map.values()) {
    const [topUrl] = [...entry.urls.entries()].sort(([, a], [, b]) => b - a);
    if (!topUrl) continue;
    const cand: CompetitorCandidate = {
      url: topUrl[0],
      domain: entry.domain,
      keyword: entry.keyword,
      providers: entry.providers,
    };
    const arr = perKeyword.get(entry.keyword) ?? [];
    arr.push(cand);
    perKeyword.set(entry.keyword, arr);
  }

  const out: CompetitorCandidate[] = [];
  for (const arr of perKeyword.values()) {
    arr
      .sort((a, b) => b.providers.size - a.providers.size)
      .slice(0, MAX_COMPETITORS_PER_KEYWORD)
      .forEach((c) => out.push(c));
  }
  return out;
}

// ---- HTML fetch + outline extraction -----

async function fetchPageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; UpliftAI-GapAnalyzer/1.0; +https://upliftai.com/bot)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("html")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractOutline(html: string): OutlineItem[] {
  const $ = load(html);
  const outline: OutlineItem[] = [];
  $("h1, h2, h3").each((_, el) => {
    const tag = (el as any).tagName as string | undefined;
    const level: OutlineItem["level"] =
      tag === "h1" ? "H1" : tag === "h2" ? "H2" : "H3";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length < 3) return;

    // "hasFaq" heuristic: the heading itself looks like a question OR the
    // immediate next sibling contains a <details>/<dl>/FAQ marker. This
    // isn't perfect but it's directionally useful for gap diffing.
    const nextHtml = ($(el).nextUntil("h1, h2, h3").toString() || "").slice(
      0,
      1200,
    );
    const hasFaq =
      /\?$/.test(text) ||
      /faq/i.test(text) ||
      /<details|<dl |data-faq|itemscope[^>]*faq/i.test(nextHtml);

    outline.push({ level, text, hasFaq });
  });
  return outline;
}

// ---- Own-content indexing -----

async function buildOwnOutlineIndex(
  businessId: string,
  keywords: string[],
): Promise<Map<string, OutlineItem[]>> {
  if (keywords.length === 0) return new Map();

  // Lowercase match so "Plumbing" and "plumbing" collide.
  const lowered = keywords.map((k) => k.toLowerCase());
  const blogs = await prisma.blog.findMany({
    where: {
      businessId,
      meta: { is: { focus_keyword: { mode: "insensitive", in: lowered } } },
    },
    select: {
      content: true,
      meta: { select: { focus_keyword: true } },
    },
    take: 200,
  });

  const index = new Map<string, OutlineItem[]>();
  for (const b of blogs) {
    const kw = b.meta?.focus_keyword?.toLowerCase();
    if (!kw) continue;
    const outline = extractOutline(b.content);
    if (!index.has(kw)) index.set(kw, outline);
  }
  return index;
}

// ---- Outline diff -----

/**
 * Return competitor headings that don't look covered by our own outline.
 * "Covered" is a loose match: normalized token overlap ≥ 0.6 with any of
 * our own headings.
 */
function diffOutlines(
  theirs: OutlineItem[],
  ours: OutlineItem[],
): string[] {
  // Only consider H2/H3 — H1 is usually the title.
  const theirHeadings = theirs
    .filter((o) => o.level === "H2" || o.level === "H3")
    .map((o) => o.text);
  const ourTokens = ours
    .filter((o) => o.level === "H2" || o.level === "H3")
    .map((o) => tokenize(o.text));

  const gaps: string[] = [];
  for (const h of theirHeadings) {
    const theirTokens = tokenize(h);
    if (theirTokens.length === 0) continue;
    let covered = false;
    for (const ot of ourTokens) {
      if (overlapFrac(theirTokens, ot) >= 0.6) {
        covered = true;
        break;
      }
    }
    if (!covered) gaps.push(h);
  }
  // Cap before sending to the LLM — outline diffs can be noisy.
  return gaps.slice(0, 15);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function overlapFrac(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const w of a) if (setB.has(w)) hit++;
  return hit / Math.max(a.length, b.length);
}

// ---- LLM classification of "real" gaps -----

async function classifyMeaningfulGaps(
  keyword: string,
  candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const model = createGPT5MiniModel();
  const prompt = `You are reviewing a list of section headings scraped from a competitor's article about "${keyword}".

Return ONLY a JSON array of strings: the headings that represent substantive, quotable content angles (e.g. specific tactics, comparisons, step-by-step guides, named tools, statistics, regulatory notes, pricing tiers).

EXCLUDE generic navigation / boilerplate headings like:
- "Introduction", "Overview", "Conclusion", "Summary", "Related posts", "About the author"
- "What is X?" if it's the only context (too basic)
- "Share this post", "Comments", "Newsletter signup"

Headings:
${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Output strictly as a JSON array of strings. No prose.`;

  try {
    const response = await model.invoke([
      {
        role: "system",
        content:
          "You filter noise from content outlines. Return JSON only — no prose.",
      },
      { role: "user", content: prompt },
    ]);
    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return candidates.slice(0, 5);
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return candidates.slice(0, 5);
    return parsed
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 3)
      .slice(0, 10);
  } catch (err) {
    console.warn(
      `[competitive-gap] classify fallback (keeping all): ${(err as Error).message}`,
    );
    return candidates.slice(0, 5);
  }
}

// ---- Dashboard data queries -----

export async function getCompetitiveGaps(businessId: string) {
  const gaps = await prisma.competitiveGap.findMany({
    where: { businessId, resolvedAt: null },
    orderBy: { detectedAt: "desc" },
    take: 100,
  });
  return gaps.map((g) => ({
    id: g.id,
    keyword: g.keyword,
    competitorUrl: g.competitorUrl,
    competitorDomain: g.competitorDomain,
    outline: (g.outline as unknown as OutlineItem[]) ?? [],
    gapTopics: (g.gapTopics as unknown as GapTopic[]) ?? [],
    detectedAt: g.detectedAt.toISOString(),
  }));
}

export async function markGapResolved(
  gapId: string,
  businessId: string,
  blogId?: string,
) {
  await prisma.competitiveGap.updateMany({
    where: { id: gapId, businessId },
    data: {
      resolvedAt: new Date(),
      ...(blogId ? { resolvedByBlogId: blogId } : {}),
    },
  });
}
