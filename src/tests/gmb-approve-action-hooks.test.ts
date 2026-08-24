// Phase 2 verification: the new edit-impact capture hook fires after each
// successful Google API call inside approveAction, never blocks the Google
// call, and a hook failure does not prevent the action from reaching APPLIED.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

let captureCalls: Array<{ id: string; actionType: string }> = [];
let captureShouldThrow = false;

const captureMock = mock(async (action: { id: string; actionType: string }) => {
  captureCalls.push({ id: action.id, actionType: action.actionType });
  if (captureShouldThrow) {
    throw new Error("simulated capture failure");
  }
  return { baselineId: `baseline-${action.id}` };
});

mock.module("../services/gmb-edit-impact.service", () => ({
  captureEditImpactBaseline: captureMock,
}));

const baseAction: {
  id: string;
  businessId: string;
  gmbId: string;
  actionType: string;
  status: string;
  payloadJson: Record<string, unknown>;
} = {
  id: "act-hook-1",
  businessId: "biz-hook-1",
  gmbId: "gmb-hook-1",
  actionType: "profile_edit",
  status: "PENDING",
  payloadJson: {
    businessData: { description: "New description, ranking-relevant." },
  },
};

let currentAction: typeof baseAction = { ...baseAction };
let lastAppliedData: any = null;
let updateInfoShouldThrow = false;

const actionFindFirstMock = mock(async () =>
  currentAction.status === "APPLIED" ? null : currentAction,
);
let lastFailedError: string | undefined;
const actionUpdateMock = mock(async (args: { data: any }) => {
  if (args.data.status === "APPLIED") {
    lastAppliedData = args.data;
  }
  if (args.data.status === "FAILED") {
    lastFailedError = args.data.error;
  }
  return { ...currentAction, ...args.data };
});

mock.module("../config/db.config", () => ({
  prisma: {
    gMBActionRecommendation: {
      findFirst: actionFindFirstMock,
      update: actionUpdateMock,
      create: mock(async () => null),
      updateMany: mock(async () => ({ count: 0 })),
    },
    googleMyBusiness: {
      findUnique: mock(async () => ({
        id: "gmb-hook-1",
        businessId: "biz-hook-1",
        isActive: true,
        isDemo: false,
        locationId: "locations/x",
        accountId: "accounts/y",
        business: {
          id: "biz-hook-1",
          businessName: "Hook Co",
          GeoProfile: null,
          Photos: [],
        },
      })),
      update: mock(async () => ({})),
    },
    gMBProfileSnapshot: {
      findFirst: mock(async () => null),
      create: mock(async () => ({
        id: "snap-x",
        businessId: "biz-hook-1",
        gmbId: "gmb-hook-1",
        syncedAt: new Date(),
      })),
    },
    gMBAlert: {
      findFirst: mock(async () => null),
      create: mock(async () => null),
    },
    // Structured tables used by backfill — mocked as no-ops so the post-snapshot
    // backfill hook completes silently and doesn't pollute test output.
    gMBBusinessHours: {
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBSpecialHours: {
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBCategory: {
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    gMBAttribute: {
      deleteMany: mock(async () => ({ count: 0 })),
      createMany: mock(async () => ({ count: 0 })),
    },
    $transaction: mock(async (ops: any[]) => Promise.all(ops)),
    business: {
      findFirst: mock(async () => null),
      findUnique: mock(async () => null),
    },
  },
}));

let service: typeof import("../services/gmb-local-visibility.service");
let GoogleMyBusinessService: typeof import("../services/google-my-business.service").GoogleMyBusinessService;

const updateBusinessInfoSpy = mock(async () => {
  if (updateInfoShouldThrow) {
    throw new Error("simulated Google 503");
  }
  return { title: "Hook Co" };
});

// Live profile that always reflects the description we said we updated, so
// verifySupportedProfileUpdate sees the update as successfully applied.
const getProfileDetailsSpy = mock(async () => ({
  title: "Hook Co",
  profile: { description: "New description, ranking-relevant." },
  storefrontAddress: undefined,
  phoneNumbers: undefined,
  websiteUri: undefined,
  categories: undefined,
  regularHours: undefined,
  specialHours: undefined,
  attributes: undefined,
  metadata: { placeId: "place-x" },
}));

let savedUpdateInfo: any;
let savedGetProfile: any;

beforeAll(async () => {
  service = await import("../services/gmb-local-visibility.service");
  ({ GoogleMyBusinessService } = await import(
    "../services/google-my-business.service"
  ));
});

beforeEach(() => {
  captureCalls = [];
  captureShouldThrow = false;
  updateInfoShouldThrow = false;
  currentAction = { ...baseAction, status: "PENDING" };
  lastAppliedData = null;
  actionFindFirstMock.mockClear();
  actionUpdateMock.mockClear();
  updateBusinessInfoSpy.mockClear();
  getProfileDetailsSpy.mockClear();
  captureMock.mockClear();

  savedUpdateInfo = GoogleMyBusinessService.prototype.updateBusinessInfo;
  savedGetProfile = GoogleMyBusinessService.prototype.getProfileDetails;
  GoogleMyBusinessService.prototype.updateBusinessInfo = updateBusinessInfoSpy as any;
  GoogleMyBusinessService.prototype.getProfileDetails = getProfileDetailsSpy as any;
});

afterEach(() => {
  GoogleMyBusinessService.prototype.updateBusinessInfo = savedUpdateInfo;
  GoogleMyBusinessService.prototype.getProfileDetails = savedGetProfile;
});

describe("approveAction Google API path + capture hook", () => {
  it("calls Google PATCH BEFORE the impact capture hook fires", async () => {
    // Track call order via timestamps
    const order: string[] = [];
    updateBusinessInfoSpy.mockImplementationOnce(async () => {
      order.push("google_patch");
      return { title: "Hook Co" };
    });
    captureMock.mockImplementationOnce(async (a: any) => {
      order.push("capture");
      captureCalls.push({ id: a.id, actionType: a.actionType });
      return { baselineId: "x" };
    });

    await service.gmbLocalVisibilityService.approveAction("biz-hook-1", "act-hook-1");

    // Wait a tick for fire-and-forget capture
    await new Promise((r) => setTimeout(r, 30));

    expect(order[0]).toBe("google_patch");
    expect(order).toContain("capture");
  });

  it("fires capture hook for profile_edit after APPLIED", async () => {
    await service.gmbLocalVisibilityService.approveAction("biz-hook-1", "act-hook-1");
    await new Promise((r) => setTimeout(r, 30));

    if (lastFailedError) {
      throw new Error(`action went FAILED instead of APPLIED: ${lastFailedError}`);
    }
    expect(lastAppliedData?.status).toBe("APPLIED");
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      id: "act-hook-1",
      actionType: "profile_edit",
    });
  });

  it("does NOT mark action APPLIED if Google PATCH throws (and capture is not fired)", async () => {
    updateInfoShouldThrow = true;

    await service.gmbLocalVisibilityService.approveAction("biz-hook-1", "act-hook-1");
    await new Promise((r) => setTimeout(r, 30));

    expect(updateBusinessInfoSpy).toHaveBeenCalledTimes(1);
    expect(lastAppliedData).toBeNull();
    expect(captureCalls).toHaveLength(0);
  });

  it("capture hook failure does NOT prevent action from reaching APPLIED", async () => {
    captureShouldThrow = true;

    const result = await service.gmbLocalVisibilityService.approveAction(
      "biz-hook-1",
      "act-hook-1",
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(result.status).toBe("APPLIED");
    // Capture was attempted (and threw), but the action still applied
    expect(captureCalls).toHaveLength(1);
  });

  it("fires capture for review_reply action type too (service decides to skip internally)", async () => {
    currentAction = {
      ...baseAction,
      actionType: "review_reply",
      payloadJson: { reviewId: "r-1", response: "Thanks!" },
    };

    const respondMock = mock(async () => ({ ok: true }));
    const savedRespond = GoogleMyBusinessService.prototype.respondToReview;
    GoogleMyBusinessService.prototype.respondToReview = respondMock as any;

    try {
      await service.gmbLocalVisibilityService.approveAction("biz-hook-1", "act-hook-1");
      await new Promise((r) => setTimeout(r, 30));

      expect(respondMock).toHaveBeenCalledTimes(1);
      // The hook always fires; the service internally decides whether to persist
      // based on the IMPACT_TRACKED_ACTION_TYPES allowlist.
      expect(captureCalls).toHaveLength(1);
      expect(captureCalls[0]?.actionType).toBe("review_reply");
    } finally {
      GoogleMyBusinessService.prototype.respondToReview = savedRespond;
    }
  });
});
