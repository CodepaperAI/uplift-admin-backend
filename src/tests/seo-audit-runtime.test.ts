import { describe, expect, it } from "bun:test";
import {
  buildAuditParserChecks,
  calculateModuleScore,
  extractInternalLinks,
  finalizeFindingFromCheck,
  parseAuditPageFacts,
  selectAuditUrls,
  shouldUseRenderedFetch,
} from "../services/seo-audit.runtime";

describe("seo-audit runtime helpers", () => {
  it("prioritizes sitemap money pages, dedupes URLs, and skips assets", () => {
    const selected = selectAuditUrls(
      "https://example.com/",
      [
        "https://example.com/pricing",
        "https://example.com/services",
        "https://example.com/logo.png",
      ],
      [
        "https://example.com/contact",
        "https://example.com/services",
        "https://example.com/privacy-policy",
      ],
      4,
    );

    expect(selected).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/services",
      "https://example.com/contact",
    ]);
  });

  it("detects suspicious app-shell HTML for JS rendering", () => {
    const suspiciousHtml = `
      <html>
        <body>
          <div id="__next"></div>
          <script src="/_next/static/chunk.js"></script>
        </body>
      </html>
    `;

    const normalHtml = `
      <html>
        <body>
          <h1>Plumbing services in Toronto</h1>
          <p>Fast emergency support with licensed technicians and transparent pricing.</p>
          <a href="/contact">Contact</a>
          <a href="/services">Services</a>
          <a href="/pricing">Pricing</a>
        </body>
      </html>
    `;

    expect(shouldUseRenderedFetch(suspiciousHtml)).toBe(true);
    expect(shouldUseRenderedFetch(normalHtml)).toBe(false);
  });

  it("parses page facts and emits deterministic parser checks", () => {
    const pageFacts = parseAuditPageFacts(
      {
        requestedUrl: "https://example.com/services",
        finalUrl: "https://example.com/services",
        pageKey: "services",
        fetchMode: "static",
        httpStatus: 200,
        contentType: "text/html",
        durationMs: 120,
        htmlLength: 1200,
        bodyTextLength: 300,
        error: null,
        html: `
          <html lang="en">
            <head>
              <title>Toronto Drain Cleaning Experts</title>
              <meta name="description" content="Reliable drain cleaning and emergency plumbing services in Toronto.">
              <link rel="canonical" href="https://example.com/services">
              <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Example Plumbing"}</script>
              <script type="application/ld+json">{invalid</script>
            </head>
            <body>
              <h1>Drain Cleaning</h1>
              <h1>Emergency Plumbing</h1>
              <h2>What we handle</h2>
              <p>Call now for drain cleaning, leak repair, and sewer service.</p>
              <img src="/hero.jpg">
              <a href="/contact">Contact</a>
            </body>
          </html>
        `,
      },
      "https://example.com",
      "services",
    );

    expect(pageFacts.viewportContent).toBe("");
    expect(pageFacts.headings.h1.length).toBe(2);
    expect(pageFacts.images.missingAltCount).toBe(1);
    expect(pageFacts.jsonLd.parseableCount).toBe(1);
    expect(pageFacts.jsonLd.invalidCount).toBe(1);
    expect(pageFacts.jsonLd.schemaTypes).toContain("LocalBusiness");

    const checks = buildAuditParserChecks(
      {
        websiteUrl: "https://example.com/",
        origin: "https://example.com",
        sitemapDiscovered: true,
        sitemapUrl: "https://example.com/sitemap.xml",
        sitemapUrlCount: 20,
        sitemapSampleUrls: ["https://example.com/services"],
        robotsTxtFetched: true,
        robotsTxtUrl: "https://example.com/robots.txt",
        robotsTxtSnippet: "Sitemap: https://example.com/sitemap.xml",
        robotsTxtRawText: "Sitemap: https://example.com/sitemap.xml",
        robotsSitemapDeclarations: ["https://example.com/sitemap.xml"],
        llmsTxtFound: false,
        crawlAttemptedCount: 1,
        crawlSucceededCount: 1,
        crawlFailedCount: 0,
        renderedPageCount: 0,
      },
      [pageFacts],
    );

    const viewportCheck = checks.find((check) =>
      check.key.endsWith("meta.viewport.present"),
    );
    const h1Check = checks.find((check) =>
      check.key.endsWith("headings.h1.count"),
    );
    const schemaValidityCheck = checks.find(
      (check) => check.key === "site.schema.jsonld.validity",
    );

    expect(viewportCheck?.status).toBe("warning");
    expect(h1Check?.status).toBe("warning");
    expect(schemaValidityCheck?.status).toBe("warning");
    expect(calculateModuleScore(checks.filter((check) => check.module === "technical"))).toBeLessThan(100);
  });

  it("tracks visible freshness and stale article content separately", () => {
    const pageFacts = parseAuditPageFacts(
      {
        requestedUrl: "https://example.com/blog/signature-scent",
        finalUrl: "https://example.com/blog/signature-scent",
        pageKey: "blog",
        fetchMode: "static",
        httpStatus: 200,
        contentType: "text/html",
        durationMs: 80,
        htmlLength: 1800,
        bodyTextLength: 500,
        error: null,
        html: `
          <html lang="en">
            <head>
              <title>Signature Scent Guide</title>
              <meta property="article:modified_time" content="2025-01-01T00:00:00.000Z">
              <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","datePublished":"2025-01-01T00:00:00.000Z","dateModified":"2025-01-01T00:00:00.000Z"}</script>
            </head>
            <body>
              <p>Last updated: January 1, 2025</p>
              <h1>Signature Scent Guide</h1>
              <p>Detailed body content for the audit parser.</p>
            </body>
          </html>
        `,
      },
      "https://example.com",
      "blog",
    );

    expect(pageFacts.content.hasVisibleLastUpdated).toBe(true);
    expect(pageFacts.jsonLd.latestArticleDateModified).toBe("2025-01-01T00:00:00.000Z");

    const checks = buildAuditParserChecks(
      {
        websiteUrl: "https://example.com/",
        origin: "https://example.com",
        sitemapDiscovered: false,
        sitemapUrl: "",
        sitemapUrlCount: 0,
        sitemapSampleUrls: [],
        robotsTxtFetched: true,
        robotsTxtUrl: "https://example.com/robots.txt",
        robotsTxtSnippet: "",
        robotsTxtRawText: "",
        robotsSitemapDeclarations: [],
        llmsTxtFound: false,
        crawlAttemptedCount: 1,
        crawlSucceededCount: 1,
        crawlFailedCount: 0,
        renderedPageCount: 0,
      },
      [pageFacts],
    );

    expect(
      checks.find((check) => check.key === "site.content.visible_last_updated")?.status,
    ).toBe("pass");
    expect(
      checks.find((check) => check.key === "site.content.freshness_window")?.status,
    ).toBe("warning");
  });

  it("treats the static SPA shell as needing render and finds links in the rendered HTML", () => {
    // Regression: upliftai.co audit returned 0 internal links because internal-link
    // extraction ran against the unhydrated static shell. The crawler now upgrades
    // the homepage to a rendered fetch before extracting links.
    const staticShell = `
      <html>
        <head><title>Uplift</title></head>
        <body>
          <div id="__next"></div>
          <script src="/_next/static/chunks/main.js"></script>
        </body>
      </html>
    `;
    const renderedHomepage = `
      <html>
        <head><title>Uplift</title></head>
        <body>
          <nav>
            <a href="/">Home</a>
            <a href="/contact">Contact</a>
            <a href="/about">About</a>
            <a href="/pricing">Pricing</a>
            <a href="https://twitter.com/upliftai">Twitter</a>
          </nav>
          <h1>Welcome</h1>
        </body>
      </html>
    `;

    expect(shouldUseRenderedFetch(staticShell)).toBe(true);

    const shellLinks = extractInternalLinks(
      staticShell,
      "https://example.com/",
      "https://example.com",
    );
    expect(shellLinks).toEqual([]);

    const renderedLinks = extractInternalLinks(
      renderedHomepage,
      "https://example.com/",
      "https://example.com",
    );
    expect(renderedLinks).toContain("https://example.com/contact");
    expect(renderedLinks).toContain("https://example.com/about");
    expect(renderedLinks).toContain("https://example.com/pricing");
    expect(renderedLinks).not.toContain("https://twitter.com/upliftai");
  });

  it("downgrades unsupported model claims when the parser contradicts them", () => {
    const result = finalizeFindingFromCheck(
      "technical",
      {
        severity: "critical",
        title: "Missing viewport",
        description: "The page is missing a viewport tag.",
        evidenceRef: "page.home.meta.viewport.present",
        suggestedFix: "Add one.",
        affectedUrls: ["https://example.com/"],
      },
      new Map([
        [
          "page.home.meta.viewport.present",
          {
            module: "technical",
            key: "page.home.meta.viewport.present",
            label: "Viewport meta tag",
            status: "pass",
            severity: "pass",
            pageUrl: "https://example.com/",
            pageKey: "home",
            value: "width=device-width, initial-scale=1",
            rawSnippet: '<meta name="viewport" content="width=device-width, initial-scale=1">',
            details: "Viewport is present.",
            verifiedBy: "parser" as const,
          },
        ],
      ]),
    );

    expect(result.finding.severity).toBe("info");
    expect(result.finding.verificationStatus).toBe("contradicted");
    expect(result.contradiction?.reason).toContain("downgraded");
    expect(result.scoreEligible).toBe(false);
  });
});
