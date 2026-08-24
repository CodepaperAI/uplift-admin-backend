/**
 * Query-text dedup
 *
 * Collapses near-duplicate natural-language questions that would otherwise
 * be stored as distinct rows in LlmQueryDiscovery. Example:
 *
 *   "How much does plumbing cost?"          ┐
 *   "How much for plumbing?"                ├─→ same normalized key
 *   "how much does a plumbing cost"         ┘
 *
 * This is a lightweight structural normalizer — it's NOT semantic dedup.
 * It strips punctuation, lowercases, removes filler words, and sorts
 * tokens so reorderings don't matter.
 */

/**
 * Filler words removed from the dedup key. These tokens carry little
 * discriminative signal and tend to vary between near-duplicate phrasings.
 */
const FILLER_WORDS: Set<string> = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "can",
  "could",
  "will",
  "would",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "have",
  "has",
  "had",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "about",
  "as",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "my",
  "your",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "any",
  "some",
  "all",
]);

/**
 * Build a stable normalized key for a query string. Two queries that
 * produce the same key are considered duplicates for storage purposes.
 *
 * Invariants:
 *  - Case-insensitive
 *  - Punctuation-insensitive
 *  - Filler-word insensitive (drops articles, aux verbs, prepositions)
 *  - Order-insensitive (sorts tokens alphabetically)
 *  - Stable: same input → same output (no randomness)
 */
export function normalizeQueryForDedup(query: string): string {
  if (typeof query !== "string") return "";
  const lowered = query.toLowerCase();

  // Replace any non-letter/digit with a space, then collapse whitespace.
  const stripped = lowered.replace(/[^a-z0-9]+/g, " ").trim();
  if (!stripped) return "";

  const tokens = stripped.split(/\s+/).filter((t) => !FILLER_WORDS.has(t));

  // Sort tokens so "cost plumbing" and "plumbing cost" collapse together.
  tokens.sort();

  return tokens.join(" ");
}

/**
 * Remove near-duplicate items from a list, keyed by a normalized form of
 * their `query` field. Preserves the first occurrence of each key — i.e.
 * the order of the input list determines which variant survives.
 */
export function dedupByNormalized<T extends { query: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = normalizeQueryForDedup(item.query);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Convenience: dedup a flat array of strings.
 */
export function dedupStringsByNormalized(queries: string[]): string[] {
  return dedupByNormalized(queries.map((query) => ({ query }))).map(
    (item) => item.query,
  );
}
