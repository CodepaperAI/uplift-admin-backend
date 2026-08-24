/**
 * offpage-quality.service.ts
 *
 * Pure quality scoring for off-page opportunities. The enrichers prove that a
 * target is real; this layer decides whether the target is useful enough to
 * show normally, should be shown with caution, or should be hidden.
 */

import type { RedditThread } from "../../utils/reddit-thread-finder";
import type {
  BusinessResearchBrief,
  DirectoryPricingModel,
  DirectorySubmissionType,
  OffPageEvidenceSource,
  OffPageSourceType,
  Opportunity,
  OpportunityConfidenceLevel,
} from "./offpage-types";

const BUYER_INTENT_PATTERNS = [
  /\brecommend(ation|ations|ed)?\b/i,
  /\bbest\b/i,
  /\blooking for\b/i,
  /\bneed (a|an|some|help|recommendations?)\b/i,
  /\bwhere (can|do|to)\b/i,
  /\bany(one|body)? (know|recommend|suggest)\b/i,
  /\bsuggestions?\b/i,
  /\bhiring\b/i,
  /\baffordable\b/i,
  /\bquote\b/i,
  /\bcost\b/i,
  /\bprice\b/i,
  /\bnear me\b/i,
];

const FOREIGN_LANGUAGE_HINTS = [
  /\bhvis\b/i,
  /\bsporgsmal\b/i,
  /\bspørgsmål\b/i,
  /\bjeg\b/i,
  /\bvil\b/i,
  /\bquelles?\b/i,
  /\bdonde\b/i,
  /\bmejor\b/i,
  /\bsuche\b/i,
  /\bempfehl/i,
];

function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function hostOf(url?: string | null): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isHttpUrl(url?: string | null): boolean {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function confidenceLevel(score: number): OpportunityConfidenceLevel {
  if (score >= 82) return "high";
  if (score >= 65) return "medium";
  if (score >= 50) return "needs_review";
  return "low";
}

export function hasBuyerIntent(title: string): boolean {
  return BUYER_INTENT_PATTERNS.some((pattern) => pattern.test(title));
}

function hasForeignLanguageSignal(title: string): boolean {
  return FOREIGN_LANGUAGE_HINTS.some((pattern) => pattern.test(title));
}

function uniqueEvidenceSources(
  ...sources: Array<OffPageEvidenceSource | OffPageEvidenceSource[] | null | undefined>
): OffPageEvidenceSource[] {
  const flattened = sources.flatMap((source) =>
    Array.isArray(source) ? source : source ? [source] : [],
  );
  return Array.from(new Set(flattened));
}

function productionEvidenceSource(source?: Opportunity["source"]): OffPageEvidenceSource {
  return source === "researched" ? "ai_research" : "baseline_seed";
}

function sentenceFromParts(parts: string[]): string {
  const clean = parts.map((part) => part.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  return `${clean.join("; ")}.`;
}

function redditWhyRecommended(
  opportunity: Opportunity,
  thread: RedditThread | undefined,
): string {
  const parts: string[] = [];
  if (thread?.buyerIntent) parts.push("The thread shows buyer intent");
  if (typeof thread?.commentCount === "number") {
    parts.push(`${thread.commentCount} visible comments indicate activity`);
  }
  if (typeof thread?.ageDays === "number") {
    if (thread.ageDays <= 45) parts.push("it is recent");
    else if (thread.ageDays <= 180) parts.push("it is still fresh enough to review");
  }
  if (thread?.detailCheckedAt) parts.push("the thread page was checked");
  if (opportunity.source === "researched") parts.push("it matches this business profile");
  if (opportunity.draft || opportunity.threads?.some((item) => item.draft)) {
    parts.push("a helpful reply draft is ready");
  }
  return (
    sentenceFromParts(parts) ||
    "This Reddit opportunity passed relevance and quality checks for the business."
  );
}

function directoryWhyRecommended(
  opportunity: Opportunity,
  target: DirectoryTarget,
  brief?: BusinessResearchBrief,
): string {
  const parts: string[] = [];
  if (target.submissionUrlType === "direct_claim") parts.push("A direct claim page is available");
  if (target.submissionUrlType === "add_business") parts.push("A direct add-listing page is available");
  if (opportunity.alreadyListed) parts.push("an existing listing was detected");
  if (target.pricingModel === "free") parts.push("the listing path appears free");
  if (target.pricingModel === "freemium") parts.push("the listing path has free/paid options");
  if (opportunity.priority >= 80) parts.push("the directory is a high-priority authority source");
  const locationSignal = directoryLocationSignal(brief);
  if (locationSignal) parts.push(locationSignal.toLowerCase());
  if (opportunity.source === "researched") parts.push("it matches this business profile");
  return (
    sentenceFromParts(parts) ||
    "This directory opportunity passed reachability and relevance checks for the business."
  );
}

export function scoreRedditThread(thread: RedditThread): RedditThread {
  const signals: string[] = [];
  const warnings: string[] = [];
  let score = 58;

  const buyerIntent = hasBuyerIntent(thread.title);
  if (buyerIntent) {
    score += 18;
    signals.push("Buyer-intent wording");
  } else {
    score -= 8;
    warnings.push("No clear buyer-intent wording");
  }

  if (typeof thread.commentCount === "number") {
    if (thread.commentCount >= 10) {
      score += 8;
      signals.push(`${thread.commentCount} comments`);
    } else if (thread.commentCount > 0) {
      score += 4;
      signals.push(`${thread.commentCount} comments`);
    } else {
      score -= 6;
      warnings.push("No visible discussion activity");
    }
  } else {
    warnings.push("Comment activity unavailable");
  }

  if (typeof thread.ageDays === "number") {
    if (thread.ageDays <= 45) {
      score += 12;
      signals.push("Recent thread");
    } else if (thread.ageDays <= 180) {
      score += 8;
      signals.push("Fresh enough to review");
    } else if (thread.ageDays <= 730) {
      score -= 4;
      warnings.push("Older thread");
    } else {
      score -= 18;
      warnings.push("Very old thread");
    }
  } else {
    warnings.push("Freshness unavailable");
  }

  if (thread.locked) {
    score -= 40;
    warnings.push("Thread appears locked");
  }
  if (thread.archived) {
    score -= 30;
    warnings.push("Thread appears archived");
  }
  if (thread.deleted) {
    score -= 60;
    warnings.push("Thread appears deleted or removed");
  }
  if (thread.unavailable) {
    score -= 60;
    warnings.push("Thread page appears unavailable");
  }
  if (thread.detailCheckedAt) {
    score += 4;
    signals.push("Thread page checked");
  } else {
    score -= 4;
    warnings.push("Thread detail check unavailable");
  }
  if (hasForeignLanguageSignal(thread.title)) {
    score -= 35;
    warnings.push("Possible non-English/mistranslated title");
  }

  const qualityScore = Math.round(clamp(score));
  return {
    ...thread,
    buyerIntent,
    qualityScore,
    qualitySignals: signals,
    qualityWarnings: warnings,
  };
}

export function rankRedditThreads(threads: RedditThread[]): RedditThread[] {
  return threads
    .map(scoreRedditThread)
    .filter((thread) => {
      if (thread.locked || thread.archived) return false;
      if (thread.deleted || thread.unavailable) return false;
      if (thread.qualityWarnings?.some((warning) => /non-English|mistranslated/i.test(warning))) {
        return false;
      }
      return (thread.qualityScore ?? 0) >= 50;
    })
    .sort(
      (a, b) =>
        (b.qualityScore ?? 0) - (a.qualityScore ?? 0) ||
        (b.commentCount ?? -1) - (a.commentCount ?? -1),
    );
}

export function applyRedditOpportunityQuality(
  opportunity: Opportunity,
  checkedAt = new Date(),
): Opportunity {
  const threads = (opportunity.threads ?? []).map(scoreRedditThread);
  const top = threads[0];
  const topScore = top?.qualityScore ?? 0;
  let score = topScore;
  const signals = [...(top?.qualitySignals ?? [])];
  const warnings = [...(top?.qualityWarnings ?? [])];

  if (threads.length >= 3) {
    score += 6;
    signals.push(`${threads.length} relevant threads found`);
  } else if (threads.length === 1) {
    warnings.push("Only one relevant thread found");
  }

  if (opportunity.draft || threads.some((t) => t.draft)) {
    score += 4;
    signals.push("Helpful reply draft prepared");
  }
  if (opportunity.source === "researched") {
    score += 4;
    signals.push("Matched to this business profile");
  }
  if (typeof opportunity.validatorScore === "number") {
    if (opportunity.validatorScore >= 0.75) {
      score += 4;
      signals.push("Passed strict reviewer");
    } else if (opportunity.validatorScore < 0.55) {
      score -= 8;
      warnings.push("Reviewer confidence is low");
    }
  } else {
    score -= 4;
    warnings.push("Reviewer score unavailable");
  }

  const confidence = Math.round(clamp(score));
  return {
    ...opportunity,
    threads,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    whyRecommended: opportunity.whyRecommended ?? redditWhyRecommended(opportunity, top),
    evidenceSources: uniqueEvidenceSources(
      opportunity.evidenceSources,
      productionEvidenceSource(opportunity.source),
      "live_search",
      threads.some((thread) => thread.detailCheckedAt) ? "thread_page" : null,
      typeof opportunity.validatorScore === "number" ? "strict_reviewer" : null,
    ),
    qualitySignals: Array.from(new Set([...(opportunity.qualitySignals ?? []), ...signals])),
    qualityWarnings: Array.from(new Set([...(opportunity.qualityWarnings ?? []), ...warnings])),
    lastCheckedAt: checkedAt.toISOString(),
    sourceType: "reddit_thread",
  };
}

export interface DirectoryTarget {
  submissionUrl: string;
  submissionUrlType: DirectorySubmissionType;
  pricingModel: DirectoryPricingModel;
  sourceType: OffPageSourceType;
  signal: string;
}

const DIRECTORY_TARGETS: Array<{
  hosts: RegExp[];
  target: DirectoryTarget;
}> = [
  {
    hosts: [/google\./],
    target: {
      submissionUrl: "https://www.google.com/business/",
      submissionUrlType: "direct_claim",
      pricingModel: "free",
      sourceType: "business_profile",
      signal: "Direct Google Business Profile claim page",
    },
  },
  {
    hosts: [/apple\.com/, /register\.apple\.com/],
    target: {
      submissionUrl: "https://businessconnect.apple.com/",
      submissionUrlType: "direct_claim",
      pricingModel: "free",
      sourceType: "business_profile",
      signal: "Direct Apple Business Connect claim page",
    },
  },
  {
    hosts: [/bingplaces\.com/],
    target: {
      submissionUrl: "https://www.bingplaces.com/",
      submissionUrlType: "direct_claim",
      pricingModel: "free",
      sourceType: "business_profile",
      signal: "Direct Bing Places claim page",
    },
  },
  {
    hosts: [/biz\.yelp\./, /yelp\./],
    target: {
      submissionUrl: "https://biz.yelp.com/",
      submissionUrlType: "direct_claim",
      pricingModel: "freemium",
      sourceType: "review_platform",
      signal: "Direct Yelp business-owner page",
    },
  },
  {
    hosts: [/trustpilot\.com/],
    target: {
      submissionUrl: "https://business.trustpilot.com/signup",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "review_platform",
      signal: "Direct Trustpilot business signup page",
    },
  },
  {
    hosts: [/foursquare\.com/],
    target: {
      submissionUrl: "https://foursquare.com/business/",
      submissionUrlType: "direct_claim",
      pricingModel: "free",
      sourceType: "directory",
      signal: "Direct Foursquare business page",
    },
  },
  {
    hosts: [/producthunt\.com/],
    target: {
      submissionUrl: "https://www.producthunt.com/products/new",
      submissionUrlType: "add_business",
      pricingModel: "free",
      sourceType: "marketplace",
      signal: "Direct Product Hunt product submission page",
    },
  },
  {
    hosts: [/crunchbase\.com/],
    target: {
      submissionUrl: "https://www.crunchbase.com/add-new",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "directory",
      signal: "Direct Crunchbase add-new page",
    },
  },
  {
    hosts: [/linkedin\.com/],
    target: {
      submissionUrl: "https://www.linkedin.com/company/setup/new/",
      submissionUrlType: "add_business",
      pricingModel: "free",
      sourceType: "business_profile",
      signal: "Direct LinkedIn company-page setup",
    },
  },
  {
    hosts: [/houzz\.com/],
    target: {
      submissionUrl: "https://www.houzz.com/getStartedPro",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "marketplace",
      signal: "Direct Houzz professional signup page",
    },
  },
  {
    hosts: [/thumbtack\.com/],
    target: {
      submissionUrl: "https://www.thumbtack.com/pro",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "marketplace",
      signal: "Direct Thumbtack pro signup page",
    },
  },
  {
    hosts: [/nextdoor\.com/],
    target: {
      submissionUrl: "https://business.nextdoor.com/local",
      submissionUrlType: "direct_claim",
      pricingModel: "freemium",
      sourceType: "marketplace",
      signal: "Direct Nextdoor local business page",
    },
  },
  {
    hosts: [/tripadvisor\.com/],
    target: {
      submissionUrl: "https://www.tripadvisor.com/GetListedNew",
      submissionUrlType: "add_business",
      pricingModel: "free",
      sourceType: "review_platform",
      signal: "Direct Tripadvisor get-listed page",
    },
  },
  {
    hosts: [/clutch\.co/],
    target: {
      submissionUrl: "https://clutch.co/vendors/new",
      submissionUrlType: "add_business",
      pricingModel: "free",
      sourceType: "review_platform",
      signal: "Direct Clutch vendor submission page",
    },
  },
  {
    hosts: [/capterra\.com/],
    target: {
      submissionUrl: "https://www.capterra.com/vendors/sign-up",
      submissionUrlType: "add_business",
      pricingModel: "free",
      sourceType: "review_platform",
      signal: "Direct Capterra vendor signup page",
    },
  },
  {
    hosts: [/g2\.com/],
    target: {
      submissionUrl: "https://sell.g2.com/",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "review_platform",
      signal: "Direct G2 vendor page",
    },
  },
  {
    hosts: [/yellowpages\.ca/],
    target: {
      submissionUrl: "https://www.yellowpages.ca/register-your-business",
      submissionUrlType: "add_business",
      pricingModel: "freemium",
      sourceType: "directory",
      signal: "Direct Yellow Pages Canada registration page",
    },
  },
];

export function getDirectorySubmissionTarget(url?: string | null): DirectoryTarget {
  const host = hostOf(url);
  for (const entry of DIRECTORY_TARGETS) {
    if (entry.hosts.some((pattern) => pattern.test(host))) return entry.target;
  }
  return {
    submissionUrl: url ?? "",
    submissionUrlType: url ? "homepage" : "unknown",
    pricingModel: "unknown",
    sourceType: "directory",
    signal: url ? "Directory page is reachable" : "Directory URL unavailable",
  };
}

function getOpportunityDirectoryTarget(opportunity: Opportunity): DirectoryTarget | null {
  if (!opportunity.submissionUrl || !opportunity.submissionUrlType) return null;
  return {
    submissionUrl: opportunity.submissionUrl,
    submissionUrlType: opportunity.submissionUrlType,
    pricingModel: opportunity.pricingModel ?? "unknown",
    sourceType: opportunity.sourceType ?? "directory",
    signal:
      opportunity.submissionUrlType === "direct_claim"
        ? "Direct claim page discovered"
        : opportunity.submissionUrlType === "add_business"
          ? "Direct add-listing page discovered"
          : "Submission page discovered",
  };
}

function directoryLocationSignal(brief?: BusinessResearchBrief): string | null {
  if (!brief) return null;
  const city = brief.location.city?.trim();
  const country = brief.location.country?.trim();
  if (city && country) return `Matched to ${city}, ${country}`;
  if (country) return `Matched to ${country}`;
  return null;
}

function meaningfulTokens(values: Array<string | null | undefined>): string[] {
  const stopwords = new Set([
    "best",
    "business",
    "company",
    "directory",
    "near",
    "online",
    "service",
    "services",
    "the",
    "your",
  ]);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of values) {
    for (const token of String(value ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < 4 || stopwords.has(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= 10) return tokens;
    }
  }
  return tokens;
}

function directoryCategorySignal(
  opportunity: Opportunity,
  target: DirectoryTarget,
  brief?: BusinessResearchBrief,
): string | null {
  const terms = meaningfulTokens([
    brief?.category,
    ...(brief?.services ?? []),
    ...(brief?.keywords ?? []),
  ]);
  const opportunityText = [
    opportunity.title,
    opportunity.rationale,
    opportunity.action,
    target.signal,
  ]
    .join(" ")
    .toLowerCase();
  const matched = terms.find((term) => opportunityText.includes(term));
  if (matched) return `Category fit matched "${matched}"`;
  if (opportunity.source === "researched") return "Selected from business/category research";
  if (target.sourceType === "business_profile") return "Core business profile fits this category";
  return null;
}

export function applyDirectoryOpportunityQuality(
  opportunity: Opportunity,
  brief?: BusinessResearchBrief,
  checkedAt = new Date(),
): Opportunity {
  const originalUrl = opportunity.url;
  const target = getOpportunityDirectoryTarget(opportunity) ?? getDirectorySubmissionTarget(originalUrl);
  const dynamicTarget = Boolean(getOpportunityDirectoryTarget(opportunity));
  const knownTarget = target.submissionUrlType === "direct_claim" || target.submissionUrlType === "add_business";
  const useTargetUrl = !opportunity.alreadyListed && target.submissionUrl;
  const signals = [
    ...(opportunity.qualitySignals ?? []),
    "Directory URL is live",
    target.signal,
  ];
  const warnings = [...(opportunity.qualityWarnings ?? [])];
  let score = 64;

  if (target.submissionUrlType === "direct_claim" || target.submissionUrlType === "add_business") {
    score += 16;
  } else {
    score -= 10;
    warnings.push("No direct submission page confirmed");
  }

  if (opportunity.alreadyListed) {
    score += 12;
    signals.push("Existing listing detected");
  }
  if (opportunity.source === "researched") {
    score += 5;
    signals.push("Matched to this business profile");
  }
  if (opportunity.priority >= 80) {
    score += 5;
    signals.push("High-priority authority source");
  } else if (opportunity.priority >= 60) {
    score += 2;
    signals.push("Moderate-priority relevance source");
  }
  const locationSignal = directoryLocationSignal(brief);
  if (locationSignal) {
    score += 3;
    signals.push(locationSignal);
  }
  const categorySignal = directoryCategorySignal(opportunity, target, brief);
  if (categorySignal) {
    score += 4;
    signals.push(categorySignal);
  } else {
    score -= 2;
    warnings.push("Category fit not explicit");
  }
  if (target.pricingModel === "paid") {
    score -= 6;
    warnings.push("May require paid placement");
  } else if (target.pricingModel === "unknown") {
    score -= 3;
    warnings.push("Pricing unknown");
  }
  if (typeof opportunity.validatorScore === "number") {
    if (opportunity.validatorScore >= 0.75) {
      score += 4;
      signals.push("Passed strict reviewer");
    } else if (opportunity.validatorScore < 0.55) {
      score -= 8;
      warnings.push("Reviewer confidence is low");
    }
  } else {
    score -= 3;
    warnings.push("Reviewer score unavailable");
  }

  const confidence = Math.round(clamp(score));
  return {
    ...opportunity,
    url: useTargetUrl ? target.submissionUrl : opportunity.url,
    originalUrl: originalUrl && originalUrl !== target.submissionUrl ? originalUrl : opportunity.originalUrl,
    submissionUrl: target.submissionUrl || undefined,
    submissionUrlType: target.submissionUrlType,
    pricingModel: target.pricingModel,
    sourceType: target.sourceType,
    whyRecommended: opportunity.whyRecommended ?? directoryWhyRecommended(opportunity, target, brief),
    evidenceSources: uniqueEvidenceSources(
      opportunity.evidenceSources,
      productionEvidenceSource(opportunity.source),
      "directory_reachability",
      dynamicTarget ? "directory_page_scan" : null,
      !dynamicTarget && knownTarget ? "known_submission_map" : null,
      opportunity.alreadyListed ? "already_listed_search" : null,
      typeof opportunity.validatorScore === "number" ? "strict_reviewer" : null,
    ),
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    qualitySignals: Array.from(new Set(signals.filter(Boolean))),
    qualityWarnings: Array.from(new Set(warnings.filter(Boolean))),
    lastCheckedAt: checkedAt.toISOString(),
  };
}

export function shouldShowOpportunity(opportunity: Opportunity): boolean {
  if (opportunity.leverKey !== "reddit" && opportunity.leverKey !== "directory") {
    return true;
  }
  if (
    opportunity.leverKey === "directory" &&
    (
      !isHttpUrl(opportunity.submissionUrl) ||
      (
        opportunity.submissionUrlType !== "direct_claim" &&
        opportunity.submissionUrlType !== "add_business"
      )
    )
  ) {
    return false;
  }
  const confidence = opportunity.confidence ?? 0;
  if (opportunity.confidenceLevel === "low") return false;
  return confidence >= 50;
}
