import { createHash } from "node:crypto";

import axios from "axios";
import * as cheerio from "cheerio";
import { fetchWithScraperAPI } from "../utils/tools.utils";

import type {
  CanonicalBlogFactPacket,
  CanonicalClaim,
  CanonicalClaimType,
  CanonicalEvidenceTag,
} from "./canonical-blog-facts.service";

export interface RetrievedClaimEvidence {
  url: string;
  title: string | null;
  excerpt: string;
  retrievedAt: string;
  authority?: "authoritative_external" | "owned_website";
  /** Deterministic retrieval score used to keep the most relevant duplicate. */
  relevanceScore?: number;
}

const AUTHORITATIVE_HOST =
  /(?:\.gov|\.edu|\.gc\.ca|\.gov\.uk|\.gov\.au|\.europa\.eu)$/i;
const SENSITIVE =
  /\b(?:law|legal|regulat\w*|compliance|mandatory|requir\w*|liabil\w*|fine|penalt\w*|insurance|medical|health|safety|financial|tax|price|cost|percent|statistics?)\b/i;
const FIRST_PARTY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const firstPartyCache = new Map<
  string,
  { at: number; evidence: RetrievedClaimEvidence[] }
>();

function normalize(value: string): string {
  // Strip leading list-bullet glyphs that leak from <li> extraction — they
  // otherwise surface verbatim in claim text ("• Resolve stubborn backups…").
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[•·▪◦‣–—-]\s*/, "");
}

function normalizeEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function evidenceTextKey(value: string): string {
  return normalize(value)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

export function deduplicateRetrievedClaimEvidence(
  evidence: RetrievedClaimEvidence[],
): RetrievedClaimEvidence[] {
  const byExcerpt = new Map<string, RetrievedClaimEvidence>();
  for (const candidate of evidence) {
    const excerpt = normalize(candidate.excerpt);
    if (!excerpt) continue;
    const key = evidenceTextKey(excerpt);
    const normalizedCandidate = {
      ...candidate,
      url: candidate.url.replace(/\/$/, ""),
      excerpt,
    };
    const existing = byExcerpt.get(key);
    if (
      !existing ||
      (normalizedCandidate.relevanceScore ?? 0) >
        (existing.relevanceScore ?? 0)
    ) {
      byExcerpt.set(key, normalizedCandidate);
    }
  }
  return [...byExcerpt.values()].sort(
    (left, right) =>
      (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
      normalizeEvidenceUrl(left.url).localeCompare(normalizeEvidenceUrl(right.url)),
  );
}

const SERVICE_MATCH_STOP_WORDS = new Set([
  "and",
  "best",
  "buy",
  "buying",
  "choose",
  "choosing",
  "complete",
  "comparison",
  "guide",
  "how",
  "options",
  "product",
  "products",
  "the",
  "for",
  "with",
  "service",
  "services",
  "fitness",
  "train",
  "training",
  "program",
  "programs",
  "room",
  "rooms",
]);

function matchToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const irregular: Record<string, string> = {
    classes: "class",
    memberships: "membership",
    services: "service",
    programs: "program",
    workouts: "workout",
    rooms: "room",
  };
  if (irregular[token]) return irregular[token]!;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function serviceMatchTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[^A-Za-z0-9]+/)
        .map(matchToken)
        .filter(
          (token) =>
            token.length >= 3 && !SERVICE_MATCH_STOP_WORDS.has(token),
        ),
    ),
  ];
}

/**
 * Returns the meaningful, lightly stemmed terms that bind article evidence to
 * its locked topic. Empty means the topic is intentionally broad (for example,
 * "services"), in which case callers may keep the existing broad inventory.
 */
export function topicMatchTokens(value: string): string[] {
  return serviceMatchTokens(value);
}

export function isTextRelevantToTopic(value: string, topic: string): boolean {
  const topicTokens = topicMatchTokens(topic);
  if (topicTokens.length === 0) return true;
  const valueTokens = new Set(serviceMatchTokens(value));
  return topicTokens.some((token) => valueTokens.has(token));
}

export function isClaimRelevantToTopic(
  claim: Pick<
    CanonicalClaim,
    | "text"
    | "evidenceExcerpt"
    | "sourceUrl"
    | "sourceTitle"
    | "sourceContext"
    | "type"
  >,
  topic: string,
  options?: { allowLocation?: boolean },
): boolean {
  if (
    options?.allowLocation === false &&
    claim.type === "business_location"
  ) {
    return false;
  }
  return isTextRelevantToTopic(
    [
      claim.text,
      claim.evidenceExcerpt,
      claim.sourceTitle,
      claim.sourceContext,
      claim.sourceUrl,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
    topic,
  );
}

export function claimSupportsService(
  claim: Pick<CanonicalClaim, "text" | "evidenceExcerpt">,
  service: string,
): boolean {
  const serviceTokens = serviceMatchTokens(service);
  if (serviceTokens.length === 0) return false;
  const claimTokens = new Set(
    serviceMatchTokens(claim.evidenceExcerpt ?? claim.text),
  );
  const overlap = serviceTokens.filter((token) => claimTokens.has(token)).length;
  return overlap >= (serviceTokens.length >= 3 ? 2 : 1);
}

export function getEvidenceBackedServices(
  packet: CanonicalBlogFactPacket,
): string[] {
  const ownedEvidence = packet.claims.filter(
    (claim) =>
      claim.authority === "owned_website" &&
      Boolean(claim.sourceUrl) &&
      Boolean(normalize(claim.evidenceExcerpt ?? claim.text)),
  );
  return packet.services.filter((service) =>
    ownedEvidence.some((claim) => claimSupportsService(claim, service)),
  );
}

export function getTopicRelevantEvidenceBackedServices(
  packet: CanonicalBlogFactPacket,
  topic: string,
): string[] {
  const services = getEvidenceBackedServices(packet);
  const topicTokens = topicMatchTokens(topic);
  if (topicTokens.length === 0) return services;
  return services.filter((service) => isTextRelevantToTopic(service, topic));
}

/**
 * Reject obvious scrape fragments before they can become first-party claims.
 * A valid price may be terse ("$508" or "99 USD"), but an orphaned zero/cents
 * fragment ("00 USD", ".00 CAD") is never useful evidence.
 */
export function isMalformedPriceEvidence(value: string): boolean {
  const text = normalize(value);
  if (!text) return true;
  if (/\bunit\s+price\b[\s/:|-]*(?:\/?\s*per\s+sale)\b/i.test(text)) {
    return true;
  }
  const currency =
    /(?:[$€£¥]|\b(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\b)/i.test(text);
  if (!currency) return false;
  if (
    /^\.?0+(?:[.,]0+)?\s*(?:USD|CAD|AUD|NZD|EUR|GBP|JPY)\b/i.test(text)
  ) {
    return true;
  }
  if (/^(?:[$€£¥]\s*)?0+(?:[.,]0+)?(?:\s|$)/.test(text)) {
    return true;
  }
  return false;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Reputable informational hosts whose passages are citable as neutral
 * industry knowledge (the Exa research channel). Local competitor sites must
 * never become "authority" citations, so this stays an explicit allowlist. */
const REPUTABLE_INFORMATIONAL_HOST =
  /(?:^|\.)(?:wikipedia\.org|britannica\.com|thespruce\.com|familyhandyman\.com|bobvila\.com|thisoldhouse\.com|angi\.com|houzz\.com|forbes\.com|consumerreports\.org|healthline\.com|webmd\.com|mayoclinic\.org|investopedia\.com|hbr\.org|entrepreneur\.com|foodnetwork\.com|seriouseats\.com|restaurantscanada\.org)$/i;

export function isReputableInformationalHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return REPUTABLE_INFORMATIONAL_HOST.test(host) || host.endsWith(".org");
  } catch {
    return false;
  }
}

export function isAuthoritativeEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return (
      AUTHORITATIVE_HOST.test(host) ||
      host === "canada.ca" ||
      host.endsWith(".canada.ca") ||
      host.endsWith(".gov.bc.ca") ||
      host === "ontario.ca" ||
      host.endsWith(".ontario.ca")
    );
  } catch {
    return false;
  }
}

function inferClaimType(excerpt: string): CanonicalClaimType {
  if (/\b(?:law|legal|regulat\w*|compliance|mandatory|requir\w*|fine|penalt\w*)\b/i.test(excerpt)) {
    return "regulatory";
  }
  if (/\b(?:\d+(?:\.\d+)?%|statistics?|study found|survey)\b/i.test(excerpt)) {
    return "statistical";
  }
  return "educational";
}

const OWNED_PROMOTIONAL_MODIFIERS =
  /\b(?:exclusive|robust|seamless|frictionless|highly targeted|expert[- ]led|affordable|effortless|wellness[- ]forward)\b/gi;
const OWNED_UNVERIFIABLE_CREDENTIAL =
  /\b(?:certified|certification|credential(?:ed|s)?|nationally recognized|accredited|licensed)\b/i;
const OWNED_OUTCOME_CLAUSE =
  /(?:,\s*|\s+)(?:which\s+)?(?:ensuring|guaranteeing|allowing|helping|enabling|preventing|avoiding)\b[\s\S]*$/i;
const OWNED_PURPOSE_CLAUSE =
  /\s+(?:to|so (?:that )?(?:you|members?) can)\s+(?:ensure|guarantee|achieve|reach|maximi[sz]e|avoid|prevent|improve|boost|transform|maintain|build|deliver)\b[\s\S]*$/i;
const OWNED_UNSUPPORTED_OUTCOME =
  /\b(?:guarantee(?:d|s)?|ensures?|results? quickly|lifelong skills?|immediate (?:access|entry|results?)|without friction|on time|best|superior)\b/i;

function atomicOwnedEvidenceClaims(excerpt: string): Array<{
  text: string;
  evidenceExcerpt: string;
}> {
  return (excerpt.match(/[^.!?]+[.!?]?/g) ?? [excerpt])
    .map((sentence) => normalize(sentence))
    .filter((sentence) => sentence.length >= 20)
    .slice(0, 4)
    .flatMap((sentence) => {
      if (OWNED_UNVERIFIABLE_CREDENTIAL.test(sentence)) return [];
      const text = normalize(
        sentence
          .replace(OWNED_OUTCOME_CLAUSE, "")
          .replace(OWNED_PURPOSE_CLAUSE, "")
          .replace(OWNED_PROMOTIONAL_MODIFIERS, " "),
      ).replace(/[,;:]$/, "");
      if (text.length < 20 || OWNED_UNSUPPORTED_OUTCOME.test(text)) return [];
      return [
        {
          text: /[.!?]$/.test(text) ? text : `${text}.`,
          evidenceExcerpt: sentence,
        },
      ];
    });
}

export function classifyClaimEvidenceTags(
  value: string,
): CanonicalEvidenceTag[] {
  const text = normalize(value).toLowerCase();
  const tags: CanonicalEvidenceTag[] = [];
  const add = (tag: CanonicalEvidenceTag) => {
    if (!tags.includes(tag)) tags.push(tag);
  };

  if (/\$|\b(?:price|pricing|cost|priced|per person|per guest|surcharge|fee)\b/.test(text)) {
    add("pricing");
  }
  if (/\b(?:guest|guests|people|persons|attendees|capacity|seats?|pax)\b/.test(text)) {
    add("capacity");
  }
  if (/\b(?:advance|notice|lead time|book|booking|reserve|reservation|quote)\b/.test(text)) {
    add("booking");
  }
  if (/\b(?:deliver|delivery|pickup|service area|across the city|across toronto|gta[- ]wide)\b/.test(text)) {
    add("delivery");
  }
  if (/\b(?:same[- ]day|available|availability|delivery window|open|hours?)\b/.test(text)) {
    add("availability");
  }
  if (/\b(?:halal|kosher|vegan|vegetarian|gluten|dairy|nut[- ]free|dietary|allerg)\b/.test(text)) {
    add("dietary");
  }
  if (/\b(?:salad|shawarma|souvlaki|kebab|falafel|hummus|tabbouleh|fattoush|baklava|rice|pita|dressings?|toppings?|protein|menu|buffet|feast|package)\b/.test(text)) {
    add("menu");
  }
  if (/\b(?:office|corporate|wedding|event|gathering|family|groups?|lunch|meeting|celebration)\b/.test(text)) {
    add("audience");
  }
  if (/\b(?:founded|established|since)\s+(?:19|20)\d{2}\b/.test(text)) {
    add("history");
  }
  if (/\b(?:certified|licensed|accredited|award|credential)\b/.test(text)) {
    add("credential");
  }
  if (/\b(?:toronto|mississauga|brampton|ontario|college st|financial district|yorkville|liberty village)\b/.test(text)) {
    add("location");
  }
  if (/\b(?:service|services|cater|catering|training|membership|consultation|class|workout)\b/.test(text)) {
    add("service");
  }
  return tags.length > 0 ? tags : ["service"];
}

function claimTypeForEvidenceTags(
  tags: CanonicalEvidenceTag[],
): CanonicalClaimType {
  if (tags.includes("location")) return "business_location";
  if (
    tags.some((tag) =>
      [
        "pricing",
        "capacity",
        "booking",
        "delivery",
        "dietary",
        "availability",
        "history",
      ].includes(tag),
    )
  ) {
    return "business_operation";
  }
  if (tags.includes("audience") && !tags.includes("service")) {
    return "business_audience";
  }
  return "business_service";
}

export function buildAllowedClaimLedger(input: {
  packet: CanonicalBlogFactPacket;
  evidence?: RetrievedClaimEvidence[];
}): CanonicalClaim[] {
  const claims = [...input.packet.claims];
  const seen = new Set(claims.map((claim) => claim.id));

  for (const evidence of deduplicateRetrievedClaimEvidence(input.evidence ?? [])) {
    const excerpt = normalize(evidence.excerpt);
    const isOwnedWebsite = evidence.authority === "owned_website";
    if (
      !excerpt ||
      isMalformedPriceEvidence(excerpt) ||
      (!isOwnedWebsite &&
        !isAuthoritativeEvidenceUrl(evidence.url) &&
        !isReputableInformationalHost(evidence.url))
    ) {
      continue;
    }
    const externalType = inferClaimType(excerpt);
    // High-stakes topics (legal/medical/safety/insurance) stay locked to
    // .gov/.edu sources. Money benchmarks and statistics from vetted
    // informational hosts (Angi cost ranges, industry stats) are citable
    // industry knowledge — dropping them was discarding the most valuable
    // long-form fuel Exa retrieves.
    const HIGH_STAKES =
      /\b(?:law|legal|regulat\w*|compliance|mandatory|requir\w*|liabil\w*|fine|penalt\w*|insurance|medical|health|safety)\b/i;
    if (
      !isOwnedWebsite &&
      externalType === "educational" &&
      (HIGH_STAKES.test(excerpt)
        ? !isAuthoritativeEvidenceUrl(evidence.url)
        : SENSITIVE.test(excerpt) &&
          !isAuthoritativeEvidenceUrl(evidence.url) &&
          !isReputableInformationalHost(evidence.url))
    ) {
      continue;
    }
    const atomicClaims = isOwnedWebsite
      ? atomicOwnedEvidenceClaims(excerpt)
      : [{ text: excerpt, evidenceExcerpt: excerpt }];
    for (const atomic of atomicClaims) {
      const evidenceTags = isOwnedWebsite
        ? classifyClaimEvidenceTags(`${atomic.text} ${evidence.url}`)
        : externalType === "regulatory"
          ? (["regulatory"] as CanonicalEvidenceTag[])
          : externalType === "statistical"
            ? (["statistical"] as CanonicalEvidenceTag[])
            : (["educational"] as CanonicalEvidenceTag[]);
      const type = isOwnedWebsite
        ? claimTypeForEvidenceTags(evidenceTags)
        : externalType;
      const id = `claim_${hash({ url: evidence.url, text: atomic.text }).slice(0, 16)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      claims.push({
        id,
        type,
        text: atomic.text,
        classification: isOwnedWebsite ? "business" : "educational",
        factIds: [],
        sourceUrl: evidence.url,
        authority: isOwnedWebsite ? "owned_website" : "authoritative_external",
        evidenceExcerpt: atomic.evidenceExcerpt,
        evidenceTags,
        sourceTitle: evidence.title,
        sourceContext: excerpt,
        sourceRelevance: evidence.relevanceScore ?? null,
      });
    }
  }
  return claims;
}

function publicWebsiteUrl(value: string): URL | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

const OFF_INTENT_EVENT_TERMS = [
  "birthday",
  "conference",
  "eid",
  "funeral",
  "holiday",
  "iftar",
  "ramadan",
  "wedding",
];

function hasUnrequestedSpecificIntent(url: string, keyword: string): boolean {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  const query = keyword.toLowerCase();
  return OFF_INTENT_EVENT_TERMS.some(
    (term) => path.includes(term) && !query.includes(term),
  );
}

function scoreFirstPartyUrl(input: {
  pathname: string;
  label: string;
  keywordTokens: string[];
  serviceTokens: string[];
  isRoot: boolean;
}): number {
  const haystack = `${input.pathname} ${input.label}`.toLowerCase();
  const keywordScore = input.keywordTokens.reduce(
    (total, token) => total + (haystack.includes(token) ? 4 : 0),
    0,
  );
  const serviceScore = input.serviceTokens.reduce(
    (total, token) => total + (haystack.includes(token) ? 1 : 0),
    0,
  );
  const servicePageBonus =
    /\b(?:catering|classes|corporate|membership|programs|services|training|workouts)\b/i.test(
      haystack,
    )
      ? 3
      : 0;
  const offIntentPenalty = OFF_INTENT_EVENT_TERMS.some(
    (term) =>
      haystack.includes(term) && !input.keywordTokens.includes(matchToken(term)),
  )
    ? 8
    : 0;
  const genericPagePenalty =
    /\b(?:about|about-us|contact|faq|gallery|team)\b/i.test(haystack) &&
    !input.keywordTokens.some((token) => haystack.includes(token))
      ? 5
      : 0;
  return (
    keywordScore +
    serviceScore +
    servicePageBonus +
    (input.isRoot ? 2 : 0) -
    offIntentPenalty -
    genericPagePenalty
  );
}

export function rankFirstPartyEvidenceUrls(input: {
  website: string;
  navigation?: Array<{ text?: string | null; url?: string | null }>;
  keyword: string;
  serviceNames: string[];
  maxPages: number;
}): string[] {
  const base = publicWebsiteUrl(input.website);
  if (!base) return [];
  const baseHost = normalizedHost(base);
  const queryTokens = keywordTokens(input.keyword, 20).map(matchToken);
  const serviceTokens = [
    ...new Set(input.serviceNames.flatMap(serviceMatchTokens)),
  ];
  const candidates = new Map<string, number>();
  const add = (raw: string | null | undefined, label = "") => {
    if (!raw) return;
    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      return;
    }
    if (normalizedHost(resolved) !== baseHost) return;
    if (!publicWebsiteUrl(resolved.toString())) return;
    resolved.hash = "";
    if (
      /\b(?:login|sign[-_]?in|account|privacy|terms|cookie|careers?|jobs?|press|investors?)\b/i.test(
        `${resolved.pathname} ${label}`,
      )
    ) {
      return;
    }
    const normalized = resolved.toString().replace(/\/$/, "");
    const score = scoreFirstPartyUrl({
      pathname: resolved.pathname,
      label,
      keywordTokens: queryTokens,
      serviceTokens,
      isRoot: normalized === base.toString().replace(/\/$/, ""),
    });
    candidates.set(normalized, Math.max(score, candidates.get(normalized) ?? 0));
  };

  add(base.toString(), "home services");
  for (const item of input.navigation ?? []) add(item.url, item.text ?? "");
  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, input.maxPages)
    .map(([url]) => url);
}

function navigationFromHtml(
  html: string,
  pageUrl: string,
): Array<{ text: string; url: string }> {
  const $ = cheerio.load(html);
  return $("a[href]")
    .toArray()
    .flatMap((node) => {
      const href = $(node).attr("href");
      if (!href) return [];
      try {
        return [
          {
            text: normalize($(node).text()),
            url: new URL(href, pageUrl).toString(),
          },
        ];
      } catch {
        return [];
      }
    });
}

function visibleTextLength(html: string): number {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, form, noscript, svg").remove();
  return normalize($("body").text()).length;
}

function pageEvidence(input: {
  html: string;
  url: string;
  keyword: string;
  serviceNames: string[];
}): RetrievedClaimEvidence[] {
  const $ = cheerio.load(input.html);
  $("script, style, nav, footer, form, noscript, svg").remove();
  const queryTokens = keywordTokens(input.keyword, 20);
  const serviceTokens = [
    ...new Set(input.serviceNames.flatMap(serviceMatchTokens)),
  ];
  const sourceScore = scoreFirstPartyUrl({
    pathname: new URL(input.url).pathname,
    label: "",
    keywordTokens: queryTokens.map(matchToken),
    serviceTokens,
    isRoot: new URL(input.url).pathname === "/",
  });
  const servicePhrases = input.serviceNames
    .map((service) => normalize(service).toLowerCase())
    .filter((service) => service.length >= 4);
  const seen = new Set<string>();
  // td/dd/blockquote carry real service facts on many small-business sites
  // (pricing tables, definition lists, testimonial-adjacent copy) that the
  // original p/li selector silently dropped.
  const candidates = $("p, li, td, dd, blockquote")
    .toArray()
    .map((node) => normalize($(node).text()))
    .filter(
      (text) =>
        text.length >= 40 &&
        text.length <= 600 &&
        !/\b(?:traditional lands|indigenous peoples|privacy policy|cookie policy|terms of use|all rights reserved|accessibility statement)\b/i.test(
          text,
        ) &&
        // Concatenated nav-menu scrapes ("Preventative Drain CleaningSewer
        // Line InspectionsTub and Shower Clogs") poison the claim ledger and
        // render as garbled "verified details". Two or more lowercase→uppercase
        // jams, or a long run with no sentence punctuation, is a menu, not
        // prose.
        (text.match(/[a-z][A-Z]/g) ?? []).length < 2 &&
        !(text.length > 120 && !/[.!?]/.test(text)),
    )
    .map((excerpt) => {
      const lower = excerpt.toLowerCase();
      const exactService = servicePhrases.some((service) => lower.includes(service));
      const keywordScore = scoreExcerpt(excerpt, queryTokens) * 4;
      const serviceScore = scoreExcerpt(excerpt, serviceTokens);
      return {
        excerpt,
        score:
          keywordScore +
          serviceScore +
          (exactService ? 4 : 0) +
          Math.max(0, sourceScore),
      };
    })
    .filter((candidate) => candidate.score >= 2)
    .sort((left, right) => right.score - left.score);

  const evidence: RetrievedClaimEvidence[] = [];
  for (const candidate of candidates) {
    const key = candidate.excerpt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      url: input.url,
      title: normalize($("title").first().text()) || null,
      excerpt: candidate.excerpt.slice(0, 600),
      retrievedAt: new Date().toISOString(),
      authority: "owned_website",
      relevanceScore: candidate.score,
    });
    if (evidence.length >= evidencePassagesPerPage()) break;
  }
  return evidence;
}

/**
 * Per-page and total passage ceilings. The original hardcoded 2-per-page /
 * 12-total starved the claim ledger — a 7-page service site yielded ~3 usable
 * passages, so the writer padded with generic advice and the judge scored it
 * 3-4/10. Wider defaults keep grounded specificity available; env overrides
 * allow tightening without a code change.
 */
function evidencePassagesPerPage(): number {
  const parsed = Number.parseInt(
    process.env.BLOG_EVIDENCE_PASSAGES_PER_PAGE ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function evidenceMaxPassages(): number {
  const parsed = Number.parseInt(
    process.env.BLOG_EVIDENCE_MAX_PASSAGES ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

export async function retrieveFirstPartyClaimEvidence(input: {
  website: string | null;
  navigation?: Array<{ text?: string | null; url?: string | null }>;
  keyword: string;
  serviceNames: string[];
  maxPages?: number;
  maxClaims?: number;
}): Promise<RetrievedClaimEvidence[]> {
  if (
    process.env.BLOG_FIRST_PARTY_EVIDENCE_ENABLED === "false" ||
    !input.website
  ) {
    return [];
  }
  const maxPages = input.maxPages ?? 6;
  const rankedInitialUrls = rankFirstPartyEvidenceUrls({
    website: input.website,
    navigation: input.navigation,
    keyword: input.keyword,
    serviceNames: input.serviceNames,
    maxPages,
  });
  const rootUrl = publicWebsiteUrl(input.website)?.toString().replace(/\/$/, "");
  const initialUrls = [
    rootUrl,
    ...rankedInitialUrls.filter((url) => url !== rootUrl),
  ]
    .filter((url): url is string => Boolean(url))
    .slice(0, Math.min(3, maxPages));
  const cacheKey = hash({
    urls: initialUrls,
    keyword: input.keyword.toLowerCase(),
    services: input.serviceNames.map((value) => value.toLowerCase()).sort(),
  });
  const cached = firstPartyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FIRST_PARTY_CACHE_TTL_MS) {
    return cached.evidence;
  }

  const initialPages = await Promise.allSettled(
    initialUrls.map(async (url) => ({
      url,
      html: await fetchWithScraperAPI(url),
    })),
  );
  let fulfilledPages = initialPages.flatMap((result) =>
    result.status === "fulfilled" && result.value.html ? [result.value] : [],
  );

  let rootPage = fulfilledPages.find(
    (page) =>
      rootUrl &&
      page.url.replace(/\/$/, "") === rootUrl.replace(/\/$/, ""),
  );
  if (
    rootPage &&
    navigationFromHtml(rootPage.html, rootPage.url).length < 3 &&
    visibleTextLength(rootPage.html) < 1_000
  ) {
    try {
      rootPage = {
        url: rootPage.url,
        html: await fetchWithScraperAPI(rootPage.url, { render: true }),
      };
      fulfilledPages = [
        ...fulfilledPages.filter((page) => page.url !== rootPage?.url),
        rootPage,
      ];
    } catch {
      // Keep the non-rendered page and continue with whatever it exposed.
    }
  }

  const discoveredNavigation = fulfilledPages.flatMap((page) =>
    navigationFromHtml(page.html, page.url),
  );
  const discoveredUrls = rankFirstPartyEvidenceUrls({
    website: input.website,
    navigation: [...(input.navigation ?? []), ...discoveredNavigation],
    keyword: input.keyword,
    serviceNames: input.serviceNames,
    maxPages,
  });
  const intentMatchedUrls = discoveredUrls.filter(
    (url) => !hasUnrequestedSpecificIntent(url, input.keyword),
  );
  const selectedUrls = new Set(intentMatchedUrls.map(normalizeEvidenceUrl));
  fulfilledPages = fulfilledPages.filter((page) =>
    selectedUrls.has(normalizeEvidenceUrl(page.url)),
  );
  const fetched = new Set(fulfilledPages.map((page) => page.url.replace(/\/$/, "")));
  const additionalUrls = intentMatchedUrls.filter(
    (url) => !fetched.has(url.replace(/\/$/, "")),
  ).slice(0, Math.max(0, maxPages - fulfilledPages.length));
  const additionalPages = await Promise.allSettled(
    additionalUrls.map(async (url) => ({
      url,
      html: await fetchWithScraperAPI(url),
    })),
  );
  fulfilledPages.push(
    ...additionalPages.flatMap((result) =>
      result.status === "fulfilled" && result.value.html ? [result.value] : [],
    ),
  );

  const renderedPages = await Promise.allSettled(
    fulfilledPages.map(async (page) => {
      const existing = pageEvidence({
        ...page,
        keyword: input.keyword,
        serviceNames: input.serviceNames,
      });
      if (existing.length > 0) return page;
      try {
        return {
          url: page.url,
          html: await fetchWithScraperAPI(page.url, { render: true }),
        };
      } catch {
        return page;
      }
    }),
  );
  fulfilledPages = renderedPages.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  const perPageEvidence = fulfilledPages.map((result) => ({
    url: result.url,
    passages: pageEvidence({
      ...result,
      keyword: input.keyword,
      serviceNames: input.serviceNames,
    }),
  }));
  for (const page of perPageEvidence) {
    if (page.passages.length === 0) {
      console.warn(
        `📄 Evidence: ${page.url} contributed 0 passages (structure or relevance mismatch)`,
      );
    } else if (process.env.DEBUG_BLOG_EVIDENCE === "true") {
      console.log(
        `📄 Evidence: ${page.url} → ${page.passages.length} passage(s)`,
      );
    }
  }
  const evidence = deduplicateRetrievedClaimEvidence(
    perPageEvidence.flatMap((page) => page.passages),
  ).slice(0, input.maxClaims ?? evidenceMaxPassages());
  firstPartyCache.set(cacheKey, { at: Date.now(), evidence });
  return evidence;
}

function keywordTokens(keyword: string, max = 8): string[] {
  return keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
    .slice(0, max);
}

function scoreExcerpt(excerpt: string, tokens: string[]): number {
  const normalized = excerpt.toLowerCase();
  return tokens.reduce(
    (score, token) => score + (normalized.includes(token) ? 1 : 0),
    0,
  );
}

async function retrievePageEvidence(
  url: string,
  keyword: string,
): Promise<RetrievedClaimEvidence | null> {
  if (!isAuthoritativeEvidenceUrl(url)) return null;
  const response = await axios.get<string>(url, {
    timeout: 8_000,
    maxRedirects: 3,
    maxContentLength: 1_000_000,
    responseType: "text",
    headers: { "User-Agent": "UpliftAI-EvidenceBot/1.0" },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const $ = cheerio.load(response.data);
  $("script, style, nav, footer, noscript").remove();
  const tokens = keywordTokens(keyword);
  const candidates = $("main p, article p, p")
    .toArray()
    .map((node) => normalize($(node).text()))
    .filter((text) => text.length >= 80 && text.length <= 800)
    .map((excerpt) => ({ excerpt, score: scoreExcerpt(excerpt, tokens) }))
    .sort((left, right) => right.score - left.score);
  const selected = candidates.find((candidate) => candidate.score > 0);
  if (!selected) return null;
  return {
    url,
    title: normalize($("title").first().text()) || null,
    excerpt: selected.excerpt.slice(0, 600),
    retrievedAt: new Date().toISOString(),
  };
}

export async function retrieveAuthoritativeClaimEvidence(input: {
  urls: string[];
  keyword: string;
  maxPages?: number;
}): Promise<RetrievedClaimEvidence[]> {
  if (process.env.BLOG_EVIDENCE_RETRIEVAL_ENABLED === "false") return [];
  const urls = [...new Set(input.urls)]
    .filter(isAuthoritativeEvidenceUrl)
    .slice(0, input.maxPages ?? 3);
  const results = await Promise.allSettled(
    urls.map((url) => retrievePageEvidence(url, input.keyword)),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}

export function buildClaimLedgerPromptBlock(
  claims: CanonicalClaim[],
  services: string[] = [],
): string {
  const owned = claims.filter((claim) => claim.authority === "owned_website");
  const external = claims.filter((claim) => claim.classification !== "business");
  const evidenceGroups = services.slice(0, 12).flatMap((service) => {
    const matching = owned.filter((claim) => claimSupportsService(claim, service));
    return matching.length > 0
      ? [
          {
            service,
            claimIds: matching.map((claim) => claim.id),
            sourceUrls: [...new Set(matching.map((claim) => claim.sourceUrl))],
          },
        ]
      : [];
  });
  return [
    "FIRST-PARTY EVIDENCE MAP",
    evidenceGroups.length > 0
      ? JSON.stringify(evidenceGroups, null, 2)
      : "none",
    "Build the body around 3-5 evidence-backed decisions, not an inventory of every service. Connect only claims assigned to the same service. A source passage supports exactly what it says, not a broader outcome.",
    "FIRST-PARTY ALLOWED CLAIMS",
    owned.length > 0
      ? JSON.stringify(
          owned.map((claim) => ({
            id: claim.id,
            text: claim.text,
            sourceUrl: claim.sourceUrl,
          })),
          null,
          2,
        )
      : "none",
    "Use these passages only as narrow evidence for the service details they explicitly state. Cite the exact source URL; do not broaden the claim.",
    "EXTERNAL ALLOWED CLAIMS",
    external.length > 0
      ? JSON.stringify(
          external.map((claim) => ({
            id: claim.id,
            type: claim.type,
            text: claim.text,
            sourceUrl: claim.sourceUrl,
            authority: claim.authority,
          })),
          null,
          2,
        )
      : "none",
    "Use only these claims or faithful narrower paraphrases, and retain the source URL as a visible citation.",
  ].join("\n");
}
