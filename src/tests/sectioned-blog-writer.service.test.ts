import { describe, expect, it } from "bun:test";
// Pin the closed-world contract for deterministic gate tests; production
// default enables general industry knowledge (product decision 2026-07-14).
process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED = "false";
import { AIMessage } from "@langchain/core/messages";

import {
  buildDeterministicFaqSection,
  buildFailureRepairDirectives,
  buildVerifiedSectionEvidenceBlock,
  buildSectionedBlogPayload,
  buildSectionWriterMessages,
  hydrateSectionedBlogDraftFromContent,
  normalizeGeneratedSectionHtml,
  prepareGeneratedSectionHtml,
  repairSectionedBlogDraft,
  selectQualityRepairSectionIds,
  type SectionWriterInput,
  type SectionedBlogDraft,
} from "../services/sectioned-blog-writer.service";
import {
  compileCanonicalBlogFacts,
  withCanonicalClaims,
} from "../services/canonical-blog-facts.service";
import { buildAllowedClaimLedger } from "../services/blog-claim-evidence.service";
import { buildGroundedBlogOutline } from "../services/grounded-blog-outline.service";
import { CREATE_BLOG } from "../validators/blog.validation";
import {
  buildBlogGroundingPacket,
  evaluateBlogGrounding,
  partitionGroundingIssues,
  sanitizeModelAuthoredBusinessClaims,
} from "../utils/blog-grounding.utils";

function fixture() {
  const base = compileCanonicalBlogFacts({
    business: {
      businessName: "Example Fitness",
      businessWebsiteUrl: "https://fitness.example.com",
      selectedServices: [
        "Group fitness classes",
        "Personal training",
        "Recovery rooms",
      ],
    },
  });
  const packet = withCanonicalClaims(
    base,
    buildAllowedClaimLedger({
      packet: base,
      evidence: [
        {
          url: "https://fitness.example.com/classes",
          title: "Classes",
          excerpt: "Group fitness classes include instructor-led strength sessions.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
          authority: "owned_website",
        },
        {
          url: "https://fitness.example.com/training",
          title: "Training",
          excerpt: "Personal training begins with a consultation about goals.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
          authority: "owned_website",
        },
      ],
    }),
  );
  const outline = buildGroundedBlogOutline({
    packet,
    title: "Example Fitness Services: Compare Classes and Training",
    seoTitle: "Compare Example Fitness Classes and Training",
    keyword: "Example Fitness services",
    intent: "Informational",
    structureType: "alternatives",
  });
  const writer: SectionWriterInput = {
    invoke: async () => {
      throw new Error("not called by this test");
    },
    packet,
    outline,
    keyword: "Example Fitness services",
    locale: "English (Canadian)",
    targetWordCount: 1_100,
  };
  return { packet, outline, writer };
}

describe("sectioned blog writer", () => {
  it("sends a section only its assigned claims", () => {
    const { writer, packet } = fixture();
    const classClaim = packet.claims.find(
      (claim) => claim.sourceUrl === "https://fitness.example.com/classes",
    )!;
    const trainingClaim = packet.claims.find(
      (claim) => claim.sourceUrl === "https://fitness.example.com/training",
    )!;
    const section = {
      id: "outline-classes",
      heading: "Group fitness classes",
      purpose: "Help the reader decide when a class is the better starting point.",
      allowedClaimIds: [classClaim.id],
      required: true,
    };
    const prompt = buildSectionWriterMessages(writer, section)
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain(classClaim.text);
    // Claim isolation: other sections' CLAIMS stay out of this prompt. The
    // verified snapshot may name every documented service (packet facts are
    // deliberately global), so assert on the unassigned claim text only.
    expect(prompt).not.toContain(trainingClaim.text);
    expect(prompt).toContain("VERIFIED BUSINESS SNAPSHOT");
    expect(prompt).toContain(
      "You may interpret an assigned business claim once in third-person prose",
    );
    expect(prompt).toContain(
      "include an HTML link to that claim's exact source URL",
    );
    expect(prompt).toContain(
      "The application will render any assigned claim you do not cite",
    );
  });

  it("expands a short article instead of treating length as an unsupported claim", () => {
    const directives = buildFailureRepairDirectives([
      {
        sectionId: "document",
        claimExcerpt: "length: 754 words outside 900-1375",
        reason: "Document-level structure or quality invariant failed",
        issueKind: "length",
        allowedFacts: [],
      },
    ]);
    expect(directives[0]).toContain("Expand this section");
    expect(directives[0]).toContain("Do not add");
    expect(directives[0]).toContain("infer business facts");
    expect(directives[0]).not.toContain("omit the claim");
  });

  it("appends length-only repair prose without replacing a passing section", async () => {
    const { packet, outline, writer } = fixture();
    const body = outline.sections.find(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    )!;
    const existing = `<h2 data-outline-id="${body.id}">${body.heading}</h2><p>Original safe decision guidance.</p>`;
    const sectionHtml = new Map([[body.id, existing]]);
    const draft: SectionedBlogDraft = {
      introHtml: "<p>Intro.</p>",
      sectionHtml,
      content: existing,
      messages: [],
      repairAttempts: {},
    };
    let prompt = "";
    const repaired = await repairSectionedBlogDraft({
      writer: {
        ...writer,
        packet,
        invoke: async (messages) => {
          prompt = messages.map((message) => message.content).join("\n");
          return new AIMessage(
            "<h3>A separate decision lens</h3><p>Supplemental safe guidance.</p>",
          );
        },
      },
      draft,
      sectionIds: [body.id],
      failures: [
        {
          sectionId: "document",
          claimExcerpt: "length: 754 words outside 900-1375",
          reason: "Document-level length invariant failed",
          issueKind: "length",
          allowedFacts: [],
        },
      ],
    });

    expect(prompt).toContain("SUPPLEMENTAL DECISION LENS");
    expect(prompt).toContain("Do not rewrite");
    expect(repaired.sectionHtml.get(body.id)).toContain(
      "Original safe decision guidance.",
    );
    expect(repaired.sectionHtml.get(body.id)).toContain(
      "Supplemental safe guidance.",
    );
    expect((repaired.sectionHtml.get(body.id)?.match(/<h2\b/g) ?? [])).toHaveLength(1);
  });

  it("normalizes model output to one locked H2 section", () => {
    const section = {
      id: "outline-classes",
      heading: "Group fitness classes",
      purpose: "Compare options.",
      allowedClaimIds: [],
      required: true,
    };
    const html = normalizeGeneratedSectionHtml(
      "```html\n<h2>Changed heading</h2><p>Useful prose.</p><h2>Extra</h2><p>More.</p>\n```",
      section,
    );
    expect(html).toStartWith(
      '<h2 data-outline-id="outline-classes" id="group-fitness-classes">Group fitness classes</h2>',
    );
    expect((html.match(/<h2\b/g) ?? [])).toHaveLength(1);
    expect(html).toContain("Useful prose");
    expect(html).toContain("More");
  });

  it("renders business evidence in an application-owned block", () => {
    const { packet } = fixture();
    const claim = packet.claims.find(
      (candidate) => candidate.authority === "owned_website",
    )!;
    const section = {
      id: "outline-evidence",
      heading: "Evidence",
      purpose: "Show evidence.",
      allowedClaimIds: [claim.id],
      required: true,
    };
    const block = buildVerifiedSectionEvidenceBlock(packet, section);
    expect(block).toContain('data-uplift-assembled="section-evidence"');
    expect(block).toContain(claim.text);
    expect(block).toContain(claim.sourceUrl!);
  });

  it("does not duplicate an assigned claim after the model cites its exact source", () => {
    const { packet } = fixture();
    const claim = packet.claims.find(
      (candidate) => candidate.authority === "owned_website",
    )!;
    const section = {
      id: "outline-cited-evidence",
      heading: "Cited evidence",
      purpose: "Interpret one verified detail.",
      allowedClaimIds: [claim.id],
      required: true,
    };
    const modelHtml = `<p>Use the documented format as one comparison point. <a href="${claim.sourceUrl}">Source</a></p>`;

    expect(buildVerifiedSectionEvidenceBlock(packet, section, modelHtml)).toBe("");
    const normalized = normalizeGeneratedSectionHtml(modelHtml, section, packet);
    expect(normalized).toContain(claim.sourceUrl!);
    expect(normalized).not.toContain('data-uplift-assembled="section-evidence"');
  });

  it("removes unsupported section claims before document-level validation", () => {
    const { packet, writer } = fixture();
    const claim = packet.claims.find(
      (candidate) => candidate.authority === "owned_website",
    )!;
    const section = {
      id: "outline-evidence",
      heading: "Evidence-backed options",
      purpose: "Help the reader verify options.",
      allowedClaimIds: [claim.id],
      required: true,
    };
    const groundingPacket = buildBlogGroundingPacket({
      business: {
        businessName: packet.identity.businessName,
        businessWebsiteUrl: packet.identity.website,
        selectedServices: packet.services,
      },
      selectedTitle: {
        title: writer.outline.title,
        seoTitle: writer.outline.seoTitle,
      },
    });
    groundingPacket.claims = packet.claims;

    const prepared = prepareGeneratedSectionHtml(
      [
        "<p>Providers typically offer programs that simplify planning and improve results.</p>",
        "<p>Ask which documented option matches the support you need, then verify current details directly.</p>",
      ].join(""),
      { ...writer, groundingPacket },
      section,
    );

    expect(prepared.removedBlocks).toBeGreaterThan(0);
    expect(prepared.html).not.toContain("typically offer");
    expect(prepared.html).not.toContain("improve results");
    expect(prepared.html).toContain("verify current details directly");
    expect(prepared.html).toContain('data-uplift-assembled="section-evidence"');
  });

  it("splits oversized model paragraphs while preserving the section", () => {
    const section = {
      id: "outline-format",
      heading: "Readable format",
      purpose: "Keep prose readable.",
      allowedClaimIds: [],
      required: true,
    };
    const sentence =
      "This sentence gives a conditional decision rule without naming the business or promising an outcome.";
    const html = normalizeGeneratedSectionHtml(
      `<p>${Array.from({ length: 15 }, () => sentence).join(" ")}</p>`,
      section,
    );
    expect((html.match(/<p>/g) ?? []).length).toBeGreaterThan(1);
  });

  it("assembles exactly three complete FAQs from the claim ledger", () => {
    const { packet, outline } = fixture();
    const faq = outline.sections.find((section) =>
      /faq|questions/i.test(section.heading),
    )!;
    const html = buildDeterministicFaqSection(packet, faq);
    expect((html.match(/class="faq-question"/g) ?? [])).toHaveLength(3);
    expect((html.match(/class="faq-answer"/g) ?? [])).toHaveLength(3);
    expect(html).toContain("https://fitness.example.com/classes");
    expect(html).not.toMatch(/guarantee|immediate|best results/i);
  });

  it("keeps a product catalog FAQ grounded through the final sanitizer", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        selectedServices: ["Sofas", "Sectionals", "Dining Tables"],
      },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Sectional Sofa Guide",
      seoTitle: "Sectional Sofa Guide",
      keyword: "sectional sofa",
      intent: "Informational",
      structureType: "complete-guide",
      businessModelType: "product",
      useLocalSection: false,
    });
    const faq = outline.sections.find((section) =>
      /faq|questions/i.test(section.heading),
    )!;
    const grounding = buildBlogGroundingPacket({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        selectedServices: ["Sofas", "Sectionals", "Dining Tables"],
      },
    });
    const html = buildDeterministicFaqSection(packet, faq);
    const sanitized = sanitizeModelAuthoredBusinessClaims(html, grounding);
    const hard = partitionGroundingIssues(
      evaluateBlogGrounding(sanitized.content, grounding).issues,
    ).hard;

    expect(sanitized.removed).toBe(0);
    expect(hard).toEqual([]);
    expect((sanitized.content.match(/class="faq-question"/g) ?? [])).toHaveLength(
      3,
    );
    expect((sanitized.content.match(/class="faq-answer"/g) ?? [])).toHaveLength(
      3,
    );
  });

  it("keeps unrelated ecommerce inventory, local areas, and generic prices out of the product prompt", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        serviceAreaLocations: ["Buffalo", "Rochester", "Albany"],
        selectedServices: [
          "Sofas",
          "Sectionals",
          "Dining Tables",
          "Dining Chairs",
          "Nightstands",
        ],
      },
      scrapedFacts: { priceFrom: "From $508" },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: [
          {
            url: "https://afbdecor.example/collections/sectionals",
            title: "Sectional sofas",
            excerpt:
              "The sectional sofa collection includes modular configurations and documented dimensions.",
            retrievedAt: "2026-07-20T00:00:00.000Z",
            authority: "owned_website",
          },
          {
            url: "https://afbdecor.example/products/dining-table",
            title: "Dining table",
            excerpt:
              "The dining table collection includes a rectangular option from $729 USD.",
            retrievedAt: "2026-07-20T00:00:00.000Z",
            authority: "owned_website",
          },
        ],
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Sectional Sofa Guide",
      seoTitle: "Sectional Sofa Guide",
      keyword: "sectional sofa",
      intent: "Informational",
      structureType: "complete-guide",
      businessModelType: "product",
      useLocalSection: false,
    });
    const section = outline.sections.find(
      (candidate) => !/faq|questions|next steps/i.test(candidate.heading),
    )!;
    const prompt = buildSectionWriterMessages(
      {
        invoke: async () => {
          throw new Error("not called by this test");
        },
        packet,
        outline,
        keyword: "sectional sofa",
        locale: "English",
        targetWordCount: 1_300,
        businessModelType: "product",
        useLocalSection: false,
      },
      section,
    )
      .map((message) => message.content)
      .join("\n");

    expect(prompt).toContain("sectional sofa");
    expect(prompt).not.toMatch(
      /Buffalo|Rochester|Albany|Dining Tables|Dining Chairs|Nightstands|From \$508|\$729/,
    );
  });

  it("wraps model-authored root text so every paragraph reaches grounding checks", () => {
    const section = {
      id: "outline-classes",
      heading: "Group fitness classes",
      purpose: "Compare options.",
      allowedClaimIds: [],
      required: true,
    };
    const html = normalizeGeneratedSectionHtml(
      "First unsupported paragraph.\n\nSecond unsupported paragraph.",
      section,
    );
    expect(html).toContain("<p>First unsupported paragraph.</p>");
    expect(html).toContain("<p>Second unsupported paragraph.</p>");
  });

  it("selects locked sections for a low-quality targeted repair", () => {
    const { outline } = fixture();
    const ids = selectQualityRepairSectionIds(outline, {
      overall: 5,
      dimensions: {
        specificity: 5,
        opinions: 5,
        livedExperience: 4,
        hedgingFreedom: 8,
        competitorUse: 10,
        offeringUse: 6,
      },
      critique: ["unsafe raw critique must not drive instructions"],
    });
    expect(ids).toEqual([
      "intro",
      ...outline.sections
        .filter((section) => !/faq|questions/i.test(section.heading))
        .map((section) => section.id),
    ]);
  });

  it("allocates enough body words to reach the article target", () => {
    const { writer, outline } = fixture();
    const bodySection = outline.sections.find(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    )!;
    const prompt = buildSectionWriterMessages(writer, bodySection)
      .map((message) => message.content)
      .join("\n");
    const budget = prompt.match(/write AT LEAST (\d+) words and at most (\d+)/);
    expect(budget).not.toBeNull();
    expect(Number(budget?.[1])).toBeGreaterThanOrEqual(220);
    expect(Number(budget?.[2])).toBeGreaterThanOrEqual(280);
  });

  it("allocates detailed section budgets for a 4000-word dry run", () => {
    const { packet, writer } = fixture();
    const outline = buildGroundedBlogOutline({
      packet,
      title: writer.outline.title,
      seoTitle: writer.outline.seoTitle,
      keyword: writer.keyword,
      intent: "Informational",
      structureType: "alternatives",
      targetWordCount: 4_000,
    });
    const longWriter = { ...writer, outline, targetWordCount: 4_000 };
    const body = outline.sections.filter(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    );
    expect(body.length).toBeGreaterThanOrEqual(7);
    const plannedMinimum = body.reduce((total, section) => {
      const prompt = buildSectionWriterMessages(longWriter, section)
        .map((message) => message.content)
        .join("\n");
      const budget = prompt.match(/write AT LEAST (\d+) words and at most (\d+)/);
      return total + Number(budget?.[1] ?? 0);
    }, 0);
    expect(plannedMinimum).toBeGreaterThanOrEqual(3_000);
    const longPrompt = buildSectionWriterMessages(longWriter, body[0]!)
      .map((message) => message.content)
      .join("\n");
    expect(longPrompt).toContain("two or three descriptive H3 decision lenses");
    expect(longPrompt).toContain("no paragraph may exceed 110 words");
  });

  it("builds a schema-valid application-owned save payload", () => {
    const { packet, outline } = fixture();
    const sectionHtml = new Map(
      outline.sections.map((section) => [
        section.id,
        `<h2 data-outline-id="${section.id}">${section.heading}</h2><p>Decision guidance.</p>`,
      ]),
    );
    const draft: SectionedBlogDraft = {
      introHtml:
        '<div class="quick-answer"><strong>Quick answer:</strong> Compare the verified options.</div><p>Choose by the kind of support required.</p>',
      sectionHtml,
      content: [
        ...sectionHtml.values(),
      ].join("\n"),
      messages: [],
      repairAttempts: {},
    };
    const payload = buildSectionedBlogPayload({
      draft,
      packet,
      outline,
      keyword: "Example Fitness services",
      locale: "en-CA",
      userId: "user-1",
      businessId: "business-1",
      keywordId: "keyword-1",
      plannedPublishInfo: { date: "2026-07-13", time: "08:00" },
      selectedTitle: {
        title: outline.title,
        seoTitle: outline.seoTitle,
        structureType: "alternatives",
        contentIntent: "Informational",
        keywordUsed: "Example Fitness services",
      },
    });
    expect(CREATE_BLOG.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      title: outline.title,
      status: "DRAFT",
      blogPublishInfo: { date: "2026-07-13", time: "08:00" },
    });
  });

  it("hydrates repairs from the sanitized article rather than the rejected original", () => {
    const { outline } = fixture();
    const faq = outline.sections.find((section) =>
      /faq|questions/i.test(section.heading),
    )!;
    const sectionHtml = new Map(
      outline.sections.map((section) => [
        section.id,
        `<h2 data-outline-id="${section.id}">${section.heading}</h2><p>Original.</p>`,
      ]),
    );
    const original: SectionedBlogDraft = {
      introHtml: "<p>Original intro.</p>",
      sectionHtml,
      content: "",
      messages: [],
      repairAttempts: {},
    };
    const sanitized = [
      "<p>Sanitized intro.</p>",
      ...outline.sections.map((section) =>
        section.id === faq.id
          ? `<h2 data-outline-id="${section.id}">${section.heading}</h2><h3>Question?</h3>`
          : `<h2 data-outline-id="${section.id}">${section.heading}</h2><p>Sanitized.</p>`,
      ),
    ].join("\n");
    const hydrated = hydrateSectionedBlogDraftFromContent(
      original,
      sanitized,
      outline,
    );
    expect(hydrated.introHtml).toContain("Sanitized intro");
    expect(hydrated.sectionHtml.get(faq.id)).not.toContain("Original");
    expect(hydrated.content).toContain("<h3>Question?</h3>");
  });
});
