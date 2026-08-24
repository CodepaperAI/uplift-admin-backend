/**
 * reddit-suggestions.llm.ts
 *
 * Business-RESEARCHED Reddit opportunities. Given a BusinessResearchBrief
 * (services, audience, competitors, location, keywords), the LLM proposes
 * SPECIFIC subreddits this business should participate in — not generic ones —
 * each with why it fits, a value-first engagement angle, and a ready-to-adapt
 * draft comment/post the owner can leverage directly.
 *
 * Manual-first by design: we NEVER auto-post. Every suggestion is framed as
 * add-genuine-value, respecting Reddit's 90/10 self-promotion norm and per-
 * subreddit rules. There is NO Reddit API / scraping here (Reddit blocked
 * unauthenticated access in 2026) — the specificity comes from grounding the
 * LLM in the business, not from live data. Subreddit names are LLM-knowledge-
 * based, so each ships with a ready link the user opens to confirm the
 * community exists and is active before participating.
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import { formatBriefForPrompt } from "../../services/offpage/offpage-research.service";
import type {
  BusinessResearchBrief,
  OffPageResearchStrategy,
} from "../../services/offpage/offpage-types";
import { sanitizeRedditDraft } from "./reddit-draft-safety";
import { formatStrategyForPrompt } from "./research-strategy.llm";

/** Fallback id only used for usage metering if the response omits the model. */
const MODEL_FALLBACK = "gpt-5-mini";
const MAX_SUGGESTIONS = 15;

export interface RedditSuggestion {
  /** Subreddit handle, normalized to "r/name". */
  subreddit: string;
  /** Why THIS subreddit fits THIS business (grounded in the brief). */
  fit: string;
  /** A value-first way to engage (what to contribute, not how to promote). */
  angle: string;
  /** Ready-to-adapt comment/post the owner can leverage — no link-dropping. */
  draft: string;
  /** 0-1, drives ranking. */
  relevance: number;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Normalize "smallbusiness", "/r/SmallBusiness", "r/SmallBusiness " → "r/SmallBusiness". */
export function normalizeSubreddit(raw: unknown): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/^\/?r\//i, "").replace(/^\/+/, "").trim();
  s = s.split(/[\s/?#]/)[0] ?? "";
  s = s.replace(/[^a-z0-9_]/gi, "");
  return s ? `r/${s}` : "";
}

const SYSTEM_PROMPT =
  "You are a Reddit community-marketing strategist. You recommend specific, real " +
  "subreddits where a particular business can build genuine reputation and earn " +
  "organic brand mentions (which also feed AI-citation visibility, since LLMs cite " +
  "Reddit heavily). You are manual-first and ethics-first: you NEVER tell users to " +
  "spam, drop links, or astroturf. You respect Reddit's 90/10 rule and each " +
  "subreddit's own rules. Recommendations must be tailored to THIS business — never " +
  "generic. Always return valid JSON only.";

/**
 * Research specific, business-grounded Reddit opportunities. Returns [] (never
 * throws) so the engine cleanly falls back to the deterministic baseline.
 */
export async function generateRedditSuggestionsLLM(
  brief: BusinessResearchBrief,
  strategy?: OffPageResearchStrategy,
): Promise<RedditSuggestion[]> {
  const prompt = `Recommend up to ${MAX_SUGGESTIONS} subreddits for this specific business to participate in. Return AS MANY as are genuinely relevant and valuable (quality over quantity — never pad to hit the number; only real, fitting communities).

BUSINESS RESEARCH BRIEF:
${formatBriefForPrompt(brief)}

RESEARCH STRATEGY FROM THE BUSINESS-UNDERSTANDING PLANNER:
${formatStrategyForPrompt(strategy)}

RULES:
- Use the FULL brief and the planner strategy above. Propose a DIVERSE mix across angles — don't return near-duplicates:
  1. Core niche/industry communities for what they actually sell.
  2. Location/city communities (if local) — e.g. r/<city>, r/<region>.
  3. Audience/lifestyle communities based on WHO their customers are.
  4. Adjacent-interest + problem communities based on their services, differentiators and the customer PAIN POINTS in the brief.
  5. Communities where competitors' customers gather.
- Prioritize the planner's subreddit/audience seeds, thread search queries, core relevance terms and helpful angles. Avoid the planner's avoid terms.
- Recommend REAL, active subreddits that genuinely fit. Do NOT pad with generic marketing subreddits unless they truly fit.
- Prefer communities where this business's expertise answers real questions people ask.
- For each, write a value-first engagement angle (what to contribute) and a ready-to-adapt draft comment/post that is genuinely helpful and does NOT drop links or hard-sell — the goal is reputation, not spam.
- Ground everything in the brief (reference their actual services/audience/pain points/topics), so it's leverageable, not generic.

Return ONLY a JSON array of exactly up to ${MAX_SUGGESTIONS} objects, no markdown:
[
  {
    "subreddit": "r/example",
    "fit": "1-2 sentences on why this subreddit fits THIS business specifically",
    "angle": "a value-first way to participate (what expertise to contribute)",
    "draft": "a ready-to-adapt, genuinely helpful comment/post (2-5 sentences, no links, no hard sell)",
    "relevance": 0.0
  }
]`;

  const llm = getLLMForComplexTasks();

  let response: { content: unknown };
  try {
    response = await llm.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    console.error("[offpage/reddit] LLM suggestion call failed:", (err as Error).message);
    return [];
  }

  // Meter the call like every other LLM usage (non-blocking).
  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: brief.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "reddit" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Tolerate prose around the array: grab the first [...] block.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn("[offpage/reddit] could not parse LLM JSON");
      return [];
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: RedditSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const subreddit = normalizeSubreddit(r.subreddit);
    if (!subreddit) continue;
    const dedupeKey = subreddit.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      subreddit,
      fit: String(r.fit ?? "").trim(),
      angle: String(r.angle ?? "").trim(),
      draft: sanitizeRedditDraft(r.draft) ?? "",
      relevance: clamp01(r.relevance),
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
