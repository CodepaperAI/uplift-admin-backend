import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Unit tests for share-of-voice.service — exercises the aggregation math
 * against synthetic LlmCitation rows. No DB required; prisma is mocked.
 */

const citationFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);

mock.module("../config/db.config", () => ({
  // Our service only touches prisma.llmCitation.findMany — satisfy the
  // other exports so anything that imports this module doesn't break.
  createPrismaClient: () => ({
    llmCitation: { findMany: citationFindManyMock },
  }),
  prisma: {
    llmCitation: { findMany: citationFindManyMock },
  },
}));

// Import after mocks so the service picks up the stubbed prisma.
const { getShareOfVoice, getShareOfVoiceTrend, detectSovDrop } = await import(
  "../services/share-of-voice.service"
);

beforeEach(() => {
  citationFindManyMock.mockReset();
  citationFindManyMock.mockImplementation(async () => []);
});

describe("getShareOfVoice", () => {
  it("returns zero shape when there are no citations", async () => {
    const result = await getShareOfVoice("biz-1");
    expect(result.overall.yourMentions).toBe(0);
    expect(result.overall.competitorMentions).toBe(0);
    expect(result.overall.yourPct).toBe(0);
    expect(result.perKeyword).toHaveLength(0);
    expect(result.perProvider).toHaveLength(0);
  });

  it("aggregates citedCount + distinct competitors into overall SoV", async () => {
    citationFindManyMock.mockImplementation(async () => [
      {
        keyword: "plumbing",
        llmProvider: "CHATGPT",
        citedCount: 2,
        cited: true,
        competitorsCited: [
          { domain: "acme.com", url: "https://acme.com/x" },
          { domain: "WWW.Acme.com", url: "https://www.acme.com/y" }, // dupe
          { domain: "beta.io", url: "https://beta.io" },
        ],
      },
      {
        keyword: "plumbing",
        llmProvider: "GEMINI",
        citedCount: 1,
        cited: true,
        competitorsCited: [{ domain: "acme.com", url: "https://acme.com/z" }],
      },
    ]);

    const sov = await getShareOfVoice("biz-1", { window: "30d" });
    // you: 2 + 1 = 3; competitors (distinct per row): row1=2 (acme, beta), row2=1 (acme)
    expect(sov.overall.yourMentions).toBe(3);
    expect(sov.overall.competitorMentions).toBe(3);
    expect(sov.overall.totalMentions).toBe(6);
    expect(sov.overall.yourPct).toBe(50);
    // Top competitors ranked by count of rows they appear in
    expect(sov.overall.topCompetitors[0]?.domain).toBe("acme.com");
    expect(sov.overall.topCompetitors[0]?.mentions).toBe(2);
  });

  it("computes perProvider breakdown separately", async () => {
    citationFindManyMock.mockImplementation(async () => [
      {
        keyword: "kw",
        llmProvider: "CHATGPT",
        citedCount: 3,
        cited: true,
        competitorsCited: [],
      },
      {
        keyword: "kw",
        llmProvider: "PERPLEXITY",
        citedCount: 0,
        cited: false,
        competitorsCited: [{ domain: "comp.com" }],
      },
    ]);

    const sov = await getShareOfVoice("biz-1");
    const chatgpt = sov.perProvider.find((p) => p.provider === "CHATGPT");
    const pplx = sov.perProvider.find((p) => p.provider === "PERPLEXITY");
    expect(chatgpt?.yourPct).toBe(100);
    expect(pplx?.yourPct).toBe(0);
  });
});

describe("getShareOfVoiceTrend", () => {
  it("produces daily points with 7-day rolling average", async () => {
    const base = Date.parse("2026-04-01T12:00:00Z");
    citationFindManyMock.mockImplementation(async () => [
      {
        createdAt: new Date(base),
        citedCount: 5,
        competitorsCited: [{ domain: "a.com" }],
      },
      {
        createdAt: new Date(base + 24 * 60 * 60 * 1000),
        citedCount: 2,
        competitorsCited: [
          { domain: "a.com" },
          { domain: "b.com" },
        ],
      },
    ]);

    const trend = await getShareOfVoiceTrend("biz-1", { days: 30 });
    expect(trend).toHaveLength(2);
    expect(trend[0]?.yourPct).toBe(Math.round((5 / 6) * 1000) / 10);
    expect(trend[1]?.yourPct).toBe(Math.round((2 / 4) * 1000) / 10);
    // Rolling avg on day 2 collapses both days: (5+2)/(6+4) = 70%
    expect(trend[1]?.rollingAveragePct).toBe(70);
  });
});

describe("detectSovDrop", () => {
  it("flags a drop when previous window had share and current collapsed", async () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Previous window (30-60d ago): 80% share. Current (0-30d ago): 40%.
    citationFindManyMock.mockImplementation(async () => [
      {
        createdAt: new Date(now - 45 * DAY),
        citedCount: 8,
        competitorsCited: [{ domain: "c.com" }],
      },
      {
        createdAt: new Date(now - 10 * DAY),
        citedCount: 2,
        competitorsCited: [
          { domain: "c.com" },
          { domain: "d.com" },
          { domain: "e.com" },
        ],
      },
    ]);

    const drop = await detectSovDrop("biz-1", "plumbing", {
      windowDays: 30,
      dropThresholdPct: 25,
    });
    expect(drop.dropped).toBe(true);
    // 80% → 40% = 40pp drop
    expect(drop.droppedBy).toBeGreaterThanOrEqual(30);
    expect(drop.previousPct).toBeGreaterThan(drop.currentPct);
  });

  it("does NOT flag a drop when there is no prior data", async () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    citationFindManyMock.mockImplementation(async () => [
      {
        createdAt: new Date(now - 5 * DAY),
        citedCount: 0,
        competitorsCited: [{ domain: "x.com" }],
      },
    ]);

    const drop = await detectSovDrop("biz-1", "plumbing");
    expect(drop.dropped).toBe(false);
  });
});
