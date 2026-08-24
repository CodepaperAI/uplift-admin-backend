import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

// ---- Fake fetcher (injected via fetchSitemapUrls' _fetch option) ----
// Each test sets `responses` — a Map<url, { status, body }> — to drive
// the fake fetcher. Unknown URLs return 404. The fetcher is passed into
// fetchSitemapUrls directly so tests never touch the network.
type FakeResponse = { status: number; body: string };
let responses = new Map<string, FakeResponse>();
let fetchCalls: string[] = [];

const fakeFetch = async (
  url: string | URL | Request,
): Promise<Response> => {
  const urlStr = typeof url === "string" ? url : url.toString();
  fetchCalls.push(urlStr);
  const r = responses.get(urlStr);
  if (!r) return new Response("not found", { status: 404 });
  return new Response(r.body, { status: r.status });
};

let fetchSitemapUrls: typeof import("../utils/tools.utils").fetchSitemapUrls;

beforeAll(async () => {
  ({ fetchSitemapUrls } = await import("../utils/tools.utils"));
});

beforeEach(() => {
  responses = new Map();
  fetchCalls = [];
});

/** Invoke fetchSitemapUrls with the fake fetcher injected. */
const callFetchSitemap = (url: string) =>
  fetchSitemapUrls(url, { _fetch: fakeFetch });

function urlsetXml(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join("")}</urlset>`;
}

function sitemapIndexXml(childUrls: string[]): string {
  return `<?xml version="1.0"?><sitemapindex>${childUrls
    .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
}

describe("fetchSitemapUrls — multi-sitemap index", () => {
  it("recurses into a single-level sitemap index", async () => {
    responses.set("https://ex.test/sitemap.xml", {
      status: 200,
      body: sitemapIndexXml([
        "https://ex.test/posts-sitemap.xml",
        "https://ex.test/pages-sitemap.xml",
      ]),
    });
    responses.set("https://ex.test/posts-sitemap.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/post-1", "https://ex.test/post-2"]),
    });
    responses.set("https://ex.test/pages-sitemap.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/about", "https://ex.test/contact"]),
    });

    const out = await callFetchSitemap("https://ex.test/sitemap.xml");
    expect(out.sort()).toEqual(
      [
        "https://ex.test/post-1",
        "https://ex.test/post-2",
        "https://ex.test/about",
        "https://ex.test/contact",
      ].sort(),
    );
  });

  it("deduplicates URLs that appear in multiple child sitemaps", async () => {
    responses.set("https://ex.test/sitemap.xml", {
      status: 200,
      body: sitemapIndexXml([
        "https://ex.test/a.xml",
        "https://ex.test/b.xml",
      ]),
    });
    responses.set("https://ex.test/a.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/shared", "https://ex.test/a-only"]),
    });
    responses.set("https://ex.test/b.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/shared", "https://ex.test/b-only"]),
    });

    const out = await callFetchSitemap("https://ex.test/sitemap.xml");
    expect(out.sort()).toEqual(
      ["https://ex.test/a-only", "https://ex.test/b-only", "https://ex.test/shared"].sort(),
    );
    // /shared should be present exactly once, not twice.
    expect(out.filter((u) => u === "https://ex.test/shared").length).toBe(1);
  });

  it("one malformed child sitemap does not kill the whole crawl", async () => {
    responses.set("https://ex.test/sitemap.xml", {
      status: 200,
      body: sitemapIndexXml([
        "https://ex.test/good.xml",
        "https://ex.test/broken.xml",
      ]),
    });
    responses.set("https://ex.test/good.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/good-page"]),
    });
    // broken.xml returns 500
    responses.set("https://ex.test/broken.xml", {
      status: 500,
      body: "internal server error",
    });

    const out = await callFetchSitemap("https://ex.test/sitemap.xml");
    expect(out).toEqual(["https://ex.test/good-page"]);
  });

  it("detects cycles in sitemap index (A → B → A)", async () => {
    responses.set("https://ex.test/a.xml", {
      status: 200,
      body: sitemapIndexXml(["https://ex.test/b.xml"]),
    });
    responses.set("https://ex.test/b.xml", {
      status: 200,
      body: sitemapIndexXml(["https://ex.test/a.xml"]),
    });

    // Should not hang. Visited-set prevents the cycle.
    const out = await callFetchSitemap("https://ex.test/a.xml");
    expect(out).toEqual([]);
    // a.xml + b.xml = exactly 2 fetches; the cycle must not re-fetch a.xml.
    const unique = new Set(fetchCalls);
    expect(unique.size).toBe(2);
  });

  it("enforces max-depth limit (5 levels)", async () => {
    // 7-level deep sitemap index — should stop at level 5.
    for (let i = 0; i < 7; i++) {
      responses.set(`https://ex.test/level-${i}.xml`, {
        status: 200,
        body: sitemapIndexXml([`https://ex.test/level-${i + 1}.xml`]),
      });
    }
    responses.set("https://ex.test/level-7.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/deep-url"]),
    });

    const out = await callFetchSitemap("https://ex.test/level-0.xml");
    // level-7.xml should not have been fetched (beyond depth 5).
    expect(fetchCalls).not.toContain("https://ex.test/level-7.xml");
    expect(out).toEqual([]);
  });

  it("top-level fetch failure still throws (existing callers rely on this)", async () => {
    // No response registered for this URL → 404 from mock.
    await expect(
      callFetchSitemap("https://ex.test/missing.xml"),
    ).rejects.toThrow(/Failed to fetch sitemap/);
  });

  it("handles flat urlset (no sitemap index) unchanged", async () => {
    responses.set("https://ex.test/sitemap.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/a", "https://ex.test/b"]),
    });
    const out = await callFetchSitemap("https://ex.test/sitemap.xml");
    expect(out.sort()).toEqual(["https://ex.test/a", "https://ex.test/b"].sort());
  });

  it("skips entries with missing <loc> in sitemap index", async () => {
    responses.set("https://ex.test/sitemap.xml", {
      status: 200,
      // Malformed: one sitemap has no <loc>.
      body: `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://ex.test/good.xml</loc></sitemap>
        <sitemap></sitemap>
      </sitemapindex>`,
    });
    responses.set("https://ex.test/good.xml", {
      status: 200,
      body: urlsetXml(["https://ex.test/page"]),
    });
    const out = await callFetchSitemap("https://ex.test/sitemap.xml");
    expect(out).toEqual(["https://ex.test/page"]);
  });
});
