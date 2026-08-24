import { describe, expect, it } from "bun:test";
import {
  extractExternalContentLinksFromHtml,
  extractExternalLinkUrlsFromHtml,
  matchManagedBusinessForUrl,
  sanitizeManagedCandidateLinks,
} from "../utils/managed-backlinks.utils";

describe("managed backlink utilities", () => {
  it("filters candidate links to valid absolute URLs and deduplicates normalized matches", () => {
    const sanitized = sanitizeManagedCandidateLinks([
      {
        title: "Published blog",
        url: "https://example.com/post/",
        businessId: "biz-1",
        score: 0.6,
      },
      {
        title: "Published blog duplicate",
        url: "https://example.com/post",
        businessId: "biz-1",
        score: 0.9,
      },
      {
        title: "Missing URL metadata",
        url: "",
        businessId: "biz-2",
        score: 0.8,
      },
      {
        title: "Relative only",
        url: "/relative/path",
        businessId: "biz-3",
        score: 0.7,
      },
    ]);

    expect(sanitized).toEqual([
      {
        title: "Published blog duplicate",
        url: "https://example.com/post",
        businessId: "biz-1",
        score: 0.9,
      },
    ]);
  });

  it("extracts unique external links from final HTML and ignores self-links/non-http targets", () => {
    const externalUrls = extractExternalLinkUrlsFromHtml({
      html: `
        <article>
          <a href="https://partner.com/post-a">Partner A</a>
          <a href="https://partner.com/post-a#section">Partner A duplicate</a>
          <a href="/services">Own site relative link</a>
          <a href="https://www.current-site.com/blog/another-post">Own site absolute</a>
          <a href="mailto:test@example.com">Email</a>
          <a href="#faq">Anchor only</a>
          <a href="tel:+15551234567">Phone</a>
          <a href="https://docs.partner.com/reference">Partner docs</a>
        </article>
      `,
      sourceBaseUrl: "https://current-site.com/blog/source-post",
      currentBusinessWebsiteUrl: "https://current-site.com",
    });

    expect(externalUrls).toEqual([
      "https://partner.com/post-a",
      "https://docs.partner.com/reference",
    ]);
  });

  it("returns the visible anchor text for each unique external content link", () => {
    const links = extractExternalContentLinksFromHtml({
      html: `
        <article>
          <a href="https://partner.com/guide#overview">
            Partner guide
          </a>
          <a href="https://partner.com/guide">Duplicate with another label</a>
          <a href="https://reference.org/report"><span>2026</span> report</a>
          <a href="/services">Our services</a>
          <a href="mailto:hello@example.com">Email us</a>
        </article>
      `,
      sourceBaseUrl: "https://current-site.com/blog/source-post",
      currentBusinessWebsiteUrl: "https://current-site.com",
    });

    expect(links).toEqual([
      {
        url: "https://partner.com/guide",
        anchorText: "Partner guide",
      },
      {
        url: "https://reference.org/report",
        anchorText: "2026 report",
      },
    ]);
  });

  it("matches an outbound URL to the best managed business by normalized website prefix", () => {
    const match = matchManagedBusinessForUrl("https://client-b.com/blog/post-1", [
      {
        businessId: "biz-a",
        websiteUrl: "https://client-a.com",
      },
      {
        businessId: "biz-b",
        websiteUrl: "https://client-b.com/blog",
      },
      {
        businessId: "biz-c",
        websiteUrl: "https://client-b.com",
      },
    ]);

    expect(match).toEqual({
      businessId: "biz-b",
      normalizedUrl: "https://client-b.com/blog/post-1",
    });
  });
});
