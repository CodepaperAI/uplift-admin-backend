/**
 * expert-voice-judge.service.ts
 *
 * The "brain" that was missing. After a blog draft is produced, this judges it
 * against an expert-voice rubric and returns concrete critique. The
 * critique-revise loop (wired in saveBlogInDb) uses the verdict to decide
 * whether to regenerate the draft before it is ever saved.
 *
 * Target (founder-defined): "sounds like a real expert wrote it" — specific,
 * opinionated, grounded in lived experience, free of hedging, using the
 * business's REAL competitors and offerings.
 *
 * The async judge call is non-fatal: any failure yields a permissive verdict so
 * a flaky judge can never block publishing. The decision/parse helpers are pure
 * and unit-tested.
 */

import {
  createBlogJudgeModel,
  EXPERT_VOICE_BAR_DEFAULT,
  getExpertVoiceWeights,
} from "../config/llm.config";
import type {
  CompetitorSubstance,
  OfferingSubstance,
} from "../utils/blog-substance.utils";
import { BANNED_PHRASES } from "../utils/blog-phrase-gate.utils";

// Re-export so existing importers of the bar from this module keep working.
export { EXPERT_VOICE_BAR_DEFAULT };

export interface ExpertVoiceDimensions {
  specificity: number; // concrete detail, real numbers, named techniques
  opinions: number; // clear stance / recommendations, not fence-sitting
  livedExperience: number; // insider / practitioner detail
  hedgingFreedom: number; // absence of filler / hedge / AI slop
  competitorUse: number; // real competitors used well, no fabricated vs
  offeringUse: number; // references the business's real products/services
}

export interface ExpertVoiceVerdict {
  overall: number; // 0-10
  dimensions: ExpertVoiceDimensions;
  critique: string[]; // concrete, actionable fixes
  /** True when the judge call itself failed and this is a permissive fallback. */
  errored?: boolean;
}

export interface ExpertVoiceJudgeInput {
  content: string;
  title: string;
  keyword: string;
  businessName: string;
  competitors: CompetitorSubstance[];
  offering: OfferingSubstance;
  /** Offerings with retrieved first-party evidence that the draft may cover in depth. */
  evidenceBackedOfferings?: string[];
  /** Closed-world facts the editor may ask the writer to use. */
  verifiedFacts?: string[];
}

const DIMENSION_KEYS: (keyof ExpertVoiceDimensions)[] = [
  "specificity",
  "opinions",
  "livedExperience",
  "hedgingFreedom",
  "competitorUse",
  "offeringUse",
];

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return Math.round(n * 10) / 10;
}

/** Strip plain text of HTML tags so the judge reads prose, not markup. */
export function stripHtmlForJudge(html: string): string {
  return String(html ?? "")
    .replace(
      /<section\b[^>]*data-uplift-assembled=["']verified-business-facts["'][^>]*>[\s\S]*?<\/section>/gi,
      " ",
    )
    .replace(
      /<div\b[^>]*data-uplift-assembled=["']author-bio["'][^>]*>[\s\S]*?<\/div>/gi,
      " ",
    )
    .replace(
      /<nav\b[^>]*data-uplift-component=["']article-toc["'][^>]*>[\s\S]*?<\/nav>/gi,
      " ",
    )
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildExpertVoiceJudgeBrief(input: ExpertVoiceJudgeInput): string {
  const text = stripHtmlForJudge(input.content);
  // Read the complete normal-size article so hallucinations or weak prose near
  // the FAQ/conclusion cannot hide beyond a short opening excerpt.
  const excerpt = text.slice(0, 18_000);

  const competitorList =
    input.competitors.length > 0
      ? input.competitors.map((c) => c.name).join(", ")
      : "(none provided)";

  const offeringList = (
    input.evidenceBackedOfferings ?? [
      ...input.offering.categories,
      ...input.offering.items,
    ]
  )
    .slice(0, 12)
    .join(", ") || "(none provided)";

  const comparativeKeyword = /\b(best|top|vs|versus|compare|comparison|alternative)\b/i.test(
    input.keyword,
  );
  const factList = (input.verifiedFacts ?? []).slice(0, 80);

  return [
    "You are a brutally honest senior editor and a practitioner in this trade.",
    "Judge whether the blog draft below reads like a REAL EXPERT wrote it — or like generic AI.",
    "",
    `Business: ${input.businessName || "(unknown)"}`,
    `Target keyword: ${input.keyword || "(unknown)"}`,
    `Real competitors available: ${competitorList}`,
    `Evidence-backed offerings available for detailed coverage: ${offeringList}`,
    `Verified facts the writer is allowed to state: ${factList.length ? factList.join(" | ") : "(none provided)"}`,
    `Topic is comparative (should reference competitors): ${comparativeKeyword ? "yes" : "no"}`,
    "",
    "Score each dimension 0-10 (10 = indistinguishable from a knowledgeable human in this trade):",
    "- specificity: concrete decision guidance grounded ONLY in the verified facts above. Real numbers or named techniques help only when they are in that list or visibly supported by a cited source in the draft. Never penalize a draft for omitting unavailable numbers.",
    "- opinions: takes a clear stance / makes real recommendations — NOT fence-sitting.",
    "- livedExperience: practical applicability, real-world tradeoffs, and mistakes a reader can avoid — NOT textbook.",
    "  ALSO score this LOW if the draft reads like an encyclopedia instead of a useful expert guide.",
    "  It should show empathy for the reader's decision and explain practical tradeoffs, but it must not",
    "  pretend the business observed a real incident, customer, site, result, sensory detail, or workflow",
    "  unless that experience is in the verified facts. A clearly labelled hypothetical may illustrate a decision.",
    "  Do not require private anecdotes or internal workflows. A draft can score 7+ here using clear conditional",
    "  decision rules and evidence-backed tradeoffs even when no first-person experience is available.",
    "  Never reward fabricated first-person customer work, outcomes, volumes, timelines, or credentials;",
    "  practical domain detail can sound expert without pretending the business personally observed it.",
    "- hedgingFreedom: free of hedging, filler, and AI slop. Score 0-3 if ANY of these",
    `  cliché crutches appear: ${BANNED_PHRASES.map((p) => p.label).slice(0, 12).join("; ")}; etc.`,
    "- competitorUse: if competitors are provided AND the topic is comparative, are the REAL named",
    "  competitors used for honest differentiation, with NO fabricated \"Brand A vs Brand B\"? If",
    "  competitors are not relevant to this topic, score this 10 (not applicable).",
    "- offeringUse: does it use the evidence-backed offerings above where they naturally support",
    "  the reader's decision, without inventing details? Never penalize omission of an offering that",
    "  lacks first-party evidence in the list above. If naturally not applicable, score 10.",
    "",
    "Then give an overall 0-10 and 2-5 concrete critique bullets naming weak passages. Diagnose only:",
    "do not write replacement sentences, examples, facts, scenarios, or claims for the writer to copy.",
    "Be harsh: a 7+ overall means you would publish it under your own name.",
    "Every requested fix MUST be achievable using only the verified facts above and facts already supported",
    "by a visible authoritative link in the draft. Never suggest a new statistic, licence class, regulation,",
    "legal consequence, schedule, patrol interval, customer scenario, competitor attribute, outcome, price,",
    "location, or first-hand story. When evidence is sparse, ask for clearer reasoning or removal of a claim,",
    "not invented specificity.",
    "",
    "Return ONLY minified JSON, no prose, no code fences:",
    `{"specificity":N,"opinions":N,"livedExperience":N,"hedgingFreedom":N,"competitorUse":N,"offeringUse":N,"overall":N,"critique":["...","..."]}`,
    "",
    `TITLE: ${input.title}`,
    "DRAFT (prose extract):",
    excerpt,
  ].join("\n");
}

/** Robustly parse the judge's JSON response into a verdict. Pure. */
export function parseExpertVoiceVerdict(raw: string): ExpertVoiceVerdict {
  const fallback: ExpertVoiceVerdict = {
    overall: 0,
    dimensions: {
      specificity: 0,
      opinions: 0,
      livedExperience: 0,
      hedgingFreedom: 0,
      competitorUse: 0,
      offeringUse: 0,
    },
    critique: [],
  };

  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;

  // Pull the first {...} block, tolerating code fences / stray prose.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return fallback;
  }

  const dimensions = {} as ExpertVoiceDimensions;
  for (const key of DIMENSION_KEYS) {
    dimensions[key] = clampScore(parsed[key]);
  }

  // Overall: trust the model's value, else average the dimensions.
  let overall: number;
  if (parsed.overall !== undefined && parsed.overall !== null) {
    overall = clampScore(parsed.overall);
  } else {
    const sum = DIMENSION_KEYS.reduce((acc, k) => acc + dimensions[k], 0);
    overall = clampScore(sum / DIMENSION_KEYS.length);
  }

  const critique = Array.isArray(parsed.critique)
    ? parsed.critique
        .map((c) => (typeof c === "string" ? c.trim() : ""))
        .filter((c) => c.length > 0)
        .slice(0, 8)
    : [];

  return { overall, dimensions, critique };
}

/**
 * Pure: recompute overall as a weighted average of the dimensions. Lets the
 * ranking-correlation analysis tune what "expert-grade" means via env, no code
 * change. Weights default to 1 for any dimension not listed.
 */
export function applyDimensionWeights(
  verdict: ExpertVoiceVerdict,
  weights: Record<string, number>,
): ExpertVoiceVerdict {
  let wsum = 0;
  let vsum = 0;
  for (const k of DIMENSION_KEYS) {
    const w = weights[k] ?? 1;
    wsum += w;
    vsum += w * verdict.dimensions[k];
  }
  if (wsum <= 0) return verdict;
  return { ...verdict, overall: clampScore(vsum / wsum) };
}

export type CritiqueAction = "save" | "revise";

/**
 * Pure decision: given a verdict and how many drafts have already been judged
 * (including this one), should the model revise or should we save?
 *
 * - attemptNumber is 1-based (first draft judged = 1).
 * - maxRevisions is the number of EXTRA revise attempts allowed, so the total
 *   number of drafts allowed is maxRevisions + 1.
 */
export function decideCritiqueAction(params: {
  overall: number;
  attemptNumber: number;
  maxRevisions: number;
  bar: number;
}): { action: CritiqueAction; reason: string } {
  const { overall, attemptNumber, maxRevisions, bar } = params;
  const maxDrafts = Math.max(1, maxRevisions + 1);

  if (overall >= bar) {
    return { action: "save", reason: `cleared bar (${overall} >= ${bar})` };
  }
  if (attemptNumber >= maxDrafts) {
    return {
      action: "save",
      reason: `revision budget exhausted (draft ${attemptNumber}/${maxDrafts}); shipping best`,
    };
  }
  return {
    action: "revise",
    reason: `below bar (${overall} < ${bar}); draft ${attemptNumber}/${maxDrafts}`,
  };
}

/** Pure: pick the highest-scoring draft. Ties keep the earliest (stable). */
export function pickBestDraft<T extends { overall: number }>(
  drafts: T[],
): T | undefined {
  let best: T | undefined;
  for (const draft of drafts) {
    if (best === undefined || draft.overall > best.overall) best = draft;
  }
  return best;
}

/** The tool message returned to the model when a draft must be revised. */
export function buildRevisionMessage(
  verdict: ExpertVoiceVerdict,
  attemptNumber: number,
): string {
  const lines = [
    `DRAFT NOT YET EXPERT-GRADE (expert-voice score ${verdict.overall}/10, attempt ${attemptNumber}).`,
    "This draft was NOT saved. Keep its verified facts, title, structure, links, and passing sections.",
    "Edit only the weak passages identified below, then call save-blog-info again with the complete article:",
  ];
  // The judge is an untrusted model too. Never forward its prose directly to
  // the writer: a critique can smuggle in a fabricated law, statistic, workflow,
  // or customer example. Convert low dimensions into code-owned instructions.
  const safeDirectives: string[] = [];
  if (verdict.dimensions.specificity < 7) {
    safeDirectives.push(
      "Replace generic passages with decision guidance supported by exact verified services, benefits, or cited sources already present; delete unsupported specificity instead of inventing it.",
    );
  }
  if (verdict.dimensions.opinions < 7) {
    safeDirectives.push(
      "Turn hedged advice into direct selection rules using only conditions already stated by the reader, verified packet, or cited source; do not add legal duties, timelines, prices, or outcomes.",
    );
  }
  if (verdict.dimensions.livedExperience < 7) {
    safeDirectives.push(
      "Explain practical tradeoffs between the verified offerings without claiming first-hand work. Any illustrative situation must be explicitly labelled hypothetical and must not assert an unverified workflow, frequency, incident, or result.",
    );
  }
  if (verdict.dimensions.hedgingFreedom < 7) {
    safeDirectives.push(
      "Remove filler, phantom citations, and vague claims. Make supported advice concise and direct; remove unsupported claims rather than strengthening their wording.",
    );
  }
  if (verdict.dimensions.competitorUse < 7) {
    safeDirectives.push(
      "Use a competitor only when its name and the exact compared attribute are supplied; otherwise discuss neutral evaluation criteria without characterising another provider.",
    );
  }
  if (verdict.dimensions.offeringUse < 7) {
    safeDirectives.push(
      "Tie recommendations to the exact verified offering names and approved benefits; do not infer how the business performs or combines those services.",
    );
  }
  for (const directive of safeDirectives.slice(0, 6)) {
    lines.push(`  • ${directive}`);
  }
  if (safeDirectives.length === 0) {
    lines.push(
      "  • Tighten the weakest prose using concrete specifics already present in verified facts or visible citations; introduce no new factual claim.",
    );
  }
  lines.push(
    "Keep all formatting/SEO requirements from the system prompt. Never invent first-person experience, customer outcomes, numbers, availability, credentials, or guarantees to raise the score.",
  );
  return lines.join("\n");
}

/**
 * Run the GPT-5 mini expert-voice judge. Never throws: on any error it returns
 * `errored: true` with a nominal overall of 10 — the critique gate treats an
 * errored verdict as score 0 when BLOG_CRITIQUE_FAIL_CLOSED is on, so a judge
 * outage blocks persistence rather than waving drafts through.
 */
export async function judgeExpertVoice(
  input: ExpertVoiceJudgeInput,
): Promise<ExpertVoiceVerdict> {
  try {
    const prose = stripHtmlForJudge(input.content);
    if (prose.length < 200) {
      // Too little to judge meaningfully — let it through rather than loop.
      return {
        overall: 10,
        dimensions: {
          specificity: 10,
          opinions: 10,
          livedExperience: 10,
          hedgingFreedom: 10,
          competitorUse: 10,
          offeringUse: 10,
        },
        critique: [],
        errored: true,
      };
    }

    const model = createBlogJudgeModel(0);
    const response = await model.invoke([
      { role: "user", content: buildExpertVoiceJudgeBrief(input) },
    ]);
    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const verdict = parseExpertVoiceVerdict(raw);
    const weights = getExpertVoiceWeights();
    return weights ? applyDimensionWeights(verdict, weights) : verdict;
  } catch (err) {
    console.error(
      "⚠️ Expert-voice judge failed non-fatally:",
      (err as Error).message,
    );
    return {
      overall: 10,
      dimensions: {
        specificity: 10,
        opinions: 10,
        livedExperience: 10,
        hedgingFreedom: 10,
        competitorUse: 10,
        offeringUse: 10,
      },
      critique: [],
      errored: true,
    };
  }
}
