import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const findFirstMock = mock(async (_args: unknown): Promise<any> => null);
const findUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const updateMock = mock(async (_args: unknown): Promise<any> => null);
const businessFindFirstMock = mock(async (_args: unknown): Promise<any> => null);
const profileSnapshotFindFirstMock = mock(async (_args: unknown): Promise<any> => null);

mock.module("../config/db.config", () => ({
  prisma: {
    gMBActionRecommendation: {
      findFirst: findFirstMock,
      update: updateMock,
      create: mock(async () => null),
      updateMany: mock(async () => ({ count: 0 })),
    },
    googleMyBusiness: {
      findUnique: findUniqueMock,
    },
    gMBProfileSnapshot: {
      findFirst: profileSnapshotFindFirstMock,
    },
    gMBAlert: {
      findFirst: mock(async () => null),
      create: mock(async () => null),
    },
    business: {
      findFirst: businessFindFirstMock,
    },
  },
}));

let service: typeof import("../services/gmb-local-visibility.service");
let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

beforeAll(async () => {
  service = await import("../services/gmb-local-visibility.service");
  ({ GoogleMyBusinessService } = await import(
    "../services/google-my-business.service"
  ));
});

const originalRespondToReview =
  Symbol.for("originalRespondToReview") as unknown as keyof typeof GoogleMyBusinessService.prototype;
let savedRespond: any;
let savedUpdateInfo: any;
let savedGetProfile: any;

const respondToReviewSpy = mock(async (_a: string, _b: string, _c: string) => undefined);
const updateBusinessInfoSpy = mock(async (_b: string, _p: any) => undefined);
const getProfileDetailsSpy = mock(async (_b: string) => ({}));

beforeEach(() => {
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
  businessFindFirstMock.mockReset();
  profileSnapshotFindFirstMock.mockReset();
  respondToReviewSpy.mockReset();
  updateBusinessInfoSpy.mockReset();
  getProfileDetailsSpy.mockReset();

  savedRespond = GoogleMyBusinessService.prototype.respondToReview;
  savedUpdateInfo = GoogleMyBusinessService.prototype.updateBusinessInfo;
  savedGetProfile = GoogleMyBusinessService.prototype.getProfileDetails;

  GoogleMyBusinessService.prototype.respondToReview = respondToReviewSpy as any;
  GoogleMyBusinessService.prototype.updateBusinessInfo = updateBusinessInfoSpy as any;
  GoogleMyBusinessService.prototype.getProfileDetails = getProfileDetailsSpy as any;
});

afterEach(() => {
  GoogleMyBusinessService.prototype.respondToReview = savedRespond;
  GoogleMyBusinessService.prototype.updateBusinessInfo = savedUpdateInfo;
  GoogleMyBusinessService.prototype.getProfileDetails = savedGetProfile;
});

describe("GMB action approval idempotency", () => {
  it("approveAction throws when action is already APPLIED (filter excludes it)", async () => {
    findFirstMock.mockImplementationOnce(async (args: any) => {
      const filter = args?.where?.status?.in;
      expect(filter).toEqual(["PENDING", "APPROVED"]);
      return null;
    });

    await expect(
      service.gmbLocalVisibilityService.approveAction("biz-1", "act-1"),
    ).rejects.toThrow(/already applied|not found/i);
    expect(updateBusinessInfoSpy).not.toHaveBeenCalled();
    expect(respondToReviewSpy).not.toHaveBeenCalled();
  });

  it("approveAction proceeds when action is PENDING — review_reply branch", async () => {
    findFirstMock.mockImplementationOnce(async (args: any) => {
      const filter = args?.where?.status?.in;
      expect(filter).toEqual(["PENDING", "APPROVED"]);
      return {
        id: "act-3",
        businessId: "biz-1",
        actionType: "review_reply",
        status: "PENDING",
        payloadJson: {
          reviewId: "rev-1",
          response: "Thanks!",
        },
      };
    });
    updateMock.mockImplementationOnce(async () => ({
      id: "act-3",
      status: "APPLIED",
    }));

    await service.gmbLocalVisibilityService.approveAction("biz-1", "act-3");
    expect(respondToReviewSpy).toHaveBeenCalledTimes(1);
  });

  it("dismissAction throws when action is already APPLIED", async () => {
    findFirstMock.mockImplementationOnce(async (args: any) => {
      const filter = args?.where?.status?.in;
      expect(filter).toEqual(["PENDING", "APPROVED"]);
      return null;
    });

    await expect(
      service.gmbLocalVisibilityService.dismissAction("biz-1", "act-4"),
    ).rejects.toThrow(/already applied|not found/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("dismissAction proceeds when action is PENDING", async () => {
    findFirstMock.mockImplementationOnce(async (args: any) => {
      const filter = args?.where?.status?.in;
      expect(filter).toEqual(["PENDING", "APPROVED"]);
      return { id: "act-5" };
    });
    updateMock.mockImplementationOnce(async () => ({
      id: "act-5",
      status: "DISMISSED",
    }));

    const result = await service.gmbLocalVisibilityService.dismissAction(
      "biz-1",
      "act-5",
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect((result as any).status).toBe("DISMISSED");
  });
});
