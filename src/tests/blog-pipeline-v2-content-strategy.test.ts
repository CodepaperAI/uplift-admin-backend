import { describe, expect, test } from "bun:test";

import {
  analyzeKeywordCannibalization,
  loadProductionContentStrategy,
} from "../services/blog-pipeline-v2/content-strategy";
import {
  BLOG_EDITORIAL_QUALITY_CONTRACT,
  descriptiveAltTextIssues,
  normalizeProductionLinkRelations,
  productionSlugIssues,
} from "../services/blog-pipeline-v2/editorial-quality";
import { buildProductionBlogImageBriefs } from "../services/blog-pipeline-v2/image-pipeline";

describe("production-v2 search and editorial strategy", () => {
  test("detects material Search Console cannibalization across competing pages", () => {
    const result = analyzeKeywordCannibalization(
      [
        {
          query: "mulch for landscaping beds",
          page: "https://example.com/blog/mulch-guide",
          clicks: 8,
          impressions: 120,
          position: 7,
        },
        {
          query: "best mulch for landscaping bed",
          page: "https://example.com/services/landscaping",
          clicks: 3,
          impressions: 40,
          position: 13,
        },
        {
          query: "unrelated lawn mowing",
          page: "https://example.com/lawn",
          clicks: 20,
          impressions: 400,
          position: 2,
        },
      ],
      "mulch for landscaping beds",
    );

    expect(result.risk).toBe("competing-pages");
    expect(result.pages.map((page) => page.page)).toEqual([
      "https://example.com/blog/mulch-guide",
      "https://example.com/services/landscaping",
    ]);
    expect(result.matchingQueries).not.toContain("unrelated lawn mowing");
  });

  test("normalizes all off-site links to nofollow and keeps internal links followable", () => {
    const html = normalizeProductionLinkRelations(
      '<p><a href="https://example.com/blog/mulch" rel="nofollow">Mulch advice</a> <a href="https://authority.example/guidance">Official guidance</a></p>',
      "https://www.example.com",
    );
    expect(html).toContain('<a href="https://example.com/blog/mulch">');
    expect(html).toContain(
      '<a href="https://authority.example/guidance" rel="nofollow noopener noreferrer">',
    );
  });

  test("enforces exact primary-keyword slugs and descriptive concise alt text", () => {
    expect(
      productionSlugIssues(
        "mulch-for-landscaping-beds",
        "mulch for landscaping beds",
      ),
    ).toEqual([]);
    expect(
      productionSlugIssues("landscaping-tips", "mulch for landscaping beds"),
    ).toContain(
      "slug_missing_primary_keyword:mulch-for-landscaping-beds",
    );
    expect(
      descriptiveAltTextIssues(
        "Landscaper spreading cedar mulch around flowering garden beds",
      ),
    ).toEqual([]);
    expect(descriptiveAltTextIssues("Article illustration")).toContain(
      "alt_text_generic_label",
    );
  });

  test("keeps the complete SEO, AIO, GEO, and AEO checklist in one prompt contract", () => {
    for (const phrase of [
      "Topic fidelity",
      "AI-search structure",
      "Title and metadata",
      "Evidence-backed promises",
      "Keyword use",
      "Helpfulness and E-E-A-T",
      "Scannability",
      "Internal links",
      "External links",
      "Search Console and cannibalization",
      "Topic clusters",
      "URL slug",
      "FAQ and ending",
      "Images and alt text",
      "Local relevance",
      "Publication data",
    ]) {
      expect(BLOG_EDITORIAL_QUALITY_CONTRACT).toContain(phrase);
    }
  });

  test("uses model-planned visual descriptions and alt text without role-specific content forcing", () => {
    const briefs = buildProductionBlogImageBriefs({
      title: "How to Choose Mulch for Landscaping Beds",
      keyword: "mulch for landscaping beds",
      businessName: "Green Garden",
      locale: "en-CA",
      content:
        "<h1>How to Choose Mulch for Landscaping Beds</h1><h2>Compare drainage needs</h2><p>Match materials to the bed.</p><h2>Check plant spacing</h2><p>Keep stems clear.</p>",
      editorialBriefs: [
        {
          role: "featured",
          visualDescription:
            "A landscaper spreading cedar mulch across a curved flowering bed",
          altText:
            "Landscaper spreading cedar mulch across a curved flowering bed",
        },
        {
          role: "internal-1",
          visualDescription:
            "Hands comparing coarse bark and fine compost beside young shrubs",
          altText: "Hands comparing coarse bark and fine compost beside young shrubs",
        },
        {
          role: "internal-2",
          visualDescription:
            "Gardener keeping fresh mulch clear of a young tree trunk",
          altText: "Gardener keeping fresh mulch clear of a young tree trunk",
        },
      ],
    });
    expect(briefs.map((brief) => brief.role)).toEqual([
      "featured",
      "internal-1",
      "internal-2",
    ]);
    expect(briefs[0]?.altText).toBe(
      "Landscaper spreading cedar mulch across a curved flowering bed",
    );
    expect(briefs[0]?.prompt).toContain(
      "Required visible scene: A landscaper spreading cedar mulch across a curved flowering bed",
    );
  });

  test("loads cluster siblings and GSC competitors before article planning", async () => {
    const prisma = {
      businessAnalyticsConfig: {
        findUnique: async () => ({ gscSiteUrl: "sc-domain:example.com" }),
      },
      searchConsoleMetric: {
        findMany: async () => [
          {
            query: "mulch for landscaping beds",
            page: "https://example.com/blog/existing-mulch-guide",
            clicks: 7,
            impressions: 90,
            position: 8,
          },
        ],
      },
      contentCluster: {
        findFirst: async () => ({
          id: "cluster-1",
          name: "Landscape bed care",
          description: "Planning and maintaining planted beds",
          keywords: [
            {
              keyword: "landscape bed drainage",
              clusterRole: "pillar",
              blog: {
                title: "Landscape Bed Drainage Planning",
                canonicalUrl: null,
                publishedBlogs: [
                  { externalPostUrl: "https://example.com/blog/bed-drainage" },
                ],
              },
            },
          ],
        }),
      },
    };
    const result = await loadProductionContentStrategy({
      prisma: prisma as never,
      businessId: "business-1",
      userId: "user-1",
      plan: {
        id: "plan-1",
        keyword: "mulch for landscaping beds",
        clusterId: "cluster-1",
        clusterRole: "cluster",
      },
      now: new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(result.context.searchConsole.connected).toBe(true);
    expect(result.context.searchConsole.cannibalization.risk).toBe(
      "existing-page",
    );
    expect(result.context.cluster?.pillarKeyword).toBe(
      "landscape bed drainage",
    );
    expect(result.preferredInternalLinks.map((link) => link.url)).toEqual([
      "https://example.com/blog/bed-drainage",
      "https://example.com/blog/existing-mulch-guide",
    ]);
    expect(result.preferredInternalLinks[1]?.score).toBeGreaterThan(
      result.preferredInternalLinks[0]?.score ?? 0,
    );
    expect(result.preferredInternalLinks[1]?.title).toBe(
      "mulch for landscaping beds",
    );
  });
});
