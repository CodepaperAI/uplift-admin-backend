import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

type ReviewRecord = {
  id: string;
  reviewId: string;
  isResponded: boolean;
  response: string | null;
  responseDate: Date | null;
};

let reviewRecord: ReviewRecord | null = null;
let allowReplyClaim = true;

const findFirstMock = mock(async () => reviewRecord);
const findManyMock = mock(async () => (reviewRecord ? [reviewRecord] : []));
const updateMock = mock(async ({ data }: { data?: Partial<ReviewRecord> }) => {
  if (reviewRecord) {
    reviewRecord = {
      ...reviewRecord,
      isResponded: Boolean(data?.isResponded ?? reviewRecord.isResponded),
      response:
        typeof data?.response === "string"
          ? data.response
          : reviewRecord.response,
      responseDate:
        data?.responseDate instanceof Date
          ? data.responseDate
          : reviewRecord.responseDate,
    };
  }
  return reviewRecord;
});
const updateManyMock = mock(
  async ({
    data,
    where,
  }: {
    data?: Partial<ReviewRecord>;
    where?: {
      id?: string;
      isResponded?: boolean;
      response?: string | null;
      responseDate?: Date | null;
    };
  }) => {
    if (!reviewRecord || where?.id !== reviewRecord.id) {
      return { count: 0 };
    }

    if (where?.isResponded === false) {
      if (!allowReplyClaim || reviewRecord.isResponded) {
        return { count: 0 };
      }

      reviewRecord = {
        ...reviewRecord,
        isResponded: Boolean(data?.isResponded ?? reviewRecord.isResponded),
        response:
          typeof data?.response === "string"
            ? data.response
            : reviewRecord.response,
        responseDate:
          data?.responseDate instanceof Date
            ? data.responseDate
            : reviewRecord.responseDate,
      };

      return { count: 1 };
    }

    if (
      where?.response === reviewRecord.response &&
      where?.responseDate === reviewRecord.responseDate
    ) {
      reviewRecord = {
        ...reviewRecord,
        isResponded: Boolean(data?.isResponded ?? reviewRecord.isResponded),
        response:
          typeof data?.response === "string" || data?.response === null
            ? data.response
            : reviewRecord.response,
        responseDate:
          data?.responseDate instanceof Date || data?.responseDate === null
            ? data.responseDate
            : reviewRecord.responseDate,
      };

      return { count: 1 };
    }

    return { count: 0 };
  },
);
const upsertMock = mock(
  async ({
    create,
    update,
    where,
  }: {
    create: ReviewRecord & Record<string, unknown>;
    update: Partial<ReviewRecord>;
    where: { reviewId: string };
  }) => {
    if (reviewRecord?.reviewId === where.reviewId) {
      reviewRecord = {
        ...reviewRecord,
        isResponded: Boolean(update.isResponded ?? reviewRecord.isResponded),
        response:
          typeof update.response === "string" || update.response === null
            ? update.response
            : reviewRecord.response,
        responseDate:
          update.responseDate instanceof Date || update.responseDate === null
            ? update.responseDate
            : reviewRecord.responseDate,
      };

      return reviewRecord;
    }

    reviewRecord = {
      id: create.id ?? "local-review-1",
      reviewId: create.reviewId,
      isResponded: Boolean(create.isResponded),
      response:
        typeof create.response === "string" || create.response === null
          ? create.response
          : null,
      responseDate:
        create.responseDate instanceof Date ? create.responseDate : null,
    };

    return reviewRecord;
  },
);

// Stub all delegates this service file (and any service it transitively pulls in)
// might touch. mock.module is process-wide in bun:test, so a partial mock here
// would leak into sibling test files and cause "prisma.<delegate> is undefined"
// at module load. Default every delegate to no-op stubs.
const noopFindFirst = mock(async () => null);
const noopFindUnique = mock(async () => null);
const noopFindMany = mock(async () => []);
const noopCount = mock(async () => 0);
const noopCreate = mock(async () => ({}));
const noopUpdate = mock(async () => ({}));
const noopUpdateMany = mock(async () => ({ count: 0 }));
const noopUpsert = mock(async () => ({}));
const noopDelete = mock(async () => ({}));
const noopDeleteMany = mock(async () => ({ count: 0 }));
const noopAggregate = mock(async () => ({}));
const noopGroupBy = mock(async () => []);

const stubDelegate = () => ({
  findFirst: noopFindFirst,
  findUnique: noopFindUnique,
  findMany: noopFindMany,
  count: noopCount,
  create: noopCreate,
  update: noopUpdate,
  updateMany: noopUpdateMany,
  upsert: noopUpsert,
  delete: noopDelete,
  deleteMany: noopDeleteMany,
  aggregate: noopAggregate,
  groupBy: noopGroupBy,
});

mock.module("../config/db.config", () => ({
  prisma: {
    // Real mocks for the delegate this test cares about
    gMBReview: {
      findFirst: findFirstMock,
      update: updateMock,
      findUnique: noopFindUnique,
      findMany: findManyMock,
      count: noopCount,
      create: noopCreate,
      updateMany: updateManyMock,
      upsert: upsertMock,
      delete: noopDelete,
      deleteMany: noopDeleteMany,
    },
    // Full no-op stubs for every other delegate so sibling tests can import the
    // mocked prisma without "undefined" errors.
    business: stubDelegate(),
    user: stubDelegate(),
    googleMyBusiness: stubDelegate(),
    gMBPost: stubDelegate(),
    gMBProfileSnapshot: stubDelegate(),
    gMBDailyMetric: stubDelegate(),
    gMBDiscoveryKeyword: stubDelegate(),
    gMBProfileHealthRun: stubDelegate(),
    gMBProfileHealthItem: stubDelegate(),
    gMBActionRecommendation: stubDelegate(),
    gMBMediaAsset: stubDelegate(),
    gMBLocalRankScan: stubDelegate(),
    gMBLocalRankResult: stubDelegate(),
    gMBCompetitorSnapshot: stubDelegate(),
    gMBReviewCampaign: stubDelegate(),
    gMBAttributionLink: stubDelegate(),
    gMBAlert: stubDelegate(),
    businessPhoto: stubDelegate(),
    publishingIntegration: stubDelegate(),
    aiVisibilityJob: stubDelegate(),
    aiVisibilityTrialRun: stubDelegate(),
  },
}));

describe("GoogleMyBusinessService review reply idempotency", () => {
  let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

  beforeAll(async () => {
    ({ GoogleMyBusinessService } = await import(
      "../services/google-my-business.service"
    ));
  });

  beforeEach(() => {
    reviewRecord = {
      id: "local-review-1",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      isResponded: false,
      response: null,
      responseDate: null,
    };

    findFirstMock.mockClear();
    findManyMock.mockClear();
    updateMock.mockClear();
    updateManyMock.mockClear();
    upsertMock.mockClear();
    allowReplyClaim = true;
  });

  it("skips reposting when the local review is already marked responded", async () => {
    reviewRecord = {
      id: "local-review-1",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      isResponded: true,
      response: "Already synced locally",
      responseDate: new Date("2026-03-30T10:00:00.000Z"),
    };

    const service = new GoogleMyBusinessService() as any;
    const makeRequestMock = mock(async () => ({}));
    service.getValidToken = async () => "token";
    service.getConnectionRecord = async () => ({
      id: "gmb-1",
      accountId: "123",
      locationId: "456",
    });
    service.makeRequest = makeRequestMock;

    const result = await service.respondToReview(
      "business-1",
      "accounts/123/locations/456/reviews/review-1",
      "Thanks for your review!"
    );

    expect(result.status).toBe("already_responded_local");
    expect(makeRequestMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("skips posting when another worker already claimed the review reply", async () => {
    allowReplyClaim = false;
    reviewRecord = {
      id: "local-review-1",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      isResponded: false,
      response: null,
      responseDate: null,
    };

    const service = new GoogleMyBusinessService() as any;
    const makeRequestMock = mock(async () => ({}));
    service.getValidToken = async () => "token";
    service.getConnectionRecord = async () => ({
      id: "gmb-1",
      accountId: "123",
      locationId: "456",
    });
    service.makeRequest = makeRequestMock;

    const result = await service.respondToReview(
      "business-1",
      "accounts/123/locations/456/reviews/review-1",
      "Thanks for your review!",
    );

    expect(result.status).toBe("already_responded_local");
    expect(makeRequestMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("treats a remote 409 reply conflict as success after syncing the remote review", async () => {
    const service = new GoogleMyBusinessService() as any;
    const conflictError = Object.assign(
      new Error("GMB API Error: 409 - ALREADY_EXISTS"),
      {
        status: 409,
        body: '{"error":{"status":"ALREADY_EXISTS"}}',
      }
    );

    service.getValidToken = async () => "token";
    service.getConnectionRecord = async () => ({
      id: "gmb-1",
      accountId: "123",
      locationId: "456",
    });
    service.makeRequest = mock(async () => {
      throw conflictError;
    });
    service.getReviews = mock(async () => {
      reviewRecord = {
        id: "local-review-1",
        reviewId: "accounts/123/locations/456/reviews/review-1",
        isResponded: true,
        response: "Remote reply already exists",
        responseDate: new Date("2026-03-30T11:00:00.000Z"),
      };

      return {
        reviews: [],
        newUnrespondedReviews: [],
      };
    });

    const result = await service.respondToReview(
      "business-1",
      "accounts/123/locations/456/reviews/review-1",
      "Thanks for your review!"
    );

    expect(result).toMatchObject({
      status: "already_exists_remote",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      response: "Remote reply already exists",
    });
    expect(service.getReviews).toHaveBeenCalledWith("business-1");
    expect(updateMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("marks a remotely missing review as skipped after a 404 reply failure", async () => {
    const service = new GoogleMyBusinessService() as any;
    const notFoundError = Object.assign(
      new Error("GMB API Error: 404 - NOT_FOUND"),
      {
        status: 404,
        body: '{"error":{"status":"NOT_FOUND","message":"Requested entity was not found."}}',
      },
    );

    service.getValidToken = async () => "token";
    service.getConnectionRecord = async () => ({
      id: "gmb-1",
      accountId: "123",
      locationId: "456",
    });
    service.makeRequest = mock(async () => {
      throw notFoundError;
    });
    service.getReviews = mock(async () => ({
      reviews: [],
      newUnrespondedReviews: [],
    }));

    const result = await service.respondToReview(
      "business-1",
      "accounts/123/locations/456/reviews/review-1",
      "Thanks for your review!",
    );

    expect(result).toMatchObject({
      status: "not_found_remote",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      response: null,
      responseDate: null,
    });
    expect(service.getReviews).toHaveBeenCalledWith("business-1");
    expect(reviewRecord).toMatchObject({
      isResponded: true,
      response: null,
      responseDate: null,
    });
    expect(updateManyMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a locally posted reply when Google sync omits the owner reply temporarily", async () => {
    const localResponseDate = new Date("2026-03-30T12:00:00.000Z");
    reviewRecord = {
      id: "local-review-1",
      reviewId: "accounts/123/locations/456/reviews/review-1",
      isResponded: true,
      response: "Previously posted local reply",
      responseDate: localResponseDate,
    };

    const service = new GoogleMyBusinessService() as any;
    const result = await service.syncReviewRecords("gmb-1", [
      {
        name: "accounts/123/locations/456/reviews/review-1",
        reviewer: { displayName: "Darrell Hart" },
        starRating: "FOUR",
        comment: "Nice stay",
        createTime: "2026-03-30T09:00:00.000Z",
      },
    ]);

    expect(result.newUnrespondedReviews).toEqual([]);
    expect(reviewRecord).toMatchObject({
      isResponded: true,
      response: "Previously posted local reply",
      responseDate: localResponseDate,
    });
  });
});
