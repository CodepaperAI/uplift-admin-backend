/**
 * reddit-lever.ts
 *
 * Off-page lever for SaaS / e-commerce / consumer businesses: surfaces Reddit
 * search opportunities where the owner can add genuine expertise. Reddit is
 * heavily cited by LLMs, so this also feeds the AI-visibility (LlmCitation) goal.
 *
 * v1 = "ready-to-run searches" the user clicks and runs themselves (subreddit
 * discovery + thread search URLs). NO Reddit API / scraping → no ToS or
 * rate-limit exposure. NEVER auto-posts; every action is framed as add-value,
 * with an explicit account-safety warning. Pure, no I/O.
 */

import { computePriority, makeOpportunityKey } from "../offpage-engine";
import type {
  BusinessOffPageProfile,
  Lever,
  OffPageResearchStrategy,
  Opportunity,
} from "../offpage-types";
import { generateRedditSuggestionsLLM } from "../../../llm/offpage/reddit-suggestions.llm";

const MAX_KEYWORDS = 5;
/** Reddit's domain authority is very high; that's the whole point for AI visibility. */
const REDDIT_AUTHORITY = 92;

const SPAM_WARNING =
  "Add genuine value / answer the question — do NOT drop links or self-promote. Low-effort promotion gets accounts banned and hurts your brand.";

function redditSearchUrl(query: string, type?: "sr"): string {
  const q = encodeURIComponent(query);
  const typeParam = type ? `&type=${type}` : "&sort=new";
  return `https://www.reddit.com/search/?q=${q}${typeParam}`;
}

/** Direct link to a normalized subreddit ("r/name" → its page). */
function subredditUrl(subreddit: string): string {
  const name = subreddit.replace(/^r\//i, "");
  return `https://www.reddit.com/r/${name}/`;
}

export const redditLever: Lever = {
  key: "reddit",

  appliesTo(profile: BusinessOffPageProfile): boolean {
    return Boolean(
      profile.businessName ||
        profile.category ||
        profile.keywords.length > 0,
    );
  },

  findOpportunities(profile: BusinessOffPageProfile): Opportunity[] {
    const keywords = profile.keywords.slice(0, MAX_KEYWORDS);
    const out: Opportunity[] = [];

    // One "find the right subreddits" opportunity (highest value first step).
    const seedTopic = keywords[0] ?? profile.category ?? profile.businessName;
    if (seedTopic) {
      out.push({
        leverKey: "reddit",
        key: makeOpportunityKey("reddit", "subreddit-finder"),
        title: `Find subreddits where ${profile.businessName || "your audience"} hangs out`,
        url: redditSearchUrl(seedTopic, "sr"),
        action: `Identify 2-3 active, on-topic subreddits to participate in. ${SPAM_WARNING}`,
        priority: computePriority(1, REDDIT_AUTHORITY),
        rationale:
          "Reddit threads are among the most-cited sources by ChatGPT/Perplexity. Genuine participation builds brand mentions and AI visibility.",
        status: "todo",
        businessTypeFit: "SaaS / e-commerce / consumer",
      });
    }

    // Per-keyword thread searches, decaying relevance by rank.
    keywords.forEach((keyword, index) => {
      const relevance = 1 - index * 0.15; // 1.0, 0.85, 0.70, ...
      out.push({
        leverKey: "reddit",
        key: makeOpportunityKey("reddit", `threads-${keyword}`),
        title: `Answer Reddit threads about "${keyword}"`,
        url: redditSearchUrl(keyword),
        action: `Review recent threads and reply where you can genuinely help. ${SPAM_WARNING}`,
        priority: computePriority(relevance, REDDIT_AUTHORITY),
        rationale: `People ask about "${keyword}" on Reddit; expert answers earn brand mentions and feed AI-citation visibility.`,
        source: "baseline",
        status: "todo",
        businessTypeFit: "SaaS / e-commerce / consumer",
      });
    });

    return out;
  },

  /**
   * LLM-researched, business-specific Reddit opportunities: real subreddits
   * matched to this business's audience/services/topics, each with a value-first
   * angle and a ready-to-adapt draft the owner can leverage. Returns [] on
   * failure so the engine falls back to the deterministic searches above.
   */
  async researchOpportunities(
    profile,
    brief,
    strategy?: OffPageResearchStrategy,
  ): Promise<Opportunity[]> {
    if (strategy && strategy.reddit.enabled === false) return [];

    const suggestions = await generateRedditSuggestionsLLM(brief, strategy);
    if (suggestions.length === 0) return [];

    return suggestions.map((s, index): Opportunity => {
      const relevance = s.relevance > 0 ? s.relevance : 1 - index * 0.1;
      return {
        leverKey: "reddit",
        key: makeOpportunityKey("reddit", s.subreddit),
        title: `Engage in ${s.subreddit}`,
        url: subredditUrl(s.subreddit),
        action: s.angle
          ? `${s.angle} ${SPAM_WARNING}`
          : `Participate genuinely and share expertise. ${SPAM_WARNING}`,
        priority: computePriority(relevance, REDDIT_AUTHORITY),
        rationale:
          s.fit ||
          `A relevant Reddit community for ${profile.businessName || "your business"}.`,
        source: "researched",
        draft: s.draft || null,
        status: "todo",
        businessTypeFit: "SaaS / e-commerce / consumer",
      };
    });
  },
};
