import { describe, expect, test } from "bun:test";
import { load } from "cheerio";

import {
  appendProductionBlogStructuredData,
  buildProductionBlogStructuredData,
} from "../services/blog-pipeline-v2/structured-data";

const content = [
  "<article>",
  "<h1>Mulch for Landscaping Beds: A Practical Selection Plan</h1>",
  '<aside class="blog-key-takeaway" data-uplift-component="direct-answer"><strong>Key takeaway:</strong><p>Choose the material for the actual bed. Check plants, drainage, and maintenance together.</p></aside>',
  "<h2>Frequently asked questions</h2>",
  "<h3>Which mulch fits the plants?</h3><p>Compare the moisture needs of the plants. Then assess the bed conditions.</p>",
  "<h3>Can mulch fix drainage?</h3><p>It cannot correct an underlying drainage fault. Check water movement separately.</p>",
  "<h3>How should the surface be maintained?</h3><p>Inspect its condition during routine care. Correct displaced material when needed.</p>",
  "<h3>When should the choice be reviewed?</h3><p>Review it when planting or site conditions change. Recheck after significant weather.</p>",
  "<h2>Talk with Green Garden</h2><p>Discuss the bed with Green Garden.</p>",
  "</article>",
].join("");

function schemas() {
  return buildProductionBlogStructuredData({
    title: "Mulch for Landscaping Beds: A Practical Selection Plan",
    excerpt:
      "Compare mulch options for landscaping beds using practical criteria for drainage, plant needs, maintenance, appearance, and long-term garden care.",
    slug: "mulch-for-landscaping-beds",
    keyword: "mulch for landscaping beds",
    locale: "en-CA",
    images: [
      "https://cdn.example/featured.png",
      "https://cdn.example/one.png",
      "https://cdn.example/two.png",
    ],
    authorName: "Avery Green",
    businessName: "Green Garden",
    businessWebsiteUrl: "https://example.com",
    publishDate: "2026-08-20",
    modifiedDate: "2026-08-20T15:00:00.000Z",
    categories: ["Landscaping"],
    tags: ["mulch", "garden beds"],
  });
}

describe("production blog structured data", () => {
  test("builds article and breadcrumb metadata without interpreting article headings", () => {
    const result = schemas();
    expect(result.map((item) => item["@type"])).toEqual([
      "BlogPosting",
      "BreadcrumbList",
    ]);
    expect(result[0]?.url).toBe(
      "https://example.com/blog/mulch-for-landscaping-beds",
    );
    expect(
      ((result[1]?.itemListElement as Array<Record<string, unknown>>)[2]?.item),
    ).toBe("https://example.com/blog/mulch-for-landscaping-beds");
  });

  test("appends parseable application-owned JSON-LD without changing article text", () => {
    const html = appendProductionBlogStructuredData(content, schemas());
    const $ = load(html, null, false);
    const scripts = $('script[type="application/ld+json"][data-uplift-schema]');
    expect(scripts).toHaveLength(2);
    expect(scripts.toArray().map((script) => JSON.parse($(script).html() ?? "{}")["@type"])).toEqual([
      "BlogPosting",
      "BreadcrumbList",
    ]);
    expect($.root().text()).toContain("Which mulch fits the plants?");
  });

  test("does not require or infer an FAQ section", () => {
    const result = buildProductionBlogStructuredData({
      title: "Mulch for Landscaping Beds: A Practical Selection Plan",
      excerpt: "x".repeat(145),
      slug: "mulch-for-landscaping-beds",
      keyword: "mulch for landscaping beds",
      locale: "en-CA",
      images: [],
      authorName: "Avery Green",
      businessName: "Green Garden",
      businessWebsiteUrl: "https://example.com",
      publishDate: "2026-08-20",
    });
    expect(result.map((item) => item["@type"])).toEqual([
      "BlogPosting",
      "BreadcrumbList",
    ]);
    expect(result[0]).not.toHaveProperty("image");
  });
});
