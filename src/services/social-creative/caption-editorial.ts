/**
 * Production prompt adaptation of the proven agent-testing caption workflow.
 * The model owns formula selection and the silent editorial quality pass; this
 * is instruction, not a JavaScript content-scoring or rewriting layer.
 */
export const SOCIAL_CAPTION_AGENT_TESTING_EDITORIAL_METHOD = `
Use this editorial method before returning the structured platform copy:

1. Build one internal brief from the supplied grounding: the real audience, the single strongest idea, the objective, the concrete brand-specific facts, the reader consequence, and the one verified next step. Do not expose this brief.
2. Choose the strongest truthful hook and formula for each platform. Useful choices include curiosity gap, contrarian correction, common mistake, direct audience callout, local callout, beginner path, checklist, comparison, or a specific result. Use a number, quote, result, customer story, urgency claim, or promotion only when that exact fact exists in the grounding.
3. Use a different formula and opening angle on every requested platform. Never write one generic caption and resize it. Each caption must feel native to its platform while carrying the same factual campaign idea.
4. Keep the client-specific details that make the post believable: actual services, location, audience problem, differentiator, promotion terms, verified proof, and verified action when relevant. Never pad with generic marketing sentences.
5. Apply the swap test silently: if another business could use the caption by changing only the name and city, it is too generic. Rewrite it with facts that only this business could naturally say.
6. Apply the read-aloud test silently. Use direct, conversational English that sounds written for the supplied locale, not translated from a marketing brief. Remove corporate filler such as excited to announce, leverage, robust, seamless, game-changer, transformative, revolutionary, and supercharge.
7. Use exactly one clear CTA when a verified action exists. Optimize for a useful next step, meaningful reply, save, or share. Never ask for likes, never use empty engagement bait, and never invent a keyword automation.
8. Preserve one idea. Delete repetition. The caption should add useful context instead of restating the topic or graphic word for word.

Platform method:
- Instagram feed: open with a 5-to-10-word hook that lands before the 125-character fold. Never put an emoji in the first line. Put the natural search phrase in the first two sentences. Use a warm, scannable opening, useful brand-specific context, and one verified CTA, separated by blank lines. The image carries the visual claim, so the caption must add context rather than repeat the graphic.
- Facebook page: write warmer, more direct copy in short full-sentence paragraphs. Prefer a concise hook, one useful fact or consequence, and a natural discussion or verified-action ending. Avoid salesy trigger language and do not paste the Instagram caption.
- LinkedIn: choose informative, story, or testimony only from the available evidence. Default to informative when no real story or proof exists. Start with a punchy hook of 10 words or fewer. Use one sentence or one useful point per paragraph with blank lines. For informative posts, use 3-to-5 discrete points only when the evidence genuinely provides them. Never invent a biography, client, quote, metric, or result. End with a concise takeaway and one relevant question or verified CTA. Write for the mobile 210-character fold, not as a desktop essay.
- X: write a native three-line post, not a shortened Instagram caption. Line 1 is a sharp take, contrast, mistake, direct callout, or supplied number. Line 2 is the concrete brand-specific fact or consequence. Line 3 is the punchline or verified next step, not a survey question. Return distinct lunch and evening variants with different hooks and wording.

Silent quality gate before output:
- Voice match: recognizable for this business and locale.
- Scroll stop: the first line creates curiosity, tension, recognition, or useful specificity.
- One idea: every sentence earns its place.
- Platform fit: native length, structure, line breaks, and a different formula per platform.
- Grounding: no invented statistics, prices, awards, superlatives, quotes, outcomes, availability, or customer claims.
- Final swap test and read-aloud test both pass.
Rewrite internally until every category is strong. Return only the final structured copy.
`.trim();
