/**
 * directory-listing-verifier.llm.ts
 *
 * Verifies whether a business ALREADY has a real profile on a directory. The
 * Google `site:` search only finds CANDIDATE pages on the directory's domain,
 * which is noisy — sitemaps, search pages, and (worst) similarly-named
 * businesses in a different city. Blindly trusting the first on-domain result
 * surfaced things like a French boats forum for "Google Business Profile" and a
 * Montréal-Nord driving school for an unrelated one.
 *
 * This agent looks at the candidates with the business's TRUE identity (name +
 * address + category) and decides if any is a genuine listing for THIS exact
 * business, or none. It is strict and fails soft to "not listed" — a false
 * "already listed" is the worse error (it tells the user to skip a directory
 * they're actually not on).
 */

import { getLLMForComplexTasks } from "../../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "../../services/llm-usage.service";
import type { ListingCandidate } from "../../utils/directory-verifier";

const MODEL_FALLBACK = "gpt-5-mini";

export interface ListingIdentity {
  businessName: string;
  city?: string | null;
  address?: string | null;
  category?: string | null;
  businessId?: string | null;
}

export interface ListingVerdict {
  listed: boolean;
  /** The verified listing URL (always one of the candidates) when listed. */
  url: string | null;
  reason: string;
}

const NOT_LISTED: ListingVerdict = { listed: false, url: null, reason: "not verified" };

const SYSTEM_PROMPT =
  "You verify whether a specific business already has a real profile/listing on a " +
  "directory, given candidate search results. Be STRICT: a match must be the EXACT " +
  "same business — same name AND same city/area. Reject similarly-named businesses " +
  "in a different city or suburb, sitemaps, search-result pages, category/index " +
  "pages, and articles. When unsure, answer not listed. Return valid JSON only.";

/**
 * Decide if any candidate is a genuine listing for THIS business. Returns
 * not-listed on any failure, and never returns a URL that wasn't among the
 * candidates (anti-hallucination).
 */
export async function verifyExistingListingLLM(
  identity: ListingIdentity,
  directoryName: string,
  candidates: ListingCandidate[],
): Promise<ListingVerdict> {
  if (candidates.length === 0) {
    return { listed: false, url: null, reason: "no candidates" };
  }

  const location =
    [identity.address, identity.city].filter(Boolean).join(", ") || "(unknown)";
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.title || "(no title)"}\n   URL: ${c.link}\n   ${c.snippet ?? ""}`.trim(),
    )
    .join("\n\n");

  const prompt = `BUSINESS (the only one that counts as a match):
- Name: ${identity.businessName}
- Location: ${location}
- Category: ${identity.category ?? "(unknown)"}

DIRECTORY: ${directoryName || "(this directory)"}

CANDIDATE RESULTS:
${list}

Which candidate, if any, is a genuine profile/listing page for THIS EXACT business?
- Same business = same name AND same city/area. A similarly-named business in a different area is NOT a match.
- Reject sitemaps (.xml), search-result pages, category/index pages, and articles — only an actual business profile counts.
- The "url" you return MUST be copied exactly from one of the candidate URLs above.
- If none clearly match, set listed = false.

Return ONLY JSON: {"listed": true or false, "url": "exact candidate URL or null", "reason": "one short sentence"}`;

  let response: { content: unknown };
  try {
    const llm = getLLMForComplexTasks();
    response = await llm.invoke([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ]);
  } catch (err) {
    console.warn("[offpage/listing-verify] LLM call failed:", (err as Error).message);
    return NOT_LISTED;
  }

  recordLlmUsageFromLangChainMessage(response, {
    purpose: "other",
    provider: "openai",
    modelFallback: MODEL_FALLBACK,
    businessId: identity.businessId || null,
    metadata: { feature: "offpage_suggestions", lever: "directory_listing_verify" },
  }).catch(() => {});

  const text = typeof response.content === "string" ? response.content : "";
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return NOT_LISTED;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return NOT_LISTED;
    }
  }

  if (!parsed || typeof parsed !== "object") return NOT_LISTED;
  const r = parsed as Record<string, unknown>;
  const listed = r.listed === true;
  const url = typeof r.url === "string" ? r.url.trim() : "";
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";

  if (!listed || !url) {
    return { listed: false, url: null, reason: reason || "not listed" };
  }
  // Anti-hallucination: only accept a URL we actually found as a candidate.
  const matched = candidates.find((c) => c.link === url);
  if (!matched) {
    return { listed: false, url: null, reason: "verified URL was not a candidate" };
  }
  return { listed: true, url, reason: reason || "verified match" };
}
