/**
 * blog-comparison.utils.ts
 *
 * Pure helpers to compare an OLD published blog against a freshly-generated
 * (dry-run) draft: how much each one actually uses the business's real
 * competitors/products, and a better/worse/similar verdict driven by the
 * expert-voice score with a substance-usage tie-break. No I/O — unit-tested.
 */

import type { ExpertVoiceDimensions } from "../services/expert-voice-judge.service";

function stripHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case-insensitive count of how many times `name` appears in `text`. */
export function countMentions(text: string, name: string): number {
  if (!text || !name) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(escaped, "gi"));
  return m ? m.length : 0;
}

/** Of the given names, which appear at least once in the (HTML) text. */
export function namesMentioned(html: string, names: string[]): string[] {
  const text = stripHtml(html);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    if (countMentions(text, n) > 0) out.push(n);
  }
  return out;
}

export interface DraftMetrics {
  voiceOverall: number;
  voiceDimensions: ExpertVoiceDimensions;
  competitorsMentioned: number;
  productsMentioned: number;
  wordCount: number;
}

export type ComparisonVerdict = "better" | "worse" | "similar";

export interface DraftComparison {
  voiceDelta: number;
  competitorDelta: number;
  productDelta: number;
  wordCountDelta: number;
  dimensionDeltas: Record<string, number>;
  verdict: ComparisonVerdict;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Verdict: driven by the expert-voice delta (>= +1 better, <= -1 worse). When
 * voice is similar, break the tie on real-substance usage (competitor +
 * product mentions): a net gain of 2+ is "better", a net loss of 2+ is "worse".
 */
export function compareDrafts(
  oldM: DraftMetrics,
  newM: DraftMetrics,
): DraftComparison {
  const voiceDelta = round(newM.voiceOverall - oldM.voiceOverall);
  const competitorDelta = newM.competitorsMentioned - oldM.competitorsMentioned;
  const productDelta = newM.productsMentioned - oldM.productsMentioned;
  const wordCountDelta = newM.wordCount - oldM.wordCount;

  const dimensionDeltas: Record<string, number> = {};
  for (const k of Object.keys(newM.voiceDimensions) as (keyof ExpertVoiceDimensions)[]) {
    dimensionDeltas[k] = round(
      newM.voiceDimensions[k] - oldM.voiceDimensions[k],
    );
  }

  let verdict: ComparisonVerdict;
  if (voiceDelta >= 1) {
    verdict = "better";
  } else if (voiceDelta <= -1) {
    verdict = "worse";
  } else {
    const substanceDelta = competitorDelta + productDelta;
    if (substanceDelta >= 2) verdict = "better";
    else if (substanceDelta <= -2) verdict = "worse";
    else verdict = "similar";
  }

  return {
    voiceDelta,
    competitorDelta,
    productDelta,
    wordCountDelta,
    dimensionDeltas,
    verdict,
  };
}

export interface AggregateComparison {
  total: number;
  better: number;
  worse: number;
  similar: number;
  avgVoiceDelta: number;
}

/** Roll up many comparisons into a headline result. */
export function aggregateComparisons(
  comparisons: DraftComparison[],
): AggregateComparison {
  const total = comparisons.length;
  if (total === 0) {
    return { total: 0, better: 0, worse: 0, similar: 0, avgVoiceDelta: 0 };
  }
  let better = 0;
  let worse = 0;
  let similar = 0;
  let voiceSum = 0;
  for (const c of comparisons) {
    if (c.verdict === "better") better++;
    else if (c.verdict === "worse") worse++;
    else similar++;
    voiceSum += c.voiceDelta;
  }
  return {
    total,
    better,
    worse,
    similar,
    avgVoiceDelta: round(voiceSum / total),
  };
}
