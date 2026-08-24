import { describe, expect, it } from "bun:test";
// Pin the closed-world contract for deterministic gate tests; production
// default enables general industry knowledge (product decision 2026-07-14).
process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED = "false";
import {
  buildBlogGroundingPacket,
  buildBlogGroundingPromptBlock,
  enforceLockedBlogFields,
  evaluateBlogGrounding,
  isHardGroundingIssue,
  partitionGroundingIssues,
  sanitizeHardGroundingBlocks,
  sanitizeModelAuthoredBusinessClaims,
  sanitizeUnverifiedContacts,
  stripModelGeneratedSchema,
} from "../utils/blog-grounding.utils";

function makePacket() {
  return buildBlogGroundingPacket({
    business: {
      businessName: "Northstar Dental Studio",
      businessType: "Dental clinic",
      businessDescription: "Family and emergency dental assessments.",
      businessWebsiteUrl: "https://northstar.example.com",
      businessPhone: "+1 416 555 9000",
      secondaryDetailsConfirmed: true,
      selectedServices: ["Emergency dental assessment", "Family dentistry"],
      serviceAreaLocations: ["Toronto", "North York"],
      targetAudience: "Toronto adults and families",
      authorName: "Dr. Avery North",
      authorJobTitle: "Licensed Dentist",
      authorExpertise: ["Emergency dentistry"],
      GMBBusinessHours: [
        {
          dayOfWeek: 1,
          openTime: "09:00",
          closeTime: "17:00",
          isClosed: false,
          is24Hours: false,
        },
      ],
      GoogleMyBusiness: {
        isActive: true,
        verified: true,
        cachedAverageRating: 4.8,
        totalReviewCount: 42,
        gmbReviews: [
          {
            reviewerName: "Jordan Lee",
            rating: 5,
            comment:
              "The team explained every step clearly and made the visit comfortable.",
          },
        ],
      },
    },
    businessLocation: {
      verified: true,
      businessCity: "Toronto",
      businessState: "Ontario",
      businessCountry: "Canada",
      formattedAddress: "123 King Street West, Toronto, Ontario",
      postalCode: "M5H 1A1",
      coordinates: { lat: 43.6487, lng: -79.3817 },
    },
    scrapedFacts: {
      leadTime: "24 hours notice",
      foundingYear: 2018,
    },
    selectedTitle: {
      title: "Emergency Dentist Toronto: What to Do Next",
      seoTitle: "Emergency Dentist Toronto | What to Do Next",
    },
  });
}

describe("blog grounding packet", () => {
  it("distills verified identity, services, geo, hours, and operating facts", () => {
    const packet = makePacket();
    expect(packet.businessName).toBe("Northstar Dental Studio");
    expect(packet.services).toContain("Emergency dental assessment");
    expect(packet.location.address).toContain("123 King Street West");
    expect(packet.serviceAreas).toEqual(["Toronto", "North York"]);
    expect(packet.businessHours).toContain("Monday: 09:00-17:00");
    expect(packet.operatingFacts).toContain("24 hours notice");
    expect(packet.regulatedTopic).toBe("health");
    expect(packet.credentials).toContain("Licensed Dentist");
    expect(packet.reviews[0]?.reviewer).toBe("Jordan Lee");
    expect(packet.reputationFacts).toContain("Average rating: 4.8");
  });

  it("does not authorize an unverified address or coordinates", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Example Co",
        businessAddress: "999 Guess Road",
      },
      businessLocation: {
        verified: false,
        businessAddress: "999 Guess Road",
        coordinates: { lat: 1.2345, lng: 2.3456 },
      },
    });
    expect(packet.location.address).toBeNull();
    expect(packet.location.coordinates).toBeNull();
  });

  it("renders a closed-world prompt contract with explicit omission rules", () => {
    const block = buildBlogGroundingPromptBlock(makePacket());
    expect(block).toContain("CLOSED WORLD CONTRACT");
    expect(block).toContain("null or an empty array means unknown");
    expect(block).toContain("Do not emit JSON-LD");
  });
});

describe("blog grounding enforcement", () => {
  it("removes every model-generated JSON-LD block", () => {
    const result = stripModelGeneratedSchema(`
      <p>Visible article.</p>
      <script type="application/ld+json">{"@type":"LocalBusiness"}</script>
      <script type='application/ld+json'>{"@type":"FAQPage"}</script>
    `);
    expect(result.removed).toBe(2);
    expect(result.content).toContain("Visible article");
    expect(result.content).not.toContain("LocalBusiness");
  });

  it("flags the hallucination patterns found in the Qwen pipeline article", () => {
    const evaluation = evaluateBlogGrounding(
      `
      <p>Northstar Dental Studio holds two emergency slots each morning.</p>
      <p>Call our clinic at 8am because slots usually fill by 10am.</p>
      <p>Our clinic provides same-day treatment with a money-back guarantee.</p>
      <p>Call +1-416-555-0123 or visit 898 College Street.</p>
      <p>Treatment starts at $99.</p>
      <p>You can usually wait until morning and take ibuprofen.</p>
      <p>Coordinates: 43.6532, -79.3832.</p>
      `,
      makePacket(),
    );
    const kinds = evaluation.issues.map((issue) => issue.kind);
    expect(kinds).toContain("capacity");
    expect(kinds).toContain("hours");
    expect(kinds).toContain("availability");
    expect(kinds).toContain("guarantee");
    expect(kinds).toContain("phone");
    expect(kinds).toContain("address");
    expect(kinds).toContain("price");
    expect(kinds).toContain("regulated_advice");
    expect(kinds).toContain("coordinates");
  });

  it("classifies every fabricated business claim as HARD and blocking", () => {
    const evaluation = evaluateBlogGrounding(
      `
      <p>Northstar Dental Studio holds two emergency slots each morning.</p>
      <p>Call +1-416-555-0123 or visit 898 College Street.</p>
      <p>Treatment starts at $99. Coordinates: 43.6532, -79.3832.</p>
      <p>Our clinic offers same-day care with a money-back guarantee.</p>
      `,
      makePacket(),
    );
    const { hard, soft } = partitionGroundingIssues(evaluation.issues);
    const hardKinds = hard.map((issue) => issue.kind);
    const softKinds = soft.map((issue) => issue.kind);
    // Fabricated, verifiable facts must fail the gate closed.
    for (const kind of [
      "phone",
      "address",
      "price",
      "coordinates",
      "capacity",
      "availability",
      "guarantee",
    ] as const) {
      expect(hardKinds).toContain(kind);
    }
    expect(hard.every(isHardGroundingIssue)).toBe(true);
    expect(softKinds).toHaveLength(0);
  });

  it("allows availability language when the same promise is verified", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription: "Licensed protection with 24/7 dispatch.",
        secondaryDetailsConfirmed: true,
        selectedServices: ["Mobile Patrols"],
        enhancedBusinessInfo: {
          valuePropositions: ["24/7 availability with dispatch"],
        },
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Ridge Security provides 24/7 dispatch for mobile patrol support.</p>",
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "availability",
    );
  });

  it("does not treat verified 24/7 dispatch as proof of a within-24-hours promise", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription: "Licensed protection with 24/7 dispatch.",
        secondaryDetailsConfirmed: true,
        selectedServices: ["Mobile Patrols"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Ridge Security delivers every proposal within 24 hours.</p>",
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "availability",
    );
  });

  it("blocks a generic response-time promise without a business-name cue", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription: "Licensed protection with 24/7 dispatch.",
        secondaryDetailsConfirmed: true,
        selectedServices: ["Mobile Patrols"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Quotes are typically delivered within 24 hours.</p>",
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "availability",
    );
  });

  it("removes hard-grounding body blocks while preserving safe prose and headings", () => {
    const packet = makePacket();
    const raw = [
      '<h2 data-outline-id="outline-1">What to compare</h2>',
      "<p>On-demand access is available immediately.</p>",
      "<p>Compare each option against your schedule and preferred format.</p>",
    ].join("");
    const firstPass = evaluateBlogGrounding(raw, packet);
    const hard = partitionGroundingIssues(firstPass.issues).hard;
    const result = sanitizeHardGroundingBlocks(raw, hard);

    expect(result.removed).toBe(1);
    expect(result.content).toContain("What to compare");
    expect(result.content).toContain("preferred format");
    expect(result.content).not.toContain("available immediately");
    expect(
      evaluateBlogGrounding(result.content, packet).issues.map(
        (issue) => issue.kind,
      ),
    ).not.toContain("availability");
  });

  it("blocks unsourced legal and compliance consequences", () => {
    const evaluation = evaluateBlogGrounding(
      "<p>Fire watch prevents liability and ensures regulatory compliance.</p>",
      buildBlogGroundingPacket({
        business: {
          businessName: "Ridge Security",
          selectedServices: ["Fire Watch"],
        },
      }),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "regulatory_claim",
    );
  });

  it("does not confuse ordinary uses of fine with a regulatory fine", () => {
    const packet = buildBlogGroundingPacket({
      business: { businessName: "A1 Buller Auto Collision" },
    });
    const ordinary = evaluateBlogGrounding(
      "<p>A repair that looks fine indoors can stand out in direct sunlight.</p>",
      packet,
    );
    expect(ordinary.issues.map((issue) => issue.kind)).not.toContain(
      "regulatory_claim",
    );

    const regulatory = evaluateBlogGrounding(
      "<p>A violation may incur a fine.</p>",
      packet,
    );
    expect(regulatory.issues.map((issue) => issue.kind)).toContain(
      "regulatory_claim",
    );
  });

  it("allows a regulatory statement with a visible source", () => {
    const packet = makePacket();
    packet.claims.push({
      id: "claim_fire_code",
      type: "regulatory",
      text: "The fire code requires this documented step.",
      classification: "educational",
      factIds: [],
      sourceUrl: "https://example.gov/fire-code",
      authority: "authoritative_external",
      evidenceExcerpt: "The fire code requires this documented step.",
    });
    const evaluation = evaluateBlogGrounding(
      '<p><a href="https://example.gov/fire-code">The fire code</a> requires this documented step.</p>',
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "regulatory_claim",
    );
  });

  it("blocks a linked regulatory claim when the URL is absent from the claim ledger", () => {
    const evaluation = evaluateBlogGrounding(
      '<p><a href="https://example.gov/fire-code">The fire code</a> requires this undocumented step.</p>',
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "regulatory_claim",
    );
  });

  it("blocks invented statistics and competitor capabilities", () => {
    const evaluation = evaluateBlogGrounding(
      [
        "<p>A recent study found that 83% of customers prefer patrol services.</p>",
        "<p>National providers offer faster response and use larger teams.</p>",
      ].join(""),
      makePacket(),
    );
    const kinds = evaluation.issues.map((issue) => issue.kind);
    expect(kinds).toContain("statistical_claim");
    expect(kinds).toContain("competitor_claim");
  });

  it("blocks the unsourced allergen and food-safety advice produced in the catering run", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      [
        "<p>If attendees have celiac disease, ask for dedicated prep surfaces and separate cooking equipment to prevent cross-contact.</p>",
        "<p>Shared fryers introduce trace exposure risk, so request an allergen matrix and third-party audits.</p>",
      ].join(""),
      packet,
    );
    const issues = evaluation.issues.filter(
      (issue) => issue.kind === "regulated_advice",
    );
    expect(issues).toHaveLength(2);
    expect(issues.every(isHardGroundingIssue)).toBe(true);
  });

  it("allows precise food-safety guidance only with matching authoritative evidence", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    packet.claims.push({
      id: "claim_food_safety",
      type: "educational",
      text: "People with celiac disease should ask about cross-contact controls.",
      classification: "educational",
      factIds: [],
      sourceUrl: "https://inspection.canada.ca/celiac-cross-contact",
      authority: "authoritative_external",
      evidenceExcerpt:
        "People with celiac disease should ask about cross-contact controls.",
    });
    const evaluation = evaluateBlogGrounding(
      '<p><a href="https://inspection.canada.ca/celiac-cross-contact">People with celiac disease should ask about cross-contact controls.</a></p>',
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "regulated_advice",
    );
  });

  it("blocks unsupported operational folklore and performance outcomes", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      [
        "<p>A 48-hour window with a ten-portion minimum is common.</p>",
        "<p>Providers that serve surrounding cities often tier pricing by distance.</p>",
        "<p>Pre-portioned boxes are faster to distribute and reduce coordination work.</p>",
        "<p>For events above 150 guests, use separate stations.</p>",
      ].join(""),
      packet,
    );
    const kinds = evaluation.issues.map((issue) => issue.kind);
    expect(kinds).toContain("statistical_claim");
    expect(kinds).toContain("competitor_claim");
    expect(kinds).toContain("performance_claim");
  });

  it("blocks uncited explanatory industry prose while allowing decision instructions", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      [
        "<p>Hot holding infrastructure dictates which menu formats remain viable.</p>",
        "<p>Flexible arrangements may result in higher baseline costs.</p>",
        "<p>Confirm whether the venue documents any setup constraints. Ask which details are included in the written quote.</p>",
        "<li>Does the proposed format match the recorded headcount?</li>",
        "<p>If attendance may change, verify the final adjustment deadline in writing.</p>",
      ].join(""),
      packet,
    );
    const unsupported = evaluation.issues.filter(
      (issue) => issue.kind === "unsupported_general_claim",
    );

    expect(unsupported).toHaveLength(3);
    expect(unsupported.every(isHardGroundingIssue)).toBe(true);
  });

  it("does not let commands introduce unsupported operational decision dimensions", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      [
        "<p>Ask vendors to document cross-contamination procedures.</p>",
        "<p>Verify whether loading dock limits trigger labour surcharges.</p>",
        "<p>Review the policy for leftover handling and waste removal.</p>",
        "<p>If the venue lacks heating equipment, prioritize a staffed buffet.</p>",
        "<p>Compare hot holding equipment against drop-off service.</p>",
        "<p>Verify whether chafing dishes and serving utensils are included.</p>",
        "<p>Confirm all potential surcharges before choosing drop-off or staffed service.</p>",
        "<p>Ask whether external vendor access requires insurance documentation.</p>",
        "<p>A most-booked menu may indicate broad attendee acceptance.</p>",
        "<p>Verify whether gratuity or service fees are added to minimum-order thresholds.</p>",
        "<p>Check whether traffic patterns require a setup buffer or labour fees.</p>",
        "<p>Confirm the written price and cancellation terms.</p>",
      ].join(""),
      packet,
    );
    const unsupported = evaluation.issues.filter(
      (issue) => issue.kind === "unsupported_general_claim",
    );

    expect(unsupported).toHaveLength(11);
    expect(unsupported.map((issue) => issue.excerpt).join(" ")).not.toContain(
      "written price",
    );
  });

  it("allows an operational dimension when an assigned claim explicitly supports it", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    packet.claims.push({
      id: "claim_serviceware",
      type: "business_service",
      text: "Compostable serviceware is included in the documented package.",
      classification: "business",
      factIds: [],
      sourceUrl: "https://shawarmamoose.example/corporate",
      authority: "owned_website",
      evidenceExcerpt:
        "Compostable serviceware is included in the documented package.",
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Confirm whether serviceware is included in the written quote.</p>",
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "unsupported_general_claim",
    );
  });

  it("allows availability language present in a ledger claim", () => {
    // Regression: a verbatim-quoted, source-cited ledger claim with "24/7"
    // was flagged as an unverified availability claim and sanitized away —
    // the deterministic FAQ re-added it every round and never converged.
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "The Hamilton Plumber",
        selectedServices: ["Emergency plumbing services"],
      },
    });
    packet.claims.push({
      id: "claim_emergency",
      type: "business_operation",
      text: "Emergency plumbing services are available 24/7 across Hamilton.",
      classification: "business",
      factIds: [],
      sourceUrl:
        "https://thehamiltonplumber.ca/emergency-plumbing-services-in-hamilton-ontario",
      authority: "owned_website",
      evidenceExcerpt:
        "Emergency plumbing services are available 24/7 across Hamilton.",
    });
    const evaluation = evaluateBlogGrounding(
      '<p class="faq-answer">Emergency plumbing services are available 24/7 across Hamilton. <a href="https://thehamiltonplumber.ca/emergency-plumbing-services-in-hamilton-ontario" rel="nofollow noopener">View the source.</a></p>',
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "availability",
    );
  });

  it("still flags availability language absent from every ledger claim", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "The Hamilton Plumber",
        selectedServices: ["Drain cleaning"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>The team offers same-day service for every Hamilton call.</p>",
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "availability",
    );
  });

  it("accepts negative-imperative verification guidance", () => {
    // Regression: this exact deterministic FAQ answer was flagged as an
    // unsupported claim, sanitized away, deterministically re-added by the FAQ
    // repair, and deleted again — the loop never converged.
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      [
        '<p class="faq-answer">Do not assume pricing, availability, timing, or outcomes when those details are not documented in the verified sources.</p>',
        "<p>Never sign a contract before the written quote lists every inclusion.</p>",
        "<p>Don’t rely on a phone estimate for the final headcount plan.</p>",
      ].join(""),
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "unsupported_general_claim",
    );
  });

  it("still flags a negative opener that smuggles an outcome claim", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Do not worry because the caterer always delivers on time and guarantees freshness.</p>",
      packet,
    );

    expect(evaluation.issues.length).toBeGreaterThan(0);
  });

  it("keeps safe sentences when one sentence in the paragraph is unsupported", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Shawarma Moose",
        selectedServices: ["Corporate event catering"],
      },
    });
    const raw = [
      "<p>Compare the written inclusions against the event brief. Hot holding dictates which formats remain viable. Your final choice should reflect the recorded headcount and budget.</p>",
      "<ul><li>Confirm whether current pricing is documented.</li></ul>",
    ].join("");
    const first = evaluateBlogGrounding(raw, packet);
    const result = sanitizeHardGroundingBlocks(
      raw,
      partitionGroundingIssues(first.issues).hard,
    );

    expect(result.content).toContain("Compare the written inclusions");
    expect(result.content).toContain("Your final choice should reflect");
    expect(result.content).toContain("Confirm whether current pricing");
    expect(result.content).not.toContain("Hot holding dictates");
    expect(
      evaluateBlogGrounding(result.content, packet).issues.map(
        (issue) => issue.kind,
      ),
    ).not.toContain("unsupported_general_claim");
  });

  it("does not let a verified service excuse an invented customer story", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        selectedServices: ["Mobile Patrols"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>We have helped hundreds of customers with mobile patrols.</p>",
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "experience",
    );
  });

  it("auto-sanitizes an invented phone by replacing it with the verified number, then the gate passes", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription:
          "A BC security company providing licensed protection.",
        businessPhone: "+1 778-594-3949",
        secondaryDetailsConfirmed: true,
      },
    });
    const raw = `<p>Call us today at 604-555-0199 for a free quote.</p>`;
    const cleaned = sanitizeUnverifiedContacts(raw, packet);
    expect(cleaned.phones).toBe(1);
    expect(cleaned.content).toContain("778-594-3949"); // real number swapped in
    expect(cleaned.content).not.toContain("604-555-0199"); // fake removed
    // And the gate no longer sees an invented phone.
    const evaluation = evaluateBlogGrounding(cleaned.content, packet);
    expect(evaluation.issues.map((i) => i.kind)).not.toContain("phone");
  });

  it("strips an invented phone when the business has no verified number", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "No Phone Co",
        businessDescription: "A service.",
      },
    });
    const cleaned = sanitizeUnverifiedContacts(
      `<p>Reach us at 416-555-1234 anytime.</p>`,
      packet,
    );
    expect(cleaned.phones).toBe(1);
    expect(cleaned.content).not.toMatch(/\d{3}-\d{4}/);
  });

  it("leaves the verified phone untouched (even with country-code/format drift)", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge",
        businessPhone: "+1 778-594-3949",
        secondaryDetailsConfirmed: true,
      },
    });
    const cleaned = sanitizeUnverifiedContacts(
      `<p>Call 778-594-3949 now.</p>`,
      packet,
    );
    expect(cleaned.phones).toBe(0);
    expect(cleaned.content).toContain("778-594-3949");
  });

  it("does NOT flag a true credential claim present in the verified corpus", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription:
          "A BC security company providing licensed, insured protection.",
        secondaryDetailsConfirmed: true,
        selectedServices: ["static guards", "mobile patrol"],
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Our guards are licensed and insured across British Columbia.</p>",
      packet,
    );
    expect(evaluation.issues.map((i) => i.kind)).not.toContain("credential");
  });

  it("still flags a credential term that is NOT in the verified corpus", () => {
    const packet = buildBlogGroundingPacket({
      business: {
        businessName: "Ridge Security",
        businessDescription: "A BC security company providing protection.",
      },
    });
    const evaluation = evaluateBlogGrounding(
      "<p>Our board-certified specialists are award-winning across the province.</p>",
      packet,
    );
    expect(evaluation.issues.map((i) => i.kind)).toContain("credential");
  });

  it("keeps natural intensifier voice (does not flag it as a guarantee)", () => {
    const evaluation = evaluateBlogGrounding(
      `<p>Our shawarma is always fresh and we never use frozen meat.</p>`,
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "guarantee",
    );
  });

  it("keeps verification guidance that explicitly rejects guarantees", () => {
    const evaluation = evaluateBlogGrounding(
      `<p>Ask restaurant contractors to put permit assumptions in writing so proposals can be compared on the same basis. Treat those proposals as verification documents rather than as guarantees of a fixed schedule or price.</p>`,
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "guarantee",
    );
  });

  it("allows a short neutral third-person statement of an exact canonical service", () => {
    const evaluation = evaluateBlogGrounding(
      `<p>Northstar Dental Studio lists Emergency dental assessment and Family dentistry as services.</p>`,
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "unsupported_business_claim",
    );
  });

  it("allows a richer third-person business detail only with matching first-party evidence", () => {
    const packet = makePacket();
    packet.claims.push({
      id: "claim_owned_personalized_assessment",
      type: "business_service",
      text: "Emergency dental assessments include a review of symptoms and next-step options.",
      classification: "business",
      factIds: [],
      sourceUrl: "https://northstar.example.com/emergency-care",
      authority: "owned_website",
      evidenceExcerpt:
        "Emergency dental assessments include a review of symptoms and next-step options.",
    });
    const evaluation = evaluateBlogGrounding(
      `<p>Northstar Dental Studio says its emergency assessment reviews symptoms and next-step options. <a href="https://northstar.example.com/emergency-care">See the service page</a>.</p>`,
      packet,
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "unsupported_business_claim",
    );
  });

  it("blocks unsupported promotional business prose without first-party evidence", () => {
    const evaluation = evaluateBlogGrounding(
      `<p>Northstar Dental Studio provides consistently excellent and superior emergency dental assessment.</p>`,
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "unsupported_business_claim",
    );
  });

  it("accepts the application-owned verified business snapshot", () => {
    const evaluation = evaluateBlogGrounding(
      `<section data-uplift-assembled="verified-business-facts"><h2>Verified details about Northstar Dental Studio</h2><p><strong>Confirmed services:</strong> Emergency dental assessment, Family dentistry.</p></section><p>Readers can compare care options without assuming availability.</p>`,
      makePacket(),
    );
    expect(evaluation.issues).toEqual([]);
  });

  it("accepts the application-owned deterministic author block", () => {
    const evaluation = evaluateBlogGrounding(
      '<div class="author-bio" data-uplift-assembled="author-bio"><h3>About the Author</h3><p><strong>Editorial team at Northstar Dental Studio</strong> - Contributor at Northstar Dental Studio. Our team\'s focus areas include Emergency dental assessment.</p></div><p>Readers should compare the available paths.</p>',
      makePacket(),
    );
    expect(evaluation.issues).toEqual([]);
  });

  it("does not sanitize application-owned author or global module prose", () => {
    const packet = makePacket();
    const result = sanitizeModelAuthoredBusinessClaims(
      [
        '<div class="key-takeaways" data-uplift-assembled="key-takeaways"><h2>Key Takeaways</h2><ul><li>Northstar Dental Studio lists Family dentistry.</li></ul></div>',
        '<div class="author-bio" data-uplift-assembled="author-bio"><h3>About the Author</h3><p><strong>The Northstar Dental Studio Team</strong> - Editorial team. Our team focuses on verified services.</p></div>',
      ].join(""),
      packet,
    );

    expect(result.removed).toBe(0);
    expect(result.content).toContain("Our team focuses");
    expect(result.content).toContain("Key Takeaways");
  });

  it("does not evaluate application-owned table-of-contents links as prose", () => {
    const evaluation = evaluateBlogGrounding(
      '<nav class="toc" data-uplift-component="article-toc"><h2>Table of contents</h2><ol><li><a href="#one">What to compare</a></li></ol></nav><p>Compare the documented options.</p>',
      makePacket(),
    );

    expect(evaluation.issues).toEqual([]);
  });

  it("removes model-authored business claims but preserves the verified snapshot", () => {
    const packet = makePacket();
    const result = sanitizeModelAuthoredBusinessClaims(
      [
        '<section data-uplift-assembled="verified-business-facts"><h2>Verified details about Northstar Dental Studio</h2><p><strong>Confirmed services:</strong> Emergency dental assessment.</p></section>',
        "<p>Northstar Dental Studio provides consistently excellent care.</p>",
        "<ul><li>Our team keeps every appointment efficient.</li><li>Compare the available treatment paths.</li></ul>",
        "<p>Readers should confirm availability before choosing a clinic.</p>",
      ].join(""),
      packet,
    );

    expect(result.removed).toBe(2);
    expect(result.content).toContain(
      "Verified details about Northstar Dental Studio",
    );
    expect(result.content).not.toContain("consistently excellent care");
    expect(result.content).not.toContain("keeps every appointment efficient");
    expect(result.content).toContain("Compare the available treatment paths");
    expect(
      evaluateBlogGrounding(result.content, packet).issues.map(
        (issue) => issue.kind,
      ),
    ).not.toContain("unsupported_business_claim");
  });

  it("leaves unsupported business headings for the fail-closed gate", () => {
    const packet = makePacket();
    const result = sanitizeModelAuthoredBusinessClaims(
      "<h2>Why Northstar Dental Studio guarantees better care</h2><p>Compare treatment paths.</p>",
      packet,
    );

    expect(result.removed).toBe(0);
    expect(
      evaluateBlogGrounding(result.content, packet).issues.map(
        (issue) => issue.kind,
      ),
    ).toContain("unsupported_business_claim");
  });

  it("allows a neutral business-topic heading that belongs to the approved outline", () => {
    const packet = makePacket();
    const evaluation = evaluateBlogGrounding(
      '<h2 data-outline-id="outline-1-topic">What to know about Northstar Dental Studio</h2><p>Compare the available treatment paths.</p>',
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "unsupported_business_claim",
    );
  });

  it("blocks an assertive business heading even when it carries an outline id", () => {
    const packet = makePacket();
    const evaluation = evaluateBlogGrounding(
      '<h2 data-outline-id="outline-1-topic">Why Northstar Dental Studio guarantees better care</h2><p>Compare the available treatment paths.</p>',
      packet,
    );

    expect(evaluation.issues.map((issue) => issue.kind)).toContain(
      "unsupported_business_claim",
    );
  });

  it("also checks title and metadata claims that sit outside article HTML", () => {
    const evaluation = evaluateBlogGrounding(
      "<p>Useful, grounded article.</p>",
      makePacket(),
      "Northstar Dental Studio: Guaranteed 24/7 Same-Day Care",
    );
    const kinds = evaluation.issues.map((issue) => issue.kind);
    expect(kinds).toContain("availability");
    expect(kinds).toContain("guarantee");
  });

  it("rejects invented credentials, customer stories, and testimonials", () => {
    const evaluation = evaluateBlogGrounding(
      `
      <p>Our award-winning specialists have helped hundreds of patients.</p>
      <p>We've worked with families across Toronto for decades.</p>
      <div class="reviews"><p>Sam said this was the best clinic in Canada.</p></div>
      `,
      makePacket(),
    );
    const kinds = evaluation.issues.map((issue) => issue.kind);
    expect(kinds).toContain("credential");
    expect(kinds).toContain("experience");
    expect(kinds).toContain("review");
  });

  it("accepts a verbatim verified GMB review", () => {
    const evaluation = evaluateBlogGrounding(
      `<div class="reviews"><p>Jordan Lee: The team explained every step clearly and made the visit comfortable.</p></div>`,
      makePacket(),
    );
    expect(evaluation.issues.map((issue) => issue.kind)).not.toContain(
      "review",
    );
  });

  it("enforces selected title fields in application code", () => {
    const payload = {
      title: "Model changed this title",
      meta: {
        seo_title: "Model changed SEO title",
        og_title: "Model changed OG title",
      },
    };
    enforceLockedBlogFields(payload, makePacket().locked);
    expect(payload.title).toBe("Emergency Dentist Toronto: What to Do Next");
    expect(payload.meta.seo_title).toBe(
      "Emergency Dentist Toronto | What to Do Next",
    );
    expect(payload.meta.og_title).toBe(
      "Emergency Dentist Toronto: What to Do Next",
    );
  });
});
