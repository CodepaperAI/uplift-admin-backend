/**
 * Deterministic grounding for generated blog content.
 *
 * The writer receives a compact allowlist instead of having to infer which
 * values inside the large onboarding payload are safe to state as facts. The
 * same packet is reused by the persistence gate, so prompt compliance is not
 * our only protection against invented business claims.
 */

import type { BusinessFacts } from "./business-facts.utils";
import {
  CANONICAL_BLOG_FACT_PACKET_VERSION,
  compileCanonicalBlogFacts,
  type CanonicalBusinessDataConflict,
  type CanonicalClaim,
  type CanonicalFactProvenance,
} from "../services/canonical-blog-facts.service";

export type GroundingSource =
  | "database"
  | "verified_geo"
  | "gmb"
  | "website"
  | "user_confirmed"
  | "user_selected";

export interface GroundedFact {
  kind:
    | "identity"
    | "contact"
    | "location"
    | "service"
    | "audience"
    | "benefit"
    | "operation";
  value: string;
  source: GroundingSource;
}

export interface LockedBlogFields {
  title?: string;
  seoTitle?: string;
}

export interface BlogGroundingPacket {
  version: typeof CANONICAL_BLOG_FACT_PACKET_VERSION;
  compiledAt: string;
  packetHash: string;
  status: "ready" | "blocked";
  businessName: string | null;
  website: string | null;
  description: string | null;
  authorName: string | null;
  phone: string | null;
  location: {
    verified: boolean;
    address: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    postalCode: string | null;
    coordinates: { lat: number; lng: number } | null;
  };
  serviceAreas: string[];
  services: string[];
  audiences: string[];
  approvedBenefits: string[];
  credentials: string[];
  operatingFacts: string[];
  businessHours: string[];
  reviews: Array<{
    reviewer: string | null;
    rating: number | null;
    text: string;
    source: "gmb";
  }>;
  reputationFacts: string[];
  locked: LockedBlogFields;
  regulatedTopic: "health" | "legal" | "financial" | null;
  /** Resolved, credible author for the E-E-A-T byline + deterministic bio. */
  author: { name: string; jobTitle: string; expertise: string[] };
  provenance: CanonicalFactProvenance[];
  conflicts: CanonicalBusinessDataConflict[];
  claims: CanonicalClaim[];
  facts: GroundedFact[];
}

export interface GroundingIssue {
  kind:
    | "phone"
    | "address"
    | "coordinates"
    | "price"
    | "hours"
    | "capacity"
    | "availability"
    | "guarantee"
    | "credential"
    | "experience"
    | "review"
    | "statistical_claim"
    | "competitor_claim"
    | "unsupported_business_claim"
    | "unsupported_general_claim"
    | "citation"
    | "regulatory_claim"
    | "regulated_advice"
    | "performance_claim";
  excerpt: string;
  reason: string;
}

export interface GroundingEvaluation {
  issues: GroundingIssue[];
  removedSchemaBlocks: number;
  sanitizedContent: string;
}

/**
 * HARD issue kinds are fabricated, verifiable facts that must NEVER reach
 * publication (real E-E-A-T / liability risk): invented contact details,
 * geography, pricing, fake reviews/credentials, and specific fabricated
 * operational numbers. These fail the gate closed.
 *
 * Operational promises, guarantees, and first-person customer experience are
 * also verifiable business claims. They fail closed unless the packet explicitly
 * authorizes them; confident prose is never a reason to invent business history.
 */
const HARD_GROUNDING_KINDS: ReadonlySet<GroundingIssue["kind"]> = new Set([
  "phone",
  "address",
  "coordinates",
  "price",
  "credential",
  "capacity",
  "review",
  "regulated_advice",
  "performance_claim",
  "hours",
  "availability",
  "guarantee",
  "experience",
  "regulatory_claim",
  "statistical_claim",
  "competitor_claim",
  "unsupported_business_claim",
  "unsupported_general_claim",
  "citation",
]);

export function isHardGroundingIssue(issue: GroundingIssue): boolean {
  // Knowledge mode (owner decision 2026-07-14): non-numeric brand-advocacy
  // outcome copy ("preventative cleaning keeps drains flowing") is standard
  // marketing on the business's own blog and the recommendation stance asks
  // for it — record it, don't block on it. Numeric performance stays hard via
  // the statistical/price checks, and everything else in the hard set is
  // unchanged.
  if (
    issue.kind === "performance_claim" &&
    process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED !== "false" &&
    !/\d/.test(issue.excerpt)
  ) {
    return false;
  }
  return HARD_GROUNDING_KINDS.has(issue.kind);
}

export function partitionGroundingIssues(issues: GroundingIssue[]): {
  hard: GroundingIssue[];
  soft: GroundingIssue[];
} {
  const hard: GroundingIssue[] = [];
  const soft: GroundingIssue[] = [];
  for (const issue of issues) {
    (isHardGroundingIssue(issue) ? hard : soft).push(issue);
  }
  return { hard, soft };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean : null;
}

function uniqueStrings(values: unknown[], max = 30): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const nested of uniqueStrings(value, max)) {
        const key = nested.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push(nested);
        }
        if (result.length >= max) return result;
      }
      continue;
    }
    const clean = cleanString(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= max) break;
  }
  return result;
}

function extractTextValues(value: unknown, max = 20): string[] {
  if (typeof value === "string") return uniqueStrings([value], max);
  if (Array.isArray(value)) {
    return uniqueStrings(
      value.flatMap((entry) => extractTextValues(entry, max)),
      max,
    );
  }
  if (!isRecord(value)) return [];
  return uniqueStrings(
    [
      value.title,
      value.name,
      value.label,
      value.description,
      value.credential,
      value.certification,
      value.award,
    ].flatMap((entry) => extractTextValues(entry, max)),
    max,
  );
}

function nestedRecord(record: UnknownRecord, key: string): UnknownRecord {
  return isRecord(record[key]) ? (record[key] as UnknownRecord) : {};
}

function resolveServices(business: UnknownRecord): string[] {
  const core = nestedRecord(business, "coreServices");
  const effective = nestedRecord(business, "effectiveServices");
  const detected = nestedRecord(business, "detectedServices");
  return uniqueStrings([
    business.selectedServices,
    core.topLevel,
    core.subOfferings,
    effective.topLevel,
    effective.subOfferings,
    detected.topLevel,
    detected.subOfferings,
  ]);
}

function resolveEnhancedBusinessInfo(business: UnknownRecord): UnknownRecord {
  return isRecord(business.enhancedBusinessInfo)
    ? business.enhancedBusinessInfo
    : {};
}

function formatBusinessHours(business: UnknownRecord): string[] {
  const hours = Array.isArray(business.GMBBusinessHours)
    ? business.GMBBusinessHours
    : [];
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const rows: string[] = [];
  for (const value of hours) {
    if (!isRecord(value) || typeof value.dayOfWeek !== "number") continue;
    const day = dayNames[value.dayOfWeek];
    if (!day) continue;
    if (value.isClosed === true) rows.push(`${day}: closed`);
    else if (value.is24Hours === true) rows.push(`${day}: open 24 hours`);
    else {
      const open = cleanString(value.openTime);
      const close = cleanString(value.closeTime);
      if (open && close) rows.push(`${day}: ${open}-${close}`);
    }
  }
  return uniqueStrings(rows, 14);
}

function extractReviews(
  business: UnknownRecord,
): BlogGroundingPacket["reviews"] {
  const gmb = nestedRecord(business, "GoogleMyBusiness");
  const candidates = Array.isArray(gmb.gmbReviews)
    ? gmb.gmbReviews
    : Array.isArray(business.gmbReviews)
      ? business.gmbReviews
      : [];
  const reviews: BlogGroundingPacket["reviews"] = [];
  for (const value of candidates) {
    if (!isRecord(value)) continue;
    const reviewerRecord = nestedRecord(value, "reviewer");
    const text = cleanString(
      value.reviewText ?? value.comment ?? value.text ?? value.review,
    );
    if (!text) continue;
    const ratingValue = value.rating ?? value.starRating;
    const rating =
      typeof ratingValue === "number" && Number.isFinite(ratingValue)
        ? ratingValue
        : typeof ratingValue === "string" && /^\d(?:\.\d)?$/.test(ratingValue)
          ? Number(ratingValue)
          : null;
    reviews.push({
      reviewer:
        cleanString(value.reviewerName) ??
        cleanString(value.authorName) ??
        cleanString(reviewerRecord.displayName),
      rating,
      text,
      source: "gmb",
    });
    if (reviews.length >= 5) break;
  }
  return reviews;
}

function extractReputationFacts(business: UnknownRecord): string[] {
  const analysis = nestedRecord(business, "GMBReviewAnalysis");
  const google = nestedRecord(business, "GoogleMyBusiness");
  const rating =
    analysis.averageRating ?? analysis.overallRating ?? google.averageRating;
  const count =
    analysis.totalReviewsAnalyzed ??
    analysis.totalReviews ??
    google.totalReviewCount;
  return uniqueStrings([
    typeof rating === "number" ? `Average rating: ${rating}` : null,
    typeof count === "number" ? `Review count: ${count}` : null,
  ]);
}

function detectRegulatedTopic(
  business: UnknownRecord,
): BlogGroundingPacket["regulatedTopic"] {
  const haystack = uniqueStrings([
    business.businessType,
    business.businessDescription,
    business.selectedServices,
    nestedRecord(business, "coreServices").topLevel,
    nestedRecord(business, "coreServices").industryFocus,
  ])
    .join(" ")
    .toLowerCase();
  if (
    /\b(dental|dentist|medical|health|clinic|physician|therapy|therapist|pharmacy|chiropract|optometr|healthcare)\b/.test(
      haystack,
    )
  ) {
    return "health";
  }
  if (/\b(law|lawyer|legal|attorney|paralegal)\b/.test(haystack))
    return "legal";
  if (
    /\b(financial|finance|investment|mortgage|accounting|accountant|tax advisor|wealth)\b/.test(
      haystack,
    )
  ) {
    return "financial";
  }
  return null;
}

function addFact(
  facts: GroundedFact[],
  kind: GroundedFact["kind"],
  value: string | null,
  source: GroundingSource,
): void {
  if (!value) return;
  if (
    facts.some(
      (fact) =>
        fact.kind === kind && fact.value.toLowerCase() === value.toLowerCase(),
    )
  ) {
    return;
  }
  facts.push({ kind, value, source });
}

export function buildBlogGroundingPacket(input: {
  business: unknown;
  businessLocation?: {
    businessCity?: string | null;
    businessState?: string | null;
    businessCountry?: string | null;
    businessAddress?: string | null;
    verified?: boolean;
    formattedAddress?: string | null;
    coordinates?: { lat: number; lng: number } | null;
    postalCode?: string | null;
    targetCity?: string | null;
  };
  scrapedFacts?: BusinessFacts | null;
  selectedTitle?: LockedBlogFields;
}): BlogGroundingPacket {
  const canonical = compileCanonicalBlogFacts({
    business: input.business,
    businessLocation: input.businessLocation,
    scrapedFacts: input.scrapedFacts,
  });

  const packet: BlogGroundingPacket = {
    version: canonical.version,
    compiledAt: canonical.compiledAt,
    packetHash: canonical.packetHash,
    status: canonical.status,
    businessName: canonical.identity.businessName,
    website: canonical.identity.website,
    description: canonical.identity.description,
    authorName: canonical.author.name,
    author: canonical.author,
    phone: canonical.contact.phone,
    location: canonical.location,
    serviceAreas: canonical.serviceAreas,
    services: canonical.services,
    audiences: canonical.audiences,
    approvedBenefits: canonical.approvedBenefits,
    credentials: canonical.credentials,
    operatingFacts: canonical.operatingFacts,
    businessHours: canonical.businessHours,
    reviews: canonical.reviews,
    reputationFacts: canonical.reputationFacts,
    locked: {
      title: cleanString(input.selectedTitle?.title) ?? undefined,
      seoTitle: cleanString(input.selectedTitle?.seoTitle) ?? undefined,
    },
    regulatedTopic: canonical.regulatedTopic,
    provenance: canonical.provenance,
    conflicts: canonical.conflicts,
    claims: canonical.claims,
    facts: canonical.provenance.flatMap((fact) => {
      if (fact.source === "legacy_inferred") return [];
      return [
        {
          kind:
            fact.kind === "credential" ||
            fact.kind === "review" ||
            fact.kind === "reputation"
              ? ("operation" as const)
              : fact.kind,
          value: fact.value,
          source: fact.source,
        },
      ];
    }),
  };

  return packet;
}

export function buildBlogGroundingPromptBlock(
  packet: BlogGroundingPacket,
): string {
  const promptPacket = {
    version: packet.version,
    packetHash: packet.packetHash,
    businessName: packet.businessName,
    website: packet.website,
    description: packet.description,
    authorName: packet.authorName,
    phone: packet.phone,
    location: packet.location,
    serviceAreas: packet.serviceAreas,
    services: packet.services,
    audiences: packet.audiences,
    approvedBenefits: packet.approvedBenefits,
    credentials: packet.credentials,
    operatingFacts: packet.operatingFacts,
    businessHours: packet.businessHours,
    reviews: packet.reviews,
    reputationFacts: packet.reputationFacts,
    locked: packet.locked,
    regulatedTopic: packet.regulatedTopic,
    allowedClaims: packet.claims.map((claim) => ({
      id: claim.id,
      type: claim.type,
      text: claim.text,
      sourceUrl: claim.sourceUrl,
      authority: claim.authority,
    })),
  };
  return [
    "VERIFIED BUSINESS FACTS - CLOSED WORLD CONTRACT",
    JSON.stringify(promptPacket, null, 2),
    "Rules:",
    "- Only the values above may be stated as facts about this business.",
    "- null or an empty array means unknown: omit it. Never complete a plausible value.",
    "- Never invent prices, schedules, appointment capacity, response times, phone numbers, addresses, coordinates, credentials, guarantees, statistics, or customer stories.",
    "- CONTACT NUMBERS: the ONLY phone number you may write is the exact 'phone' value above, copied digit-for-digit. If 'phone' is null, write NO phone number anywhere — never use a placeholder, example, or made-up number (e.g. 555-… or 604-XXX-XXXX). For a call-to-action without a verified number, say 'contact us' / 'reach our team' with no digits.",
    "- Quote reviews only from the reviews array, preserving the review text and reviewer attribution exactly. If it is empty, do not add testimonials or rating claims.",
    "- General educational claims may be used only when they do not imply this business performs or guarantees them; link sensitive factual claims to an authoritative tool-provided source.",
    "- For legal, regulatory, insurance, safety, medical, or financial topics, do not invent consequences, fines, liability, mandatory intervals, governing agencies, or compliance outcomes. If the supplied evidence does not contain the precise claim, use cautious general wording and direct the reader to the linked official source for current requirements.",
    "- Do not claim 'we worked with', 'we have seen', or other first-person experience unless that exact experience is present above.",
    "- Do not emit JSON-LD or schema markup. The application creates schema from verified fields after generation.",
    "- Copy locked title fields exactly. The application will enforce them before persistence.",
  ].join("\n");
}

const JSON_LD_BLOCK =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi;

export function stripModelGeneratedSchema(content: string): {
  content: string;
  removed: number;
} {
  let removed = 0;
  const stripped = String(content ?? "").replace(JSON_LD_BLOCK, () => {
    removed += 1;
    return "";
  });
  return { content: stripped.replace(/\n{3,}/g, "\n\n").trim(), removed };
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function hasAllowedValue(excerpt: string, allowed: string[]): boolean {
  const normalizedExcerpt = normalizeComparable(excerpt);
  return allowed.some((value) => {
    const normalizedValue = normalizeComparable(value);
    return (
      normalizedValue.length >= 2 && normalizedExcerpt.includes(normalizedValue)
    );
  });
}

/**
 * Every number in the excerpt must appear somewhere in the allowed corpus.
 * Whole-fact containment (hasAllowedValue) misses faithful paraphrases of
 * documented numeric facts — "serves 10 to 1,000 guests" was flagged as a
 * statistical claim even though both numbers sit in the claim ledger.
 */
function hasAllowedNumericValues(excerpt: string, allowed: string[]): boolean {
  const numbers = excerpt.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (numbers.length === 0) return false;
  const corpus = normalizeComparable(allowed.join(" "));
  return numbers.every((num) => corpus.includes(normalizeComparable(num)));
}

function hasAllowedOperationalSignal(
  excerpt: string,
  allowed: string[],
): boolean {
  const normalizedExcerpt = normalizeComparable(excerpt);
  const normalizedAllowed = normalizeComparable(allowed.join(" "));
  const signalPatterns = [
    /\b24 7\b/g,
    /\bsame day\b/g,
    /\bnext day\b/g,
    /\bwalk in\b/g,
    /\bimmediate(?:ly)?\b/g,
    /\bwithin \d+ (?:minute|minutes|hour|hours|day|days)\b/g,
    /\bguarantee(?:d|s)?\b/g,
    /\bmoney back\b/g,
    /\bwarranty\b/g,
    /\brisk free\b/g,
    /\bno risk\b/g,
  ];
  return signalPatterns.some((pattern) => {
    const matches = normalizedExcerpt.match(pattern) ?? [];
    return matches.some((match) => normalizedAllowed.includes(match));
  });
}

function isNegatedGuaranteeReference(excerpt: string): boolean {
  return splitProseSentences(excerpt).every((sentence) => {
    if (
      !/\b(?:guarantee(?:d|s)?|money[- ]back|warranty|risk[- ]free|no[- ]risk)\b/i.test(
        sentence,
      )
    ) {
      return true;
    }
    return /\b(?:not|never|without|avoid(?:ing)?|reject(?:ing)?|rather\s+than(?:\s+as)?|do(?:es)?\s+not|cannot|can't|should(?:n't|\s+not)|is(?:n't|\s+not)|are(?:n't|\s+not))\b[^.!?]{0,80}\b(?:guarantee(?:d|s)?|money[- ]back|warranty|risk[- ]free|no[- ]risk)\b/i.test(
      sentence,
    );
  });
}

function contentSegments(content: string): string[] {
  const matches = Array.from(
    content.matchAll(/<(p|li|td|th|h2|h3|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi),
    (match) => match[0],
  );
  return (matches.length ? matches : [content]).map(stripTags).filter(Boolean);
}

function modelProseSegments(content: string): string[] {
  return Array.from(
    content.matchAll(/<(p|li|td|th|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi),
    (match) => stripTags(match[0]),
  ).filter(Boolean);
}

function stripApplicationVerifiedBlocks(content: string): string {
  return content
    .replace(
      /<section\b[^>]*data-uplift-assembled=["']verified-business-facts["'][^>]*>[\s\S]*?<\/section>/gi,
      "",
    )
    .replace(
      /<(div|aside|nav)\b[^>]*data-uplift-assembled=["'][^"']+["'][^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(
      /<nav\b[^>]*data-uplift-component=["']article-toc["'][^>]*>[\s\S]*?<\/nav>/gi,
      "",
    );
}

function approvedNeutralBusinessHeadings(
  content: string,
  packet: BlogGroundingPacket,
): Set<string> {
  const headings = new Set<string>();
  for (const match of content.matchAll(
    /<(h2|h3)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
  )) {
    const attributes = match[2] ?? "";
    const text = stripTags(match[3] ?? "");
    if (!/\bdata-outline-id\s*=\s*["'][^"']+["']/i.test(attributes)) {
      continue;
    }
    if (!hasModelAuthoredBusinessCue(text, packet)) continue;
    if (
      /\b(?:guarantee(?:d|s)?|promises?|provides?|offers?|delivers?|ensures?|speciali[sz]es?|serves?|claims?|award[- ]winning|number\s+one|fastest|most\s+reliable|trusted\s+(?:team|provider)|expert\s+(?:team|provider))\b/i.test(
        text,
      )
    ) {
      continue;
    }
    headings.add(normalizeComparable(text));
  }
  return headings;
}

function hasModelAuthoredBusinessCue(
  value: string,
  packet: BlogGroundingPacket,
): boolean {
  const normalizedValue = normalizeComparable(value);
  const normalizedBusinessName = packet.businessName
    ? normalizeComparable(packet.businessName)
    : "";
  const namesBusiness = Boolean(
    normalizedBusinessName && normalizedValue.includes(normalizedBusinessName),
  );
  const speaksForBusiness =
    /\b(?:we|our|us|this\s+business|the\s+(?:business|company|team|provider))\b/i.test(
      value,
    );
  return namesBusiness || speaksForBusiness;
}

function hasFirstPersonBusinessVoice(value: string): boolean {
  return /\b(?:we|our|us)\b/i.test(value);
}

function hasClaimBackedBusinessStatement(
  value: string,
  packet: BlogGroundingPacket,
): boolean {
  const normalizedValue = normalizeComparable(value);
  const urls = value.match(/https?:\/\/[^\s]+/gi) ?? [];
  const valueTokens = new Set(
    normalizedValue
      .split(" ")
      .filter((token) => token.length >= 4 && !token.startsWith("http")),
  );

  const sourced = packet.claims.some((claim) => {
    if (
      claim.classification !== "business" ||
      !claim.sourceUrl ||
      !urls.some((url) => url.replace(/[).,;]+$/, "") === claim.sourceUrl)
    ) {
      return false;
    }
    const claimTokens = normalizeComparable(claim.evidenceExcerpt ?? claim.text)
      .split(" ")
      .filter((token) => token.length >= 4);
    if (claimTokens.length === 0) return false;
    const overlap = claimTokens.filter((token) =>
      valueTokens.has(token),
    ).length;
    return overlap >= Math.min(3, Math.ceil(claimTokens.length * 0.25));
  });
  if (sourced) return true;

  const normalizedBusinessName = normalizeComparable(packet.businessName ?? "");
  if (
    !normalizedBusinessName ||
    !normalizedValue.includes(normalizedBusinessName)
  ) {
    return false;
  }

  // Canonical service membership can be stated without re-citing a page, but
  // only as a short neutral listing statement. Any richer benefit, outcome, or
  // operational detail must use the sourced branch above.
  const exactServices = packet.services.filter((service) =>
    normalizedValue.includes(normalizeComparable(service)),
  );
  const neutralServiceStatement =
    exactServices.length > 0 &&
    normalizedValue.split(" ").length <= 35 &&
    /\b(?:lists?|offers?|includes?|provides?|services?|options?)\b/i.test(
      value,
    ) &&
    !/\b(?:best|better|leading|premier|top[- ]rated|trusted|superior|exceptional|world[- ]class|high[- ]quality|affordable|fast(?:est)?|reliable|guarantee(?:d|s)?|ensures?|results?)\b/i.test(
      value,
    );
  return neutralServiceStatement;
}

function hasUnsupportedModelBusinessClaim(
  value: string,
  packet: BlogGroundingPacket,
): boolean {
  if (!hasModelAuthoredBusinessCue(value, packet)) return false;
  if (hasFirstPersonBusinessVoice(value)) return true;
  return !hasClaimBackedBusinessStatement(value, packet);
}

/**
 * Remove model-authored business voice before consuming a repair attempt.
 *
 * Qwen can repeat a plausible business claim even after a targeted correction.
 * Claim-backed third-person statements are preserved; unsupported or first-person
 * blocks are safe to delete because the application inserts a canonical snapshot.
 * Headings are intentionally not removed: an unsupported heading must fail closed
 * so we cannot silently damage the approved outline.
 */
export function sanitizeModelAuthoredBusinessClaims(
  content: string,
  packet: BlogGroundingPacket,
): { content: string; removed: number } {
  const verifiedBlocks: string[] = [];
  let removed = 0;
  let output = String(content ?? "").replace(
    /<(section|div|aside)\b(?=[^>]*data-uplift-assembled=["'](?:verified-business-facts|section-evidence|key-takeaways|local-tip|reviews|author-bio)["'])[^>]*>[\s\S]*?<\/\1>/gi,
    (block) => {
      const index = verifiedBlocks.push(block) - 1;
      return `<!--UPLIFT_VERIFIED_BUSINESS_BLOCK_${index}-->`;
    },
  );

  output = output.replace(
    /<(p|li|td|th|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (block) => {
      if (!hasUnsupportedModelBusinessClaim(stripTags(block), packet))
        return block;
      removed += 1;
      return "";
    },
  );

  output = output.replace(
    /<!--UPLIFT_VERIFIED_BUSINESS_BLOCK_(\d+)-->/g,
    (_placeholder, index: string) => verifiedBlocks[Number(index)] ?? "",
  );
  output = output.replace(/(?:\r?\n\s*){3,}/g, "\n\n").trim();
  return { content: output, removed };
}

/**
 * Delete body blocks that contain hard grounding failures. This is deliberately
 * limited to prose/list/table/quote blocks. Titles and headings remain
 * fail-closed because silently deleting either would break search intent or the
 * approved outline.
 */
export function sanitizeHardGroundingBlocks(
  content: string,
  issues: GroundingIssue[],
): { content: string; removed: number } {
  if (issues.length === 0) return { content, removed: 0 };
  const excerpts = issues
    .map((issue) => normalizeComparable(issue.excerpt))
    .filter((excerpt) => excerpt.length >= 8);
  if (excerpts.length === 0) return { content, removed: 0 };

  const applicationBlocks: string[] = [];
  let removed = 0;
  let output = String(content ?? "")
    .replace(
      /<section\b[^>]*data-uplift-assembled=["']verified-business-facts["'][^>]*>[\s\S]*?<\/section>/gi,
      (block) => {
        const index = applicationBlocks.push(block) - 1;
        return `<!--UPLIFT_GROUNDED_APP_BLOCK_${index}-->`;
      },
    )
    .replace(
      /<div\b[^>]*data-uplift-assembled=["']author-bio["'][^>]*>[\s\S]*?<\/div>/gi,
      (block) => {
        const index = applicationBlocks.push(block) - 1;
        return `<!--UPLIFT_GROUNDED_APP_BLOCK_${index}-->`;
      },
    );

  output = output.replace(
    /<(p|li|td|th|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (block) => {
      const comparable = normalizeComparable(stripTags(block));
      const matchedIssues = issues.filter((issue) => {
        const excerpt = normalizeComparable(issue.excerpt);
        const probe = excerpt.slice(0, 120);
        return comparable.includes(probe) || probe.includes(comparable);
      });
      if (matchedIssues.length === 0) return block;

      if (
        matchedIssues.every(
          (issue) => issue.kind === "unsupported_general_claim",
        )
      ) {
        const remaining = splitProseSentences(stripTags(block)).filter(
          (sentence) => {
            const sentenceComparable = normalizeComparable(sentence);
            return !matchedIssues.some((issue) => {
              const issueComparable = normalizeComparable(issue.excerpt);
              const probe = issueComparable.slice(0, 120);
              return (
                sentenceComparable.includes(probe) ||
                probe.includes(sentenceComparable)
              );
            });
          },
        );
        removed += matchedIssues.length;
        if (remaining.length === 0) return "";
        const opening = block.match(/^<([a-z0-9]+)\b([^>]*)>/i);
        const tag = opening?.[1] ?? "p";
        const attributes = opening?.[2] ?? "";
        const escaped = remaining
          .join(" ")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<${tag}${attributes}>${escaped}</${tag}>`;
      }

      removed += 1;
      return "";
    },
  );

  output = output.replace(
    /<!--UPLIFT_GROUNDED_APP_BLOCK_(\d+)-->/g,
    (_placeholder, index: string) => applicationBlocks[Number(index)] ?? "",
  );
  output = output.replace(/(?:\r?\n\s*){3,}/g, "\n\n").trim();
  return { content: output, removed };
}

function pushIssue(issues: GroundingIssue[], issue: GroundingIssue): void {
  const key = `${issue.kind}:${issue.excerpt.toLowerCase()}`;
  if (
    issues.some(
      (entry) => `${entry.kind}:${entry.excerpt.toLowerCase()}` === key,
    )
  )
    return;
  issues.push({ ...issue, excerpt: issue.excerpt.slice(0, 240) });
}

function hasAllowedSourcedClaim(
  segment: string,
  claims: CanonicalClaim[],
): boolean {
  const urls = segment.match(/https?:\/\/[^\s]+/gi) ?? [];
  if (urls.length === 0) return false;
  const segmentTokens = new Set(
    normalizeComparable(segment)
      .split(" ")
      .filter((token) => token.length >= 4 && !token.startsWith("http")),
  );
  return claims.some((claim) => {
    if (
      !claim.sourceUrl ||
      claim.authority !== "authoritative_external" ||
      !urls.some((url) => url.replace(/[).,;]+$/, "") === claim.sourceUrl)
    ) {
      return false;
    }
    const claimTokens = normalizeComparable(claim.evidenceExcerpt ?? claim.text)
      .split(" ")
      .filter((token) => token.length >= 4);
    if (claimTokens.length === 0) return false;
    const overlap = claimTokens.filter((token) =>
      segmentTokens.has(token),
    ).length;
    // 50% token overlap penalized faithful PARAPHRASES of cited research —
    // the writer links the exact allowed source but rewords the finding, the
    // availability/performance checks then flag it, the sanitizer deletes it,
    // and the repair loop re-adds it forever. A segment that links an allowed
    // authoritative source and shares a third of its vocabulary is citing it.
    return overlap >= Math.min(3, Math.ceil(claimTokens.length * 0.34));
  });
}

const DECISION_ACTION =
  "ask|assess|avoid|base|calculate|check|choose|clarify|compare|confirm|consider|decide|define|determine|document|focus|identify|keep|list|look for|map|match|note|prioritize|rank|record|request|review|separate|set|start|treat|use|verify";
const DECISION_ACTION_PATTERN = new RegExp(`^(?:${DECISION_ACTION})\\b`, "i");
const CONDITIONAL_DECISION_PATTERN = new RegExp(
  `^(?:if|when|before|after|once|while)\\b[^,;:]{0,220}[,;:]\\s*(?:${DECISION_ACTION})\\b`,
  "i",
);
const READER_DECISION_PATTERN =
  /^(?:readers?|planners?|organizers?|decision[- ]makers?|buyers?|teams?|you)\s+(?:can|should|must|may)\s+(?:ask|assess|avoid|check|choose|clarify|compare|confirm|consider|decide|define|determine|document|identify|list|prioritize|record|request|review|start|verify)\b/i;
// Negative imperatives are verification guidance, not factual claims. Without
// this, "Do not assume pricing…" is flagged as an unsupported claim, the
// sanitizer deletes it, and any deterministic block that contains it (e.g. the
// rebuilt FAQ answer) is re-added and re-deleted forever.
const NEGATIVE_GUIDANCE_PATTERN = new RegExp(
  `^(?:do\\s+not|don['’]t|never)\\s+(?:${DECISION_ACTION}|assume|expect|rely(?:\\s+on)?|infer|presume|guess|extrapolate|generali[sz]e|commit|sign|book|pay|proceed|finali[sz]e|skip|overlook)\\b`,
  "i",
);
const EDITORIAL_FRAME_PATTERN =
  /^(?:a\s+(?:useful|practical|sensible)\s+(?:comparison|starting point|way|question|check|rule)|the\s+(?:key|deciding|final|first|next|primary)\s+(?:decision|choice|question|step|check|priority|constraint|selection)|your\s+(?:final\s+)?(?:decision|choice|comparison|priority|starting point|next step|shortlist|plan)|the\s+tradeoff\s+(?:is|to\s+(?:consider|compare|review))|this\s+(?:guide|section|checklist|comparison|process)|the\s+(?:decision|selection|comparison|planning)\s+process)\b/i;
const READER_CONTEXT_RECOMMENDATION_PATTERN = new RegExp(
  `^(?:for|in)\\b[^,;:]{0,220}[,;:]\\s*(?:(?:the\\s+(?:priority|starting point|next step|strongest choice)\\s+is\\s+to)|(?:${DECISION_ACTION})\\b)`,
  "i",
);
const UNSUPPORTED_EDITORIAL_OUTCOME_PATTERN =
  /\b(?:causes?|creates?|delivers?|encourages?|ensures?|fosters?|guarantees?|improves?|increases?|leads?\s+to|maximi[sz]es?|minimi[sz]es?|prevents?|produces?|reduces?|results?\s+in|secures?)\b/i;

function splitProseSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(cleanString)
    .filter((sentence): sentence is string => Boolean(sentence));
}

function isClosedWorldDecisionSentence(value: string): boolean {
  const sentence = value.trim();
  if (!sentence) return true;
  if (sentence.endsWith("?")) return true;
  if (DECISION_ACTION_PATTERN.test(sentence)) return true;
  if (NEGATIVE_GUIDANCE_PATTERN.test(sentence)) return true;
  if (CONDITIONAL_DECISION_PATTERN.test(sentence)) return true;
  if (READER_DECISION_PATTERN.test(sentence)) return true;
  if (READER_CONTEXT_RECOMMENDATION_PATTERN.test(sentence)) return true;
  if (EDITORIAL_FRAME_PATTERN.test(sentence)) {
    return !UNSUPPORTED_EDITORIAL_OUTCOME_PATTERN.test(sentence);
  }
  return false;
}

const CONTROLLED_DECISION_DIMENSIONS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern:
      /\b(?:allerg(?:y|ies|en|ens|enic)|cross[- ]contamination|cross[- ]contact|food safety)\b/i,
    label: "allergen or food-safety procedure",
  },
  {
    pattern:
      /\b(?:(?:heated|chilled) display units?|(?:hot )?holding (?:temperatures?|equipment)|heating (?:elements?|equipment)|open flames?|power sources?|chafing dishes?|fuel sources?|serving utensils?)\b/i,
    label: "food-holding or power equipment",
  },
  {
    pattern:
      /\b(?:kitchen access|preparation areas?|loading docks?|vendor access|external vendors?|insurance documentation|floor plans?|noise restrictions?|odor restrictions?|power access|power sources?|electrical capacity|traffic patterns?|building access|venue access|logistical delays?|setup(?:\s+(?:constraints?|duties|requirements?|buffer))?|cleanup(?:\s+(?:duties|protocol|responsibilities|services?))?)\b/i,
    label: "venue infrastructure",
  },
  {
    pattern:
      /\b(?:serviceware|replenishment|leftover (?:food|handling|policy)|food disposal|waste(?:\s+(?:bins?|disposal|management|removal))?|removal of waste|cleanup services?|last[- ]minute substitutions?|minimum orders?(?:\s+(?:requirements?|thresholds?))?)\b/i,
    label: "service operations",
  },
  {
    pattern:
      /\b(?:gratuity|gratuities|surcharges?|processing fees?|service fees?|labou?r fees?|logistical charges?|additional fees? associated with distance|staff ratios?|internal staffing|hidden costs? for (?:labou?r|rentals?)|deposits?|refund (?:eligibility|percentages?)|force majeure)\b/i,
    label: "fees or staffing operations",
  },
  {
    pattern:
      /\b(?:fully staffed|staffed (?:buffet|service)|plated (?:option|service)|drop[- ]off(?:\s+(?:model|service))?|on[- ]site management|dedicated personnel|individual packaging|shared platters?)\b/i,
    label: "undocumented service format",
  },
];

const UNSUPPORTED_EVIDENCE_INFERENCE_PATTERN =
  /\b(?:(?:may|might|can|could)\s+(?:indicate|imply|suggest)|(?:indicates?|implies?|signals?|suggests?)\s+(?:a|an|the|that)\s+(?:specific|general|broad|likely|clear|strong))\b/i;

function unsupportedDecisionDimension(
  sentence: string,
  packet: BlogGroundingPacket,
): string | null {
  const matched = CONTROLLED_DECISION_DIMENSIONS.find(({ pattern }) =>
    pattern.test(sentence),
  );
  if (!matched) return null;
  const supported = packet.claims.some((claim) =>
    matched.pattern.test(`${claim.text} ${claim.evidenceExcerpt ?? ""}`),
  );
  return supported ? null : matched.label;
}

function hasUnsupportedGeneralClaim(
  segment: string,
  packet: BlogGroundingPacket,
): boolean {
  if (hasAllowedSourcedClaim(segment, packet.claims)) return false;
  if (hasClaimBackedBusinessStatement(segment, packet)) return false;
  return splitProseSentences(segment).some(
    (sentence) => !isClosedWorldDecisionSentence(sentence),
  );
}

export function evaluateBlogGrounding(
  content: string,
  packet: BlogGroundingPacket,
  additionalBusinessClaims?: string,
): GroundingEvaluation {
  const sanitized = stripModelGeneratedSchema(content);
  const issues: GroundingIssue[] = [];
  const extraClaims = cleanString(additionalBusinessClaims);
  const modelContent = stripApplicationVerifiedBlocks(sanitized.content);
  const neutralBusinessHeadings = approvedNeutralBusinessHeadings(
    modelContent,
    packet,
  );
  const segments = [
    ...contentSegments(modelContent),
    ...(extraClaims ? [extraClaims] : []),
  ];
  for (const segment of modelProseSegments(modelContent)) {
    // Product decision (2026-07-14): generally-true industry knowledge is
    // allowed uncited — it is what fills useful long-form and what ranking
    // competitors publish. Business-specific facts (price, phone, services,
    // credentials, reviews, availability…) remain hard-gated by the dedicated
    // checks above regardless of this flag. Set
    // BLOG_GENERAL_KNOWLEDGE_ENABLED=false to restore the closed-world
    // grammar.
    if (process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED === "false") {
    for (const sentence of splitProseSentences(segment)) {
      if (UNSUPPORTED_EVIDENCE_INFERENCE_PATTERN.test(sentence)) {
        pushIssue(issues, {
          kind: "unsupported_general_claim",
          excerpt: sentence,
          reason:
            "A cited fact cannot be broadened into an inferred preference, outcome, or market conclusion.",
        });
        continue;
      }
      const unsupportedDimension = unsupportedDecisionDimension(
        sentence,
        packet,
      );
      if (unsupportedDimension) {
        pushIssue(issues, {
          kind: "unsupported_general_claim",
          excerpt: sentence,
          reason:
            `The ${unsupportedDimension} is not present in the assigned evidence. ` +
            "Questions and commands cannot introduce a new operational topic.",
        });
        continue;
      }
      if (!hasUnsupportedGeneralClaim(sentence, packet)) continue;
      if (isClosedWorldDecisionSentence(sentence)) continue;
      pushIssue(issues, {
        kind: "unsupported_general_claim",
        excerpt: sentence,
        reason:
          "Uncited model prose must be a question, verification instruction, conditional recommendation, or reader-owned decision analysis; explanatory factual claims require matching evidence.",
      });
    }
    }
  }
  const allowedOperations = packet.operatingFacts;
  const allowedBusinessClaims = uniqueStrings(
    [
      packet.description,
      packet.services,
      packet.approvedBenefits,
      packet.credentials,
      packet.operatingFacts,
      packet.businessHours,
      // The retrieved claim ledger IS the allowed corpus for richer business
      // detail — the writer contract says a claim may be faithfully restated
      // with its source URL. Without this, a verbatim-quoted, source-cited
      // ledger claim ("24/7 emergency plumbing") was flagged as an unverified
      // availability claim and deleted, re-added by the deterministic FAQ, and
      // deleted again — the loop never converged.
      packet.claims.map((claim) => claim.text),
    ],
    160,
  );
  const businessName = packet.businessName?.toLowerCase() ?? "";
  const businessCue = new RegExp(
    `\\b(?:we|our|us|clinic|office|practice|studio|company|restaurant|store|shop|team${businessName ? `|${businessName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : ""})\\b`,
    "i",
  );

  const allowedPhone = packet.phone ? digitsOnly(packet.phone) : "";
  const phoneMatches =
    sanitized.content.match(/(?:\+?\d[\d().\s-]{7,}\d)/g) ?? [];
  for (const phone of phoneMatches) {
    const digits = digitsOnly(phone);
    if (digits.length < 8 || (allowedPhone && digits === allowedPhone))
      continue;
    pushIssue(issues, {
      kind: "phone",
      excerpt: phone,
      reason: "Phone number is not present in the verified business packet.",
    });
  }

  const streetPattern =
    /\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.'-]*){0,5}\s+(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|court|ct\.?)\b/gi;
  for (const address of sanitized.content.match(streetPattern) ?? []) {
    if (
      packet.location.address &&
      normalizeComparable(packet.location.address).includes(
        normalizeComparable(address),
      )
    )
      continue;
    pushIssue(issues, {
      kind: "address",
      excerpt: address,
      reason: "Street address is missing from the verified geo packet.",
    });
  }

  const coordinatePattern = /\b-?\d{1,3}\.\d{3,}\s*[,/]\s*-?\d{1,3}\.\d{3,}\b/g;
  for (const coordinates of sanitized.content.match(coordinatePattern) ?? []) {
    const allowed = packet.location.coordinates
      ? `${packet.location.coordinates.lat},${packet.location.coordinates.lng}`
      : "";
    if (
      allowed &&
      normalizeComparable(coordinates) === normalizeComparable(allowed)
    )
      continue;
    pushIssue(issues, {
      kind: "coordinates",
      excerpt: coordinates,
      reason: "Coordinates are missing from the verified geo packet.",
    });
  }

  for (const segment of segments) {
    // Strict mode treats title/meta as business claims by definition. In
    // knowledge mode they are judged by actual business mention — a how-to
    // TITLE legitimately contains outcome verbs ("how to prevent drain
    // clogs"); flagging the keyword itself made the failure unrepairable.
    const businessSpecific =
      process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED === "false"
        ? segment === extraClaims || businessCue.test(segment)
        : businessCue.test(segment);
    const hasExternalCitation = hasAllowedSourcedClaim(segment, packet.claims);
    const allowedOperation = hasAllowedValue(segment, allowedOperations);

    const normalizedSegment = normalizeComparable(segment);
    if (
      segment !== extraClaims &&
      hasUnsupportedModelBusinessClaim(segment, packet) &&
      !neutralBusinessHeadings.has(normalizedSegment)
    ) {
      pushIssue(issues, {
        kind: "unsupported_business_claim",
        excerpt: segment,
        reason:
          "Model-authored prose may not speak for or make claims about the business; the application inserts verified business facts.",
      });
    }

    // Only flag a currency figure as an unverified BUSINESS PRICE when it sits in
    // a pricing context (per-unit, starting-from, quote/fee/rate…). A general
    // market/statistic figure like "$2 million industry" is NOT a business price
    // and must not hard-block the article (the prompt already discourages invented
    // stats; a cited stat carries an external link and is exempt).
    const pricingCue =
      /\b(?:per|each|only|from|starting|starts?\s+at|\/\s*(?:hr|hour|day|week|month|year|person|guest|head|vehicle|car|visit|clean|detail|service|session)|price[ds]?|pricing|cost[s]?|charge[ds]?|fee[s]?|rate[s]?|quote[ds]?|package[s]?|deposit|per\s+person)\b/i;
    if (
      /[$€£]\s?\d|\b(?:USD|CAD|EUR|GBP)\s?\d/i.test(segment) &&
      pricingCue.test(segment) &&
      !hasExternalCitation &&
      !allowedOperation
    ) {
      pushIssue(issues, {
        kind: "price",
        excerpt: segment,
        reason:
          "Price or currency value is not present in verified operating facts.",
      });
    }

    if (
      /\b\d+(?:\.\d+)?%\b|\b(?:study|survey|report|research)\s+(?:found|shows?|indicates?)\b|\b\d[\d,]+\+?\s+(?:customers?|businesses?|people|companies|cases|incidents|guests?|attendees?|portions?|orders?)\b|\b\d[\d,]*[-\s]?(?:minutes?|hours?|days?|weeks?|portions?|orders?)\b[^.!?]{0,80}\b(?:common|typical|standard|usual|customary)\b/i.test(
        segment,
      ) &&
      !hasExternalCitation &&
      !hasAllowedValue(segment, packet.reputationFacts) &&
      !hasAllowedNumericValues(segment, [
        ...packet.reputationFacts,
        ...packet.operatingFacts,
        ...packet.claims.map((claim) => claim.text),
      ])
    ) {
      pushIssue(issues, {
        kind: "statistical_claim",
        excerpt: segment,
        reason:
          "Statistical claim is not linked to an authoritative allowed claim.",
      });
    }

    if (
      /\b(?:competitors?|national\s+(?:providers?|companies)|other\s+(?:providers?|companies))\b[^.!?]{0,100}\b(?:offer|provide|lack|charge|cost|respond|serve|specialize|guarantee|use)\b/i.test(
        segment,
      ) &&
      !hasExternalCitation
    ) {
      pushIssue(issues, {
        kind: "competitor_claim",
        excerpt: segment,
        reason:
          "Competitor capability or performance claim is not present in the allowed claim ledger.",
      });
    }

    if (
      !hasExternalCitation &&
      /(?:\b(?:providers?|caterers?|vendors?|kitchens?)\b[^.!?]{0,100}\b(?:often|typically|usually|generally|commonly)\b[^.!?]{0,80}\b(?:offer|provide|tier|charge|require|maintain|guarantee|use|serve)\b)|(?:\bnot\s+all\s+(?:providers?|caterers?|vendors?|kitchens?)\b[^.!?]{0,80}\b(?:can|offer|provide|maintain|guarantee|use|serve)\b)/i.test(
        segment,
      )
    ) {
      pushIssue(issues, {
        kind: "competitor_claim",
        excerpt: segment,
        reason:
          "Generalized provider or industry capability claim lacks authoritative evidence.",
      });
    }

    if (
      !hasExternalCitation &&
      /\b(?:celiac(?:\s+disease)?|severe\s+(?:[a-z-]+\s+){0,3}(?:allerg(?:y|ies)|intolerance)|cross[- ]contact|allergen(?:[- ](?:free|safe)|\s+(?:matrix|signage|controls?))|segregation\s+protocol|dedicated\s+(?:prep|preparation|equipment|station|surface|fryer|utensils?|kitchen)|separate\s+cooking\s+equipment|shared\s+fryers?|trace\s+exposure|third[- ]party\s+audits?|temperature\s+danger\s+zone|hold\s+temperature|arrive\s+at\s+temperature|stay\s+chilled|dietary\s+integrity)\b/i.test(
        segment,
      )
    ) {
      pushIssue(issues, {
        kind: "regulated_advice",
        excerpt: segment,
        reason:
          "Medical, allergen, or food-safety guidance requires authoritative evidence.",
      });
    }

    if (
      !hasExternalCitation &&
      !allowedOperation &&
      // Knowledge mode: generic industry outcomes ("regular maintenance
      // prevents costly backups") are legitimate expertise; only claims about
      // THIS business's performance stay hard-gated.
      (process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED === "false" ||
        businessSpecific) &&
      /\b(?:faster|slower|more\s+efficient|less\s+expensive|reduces?|prevents?|avoids?|simplif(?:y|ies)|preserves?|improves?|maximi[sz]es?|minimi[sz]es?)\b/i.test(
        segment,
      )
    ) {
      pushIssue(issues, {
        kind: "performance_claim",
        excerpt: segment,
        reason:
          "Performance, efficiency, risk-reduction, or outcome claim lacks authoritative evidence.",
      });
    }

    if (
      businessSpecific &&
      /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:dedicated\s+)?(?:appointment|booking|emergency\s+slot|slot|patient|client|customer|order|project)s?\b/i.test(
        segment,
      ) &&
      !allowedOperation
    ) {
      pushIssue(issues, {
        kind: "capacity",
        excerpt: segment,
        reason: "Capacity or appointment-volume claim is not verified.",
      });
    }

    // Credentials: flag the specific credential TERM only when it is absent from
    // the verified corpus. Matching the whole segment against full benefit
    // sentences (the old approach) false-flagged true, paraphrased claims — e.g.
    // "our licensed guards" when "licensed" is right there in the description /
    // approvedBenefits. We now check each matched term against a combined corpus.
    const credentialTerms = businessSpecific
      ? (segment.match(
          /\b(?:award[- ]winning|board[- ]certified|certified|licensed|insured|background[- ]checked|accredited|specialist|\d+\s+years?\s+of\s+experience)\b/gi,
        ) ?? [])
      : [];
    if (credentialTerms.length) {
      const credentialCorpus = normalizeComparable(
        [
          packet.description ?? "",
          packet.businessName ?? "",
          ...packet.approvedBenefits,
          ...packet.credentials,
          ...packet.services,
          ...packet.operatingFacts,
        ].join(" "),
      );
      const unverified = credentialTerms.filter(
        (term) => !credentialCorpus.includes(normalizeComparable(term)),
      );
      if (unverified.length) {
        pushIssue(issues, {
          kind: "credential",
          excerpt: segment,
          reason: `Credential/award/experience claim not in verified facts: ${unverified.join(", ")}`,
        });
      }
    }

    if (
      /\b(?:we(?:'ve| have)?\s+(?:worked with|helped|served|seen)|our\s+(?:client|customer|patient)s?\b|in\s+our\s+experience)\b/i.test(
        segment,
      ) &&
      !hasAllowedValue(segment, allowedOperations)
    ) {
      pushIssue(issues, {
        kind: "experience",
        excerpt: segment,
        reason:
          "Customer story or first-person experience is not present in verified facts.",
      });
    }

    const timeClaim =
      /\b(?:call\s+(?:us|our\s+(?:office|clinic|team))|open|close|appointment|booking|available|availability|slot)[^.!?]{0,80}\b(?:\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)|by\s+\d{1,2}(?::\d{2})?)\b|\b(?:\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)|by\s+\d{1,2}(?::\d{2})?)\b[^.!?]{0,80}\b(?:open|close|appointment|booking|available|availability|slot)\b/i.test(
        segment,
      );
    if (
      businessSpecific &&
      timeClaim &&
      !hasAllowedValue(segment, packet.businessHours)
    ) {
      pushIssue(issues, {
        kind: "hours",
        excerpt: segment,
        reason: "Business hour or booking-time claim is not verified.",
      });
    }

    if (
      /\b(?:same[- ]day|next[- ]day|24\s*\/\s*7|walk[- ]in|immediate(?:ly)?|within\s+\d+\s+(?:minutes?|hours?|days?))\b/i.test(
        segment,
      ) &&
      // Knowledge mode: generic availability norms ("many providers offer
      // same-day service") are fine; only THIS business's availability
      // promises require verified backing.
      (process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED === "false" ||
        businessSpecific) &&
      !hasAllowedOperationalSignal(segment, allowedBusinessClaims)
    ) {
      pushIssue(issues, {
        kind: "availability",
        excerpt: segment,
        reason:
          "Availability or response-time claim is not in verified services or operating facts.",
      });
    }

    if (
      businessSpecific &&
      /\b(?:guarantee(?:d|s)?|money[- ]back|warranty|risk[- ]free|no[- ]risk)\b/i.test(
        segment,
      ) &&
      !isNegatedGuaranteeReference(segment) &&
      !hasAllowedOperationalSignal(segment, allowedBusinessClaims)
    ) {
      pushIssue(issues, {
        kind: "guarantee",
        excerpt: segment,
        reason:
          "Absolute or guaranteed business outcome is not an approved claim.",
      });
    }

    if (
      !hasExternalCitation &&
      !allowedOperation &&
      /\b(?:required|mandated)\s+(?:by|under)\b|\b(?:law|regulation|building\s+code|fire\s+code)\s+(?:requires?|mandates?)\b|\b(?:liable|liability|fines|penalt(?:y|ies)|violation)\b|\b(?:pay|face|incur|receive|avoid|subject\s+to)\s+(?:a\s+)?fine\b|\bfine\s+(?:of|up\s+to|for)\b|\b(?:maintain|ensure|meet)\s+(?:legal\s+|regulatory\s+)?compliance\b|\b(?:legal|regulatory)\s+(?:requirement|obligation|consequence)s?\b/i.test(
        segment,
      )
    ) {
      pushIssue(issues, {
        kind: "regulatory_claim",
        excerpt: segment,
        reason:
          "Legal, regulatory, liability, or mandated-compliance claim lacks a visible source or verified business fact.",
      });
    }

    if (
      packet.regulatedTopic === "health" &&
      !hasExternalCitation &&
      /\b(?:take|use)\s+(?:ibuprofen|acetaminophen|paracetamol|aspirin|antibiotics?)\b|\bcan\s+(?:usually\s+)?wait\b|\busually\s+(?:a\s+)?sign\s+of\b/i.test(
        segment,
      )
    ) {
      pushIssue(issues, {
        kind: "regulated_advice",
        excerpt: segment,
        reason:
          "Medical advice or diagnosis requires an authoritative citation and cautious wording.",
      });
    }
  }

  const reviewBlocks =
    sanitized.content.match(
      /<div\b[^>]*class\s*=\s*["'][^"']*\breviews\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ) ?? [];
  for (const block of reviewBlocks) {
    const excerpt = stripTags(block);
    const matchesVerifiedReview = packet.reviews.some((review) => {
      const quote = normalizeComparable(review.text).slice(0, 80);
      const reviewer = review.reviewer
        ? normalizeComparable(review.reviewer)
        : "";
      const normalizedBlock = normalizeComparable(excerpt);
      return (
        (quote.length >= 20 && normalizedBlock.includes(quote)) ||
        (reviewer.length >= 3 && normalizedBlock.includes(reviewer))
      );
    });
    if (!matchesVerifiedReview) {
      pushIssue(issues, {
        kind: "review",
        excerpt,
        reason:
          "Review or testimonial block does not match a verified GMB review.",
      });
    }
  }

  return {
    issues,
    removedSchemaBlocks: sanitized.removed,
    sanitizedContent: sanitized.content,
  };
}

/** True when two phone strings share the same last 10 digits (tolerates a
 * leading country code, spacing, and punctuation differences). */
function phoneDigitsMatch(a: string, b: string): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < 8 || db.length < 8) return false;
  return da.slice(-10) === db.slice(-10);
}

/**
 * TIER-1 AUTO-SANITIZE (deterministic, no model round-trip): neutralise
 * fabricated contact facts BEFORE grounding evaluation so they clean up silently
 * instead of hard-blocking an otherwise-good article.
 *   - phone: any number that is not the verified phone is REPLACED with the
 *     verified phone (turning a placeholder CTA into the correct one), or removed
 *     when no verified phone exists.
 *   - coordinates / street address: stripped unless they match verified geo.
 * Publishing is never fabricated, and no full regeneration is needed.
 */
export function sanitizeUnverifiedContacts(
  content: string,
  packet: BlogGroundingPacket,
): { content: string; phones: number; addresses: number; coordinates: number } {
  let phones = 0;
  let addresses = 0;
  let coordinates = 0;
  let out = String(content ?? "");
  const verifiedPhone = packet.phone ?? null;

  out = out.replace(/(\+?\d[\d().\s-]{7,}\d)/g, (match) => {
    if (digitsOnly(match).length < 8) return match; // years / ids, not a phone
    if (verifiedPhone && phoneDigitsMatch(match, verifiedPhone)) return match;
    phones++;
    return verifiedPhone ?? "";
  });

  out = out.replace(
    /\b-?\d{1,3}\.\d{3,}\s*[,/]\s*-?\d{1,3}\.\d{3,}\b/g,
    (match) => {
      const allowed = packet.location.coordinates
        ? `${packet.location.coordinates.lat},${packet.location.coordinates.lng}`
        : "";
      if (
        allowed &&
        normalizeComparable(match) === normalizeComparable(allowed)
      )
        return match;
      coordinates++;
      return "";
    },
  );

  const streetPattern =
    /\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.'-]*){0,5}\s+(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|court|ct\.?)\b/gi;
  out = out.replace(streetPattern, (match) => {
    if (
      packet.location.address &&
      normalizeComparable(packet.location.address).includes(
        normalizeComparable(match),
      )
    )
      return match;
    addresses++;
    return "";
  });

  // Tidy artifacts left by removals (double spaces, space-before-punctuation).
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1");
  return { content: out, phones, addresses, coordinates };
}

export function enforceLockedBlogFields(
  payload: {
    title: string;
    meta: { seo_title: string; og_title?: string };
  },
  locked: LockedBlogFields,
): void {
  if (locked.title) {
    payload.title = locked.title;
    payload.meta.og_title = locked.title;
  }
  if (locked.seoTitle) payload.meta.seo_title = locked.seoTitle;
}

export function buildGroundingRevisionMessage(
  issues: GroundingIssue[],
): string {
  const lines = issues
    .slice(0, 12)
    .map(
      (issue, index) =>
        `${index + 1}. [${issue.kind}] ${issue.reason}\n   Remove or rewrite: "${issue.excerpt}"`,
    );
  return [
    "GROUNDING CHECK FAILED. Keep the existing article and call save-blog-info again after changing ONLY the exact unsupported claims below.",
    "Delete each unsupported claim or rewrite it without the unverified fact. Do not replace it with a plausible alternative and do not add new claims. Use only the VERIFIED BUSINESS FACTS packet; when a value is missing, omit it or use explicitly conditional language.",
    "Do not emit JSON-LD/schema. Do not change locked title fields.",
    ...lines,
  ].join("\n");
}
