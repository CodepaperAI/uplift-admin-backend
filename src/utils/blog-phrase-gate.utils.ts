/**
 * blog-phrase-gate.utils.ts
 *
 * A deterministic, model-free gate against the AI-slop phrases that make a blog
 * read like a machine wrote it — the exact crutches Google's helpful-content
 * system and human readers penalise. The same list is injected into the
 * generation prompt (so the model is told NOT to use them) AND enforced after
 * the draft is produced (so a draft that slipped one through is sent back for a
 * rewrite, regardless of what the LLM judge thought).
 *
 * Why deterministic: an LLM judge is probabilistic and can wave a clichéd phrase
 * through. A regex never does. This is the cheap, 100%-reliable backstop under
 * the (smarter but fuzzier) expert-voice judge.
 *
 * Every function here is total and defensive: malformed / missing input yields
 * an empty result, never a throw. No I/O — fully unit-testable.
 */

export interface BannedPhraseHit {
  /** Human-readable label of the offending pattern. */
  label: string;
  /** How many times it appeared in the scanned prose. */
  count: number;
}

/**
 * High-precision AI-slop blocklist. Kept deliberately tight: every entry is a
 * phrase a careful human editor would strike, so false positives are rare.
 * Order is irrelevant; matching is case-insensitive.
 *
 * `pattern` is matched against HTML-stripped prose with the global+ignorecase
 * flags applied centrally (do NOT bake `g`/`i` into the literals here, or the
 * shared lastIndex state would make matching non-reentrant).
 */
export const BANNED_PHRASES: { label: string; pattern: RegExp }[] = [
  { label: "here's the thing", pattern: /here'?s the thing/ },
  { label: "let's be honest", pattern: /let'?s be honest/ },
  { label: "the bottom line", pattern: /the bottom line/ },
  { label: "the reality is", pattern: /the reality is/ },
  { label: "at the end of the day", pattern: /at the end of the day/ },
  { label: "in today's (world / landscape / fast-paced …)", pattern: /in today'?s [a-z-]+/ },
  { label: "when it comes to", pattern: /when it comes to/ },
  { label: "navigating/navigate the world of", pattern: /navigat(?:e|ing) the world of/ },
  { label: "it's worth noting", pattern: /it'?s worth noting/ },
  { label: "it is worth noting", pattern: /it is worth noting/ },
  { label: "it should be noted/mentioned", pattern: /it should be (?:noted|mentioned)/ },
  { label: "in conclusion", pattern: /in conclusion/ },
  { label: "as we've seen", pattern: /as we'?ve seen/ },
  { label: "look no further", pattern: /look no further/ },
  { label: "rest assured", pattern: /rest assured/ },
  { label: "you might be wondering", pattern: /you might be wondering/ },
  { label: "what most people don't realize", pattern: /what most people don'?t realize/ },
  { label: '"think of X as your Y" metaphor', pattern: /think of .{1,45}? as your\b/ },
  { label: "that's where X comes in", pattern: /that'?s where .{1,40}? comes? in/ },
  { label: "game-changer", pattern: /game[\s-]?changer/ },
  { label: "in the realm of", pattern: /in the realm of/ },
  { label: "ever-evolving / ever-changing", pattern: /ever[\s-](?:evolving|changing)/ },
  { label: "take your X to the next level", pattern: /to the next level/ },
  { label: "elevate your", pattern: /elevate your/ },
  { label: "let's dive in / deep dive / dive into", pattern: /\b(?:dive into|let'?s dive|deep dive)\b/ },
  { label: "more than just", pattern: /more than just/ },
  { label: "unlock the (power/potential/secrets) of", pattern: /unlock the (?:power|potential|secrets?) of/ },
  { label: "generic personal/fitness/wellness journey", pattern: /\b(?:personal|fitness|wellness|unique) journey\b/ },
  { label: "transform intention into", pattern: /\btransform intention into\b/ },
  { label: "modern member experience", pattern: /\bmodern member experience\b/ },
];

/** Strip HTML tags so the gate scans prose, not markup. Local + dependency-free. */
function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scan blog content (HTML or plain text) for banned phrases. Returns one hit per
 * distinct pattern that matched, with an occurrence count. Empty array == clean.
 */
export function findBannedPhrases(content: unknown): BannedPhraseHit[] {
  const text = stripHtml(typeof content === "string" ? content : "");
  if (!text) return [];

  const hits: BannedPhraseHit[] = [];
  for (const { label, pattern } of BANNED_PHRASES) {
    const re = new RegExp(pattern.source, "gi");
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      hits.push({ label, count: matches.length });
    }
  }
  return hits;
}

/**
 * The blocklist rendered for injection into the generation system prompt, so the
 * model is told the rule up front (cheaper than catching it in a revision).
 */
export function buildBannedPhrasesPromptBlock(): string {
  return [
    "🚫 BANNED PHRASES — never use these AI-cliché crutches (a deterministic gate",
    "rejects the draft if any appear, and they are the #1 signal that a machine wrote it):",
    BANNED_PHRASES.map((p) => `  - ${p.label}`).join("\n"),
    "Write what you actually mean instead. If a sentence only works with one of these,",
    "the sentence has no real content — cut it or replace it with a concrete specific.",
  ].join("\n");
}

/**
 * A revision instruction listing the exact phrases found, for the critique loop
 * to hand back to the model when the deterministic gate trips.
 */
export function buildBannedPhraseRevisionMessage(hits: BannedPhraseHit[]): string {
  return [
    "DRAFT REJECTED BY THE AI-PHRASE GATE. The draft was NOT saved.",
    "It contains banned AI-cliché phrases that make it read like generic AI. Rewrite the",
    "FULL article removing every occurrence below, replacing each with a concrete, specific",
    "point in the business's real voice (not another cliché), then call save-blog-info again:",
    ...hits.map((h) => `  • "${h.label}" (${h.count}×)`),
  ].join("\n");
}
