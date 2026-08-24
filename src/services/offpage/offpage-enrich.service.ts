/**
 * offpage-enrich.service.ts
 *
 * Live enrichment of validated opportunities (the I/O layer):
 *  - Reddit: replace the subreddit-page link with a REAL thread permalink to
 *    contribute to (old.reddit via ScraperAPI).
 *  - Directory: drop unreachable directories, and detect when the business is
 *    ALREADY listed (→ "Already listed" + existing link instead of "create one").
 *
 * Expensive (ScraperAPI renders + Google lookups), so it runs only on the
 * validated survivors, is bounded by per-lever caps + bounded concurrency, and
 * fails soft per item (an item that errors keeps its un-enriched form). The
 * result is cached, so this cost is paid once per business.
 */

import {
  checkUrlReachable,
  findDirectoryListingCandidates,
  findDirectorySubmissionLinks,
} from "../../utils/directory-verifier";
import { verifyExistingListingLLM } from "../../llm/offpage/directory-listing-verifier.llm";
import {
  findRedditThreads,
  verifyRedditThreadDetails,
} from "../../utils/reddit-thread-finder";
import { generateThreadReplies } from "../../llm/offpage/reddit-reply-drafter.llm";
import {
  applyDirectoryOpportunityQuality,
  applyRedditOpportunityQuality,
  getDirectorySubmissionTarget,
  rankRedditThreads,
} from "./offpage-quality.service";
import type {
  BusinessResearchBrief,
  OffPageResearchStrategy,
  Opportunity,
} from "./offpage-types";

const REDDIT_ENRICH_LIMIT = 10;
const THREADS_PER_SUBREDDIT = 6;
const DIRECTORY_ALREADY_LISTED_LIMIT = 10;
const CONCURRENCY = 5;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function extractSubreddit(o: Opportunity): string {
  const fromUrl = (o.url ?? "").match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i);
  if (fromUrl) return fromUrl[1] ?? "";
  const fromTitle = o.title.match(/r\/([A-Za-z0-9_]+)/i);
  return fromTitle ? (fromTitle[1] ?? "") : "";
}

/** Generic words that describe intent/quality, not the business TOPIC. */
const TOPIC_STOPWORDS = new Set([
  "best", "top", "near", "good", "great", "local", "online", "store", "shop",
  "services", "service", "company", "business", "your", "with", "from",
]);

/**
 * Build the thread-search context: a `query` to search the subreddit with, and
 * `coreTerms` (the business's distinctive TOPIC words, with location words
 * stripped) used to relevance-filter results. Stripping location words matters:
 * for a Toronto restaurant we want to match "shawarma", not "toronto" (which a
 * Toronto subreddit thread trivially contains).
 */
function getThreadSearchContext(brief: BusinessResearchBrief): {
  query: string;
  coreTerms: string[];
} {
  const locationWords = new Set(
    [
      brief.location.city,
      brief.location.country,
      ...brief.location.serviceAreaLocations,
      ...brief.location.neighborhoods,
    ]
      .filter((s): s is string => Boolean(s))
      .flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean),
  );

  const raw = [
    ...brief.keywords.slice(0, 3),
    ...brief.services.slice(0, 3),
    brief.category ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const coreTerms: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 4) continue;
    if (locationWords.has(token) || TOPIC_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    coreTerms.push(token);
    if (coreTerms.length >= 6) break;
  }

  const query =
    coreTerms[0] ?? (brief.category ?? brief.businessName ?? "").toLowerCase();
  return { query, coreTerms };
}

function getPlannedThreadSearchContext(
  brief: BusinessResearchBrief,
  strategy?: OffPageResearchStrategy,
): {
  query: string;
  coreTerms: string[];
} {
  const fallback = getThreadSearchContext(brief);
  if (!strategy?.reddit.enabled) return fallback;

  const query = strategy.reddit.threadSearchQueries.find((q) => q.trim()) ?? fallback.query;
  const coreTerms = strategy.reddit.coreTerms
    .map((term) => term.toLowerCase().trim())
    .filter((term) => term.length >= 3);

  return {
    query,
    coreTerms: coreTerms.length ? coreTerms : fallback.coreTerms,
  };
}

/** Country/region names that, if in a thread title, signal a DIFFERENT market. */
const FOREIGN_LOCATION_TOKENS = new Set([
  "finland", "sweden", "norway", "denmark", "iceland", "germany", "france",
  "spain", "italy", "portugal", "netherlands", "belgium", "switzerland",
  "austria", "poland", "ireland", "scotland", "england", "wales", "britain",
  "russia", "ukraine", "greece", "turkey", "india", "pakistan", "bangladesh",
  "china", "japan", "korea", "thailand", "vietnam", "indonesia", "philippines",
  "malaysia", "singapore", "australia", "brazil", "argentina", "chile",
  "mexico", "egypt", "nigeria", "kenya", "dubai", "uae", "saudi", "qatar",
]);

/** True if the title names a country/region that isn't the business's own market. */
export function titleIsForeignMarket(
  title: string,
  brief: Pick<BusinessResearchBrief, "location">,
): boolean {
  const home = `${brief.location.country ?? ""} ${brief.location.city ?? ""} ${brief.location.serviceAreaLocations.join(" ")}`.toLowerCase();
  for (const tok of title.toLowerCase().split(/[^a-z]+/)) {
    if (tok && FOREIGN_LOCATION_TOKENS.has(tok) && !home.includes(tok)) return true;
  }
  return false;
}

/**
 * Live-verify a subreddit by finding a REAL, on-topic, on-location thread in it.
 * Returns null (DROP the suggestion) when we can't — the subreddit is likely
 * non-existent (the LLM invents plausible names like r/NewDrivers), private, or
 * has nothing relevant. We only ever show subreddits we've grounded in a real
 * thread, never a bare LLM-guessed subreddit link that 404s.
 */
async function enrichReddit(
  o: Opportunity,
  ctx: { query: string; coreTerms: string[] },
  brief: BusinessResearchBrief,
): Promise<Opportunity | null> {
  const sub = extractSubreddit(o);
  if (!sub || !ctx.query) return null;

  // findRedditThreads handles its own errors (old.reddit → google fallback → []).
  const found = await findRedditThreads(
    sub,
    ctx.query,
    ctx.coreTerms,
    THREADS_PER_SUBREDDIT,
  );
  // Drop threads clearly about a different country (e.g. a Finland post for a
  // Montréal business that only matched on the word "driving").
  const onTopic = found.filter((t) => !titleIsForeignMarket(t.title, brief));
  const detailChecked = await verifyRedditThreadDetails(onTopic);
  const ranked = rankRedditThreads(detailChecked);
  if (ranked.length === 0) return null; // unverified / low-quality subreddit → drop

  // Verified: real threads found. Draft replies, but keep the (grounded) threads
  // even if drafting fails.
  let threads = ranked;
  try {
    threads = await generateThreadReplies(brief, sub, ranked);
  } catch {
    // keep the real threads without per-thread drafts
  }
  const top = threads[0];
  if (!top?.url || !top.title) return null;
  return applyRedditOpportunityQuality({
    ...o,
    url: top.url,
    threadTitle: top.title,
    threads, // ranked list w/ per-thread reply drafts — UI shows several
    grounded: true, // real, on-topic threads found via live search
    title: `Reply in r/${sub}: "${truncate(top.title, 70)}"`,
  });
}

/**
 * Already-listed detection: Google `site:` finds candidate pages on the
 * directory, then an AI verifier confirms one is genuinely THIS business's
 * profile (same name + city) before we claim it — no blind "first result wins",
 * which used to surface wrong businesses, sitemaps, and unrelated pages. Only
 * calls the LLM when there are real candidates (so businesses NOT on a directory
 * cost nothing). Fails soft → keeps the "create a listing" suggestion.
 */
async function detectAlreadyListed(
  o: Opportunity,
  brief: BusinessResearchBrief,
): Promise<Opportunity> {
  const url = o.url ?? "";
  if (!url) return o;
  try {
    const candidates = await findDirectoryListingCandidates(
      url,
      brief.businessName,
      brief.location.city ?? null,
    );
    if (candidates.length === 0) return o; // nothing to verify → not listed

    const directoryName = o.title.replace(/^List\s+.*?\s+on\s+/i, "").trim();
    const verdict = await verifyExistingListingLLM(
      {
        businessName: brief.businessName,
        city: brief.location.city ?? null,
        address: brief.location.formattedAddress ?? null,
        category: brief.category ?? null,
        businessId: brief.businessId || null,
      },
      directoryName,
      candidates,
    );

    if (verdict.listed && verdict.url) {
      return applyDirectoryOpportunityQuality({
        ...o,
        alreadyListed: true,
        url: verdict.url,
        title: `Already listed${directoryName ? ` on ${directoryName}` : ""}`,
        action:
          "Your business already appears here. Review the listing and keep name, address and phone (NAP) consistent with your other listings.",
      }, brief);
    }
  } catch {
    // keep the un-enriched directory suggestion on failure
  }
  return o;
}

/** Live-enrich validated opportunities; returns a re-ranked candidate queue. */
export async function enrichOpportunities(
  opportunities: Opportunity[],
  brief: BusinessResearchBrief,
  strategy?: OffPageResearchStrategy,
): Promise<Opportunity[]> {
  const reddit = opportunities.filter((o) => o.leverKey === "reddit");
  const directory = opportunities.filter((o) => o.leverKey === "directory");
  const other = opportunities.filter(
    (o) => o.leverKey !== "reddit" && o.leverKey !== "directory",
  );

  const threadCtx = getPlannedThreadSearchContext(brief, strategy);

  // Reddit: keep ONLY subreddits we verify by finding a real, on-topic thread
  // (enrichReddit returns null for non-existent/empty/off-location ones). The
  // un-enriched tail beyond the limit is also dropped — never show an unverified,
  // possibly-hallucinated subreddit link.
  const enrichedReddit = (
    await mapLimit(reddit.slice(0, REDDIT_ENRICH_LIMIT), CONCURRENCY, (o) =>
      enrichReddit(o, threadCtx, brief),
    )
  ).filter((o): o is Opportunity => o !== null);

  // Directory: reachability on EVERY directory (cheap GET) → drop confirmed-dead
  // (this is what catches the 404s the LLM occasionally invents); then run the
  // expensive already-listed detection only on the top survivors.
  const checkedAt = new Date();
  const reachable = (
    await mapLimit(directory, CONCURRENCY, async (o) => {
      const target = getDirectorySubmissionTarget(o.url ?? "");
      const urlToCheck = target.submissionUrl || o.url || "";
      if (!(await checkUrlReachable(urlToCheck))) return null;
      let enriched = { ...o, grounded: true } as Opportunity;
      if (target.submissionUrlType === "homepage" || target.submissionUrlType === "unknown") {
        const [submissionLink] = await findDirectorySubmissionLinks(o.url ?? "");
        if (submissionLink && (await checkUrlReachable(submissionLink.url))) {
          enriched = {
            ...enriched,
            submissionUrl: submissionLink.url,
            submissionUrlType: submissionLink.submissionUrlType,
            pricingModel: submissionLink.pricingModel,
            qualitySignals: [
              ...(enriched.qualitySignals ?? []),
              `Discovered "${submissionLink.text || "submission"}" link on directory`,
            ],
          };
        }
      }
      return applyDirectoryOpportunityQuality(
        enriched,
        brief,
        checkedAt,
      );
    })
  ).filter((o): o is Opportunity => o !== null);

  const enrichedDirectory = await mapLimit(
    reachable.slice(0, DIRECTORY_ALREADY_LISTED_LIMIT),
    CONCURRENCY,
    (o) => detectAlreadyListed(o, brief),
  );

  const merged: Opportunity[] = [
    ...enrichedReddit, // only verified subreddits (the un-enriched tail is dropped)
    ...enrichedDirectory,
    ...reachable.slice(DIRECTORY_ALREADY_LISTED_LIMIT),
    ...other,
  ];

  return merged
    .map((o, i) => ({ o, i }))
    .sort((a, b) => b.o.priority - a.o.priority || a.i - b.i)
    .map((x) => x.o);
}
