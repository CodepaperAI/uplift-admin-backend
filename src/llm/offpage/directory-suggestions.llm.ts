/**
 * directory-suggestions.llm.ts
 *
 * Business- and LOCATION-aware directory recommendations. Given the deep research
 * brief, the LLM proposes directories/citation sites THIS specific business
 * should be listed on — weighted to its category, country, city/neighbourhood,
 * and business model — including the national/local/niche directories the static
 * catalog misses (e.g. for a Toronto restaurant: Yelp Canada, BlogTO, Toronto.com,
 * OpenTable, local food guides — not just generic global sites). Each comes with
 * why-it-fits and a real listing/submission URL. Returns [] on failure so the
 * lever falls back to the deterministic catalog baseline.
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import { formatBriefForPrompt } from "../../services/offpage/offpage-research.service";
import type {
  BusinessResearchBrief,
  OffPageResearchStrategy,
} from "../../services/offpage/offpage-types";
import { formatStrategyForPrompt } from "./research-strategy.llm";

const MODEL_FALLBACK = "gpt-5-mini";
const MAX_DIRECTORIES = 18;

export type DirectoryScope = "global" | "national" | "local" | "niche";

export interface DirectorySuggestion {
  name: string;
  /** Listing/submission URL (validated for reachability in a later phase). */
  url: string;
  /** Why this directory fits THIS business + location. */
  fit: string;
  scope: DirectoryScope;
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

function normalizeScope(value: unknown): DirectoryScope {
  return value === "global" || value === "national" || value === "local" || value === "niche"
    ? value
    : "niche";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+\.[^\s]+/i.test(value);
}

const SYSTEM_PROMPT =
  "You are a citations & directory strategist. You think in 3 layers — Trust " +
  "(Google/Apple/Bing/Yelp), Category Intent (G2/Capterra/TripAdvisor/Zillow/etc. " +
  "by business type), and Niche Authority (Clutch/Houzz/Indie Hackers/etc.) — and " +
  "you rank by where being listed actually drives discovery and revenue intent for " +
  "THIS business, not a spray-and-pray list. You use the correct regional variant " +
  "(e.g. Yelp Canada), recommend only REAL directories with real listing URLs, and " +
  "always return valid JSON only.";

/**
 * Research specific, business- and location-grounded directory opportunities.
 * Returns [] (never throws) so the engine falls back to the static catalog.
 */
export async function generateDirectorySuggestionsLLM(
  brief: BusinessResearchBrief,
  discovered: string[] = [],
  strategy?: OffPageResearchStrategy,
): Promise<DirectorySuggestion[]> {
  const prompt = `List the directories / citation sites THIS business should be on, using a 3-LAYER model. Pick what genuinely fits this business's category, country, city and model — not a generic list.

BUSINESS RESEARCH BRIEF:
${formatBriefForPrompt(brief)}

RESEARCH STRATEGY FROM THE BUSINESS-UNDERSTANDING PLANNER:
${formatStrategyForPrompt(strategy)}

DISCOVERED DOMAINS (these actually rank for this business's category/location searches — strong signal they're real directories to be on; identify the genuine directories among them and use their real listing/submission URLs):
${discovered.length ? discovered.join(", ") : "(none found — rely on the layers below)"}

LAYER 1 — TRUST (almost every business needs these; use the right REGIONAL variant):
  Google Business Profile, Apple Maps / Apple Business Connect, Bing Places, Yelp (e.g. Yelp Canada for a Canadian business).
LAYER 2 — CATEGORY INTENT (choose the ones matching THIS business type):
  • Local services / restaurants / clinics / salons / trades → TripAdvisor, Zomato, Foursquare, OpenTable, Thumbtack, Angi, regional/city directories (e.g. BlogTO/Toronto.com for Toronto).
  • SaaS / tech / software → G2, Capterra, Product Hunt, Crunchbase, StackShare, GitHub (if dev tools).
  • E-commerce / DTC → Google Shopping, Amazon, eBay, relevant marketplaces.
  • Real estate → Zillow, Realtor.com, Redfin, Trulia.
  • B2B agencies / professional services → Clutch, GoodFirms, DesignRush.
  • Startups / fundraising → Crunchbase, AngelList / Wellfound, LinkedIn.
LAYER 3 — NICHE AUTHORITY (1-3 category-specific hidden-leverage sites if they apply):
  e.g. Houzz (home/design), Behance / Dribbble (creative), Indie Hackers (dev/SaaS), category food/award guides, etc.

RULES:
- PRIORITIZE the discovered domains that are genuine directories (they're proven to rank for this niche). Then ensure the Layer-1 trust essentials are present, and add the Layer-2/Layer-3 sites that fit.
- Follow the planner's required directory types, niche directory types, regional hints and avoid list. Use its discovery search language to infer intent.
- Include the Layer-1 essentials, then the Layer-2 platforms that match THIS business type, then 1-3 relevant Layer-3 niche ones. Rank by impact (where being listed actually drives discovery / revenue intent) — don't spray-and-pray.
- Use the correct regional variant for the business's country (e.g. Yelp Canada, not Yelp.com).
- Every entry must be a REAL directory with a real listing/submission URL (https://...).
- Per entry, explain why it fits THIS business + location.

Return ONLY a JSON array, ordered by impact, no markdown — as many GENUINELY-fitting directories as you find (up to ${MAX_DIRECTORIES}; quality over padding):
[
  {
    "name": "Directory name",
    "url": "https://...",
    "fit": "1-2 sentences on why this fits THIS business + location",
    "scope": "global | national | local | niche",
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
    console.error("[offpage/directory] LLM suggestion call failed:", (err as Error).message);
    return [];
  }

  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: brief.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "directory" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn("[offpage/directory] could not parse LLM JSON");
      return [];
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: DirectorySuggestion[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? "").trim();
    const url = String(r.url ?? "").trim();
    if (!name || !isHttpUrl(url)) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      name,
      url,
      fit: String(r.fit ?? "").trim(),
      scope: normalizeScope(r.scope),
      relevance: clamp01(r.relevance),
    });
    if (out.length >= MAX_DIRECTORIES) break;
  }
  return out;
}
