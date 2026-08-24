/**
 * offpage-validator.llm.ts
 *
 * The "don't blind-trust" layer. An independent skeptic agent reviews the
 * researcher agents' candidate opportunities (Reddit + directory) against the
 * business context and rejects anything generic, irrelevant, implausible, spammy
 * or inappropriate — returning a keep/drop verdict + suitability score per item.
 * Combined with the live checks (real threads, reachability, already-listed),
 * this is what keeps the queue specific and trustworthy.
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import { formatBriefForPrompt } from "../../services/offpage/offpage-research.service";
import type {
  BusinessResearchBrief,
  Opportunity,
} from "../../services/offpage/offpage-types";

const MODEL_FALLBACK = "gpt-5-mini";

export interface OpportunityVerdict {
  keep: boolean;
  reason: string;
  /** 0-1 suitability after scrutiny. */
  score: number;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0.5;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const SYSTEM_PROMPT =
  "You are a strict off-page marketing reviewer. You are skeptical by default and " +
  "reject suggestions that are generic, off-topic for this specific business, " +
  "implausible/likely fake, spammy, or inappropriate for the platform's norms. You " +
  "keep only suggestions a sharp marketer would actually act on for THIS business. " +
  "Always return valid JSON only.";

/**
 * Review candidates and return a verdict per opportunity key. On any failure
 * returns an empty map (caller then keeps everything — fail-open, since the
 * live checks already pruned the worst).
 */
export async function validateOpportunitiesLLM(
  brief: BusinessResearchBrief,
  opportunities: Opportunity[],
): Promise<Map<string, OpportunityVerdict>> {
  const verdicts = new Map<string, OpportunityVerdict>();
  if (opportunities.length === 0) return verdicts;

  const candidates = opportunities.map((o) => ({
    key: o.key,
    lever: o.leverKey,
    title: o.title,
    target: o.url ?? "",
    why: o.rationale,
  }));

  const prompt = `Review these candidate off-page opportunities for the business below. Keep only the ones that are genuinely relevant, specific, plausible and appropriate for THIS business. Reject generic filler, off-topic, implausible or spammy ones.

BUSINESS:
${formatBriefForPrompt(brief)}

CANDIDATES (JSON):
${JSON.stringify(candidates, null, 2)}

For EACH candidate return a verdict. Return ONLY a JSON array, no markdown:
[
  { "key": "<the candidate key>", "keep": true, "reason": "short reason", "score": 0.0 }
]`;

  const llm = getLLMForComplexTasks();
  let response: { content: unknown };
  try {
    response = await llm.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    console.error("[offpage/validator] LLM call failed:", (err as Error).message);
    return verdicts;
  }

  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: brief.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "validator" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return verdicts;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return verdicts;
    }
  }

  if (!Array.isArray(parsed)) return verdicts;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const key = String(r.key ?? "").trim();
    if (!key) continue;
    verdicts.set(key, {
      keep: r.keep !== false,
      reason: String(r.reason ?? "").trim(),
      score: clamp01(r.score),
    });
  }
  return verdicts;
}
