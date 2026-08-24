import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const findUniqueMock = mock(async () => ({ id: "gmb-1" }));
const reviewFindManyMock = mock(async (_args?: unknown): Promise<any[]> => []);
const reviewUpsertMock = mock(async ({ create }: { create: any }) => ({
  id: `local-${create.reviewId}`,
  ...create,
}));

mock.module("../config/db.config", () => ({
  prisma: {
    googleMyBusiness: {
      findUnique: findUniqueMock,
    },
    gMBReview: {
      findMany: reviewFindManyMock,
      upsert: reviewUpsertMock,
    },
  },
}));

describe("GoogleMyBusinessService review window", () => {
  let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

  beforeAll(async () => {
    ({ GoogleMyBusinessService } = await import(
      "../services/google-my-business.service"
    ));
  });

  beforeEach(() => {
    findUniqueMock.mockImplementation(async () => ({ id: "gmb-1" }));
    reviewFindManyMock.mockImplementation(async () => []);
    reviewUpsertMock.mockImplementation(async ({ create }: { create: any }) => ({
      id: `local-${create.reviewId}`,
      ...create,
    }));
    findUniqueMock.mockClear();
    reviewFindManyMock.mockClear();
    reviewUpsertMock.mockClear();
  });

  it("fetches only recent reviews and stops pagination after an old page", async () => {
    const service = new GoogleMyBusinessService() as any;
    service.getValidToken = async () => "token";
    service.getConnectionRecord = async () => ({
      id: "gmb-1",
      accountId: "123",
      locationId: "456",
    });

    const requestedUrls: string[] = [];
    service.makeRequest = mock(async (url: string) => {
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return {
          reviews: [
            {
              name: "accounts/123/locations/456/reviews/recent",
              starRating: 5,
              createTime: new Date().toISOString(),
            },
            {
              name: "accounts/123/locations/456/reviews/old-on-first-page",
              starRating: 1,
              createTime: "2020-01-01T00:00:00.000Z",
            },
          ],
          nextPageToken: "page-2",
        };
      }

      return {
        reviews: [
          {
            name: "accounts/123/locations/456/reviews/old-page",
            starRating: 2,
            createTime: "2020-01-02T00:00:00.000Z",
          },
        ],
        nextPageToken: "page-3",
      };
    });

    const result = await service.getReviews("business-1");

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("pageSize=50");
    expect(requestedUrls[0]).toContain("orderBy=updateTime+desc");
    expect(requestedUrls[1]).toContain("pageToken=page-2");
    expect(result.reviews.map((review: { name?: string }) => review.name)).toEqual([
      "accounts/123/locations/456/reviews/recent",
    ]);
    expect(result.totalReviewCount).toBe(1);
    expect(result.averageRating).toBe(5);
  });

  it("filters cached reviews by the same six-month window", async () => {
    const service = new GoogleMyBusinessService();
    let capturedWhere: unknown;

    findUniqueMock.mockImplementation(async () => ({ id: "gmb-1" }));
    reviewFindManyMock.mockImplementation(async (args?: unknown) => {
      capturedWhere = (args as { where?: unknown } | undefined)?.where;
      return [];
    });

    await service.getCachedReviews("business-1");

    expect(capturedWhere).toMatchObject({
      gmbId: "gmb-1",
      reviewDate: { gte: expect.any(Date) },
    });
  });

  it("does not fall back to all-time cached dashboard ratings when no recent reviews exist", async () => {
    const service = new GoogleMyBusinessService() as any;
    service.getCachedPosts = async () => [];
    service.getCachedReviews = async () => [];

    findUniqueMock.mockImplementation(async () => ({
      id: "gmb-1",
      businessName: "Recent Window Test",
      businessAddress: null,
      businessPhone: null,
      businessWebsite: null,
      lastSyncAt: new Date("2026-04-29T12:00:00.000Z"),
      lastSyncError: null,
      totalReviewCount: 42,
      cachedInsightsViews: 10,
      cachedInsightsClicks: 2,
      cachedInsightsCalls: 1,
      cachedInsightsDirections: 3,
      cachedAverageRating: 4.8,
      cachedCategories: [],
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
    }));

    const result = await service.getCachedDashboardData("business-1");

    expect(result.profile.totalReviews).toBe(0);
    expect(result.profile.rating).toBe(null);
  });

  it("auto-replies to existing synced unresponded reviews", async () => {
    const service = new GoogleMyBusinessService() as any;
    const autoReplyMock = mock(async () => ({
      repliedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));

    service.getReviews = mock(async () => ({
      reviews: [
        {
          name: "accounts/123/locations/456/reviews/existing-review",
          reviewer: { displayName: "Ava" },
          starRating: "FIVE",
          comment: "Great",
          createTime: new Date().toISOString(),
        },
      ],
      newUnrespondedReviews: [],
    }));
    service.isAutoReviewReplyEnabled = async () => true;
    service.autoReplyToNewReviews = autoReplyMock;

    reviewFindManyMock.mockImplementation(async () => [
      {
        id: "local-review-1",
        reviewId: "accounts/123/locations/456/reviews/existing-review",
        reviewerName: "Ava",
        rating: 5,
        comment: "Great",
      },
    ]);

    const result = await service.syncAndAutoReplyReviews("business-1");

    expect(result).toMatchObject({
      syncedCount: 1,
      autoReplyDisabled: false,
      autoReplyResults: {
        repliedCount: 1,
        skippedCount: 0,
        failedCount: 0,
      },
    });
    expect(reviewFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reviewId: {
            in: ["accounts/123/locations/456/reviews/existing-review"],
          },
          isResponded: false,
        },
      }),
    );
    expect(autoReplyMock).toHaveBeenCalledWith("business-1", [
      {
        id: "local-review-1",
        reviewId: "accounts/123/locations/456/reviews/existing-review",
        reviewerName: "Ava",
        rating: 5,
        comment: "Great",
      },
    ]);
  });

  it("syncs reviews but skips auto-reply when review automation is disabled", async () => {
    const service = new GoogleMyBusinessService() as any;
    const autoReplyMock = mock(async () => ({
      repliedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));

    service.getReviews = mock(async () => ({
      reviews: [{ name: "recent" }],
      newUnrespondedReviews: [
        {
          id: "local-review-1",
          reviewId: "review-1",
          reviewerName: "Ava",
          rating: 5,
          comment: "Great",
        },
      ],
    }));
    service.isAutoReviewReplyEnabled = async () => false;
    service.autoReplyToNewReviews = autoReplyMock;

    const result = await service.syncAndAutoReplyReviews("business-1");

    expect(result).toMatchObject({
      syncedCount: 1,
      autoReplyDisabled: true,
      autoReplyResults: null,
    });
    expect(autoReplyMock).not.toHaveBeenCalled();
  });
});
