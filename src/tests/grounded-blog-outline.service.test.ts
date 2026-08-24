import { describe, expect, it } from "bun:test";

import {
  buildGroundedBlogOutline,
  findFaqStructureIssue,
  findMissingOutlineSections,
} from "../services/grounded-blog-outline.service";
import {
  compileCanonicalBlogFacts,
  withCanonicalClaims,
} from "../services/canonical-blog-facts.service";
import { buildAllowedClaimLedger } from "../services/blog-claim-evidence.service";

describe("grounded blog outline", () => {
  it("locks sections to known claim ids and flags missing required headings", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        selectedServices: ["Mobile Patrols"],
      },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Mobile Patrol Planning: A Practical Guide",
      seoTitle: "Mobile Patrol Planning Guide",
      intent: "Informational",
      requiredSections: ["How mobile patrol planning works"],
      requiredModules: ["decision-checklist"],
    });

    expect(outline.sections[0]?.allowedClaimIds.length).toBeGreaterThan(0);
    const missing = findMissingOutlineSections(
      "<h2>Next steps</h2><p>Contact us.</p>",
      outline,
    );
    expect(missing.map((section) => section.id)).toContain(
      outline.sections[0]!.id,
    );
    const completeRequiredHtml = outline.sections
      .filter((section) => section.required)
      .map((section) => `<h2>${section.heading}</h2><p>Details.</p>`)
      .join("");
    expect(
      findMissingOutlineSections(completeRequiredHtml, outline),
    ).toHaveLength(0);
  });

  it("builds a title-structure outline instead of leaking archetype placeholders", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Shawarma West",
        selectedServices: [
          "Corporate catering",
          "Individually packaged catering",
        ],
      },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Corporate Catering Mississauga: 5 Menu Picks for Offices",
      seoTitle: "Corporate Catering Mississauga | Office Menu Picks",
      keyword: "corporate catering Mississauga",
      intent: "Service",
      structureType: "list-based",
      requiredSections: [
        "Above-Fold Section (Hook + TOC)",
        "What Is [Topic]?",
        "Why [Topic] Matters",
      ],
    });

    expect(outline.sections.map((section) => section.heading)).toEqual([
      "corporate catering Mississauga: options at a glance",
      "Options to consider for corporate catering Mississauga",
      "How to choose for corporate catering Mississauga",
      "Frequently asked questions",
      "Next steps",
    ]);
    expect(JSON.stringify(outline)).not.toContain("[Topic]");
    expect(JSON.stringify(outline)).not.toContain("Above-Fold");
  });

  it("accepts a locked section by data-outline-id even when display wording changes", () => {
    const packet = compileCanonicalBlogFacts({
      business: { businessName: "Example", selectedServices: ["Consulting"] },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "A Guide",
      seoTitle: "A Guide",
      intent: "Informational",
      requiredSections: ["How consulting works"],
    });
    const section = outline.sections[0]!;
    const renderedRequiredSections = outline.sections
      .filter((candidate) => candidate.required)
      .map((candidate) =>
        candidate.id === section.id
          ? `<h2 data-outline-id="${candidate.id}">A clearer display heading</h2>`
          : `<h2 data-outline-id="${candidate.id}">${candidate.heading}</h2>`,
      )
      .join("");
    expect(
      findMissingOutlineSections(renderedRequiredSections, outline),
    ).toHaveLength(0);
  });

  it("does not turn a broad service inventory into detailed sections without page evidence", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        selectedServices: [
          "Gym memberships",
          "Group fitness classes",
          "Personal training",
          "On-demand workouts",
          "Recovery rooms",
          "Corporate wellness memberships",
        ],
      },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Example Fitness Services: Compare Classes and Training",
      seoTitle: "Example Fitness Services",
      keyword: "Example Fitness services",
      intent: "Informational",
      structureType: "alternatives",
      requiredModules: ["quick-answer", "at-a-glance"],
    });

    expect(outline.sections.map((section) => section.heading)).toEqual([
      "Example Fitness services: options at a glance",
      "How the options differ",
      "How to choose for Example Fitness services",
      "Frequently asked questions",
      "Next steps",
    ]);
    expect(JSON.stringify(outline)).not.toContain("Recovery rooms");
    expect(JSON.stringify(outline)).not.toContain(
      "Corporate wellness memberships",
    );
    expect(JSON.stringify(outline)).not.toContain('"heading":"quick answer"');
    expect(outline.sections[0]?.purpose).not.toBe(outline.sections[1]?.purpose);
    expect(JSON.stringify(outline)).not.toContain(
      "one evidence-backed tradeoff, and what the reader should verify",
    );
  });

  it("does not expand a canonical service into a body section without first-party evidence", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        businessWebsiteUrl: "https://fitness.example.com",
        selectedServices: [
          "Gym memberships",
          "Personal training",
          "On-demand workouts",
          "Recovery rooms",
          "Corporate wellness memberships",
        ],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: [
          {
            url: "https://fitness.example.com/membership",
            title: "Membership",
            excerpt: "Gym memberships include club access and class booking.",
            retrievedAt: "2026-07-13T00:00:00.000Z",
            authority: "owned_website",
          },
          {
            url: "https://fitness.example.com/training",
            title: "Training",
            excerpt:
              "Personal training begins with a consultation about goals.",
            retrievedAt: "2026-07-13T00:00:00.000Z",
            authority: "owned_website",
          },
          {
            url: "https://fitness.example.com/app",
            title: "App",
            excerpt: "On-demand workouts are available through the mobile app.",
            retrievedAt: "2026-07-13T00:00:00.000Z",
            authority: "owned_website",
          },
        ],
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Compare Gym, Training, and App Options",
      seoTitle: "Compare Fitness Options",
      keyword: "fitness services",
      intent: "Informational",
      structureType: "alternatives",
    });
    const serialized = JSON.stringify(outline);
    expect(serialized).toContain("Gym memberships");
    expect(serialized).toContain("Personal training");
    expect(serialized).toContain("On-demand workouts");
    expect(serialized).not.toContain("Recovery rooms");
    expect(serialized).not.toContain("Corporate wellness memberships");
  });

  it("gives next steps only owned actionable claims and validates all FAQ answers", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        businessWebsiteUrl: "https://fitness.example.com",
        selectedServices: ["Group fitness classes"],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: [
          {
            url: "https://fitness.example.com/app",
            title: "App",
            excerpt:
              "Members can use the mobile app to book group fitness classes.",
            retrievedAt: "2026-07-13T00:00:00.000Z",
            authority: "owned_website",
          },
        ],
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Compare Fitness Services",
      seoTitle: "Compare Fitness Services",
      keyword: "fitness services",
      intent: "Informational",
      structureType: "alternatives",
    });
    const next = outline.sections.find((section) =>
      /next steps/i.test(section.heading),
    )!;
    const faq = outline.sections.find((section) =>
      /faq|questions/i.test(section.heading),
    )!;
    expect(next.allowedClaimIds).toHaveLength(1);
    const incomplete = `<h2 data-outline-id="${faq.id}">${faq.heading}</h2><h3>One?</h3><p class="faq-answer">Yes.</p><h3>Two?</h3>`;
    expect(findFaqStructureIssue(incomplete, outline)).toEqual({
      sectionId: faq.id,
      questionCount: 2,
      answerCount: 1,
    });
    const complete = `<h2 data-outline-id="${faq.id}">${faq.heading}</h2><h3>One?</h3><p class="faq-answer">A.</p><h3>Two?</h3><p class="faq-answer">B.</p><h3>Three?</h3><p class="faq-answer">C.</p>`;
    expect(findFaqStructureIssue(complete, outline)).toBeNull();
  });

  it("expands a 4000-word test outline into enough focused body sections", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Example",
        selectedServices: ["Consulting"],
      },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Example Consulting Guide",
      seoTitle: "Example Consulting Guide",
      keyword: "consulting services",
      intent: "Informational",
      structureType: "alternatives",
      targetWordCount: 4_000,
    });
    const body = outline.sections.filter(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    );
    // Long-form targets need real section depth: 4,000 words across 7 sections
    // forced 570-word sections the writer cannot legally fill; 9-10 focused
    // sections keep each at a fillable ~400 words.
    expect(body.length).toBeGreaterThanOrEqual(9);
    expect(outline.sections.at(-2)?.heading).toBe("Frequently asked questions");
    expect(outline.sections.at(-1)?.heading).toBe("Next steps");
  });

  it("keeps an 1800-word evidence-backed outline achievable when services collapse into one group", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Shawarma Moose",
        businessWebsiteUrl: "https://shawarma.example.com",
        selectedServices: [
          "Shawarma",
          "Catering services",
          "Corporate event catering",
        ],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: [
          {
            url: "https://shawarma.example.com/catering",
            title: "Catering",
            excerpt:
              "Shawarma, catering services, and corporate event catering are available for event organizers.",
            retrievedAt: "2026-07-13T00:00:00.000Z",
            authority: "owned_website",
          },
        ],
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Corporate Catering: Buffet vs Boxed Lunch Choices",
      seoTitle: "Corporate Catering Choices",
      keyword: "corporate catering Toronto",
      intent: "Commercial",
      structureType: "list-based",
      targetWordCount: 1_800,
    });
    const body = outline.sections.filter(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    );

    expect(body).toHaveLength(4);
    expect(new Set(body.map((section) => section.heading)).size).toBe(4);
  });

  it("allocates owned evidence across body sections without repeating claim ids", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Shawarma Moose",
        businessWebsiteUrl: "https://shawarma.example.com",
        selectedServices: ["Corporate catering"],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: Array.from({ length: 7 }, (_value, index) => ({
          url: `https://shawarma.example.com/catering-${index + 1}`,
          title: `Catering option ${index + 1}`,
          excerpt: `Documented catering option ${index + 1} is listed for event organizers.`,
          retrievedAt: "2026-07-13T00:00:00.000Z",
          authority: "owned_website" as const,
        })),
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Corporate Catering Toronto: A Planning Guide",
      seoTitle: "Corporate Catering Toronto",
      keyword: "corporate catering Toronto",
      intent: "Commercial",
      structureType: "question",
      targetWordCount: 1_800,
    });
    const body = outline.sections.filter(
      (section) => !/faq|questions|next steps/i.test(section.heading),
    );
    const allocated = body.flatMap((section) => section.allowedClaimIds);

    expect(allocated.length).toBeGreaterThanOrEqual(body.length);
    expect(new Set(allocated).size).toBe(allocated.length);
    expect(body.every((section) => section.allowedClaimIds.length <= 3)).toBe(
      true,
    );
  });

  it("uses evidence-led headings instead of a generic best-practices shell", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Shawarma Moose",
        businessWebsiteUrl: "https://shawarma.example.com",
        businessCity: "Toronto",
        selectedServices: ["Corporate catering"],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: Array.from({ length: 6 }, (_value, index) => ({
          url: `https://shawarma.example.com/catering-${index + 1}`,
          title: `Catering evidence ${index + 1}`,
          excerpt: `Shawarma Moose documents corporate catering option ${index + 1} in Toronto.`,
          retrievedAt: "2026-07-14T00:00:00.000Z",
          authority: "owned_website" as const,
        })),
      }),
    );
    packet.operatingFacts.push("From $10 per person for 10 to 500 guests.");
    packet.location.verified = true;
    packet.location.city = "Toronto";
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Corporate Catering Toronto",
      seoTitle: "Corporate Catering Toronto",
      keyword: "corporate catering Toronto",
      intent: "Commercial",
      structureType: "best-practices",
      targetWordCount: 1_700,
    });
    const headings = outline.sections.map((section) => section.heading);

    expect(headings[0]).toContain("Shawarma Moose's documented options");
    expect(headings).not.toContain(
      "Best practices for corporate catering Toronto",
    );
    expect(headings).not.toContain(
      "How to compare the documented options for corporate catering Toronto",
    );
    expect(
      outline.sections
        .filter((section) => !/faq|questions|next steps/i.test(section.heading))
        .every((section) => section.allowedClaimIds.length > 0),
    ).toBe(true);
  });

  it("uses product and broad-reach headings for e-commerce evidence", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        serviceAreaLocations: ["Buffalo", "Rochester", "Albany"],
        selectedServices: ["Sofas", "Sectionals", "Dining Tables"],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: Array.from({ length: 5 }, (_value, index) => ({
          url: `https://afbdecor.example/products/sectional-${index + 1}`,
          title: `Sectional ${index + 1}`,
          excerpt: `Documented sectional option ${index + 1} includes dimensions, price, and delivery details.`,
          retrievedAt: "2026-07-20T00:00:00.000Z",
          authority: "owned_website" as const,
        })),
      }),
    );
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Sectional Sofa Guide",
      seoTitle: "Sectional Sofa Guide",
      keyword: "sectional sofa",
      intent: "Informational",
      structureType: "complete-guide",
      targetWordCount: 1_300,
      businessModelType: "product",
      useLocalSection: false,
    });
    const headings = outline.sections.map((section) => section.heading);

    expect(headings).toContain("Documented products and choices from AFBDECOR");
    expect(headings).toContain(
      "Pricing, dimensions, delivery, and purchase details",
    );
    expect(headings.some((heading) => /local coverage|booking details/i.test(heading))).toBe(
      false,
    );
  });

  it("does not use an unrelated owned claim as an arbitrary allocation fallback", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        serviceAreaLocations: ["Buffalo", "Rochester", "Albany"],
        selectedServices: ["Dining Tables"],
      },
    });
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({
        packet: base,
        evidence: [
          {
            url: "https://afbdecor.example/products/dining-table",
            title: "Dining table",
            excerpt:
              "The dining table collection includes a rectangular six-seat option from $729 USD.",
            retrievedAt: "2026-07-20T00:00:00.000Z",
            authority: "owned_website",
          },
        ],
      }),
    );
    const diningClaimIds = new Set(
      packet.claims
        .filter((claim) => /dining table|\$729/i.test(claim.text))
        .map((claim) => claim.id),
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
    const allocated = outline.sections.flatMap(
      (section) => section.allowedClaimIds,
    );

    expect(allocated.some((claimId) => diningClaimIds.has(claimId))).toBe(false);
    expect(JSON.stringify(outline)).not.toMatch(
      /Buffalo|Rochester|Albany|Dining Table|\$729/,
    );
  });

  it("materializes the locked complete-guide structure", () => {
    const packet = compileCanonicalBlogFacts({
      business: { businessName: "Example", selectedServices: ["Consulting"] },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Consulting Services: A Practical Guide",
      seoTitle: "Consulting Services Guide",
      keyword: "consulting services",
      intent: "Informational",
      structureType: "complete-guide",
    });

    expect(outline.sections.map((section) => section.heading)).toEqual([
      "consulting services: key concepts",
      "Options and approaches for consulting services",
      "How to evaluate consulting services",
      "Frequently asked questions",
      "Next steps",
    ]);
  });

  it("materializes the locked service-page structure", () => {
    const packet = compileCanonicalBlogFacts({
      business: { businessName: "Example", selectedServices: ["Consulting"] },
    });
    const outline = buildGroundedBlogOutline({
      packet,
      title: "Consulting Services: Services and Process",
      seoTitle: "Consulting Services and Process",
      keyword: "consulting services",
      intent: "Service",
      structureType: "service-page",
    });

    expect(outline.sections.map((section) => section.heading)).toEqual([
      "consulting services: service scope at a glance",
      "Options available for consulting services",
      "How the consulting services process works",
      "What to confirm before booking consulting services",
      "Frequently asked questions",
      "Next steps",
    ]);
  });
});
