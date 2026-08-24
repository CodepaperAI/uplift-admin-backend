import { XMLParser } from "fast-xml-parser";
import fetch from "node-fetch";
import type { Browser } from "puppeteer";
import { launchStealthBrowser } from "./browser.utils";
import { guardUrl, safeFetch } from "./ssrf-guard";

const SCRAPER_API_URL = "https://api.scraperapi.com";
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_SITEMAP_URLS = 50_000;
const MAX_SITEMAP_FILES = 100;

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Remote response is too large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (value: Uint8Array | undefined) => {
    if (!value) return;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("Remote response is too large");
    }
    chunks.push(value);
  };
  const body = response.body as unknown as {
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>;
    destroy?: (error?: Error) => void;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  } | null;
  const reader = body?.getReader?.();

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        append(value);
      } catch (error) {
        await reader.cancel("Remote response is too large");
        throw error;
      }
    }
  } else if (body?.[Symbol.asyncIterator]) {
    try {
      for await (const value of body as AsyncIterable<Uint8Array>) {
        append(value instanceof Uint8Array ? value : new Uint8Array(value));
      }
    } catch (error) {
      body.destroy?.(
        error instanceof Error ? error : new Error("Remote response failed"),
      );
      throw error;
    }
  } else {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("Remote response is too large");
    }
    append(new Uint8Array(buffer));
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export type ScrapedMetaTag = {
  name: string | null;
  content: string | null;
};

export type ScrapedLink = {
  href: string;
  text: string;
  rel: string;
};

export type ScrapedScript = {
  src: string | null;
  type: string | null;
  jsonLD: string | null;
};

export type ScrapeWebsiteResult = {
  title: string;
  metaTags: ScrapedMetaTag[];
  headers: Record<string, string[]>;
  canonical: string | null;
  links: ScrapedLink[];
  scripts: ScrapedScript[];
  wordCount: number;
  bodyText: string;
  source: "scraperapi" | "puppeteer";
  finalUrl: string;
};

export type FetchWithScraperAPIOptions = {
  render?: boolean;
  outputFormat?: "markdown";
  deviceType?: "desktop" | "mobile";
};

function getScraperApiKey(): string {
  const key = process.env.SCRAPER_API_KEY;
  if (!key || key.length === 0) {
    throw new Error("SCRAPER_API_KEY is required");
  }
  return key;
}

/**
 * Fetch HTML content using ScraperAPI
 */
export async function fetchWithScraperAPI(
  url: string,
  options?: FetchWithScraperAPIOptions,
): Promise<string> {
  const guarded = await guardUrl(url);
  const render: boolean = options?.render === true;
  const params = new URLSearchParams({
    api_key: getScraperApiKey(),
    url: guarded.url.toString(),
  });
  if (options?.outputFormat) {
    params.set("output_format", options.outputFormat);
  }
  if (render) {
    params.set("render", "true");
    if (options?.deviceType) {
      params.set("device_type", options.deviceType);
    }
  }
  const scraperUrl = `${SCRAPER_API_URL}/?${params.toString()}`;

  console.log(
    `Fetching URL via ScraperAPI (${[
      options?.outputFormat ?? "html",
      render ? "render=true" : "no render",
      options?.deviceType ? `device=${options.deviceType}` : null,
    ]
      .filter(Boolean)
      .join(", ")}): ${guarded.url.origin}`,
  );
  const response = await fetch(scraperUrl);

  if (!response.ok) {
    throw new Error(
      `ScraperAPI failed: ${response.status} ${response.statusText}`
    );
  }

  const html = await readBoundedResponseText(response as unknown as Response, 5 * 1024 * 1024);
  return html;
}

export async function scrapeWebsite(url: string): Promise<ScrapeWebsiteResult> {
  let browser: Browser | null = null;

  try {
    // Fetch HTML using ScraperAPI
    const htmlContent = await fetchWithScraperAPI(url);

    browser = await launchStealthBrowser();
    const page = await browser.newPage();

    await page.setContent(htmlContent, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate((requestedUrl) => {
      const metaTags = Array.from(document.querySelectorAll("meta")).map(
        (m) => ({
          name: m.getAttribute("name") || m.getAttribute("property"),
          content: m.getAttribute("content"),
        })
      );

      const headers: any = {};
      ["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
        headers[tag] = Array.from(document.querySelectorAll(tag)).map(
          (h) => h.textContent?.trim() || ""
        );
      });

      const canonical =
        document.querySelector("link[rel='canonical']")?.getAttribute("href") ||
        null;

      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        href: a.href,
        text: a.textContent?.trim() || "",
        rel: a.rel || "",
      }));

      const scripts = Array.from(document.querySelectorAll("script")).map(
        (s) => ({
          src: s.getAttribute("src"),
          type: s.getAttribute("type"),
          jsonLD:
            s.type === "application/ld+json" ? s.textContent?.trim() : null,
        })
      );

      const bodyText = document.body.innerText || "";
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

      return {
        title: document.title,
        metaTags,
        headers,
        canonical,
        links,
        scripts,
        wordCount,
        bodyText: bodyText.slice(0, 7000), // truncate to 7k chars for token control
        source: "scraperapi" as const,
        finalUrl: requestedUrl,
      };
    }, url);

    return data;
  } catch (error) {
    console.error(
      "Error scraping with ScraperAPI, falling back to direct puppeteer:",
      error
    );

    if (!browser) {
      browser = await launchStealthBrowser();
    }
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "networkidle2" });

    const data = await page.evaluate(() => {
      const metaTags = Array.from(document.querySelectorAll("meta")).map(
        (m) => ({
          name: m.getAttribute("name") || m.getAttribute("property"),
          content: m.getAttribute("content"),
        })
      );

      const headers: any = {};
      ["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
        headers[tag] = Array.from(document.querySelectorAll(tag)).map(
          (h) => h.textContent?.trim() || ""
        );
      });

      const canonical =
        document.querySelector("link[rel='canonical']")?.getAttribute("href") ||
        null;

      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        href: a.href,
        text: a.textContent?.trim() || "",
        rel: a.rel || "",
      }));

      const scripts = Array.from(document.querySelectorAll("script")).map(
        (s) => ({
          src: s.getAttribute("src"),
          type: s.getAttribute("type"),
          jsonLD:
            s.type === "application/ld+json" ? s.textContent?.trim() : null,
        })
      );

      const bodyText = document.body.innerText || "";
      const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

      return {
        title: document.title,
        metaTags,
        headers,
        canonical,
        links,
        scripts,
        wordCount,
        bodyText: bodyText.slice(0, 7000), // truncate to 7k chars for token control
        source: "puppeteer" as const,
        finalUrl: window.location.href,
      };
    });

    return data;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function scrapeWebsiteUrl(url: string) {
  let browser: Browser | null = null;

  try {
    // Fetch HTML using ScraperAPI
    const htmlContent = await fetchWithScraperAPI(url);

    browser = await launchStealthBrowser();
    const page = await browser.newPage();

    await page.setContent(htmlContent, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        href: a.href,
        text: a.textContent?.trim() || "",
        rel: a.rel || "",
      }));

      return {
        links,
      };
    });

    return data;
  } catch (error) {
    console.error(
      "Error scraping with ScraperAPI, falling back to direct puppeteer:",
      error
    );

    if (!browser) {
      browser = await launchStealthBrowser();
    }
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "networkidle2" });

    const data = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        href: a.href,
        text: a.textContent?.trim() || "",
        rel: a.rel || "",
      }));

      return {
        links,
      };
    });

    return data;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function discoverSitemapUrl(websiteUrl: string): Promise<string | null> {
  try {
    const url = new URL(websiteUrl);
    const baseUrl = `${url.protocol}//${url.host}`;

    const commonSitemapPaths = [
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
      "/sitemap1.xml",
      "/sitemap/sitemap.xml",
      "/wp-sitemap.xml",
    ];

    for (const path of commonSitemapPaths) {
      try {
        const sitemapUrl = `${baseUrl}${path}`;
        const res = await safeFetch(sitemapUrl, {
          method: "HEAD",
        }, { timeoutMs: 5000, maxRedirects: 3 });

        if (res.ok) {
          const contentType = res.headers.get("content-type");
          if (contentType?.includes("xml") || contentType?.includes("text")) {
            const fullRes = await safeFetch(
              sitemapUrl,
              {},
              { timeoutMs: 5000, maxRedirects: 3 },
            );
            const text = await readBoundedResponseText(fullRes, MAX_SITEMAP_BYTES);
            if (
              text.includes("<?xml") &&
              (text.includes("sitemap") || text.includes("urlset"))
            ) {
              console.log(`✅ Found sitemap at: ${sitemapUrl}`);
              return sitemapUrl;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }

    try {
      const robotsUrl = `${baseUrl}/robots.txt`;
      const robotsRes = await safeFetch(
        robotsUrl,
        {},
        { timeoutMs: 5000, maxRedirects: 3 },
      );

      if (robotsRes.ok) {
        const robotsText = await readBoundedResponseText(robotsRes, MAX_ROBOTS_BYTES);
        const sitemapLines = robotsText
          .split("\n")
          .filter((line) => line.toLowerCase().startsWith("sitemap:"))
          .map((line) => {
            const parts = line.split(":");
            return parts.slice(1).join(":").trim();
          })
          .filter(Boolean);

        for (const sitemapUrl of sitemapLines) {
          try {
            const res = await safeFetch(sitemapUrl, {
              method: "HEAD",
            }, { timeoutMs: 5000, maxRedirects: 3 });

            if (res.ok) {
              const contentType = res.headers.get("content-type");
              if (contentType?.includes("xml") || contentType?.includes("text")) {
                const fullRes = await safeFetch(
                  sitemapUrl,
                  {},
                  { timeoutMs: 5000, maxRedirects: 3 },
                );
                const text = await readBoundedResponseText(fullRes, MAX_SITEMAP_BYTES);
                if (
                  text.includes("<?xml") &&
                  (text.includes("sitemap") || text.includes("urlset"))
                ) {
                  console.log(`✅ Found sitemap in robots.txt: ${sitemapUrl}`);
                  return sitemapUrl;
                }
              }
            }
          } catch (error) {
            continue;
          }
        }
      }
    } catch (error) {
      console.log("Could not fetch robots.txt:", error);
    }

    return null;
  } catch (error) {
    console.error("Error discovering sitemap:", error);
    return null;
  }
}

/**
 * Maximum depth `fetchSitemapUrls` will recurse into nested sitemap-index
 * files. Real-world sitemaps rarely exceed 2 levels; 5 gives headroom
 * while still preventing pathological/cyclic sitemaps from hanging the
 * process.
 */
const MAX_SITEMAP_DEPTH = 5;

/**
 * Minimal HTTP client signature accepted by fetchSitemapUrls' _fetch hook.
 * Narrower than the global `typeof fetch` so tests can pass any function
 * with the `(url) => Promise<Response>` shape without needing to also
 * shim static helpers like `fetch.preconnect`.
 */
type SitemapFetcher = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type FetchSitemapUrlsOptions = {
  /** Internal — current recursion depth. Callers should not set this. */
  _depth?: number;
  /** Internal — set of already-visited sitemap URLs (cycle detection). */
  _visited?: Set<string>;
  /**
   * Internal — dependency-injection hook for the HTTP client, used by
   * unit tests to avoid real network traffic. Callers should not set this.
   * Defaults to the global `fetch`.
   */
  _fetch?: SitemapFetcher;
};

/**
 * Fetch all page URLs from a sitemap (or sitemap index), recursing into
 * nested sitemap-index files up to {@link MAX_SITEMAP_DEPTH} levels deep.
 *
 * Safety features:
 *  - Cycle detection via a visited-URL Set (shared across the recursive call).
 *  - Per-child try/catch so one malformed child sitemap can't kill the
 *    whole crawl; the child's URLs are dropped but the rest of the
 *    sitemap-index is still returned.
 *  - Depth limit to prevent pathological sitemap trees.
 *  - Output URLs are deduplicated (Set-backed) so the same URL appearing
 *    in multiple child sitemaps is only returned once.
 *
 * A top-level fetch failure is still a hard error (existing callers rely
 * on this), but child-level failures are logged and swallowed.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: FetchSitemapUrlsOptions = {},
): Promise<string[]> {
  const depth = options._depth ?? 0;
  const visited = options._visited ?? new Set<string>();
  const fetchFn: SitemapFetcher =
    options._fetch ?? ((url, init) =>
      safeFetch(String(url), init, {
        timeoutMs: 10_000,
        maxRedirects: 3,
      }));

  if (depth >= MAX_SITEMAP_DEPTH) {
    console.warn(
      `[fetchSitemapUrls] max depth ${MAX_SITEMAP_DEPTH} reached; skipping ${sitemapUrl}`,
    );
    return [];
  }
  if (visited.size >= MAX_SITEMAP_FILES) {
    console.warn("[fetchSitemapUrls] sitemap file limit reached");
    return [];
  }
  if (visited.has(sitemapUrl)) {
    // Cycle in sitemap index — already crawled this URL.
    return [];
  }
  visited.add(sitemapUrl);

  const res = await fetchFn(sitemapUrl);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await readBoundedResponseText(res, MAX_SITEMAP_BYTES);

  const parser = new XMLParser();
  const parsed = parser.parse(xml);

  const dedup = new Set<string>();

  if (parsed.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    for (const s of sitemaps.slice(0, MAX_SITEMAP_FILES)) {
      if (!s?.loc) continue;
      try {
        const childUrls = await fetchSitemapUrls(s.loc, {
          _depth: depth + 1,
          _visited: visited,
          _fetch: fetchFn,
        });
        for (const u of childUrls) {
          if (dedup.size >= MAX_SITEMAP_URLS) break;
          dedup.add(u);
        }
      } catch (err: any) {
        console.warn(
          `[fetchSitemapUrls] child sitemap failed, skipping ${s.loc}: ${err?.message ?? err}`,
        );
      }
    }
  } else if (parsed.urlset?.url) {
    const urlEntries = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];
    for (const u of urlEntries.slice(0, MAX_SITEMAP_URLS)) {
      if (u?.loc && typeof u.loc === "string") dedup.add(u.loc.slice(0, 2048));
    }
  }

  return Array.from(dedup);
}
