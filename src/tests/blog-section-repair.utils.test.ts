import { describe, expect, it } from "bun:test";

import {
  buildSectionRepairInstruction,
  locateFailureSection,
  preservePassingSections,
  splitBlogHtmlSections,
} from "../utils/blog-section-repair.utils";

const ORIGINAL = [
  "<p>Intro remains exact.</p>",
  "<h2>Verified Services</h2><p>Mobile patrol is available.</p>",
  "<h2>Response Planning</h2><p>We arrive within 10 minutes.</p>",
  "<h2>Next Steps</h2><p>Contact the team.</p>",
].join("");

describe("section-scoped blog repair", () => {
  it("splits stable sections and locates the failed excerpt", () => {
    const sections = splitBlogHtmlSections(ORIGINAL);
    expect(sections.map((section) => section.id)).toEqual([
      "intro",
      "section-1-verified-services",
      "section-2-response-planning",
      "section-3-next-steps",
    ]);
    expect(locateFailureSection(ORIGINAL, "arrive within 10 minutes")).toBe(
      "section-2-response-planning",
    );
  });

  it("uses the locked outline id when one is present", () => {
    const html =
      '<h2 data-outline-id="outline-training">Training</h2><p>Supported text.</p>';
    expect(splitBlogHtmlSections(html)[0]?.id).toBe("outline-training");
    expect(locateFailureSection(html, "Supported text")).toBe(
      "outline-training",
    );
  });

  it("restores passing sections byte-for-byte and keeps only the failed replacement", () => {
    const candidate = [
      "<p>A rewritten intro that must not survive.</p>",
      "<h2>Verified Services</h2><p>Invented service rewrite.</p>",
      "<h2>Response Planning</h2><p>Confirm timing directly with the team.</p>",
      "<h2>Next Steps</h2><p>Changed CTA.</p>",
    ].join("");
    const result = preservePassingSections({
      previousHtml: ORIGINAL,
      candidateHtml: candidate,
      failedSectionIds: ["section-2-response-planning"],
    });
    expect(result.html).toContain("Intro remains exact");
    expect(result.html).toContain("Mobile patrol is available");
    expect(result.html).toContain("Confirm timing directly with the team");
    expect(result.html).toContain("Contact the team");
    expect(result.html).not.toContain("rewritten intro");
    expect(result.html).not.toContain("Invented service rewrite");
  });

  it("does not preserve application-owned global modules as model sections", () => {
    const previous = [
      '<nav class="toc" data-uplift-component="article-toc"><ol><li>Old</li></ol></nav>',
      '<h2 data-outline-id="one">One</h2><p>Passing section.</p>',
      '<div class="key-takeaways" data-uplift-assembled="key-takeaways"><h2>Key Takeaways</h2><ul><li>Old</li></ul></div>',
      '<h2 data-outline-id="two">Two</h2><p>Failing section.</p>',
      '<div class="author-bio" data-uplift-assembled="author-bio"><p>Old bio</p></div>',
    ].join("");
    const candidate = [
      '<h2 data-outline-id="one">One</h2><p>Changed passing section.</p>',
      '<h2 data-outline-id="two">Two</h2><p>Repaired section.</p>',
    ].join("");
    const result = preservePassingSections({
      previousHtml: previous,
      candidateHtml: candidate,
      failedSectionIds: ["two"],
    });

    expect(result.html).toContain("Passing section");
    expect(result.html).toContain("Repaired section");
    expect(result.html).not.toContain("Key Takeaways");
    expect(result.html).not.toContain("Old bio");
    expect(result.html).not.toContain("article-toc");
  });

  it("creates deterministic instructions without forwarding judge prose", () => {
    const instruction = buildSectionRepairInstruction([
      {
        sectionId: "section-2-response-planning",
        claimExcerpt: "within 10 minutes",
        reason: "Unsupported response-time promise",
        issueKind: "availability",
        allowedFacts: ["service: Mobile Patrols"],
      },
    ]);
    expect(instruction).toContain("SECTION-ONLY REPAIR CONTRACT");
    expect(instruction).toContain("section-2-response-planning");
    expect(instruction).toContain("service: Mobile Patrols");
  });
});
