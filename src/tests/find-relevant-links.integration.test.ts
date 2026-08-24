import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Fixture: Pinecone query + delete controller ----
// Each test sets `pineconeMatchesByNamespace` to control what `.query()` returns.
type PineconeMatch = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
};

let pineconeMatchesByNamespace: Record<string, PineconeMatch[]> = {
  blogs: [],
  sitemaps: [],
};

// Captured per-namespace deleteMany calls — one entry per call.
let deleteCalls: Array<{ namespace: string; ids: string[] }> = [];

// Signal for triggering a Pinecone delete failure (used by one test).
let deleteShouldThrow = false;

mock.module("@pinecone-database/pinecone", () => ({
  Pinecone: class {
    constructor(_opts: unknown) {}
    index(_name: string) {
      return {
        namespace(ns: string) {
          return {
            query: async (_req: unknown) => ({
              matches: pineconeMatchesByNamespace[ns] ?? [],
            }),
            deleteMany: async (opts: { ids?: string[] }) => {
              if (deleteShouldThrow) throw new Error("simulated pinecone 500");
              deleteCalls.push({ namespace: ns, ids: opts.ids ?? [] });
            },
          };
        },
      };
    }
  },
}));

// ---- OpenAI embedding mock ----
mock.module("openai", () => ({
  default: class {
    constructor(_opts: unknown) {}
    embeddings = {
      create: async () => ({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    };
  },
}));

// ---- axios mock (drives the URL validator) ----
const headMock = mock(async (_url: string) => ({ status: 200 }));
const getMock = mock(async (_url: string) => ({
  status: 200,
  data: { destroy: () => {} },
}));
mock.module("axios", () => ({
  default: { head: headMock, get: getMock },
  head: headMock,
  get: getMock,
}));

// ---- Cache mock: fresh map each test so cached decisions don't leak ----
let cacheStore = new Map<string, { data: unknown; expiresAt: number }>();
mock.module("../utils/dataforseo-cache", () => ({
  getCached: <T,>(key: string): T | null => {
    const entry = cacheStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cacheStore.delete(key);
      return null;
    }
    return entry.data as T;
  },
  setCache: <T,>(key: string, data: T, ttlMs: number): void => {
    cacheStore.set(key, { data, expiresAt: Date.now() + ttlMs });
  },
  withCache: async () => {
    throw new Error("withCache unused in these tests");
  },
}));

let findRelevantLinks: typeof import("../config/pinecone.config").findRelevantLinks;
let findRelevantLinksWithClusterBoost: typeof import("../config/pinecone.config").findRelevantLinksWithClusterBoost;

beforeAll(async () => {
  ({ findRelevantLinks, findRelevantLinksWithClusterBoost } = await import(
    "../config/pinecone.config"
  ));
});

beforeEach(() => {
  headMock.mockReset();
  getMock.mockReset();
  cacheStore = new Map();
  pineconeMatchesByNamespace = { blogs: [], sitemaps: [] };
  deleteCalls = [];
  deleteShouldThrow = false;
});

// findRelevantLinks kicks off Pinecone delete via `void` (fire-and-forget).
// Tests must yield to the event loop so those deletes resolve before assertions.
const flushPromises = () => new Promise((r) => setImmediate(r));

// --- helper to build Pinecone-like matches ---
const match = (
  url: string,
  score: number,
  opts: { title?: string; businessId?: string; blogId?: string } = {},
): PineconeMatch => ({
  id: url,
  score,
  metadata: {
    url,
    title: opts.title ?? `Title for ${url}`,
    business_id: opts.businessId ?? "biz-123",
    blog_id: opts.blogId ?? `blog-${url}`,
  },
});

const payload = {
  title: "Test Blog",
  content: "Lorem ipsum about SEO and content marketing.",
  tags: [],
  categories: [],
  seoDescription: "",
  userId: "user-1",
  businessId: "biz-123",
  url: "",
};

describe("findRelevantLinks — dead URL filtering", () => {
  it("16. 8 candidates, 3 dead => returns only the 5 live URLs", async () => {
    pineconeMatchesByNamespace.blogs = [
      match("https://ok.example.com/a", 0.95),
      match("https://dead.example.com/b", 0.9),
      match("https://ok.example.com/c", 0.85),
      match("https://dead.example.com/d", 0.8),
    ];
    pineconeMatchesByNamespace.sitemaps = [
      match("https://ok.example.com/e", 0.75),
      match("https://ok.example.com/f", 0.7),
      match("https://dead.example.com/g", 0.65),
      match("https://ok.example.com/h", 0.6),
    ];

    headMock.mockImplementation(async (url: string) =>
      url.includes("dead.example.com") ? { status: 404 } : { status: 200 },
    );

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );

    const urls = result.map((r) => r.url);
    expect(urls).not.toContain("https://dead.example.com/b");
    expect(urls).not.toContain("https://dead.example.com/d");
    expect(urls).not.toContain("https://dead.example.com/g");
    expect(urls.length).toBe(5);
    // Sorted by descending score
    expect(result[0]!.score).toBeGreaterThanOrEqual(result[1]!.score ?? 0);
  });

  it("17. All 8 dead => returns empty array", async () => {
    pineconeMatchesByNamespace.blogs = [
      match("https://dead.example.com/1", 0.95),
      match("https://dead.example.com/2", 0.9),
      match("https://dead.example.com/3", 0.85),
      match("https://dead.example.com/4", 0.8),
    ];
    pineconeMatchesByNamespace.sitemaps = [
      match("https://dead.example.com/5", 0.75),
      match("https://dead.example.com/6", 0.7),
      match("https://dead.example.com/7", 0.65),
      match("https://dead.example.com/8", 0.6),
    ];

    headMock.mockImplementation(async () => ({ status: 404 }));

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );

    expect(result).toEqual([]);
  });

  it("18. All 8 live => returns up to 10 combined, sorted by score", async () => {
    pineconeMatchesByNamespace.blogs = Array.from({ length: 4 }, (_, i) =>
      match(`https://ok.example.com/b${i}`, 0.9 - i * 0.1),
    );
    pineconeMatchesByNamespace.sitemaps = Array.from({ length: 4 }, (_, i) =>
      match(`https://ok.example.com/s${i}`, 0.5 - i * 0.05),
    );

    headMock.mockImplementation(async () => ({ status: 200 }));

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );

    expect(result.length).toBe(8);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score ?? 0).toBeGreaterThanOrEqual(
        result[i]!.score ?? 0,
      );
    }
  });

  it("19. Validation runs for EXTERNAL scope too", async () => {
    pineconeMatchesByNamespace.blogs = [
      match("https://ok.example.com/x", 0.9, { businessId: "biz-other" }),
      match("https://dead.example.com/y", 0.8, { businessId: "biz-other" }),
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async (url: string) =>
      url.includes("dead.example.com") ? { status: 404 } : { status: 200 },
    );

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-123",
      payload,
      "EXTERNAL",
    );

    const urls = result.map((r) => r.url);
    expect(urls).toContain("https://ok.example.com/x");
    expect(urls).not.toContain("https://dead.example.com/y");
  });

  it("20. findRelevantLinksWithClusterBoost inherits validation", async () => {
    pineconeMatchesByNamespace.blogs = [
      match("https://ok.example.com/k", 0.9),
      match("https://dead.example.com/k2", 0.85),
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async (url: string) =>
      url.includes("dead.example.com") ? { status: 404 } : { status: 200 },
    );

    // No clusterId + INTERNAL scope: the function forwards to findRelevantLinks
    // unchanged, but still benefits from validation applied inside the base fn.
    const result = await findRelevantLinksWithClusterBoost(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
      null,
    );

    const urls = result.map((r) => r.url);
    expect(urls).toContain("https://ok.example.com/k");
    expect(urls).not.toContain("https://dead.example.com/k2");
  });

  it("21. Dead URLs trigger deleteMany on Pinecone per-namespace", async () => {
    pineconeMatchesByNamespace.blogs = [
      { ...match("https://ok.example.com/a", 0.9), id: "blog-vec-1" },
      { ...match("https://dead.example.com/b", 0.85), id: "blog-vec-2" },
    ];
    pineconeMatchesByNamespace.sitemaps = [
      { ...match("https://ok.example.com/c", 0.7), id: "sitemap-vec-1" },
      { ...match("https://dead.example.com/d", 0.6), id: "sitemap-vec-2" },
      { ...match("https://dead.example.com/e", 0.55), id: "sitemap-vec-3" },
    ];

    headMock.mockImplementation(async (url: string) =>
      url.includes("dead.example.com") ? { status: 404 } : { status: 200 },
    );

    await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );
    await flushPromises();

    // Exactly one delete call per namespace that had dead items.
    const blogCall = deleteCalls.find((c) => c.namespace === "blogs");
    const sitemapCall = deleteCalls.find((c) => c.namespace === "sitemaps");

    expect(blogCall).toBeDefined();
    expect(blogCall!.ids).toEqual(["blog-vec-2"]);

    expect(sitemapCall).toBeDefined();
    expect(sitemapCall!.ids.sort()).toEqual(
      ["sitemap-vec-2", "sitemap-vec-3"].sort(),
    );
  });

  it("22. No dead URLs => deleteMany is never called", async () => {
    pineconeMatchesByNamespace.blogs = [
      { ...match("https://ok.example.com/a", 0.9), id: "blog-vec-1" },
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async () => ({ status: 200 }));

    await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );
    await flushPromises();

    expect(deleteCalls.length).toBe(0);
  });

  it("23. Delete failure does NOT break blog generation", async () => {
    pineconeMatchesByNamespace.blogs = [
      { ...match("https://ok.example.com/a", 0.9), id: "blog-vec-1" },
      { ...match("https://dead.example.com/b", 0.85), id: "blog-vec-2" },
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async (url: string) =>
      url.includes("dead.example.com") ? { status: 404 } : { status: 200 },
    );
    deleteShouldThrow = true;

    // Must resolve normally with the live link, even though delete throws.
    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );
    await flushPromises();

    expect(result.map((r) => r.url)).toEqual(["https://ok.example.com/a"]);
  });

  it("24. Returned candidates do not leak _vectorId / _namespace fields", async () => {
    pineconeMatchesByNamespace.blogs = [
      { ...match("https://ok.example.com/a", 0.9), id: "blog-vec-1" },
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async () => ({ status: 200 }));

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );

    expect(result[0]).toEqual({
      title: expect.any(String),
      url: "https://ok.example.com/a",
      businessId: expect.any(String),
      score: expect.any(Number),
    });
  });

  it("HEAD-blocked pages fall back to GET (e.g. Cloudflare 403)", async () => {
    pineconeMatchesByNamespace.blogs = [
      match("https://cf.example.com/bot-blocked", 0.9),
    ];
    pineconeMatchesByNamespace.sitemaps = [];

    headMock.mockImplementation(async () => ({ status: 403 }));
    getMock.mockImplementation(async () => ({
      status: 200,
      data: { destroy: () => {} },
    }));

    const result = await findRelevantLinks(
      "new-blog-id",
      "biz-other",
      payload,
      "INTERNAL",
    );

    expect(result.map((r) => r.url)).toContain(
      "https://cf.example.com/bot-blocked",
    );
  });
});
