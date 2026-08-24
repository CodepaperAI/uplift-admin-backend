import type { CanonicalBlogFactPacket } from "./canonical-blog-facts.service";
import {
  getEvidenceBackedServices,
  getTopicRelevantEvidenceBackedServices,
  isClaimRelevantToTopic,
  topicMatchTokens,
} from "./blog-claim-evidence.service";
import { splitBlogHtmlSections } from "../utils/blog-section-repair.utils";
import type { BusinessModelType } from "../utils/blog-substance.utils";

export interface GroundedOutlineSection {
  id: string;
  heading: string;
  purpose: string;
  allowedClaimIds: string[];
  required: boolean;
}

export interface GroundedBlogOutline {
  version: 1;
  title: string;
  seoTitle: string;
  intent: string;
  sections: GroundedOutlineSection[];
}

export interface FaqStructureIssue {
  sectionId: string;
  questionCount: number;
  answerCount: number;
}

type WriterStructure =
  | "complete-guide"
  | "list-based"
  | "how-to"
  | "best-practices"
  | "mistakes"
  | "alternatives"
  | "process"
  | "question"
  | "service-page";

const WRITER_STRUCTURES: ReadonlySet<string> = new Set([
  "complete-guide",
  "list-based",
  "how-to",
  "best-practices",
  "mistakes",
  "alternatives",
  "process",
  "question",
  "service-page",
]);

function normalizeWriterStructure(
  value: string | undefined,
): WriterStructure | undefined {
  return value && WRITER_STRUCTURES.has(value)
    ? (value as WriterStructure)
    : undefined;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function idFor(value: string, index: number): string {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `outline-${index + 1}-${slug || "section"}`;
}

function topicLabel(keyword: string | undefined, title: string): string {
  const keywordLabel = clean(keyword ?? "");
  if (keywordLabel) return keywordLabel;
  const titleLead = clean(title.split(":")[0] ?? title);
  return titleLead || "the topic";
}

function structureHeadings(
  structure: WriterStructure | undefined,
  topic: string,
): string[] | null {
  switch (structure) {
    case "complete-guide":
      return [
        `${topic}: key concepts`,
        `Options and approaches for ${topic}`,
        `How to evaluate ${topic}`,
      ];
    case "list-based":
      return [
        `${topic}: options at a glance`,
        `Options to consider for ${topic}`,
        `How to choose for ${topic}`,
      ];
    case "how-to":
    case "process":
      return [
        `Before you begin with ${topic}`,
        `${topic}: step-by-step process`,
        `Common mistakes with ${topic}`,
      ];
    case "best-practices":
      return [
        `What to know about ${topic}`,
        `Best practices for ${topic}`,
        `How to apply these practices`,
      ];
    case "mistakes":
      return [
        `What to know about ${topic}`,
        `Common mistakes with ${topic}`,
        `A better approach to ${topic}`,
      ];
    case "alternatives":
      return [
        `${topic}: options at a glance`,
        `How the options differ`,
        `How to choose for ${topic}`,
      ];
    case "question":
      return [
        `The short answer about ${topic}`,
        `What to know about ${topic}`,
        `How to decide what to do next`,
      ];
    case "service-page":
      return [
        `${topic}: service scope at a glance`,
        `Options available for ${topic}`,
        `How the ${topic} process works`,
        `What to confirm before booking ${topic}`,
      ];
    default:
      return null;
  }
}

function materializeArchetypeHeading(
  heading: string,
  topic: string,
): string | null {
  const value = clean(heading)
    .replace(/\[(?:topic)\]/gi, topic)
    .replace(/\((?:optional)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return null;
  if (
    /^(?:hero|above[- ]fold|introduction|final cta|cta section)$/i.test(value)
  ) {
    return null;
  }
  if (/table of contents|\btoc\b|schema|author/i.test(value)) return null;
  if (/^pricing$/i.test(value)) return null;
  if (/^testimonials?$/i.test(value)) return null;
  if (/^entry\s*#?2[-–]10/i.test(value))
    return `Options to consider for ${topic}`;
  if (/^conclusion$/i.test(value)) return "Next steps";
  if (/^faq$/i.test(value)) return "Frequently asked questions";
  return value;
}

function allocateBodyClaimIds(
  headings: string[],
  packet: CanonicalBlogFactPacket,
  topic: string,
  useLocalSection: boolean,
  claimsPerSection = 2,
): Map<string, string[]> {
  const allocations = new Map(
    headings.map((heading) => [heading, [] as string[]]),
  );
  const businessClaims = packet.claims
    .filter(
      (claim) =>
        claim.classification === "business" &&
        claim.type !== "business_identity" &&
        claim.type !== "business_contact" &&
        isClaimRelevantToTopic(claim, topic, {
          allowLocation: useLocalSection,
        }),
    )
    .sort((left, right) => {
      const leftOwned = left.authority === "owned_website" ? 1 : 0;
      const rightOwned = right.authority === "owned_website" ? 1 : 0;
      return rightOwned - leftOwned;
    });
  const available = new Set(businessClaims.map((claim) => claim.id));
  const topicTokens = topicMatchTokens(topic);

  const scoreForHeading = (heading: string, claimId: string): number => {
    const claim = businessClaims.find((candidate) => candidate.id === claimId);
    if (!claim) return 0;
    const headingText = heading.toLowerCase();
    const claimText =
      `${claim.text} ${claim.evidenceExcerpt ?? ""} ${claim.sourceUrl ?? ""}`.toLowerCase();
    const headingWords = headingText
      .split(/[^a-z0-9]+/)
      .filter(
        (word) =>
          word.length >= 4 &&
          ![
            "documented",
            "options",
            "services",
            "choices",
            "from",
            "about",
            "with",
          ].includes(word),
      );
    const topicOverlap = topicTokens.filter((word) =>
      claimText.includes(word),
    ).length;
    if (topicTokens.length > 0 && topicOverlap === 0) return 0;
    let score = topicOverlap * 8;
    score += headingWords.filter((word) => claimText.includes(word)).length * 4;
    if (claim.authority === "owned_website") score += 2;
    if (
      /\b(?:pricing|capacity|booking)\b/.test(headingText) &&
      /\b(?:price|\$|cost|guest|people|advance|book|day|hour)\b/.test(claimText)
    ) {
      score += 24;
    }
    if (
      /\b(?:local|coverage|availability)\b/.test(headingText) &&
      /\b(?:toronto|gta|mississauga|brampton|delivery|coverage|location)\b/.test(
        claimText,
      )
    ) {
      score += 24;
    }
    if (
      /\b(?:service|menu|choice)\b/.test(headingText) &&
      /\b(?:menu|cuisine|shawarma|falafel|kebab|catering|lunch)\b/.test(
        claimText,
      )
    ) {
      score += 16;
    }
    return score;
  };

  // Give every section its best unused claim before any section receives a
  // second claim. This prevents generic headings from repeating the same
  // high-overlap evidence throughout the article.
  for (let pass = 0; pass < claimsPerSection; pass += 1) {
    for (const heading of headings) {
      const allocation = allocations.get(heading)!;
      const relevant = [...available]
        .sort(
          (left, right) =>
            scoreForHeading(heading, right) - scoreForHeading(heading, left),
        )
        .find((claimId) => scoreForHeading(heading, claimId) > 0);
      const claimId = relevant;
      if (!claimId) continue;
      allocation.push(claimId);
      available.delete(claimId);
    }
  }

  // Authoritative educational claims (Exa/authoritative research) are the
  // depth fuel for detailed sections. They were previously never allocated —
  // classification==="business" filtered them out — so the writer could not
  // cite the very passages retrieved for it. Round-robin them on top of the
  // business-claim allocation.
  const educationalClaimIds = packet.claims
    .filter(
      (claim) =>
        claim.classification === "educational" &&
        claim.authority === "authoritative_external" &&
        Boolean(claim.sourceUrl) &&
        isClaimRelevantToTopic(claim, topic),
    )
    .map((claim) => claim.id);
  if (educationalClaimIds.length > 0 && headings.length > 0) {
    let headingIndex = 0;
    for (const claimId of educationalClaimIds) {
      const candidates = headings.filter(
        (heading) => allocations.get(heading)!.length < claimsPerSection,
      );
      if (candidates.length === 0) break;
      const heading = candidates[headingIndex % candidates.length]!;
      allocations.get(heading)!.push(claimId);
      headingIndex += 1;
    }
  }
  return allocations;
}

function evidenceLedHeadings(
  packet: CanonicalBlogFactPacket,
  topic: string,
  structure: WriterStructure | undefined,
  businessModelType: BusinessModelType | undefined,
  useLocalSection: boolean,
): string[] | null {
  if (structure === "list-based" || structure === "alternatives") return null;
  const ownedClaims = packet.claims.filter(
    (claim) =>
      claim.classification === "business" &&
      claim.authority === "owned_website" &&
      Boolean(claim.sourceUrl) &&
      isClaimRelevantToTopic(claim, topic, {
        allowLocation: useLocalSection,
      }),
  );
  if (ownedClaims.length < 4) return null;

  const businessName = clean(packet.identity.businessName ?? "the business");
  const isProduct = businessModelType === "product";
  const headings = [
    `${businessName}'s documented options for ${topic}`,
    isProduct
      ? `Documented products and choices from ${businessName}`
      : `Documented services and choices from ${businessName}`,
  ];
  const operationText = [
    ...ownedClaims.flatMap((claim) => [
      claim.text,
      claim.evidenceExcerpt ?? "",
    ]),
  ].join(" ");
  if (
    /\b(?:price|cost|guest|people|persons?|advance|book|day|hour|delivery|pickup)\b/i.test(
      operationText,
    )
  ) {
    headings.push(
      isProduct
        ? "Pricing, dimensions, delivery, and purchase details"
        : "Pricing, capacity, and booking details",
    );
  }
  if (
    useLocalSection &&
    (packet.location.verified ||
      packet.serviceAreas.length > 0 ||
      ownedClaims.some((claim) => claim.type === "business_location"))
  ) {
    headings.push(`Local coverage and availability for ${topic}`);
  }
  if (headings.length < 4) {
    headings.push(`How to choose among the documented options for ${topic}`);
  }
  return headings;
}

function serviceGroupHeadings(
  packet: CanonicalBlogFactPacket,
  topic: string,
  targetWordCount?: number,
): string[] | null {
  const relevantServices = getTopicRelevantEvidenceBackedServices(packet, topic);
  const cleanServices = (relevantServices.length > 0
    ? relevantServices
    : topicMatchTokens(topic).length === 0
      ? getEvidenceBackedServices(packet)
      : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, 12);
  if (cleanServices.length < 3) return null;
  // Single-service headings only at true long-form: at mid-length targets a
  // per-service section for every offering inflates the outline (11 sections
  // for a 3,000-word target → 4,009 words, unshrinkable), while grouped pairs
  // stay readable.
  const target = targetWordCount ?? 0;
  const groupSize = target >= 4_000 ? 1 : target >= 2_500 ? 2 : 3;
  const headings: string[] = [];
  for (let index = 0; index < cleanServices.length; index += groupSize) {
    const group = cleanServices.slice(index, index + groupSize);
    headings.push(
      group.length === 1
        ? group[0]!
        : `${group.slice(0, -1).join(", ")}, and ${group.at(-1)}`,
    );
  }
  return headings;
}

function addLongFormDepthHeadings(
  headings: string[],
  topic: string,
  targetWordCount?: number,
): string[] {
  if ((targetWordCount ?? 0) < 2_500) return headings;
  const expanded = [...headings];
  const candidates = [
    `What matters before comparing ${topic}`,
    `How ${topic} typically works from first contact to completion`,
    `Cost factors and how quotes are structured for ${topic}`,
    `Common mistakes to avoid with ${topic}`,
    `How support formats change the decision`,
    `How to match an option to a realistic routine`,
    `What to confirm before choosing`,
    `Questions to ask before booking ${topic}`,
    `How to choose a sensible starting point`,
    `How to review the choice after getting started`,
  ];
  const target = targetWordCount ?? 0;
  const sectionCap = target >= 6_000 ? 13 : target >= 4_000 ? 10 : 7;
  for (const candidate of candidates) {
    if (expanded.length >= sectionCap) break;
    if (
      expanded.some(
        (heading) => clean(heading).toLowerCase() === candidate.toLowerCase(),
      )
    ) {
      continue;
    }
    expanded.push(candidate);
  }
  return expanded;
}

function minimumBodySectionCount(targetWordCount?: number): number {
  const target = targetWordCount ?? 1_300;
  if (target >= 8_000) return 13;
  if (target >= 6_000) return 11;
  if (target >= 4_000) return 9;
  if (target >= 3_200) return 7;
  if (target >= 2_500) return 6;
  if (target >= 2_000) return 5;
  if (target >= 1_600) return 4;
  return 3;
}

function ensureAchievableBodyDepth(
  headings: string[],
  topic: string,
  packet: CanonicalBlogFactPacket,
  targetWordCount?: number,
  businessModelType?: BusinessModelType,
  useLocalSection = true,
): string[] {
  const expanded = [...headings];
  const desired = minimumBodySectionCount(targetWordCount);
  const candidates = [
    `What matters before choosing ${topic}`,
    `How to compare the available options for ${topic}`,
    packet.operatingFacts.length > 0
      ? businessModelType === "product"
        ? "Price, dimensions, delivery, and purchase details to confirm"
        : "Costs, timing, and practical details to confirm"
      : `Practical details to confirm for ${topic}`,
    useLocalSection &&
    (packet.location.verified || packet.serviceAreas.length > 0)
      ? `Local considerations for ${topic}`
      : `How to match ${topic} to the actual need`,
    `Common decision mistakes with ${topic}`,
    `A practical checklist for choosing ${topic}`,
    `How to make the final decision about ${topic}`,
  ];
  for (const candidate of candidates) {
    if (expanded.length >= desired) break;
    const key = clean(candidate).toLowerCase();
    if (expanded.some((heading) => clean(heading).toLowerCase() === key)) {
      continue;
    }
    expanded.push(candidate);
  }
  return expanded;
}

function evidenceSectionPurpose(index: number): string {
  const purposes = [
    "Help the reader choose a starting point with direct questions, verification steps, and if/then selection rules. The application renders assigned facts separately; do not paraphrase them or add market norms.",
    "Frame one practical comparison the reader can perform. Use commands and conditional decision rules, avoid provider capability claims, and do not repeat the previous section's structure.",
    "Show how to decide between documented options without explaining undocumented outcomes. State what the reader should ask, record, compare, or verify before choosing.",
    "Resolve one likely uncertainty through a concise decision protocol. Keep uncited prose editorial and do not describe what providers, formats, contracts, or venues generally do.",
  ];
  return purposes[index % purposes.length]!;
}

function claimFreeSectionPurpose(index: number): string {
  const purposes = [
    "Define the reader's decision criteria with direct questions, verification steps, and conditional selection rules. Do not add business or market facts.",
    "Frame a practical comparison using only reader-owned constraints and details the reader can verify directly. Do not characterize the business or its inventory.",
    "Give a concise decision protocol using questions and if/then rules. Do not infer services, prices, locations, operations, or outcomes.",
    "Identify the tradeoff the reader must resolve and the exact current detail to confirm. Keep every business-specific premise out of the prose.",
  ];
  return purposes[index % purposes.length]!;
}

function actionableClaimIds(
  packet: CanonicalBlogFactPacket,
  topic: string,
  useLocalSection: boolean,
): string[] {
  const actionTerms = [
    "app",
    "book",
    "booking",
    "consult",
    "membership",
    "class finder",
    "check-in",
    "qr",
  ];
  return packet.claims
    .filter(
      (claim) =>
        claim.classification === "business" &&
        claim.authority === "owned_website" &&
        isClaimRelevantToTopic(claim, topic, {
          allowLocation: useLocalSection,
        }) &&
        actionTerms.some((term) => claim.text.toLowerCase().includes(term)),
    )
    .slice(0, 2)
    .map((claim) => claim.id);
}

export function buildGroundedBlogOutline(input: {
  packet: CanonicalBlogFactPacket;
  title: string;
  seoTitle: string;
  intent: string;
  keyword?: string;
  structureType?: string;
  requiredSections?: string[];
  requiredModules?: string[];
  targetWordCount?: number;
  businessModelType?: BusinessModelType;
  useLocalSection?: boolean;
}): GroundedBlogOutline {
  const topic = topicLabel(input.keyword, input.title);
  const useLocalSection =
    input.useLocalSection ??
    (input.packet.location.verified || input.packet.serviceAreas.length > 0);
  const titleStructureHeadings = structureHeadings(
    normalizeWriterStructure(input.structureType),
    topic,
  );
  const evidenceHeadings = evidenceLedHeadings(
    input.packet,
    topic,
    normalizeWriterStructure(input.structureType),
    input.businessModelType,
    useLocalSection,
  );
  const groupedServiceHeadings =
    input.structureType === "list-based" ||
    input.structureType === "alternatives"
      ? serviceGroupHeadings(input.packet, topic, input.targetWordCount)
      : null;
  const baseRequiredHeadings =
    groupedServiceHeadings ??
    evidenceHeadings ??
    titleStructureHeadings ??
    (input.requiredSections ?? [])
      .map((heading) => materializeArchetypeHeading(heading, topic))
      .filter((heading): heading is string => Boolean(heading));
  const requiredHeadings = ensureAchievableBodyDepth(
    addLongFormDepthHeadings(
      baseRequiredHeadings,
      topic,
      input.targetWordCount,
    ),
    topic,
    input.packet,
    input.targetWordCount,
    input.businessModelType,
    useLocalSection,
  );
  const headings = [...requiredHeadings].map(clean).filter(Boolean);
  if (headings.length === 0) {
    headings.push("What to know", "How to evaluate the options", "Next steps");
  }
  if (!headings.some((heading) => /faq|questions/i.test(heading))) {
    headings.push("Frequently asked questions");
  }
  if (
    !headings.some((heading) => /next steps|conclusion|summary/i.test(heading))
  ) {
    headings.push("Next steps");
  }

  const seen = new Set<string>();
  const unique = headings.filter((heading) => {
    const key = heading.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const explicitRequired = new Set(
    requiredHeadings.map((heading) => clean(heading).toLowerCase()),
  );
  const bodyHeadings = unique.filter(
    (heading) => !/faq|questions|next steps|conclusion|summary/i.test(heading),
  );
  // 5-7 claims per section, not 2-3: the writer must fill ~300 words per
  // section under a closed-world grammar, and with two facts it can only pad
  // with generic verification scaffolding — which the expert judge (grading
  // against the FULL fact list) then correctly scores 3-5/10. Starving the
  // writer of claims the judge can see was the systemic quality ceiling.
  const bodyAllocations = allocateBodyClaimIds(
    bodyHeadings,
    input.packet,
    topic,
    useLocalSection,
    (input.targetWordCount ?? 0) >= 1_600 ? 7 : 5,
  );
  const bodyClaimIds = new Set(
    bodyHeadings.flatMap((heading) => bodyAllocations.get(heading) ?? []),
  );
  const nextStepClaimIds = actionableClaimIds(
    input.packet,
    topic,
    useLocalSection,
  );

  return {
    version: 1,
    title: input.title,
    seoTitle: input.seoTitle,
    intent: input.intent,
    sections: unique.map((heading, index) => {
      const isFaq = /faq|questions/i.test(heading);
      const isNextSteps = /next steps|conclusion|summary/i.test(heading);
      const allowedClaimIds = isFaq
        ? [...bodyClaimIds]
        : isNextSteps
          ? nextStepClaimIds
          : (bodyAllocations.get(heading) ?? []);
      return {
        id: idFor(heading, index),
        heading,
        purpose: isFaq
          ? "Answer three non-duplicative decision questions. Add reasoning not already stated in the body and use only assigned claims."
          : isNextSteps
            ? "End with one direct starting recommendation and one alternative for a different reader need. Do not write a verification checklist, repeat the service inventory, or add unassigned business claims."
            : allowedClaimIds.length > 0
              ? evidenceSectionPurpose(index)
              : claimFreeSectionPurpose(index),
        allowedClaimIds,
        required: explicitRequired.has(heading.toLowerCase()),
      };
    }),
  };
}

export function buildGroundedOutlinePromptBlock(
  outline: GroundedBlogOutline,
): string {
  return [
    "APPROVED OUTLINE - LOCKED",
    JSON.stringify(outline, null, 2),
    "Write one H2 section at a time in this order. A section may use only its allowedClaimIds for factual claims.",
    'Copy each section heading exactly and emit its H2 as <h2 data-outline-id="SECTION_ID" id="stable-slug">HEADING</h2>.',
    "Do not add a factual premise to a heading. Do not add sections that imply an unsupported service, location, outcome, price, timing promise, or legal requirement.",
  ].join("\n");
}

export function findMissingOutlineSections(
  html: string,
  outline: GroundedBlogOutline | undefined,
): GroundedOutlineSection[] {
  if (!outline) return [];
  const headings = [
    ...String(html).matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi),
  ].map((match) => ({
    attributes: match[1] ?? "",
    text: clean((match[2] ?? "").replace(/<[^>]+>/g, " ")).toLowerCase(),
  }));
  return outline.sections.filter(
    (section) =>
      section.required &&
      !headings.some((heading) => {
        const outlineId = heading.attributes.match(
          /\bdata-outline-id\s*=\s*["']([^"']+)["']/i,
        )?.[1];
        return (
          outlineId === section.id ||
          heading.text.includes(section.heading.toLowerCase()) ||
          section.heading.toLowerCase().includes(heading.text)
        );
      }),
  );
}

export function findFaqStructureIssue(
  html: string,
  outline: GroundedBlogOutline | undefined,
): FaqStructureIssue | null {
  const faqSection = outline?.sections.find((section) =>
    /faq|questions/i.test(section.heading),
  );
  if (!faqSection) return null;
  const rendered = splitBlogHtmlSections(html).find(
    (section) => section.id === faqSection.id,
  );
  if (!rendered) {
    return {
      sectionId: faqSection.id,
      questionCount: 0,
      answerCount: 0,
    };
  }
  const explicitQuestions = (
    rendered.html.match(
      /<h3\b[^>]*class\s*=\s*["'][^"']*\bfaq-question\b[^"']*["'][^>]*>/gi,
    ) ?? []
  ).length;
  // Application-owned modules such as the author bio may follow the final FAQ
  // H2 and therefore share its broad HTML slice. Prefer explicit FAQ question
  // markers when present; retain the legacy all-H3 fallback for old drafts.
  const questionCount =
    explicitQuestions > 0
      ? explicitQuestions
      : (rendered.html.match(/<h3\b[^>]*>/gi) ?? []).length;
  const answerCount = (
    rendered.html.match(
      /<p\b[^>]*class\s*=\s*["'][^"']*\bfaq-answer\b[^"']*["'][^>]*>/gi,
    ) ?? []
  ).length;
  if (questionCount === 3 && answerCount === 3) return null;
  return { sectionId: faqSection.id, questionCount, answerCount };
}
