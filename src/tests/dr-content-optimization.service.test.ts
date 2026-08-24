import { describe, expect, test } from "bun:test";
import {
  preserveCanonicalNextStepSection,
  validateDrOptimizedContent,
} from "../services/dr-content-optimization.service";

describe("preserveCanonicalNextStepSection", () => {
  const approvedCta =
    '<section class="next-step"><h2 id="next-step">A practical next step</h2><p>Contact <a href="https://example-client.com/">Example Client</a>.</p></section>';

  test("restores the exact approved CTA when it sits beyond the optimizer prompt window", () => {
    const canonicalContent = `<article>${"x".repeat(9_000)}</article>\n${approvedCta}`;
    const optimizedContent =
      "<article><h1>Optimized article</h1><p>Key Takeaways</p></article>";

    const result = preserveCanonicalNextStepSection(
      canonicalContent,
      optimizedContent,
    );

    expect(result).toEndWith(approvedCta);
    expect(result.match(/class="next-step"/g)).toHaveLength(1);
    expect(result).toContain('href="https://example-client.com/"');
  });

  test("replaces a model-authored next-step section with the approved canonical CTA", () => {
    const canonicalContent = `<article><h1>Original</h1></article>${approvedCta}`;
    const optimizedContent =
      '<article><h1>Optimized</h1></article><section class="summary next-step"><p>Call a different company.</p></section>';

    const result = preserveCanonicalNextStepSection(
      canonicalContent,
      optimizedContent,
    );

    expect(result).not.toContain("Call a different company.");
    expect(result.match(/next-step/g)).toHaveLength(2);
    expect(result).toEndWith(approvedCta);
  });

  test("leaves ordinary non-recovery content unchanged", () => {
    const optimizedContent =
      "<article><h1>Optimized</h1><p>No approved CTA exists.</p></article>";

    expect(
      preserveCanonicalNextStepSection(
        "<article><h1>Original</h1></article>",
        optimizedContent,
      ),
    ).toBe(optimizedContent);
  });

  test("fails closed when canonical content contains multiple approved CTA sections", () => {
    expect(() =>
      preserveCanonicalNextStepSection(
        `<article><h1>Original</h1></article>${approvedCta}${approvedCta}`,
        "<article><h1>Optimized</h1></article>",
      ),
    ).toThrow("found 2");
  });
});

describe("validateDrOptimizedContent", () => {
  const canonical = [
    "<article>",
    "<h1>Event planning checklist</h1>",
    '<p>Use a practical checklist and review the <a href="https://example.com/guide">venue guide</a>.</p>',
    "<h2>Confirm the details</h2>",
    `<p>${"Confirm timing, access, capacity, and service details. ".repeat(30)}</p>`,
    "</article>",
  ].join("");

  test("accepts bounded structural additions that preserve canonical links", () => {
    const optimized = canonical.replace(
      "<h1>Event planning checklist</h1>",
      "<h1>Event planning checklist</h1><h2>Key Takeaways</h2><ul><li>Confirm the event requirements.</li></ul>",
    );

    expect(validateDrOptimizedContent(canonical, optimized)).toBe(optimized);
  });

  test("rejects the repeated ds00 malformed-anchor regression", () => {
    const corrupted = `${canonical}<h2>Sources &amp; References</h2><ul><li>&lt;a href=&quot;https://www.eventbrite.com/blog/academy/7-tips-${"ds00-".repeat(100)}</li></ul>`;

    expect(() => validateDrOptimizedContent(canonical, corrupted)).toThrow();
  });

  test("rejects a newly invented source URL", () => {
    const invented = canonical.replace(
      "</article>",
      '<h2>Sources &amp; References</h2><a href="https://invented.example/source">Source</a></article>',
    );

    expect(() => validateDrOptimizedContent(canonical, invented)).toThrow(
      /non-canonical link|ungrounded references section/,
    );
  });

  test("rejects removal of an existing canonical link", () => {
    const withoutLink = canonical.replace(
      '<a href="https://example.com/guide">venue guide</a>',
      "venue guide",
    );

    expect(() => validateDrOptimizedContent(canonical, withoutLink)).toThrow(
      "removed a canonical link",
    );
  });

  test("rejects unbalanced anchors and unsafe elements", () => {
    expect(() =>
      validateDrOptimizedContent(
        canonical,
        `${canonical}<a href="https://example.com/guide">broken`,
      ),
    ).toThrow("unbalanced anchor tags");

    expect(() =>
      validateDrOptimizedContent(canonical, `${canonical}<iframe src="/bad"></iframe>`),
    ).toThrow("unsafe HTML element");
  });
});
