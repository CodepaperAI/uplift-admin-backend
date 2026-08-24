import { describe, expect, it } from "bun:test";
import {
  bucketAverages,
  correlateFeatures,
  extractContentFeatures,
  normalizeUrl,
  pearson,
  spearman,
  urlsMatch,
  urlVariants,
} from "../utils/ranking-correlation.utils";

describe("normalizeUrl / urlsMatch", () => {
  it("canonicalizes protocol, www, trailing slash, query", () => {
    expect(normalizeUrl("https://www.Example.com/Blog/Post/?utm=1")).toBe(
      "example.com/Blog/Post",
    );
    expect(normalizeUrl("http://example.com")).toBe("example.com");
    expect(normalizeUrl("")).toBe("");
  });

  it("matches across protocol/www/slash differences", () => {
    expect(urlsMatch("https://example.com/p", "http://www.example.com/p/")).toBe(true);
    expect(urlsMatch("https://example.com/a", "https://example.com/b")).toBe(false);
  });
});

describe("urlVariants", () => {
  it("produces protocol x www x slash candidates for a page", () => {
    const v = urlVariants("https://shop.com/products/x");
    expect(v).toContain("https://shop.com/products/x");
    expect(v).toContain("http://shop.com/products/x");
    expect(v).toContain("https://www.shop.com/products/x");
    expect(v).toContain("https://shop.com/products/x/");
  });
});

describe("pearson / spearman", () => {
  it("pearson is +1 / -1 for perfect linear relationships", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBe(1);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBe(-1);
  });

  it("returns 0 for n<2 or zero variance", () => {
    expect(pearson([1], [1])).toBe(0);
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
  });

  it("spearman is 1 for monotonic-but-nonlinear data", () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBe(1);
  });
});

describe("extractContentFeatures", () => {
  it("counts structural elements and classifies links", () => {
    const html = `
      <h2>One</h2><p>para one</p>
      <h3>Sub</h3><ul><li>a</li><li>b</li></ul>
      <a href="https://example.com/internal">int</a>
      <a href="/relative">rel</a>
      <a href="https://other.com/ext">ext</a>
      <img src="x.jpg"/>
      <div class="faq-question">Q?</div>
      <script type="application/ld+json">{}</script>
    `;
    const f = extractContentFeatures(html, "example.com");
    expect(f.h2Count).toBe(1);
    expect(f.h3Count).toBe(1);
    expect(f.listItemCount).toBe(2);
    expect(f.imageCount).toBe(1);
    expect(f.faqCount).toBe(1);
    expect(f.hasSchema).toBe(1);
    expect(f.internalLinkCount).toBe(2); // example.com link + relative
    expect(f.externalLinkCount).toBe(1); // other.com
    expect(f.wordCount).toBeGreaterThan(0);
  });
});

describe("correlateFeatures", () => {
  it("ranks features by absolute correlation with the outcome", () => {
    // featureA perfectly tracks outcome; featureB is flat (no correlation).
    const rows = [
      { features: { a: 1, b: 5 }, outcome: 1 },
      { features: { a: 2, b: 5 }, outcome: 2 },
      { features: { a: 3, b: 5 }, outcome: 3 },
    ];
    const out = correlateFeatures(rows);
    expect(out[0]?.feature).toBe("a");
    expect(out[0]?.correlation).toBe(1);
    const b = out.find((c) => c.feature === "b");
    expect(b?.correlation).toBe(0);
  });

  it("handles empty input", () => {
    expect(correlateFeatures([])).toEqual([]);
  });
});

describe("bucketAverages", () => {
  it("averages the outcome within each score bucket", () => {
    const points = [
      { score: 3, outcome: 20 },
      { score: 7, outcome: 8 },
      { score: 8, outcome: 6 },
    ];
    const out = bucketAverages(points, [
      { label: "low", lo: 0, hi: 4 },
      { label: "high", lo: 7, hi: 10 },
    ]);
    expect(out[0]).toEqual({ label: "low", n: 1, avgOutcome: 20 });
    expect(out[1]).toEqual({ label: "high", n: 2, avgOutcome: 7 });
  });
});
