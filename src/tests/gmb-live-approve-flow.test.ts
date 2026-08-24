// Live-connected approval flow:
// approve a profile_edit action → calls Google PATCH (updateBusinessInfo) once.
// Re-approve the same action → guard rejects, no second PATCH.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const liveAction = {
  id: "act-live-1",
  businessId: "biz-live-1",
  actionType: "profile_edit",
  status: "PENDING",
  payloadJson: {
    businessData: {
      description: "Updated description for live profile.",
    },
  },
};

let actionFindFirstReturns: any = liveAction;

const findFirstMock = mock(async (args: any) => {
  const filter = args?.where?.status?.in;
  if (Array.isArray(filter) && actionFindFirstReturns?.status === "APPLIED") {
    return null;
  }
  return actionFindFirstReturns;
});
const updateMock = mock(async ({ data }: any) => ({
  ...liveAction,
  ...data,
}));

mock.module("../config/db.config", () => ({
  prisma: {
    gMBActionRecommendation: {
      findFirst: findFirstMock,
      update: updateMock,
      create: mock(async () => null),
      updateMany: mock(async () => ({ count: 0 })),
    },
    googleMyBusiness: {
      findUnique: mock(async () => ({
        id: "gmb-live-1",
        businessId: "biz-live-1",
        isActive: true,
        isDemo: false,
        locationId: "locations/123",
        accountId: "accounts/456",
        business: {
          id: "biz-live-1",
          businessName: "Real Plumbing Co",
          GeoProfile: null,
          Photos: [],
        },
      })),
    },
    gMBProfileSnapshot: {
      findFirst: mock(async () => null),
      create: mock(async () => ({
        id: "snap-1",
        businessId: "biz-live-1",
        gmbId: "gmb-live-1",
        syncedAt: new Date(),
      })),
    },
    gMBAlert: {
      findFirst: mock(async () => null),
      create: mock(async () => null),
    },
    business: {
      findFirst: mock(async () => null),
      findUnique: mock(async () => null),
    },
  },
}));

let service: typeof import("../services/gmb-local-visibility.service");
let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

const updateBusinessInfoSpy = mock(async (_b: string, _p: any) => ({
  title: "Real Plumbing Co",
}));

let savedUpdateInfo: any;

beforeAll(async () => {
  service = await import("../services/gmb-local-visibility.service");
  ({ GoogleMyBusinessService } = await import(
    "../services/google-my-business.service"
  ));
});

beforeEach(() => {
  findFirstMock.mockClear();
  updateMock.mockClear();
  updateBusinessInfoSpy.mockClear();
  actionFindFirstReturns = { ...liveAction, status: "PENDING" };

  savedUpdateInfo = GoogleMyBusinessService.prototype.updateBusinessInfo;
  GoogleMyBusinessService.prototype.updateBusinessInfo = updateBusinessInfoSpy as any;
});

afterEach(() => {
  GoogleMyBusinessService.prototype.updateBusinessInfo = savedUpdateInfo;
});

describe("Live Google approval flow: profile_edit action", () => {
  it("first approve calls Google PATCH exactly once", async () => {
    await service.gmbLocalVisibilityService.approveAction("biz-live-1", "act-live-1");
    expect(updateBusinessInfoSpy).toHaveBeenCalledTimes(1);
    expect(updateBusinessInfoSpy.mock.calls[0]?.[0]).toBe("biz-live-1");
  });

  it("second approve on already-APPLIED action throws and does NOT re-PATCH Google", async () => {
    actionFindFirstReturns = { ...liveAction, status: "APPLIED" };

    await expect(
      service.gmbLocalVisibilityService.approveAction("biz-live-1", "act-live-1"),
    ).rejects.toThrow();

    expect(updateBusinessInfoSpy).not.toHaveBeenCalled();
  });
});
