export const HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE =
  "HIGH_DR_GUEST_POSTING";
export const HIGH_AUTHORITY_MIN_DA = 40;
export const HIGH_AUTHORITY_MAX_SPAM_SCORE = 15;
export const HIGH_AUTHORITY_MAX_SUBMISSIONS_PER_DAY = 3;

type PublisherQualityInput = {
  id?: string;
  name?: string | null;
  domainAuthority?: number | null;
  domainRank?: number | null;
  monthlyTraffic?: number | null;
  spamScore?: number | null;
  niche?: string | null;
  contactEmail?: string | null;
  submissionUrl?: string | null;
  submissionGuidelines?: string | null;
  requiresPayment?: boolean | null;
  acceptsLinks?: boolean | null;
  linkTypesAllowed?: string[] | null;
  isVerified?: boolean | null;
  acceptanceRate?: number | null;
};

type CampaignQualityInput = {
  campaignTemplate?: string | null;
  targetNiche?: string | null;
  targetKeywords?: string[] | null;
  minDomainAuthority?: number | null;
  maxPublisherSpamScore?: number | null;
  requireNicheMatch?: boolean | null;
  requireVerifiedPublishers?: boolean | null;
  autoSendPitch?: boolean | null;
};

export type PublisherQualityEvaluation = {
  score: number;
  status: "QUALIFIED" | "NEEDS_REVIEW" | "BLOCKED";
  reasons: string[];
  warnings: string[];
  placementType: "EDITORIAL" | "SPONSORED" | "PAID";
  requiredLinkRel: "none" | "nofollow" | "sponsored";
  complianceStatus: "PENDING" | "APPROVED" | "BLOCKED";
  complianceNotes: string | null;
  canCreateSubmission: boolean;
  canGeneratePitch: boolean;
  canAutoSend: boolean;
};

export function isHighAuthorityCampaign(
  campaign?: CampaignQualityInput | null,
): boolean {
  if (!campaign) return false;
  return campaign.campaignTemplate === HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE;
}

export function getHighAuthorityCampaignDefaults() {
  return {
    campaignTemplate: HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE,
    minDomainAuthority: HIGH_AUTHORITY_MIN_DA,
    maxPublisherSpamScore: HIGH_AUTHORITY_MAX_SPAM_SCORE,
    maxSubmissionsPerDay: HIGH_AUTHORITY_MAX_SUBMISSIONS_PER_DAY,
    autoGeneratePitch: true,
    autoSendPitch: false,
    requireNicheMatch: true,
    requireVerifiedPublishers: true,
  };
}

export function evaluateGuestPostPublisher(
  publisher: PublisherQualityInput,
  campaign?: CampaignQualityInput | null,
): PublisherQualityEvaluation {
  const highAuthority = isHighAuthorityCampaign(campaign);
  const minDa =
    campaign?.minDomainAuthority ??
    (highAuthority ? HIGH_AUTHORITY_MIN_DA : 0);
  const maxSpam =
    campaign?.maxPublisherSpamScore ?? HIGH_AUTHORITY_MAX_SPAM_SCORE;
  const requireNiche = highAuthority || campaign?.requireNicheMatch === true;
  const requireVerified =
    highAuthority || campaign?.requireVerifiedPublishers === true;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let complianceStatus: PublisherQualityEvaluation["complianceStatus"] =
    "PENDING";
  let requiredLinkRel: PublisherQualityEvaluation["requiredLinkRel"] = "none";
  let placementType: PublisherQualityEvaluation["placementType"] = "EDITORIAL";

  const da = publisher.domainAuthority ?? normalizeDr(publisher.domainRank);
  if (da === null) {
    reasons.push("Domain authority is missing");
  } else if (da < minDa) {
    reasons.push(`Domain authority ${da} is below the required ${minDa}`);
  } else {
    score += Math.min(30, (da / 100) * 30);
  }

  if (typeof publisher.monthlyTraffic === "number") {
    score += Math.min(15, Math.log10(Math.max(publisher.monthlyTraffic, 1)) * 3);
  }

  if (typeof publisher.spamScore === "number") {
    if (publisher.spamScore > maxSpam) {
      reasons.push(
        `Spam score ${publisher.spamScore} is above the maximum ${maxSpam}`,
      );
    } else {
      score += Math.max(0, 15 - publisher.spamScore / 2);
    }
  } else {
    warnings.push("Spam score is missing");
  }

  if (requireNiche) {
    if (!publisher.niche || !campaign?.targetNiche) {
      reasons.push("Niche match is required");
    } else if (!hasNicheMatch(publisher.niche, campaign.targetNiche)) {
      reasons.push(`Publisher niche does not match ${campaign.targetNiche}`);
    } else {
      score += 15;
    }
  } else if (publisher.niche) {
    score += 8;
  }

  if (publisher.contactEmail || publisher.submissionUrl) {
    score += publisher.contactEmail ? 15 : 8;
  } else {
    reasons.push("Contact email or verified submission URL is required");
  }

  if (publisher.submissionGuidelines) {
    score += 8;
  } else {
    warnings.push("Submission guidelines are missing");
  }

  if (publisher.acceptanceRate && publisher.acceptanceRate > 0) {
    score += Math.min(7, publisher.acceptanceRate * 7);
  }

  const linkTypes = normalizeLinkTypes(publisher.linkTypesAllowed);
  if (publisher.requiresPayment) {
    placementType = "PAID";
    requiredLinkRel = linkTypes.has("nofollow") ? "nofollow" : "sponsored";
    if (!linkTypes.has("nofollow") && !linkTypes.has("sponsored")) {
      reasons.push("Paid dofollow placements are blocked from automation");
      complianceStatus = "BLOCKED";
    }
  } else if (linkTypes.has("sponsored")) {
    placementType = "SPONSORED";
    requiredLinkRel = "sponsored";
  }

  if (publisher.acceptsLinks === false) {
    reasons.push("Publisher does not accept links");
  }

  if (campaign?.targetKeywords?.length) {
    warnings.push(
      "Use branded or natural anchors; optimized-anchor guest post links need manual review",
    );
  }

  if (requireVerified && !publisher.isVerified) {
    reasons.push("Publisher must be verified before automation");
  } else if (publisher.isVerified) {
    score += 10;
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  const blocked = reasons.some((reason) =>
    [
      "below the required",
      "above the maximum",
      "Niche match",
      "does not match",
      "Contact email",
      "Paid dofollow",
      "does not accept links",
      "must be verified",
    ].some((needle) => reason.includes(needle)),
  );

  const reviewWarnings = warnings.filter(
    (warning) => !warning.startsWith("Use branded or natural anchors"),
  );
  const status = blocked
    ? "BLOCKED"
    : reviewWarnings.length > 0
      ? "NEEDS_REVIEW"
      : "QUALIFIED";

  if (complianceStatus !== "BLOCKED") {
    complianceStatus = status === "QUALIFIED" ? "APPROVED" : "PENDING";
  }

  const canGeneratePitch =
    status !== "BLOCKED" && Boolean(publisher.contactEmail);
  const canAutoSend =
    status === "QUALIFIED" &&
    complianceStatus === "APPROVED" &&
    Boolean(publisher.contactEmail) &&
    Boolean(publisher.isVerified);

  return {
    score,
    status,
    reasons,
    warnings,
    placementType,
    requiredLinkRel,
    complianceStatus,
    complianceNotes: [...reasons, ...warnings].join("; ") || null,
    canCreateSubmission: status === "QUALIFIED",
    canGeneratePitch,
    canAutoSend,
  };
}

export function buildSubmissionComplianceSnapshot(
  publisher: PublisherQualityInput,
  campaign?: CampaignQualityInput | null,
) {
  const evaluation = evaluateGuestPostPublisher(publisher, campaign);
  return {
    placementType: evaluation.placementType,
    requiredLinkRel: evaluation.requiredLinkRel,
    complianceStatus: evaluation.complianceStatus,
    complianceNotes: evaluation.complianceNotes,
    qualityScore: evaluation.score,
    qualityGateReasons: [
      ...evaluation.reasons,
      ...evaluation.warnings,
    ],
  };
}

function normalizeDr(domainRank: number | null | undefined): number | null {
  if (typeof domainRank !== "number") return null;
  return domainRank > 100 ? Math.round(domainRank / 10) : domainRank;
}

function normalizeLinkTypes(linkTypes: string[] | null | undefined) {
  return new Set((linkTypes ?? []).map((item) => item.toLowerCase()));
}

function hasNicheMatch(
  publisherNiche: string,
  targetNiche: string,
): boolean {
  const publisherTokens = tokenize(publisherNiche);
  const targetTokens = tokenize(targetNiche);
  if (publisherTokens.size === 0 || targetTokens.size === 0) return false;

  for (const token of targetTokens) {
    if (publisherTokens.has(token)) return true;
  }

  return publisherNiche
    .toLowerCase()
    .includes(targetNiche.toLowerCase());
}

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  );
}
