import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Mocks ----
const fetchDomainRankMock = mock(
  async (_domain: string): Promise<{ rank?: number } | null> => null,
);

mock.module("../utils/dataforseo-backlinks.utils", () => ({
  fetchDomainRankFromDataForSEO: fetchDomainRankMock,
}));

// Fresh in-memory cache per test.
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
    throw new Error("not used");
  },
}));

let service: typeof import("../services/competitor-authority.service");

beforeAll(async () => {
  service = await import("../services/competitor-authority.service");
});

beforeEach(() => {
  fetchDomainRankMock.mockReset();
  fetchDomainRankMock.mockImplementation(async () => null);
  cacheStore = new Map();
});

describe("getDomainAuthority", () => {
  it("returns the DataForSEO rank", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 750 }));
    expect(await service.getDomainAuthority("wikipedia.org")).toBe(750);
  });

  it("caches — second call for the same domain skips the API", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 500 }));
    await service.getDomainAuthority("example.com");
    await service.getDomainAuthority("example.com");
    expect(fetchDomainRankMock).toHaveBeenCalledTimes(1);
  });

  it("caches negative results too (unknown domain doesn't retry on every call)", async () => {
    fetchDomainRankMock.mockImplementation(async () => null);
    await service.getDomainAuthority("unknown.xyz");
    await service.getDomainAuthority("unknown.xyz");
    expect(fetchDomainRankMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on fetch failure", async () => {
    fetchDomainRankMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect(await service.getDomainAuthority("flaky.com")).toBeNull();
  });

  it("rescales domain_authority (Moz 0-100) to 0-1000 if rank absent", async () => {
    fetchDomainRankMock.mockImplementation(
      async () => ({ domain_authority: 60 }) as any,
    );
    expect(await service.getDomainAuthority("mozlike.com")).toBe(600);
  });
});

describe("getBulkDomainAuthorities", () => {
  it("returns a map keyed by normalized domain", async () => {
    fetchDomainRankMock.mockImplementation(async (domain: string) =>
      domain === "authority.com" ? { rank: 700 } : null,
    );
    const out = await service.getBulkDomainAuthorities([
      "authority.com",
      "unknown.com",
    ]);
    expect(out.get("authority.com")).toBe(700);
    expect(out.get("unknown.com")).toBeNull();
  });

  it("deduplicates input before hitting the API", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 500 }));
    await service.getBulkDomainAuthorities([
      "dup.com",
      "dup.com",
      "DUP.COM",
    ]);
    expect(fetchDomainRankMock).toHaveBeenCalledTimes(1);
  });
});

describe("computeAuthorityWeightedDifficulty", () => {
  it("treats 2 authorities (rank=700) as MEDIUM via weight sum 4", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 700 }));
    const result = await service.computeAuthorityWeightedDifficulty([
      "wiki.example",
      "yelp.example",
    ]);
    expect(result).toBe("MEDIUM");
  });

  it("treats 4 weak/unknown (weight 0.5 each → total 2) as MEDIUM boundary", async () => {
    fetchDomainRankMock.mockImplementation(async () => null);
    const result = await service.computeAuthorityWeightedDifficulty([
      "a.example",
      "b.example",
      "c.example",
      "d.example",
    ]);
    // 4 × 0.5 = 2 → MEDIUM (threshold is `< 2` for EASY)
    expect(result).toBe("MEDIUM");
  });

  it("treats 3 authorities (weight 6) as HARD", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 900 }));
    const result = await service.computeAuthorityWeightedDifficulty([
      "wiki.example",
      "yelp.example",
      "angi.example",
    ]);
    expect(result).toBe("HARD");
  });

  it("1 authority alone (weight 2) → MEDIUM (not EASY)", async () => {
    fetchDomainRankMock.mockImplementation(async () => ({ rank: 800 }));
    const result = await service.computeAuthorityWeightedDifficulty([
      "wiki.example",
    ]);
    // Weight sum = 2.0; threshold EASY is strictly < 2 → MEDIUM.
    expect(result).toBe("MEDIUM");
  });

  it("empty list → EASY", async () => {
    const result = await service.computeAuthorityWeightedDifficulty([]);
    expect(result).toBe("EASY");
  });
});
