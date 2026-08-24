import { describe, expect, it } from "bun:test";
import {
  buildLinkOverview,
  emptyLinkOverview,
} from "../utils/link-overview.utils";

describe("link overview read model", () => {
  it("keeps outbound article links separate from inbound managed backlinks", () => {
    const overview = buildLinkOverview({
      businessWebsiteUrl: "https://current-site.com",
      blogs: [
        {
          id: "blog-1",
          title: "First article",
          slug: "first-article",
          status: "PUBLISH",
          content: `
            <a href="https://partner.com/guide">Partner guide</a>
            <a href="https://partner.com/guide#details">Duplicate</a>
            <a href="https://research.org/report"><strong>Research</strong> report</a>
            <a href="/services">Internal service page</a>
          `,
          canonicalUrl: "https://publisher.example/insights/first-article",
          updatedAt: "2026-08-21T12:00:00.000Z",
          publishedBlogs: [],
        },
        {
          id: "blog-2",
          title: "Draft article",
          slug: "draft-article",
          status: "DRAFT",
          content: `<a href="https://partner.com/another">Another source</a>`,
          canonicalUrl: null,
          updatedAt: "2026-08-20T12:00:00.000Z",
          publishedBlogs: [
            { externalPostUrl: "https://current-site.com/blog/draft-article" },
          ],
        },
      ],
      managedBacklinks: [
        {
          id: "backlink-1",
          sourceBlogUrl: "https://managed-source.com/blog/recommendation",
          sourceBusinessId: "source-business",
          referredBlogUrl: "https://current-site.com/services",
          referredBusinessId: "current-business",
          createdAt: "2026-08-19T12:00:00.000Z",
          updatedAt: "2026-08-19T12:00:00.000Z",
        },
      ],
    });

    expect(overview.outboundContentLinks).toHaveLength(3);
    expect(overview.outboundContentLinks[0]).toMatchObject({
      blogId: "blog-1",
      blogTitle: "First article",
      sourceUrl: "https://publisher.example/insights/first-article",
      destinationUrl: "https://partner.com/guide",
      destinationDomain: "partner.com",
      anchorText: "Partner guide",
    });
    expect(overview.outboundContentLinks[1]?.anchorText).toBe(
      "Research report",
    );
    expect(overview.managedBacklinks).toEqual([
      expect.objectContaining({
        id: "backlink-1",
        sourceDomain: "managed-source.com",
        targetDomain: "current-site.com",
      }),
    ]);
    expect(overview.summary).toEqual({
      outboundLinks: 3,
      outboundDomains: 2,
      articlesWithOutboundLinks: 2,
      managedBacklinks: 1,
      managedSourceDomains: 1,
      managedTargetPages: 1,
      latestActivityAt: "2026-08-21T12:00:00.000Z",
    });
  });

  it("returns a stable empty contract when a workspace has no links", () => {
    expect(emptyLinkOverview()).toEqual({
      outboundContentLinks: [],
      managedBacklinks: [],
      summary: {
        outboundLinks: 0,
        outboundDomains: 0,
        articlesWithOutboundLinks: 0,
        managedBacklinks: 0,
        managedSourceDomains: 0,
        managedTargetPages: 0,
        latestActivityAt: null,
      },
    });
  });
});
