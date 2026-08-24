/**
 * reddit-reply-drafter.llm.ts
 *
 * Given the real threads we found in a subreddit, writes a tailored, value-first
 * reply suggestion for EACH specific thread (not a generic subreddit angle), so
 * the user can open a thread and post a genuinely helpful, on-topic reply. One
 * batched LLM call per subreddit (drafts all its threads at once). Manual-first
 * + ethics-first: helpful answers, mention the business only where it genuinely
 * fits, never link-drop/spam. Returns the threads unchanged on failure.
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import { formatBriefForPrompt } from "../../services/offpage/offpage-research.service";
import type { BusinessResearchBrief } from "../../services/offpage/offpage-types";
import type { RedditThread } from "../../utils/reddit-thread-finder";
import { sanitizeRedditDraft } from "./reddit-draft-safety";

const MODEL_FALLBACK = "gpt-5-mini";

const SYSTEM_PROMPT =
  "You write genuinely helpful, value-first Reddit replies for a business. You " +
  "answer the actual question first; you mention the business only where it truly " +
  "fits, naturally, never as a link-drop or hard sell. You sound like a real local, " +
  "not an ad. Always return valid JSON only.";

export async function generateThreadReplies(
  brief: BusinessResearchBrief,
  subreddit: string,
  threads: RedditThread[],
): Promise<RedditThread[]> {
  if (threads.length === 0) return threads;

  const list = threads.map((t, i) => `${i}. ${t.title}`).join("\n");
  const prompt = `Write a tailored, value-first reply for each Reddit thread below in r/${subreddit.replace(/^r\//i, "")}.

BUSINESS:
${formatBriefForPrompt(brief)}

THREADS:
${list}

For EACH thread, write a reply that:
- answers the thread's actual question helpfully first,
- mentions the business naturally ONLY where it genuinely fits (and it's fine to not mention it at all),
- never drops links or hard-sells,
- is 2-4 sentences, sounds like a real, knowledgeable local.

Return ONLY a JSON array, no markdown:
[
  { "index": 0, "reply": "the tailored reply for thread 0" }
]`;

  const llm = getLLMForComplexTasks();
  let response: { content: unknown };
  try {
    response = await llm.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    console.warn("[offpage/reddit-replies] LLM call failed:", (err as Error).message);
    return threads;
  }

  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: brief.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "reddit_replies" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return threads;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return threads;
    }
  }
  if (!Array.isArray(parsed)) return threads;

  const byIndex = new Map<number, string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const idx = typeof r.index === "number" ? r.index : Number(r.index);
    const reply = sanitizeRedditDraft(r.reply);
    if (Number.isInteger(idx) && reply) byIndex.set(idx, reply);
  }

  return threads.map((t, i) => ({ ...t, draft: byIndex.get(i) ?? t.draft ?? null }));
}
