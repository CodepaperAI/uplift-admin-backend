import { describe, expect, it } from "bun:test";

import {
  appendVerifiedArticleJsonLd,
  assembleApplicationOwnedArticle,
} from "../services/blog-application-assembly.service";

describe("application-owned blog assembly", () => {
  it("owns TOC, heading ids, links, images, and strips model assets", () => {
    const result = assembleApplicationOwnedArticle({
      html: [
        "<h1>Guide</h1>",
        "<p>Useful introduction.</p>",
        '<img src="https://invented.test/image.jpg" alt="bad" />',
        '<p><a href="https://invented.test/source">Unsupported source</a></p>',
        "<h2>First Step</h2><p>First details.</p>",
        "<h2>Second Step</h2><p>Second details.</p>",
        "<h2>Third Step</h2><p>Third details.</p>",
        "<h2>Fourth Step</h2><p>Fourth details.</p>",
      ].join(""),
      title: "Guide",
      businessWebsiteUrl: "https://example.com",
      allowedExternalUrls: ["https://www.canada.ca/safe-source"],
      internalLinks: [
        { url: "https://example.com/blog/related", title: "Related guidance" },
      ],
      images: [
        { url: "https://images.example.com/featured.jpg", altText: "Featured" },
        { url: "https://images.example.com/body-one.jpg", altText: "Detail" },
        { url: "https://images.example.com/body-two.jpg", altText: "Process" },
      ],
      includeKeyTakeaways: true,
    });

    expect(result.html).toContain('class="toc"');
    expect(result.html).toContain('data-uplift-component="article-toc"');
    expect(result.html).toContain('class="key-takeaways"');
    expect(result.html).toContain('data-uplift-assembled="key-takeaways"');
    expect(result.headingIds).toEqual([
      "first-step",
      "second-step",
      "third-step",
      "fourth-step",
      "key-takeaways",
    ]);
    expect(result.html).toContain("https://example.com/blog/related");
    expect(result.html).not.toContain("invented.test");
    expect(result.html).toContain("body-one.jpg");
    expect(result.html).toContain("body-two.jpg");
    expect(result.featuredImageUrl).toBe(
      "https://images.example.com/featured.jpg",
    );
  });

  it("emits deterministic verified Article JSON-LD", () => {
    const html = appendVerifiedArticleJsonLd("<p>Body</p>", {
      title: "Verified guide",
      description: "A verified description",
      authorName: "Alex Writer",
      businessName: "Example Co",
      businessWebsiteUrl: "https://example.com",
      featuredImageUrl: "https://example.com/image.jpg",
      datePublished: "2026-07-13",
    });

    expect(html).toContain('data-uplift-assembled="article-schema"');
    expect(html).toContain('"headline":"Verified guide"');
    expect(html).toContain('"name":"Example Co"');
  });

  it("injects business claims only from the verified application packet", () => {
    const result = assembleApplicationOwnedArticle({
      html: "<p>Educational introduction.</p><h2>What to know</h2><p>General guidance.</p>",
      title: "Guide",
      businessWebsiteUrl: "https://example.com",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      verifiedBusiness: {
        businessName: "Example Co",
        website: "https://example.com",
        description: null,
        phone: null,
        location: {
          verified: true,
          city: "Toronto",
          region: "Ontario",
          country: "Canada",
        },
        serviceAreas: ["North York"],
        services: ["Office cleaning", "Move-out cleaning"],
        operatingFacts: [],
      },
    });

    expect(result.html).toContain('data-uplift-assembled="verified-business-facts"');
    expect(result.html).toContain("Office cleaning, Move-out cleaning");
    expect(result.html).toContain("Toronto, Ontario, Canada");
    expect(result.html).toContain("https://example.com");
  });

  it("keeps global modules outside section evidence and renders only verified local/review data", () => {
    const result = assembleApplicationOwnedArticle({
      html: [
        '<div class="quick-answer"><strong>Quick answer:</strong> Start here.</div>',
        '<h2 data-outline-id="outline-1">Options</h2>',
        '<aside class="verified-section-evidence" data-uplift-assembled="section-evidence"><h3>Verified details</h3><p>Exact source fact.</p></aside>',
        "<p>Decision guidance.</p>",
        '<h2 data-outline-id="outline-2">Frequently asked questions</h2>',
        '<h3>Question?</h3><p class="faq-answer">Answer.</p>',
      ].join(""),
      title: "Guide",
      businessWebsiteUrl: "https://example.com",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      verifiedBusiness: {
        businessName: "Example Co",
        website: "https://example.com",
        description: null,
        phone: null,
        location: {
          verified: true,
          city: "Toronto",
          region: "Ontario",
          country: "CA",
        },
        serviceAreas: ["Toronto", "Mississauga"],
        services: ["Corporate catering"],
        operatingFacts: ["5 days in advance"],
        reviews: [
          { reviewer: "Alex", rating: 5, text: "The event order was clearly organized." },
        ],
      },
      includeKeyTakeaways: true,
      includeLocalTip: true,
      includeReviews: true,
    });

    const evidenceBlock = result.html.match(
      /<aside\b[^>]*data-uplift-assembled="section-evidence"[^>]*>[\s\S]*?<\/aside>/i,
    )?.[0];
    expect(evidenceBlock).toBeDefined();
    expect(evidenceBlock).not.toContain('class="toc"');
    expect(evidenceBlock).not.toContain('class="verified-business-facts"');
    expect(result.html).toContain('data-uplift-assembled="local-tip"');
    expect(result.html).toContain("Toronto, Mississauga");
    expect(result.html).toContain('data-uplift-assembled="reviews"');
    expect(result.html).toContain("The event order was clearly organized.");
    expect(result.html).toContain("5 days in advance");
  });

  it("renders the local tip from service areas when the profile location is unverified", () => {
    const result = assembleApplicationOwnedArticle({
      html: '<h2 data-outline-id="outline-1">Options</h2><p>Compare the documented options.</p>',
      title: "Guide",
      businessWebsiteUrl: "https://example.com",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      verifiedBusiness: {
        businessName: "Example Co",
        website: "https://example.com",
        description: null,
        phone: null,
        location: {
          verified: false,
          city: null,
          region: null,
          country: null,
        },
        serviceAreas: ["Hamilton", "Stoney Creek"],
        services: ["Drain cleaning"],
        operatingFacts: [],
        reviews: [],
      },
      includeLocalTip: true,
    });

    expect(result.html).toContain('data-uplift-assembled="local-tip"');
    expect(result.html).toContain("Local planning note for Hamilton");
    expect(result.html).toContain("Hamilton, Stoney Creek");
    expect(result.html).not.toContain("verified profile location");
  });

  it("omits the local tip when neither a verified city nor service areas exist", () => {
    const result = assembleApplicationOwnedArticle({
      html: '<h2 data-outline-id="outline-1">Options</h2><p>Compare the documented options.</p>',
      title: "Guide",
      businessWebsiteUrl: "https://example.com",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      verifiedBusiness: {
        businessName: "Example Co",
        website: "https://example.com",
        description: null,
        phone: null,
        location: {
          verified: false,
          city: null,
          region: null,
          country: null,
        },
        serviceAreas: [],
        services: ["Drain cleaning"],
        operatingFacts: [],
        reviews: [],
      },
      includeLocalTip: true,
    });

    expect(result.html).not.toContain('data-uplift-assembled="local-tip"');
  });

  it("scopes ecommerce assembly to the locked product topic and suppresses local facts", () => {
    const result = assembleApplicationOwnedArticle({
      html: [
        "<p>Choose the configuration that matches the room.</p>",
        '<h2 data-outline-id="outline-1">Sectional sofa options</h2>',
        "<p>Compare dimensions and upholstery.</p>",
        '<h2 data-outline-id="outline-2">Frequently asked questions</h2>',
        '<h3>What should be measured?</h3><p class="faq-answer">Confirm the room dimensions.</p>',
      ].join(""),
      title: "Sectional Sofa Guide",
      topic: "sectional sofa",
      useLocalFacts: false,
      businessWebsiteUrl: "https://afbdecor.example",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      verifiedBusiness: {
        businessName: "AFBDECOR",
        website: "https://afbdecor.example",
        description: null,
        phone: null,
        location: {
          verified: true,
          city: "Buffalo",
          region: "New York",
          country: "US",
        },
        serviceAreas: ["Buffalo", "Rochester", "Albany"],
        services: [
          "Beds",
          "Nightstands",
          "Dressers",
          "Sofas",
          "Sectionals",
          "Dining Tables",
          "Dining Chairs",
          "Lighting",
          "Mirrors",
          "Wall Art",
        ],
        operatingFacts: [
          "From $508",
          "Unit price / per Sale 00 USD",
          "Sectional sofa from $1,299 USD",
        ],
        reviews: [],
      },
      includeKeyTakeaways: true,
      includeLocalTip: true,
    });

    expect(result.html).toContain("Sofas, Sectionals");
    expect(result.html).toContain("Sectional sofa from $1,299 USD");
    expect(result.html).not.toMatch(
      /Buffalo|Rochester|Albany|Dining Tables|Dining Chairs|Nightstands|From \$508|Unit price|00 USD/,
    );
    expect(result.html).not.toContain('data-uplift-assembled="local-tip"');
  });

  it("strips orphan sub-headings without swallowing surrounding content", () => {
    const result = assembleApplicationOwnedArticle({
      html: [
        '<h2 data-outline-id="outline-1">Options</h2>',
        "<h3>Orphan promise heading</h3>",
        "<h3>Real lens</h3><p>Compare the documented options carefully.</p>",
        '<h2 data-outline-id="outline-2">Second section</h2>',
        "<p>Verify current details before booking.</p>",
        "<h3>Trailing orphan</h3>",
      ].join("\n"),
      title: "Guide",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
    });

    expect(result.html).not.toContain("Orphan promise heading");
    expect(result.html).not.toContain("Trailing orphan");
    // Regression: a backtracking regex once swallowed everything between two
    // headings — the kept heading, its paragraph, and the next H2 must survive.
    expect(result.html).toContain("Real lens");
    expect(result.html).toContain("Compare the documented options carefully.");
    expect(result.html).toContain("Second section");
    expect(result.html).toContain("Verify current details before booking.");
  });

  it("replaces stale author and global blocks instead of duplicating them", () => {
    const result = assembleApplicationOwnedArticle({
      html: [
        '<nav class="toc" data-uplift-component="article-toc"><ol><li>Old</li></ol></nav>',
        '<h2 id="one">One</h2><p>Compare the documented options.</p>',
        '<div class="key-takeaways" data-uplift-assembled="key-takeaways"><h2>Key Takeaways</h2><ul><li>Old</li></ul></div>',
        '<div class="author-bio" data-uplift-assembled="author-bio"><h3>About</h3><p>Old bio</p></div>',
        '<h2 id="two">Two</h2><p>Verify current details.</p>',
      ].join(""),
      title: "Guide",
      allowedExternalUrls: [],
      internalLinks: [],
      images: [],
      includeKeyTakeaways: true,
      verifiedBusiness: {
        businessName: "Example Catering",
        website: "https://catering.example.com",
        description: null,
        phone: null,
        location: {
          verified: false,
          city: null,
          region: null,
          country: null,
        },
        serviceAreas: [],
        services: ["Corporate catering"],
        operatingFacts: [],
      },
      author: {
        name: "The Example Catering Team",
        jobTitle: "Editorial team at Example Catering",
        expertise: ["Corporate catering"],
      },
    });

    expect((result.html.match(/data-uplift-component="article-toc"/g) ?? [])).toHaveLength(1);
    expect((result.html.match(/data-uplift-assembled="key-takeaways"/g) ?? [])).toHaveLength(1);
    expect((result.html.match(/data-uplift-assembled="author-bio"/g) ?? [])).toHaveLength(1);
    expect(result.html).not.toContain("Old bio");
    expect(result.html).toContain("The Example Catering Team");
  });
});
