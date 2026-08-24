import type { CanonicalBlogFactPacket } from "./canonical-blog-facts.service";

export interface BlogEvidenceBudget {
  requestedTarget: number;
  supportedTarget: number;
  target: number;
  min: number;
  max: number;
  capped: boolean;
  sufficient: boolean;
  counts: {
    businessClaims: number;
    ownedWebsiteClaims: number;
    ownedWebsiteEvidenceUnits: number;
    confirmedProfileClaims: number;
    authoritativeExternalClaims: number;
    authoritativeExternalEvidenceUnits: number;
    distinctSources: number;
  };
}

export class InsufficientBlogEvidenceError extends Error {
  readonly code = "INSUFFICIENT_BLOG_EVIDENCE";

  constructor(readonly budget: BlogEvidenceBudget) {
    super(
      `INSUFFICIENT_BLOG_EVIDENCE: only ${budget.counts.businessClaims} verified business claim(s) are available`,
    );
    this.name = "InsufficientBlogEvidenceError";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function evidenceUnitKey(
  claim: CanonicalBlogFactPacket["claims"][number],
): string {
  if (claim.sourceUrl) return claim.sourceUrl.toLowerCase().replace(/\/$/, "");
  const excerpt = (claim.evidenceExcerpt ?? claim.text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `no-source:${excerpt}`;
}

/**
 * Estimates how much article depth the current ledger can support. Basic
 * profile facts receive a small allowance; retrieved first-party passages and
 * authoritative educational claims receive more because they can support
 * explanation without asking the writer to invent connective facts.
 */
export function planEvidenceSupportedWordCount(input: {
  packet: CanonicalBlogFactPacket;
  requestedTarget: number;
}): BlogEvidenceBudget {
  const businessClaims = input.packet.claims.filter(
    (claim) => claim.classification === "business",
  );
  const ownedWebsiteClaims = businessClaims.filter(
    (claim) => claim.authority === "owned_website",
  );
  const confirmedProfileClaims = businessClaims.filter(
    (claim) =>
      claim.authority === "verified_profile" ||
      claim.authority === "user_confirmed",
  );
  const authoritativeExternalClaims = input.packet.claims.filter(
    (claim) =>
      claim.classification === "educational" &&
      claim.authority === "authoritative_external",
  );
  const ownedWebsiteEvidenceUnits = new Set(
    ownedWebsiteClaims.map(evidenceUnitKey),
  ).size;
  const authoritativeExternalEvidenceUnits = new Set(
    authoritativeExternalClaims.map(evidenceUnitKey),
  ).size;
  const distinctSources = new Set(
    input.packet.claims
      .map((claim) => claim.sourceUrl)
      .filter((source): source is string => Boolean(source)),
  );
  const requestedTarget = clamp(input.requestedTarget, 700, 9_500);
  // Weights recalibrated against measured closed-world supply (2026-07-14):
  // with the 100-words-per-passage weight a 7-source ledger claimed "1570
  // supported" while the writer could legitimately produce ~700 compliant
  // words — every run then died on the length gate. A passage sustains about
  // 60 grounded words once the grammar strips uncited industry padding, and a
  // short dense grounded page is honest (local SERP averages ~1,000 words).
  const supportedTarget = clamp(
    550 +
      Math.min(ownedWebsiteEvidenceUnits, 20) * 60 +
      Math.min(confirmedProfileClaims.length, 12) * 15 +
      // Authoritative research passages (Exa + .gov/.edu) fund long-form
      // depth: 32 cited passages sustain a ~6,500-word researched article.
      Math.min(authoritativeExternalEvidenceUnits, 32) * 185 +
      Math.min(distinctSources.size, 12) * 20,
    700,
    9_200,
  );
  // With general industry knowledge enabled (product decision 2026-07-14),
  // evidence no longer caps article LENGTH — the writer may fill depth with
  // generally-true industry content. Evidence still gates SUFFICIENCY (a
  // business with no verifiable facts is blocked) and business-fact accuracy.
  const generalKnowledge =
    process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED !== "false";
  const target = generalKnowledge
    ? requestedTarget
    : Math.min(requestedTarget, supportedTarget);
  const capped = target < requestedTarget;
  const sufficient =
    businessClaims.length >= 3 &&
    Boolean(input.packet.identity.businessName) &&
    (input.packet.services.length > 0 || ownedWebsiteClaims.length >= 2);

  return {
    requestedTarget,
    supportedTarget,
    target,
    // A capped target is an evidence ceiling, not a quota. Requiring the
    // writer to reach 85% after unsupported prose is removed rewards padding.
    min: Math.max(700, Math.round(target * (capped ? 0.7 : 0.85))),
    max: Math.max(850, Math.round(target * 1.15)),
    capped,
    sufficient,
    counts: {
      businessClaims: businessClaims.length,
      ownedWebsiteClaims: ownedWebsiteClaims.length,
      ownedWebsiteEvidenceUnits,
      confirmedProfileClaims: confirmedProfileClaims.length,
      authoritativeExternalClaims: authoritativeExternalClaims.length,
      authoritativeExternalEvidenceUnits,
      distinctSources: distinctSources.size,
    },
  };
}
