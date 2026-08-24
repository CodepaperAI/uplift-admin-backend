import { describe, expect, it } from "bun:test";
import {
  resolveOnboardingWebsiteIdentityUrl,
  scrapeWebsiteForOnboarding,
  type OnboardingScrapeDeps,
} from "../utils/onboarding-scrape.utils";

describe("resolveOnboardingWebsiteIdentityUrl", () => {
  it("uses one guarded top-level frameset target as the canonical identity", async () => {
    const calls: string[] = [];
    const result = await resolveOnboardingWebsiteIdentityUrl(
      "https://legacy.example/",
      {
        fetchHtml: async (url) => {
          calls.push(`fetch:${url}`);
          return '<html><frameset><frame src="https://canonical.example/home"></frameset></html>';
        },
        validatePublicUrl: async (url) => {
          calls.push(`guard:${url}`);
          return url;
        },
      },
    );

    expect(result).toBe("https://canonical.example/home");
    expect(calls).toEqual([
      "fetch:https://legacy.example/",
      "guard:https://canonical.example/home",
    ]);
  });

  it("ignores body iframes and falls back when the identity provider fails", async () => {
    expect(
      await resolveOnboardingWebsiteIdentityUrl("https://example.com", {
        fetchHtml: async () =>
          '<html><body><iframe src="https://other.example"></iframe></body></html>',
        validatePublicUrl: async (url) => url,
      }),
    ).toBe("https://example.com/");

    expect(
      await resolveOnboardingWebsiteIdentityUrl("https://example.com", {
        fetchHtml: async () => {
          throw new Error("provider unavailable");
        },
        validatePublicUrl: async (url) => url,
      }),
    ).toBe("https://example.com/");
  });
});

describe("scrapeWebsiteForOnboarding", () => {
  it("follows one explicit top-level frameset document through the guarded provider", async () => {
    const calls: Array<{ url: string; render?: boolean; outputFormat?: string }> = [];
    const snapshot = await scrapeWebsiteForOnboarding(
      "https://forwarder.example",
      {
        fetchWithScraperAPI: (async (url, options) => {
          calls.push({
            url,
            render: options?.render,
            outputFormat: options?.outputFormat,
          });
          if (options?.outputFormat === "markdown") return "Thin";
          if (url === "https://forwarder.example/") {
            return '<html><frameset rows="100%"><frame src="https://site.example/home"></frameset></html>';
          }
          return `
            <html>
              <head><title>Grounded Service Company</title></head>
              <body>
                <h1>Grounded Service Company</h1>
                <h2>Residential services</h2>
                <p>${"Detailed first-party service information for local homeowners. ".repeat(12)}</p>
                <a href="/services">Services</a>
                <a href="/about">About</a>
                <a href="/contact">Contact</a>
              </body>
            </html>
          `;
        }) as OnboardingScrapeDeps["fetchWithScraperAPI"],
        scrapeWebsite: async () => {
          throw new Error("structured fallback should not run");
        },
      },
    );

    expect(snapshot.markdownMode).toBe("html");
    expect(snapshot.finalUrl).toBe("https://site.example/home");
    expect(snapshot.markdown).toContain("Grounded Service Company");
    expect(calls).toContainEqual({
      url: "https://site.example/home",
      render: false,
      outputFormat: undefined,
    });
  });

  it("does not follow an ordinary iframe embedded in body content", async () => {
    const html = `
      <html><body>
        <h1>Primary content</h1>
        <p>${"Useful information about the actual business and its customers. ".repeat(12)}</p>
        <iframe src="https://unrelated.example"></iframe>
      </body></html>
    `;
    const requestedUrls: string[] = [];
    const snapshot = await scrapeWebsiteForOnboarding(
      "https://primary.example",
      {
        fetchWithScraperAPI: (async (url, options) => {
          requestedUrls.push(url);
          return options?.outputFormat === "markdown" ? "Thin" : html;
        }) as OnboardingScrapeDeps["fetchWithScraperAPI"],
        scrapeWebsite: async () => {
          throw new Error("structured fallback should not run");
        },
      },
    );

    expect(snapshot.finalUrl).toBe("https://primary.example/");
    expect(snapshot.markdownMode).toBe("html");
    expect(requestedUrls).not.toContain("https://unrelated.example/");
  });
  it("uses the initial markdown scrape when content is already strong enough", async () => {
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async (_url: string, options?: { outputFormat?: string }) => {
        if (options?.outputFormat === "markdown") {
          return `# Example\n\n${"A".repeat(600)}`;
        }

        return `
          <html>
            <head>
              <title>Example</title>
              <meta name="description" content="Example description" />
            </head>
            <body>
              <h1>Example</h1>
              <a href="/about">About</a>
              <a href="/services">Services</a>
              <a href="/contact">Contact</a>
              <p>${"B".repeat(200)}</p>
            </body>
          </html>
        `;
      },
      scrapeWebsite: async () => {
        throw new Error("Structured fallback should not be used");
      },
    };

    const snapshot = await scrapeWebsiteForOnboarding("https://example.com", deps);

    expect(snapshot.markdownMode).toBe("markdown");
    expect(snapshot.renderFallbackReason).toBeNull();
    expect(snapshot.structuredFallbackUsed).toBe(false);
    expect(snapshot.puppeteerFallbackUsed).toBe(false);
    expect(snapshot.seoSignals.title).toBe("Example");
  });

  it("retries markdown with render=true when the initial scrape is thin", async () => {
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async (
        _url: string,
        options?: { outputFormat?: string; render?: boolean },
      ) => {
        if (options?.outputFormat === "markdown" && !options?.render) {
          return "Loading...";
        }

        if (options?.outputFormat === "markdown" && options?.render) {
          return `# Rendered Example\n\n${"C".repeat(700)}`;
        }

        return `
          <html>
            <head>
              <title>Rendered Example</title>
              <meta name="description" content="Rendered description" />
            </head>
            <body>
              <h1>Rendered Example</h1>
              <a href="/about">About</a>
              <a href="/services">Services</a>
              <a href="/contact">Contact</a>
              <p>${"D".repeat(200)}</p>
            </body>
          </html>
        `;
      },
      scrapeWebsite: async () => {
        throw new Error("Structured fallback should not be used");
      },
    };

    const snapshot = await scrapeWebsiteForOnboarding("https://example.com", deps);

    expect(snapshot.markdownMode).toBe("markdown+render");
    expect(snapshot.renderFallbackReason).toBe("app_shell_markdown");
    expect(snapshot.structuredFallbackUsed).toBe(false);
    expect(snapshot.puppeteerFallbackUsed).toBe(false);
  });

  it("falls back to the shared structured scraper path after hard markdown failures", async () => {
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async () => {
        throw new Error("ScraperAPI failed: 403 Forbidden");
      },
      scrapeWebsite: async (url: string) => ({
        title: "Fallback Example",
        metaTags: [
          { name: "description", content: "Fallback description" },
          { name: "og:title", content: "Fallback OG" },
        ],
        headers: { h1: ["Immersive VR Experiences"], h2: ["Group Events"], h3: [] },
        canonical: url,
        links: [
          { href: `${url}/about`, text: "About", rel: "" },
          { href: `${url}/contact`, text: "Contact", rel: "" },
        ],
        scripts: [
          {
            src: null,
            type: "application/ld+json",
            jsonLD:
              '{"@context":"https://schema.org","@type":"Organization","name":"Fallback Example"}',
          },
        ],
        wordCount: 500,
        bodyText: `Immersive VR experiences for parties and events. ${"E".repeat(700)}`,
        source: "puppeteer" as const,
        finalUrl: url,
      }),
    };

    const snapshot = await scrapeWebsiteForOnboarding("https://example.com", deps);

    expect(snapshot.markdownMode).toBe("structured-fallback");
    expect(snapshot.structuredFallbackUsed).toBe(true);
    expect(snapshot.puppeteerFallbackUsed).toBe(true);
    expect(snapshot.markdown).toContain("Fallback Example");
    expect(snapshot.seoSignals.metaDescription).toBe("Fallback description");
  });

  it("uses plain HTML grounding before the structured fallback when markdown stays weak", async () => {
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async (
        _url: string,
        options?: { outputFormat?: string; render?: boolean },
      ) => {
        if (options?.outputFormat === "markdown" && !options?.render) {
          return "Loading...";
        }

        if (options?.outputFormat === "markdown" && options?.render) {
          return "Interactive experience";
        }

        return `
          <html>
            <head>
              <title>Next Level VR</title>
              <meta name="description" content="Immersive VR events and parties." />
            </head>
            <body>
              <h1>Next Level VR</h1>
              <h2>Corporate Events</h2>
              <h2>Birthday Parties</h2>
              <a href="/events">Events</a>
              <a href="/pricing">Pricing</a>
              <a href="/contact">Contact</a>
              <p>${"F".repeat(900)}</p>
            </body>
          </html>
        `;
      },
      scrapeWebsite: async () => {
        throw new Error("Structured fallback should not be used");
      },
    };

    const snapshot = await scrapeWebsiteForOnboarding("https://example.com", deps);

    expect(snapshot.markdownMode).toBe("html");
    expect(snapshot.structuredFallbackUsed).toBe(false);
    expect(snapshot.puppeteerFallbackUsed).toBe(false);
    expect(snapshot.markdown).toContain("Next Level VR");
    expect(snapshot.seoSignals.metaDescription).toBe(
      "Immersive VR events and parties.",
    );
  });

  it("escalates plain HTML to render only when the document is an app shell", async () => {
    const calls: Array<{
      render?: boolean;
      outputFormat?: string;
      deviceType?: "desktop" | "mobile";
    }> = [];
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async (
        _url: string,
        options?: {
          outputFormat?: string;
          render?: boolean;
          deviceType?: "desktop" | "mobile";
        },
      ) => {
        calls.push(options ?? {});
        if (options?.outputFormat === "markdown") return "Loading...";
        if (!options?.render) {
          return "<html><body><p>Loading...</p></body></html>";
        }
        return `
          <html><body>
            <h1>Rendered Service Company</h1>
            <h2>Local services</h2>
            <p>${"Rendered first-party details about the company and customers. ".repeat(12)}</p>
            <a href="/services">Services</a>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </body></html>
        `;
      },
      scrapeWebsite: async () => {
        throw new Error("Structured fallback should not be used");
      },
    };

    const snapshot = await scrapeWebsiteForOnboarding(
      "https://app-shell.example",
      deps,
    );

    expect(snapshot.markdownMode).toBe("html+render");
    expect(calls).toContainEqual({ render: false });
    expect(calls).toContainEqual({ render: true, deviceType: "desktop" });
  });

  it("throws a structured terminal error when all scrape fallbacks fail", async () => {
    const deps: OnboardingScrapeDeps = {
      fetchWithScraperAPI: async () => {
        throw new Error("ScraperAPI failed: 403 Forbidden");
      },
      scrapeWebsite: async () => {
        throw new Error("Browser navigation failed");
      },
    };

    try {
      await scrapeWebsiteForOnboarding("https://example.com", deps);
      throw new Error("Expected scrapeWebsiteForOnboarding to throw");
    } catch (error) {
      expect(error).toMatchObject({
        name: "OnboardingScrapeError",
        code: "site_inaccessible",
        stage: "structured_fallback_scrape",
      });
    }
  });
});
