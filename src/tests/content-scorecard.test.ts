import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Prisma mock ----
const blogFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const contentLlmScoreFindUniqueMock = mock(
  async (_args: unknown): Promise<any> => null,
);
const contentLlmScoreUpsertMock = mock(async (_args: unknown) => ({}));

mock.module("../config/db.config", () => ({
  prisma: {
    blog: { findUnique: blogFindUniqueMock, findMany: async () => [] },
    contentLlmScore: {
      findUnique: contentLlmScoreFindUniqueMock,
      upsert: contentLlmScoreUpsertMock,
    },
  },
}));

// ---- GPT-5 mini mock ----
// Each test drives `modelInvokeMock` to either return a fake response or throw.
const modelInvokeMock = mock(async (_msgs: unknown): Promise<{ content: string }> => ({
  content: "YES",
}));

mock.module("../config/llm.config", () => ({
  createGPT5MiniModel: () => ({ invoke: modelInvokeMock }),
  createGPT54NanoModel: () => ({ invoke: modelInvokeMock }),
}));

let service: typeof import("../services/content-scorecard.service");

beforeAll(async () => {
  service = await import("../services/content-scorecard.service");
});

beforeEach(() => {
  blogFindUniqueMock.mockReset();
  contentLlmScoreFindUniqueMock.mockReset();
  contentLlmScoreUpsertMock.mockReset();
  modelInvokeMock.mockReset();

  blogFindUniqueMock.mockImplementation(async () => ({
    title: "Test Blog",
    content:
      // Content with all five signals maxed out except clarity which the model decides.
      '<script type="application/ld+json">{"@context":"schema.org"}</script>' +
      "<h2>FAQ</h2>" +
      '<script type="application/ld+json">{"@type":"FAQPage"}</script>' +
      '<a href="https://source1.com/">1</a>' +
      '<a href="https://source2.com/">2</a>' +
      '<a href="https://source3.com/">3</a>' +
      "<p>Body</p>",
    updatedAt: new Date(), // fresh (< 3mo)
  }));
  contentLlmScoreFindUniqueMock.mockImplementation(async () => null);
  contentLlmScoreUpsertMock.mockImplementation(async () => ({}));
});

describe("scoreBlogContent — GPT-5 mini happy path", () => {
  it("writes full score when GPT-5 mini returns YES", async () => {
    modelInvokeMock.mockImplementation(async () => ({ content: "YES" }));
    const result = await service.scoreBlogContent("blog-1", "biz-1");
    expect(service.isScoreSkipped(result)).toBe(false);
    if (service.isScoreSkipped(result)) return;
    expect(result.definitionalClarity).toBe(2);
    expect(result.overallScore).toBeGreaterThanOrEqual(8);
    expect(contentLlmScoreUpsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("scoreBlogContent — GPT-5 mini failure: preserve prior", () => {
  it("uses prior definitionalClarity when LLM throws", async () => {
    modelInvokeMock.mockImplementation(async () => {
      throw new Error("openai 500");
    });
    contentLlmScoreFindUniqueMock.mockImplementation(async () => ({
      definitionalClarity: 2,
    }));

    const result = await service.scoreBlogContent("blog-1", "biz-1");
    expect(service.isScoreSkipped(result)).toBe(false);
    if (service.isScoreSkipped(result)) return;

    expect(result.definitionalClarity).toBe(2);
    expect(result.definitionalClarityPreserved).toBe(true);
    expect(contentLlmScoreUpsertMock).toHaveBeenCalledTimes(1);

    // No "could not be assessed" suggestion should have been added.
    const upsertArgs: any = contentLlmScoreUpsertMock.mock.calls[0]![0];
    const suggestions: Array<{ signal: string }> =
      upsertArgs.create.suggestions;
    expect(
      suggestions.some((s) => s.signal === "definitionalClarity"),
    ).toBe(false);
  });
});

describe("scoreBlogContent — GPT-5 mini failure: skip when no prior", () => {
  it("does NOT upsert and returns { skipped: true }", async () => {
    modelInvokeMock.mockImplementation(async () => {
      throw new Error("openai 500");
    });
    contentLlmScoreFindUniqueMock.mockImplementation(async () => null);

    const result = await service.scoreBlogContent("blog-1", "biz-1");

    expect(service.isScoreSkipped(result)).toBe(true);
    if (!service.isScoreSkipped(result)) return;
    expect(result.reason).toBe("model_unavailable");
    expect(contentLlmScoreUpsertMock).not.toHaveBeenCalled();
  });
});
