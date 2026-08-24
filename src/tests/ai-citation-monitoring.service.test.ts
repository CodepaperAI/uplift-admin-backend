import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Prisma mock ----
const citationFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);
const businessFindUniqueMock = mock(async (_args: unknown): Promise<any> => ({
  businessWebsiteUrl: "https://example.com",
  businessName: "Example",
}));
const planFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);
const scanCreateMock = mock(async (_args: unknown) => ({ id: "scan-1" }));
const scanUpdateMock = mock(async (_args: unknown) => ({}));
const citationCreateMock = mock(async (_args: unknown) => ({}));
const llmUsageCreateMock = mock(async (_args: unknown) => ({}));

mock.module("../config/db.config", () => ({
  prisma: {
    llmCitation: { findMany: citationFindManyMock, create: citationCreateMock },
    llmCitationScan: { create: scanCreateMock, update: scanUpdateMock },
    business: { findUnique: businessFindUniqueMock },
    plan: { findMany: planFindManyMock },
    llmUsageEvent: { create: llmUsageCreateMock },
  },
}));

// ---- LLM mocks (for runCitationScan path) ----
const llmInvokeMock = mock(async () => ({ content: "no mention" }));
mock.module("../config/llm.config", () => ({
  LLM_MODELS: {
    GPT54_NANO: "gpt-5.4-nano",
  },
  createGPT54NanoModel: () => ({ invoke: llmInvokeMock }),
}));

// ---- Fetch mock for Gemini/Perplexity endpoints ----
const fetchMock = mock(
  async (_url: string, _init?: any): Promise<Response> =>
    new Response(JSON.stringify({}), { status: 500 }),
);
(globalThis as any).fetch = fetchMock;

// ---- Fresh cache per test ----
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
  withCache: async <T,>(
    key: string,
    compute: () => Promise<T>,
    options?: { ttlMs?: number },
  ): Promise<T> => {
    const cached = cacheStore.get(key);
    if (cached && Date.now() <= cached.expiresAt) return cached.data as T;
    const result = await compute();
    cacheStore.set(key, {
      data: result,
      expiresAt: Date.now() + (options?.ttlMs ?? 60_000),
    });
    return result;
  },
}));

// ---- Inngest mock: spy on send ----
const inngestSendMock = mock(async (_ev: unknown) => ({ ids: ["ev1"] }));
mock.module("../inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

let service: typeof import("../services/ai-citation-monitoring.service");

beforeAll(async () => {
  service = await import("../services/ai-citation-monitoring.service");
});

beforeEach(() => {
  citationFindManyMock.mockReset();
  citationFindManyMock.mockImplementation(async () => []);
  businessFindUniqueMock.mockReset();
  businessFindUniqueMock.mockImplementation(async () => ({
    businessWebsiteUrl: "https://example.com",
    businessName: "Example",
    businessType: "Plumber",
    businessDescription: "Example plumbing company.",
    businessCity: "Toronto",
    businessState: "ON",
    businessCountry: "CA",
    selectedServices: ["Drain cleaning", "Leak repair"],
  }));
  planFindManyMock.mockReset();
  planFindManyMock.mockImplementation(async () => []);
  scanCreateMock.mockReset();
  scanCreateMock.mockImplementation(async () => ({ id: "scan-1" }));
  scanUpdateMock.mockReset();
  scanUpdateMock.mockImplementation(async () => ({}));
  citationCreateMock.mockReset();
  citationCreateMock.mockImplementation(async () => ({}));
  llmUsageCreateMock.mockReset();
  llmUsageCreateMock.mockImplementation(async () => ({}));
  llmInvokeMock.mockReset();
  llmInvokeMock.mockImplementation(async () => ({ content: "no mention" }));
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({}), { status: 500 }),
  );
  inngestSendMock.mockReset();
  inngestSendMock.mockImplementation(async () => ({ ids: ["ev1"] }));
  cacheStore = new Map();
});

describe("getCitationContextForKeyword — 1h cache", () => {
  it("second call within TTL hits cache (DB query only fires once)", async () => {
    citationFindManyMock.mockImplementation(async () => []);
    await service.getCitationContextForKeyword("biz-1", "plumbing");
    await service.getCitationContextForKeyword("biz-1", "plumbing");
    expect(citationFindManyMock).toHaveBeenCalledTimes(1);
  });

  it("different keyword → fresh DB query", async () => {
    citationFindManyMock.mockImplementation(async () => []);
    await service.getCitationContextForKeyword("biz-1", "plumbing");
    await service.getCitationContextForKeyword("biz-1", "roofing");
    expect(citationFindManyMock).toHaveBeenCalledTimes(2);
  });

  it("normalized keyword variants hit the same cache entry", async () => {
    citationFindManyMock.mockImplementation(async () => []);
    // Both phrasings normalize to the same dedup key (differ only in
    // filler words + case + punctuation).
    await service.getCitationContextForKeyword(
      "biz-1",
      "How much does plumbing cost?",
    );
    await service.getCitationContextForKeyword(
      "biz-1",
      "how much is a plumbing cost",
    );
    expect(citationFindManyMock).toHaveBeenCalledTimes(1);
  });
});

describe("brand answer checks", () => {
  it("builds branded overview, services, and location questions", () => {
    const tasks = service.buildBrandAnswerCheckTasks({
      businessName: "Example Plumbing",
      businessType: "Plumber",
      businessDescription: "Local plumbing team.",
      businessWebsiteUrl: "https://example.com",
      businessCity: "Toronto",
      businessState: "ON",
      businessCountry: "CA",
      selectedServices: ["Drain cleaning", "Leak repair"],
    });

    expect(tasks).toHaveLength(3);
    expect(tasks.every((task) => task.queryType === "brand_answer")).toBe(true);
    expect(tasks.map((task) => task.keyword)).toEqual([
      "Brand answer: Overview",
      "Brand answer: Services",
      "Brand answer: Location",
    ]);
    expect(tasks[0]?.queries[0]).toContain("Example Plumbing");
    expect(tasks[0]?.queries[0]).toContain("Toronto");
    expect(tasks[1]?.queries[0]).toContain("Drain cleaning");
  });

  it("runs branded answer checks even when no plan keywords exist", async () => {
    const previousEnv = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;

    try {
      planFindManyMock.mockImplementation(async () => []);
      llmInvokeMock.mockImplementation(async () => ({
        content: "Example Plumbing is a plumbing company. Visit https://example.com.",
      }));

      const result = await service.runCitationScan({
        businessId: "biz-1",
        maxKeywords: 1,
      });

      expect(result.keywordsScanned).toBe(3);
      expect(citationCreateMock).toHaveBeenCalledTimes(3);
      const createdRows = citationCreateMock.mock.calls.map(
        (call) => (call[0] as any).data,
      );
      expect(
        createdRows.every((row) =>
          row.keyword.startsWith(service.BRAND_ANSWER_KEYWORD_PREFIX),
        ),
      ).toBe(true);
      expect(createdRows.every((row) => row.cited === true)).toBe(true);
      expect(createdRows.every((row) => row.citationContext)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("runCitationScan — provider-failure alert (#8)", () => {
  it("emits ai-visibility/provider-failure when all providers fail", async () => {
    planFindManyMock.mockImplementation(async () => [{ keyword: "plumbing" }]);
    // Make every provider fail (no API keys → Gemini/Perplexity skip;
    // ChatGPT throws via llmInvokeMock).
    llmInvokeMock.mockImplementation(async () => {
      throw new Error("openai down");
    });
    // Ensure Gemini/Perplexity are in the provider list by setting
    // their env vars, but make their fetches fail.
    process.env.PERPLEXITY_API_KEY = "x";
    process.env.GEMINI_API_KEY = "x";
    fetchMock.mockImplementation(
      async () => new Response("nope", { status: 500 }),
    );

    const result = await service.runCitationScan({
      businessId: "biz-1",
      maxKeywords: 1,
    });

    expect(result.status).toBe("failed");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const sent: any = inngestSendMock.mock.calls[0]![0];
    expect(sent.name).toBe("ai-visibility/provider-failure");
    expect(sent.data.businessId).toBe("biz-1");
    expect(sent.data.scanId).toBe("scan-1");
    expect(Array.isArray(sent.data.failedProviders)).toBe(true);
  });

  it("inngest.send throwing does NOT reject runCitationScan", async () => {
    planFindManyMock.mockImplementation(async () => [{ keyword: "plumbing" }]);
    llmInvokeMock.mockImplementation(async () => {
      throw new Error("openai down");
    });
    fetchMock.mockImplementation(
      async () => new Response("nope", { status: 500 }),
    );
    inngestSendMock.mockImplementation(async () => {
      throw new Error("inngest degraded");
    });

    await expect(
      service.runCitationScan({ businessId: "biz-1", maxKeywords: 1 }),
    ).resolves.toBeDefined();
  });
});
