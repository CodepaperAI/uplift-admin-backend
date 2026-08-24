import { beforeEach, describe, expect, it, mock } from "bun:test";

const blogFindManyMock = mock();
const blogUpdateMock = mock();
const detectSovDropMock = mock();
const scoreBlogContentMock = mock();
const isScoreSkippedMock = mock();
const refreshBlogSectionsMock = mock();

mock.module("../config/db.config", () => ({
  prisma: {
    blog: {
      findMany: blogFindManyMock,
      update: blogUpdateMock,
    },
  },
}));

mock.module("../services/share-of-voice.service", () => ({
  detectSovDrop: detectSovDropMock,
}));

mock.module("../services/content-scorecard.service", () => ({
  scoreBlogContent: scoreBlogContentMock,
  isScoreSkipped: isScoreSkippedMock,
}));

mock.module("../services/blog-section-refresh.service", () => ({
  refreshBlogSections: refreshBlogSectionsMock,
}));

const { runFreshnessRefreshBatch } = await import(
  "../services/blog-freshness.service"
);

const staleBlog = {
  id: "blog-1",
  businessId: "business-1",
  slug: "stale-blog",
  seoScore: 70,
  refreshAttempts: 0,
  lastRefreshedAt: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("blog freshness refresh batch", () => {
  beforeEach(() => {
    blogFindManyMock.mockReset();
    blogUpdateMock.mockReset();
    detectSovDropMock.mockReset();
    scoreBlogContentMock.mockReset();
    isScoreSkippedMock.mockReset();
    refreshBlogSectionsMock.mockReset();

    blogFindManyMock
      .mockResolvedValueOnce([staleBlog])
      .mockResolvedValueOnce([]);
    blogUpdateMock.mockResolvedValue({});
    isScoreSkippedMock.mockReturnValue(false);
  });

  it("bumps stale-only blogs without changing content", async () => {
    scoreBlogContentMock.mockResolvedValue({ suggestions: [] });

    const result = await runFreshnessRefreshBatch({ limit: 1 });

    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.enqueuedFullRegen).toBe(0);
    expect(blogUpdateMock).toHaveBeenCalledWith({
      where: { id: "blog-1" },
      data: {
        lastRefreshedAt: expect.any(Date),
      },
    });
    expect(refreshBlogSectionsMock).not.toHaveBeenCalled();
  });

  it("runs partial refresh for one or two failing signals", async () => {
    scoreBlogContentMock.mockResolvedValue({
      suggestions: [{ signal: "faqSection", priority: "high" }],
    });
    refreshBlogSectionsMock.mockResolvedValue({
      refreshed: true,
      html: "<p>updated</p>",
      sectionsUpdated: ["faqSection"],
    });

    const result = await runFreshnessRefreshBatch({ limit: 1 });

    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(refreshBlogSectionsMock).toHaveBeenCalledWith("blog-1", [
      "faqSection",
    ]);
    expect(blogUpdateMock).toHaveBeenCalledWith({
      where: { id: "blog-1" },
      data: {
        content: "<p>updated</p>",
        refreshAttempts: { increment: 1 },
        lastRefreshedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    });
  });

  it("does not fake-success full regeneration when the safe in-place path is absent", async () => {
    scoreBlogContentMock.mockResolvedValue({
      suggestions: [
        { signal: "definitionalClarity", priority: "high" },
        { signal: "faqSection", priority: "high" },
        { signal: "sourceCitations", priority: "medium" },
      ],
    });

    const result = await runFreshnessRefreshBatch({ limit: 1 });

    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.enqueuedFullRegen).toBe(0);
    expect(blogUpdateMock).not.toHaveBeenCalled();
    expect(refreshBlogSectionsMock).not.toHaveBeenCalled();
  });

  it("keeps failures retryable when partial regeneration throws", async () => {
    scoreBlogContentMock.mockResolvedValue({
      suggestions: [{ signal: "faqSection", priority: "high" }],
    });
    refreshBlogSectionsMock.mockRejectedValue(new Error("LLM failed"));

    const result = await runFreshnessRefreshBatch({ limit: 1 });

    expect(result.refreshed).toBe(0);
    expect(result.failed).toBe(1);
    expect(blogUpdateMock).not.toHaveBeenCalled();
  });
});
