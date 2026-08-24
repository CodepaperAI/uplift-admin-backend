import type { AIMessage } from "@langchain/core/messages";
import { load } from "cheerio";
import type { z } from "zod";

import type {
  CanonicalBlogFactPacket,
  CanonicalClaim,
} from "./canonical-blog-facts.service";
import {
  claimSupportsService,
  getEvidenceBackedServices,
  getTopicRelevantEvidenceBackedServices,
  isClaimRelevantToTopic,
  isTextRelevantToTopic,
  topicMatchTokens,
} from "./blog-claim-evidence.service";
import type {
  GroundedBlogOutline,
  GroundedOutlineSection,
} from "./grounded-blog-outline.service";
import type { ExpertVoiceVerdict } from "./expert-voice-judge.service";
import {
  splitBlogHtmlSections,
  type SectionValidationFailure,
} from "../utils/blog-section-repair.utils";
import { BANNED_PHRASES } from "../utils/blog-phrase-gate.utils";
import {
  evaluateBlogGrounding,
  partitionGroundingIssues,
  sanitizeHardGroundingBlocks,
  sanitizeModelAuthoredBusinessClaims,
  type BlogGroundingPacket,
  type GroundingIssue,
} from "../utils/blog-grounding.utils";
import { CREATE_BLOG } from "../validators/blog.validation";
import type { BusinessModelType } from "../utils/blog-substance.utils";

export type SectionedBlogPayload = z.infer<typeof CREATE_BLOG>;

export type SectionWriterMessage = {
  role: "system" | "user";
  content: string;
};

export type SectionWriterInvoke = (
  messages: SectionWriterMessage[],
) => Promise<AIMessage>;

export interface SectionedBlogDraft {
  introHtml: string;
  sectionHtml: Map<string, string>;
  content: string;
  messages: AIMessage[];
  repairAttempts: Record<string, number>;
}

export interface SectionWriterInput {
  invoke: SectionWriterInvoke;
  packet: CanonicalBlogFactPacket;
  outline: GroundedBlogOutline;
  keyword: string;
  locale: string;
  brandVoiceBlock?: string;
  targetWordCount: number;
  businessModelType?: BusinessModelType;
  /** False for broad-reach/non-location-dependent articles. */
  useLocalSection?: boolean;
  groundingPacket?: BlogGroundingPacket;
  /** Required rank-module ids (selectModules output) so writer-owned modules
   * like howto-steps render in the best-matching section. */
  requiredModuleIds?: string[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "article"
  );
}

function toTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripDocumentShell(value: string): string {
  let html = value
    .replace(/^\s*```(?:html)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(
      /<div\b[^>]*class=["'][^"']*author-bio[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      "",
    )
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, "")
    .replace(/<\/?(?:html|body|main|article)\b[^>]*>/gi, "")
    .trim();
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (body) html = body.trim();
  return html;
}

function normalizeRootTextBlocks(value: string): string {
  const $ = load(value, null, false);
  $.root()
    .contents()
    .each((_index, node) => {
      if (node.type !== "text") return;
      const paragraphs = $(node)
        .text()
        .split(/\n\s*\n+/)
        .map(clean)
        .filter(Boolean);
      if (paragraphs.length === 0) {
        $(node).remove();
        return;
      }
      $(node).replaceWith(
        paragraphs
          .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
          .join("\n"),
      );
    });
  return ($.root().html() ?? "").trim();
}

function claimsForSection(
  packet: CanonicalBlogFactPacket,
  section: GroundedOutlineSection,
): CanonicalClaim[] {
  const allowed = new Set(section.allowedClaimIds);
  return packet.claims.filter((claim) => allowed.has(claim.id));
}

function claimLedger(claims: CanonicalClaim[]): string {
  return JSON.stringify(
    claims.map((claim) => ({
      id: claim.id,
      type: claim.type,
      text: claim.text,
      sourceUrl: claim.sourceUrl,
      authority: claim.authority,
    })),
    null,
    2,
  );
}

function listText(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function sectionWordBudget(
  section: GroundedOutlineSection,
  targetWordCount: number,
  outline: GroundedBlogOutline,
): { min: number; max: number } {
  if (/faq|questions/i.test(section.heading)) return { min: 120, max: 180 };
  if (/next steps|conclusion|summary/i.test(section.heading)) {
    return targetWordCount >= 2_500
      ? { min: 140, max: 220 }
      : { min: 90, max: 140 };
  }
  const bodyCount = Math.max(
    1,
    outline.sections.filter(
      (candidate) =>
        !/faq|questions|next steps|conclusion|summary/i.test(candidate.heading),
    ).length,
  );
  const target = Math.round((targetWordCount - 320) / bodyCount);
  if (targetWordCount >= 2_500) {
    return {
      min: Math.max(360, Math.min(700, target - 50)),
      max: Math.max(450, Math.min(780, target + 60)),
    };
  }
  return {
    min: Math.max(170, Math.min(340, target - 30)),
    max: Math.max(220, Math.min(420, target + 35)),
  };
}

/**
 * Compact packet facts available to EVERY section. Without this the section
 * writer saw only its 2-7 assigned claims while the judge graded against the
 * full fact list — the writer was structurally unable to use documented
 * operating facts (price-from, capacity, lead time, coverage) and padded with
 * generic scaffolding instead.
 */
function verifiedSnapshotBlock(
  packet: CanonicalBlogFactPacket,
  topic: string,
  useLocalSection: boolean,
  groundingPacket?: BlogGroundingPacket,
): string {
  // The editorial judge grades against the full grounded fact list, so the
  // writer needs the same substance — but a 40-line fact dump buries the
  // length instruction and measurably shortens drafts (597 words vs 950-1400
  // with a compact prompt). Curate: skip kinds already covered by the
  // services/identity lines, dedupe, and cap hard.
  const coveredKinds = new Set(["service", "identity", "location", "operation"]);
  const groundedFactLines = (groundingPacket?.facts ?? [])
    .filter((fact) => !coveredKinds.has(fact.kind))
    .filter((fact) => isTextRelevantToTopic(fact.value, topic))
    .map((fact) => `${fact.kind}: ${fact.value}`)
    .slice(0, 12);
  const credentialLines = (groundingPacket?.credentials ?? [])
    .filter((value) => isTextRelevantToTopic(value, topic))
    .slice(0, 4);
  const reputationLines = (groundingPacket?.reputationFacts ?? [])
    .filter((value) => isTextRelevantToTopic(value, topic))
    .slice(0, 3);
  const services = getTopicRelevantEvidenceBackedServices(packet, topic);
  const operatingFacts = packet.claims
    .filter(
      (claim) =>
        claim.classification === "business" &&
        claim.type === "business_operation" &&
        isClaimRelevantToTopic(claim, topic, {
          allowLocation: useLocalSection,
        }),
    )
    .map((claim) => claim.text)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 6);
  const lines = [
    packet.identity.businessName
      ? `Business: ${packet.identity.businessName}`
      : "",
    useLocalSection && packet.location.city
      ? `Verified location: ${[packet.location.city, packet.location.region]
          .filter(Boolean)
          .join(", ")}`
      : "",
    useLocalSection && packet.serviceAreas.length
      ? `Documented service areas: ${packet.serviceAreas.slice(0, 8).join(", ")}`
      : "",
    services.length
      ? `Topic-relevant documented services: ${services.slice(0, 8).join("; ")}`
      : "",
    operatingFacts.length
      ? `Topic-relevant operating facts: ${operatingFacts.join("; ")}`
      : "",
    ...groundedFactLines,
    ...credentialLines.map((credential) => `credential: ${credential}`),
    ...reputationLines.map((fact) => `reputation: ${fact}`),
  ].filter(Boolean);
  if (lines.length === 0) return "";
  return [
    "VERIFIED BUSINESS SNAPSHOT — usable in ANY section without a link:",
    ...[...new Set(lines)].map((line) => `- ${line}`),
    "State these packet facts directly and exactly when they answer the reader's question — as plain assertions in an expert voice, never as remarks about what is documented. Any richer business detail still requires an assigned claim cited with its exact source URL.",
  ].join("\n");
}

function isGeneralKnowledgeEnabled(): boolean {
  return process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED !== "false";
}

function sectionSystemPrompt(input: SectionWriterInput): string {
  const generalKnowledge = isGeneralKnowledgeEnabled();
  return [
    generalKnowledge
      ? "You write exactly one section of an expert industry article. General industry knowledge is welcome; business-specific facts are strictly controlled."
      : "You write exactly one section in a controlled, closed-world article pipeline.",
    "Return only the requested HTML section. Do not return Markdown, JSON, explanations, schema, a title, a table of contents, an author block, or images.",
    `Write in ${input.locale}.`,
    `Locked article title: ${input.outline.title}`,
    `Primary keyword: ${input.keyword}`,
    "You may interpret an assigned business claim once in third-person prose only when you preserve its meaning and include an HTML link to that claim's exact source URL in the same paragraph. Claims without a source URL remain application-only facts.",
    "STATE DOCUMENTED FACTS, NEVER ASK ABOUT THEM: when an assigned claim documents a detail — a starting price, capacity range, lead time, labeling practice, coverage area, package, or default recommendation — state it directly with its citation. Telling the reader to ask about or verify a detail that an assigned claim already documents is an error; reserve verification questions for details that are genuinely undocumented.",
    "Assert facts in an expert voice: say what is true and cite it. Never write ABOUT the documentation — phrases like 'is documented', 'according to the page', 'the website lists', or 'review the linked page' read like an aggregator, not a practitioner.",
    "VOICE: write like a seasoned practitioner talking to a smart friend. Use contractions, direct 'you', rhetorical questions, and short punchy sentences mixed with longer ones. Bold the lead-in phrase of list items (<strong>Lead-in:</strong> explanation). Analogies about the READER's situation are welcome — they claim nothing about the business. Weave numbers and facts INTO sentences with natural attribution ('Angi pegs professional drain cleaning at $147–$352' with the link), never as labeled data blocks.",
    "PROFESSIONAL LEXICAL DISCIPLINE: archetype names and outline labels are private guidance, not phrases to repeat. Name each concern or decision criterion precisely. Use attention phrases such as 'red flag', 'warning sign', 'key takeaway', or 'what to expect' sparingly, never as the repeated prefix for headings or list items. Silently reread the section beside its neighbouring headings and remove templated catchphrases without weakening facts, citations, or search intent.",
    "ANCHOR TO THE BUSINESS: every section must contain at least one sentence that could only be written about this business — its name plus a verified specific (a service scope, coverage area, capacity, founding year, lead time, or cited first-party claim). General industry guidance that never returns to the business reads as interchangeable content that any competitor could publish; AI engines and readers reward entity-specific pages.",
    /\b(?:best|top|recommend\w*|#1|number\s+one)\b/i.test(input.keyword)
      ? "RECOMMENDATION INTENT: this 'best/top' query is answered on the business's OWN site — a neutral buying guide underserves it. Where the verified facts genuinely fit the reader's need, recommend the business plainly using its specifics ('For corporate teams needing halal catering at scale, [Business] handles 10–1,000 guests from $10/person'). Include ONE honest fit-boundary ('teams needing [something not offered] should look elsewhere') — a disclosed limitation makes the recommendation credible. Never invent superlatives ('award-winning', 'highest-rated') without a verified claim."
      : "",
    "Never invent a personal history ('after years of doing this', 'I've seen hundreds of…') — conviction must come from clear reasoning and cited facts, not fabricated experience.",
    "When an assigned claim itself recommends an option for a situation, adopt that documented recommendation as your stated position and cite it — do not soften it into a neutral comparison.",
    "Citation anchor text must be descriptive — the business name or the linked page's topic (e.g. \"the preventative drain cleaning page\"). Never use the bare words source, here, or link as anchor text.",
    "Do not copy a claim verbatim or turn the section into a profile summary. Use sourced evidence to support a useful comparison, then return to reader-owned decision guidance.",
    "You may use the exact service names present in the locked heading, but any richer characterization of what the business provides or how it operates requires an assigned sourced claim.",
    "Treat each assigned claim as a strict ceiling: preserve its modality and use the same core nouns and verbs. A source URL supports only that claim, not an inferred benefit.",
    "Never turn can, may, or available into will, ensures, guarantees, prevents, avoids, achieves, maximizes, or requires.",
    "Use conditional decision guidance: name the reader condition, the question to ask, and the tradeoff to consider. Do not present health, safety, injury, financial, behavioral, or performance outcomes as universal facts.",
    generalKnowledge
      ? "GENERAL INDUSTRY KNOWLEDGE IS ALLOWED: explain how things typically work, what usually matters, common mistakes, and practical guidance — confidently and without citations, as a knowledgeable practitioner would. Attribute SPECIFIC numbers, studies, or statistics to a cited source (assigned claims include several) or omit them. The hard line: never invent BUSINESS-SPECIFIC facts — this business's prices, availability, response times, credentials, equipment, service scope, or customer outcomes come only from assigned claims and the verified snapshot."
      : "CLOSED-WORLD PROSE GRAMMAR: every uncited sentence must be one of these forms: a direct question; a command beginning with Ask, Assess, Check, Choose, Clarify, Compare, Confirm, Consider, Decide, Define, Determine, Document, Identify, Prioritize, Record, Request, Review, Start, or Verify; or an If/When/Before condition followed by one of those commands.",
    "You may also write clearly editorial analysis about the reader's own decision, shortlist, plan, criteria, constraints, or tradeoff. Keep it framed as a recommendation, not as a fact about the market or provider.",
    "Reader-owned planning inputs are limited to the goal, budget, scope, date, exact address, assigned verified facts, and the written quote. Do not expand them into premises, staffing, equipment, procedural, fulfillment, or contract assumptions. Never borrow scenario vocabulary from another industry; every example must fit this business's actual service category.",
    ...(generalKnowledge
      ? [
          "You may describe what services, tools, and processes GENERALLY do and involve — that is the useful industry knowledge readers came for. Attribute anything business-specific (what THIS business does, includes, charges, or achieves) to an assigned claim or the verified snapshot, and never present a general norm as this business's policy.",
        ]
      : [
          "Do not write uncited explanatory sentences about what a provider, vendor, service, package, format, contract, workflow, or option does, includes, requires, affects, enables, improves, or typically involves. The application rejects and removes those sentences.",
          "Do not introduce operational details such as equipment, tools, methods, techniques, premises access, insurance, staffing, setup, cleanup, scheduling internals, substitutions, minimum orders, deposits, refunds, surcharges, or compliance rules unless an assigned claim names that exact detail. You may ask only whether price, availability, timing, geographic coverage, inclusions, exclusions, payment terms, or cancellation terms are documented.",
          "Do not use outcome verbs such as improves, reduces, prevents, avoids, simplifies, preserves, maximizes, minimizes, or ensures unless an assigned authoritative claim states that exact outcome.",
        ]),
    "Do not add prices, timing promises, guarantees, laws, safety claims, statistics, competitors, customer stories, outcomes, or operational details unless an assigned claim explicitly supports them.",
    "Write about the business in third person. Never use we, our, or us as the business.",
    "Every paragraph must do at least one useful job: make a direct conditional recommendation, explain a meaningful tradeoff, identify a concrete selection question, or interpret assigned evidence.",
    "Do not use vague motivational filler, an encyclopedia tone, or phrases such as it depends without immediately stating the deciding condition.",
    `Never use these blocked phrases: ${BANNED_PHRASES.map((phrase) => phrase.label).join("; ")}.`,
    verifiedSnapshotBlock(
      input.packet,
      input.keyword,
      input.useLocalSection !== false,
      input.groundingPacket,
    ),
    input.brandVoiceBlock ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildSectionWriterMessages(
  input: SectionWriterInput,
  section: GroundedOutlineSection,
  options?: {
    existingHtml?: string;
    repairDirectives?: string[];
    priorHeadings?: string[];
  },
): SectionWriterMessage[] {
  const claims = claimsForSection(input.packet, section);
  const budget = sectionWordBudget(
    section,
    input.targetWordCount,
    input.outline,
  );
  const isFaq = /faq|questions/i.test(section.heading);
  const isNext = /next steps|conclusion|summary/i.test(section.heading);
  const format = isFaq
    ? [
        "Write exactly three non-duplicative FAQ entries.",
        'Use <h3> for each question and <p class="faq-answer"> for each answer.',
        "Handle objections or edge cases that earlier headings do not already answer. Do not repeat the body in different words.",
      ].join(" ")
    : isNext
      ? "End with one direct starting recommendation and one alternative for a different reader need. Do not repeat the service inventory or write a generic contact-us conclusion."
      : budget.max >= 450
        ? [
            "Use four to six short paragraphs; no paragraph may exceed 110 words.",
            "After a brief opening, use two or three descriptive H3 decision lenses and one useful ul with three to five concise questions or verification commands.",
            "Each H3 must answer a different reader question in one or two short paragraphs, matching the layered H2/H3 rhythm of a professionally edited long-form guide.",
            "Do not turn the entire section into a list. Close with a distinct conditional recommendation and do not recap earlier sections.",
          ].join(" ")
        : "Use two or three concise paragraphs. Take a clear position for a stated reader condition and explain the tradeoff without inventing a result.";

  // Writer-owned rank modules render in the best-matching body section — the
  // module plan previously lived only in the single-shot prompt, so how-to
  // articles shipped without their required <ol class="howto-steps"> (the
  // same never-plumbed class of bug as the local-tip loop).
  const bodySections = input.outline.sections.filter(
    (candidate) =>
      !/faq|questions|next steps|conclusion|summary/i.test(candidate.heading),
  );
  const howToTargetId = (input.requiredModuleIds ?? []).includes("howto-steps")
    ? (bodySections.find((candidate) =>
        /\bhow\b|\bsteps?\b|\bprocess\b|\bprevent/i.test(candidate.heading),
      ) ?? bodySections[0])?.id
    : undefined;
  const wantsHowToSteps = howToTargetId === section.id;
  const moduleDirectives = wantsHowToSteps
    ? 'RENDER IN THIS SECTION — HOW-TO STEPS (required for this article): an ordered list <ol class="howto-steps"> of 5-8 concise, action-first steps with clear step lead-ins.'
    : "";

  return [
    { role: "system", content: sectionSystemPrompt(input) },
    {
      role: "user",
      content: [
        "WRITE THIS LOCKED SECTION ONLY",
        `Section ID: ${section.id}`,
        `Exact H2: ${section.heading}`,
        `Purpose: ${section.purpose}`,
        moduleDirectives,
        // "at least N" is load-bearing: with a passive "N-M words" range the
        // writer routinely delivers 60-80% of the minimum and the document
        // fails the length gate.
        `Length: write AT LEAST ${budget.min} words and at most ${budget.max}; aim for ${Math.round((budget.min + budget.max) / 2)}. A section under ${budget.min} words will be rejected.`,
        `Required H2 markup: <h2 data-outline-id=\"${section.id}\" id=\"${slugify(section.heading)}\">${escapeHtml(section.heading)}</h2>`,
        format,
        options?.priorHeadings?.length
          ? `Earlier sections already cover these headings; add new decision value instead of recapping them: ${options.priorHeadings.join(" | ")}`
          : "",
        "ASSIGNED VERIFIED EVIDENCE. You may faithfully interpret a sourced claim once and must link its exact source URL in the same paragraph. Never broaden it or infer an outcome. The application will render any assigned claim you do not cite.",
        claimLedger(claims),
        options?.existingHtml
          ? `CURRENT SECTION TO REPAIR\n${options.existingHtml}`
          : "",
        options?.repairDirectives?.length
          ? [
              "APPLICATION-OWNED REPAIR DIRECTIVES",
              ...options.repairDirectives.map((directive) => `- ${directive}`),
              "Change only this section. Preserve every supported fact and citation that still serves the section.",
            ].join("\n")
          : "",
        "Return only the replacement HTML section.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

function splitLongParagraphs(html: string, maxWords = 110): string {
  const $ = load(html, null, false);
  $("p").each((_index, element) => {
    const paragraph = $(element);
    const inner = paragraph.html() ?? "";
    if (plainText(inner).split(/\s+/).filter(Boolean).length <= maxWords) {
      return;
    }
    const sentences = inner
      .split(/(?<=[.!?])\s+(?=(?:<[^>]+>\s*)*[A-Z0-9])/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    if (sentences.length < 2) return;
    const groups: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      const candidateWords = plainText(candidate)
        .split(/\s+/)
        .filter(Boolean).length;
      if (current && candidateWords > maxWords) {
        groups.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }
    if (current) groups.push(current);
    if (groups.length < 2) return;
    const attributes = paragraph.attr() ?? {};
    for (const group of groups) {
      paragraph.before($("<p></p>").attr(attributes).html(group));
    }
    paragraph.remove();
  });
  return ($.root().html() ?? "").trim();
}

export function buildVerifiedSectionEvidenceBlock(
  packet: CanonicalBlogFactPacket,
  section: GroundedOutlineSection,
  modelHtml = "",
): string {
  const claims = claimsForSection(packet, section)
    .filter(
      (claim) =>
        claim.authority === "owned_website" &&
        Boolean(claim.sourceUrl) &&
        !modelHtml.includes(claim.sourceUrl!),
    )
    .slice(0, 2);
  if (claims.length === 0) return "";
  // Editorial pull-quote, not a "Verified details" data dump: human editors
  // quote a source's own words with attribution; they never label prose with
  // meta-headings about verification (flagged by both the judge and human
  // review as a machine tell).
  const businessName = packet.identity.businessName ?? "the business";
  return [
    '<aside class="verified-section-evidence" data-uplift-assembled="section-evidence">',
    ...claims.map((claim) => {
      const label = sourcePageLabel(claim.sourceUrl!, businessName);
      return `<blockquote>“${escapeHtml(claim.text.replace(/^["“]|["”]$/g, ""))}” — <a href="${escapeHtml(claim.sourceUrl!)}" rel="nofollow noopener">${escapeHtml(label)}</a></blockquote>`;
    }),
    "</aside>",
  ].join("\n");
}

/** Human-readable attribution label derived from the source URL path. */
function sourcePageLabel(sourceUrl: string, businessName: string): string {
  try {
    const url = new URL(sourceUrl);
    const slug = url.pathname
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[-_]+/g, " ")
      .replace(/\.(?:html?|php|aspx?)$/i, "")
      .trim();
    return slug && slug.length >= 4 ? `${businessName}, ${slug}` : businessName;
  } catch {
    return businessName;
  }
}

export function normalizeGeneratedSectionHtml(
  raw: string,
  section: GroundedOutlineSection,
  packet?: CanonicalBlogFactPacket,
): string {
  const content = stripDocumentShell(raw)
    .replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, "")
    .replace(
      /<div\b[^>]*class=["'][^"']*quick-answer[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      "",
    )
    .replace(
      /<aside\b[^>]*data-uplift-assembled=["']section-evidence["'][^>]*>[\s\S]*?<\/aside>/gi,
      "",
    )
    .trim();
  const structuredContent = splitLongParagraphs(
    normalizeRootTextBlocks(content),
  );
  const isFaq = /faq|questions/i.test(section.heading);
  const normalizedBody = isFaq
    ? structuredContent.replace(
        /(<h3\b[^>]*>[\s\S]*?<\/h3>\s*)<p(?![^>]*\bclass=)([^>]*)>/gi,
        '$1<p class="faq-answer"$2>',
      )
    : structuredContent;
  return [
    `<h2 data-outline-id="${section.id}" id="${slugify(section.heading)}">${escapeHtml(section.heading)}</h2>`,
    packet
      ? buildVerifiedSectionEvidenceBlock(packet, section, normalizedBody)
      : "",
    normalizedBody,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildDeterministicFaqSection(
  packet: CanonicalBlogFactPacket,
  section: GroundedOutlineSection,
  topic = "",
): string {
  const businessName = packet.identity.businessName ?? "The business";
  const relevantServices = getTopicRelevantEvidenceBackedServices(
    packet,
    topic,
  );
  const services = (
    relevantServices.length > 0
      ? relevantServices
      : topicMatchTokens(topic).length === 0
        ? [...getEvidenceBackedServices(packet), ...packet.services]
        : []
  ).filter((service, index, values) => values.indexOf(service) === index);
  const usedClaimIds = new Set<string>();
  // FINAL FAQ CONTRACT — never quote claim text. Raw first-party passages are
  // marketing prose; some checker (availability, performance, grammar) will
  // eventually flag a quoted sentence, the sanitizer deletes the answer, and
  // the FAQ repair loop reopens (this happened three separate times). Varied
  // editorial templates + a descriptive source link give reader value with
  // ZERO sanitizer surface, so 3 questions / 3 answers is structurally
  // guaranteed.
  const answerTemplates = [
    (service: string, link: string | null) =>
      `${escapeHtml(businessName)} lists ${escapeHtml(service)} among its documented options${link ?? ""}. Compare that category with your priorities, then confirm current details before deciding.`,
    (service: string, link: string | null) =>
      `${escapeHtml(businessName)} lists ${escapeHtml(service)} among its documented options${link ?? ""}. Review the documented category, then verify price, availability, timing, and other decision-critical details directly.`,
    (service: string, link: string | null) =>
      `${escapeHtml(businessName)} lists ${escapeHtml(service)} among its documented options${link ?? ""}. Keep it on the shortlist only when the documented category matches the need, then confirm current details.`,
  ];
  const entries = services.slice(0, 3).map((service, index) => {
    const claim = packet.claims.find(
      (candidate) =>
        candidate.authority === "owned_website" &&
        Boolean(candidate.sourceUrl) &&
        !usedClaimIds.has(candidate.id) &&
        claimSupportsService(candidate, service),
    );
    if (claim) usedClaimIds.add(claim.id);
    const link = claim?.sourceUrl
      ? ` (<a href="${escapeHtml(claim.sourceUrl)}" rel="nofollow noopener">the ${escapeHtml(service)} page</a>)`
      : null;
    return {
      question: `When is ${service} the right choice?`,
      answer: answerTemplates[index % answerTemplates.length]!(service, link),
    };
  });
  const website = packet.identity.website;
  const fallbacks = [
    {
      question: "Where should current service details be verified?",
      answer: website
        ? `Review the <a href="${escapeHtml(website)}" rel="nofollow noopener">verified business website</a> for current service details.`
        : "Confirm current service details directly with the business before making a decision.",
    },
    {
      question: "What details should not be assumed?",
      answer:
        "Do not assume pricing, availability, timing, or outcomes when those details are not documented in the verified sources.",
    },
    {
      question: "How should the options be compared?",
      answer:
        "Compare the documented service format with the type of support you need, then verify current operating details directly.",
    },
  ];
  while (entries.length < 3) entries.push(fallbacks[entries.length]!);
  return [
    `<h2 data-outline-id="${section.id}" id="${slugify(section.heading)}">${escapeHtml(section.heading)}</h2>`,
    ...entries
      .slice(0, 3)
      .flatMap((entry) => [
        `<h3 class="faq-question">${escapeHtml(entry.question)}</h3>`,
        `<p class="faq-answer">${entry.answer}</p>`,
      ]),
  ].join("\n");
}

function introClaims(
  packet: CanonicalBlogFactPacket,
  topic: string,
): CanonicalClaim[] {
  const services = new Set(
    getTopicRelevantEvidenceBackedServices(packet, topic),
  );
  const selected: CanonicalClaim[] = [];
  for (const claim of packet.claims) {
    if (
      claim.authority === "owned_website" &&
      isClaimRelevantToTopic(claim, topic) &&
      packet.services.some(
        (service) =>
          services.has(service) &&
          claim.text.toLowerCase().includes(service.toLowerCase()),
      )
    ) {
      selected.push(claim);
    }
    if (selected.length >= 4) break;
  }
  return selected;
}

function normalizeIntroHtml(
  raw: string,
  packet: CanonicalBlogFactPacket,
  topic: string,
  useLocalSection: boolean,
  businessModelType?: BusinessModelType,
): string {
  let html = stripDocumentShell(raw)
    .replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, "")
    .replace(
      /<div\b[^>]*class=["'][^"']*quick-answer[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      "",
    )
    .trim();
  const services = getTopicRelevantEvidenceBackedServices(packet, topic).slice(
    0,
    3,
  );
  const businessName = packet.identity.businessName ?? "The business";
  // Lead with the strongest documented facts, not a meta description of the
  // guide — the judge flagged "This guide compares…" as evasive AI filler.
  const operatingHighlights = packet.claims
    .filter(
      (claim) =>
        claim.classification === "business" &&
        claim.type === "business_operation" &&
        isClaimRelevantToTopic(claim, topic, {
          allowLocation: useLocalSection,
        }),
    )
    .map((claim) => claim.text)
    .filter((fact, index, values) => values.indexOf(fact) === index)
    .filter((fact) => fact.length <= 90)
    .slice(0, 2);
  // Expert voice, probe-verified against the grounding evaluator: "handles X
  // across Y" carries no promise verb the gates flag, and drops the
  // "documents…documented" meta-talk the judge graded as bureaucratic notes.
  const factLead = [
    services.length
      ? `${businessName} ${businessModelType === "product" ? "offers" : "handles"} ${listText(services)}${
          useLocalSection && packet.serviceAreas.length
            ? ` across ${listText(packet.serviceAreas.slice(0, 4))}`
            : ""
        }.`
      : "",
    operatingHighlights.length ? `${operatingHighlights.join(". ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const safeSummary = factLead
    ? `${factLead} Match the option to the exact need below, then confirm current details directly.`
    : `Compare the topic-relevant options for ${businessName} and confirm current details directly before deciding.`;
  return [
    `<div class="quick-answer" data-uplift-assembled="quick-answer"><strong>Quick answer:</strong> ${escapeHtml(safeSummary)}</div>`,
    html,
  ]
    .filter(Boolean)
    .join("\n");
}

type PreparedModelHtml = {
  html: string;
  removedBlocks: number;
  hardIssues: GroundingIssue[];
};

function sanitizeAgainstGrounding(
  html: string,
  groundingPacket?: BlogGroundingPacket,
): PreparedModelHtml {
  if (!groundingPacket) {
    return { html, removedBlocks: 0, hardIssues: [] };
  }
  const businessClaims = sanitizeModelAuthoredBusinessClaims(
    html,
    groundingPacket,
  );
  const firstEvaluation = evaluateBlogGrounding(
    businessClaims.content,
    groundingPacket,
  );
  const firstHard = partitionGroundingIssues(firstEvaluation.issues).hard;
  const hardBlocks = sanitizeHardGroundingBlocks(
    businessClaims.content,
    firstHard,
  );
  const remaining = evaluateBlogGrounding(hardBlocks.content, groundingPacket);
  return {
    html: hardBlocks.content,
    removedBlocks: businessClaims.removed + hardBlocks.removed,
    hardIssues: partitionGroundingIssues(remaining.issues).hard,
  };
}

export function prepareGeneratedSectionHtml(
  raw: string,
  input: SectionWriterInput,
  section: GroundedOutlineSection,
): PreparedModelHtml {
  const modelOnly = normalizeGeneratedSectionHtml(raw, section);
  const prepared = sanitizeAgainstGrounding(modelOnly, input.groundingPacket);
  return {
    ...prepared,
    html: normalizeGeneratedSectionHtml(prepared.html, section, input.packet),
  };
}

function prepareGeneratedIntroHtml(
  raw: string,
  input: SectionWriterInput,
): PreparedModelHtml {
  const normalized = normalizeIntroHtml(
    raw,
    input.packet,
    input.keyword,
    input.useLocalSection !== false,
    input.businessModelType,
  );
  const prepared = sanitizeAgainstGrounding(normalized, input.groundingPacket);
  return {
    ...prepared,
    html: normalizeIntroHtml(
      prepared.html,
      input.packet,
      input.keyword,
      input.useLocalSection !== false,
      input.businessModelType,
    ),
  };
}

function groundingRepairDirectives(prepared: PreparedModelHtml): string[] {
  const kinds = [...new Set(prepared.hardIssues.map((issue) => issue.kind))];
  const directives = kinds.map(
    (kind) =>
      `Remove every unsupported ${kind.replace(/_/g, " ")} statement. Do not replace it with a similar claim or an industry generalization.`,
  );
  if (prepared.removedBlocks > 0) {
    directives.push(
      `${prepared.removedBlocks} unsupported block(s) were removed. Replace their word count only with questions, verification steps, and conditional selection rules that require no external factual support.`,
    );
  }
  return directives;
}

function buildIntroMessages(input: SectionWriterInput): SectionWriterMessage[] {
  const services = getTopicRelevantEvidenceBackedServices(
    input.packet,
    input.keyword,
  ).slice(0, 4);
  return [
    { role: "system", content: sectionSystemPrompt(input) },
    {
      role: "user",
      content: [
        "WRITE THE ARTICLE INTRODUCTION ONLY",
        "Return one 80-110 word HTML paragraph without an H1, H2, or quick-answer box. Every sentence must be a direct question, a permitted verification command, an If/When condition followed by a permitted command, or a direct statement of an assigned INTRO CLAIM cited with its exact source URL.",
        "The application creates the quick answer from verified facts. Write only a concise editorial opening that frames the reader's decision.",
        "State the article's selection stance immediately, anchored in the strongest assigned claim. Never open with what this guide explains or covers. Do not preview every section and do not list every service.",
        input.useLocalSection !== false
          ? "Name the business and its verified city/service area within the first 100 words."
          : "Name the business within the first 100 words. Do not introduce a city, service area, or local-coverage claim.",
        `Evidence-backed offerings you may name: ${services.length ? services.join(", ") : "none"}`,
        "INTRO CLAIMS",
        claimLedger(introClaims(input.packet, input.keyword)),
        "Return only the introduction HTML.",
      ].join("\n\n"),
    },
  ];
}

function buildIntroRepairMessages(
  input: SectionWriterInput,
  existingHtml: string,
  directives: string[],
): SectionWriterMessage[] {
  const services = getTopicRelevantEvidenceBackedServices(
    input.packet,
    input.keyword,
  ).slice(0, 4);
  return [
    { role: "system", content: sectionSystemPrompt(input) },
    {
      role: "user",
      content: [
        "REPAIR THE ARTICLE INTRODUCTION ONLY",
        "Return one 80-110 word HTML paragraph without an H1, H2, or quick-answer box. Every sentence must be a direct question, a permitted verification command, an If/When condition followed by a permitted command, or a direct statement of an assigned INTRO CLAIM cited with its exact source URL.",
        "The application owns the quick answer. Repair only the editorial opening paragraph.",
        `Evidence-backed offerings you may name: ${services.length ? services.join(", ") : "none"}`,
        "INTRO CLAIMS",
        claimLedger(introClaims(input.packet, input.keyword)),
        `CURRENT INTRODUCTION\n${existingHtml}`,
        "APPLICATION-OWNED REPAIR DIRECTIVES",
        ...directives.map((directive) => `- ${directive}`),
        "Return only the replacement introduction HTML.",
      ].join("\n\n"),
    },
  ];
}

function assembleContent(
  introHtml: string,
  sectionHtml: Map<string, string>,
  outline: GroundedBlogOutline,
): string {
  return [
    introHtml,
    ...outline.sections.map((section) => sectionHtml.get(section.id) ?? ""),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function hydrateSectionedBlogDraftFromContent(
  draft: SectionedBlogDraft,
  content: string,
  outline: GroundedBlogOutline,
): SectionedBlogDraft {
  const parsed = new Map(
    splitBlogHtmlSections(content).map((section) => [section.id, section.html]),
  );
  const sectionHtml = new Map(draft.sectionHtml);
  for (const section of outline.sections) {
    const sanitized = parsed.get(section.id);
    if (sanitized) sectionHtml.set(section.id, sanitized);
  }
  const introHtml = parsed.get("intro") ?? draft.introHtml;
  return {
    ...draft,
    introHtml,
    sectionHtml,
    content: assembleContent(introHtml, sectionHtml, outline),
  };
}

export async function generateSectionedBlogDraft(
  input: SectionWriterInput,
): Promise<SectionedBlogDraft> {
  const messages: AIMessage[] = [];
  let introResponse = await input.invoke(buildIntroMessages(input));
  messages.push(introResponse);
  let preparedIntro = prepareGeneratedIntroHtml(
    toTextContent(introResponse.content),
    input,
  );
  if (preparedIntro.removedBlocks > 0 || preparedIntro.hardIssues.length > 0) {
    introResponse = await input.invoke(
      buildIntroRepairMessages(
        input,
        preparedIntro.html,
        groundingRepairDirectives(preparedIntro),
      ),
    );
    messages.push(introResponse);
    preparedIntro = prepareGeneratedIntroHtml(
      toTextContent(introResponse.content),
      input,
    );
  }
  const introHtml = preparedIntro.html;
  const sectionHtml = new Map<string, string>();
  const priorHeadings: string[] = [];
  for (const section of input.outline.sections) {
    if (/faq|questions/i.test(section.heading)) {
      sectionHtml.set(
        section.id,
        buildDeterministicFaqSection(input.packet, section, input.keyword),
      );
      priorHeadings.push(section.heading);
      continue;
    }
    let response = await input.invoke(
      buildSectionWriterMessages(input, section, { priorHeadings }),
    );
    messages.push(response);
    let prepared = prepareGeneratedSectionHtml(
      toTextContent(response.content),
      input,
      section,
    );
    const budget = sectionWordBudget(
      section,
      input.targetWordCount,
      input.outline,
    );
    let generatedWords = plainText(prepared.html)
      .split(/\s+/)
      .filter(Boolean).length;
    if (
      prepared.removedBlocks > 0 ||
      prepared.hardIssues.length > 0 ||
      generatedWords < Math.round(budget.min * 0.8)
    ) {
      const repairDirectives = groundingRepairDirectives(prepared);
      if (generatedWords < Math.round(budget.min * 0.8)) {
        repairDirectives.push(
          `This section has only ${generatedWords} words. Expand it to ${budget.min}-${budget.max} words using short paragraphs, one useful H3, and one concise list. Add decision depth without adding business facts or universal outcome claims.`,
        );
      }
      response = await input.invoke(
        buildSectionWriterMessages(input, section, {
          existingHtml: prepared.html,
          repairDirectives,
          priorHeadings,
        }),
      );
      messages.push(response);
      prepared = prepareGeneratedSectionHtml(
        toTextContent(response.content),
        input,
        section,
      );
      generatedWords = plainText(prepared.html)
        .split(/\s+/)
        .filter(Boolean).length;
    }
    sectionHtml.set(section.id, prepared.html);
    priorHeadings.push(section.heading);
  }
  return {
    introHtml,
    sectionHtml,
    content: assembleContent(introHtml, sectionHtml, input.outline),
    messages,
    repairAttempts: {},
  };
}

export function buildQualityRepairDirectives(
  verdict: ExpertVoiceVerdict,
): string[] {
  const directives: string[] = [];
  if (verdict.dimensions.specificity < 7) {
    directives.push(
      "Replace generic explanation with one concrete decision rule supported by an assigned claim; remove unsupported specificity.",
    );
  }
  if (verdict.dimensions.opinions < 7) {
    directives.push(
      "Take a direct position for a named reader condition instead of presenting both choices neutrally.",
    );
  }
  if (verdict.dimensions.livedExperience < 7) {
    directives.push(
      "Explain a practical tradeoff or mistake without claiming first-hand business experience, a customer story, or an undocumented workflow.",
    );
  }
  if (verdict.dimensions.hedgingFreedom < 7) {
    directives.push(
      "Remove hedging, filler, repeated setup, and empty transitions; every remaining sentence must advance the decision.",
    );
  }
  if (verdict.dimensions.offeringUse < 7) {
    directives.push(
      "Use the assigned evidence-backed offering where relevant, but do not infer a benefit or implementation detail.",
    );
  }
  const finalDirectives = directives.length
    ? directives
    : [
        "Tighten this section using only assigned claims and add one new decision insight.",
      ];
  // A quality rewrite must not push the document under the length gate: the
  // writer under-delivers budgets, so an unconstrained rewrite tends to come
  // back shorter and converts a judge failure into a terminal length failure.
  finalDirectives.push(
    "Keep the rewritten section at or above its current word count by replacing weak prose with substantive decision guidance, never by deleting coverage.",
  );
  return finalDirectives;
}

export function selectQualityRepairSectionIds(
  outline: GroundedBlogOutline,
  verdict: ExpertVoiceVerdict,
): string[] {
  if (verdict.overall >= 7) return [];
  const selected: string[] = [];
  if (
    verdict.dimensions.opinions < 7 ||
    verdict.dimensions.hedgingFreedom < 7
  ) {
    selected.push("intro");
  }
  const weakSubstance =
    verdict.dimensions.specificity < 7 ||
    verdict.dimensions.opinions < 7 ||
    verdict.dimensions.livedExperience < 7 ||
    verdict.dimensions.offeringUse < 7;
  selected.push(
    ...outline.sections
      .filter((section) => {
        if (/faq|questions/i.test(section.heading)) return false;
        if (/next steps|conclusion|summary/i.test(section.heading)) {
          return weakSubstance;
        }
        return weakSubstance || verdict.dimensions.hedgingFreedom < 7;
      })
      .map((section) => section.id),
  );
  return [...new Set(selected)];
}

export function buildFailureRepairDirectives(
  failures: SectionValidationFailure[],
): string[] {
  return failures.map((failure) => {
    if (failure.issueKind === "length") {
      const excerpt = clean(failure.claimExcerpt);
      const match = excerpt.match(
        /length:\s*(\d+)\s*words outside\s*(\d+)-(\d+)/i,
      );
      const current = Number(match?.[1]);
      const minimum = Number(match?.[2]);
      const maximum = Number(match?.[3]);
      if (
        Number.isFinite(current) &&
        Number.isFinite(maximum) &&
        current > maximum
      ) {
        return "Shorten this section toward its assigned word range by removing repetition, generic setup, and duplicated conclusions. Preserve every exact assigned claim, citation, and distinct decision insight.";
      }
      return "Expand this section toward its assigned word range with useful general decision guidance, explicit reader conditions, and meaningful tradeoffs. Do not add, repeat, copy, paraphrase, or infer business facts; application-owned evidence remains unchanged.";
    }
    return [
      `Remove or correct the ${failure.issueKind} failure: ${clean(failure.reason)}.`,
      failure.claimExcerpt
        ? `Rejected excerpt: ${clean(failure.claimExcerpt).slice(0, 220)}.`
        : "",
      failure.allowedFacts.length
        ? `Allowed facts: ${failure.allowedFacts.join(" | ")}.`
        : "No replacement fact is available; omit the claim.",
    ]
      .filter(Boolean)
      .join(" ");
  });
}

function supplementalWordBudget(
  failures: SectionValidationFailure[],
  bodySectionCount: number,
): { min: number; max: number } {
  const lengthFailure = failures.find(
    (failure) => failure.issueKind === "length",
  );
  const match = clean(lengthFailure?.claimExcerpt ?? "").match(
    /length:\s*(\d+)\s*words outside\s*(\d+)-(\d+)/i,
  );
  const current = Number(match?.[1]);
  const minimum = Number(match?.[2]);
  const maximum = Number(match?.[3]);
  // Aim at the middle of the allowed range, not the bare minimum: the writer
  // reliably under-delivers its budget, and a minimum-targeting supplement
  // leaves the document a few words short round after round until the
  // correction budget runs out.
  const goal =
    Number.isFinite(minimum) && Number.isFinite(maximum)
      ? Math.round((minimum + maximum) / 2)
      : Number.isFinite(minimum)
        ? minimum
        : Number.NaN;
  const deficit =
    Number.isFinite(current) && Number.isFinite(goal)
      ? Math.max(0, goal - current)
      : 200;
  const perSection = Math.ceil(deficit / Math.max(1, bodySectionCount));
  const min = Math.max(90, Math.min(160, perSection + 35));
  return { min, max: Math.min(220, min + 60) };
}

function buildSectionSupplementMessages(
  input: SectionWriterInput,
  section: GroundedOutlineSection,
  existingHtml: string,
  failures: SectionValidationFailure[],
): SectionWriterMessage[] {
  const bodySectionCount = input.outline.sections.filter(
    (candidate) =>
      !/faq|questions|next steps|conclusion|summary/i.test(candidate.heading),
  ).length;
  const budget = supplementalWordBudget(failures, bodySectionCount);
  return [
    { role: "system", content: sectionSystemPrompt(input) },
    {
      role: "user",
      content: [
        "ADD ONE SUPPLEMENTAL DECISION LENS TO THIS LOCKED SECTION",
        `Section ID: ${section.id}`,
        `Section heading: ${section.heading}`,
        `Section purpose: ${section.purpose}`,
        `Write AT LEAST ${budget.min} NEW words and at most ${budget.max}. A supplement under ${budget.min} words will be rejected.`,
        "Return one descriptive H3 followed by one or two short paragraphs or one concise list.",
        "Do not return an H2. Do not rewrite, summarize, or repeat the existing section.",
        "Do not name the business, its services, locations, prices, timing, capabilities, customers, or outcomes. Do not add factual claims that require a source.",
        "Add generally applicable decision guidance: a reader condition, a tradeoff, concrete questions to ask, and a practical verification step.",
        `EXISTING SECTION - USE ONLY TO AVOID REPETITION\n${existingHtml}`,
        "Return only the supplemental HTML fragment.",
      ].join("\n\n"),
    },
  ];
}

function normalizeSupplementalHtml(raw: string): string {
  const content = stripDocumentShell(raw)
    .replace(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, "")
    .replace(
      /<aside\b[^>]*data-uplift-assembled=["']section-evidence["'][^>]*>[\s\S]*?<\/aside>/gi,
      "",
    )
    .replace(
      /<div\b[^>]*class=["'][^"']*(?:quick-answer|local-tip|reviews|key-takeaways)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      "",
    )
    .trim();
  return splitLongParagraphs(normalizeRootTextBlocks(content));
}

export async function repairSectionedBlogDraft(input: {
  writer: SectionWriterInput;
  draft: SectionedBlogDraft;
  sectionIds: string[];
  verdict?: ExpertVoiceVerdict;
  failures?: SectionValidationFailure[];
  maxAttemptsPerSection?: number;
}): Promise<SectionedBlogDraft> {
  const sectionHtml = new Map(input.draft.sectionHtml);
  const messages = [...input.draft.messages];
  const repairAttempts = { ...input.draft.repairAttempts };
  const requested = new Set(input.sectionIds);
  const priorHeadings = input.writer.outline.sections.map(
    (section) => section.heading,
  );
  let introHtml = input.draft.introHtml;
  if (requested.has("intro")) {
    const currentAttempts = repairAttempts.intro ?? 0;
    if (currentAttempts < (input.maxAttemptsPerSection ?? 2)) {
      const introFailures = (input.failures ?? []).filter(
        (failure) =>
          failure.sectionId === "intro" || failure.sectionId === "document",
      );
      const directives = introFailures.length
        ? buildFailureRepairDirectives(introFailures)
        : input.verdict
          ? buildQualityRepairDirectives(input.verdict)
          : ["Remove unsupported content and use only assigned claims."];
      const response = await input.writer.invoke(
        buildIntroRepairMessages(input.writer, introHtml, directives),
      );
      messages.push(response);
      introHtml = prepareGeneratedIntroHtml(
        toTextContent(response.content),
        input.writer,
      ).html;
      repairAttempts.intro = currentAttempts + 1;
    }
  }
  for (const section of input.writer.outline.sections) {
    if (!requested.has(section.id)) continue;
    const currentAttempts = repairAttempts[section.id] ?? 0;
    if (currentAttempts >= (input.maxAttemptsPerSection ?? 2)) continue;
    if (/faq|questions/i.test(section.heading)) {
      sectionHtml.set(
        section.id,
        buildDeterministicFaqSection(
          input.writer.packet,
          section,
          input.writer.keyword,
        ),
      );
      repairAttempts[section.id] = currentAttempts + 1;
      continue;
    }
    const sectionFailures = (input.failures ?? []).filter(
      (failure) =>
        failure.sectionId === section.id || failure.sectionId === "document",
    );
    const lengthOnly =
      sectionFailures.length > 0 &&
      sectionFailures.every((failure) => failure.issueKind === "length");
    // Supplements APPEND — correct for under-length, catastrophic for
    // over-length (a 3,484-word draft "repaired" to 4,461 across rounds).
    // Over-max routes to the rewrite path, whose directive is "shorten".
    const lengthExcerpt =
      sectionFailures.find((failure) => failure.issueKind === "length")
        ?.claimExcerpt ?? "";
    const lengthMatch = lengthExcerpt.match(
      /length:\s*(\d+)\s*words outside\s*(\d+)-(\d+)/i,
    );
    const overMax = lengthMatch
      ? Number(lengthMatch[1]) > Number(lengthMatch[3])
      : false;
    if (lengthOnly && !overMax) {
      const existingHtml = sectionHtml.get(section.id) ?? "";
      const response = await input.writer.invoke(
        buildSectionSupplementMessages(
          input.writer,
          section,
          existingHtml,
          sectionFailures,
        ),
      );
      messages.push(response);
      const supplemental = normalizeSupplementalHtml(
        toTextContent(response.content),
      );
      if (supplemental) {
        sectionHtml.set(
          section.id,
          prepareGeneratedSectionHtml(
            `${existingHtml}\n${supplemental}`,
            input.writer,
            section,
          ).html,
        );
      }
      repairAttempts[section.id] = currentAttempts + 1;
      continue;
    }
    const isQualityOnlyRepair =
      sectionFailures.length === 0 && Boolean(input.verdict);
    const directives = sectionFailures.length
      ? buildFailureRepairDirectives(sectionFailures)
      : input.verdict
        ? buildQualityRepairDirectives(input.verdict)
        : ["Remove unsupported content and use only assigned claims."];
    const previousHtml = sectionHtml.get(section.id) ?? "";
    const response = await input.writer.invoke(
      buildSectionWriterMessages(input.writer, section, {
        existingHtml: previousHtml,
        repairDirectives: directives,
        priorHeadings: priorHeadings.filter(
          (heading) => heading !== section.heading,
        ),
      }),
    );
    messages.push(response);
    const rewrittenHtml = prepareGeneratedSectionHtml(
      toTextContent(response.content),
      input.writer,
      section,
    ).html;
    const previousWords = plainText(previousHtml)
      .split(/\s+/)
      .filter(Boolean).length;
    const rewrittenWords = plainText(rewrittenHtml)
      .split(/\s+/)
      .filter(Boolean).length;
    // A quality rewrite that guts the section converts a sub-bar judge score
    // into a terminal LENGTH failure — strictly worse than keeping the prior
    // prose. Deterministic failures (grounding/structure) may shrink freely;
    // pure editorial rewrites must roughly preserve size.
    if (
      isQualityOnlyRepair &&
      previousWords > 0 &&
      rewrittenWords < Math.round(previousWords * 0.85)
    ) {
      console.warn(
        `🛡️ Quality rewrite for "${section.heading}" shrank ${previousWords}→${rewrittenWords} words; keeping the prior section`,
      );
    } else {
      sectionHtml.set(section.id, rewrittenHtml);
    }
    repairAttempts[section.id] = currentAttempts + 1;
  }
  return {
    introHtml,
    sectionHtml,
    content: assembleContent(introHtml, sectionHtml, input.writer.outline),
    messages,
    repairAttempts,
  };
}

function plainText(html: string): string {
  return clean(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&"),
  );
}

function summary(value: string, max = 155): string {
  const text = clean(value);
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const breakAt = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, breakAt > 80 ? breakAt : clipped.length).trim()}.`;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.map((value) => clean(value ?? "")).filter(Boolean)),
  ];
}

export function buildSectionedBlogPayload(input: {
  draft: SectionedBlogDraft;
  packet: CanonicalBlogFactPacket;
  outline: GroundedBlogOutline;
  keyword: string;
  locale: string;
  userId: string;
  businessId: string;
  keywordId?: string;
  plannedPublishInfo: { date: string; time: string };
  selectedTitle: {
    title: string;
    seoTitle: string;
    structureType: string;
    contentIntent: string;
    keywordUsed: string;
    characterCount?: number;
    keywordPosition?: number;
  };
}): SectionedBlogPayload {
  const words = plainText(input.draft.content)
    .split(/\s+/)
    .filter(Boolean).length;
  const evidenceBackedServices = getEvidenceBackedServices(input.packet);
  // The excerpt/meta feed the grounding gate but sit OUTSIDE the body
  // sanitizer's reach — intro prose with a stray performance/availability
  // word made the gate fail every round with nothing left to repair. Build
  // them from the gate-safe fact template instead.
  const excerptBusinessName =
    input.packet.identity.businessName ?? "The business";
  const excerpt = summary(
    evidenceBackedServices.length
      ? `${excerptBusinessName} handles ${listText(evidenceBackedServices.slice(0, 3))} — compare the options and confirm details for your exact situation.`
      : plainText(input.draft.introHtml),
    155,
  );
  // Meta description = the entity-bearing excerpt alone. Prefixing the title
  // merged its outcome verbs ("how to PREVENT…") with the business name in
  // one gate segment — an unrepairable performance_claim.
  const seoDescription = summary(excerpt, 160);
  const tags = unique([input.keyword, ...evidenceBackedServices.slice(0, 4)]);
  const categories = evidenceBackedServices.length
    ? evidenceBackedServices.slice(0, 2)
    : ["Guides"];
  return CREATE_BLOG.parse({
    userId: input.userId,
    businessId: input.businessId,
    title: input.outline.title,
    slug: slugify(input.outline.title),
    status: "DRAFT",
    author: input.packet.author.name,
    content: input.draft.content,
    excerpt,
    categories,
    tags,
    featured_media: "",
    keywordId: input.keywordId,
    analytics: {
      contentQualityScore: 0,
      rankingPotential: "MEDIUM",
      conversionPotential: "MEDIUM",
      externalLinksCount: (input.draft.content.match(/<a\b[^>]*href=/gi) ?? [])
        .length,
      selectedTitle: input.selectedTitle,
      sectionedWriter: true,
      sectionCount: input.outline.sections.length,
    },
    meta: {
      seo_title: input.outline.seoTitle,
      seo_description: seoDescription,
      focus_keyword: input.keyword,
      keywords: tags,
      og_title: input.outline.title,
      og_description: seoDescription,
      og_type: "article",
      og_url: input.packet.identity.website ?? undefined,
      og_site_name: input.packet.identity.businessName ?? undefined,
      og_locale: input.locale,
      article_author: input.packet.author.name,
      article_section: categories[0],
      article_tags: tags,
    },
    custom_fields: {
      reading_time: `${Math.max(1, Math.ceil(words / 220))} min`,
      rating: 8,
    },
    blogPublishInfo: input.plannedPublishInfo,
  });
}
