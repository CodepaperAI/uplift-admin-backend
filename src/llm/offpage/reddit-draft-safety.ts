/**
 * Reddit drafts must be helpful notes a user can adapt, not promotion payloads.
 * The LLM prompt asks for that, and this guard keeps obvious misses out of UI.
 */

const LINK_PATTERNS = [
  /https?:\/\//i,
  /\bwww\./i,
  /\[[^\]]+\]\([^)]+\)/,
];

const HARD_SELL_PATTERNS = [
  /\bbook (a|your) (call|consultation|demo|appointment)\b/i,
  /\bschedule (a|your) (call|consultation|demo|appointment)\b/i,
  /\bcontact (us|me) (today|now)\b/i,
  /\bcall (us|me) (today|now)\b/i,
  /\bdm (us|me)\b/i,
  /\bcheck (us|me|our site|our website) out\b/i,
  /\bvisit (our|my) (site|website)\b/i,
  /\bbuy now\b/i,
  /\blimited[- ]time offer\b/i,
  /\buse code\b/i,
  /\bwe'?re the best\b/i,
];

export function sanitizeRedditDraft(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const draft = value.replace(/\s+/g, " ").trim();
  if (!draft) return null;
  if (draft.length < 20) return null;
  if (LINK_PATTERNS.some((pattern) => pattern.test(draft))) return null;
  if (HARD_SELL_PATTERNS.some((pattern) => pattern.test(draft))) return null;

  return draft.length > 700 ? `${draft.slice(0, 697).trimEnd()}...` : draft;
}
