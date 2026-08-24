/**
 * blog-brand-voice.utils.ts
 *
 * Turns a business's configured `contentTone` (the brand voice set at onboarding —
 * professional / casual / technical / friendly / bold / playful …) into a concrete,
 * enforceable WRITING directive that gets injected into the blog-writer prompt.
 *
 * Why this exists: the tone was captured and stored but never reached generation —
 * every blog used the writer's hardcoded house voice regardless of the brand's
 * setting. Tone is a STYLE instruction (how to write), NOT a groundable fact, so it
 * lives in its own prompt block, separate from the closed-world verified-facts
 * contract. It governs style only and never licenses inventing facts.
 *
 * Returns "" when no tone is configured, so businesses without a tone keep the
 * writer's existing default house style with zero behaviour change.
 */

const TONE_GUIDANCE: Record<string, string> = {
  professional:
    "Authoritative, polished, and precise. Industry-credible and trustworthy. Avoid slang, hype, and filler; favour clear, confident statements a knowledgeable buyer would respect.",
  casual:
    "Conversational and relaxed, like a knowledgeable friend talking to the reader. Use contractions and everyday language, shorter sentences, and a warm, approachable rhythm — while staying accurate.",
  technical:
    "Precise and detail-rich. Use correct terminology, concrete specifications, and structured explanations. Assume a knowledgeable reader who wants depth over simplification.",
  friendly:
    'Warm, encouraging, and personable. Speak directly to the reader as "you", be supportive and reassuring, and keep an upbeat, helpful tone.',
  bold: "Confident, punchy, and opinionated. Take clear stances, lead with strong declarative sentences, and cut hedging. Energetic without being gimmicky.",
  playful:
    "Light, witty, and energetic. Use tasteful humour and vivid, human phrasing to keep it engaging — without sacrificing clarity or accuracy.",
  authoritative:
    "Commanding and expert. Speak with earned confidence, cite specifics, and take firm, well-justified positions.",
  formal:
    "Composed, precise, and businesslike. Full sentences, no slang or contractions, measured and respectful.",
  conversational:
    "Natural and dialogue-like. Address the reader directly, use contractions, and vary sentence length so it reads like a real person speaking.",
  inspirational:
    "Encouraging but concrete. Motivate through clear choices and achievable next actions, never slogans, transformation promises, journey language, empowerment clichés, vitality or confidence claims, or hype.",
};

function normalizeTone(tone: string | null | undefined): string | null {
  const t = typeof tone === "string" ? tone.trim().toLowerCase() : "";
  return t.length > 0 ? t : null;
}

/**
 * Resolve the concrete guidance sentence for a tone. Exact match first, then a
 * substring match (so "professional/authoritative" style compound values still
 * resolve), else a generic directive built from the raw tone word.
 */
export function resolveBrandVoiceGuidance(
  tone: string | null | undefined,
): string | null {
  const t = normalizeTone(tone);
  if (!t) return null;
  const exact = TONE_GUIDANCE[t];
  if (exact) return exact;
  for (const [key, guidance] of Object.entries(TONE_GUIDANCE)) {
    if (t.includes(key)) return guidance;
  }
  return `Write in a distinctly ${t} voice, applied consistently across the whole article.`;
}

/**
 * Build the BRAND VOICE prompt block for the blog writer. Empty string when no
 * tone is configured (writer keeps its default house style).
 */
export function buildBrandVoicePromptBlock(
  tone: string | null | undefined,
): string {
  const guidance = resolveBrandVoiceGuidance(tone);
  if (!guidance) return "";
  const label = normalizeTone(tone);
  return [
    "BRAND VOICE (MANDATORY — this is the business's chosen voice and OVERRIDES any generic tone guidance elsewhere in this prompt):",
    `- Configured voice: "${label}".`,
    `- ${guidance}`,
    "- Apply this voice consistently across the title, introduction, body sections, and FAQ.",
    "- This governs STYLE only. It never permits inventing facts — the verified-facts contract still fully applies.",
  ].join("\n");
}
