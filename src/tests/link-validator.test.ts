import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- axios mock ----
// Must be installed BEFORE the module under test is imported.
const headMock = mock(async (_url: string, _cfg?: unknown) => ({ status: 200 }));
const getMock = mock(async (_url: string, _cfg?: unknown) => ({
  status: 200,
  data: { destroy: () => {} },
}));

mock.module("axios", () => ({
  default: {
    head: headMock,
    get: getMock,
  },
  head: headMock,
  get: getMock,
}));

// Fresh cache per test: re-mock the cache module with a per-test Map.
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
    throw new Error("withCache not used by link-validator in tests");
  },
}));

// Import under test — after mocks.
let isUrlAlive: typeof import("../utils/link-validator").isUrlAlive;
let filterAliveUrls: typeof import("../utils/link-validator").filterAliveUrls;
let partitionAliveUrls: typeof import("../utils/link-validator").partitionAliveUrls;

beforeAll(async () => {
  ({ isUrlAlive, filterAliveUrls, partitionAliveUrls } = await import(
    "../utils/link-validator"
  ));
});

beforeEach(() => {
  headMock.mockReset();
  getMock.mockReset();
  cacheStore = new Map();
  // Re-install the store-clearing getCached closure captures live `cacheStore`
  // — but the factory above used the binding, so reassign isn't enough.
  // Workaround: reset module-level state by clearing inline.
});

// --- helpers ---
let nextUrlId = 0;
const uniqueUrl = () =>
  `https://example.com/alive-test-${Date.now()}-${nextUrlId++}`;

describe("isUrlAlive — status handling", () => {
  it("1. HEAD 200 => true (no GET fallback)", async () => {
    headMock.mockImplementation(async () => ({ status: 200 }));
    const url = uniqueUrl();

    expect(await isUrlAlive(url)).toBe(true);
    expect(headMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("2. HEAD 301 => true (redirects handled by axios maxRedirects)", async () => {
    headMock.mockImplementation(async () => ({ status: 301 }));
    // note: axios' maxRedirects would normally resolve to final status; we're
    // testing that any 3xx-class final status is treated as alive.
    expect(await isUrlAlive(uniqueUrl())).toBe(true);
  });

  it("3. HEAD 404 => false (no GET fallback)", async () => {
    headMock.mockImplementation(async () => ({ status: 404 }));
    const url = uniqueUrl();

    expect(await isUrlAlive(url)).toBe(false);
    expect(headMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("4. HEAD 410 => false", async () => {
    headMock.mockImplementation(async () => ({ status: 410 }));
    expect(await isUrlAlive(uniqueUrl())).toBe(false);
  });

  it("5. HEAD 405 => GET 200 => true", async () => {
    headMock.mockImplementation(async () => ({ status: 405 }));
    getMock.mockImplementation(async () => ({
      status: 200,
      data: { destroy: () => {} },
    }));

    expect(await isUrlAlive(uniqueUrl())).toBe(true);
    expect(headMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("6. HEAD 403 => GET 200 => true (Cloudflare-style bot protection)", async () => {
    headMock.mockImplementation(async () => ({ status: 403 }));
    getMock.mockImplementation(async () => ({
      status: 200,
      data: { destroy: () => {} },
    }));

    expect(await isUrlAlive(uniqueUrl())).toBe(true);
  });

  it("7. HEAD 503 => GET 503 => false", async () => {
    headMock.mockImplementation(async () => ({ status: 503 }));
    getMock.mockImplementation(async () => ({
      status: 503,
      data: { destroy: () => {} },
    }));

    expect(await isUrlAlive(uniqueUrl())).toBe(false);
  });

  it("8. HEAD throws (timeout/network) => false", async () => {
    headMock.mockImplementation(async () => {
      throw new Error("ETIMEDOUT");
    });

    expect(await isUrlAlive(uniqueUrl())).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("9. HEAD 403, GET throws => false", async () => {
    headMock.mockImplementation(async () => ({ status: 403 }));
    getMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });

    expect(await isUrlAlive(uniqueUrl())).toBe(false);
  });

  it("10. Invalid URL string => false, no HTTP call", async () => {
    expect(await isUrlAlive("not a url")).toBe(false);
    expect(headMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("closes the GET response stream to free sockets", async () => {
    let destroyCalls = 0;
    headMock.mockImplementation(async () => ({ status: 405 }));
    getMock.mockImplementation(async () => ({
      status: 200,
      data: {
        destroy: () => {
          destroyCalls++;
        },
      },
    }));

    await isUrlAlive(uniqueUrl());
    expect(destroyCalls).toBe(1);
  });
});

describe("isUrlAlive — caching", () => {
  it("11. Cache hit (positive): axios.head called once across two calls", async () => {
    headMock.mockImplementation(async () => ({ status: 200 }));
    const url = uniqueUrl();

    const first = await isUrlAlive(url);
    const second = await isUrlAlive(url);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(headMock).toHaveBeenCalledTimes(1);
  });

  it("12. Cache hit (negative): 404 second call returns false with no new HTTP", async () => {
    headMock.mockImplementation(async () => ({ status: 404 }));
    const url = uniqueUrl();

    const first = await isUrlAlive(url);
    const second = await isUrlAlive(url);

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(headMock).toHaveBeenCalledTimes(1);
  });
});

describe("filterAliveUrls", () => {
  it("13. Preserves original order, drops dead items", async () => {
    // Items at indexes 0, 2, 4 are alive; 1 and 3 are dead.
    const items = [
      { url: "https://ok.example.com/a" },
      { url: "https://bad.example.com/b" },
      { url: "https://ok.example.com/c" },
      { url: "https://bad.example.com/d" },
      { url: "https://ok.example.com/e" },
    ];

    headMock.mockImplementation(async (url: string) =>
      url.includes("ok.example.com") ? { status: 200 } : { status: 404 },
    );

    const out = await filterAliveUrls(items);
    expect(out.map((i) => i.url)).toEqual([
      "https://ok.example.com/a",
      "https://ok.example.com/c",
      "https://ok.example.com/e",
    ]);
  });

  it("14. Respects concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;

    headMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { status: 200 };
    });

    const items = Array.from({ length: 20 }, (_, i) => ({
      url: `https://example.com/c${i}-${Date.now()}`,
    }));

    await filterAliveUrls(items, 4);

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });

  it("15. One failing probe does not abort the batch", async () => {
    const items = [
      { url: "https://ok.example.com/a" },
      { url: "https://throws.example.com/b" },
      { url: "https://ok.example.com/c" },
    ];

    headMock.mockImplementation(async (url: string) => {
      if (url.includes("throws.example.com")) throw new Error("boom");
      return { status: 200 };
    });

    const out = await filterAliveUrls(items);
    expect(out.map((i) => i.url)).toEqual([
      "https://ok.example.com/a",
      "https://ok.example.com/c",
    ]);
  });

  it("returns [] for empty input without any HTTP calls", async () => {
    const out = await filterAliveUrls([]);
    expect(out).toEqual([]);
    expect(headMock).not.toHaveBeenCalled();
  });
});

describe("partitionAliveUrls", () => {
  it("splits items into alive and dead buckets preserving order", async () => {
    const items = [
      { url: "https://ok.example.com/a", id: 1 },
      { url: "https://bad.example.com/b", id: 2 },
      { url: "https://ok.example.com/c", id: 3 },
      { url: "https://bad.example.com/d", id: 4 },
    ];
    headMock.mockImplementation(async (url: string) =>
      url.includes("ok.example.com") ? { status: 200 } : { status: 404 },
    );

    const { alive, dead } = await partitionAliveUrls(items);

    expect(alive.map((i) => i.id)).toEqual([1, 3]);
    expect(dead.map((i) => i.id)).toEqual([2, 4]);
  });

  it("empty input => empty partitions, no HTTP calls", async () => {
    const { alive, dead } = await partitionAliveUrls([]);
    expect(alive).toEqual([]);
    expect(dead).toEqual([]);
    expect(headMock).not.toHaveBeenCalled();
  });

  it("all dead", async () => {
    headMock.mockImplementation(async () => ({ status: 404 }));
    const items = [
      { url: "https://a.example.com/1" },
      { url: "https://a.example.com/2" },
    ];
    const { alive, dead } = await partitionAliveUrls(items);
    expect(alive).toEqual([]);
    expect(dead.length).toBe(2);
  });

  it("all alive", async () => {
    headMock.mockImplementation(async () => ({ status: 200 }));
    const items = [
      { url: "https://a.example.com/alive-1" },
      { url: "https://a.example.com/alive-2" },
    ];
    const { alive, dead } = await partitionAliveUrls(items);
    expect(alive.length).toBe(2);
    expect(dead).toEqual([]);
  });

  it("preserves extra fields on each item (metadata passthrough)", async () => {
    headMock.mockImplementation(async (url: string) =>
      url.endsWith("/dead") ? { status: 404 } : { status: 200 },
    );
    const items = [
      { url: "https://a.example.com/alive", _vectorId: "v1", _ns: "blogs" },
      { url: "https://a.example.com/dead", _vectorId: "v2", _ns: "sitemaps" },
    ];
    const { alive, dead } = await partitionAliveUrls(items);
    expect(alive[0]!._vectorId).toBe("v1");
    expect(dead[0]!._vectorId).toBe("v2");
    expect(dead[0]!._ns).toBe("sitemaps");
  });
});
