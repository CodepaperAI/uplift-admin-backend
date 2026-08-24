import { beforeEach, describe, expect, it, mock } from "bun:test";

// We need to mock the dependencies imported by gmb-local-visibility.service
// before requiring it. The service relies on prisma + the Google service +
// the AI service, none of which we exercise here — we only test the
// payload-shaping helpers via approveAction's update path.

const updateBusinessInfoMock = mock(
  async (_businessId: string, businessData: Record<string, unknown>) => {
    capturedPatches.push(businessData);
    return {};
  },
);
const capturedPatches: Array<Record<string, unknown>> = [];

const actionFindFirstMock = mock(async (_args: unknown): Promise<any> => null);
const actionUpdateMock = mock(
  async ({ data }: any) => ({ id: "action", ...data }),
);
const alertFindFirstMock = mock(async () => null);
const gmbFindUniqueMock = mock(
  async (_args: unknown): Promise<any> => ({
    id: "gmb-1",
    businessId: "biz-1",
    accountId: "acct-1",
    locationId: "loc-1",
    isDemo: false,
    business: {},
  }),
);
const snapshotFindFirstMock = mock(async () => null);

mock.module("../config/db.config", () => ({
  prisma: {
    gMBActionRecommendation: {
      findFirst: actionFindFirstMock,
      update: actionUpdateMock,
      create: mock(async () => ({})),
      findMany: mock(async () => []),
      updateMany: mock(async () => ({ count: 0 })),
    },
    gMBAlert: { findFirst: alertFindFirstMock },
    gMBMediaAsset: {
      findFirst: mock(async () => null),
      update: mock(async () => ({})),
    },
    googleMyBusiness: { findUnique: gmbFindUniqueMock },
    gMBProfileSnapshot: { findFirst: snapshotFindFirstMock },
    business: { findUnique: mock(async () => null) },
  },
}));

mock.module("./gmb-demo-data.service", () => ({
  isDemoGmbConnection: () => false,
}));

mock.module("./gmb-ai.service", () => ({
  gmbAIService: {
    generateProfileProposal: mock(async () => null),
    invalidateProfileProposalCache: mock(() => undefined),
  },
}));

import { GMBLocalVisibilityService } from "../services/gmb-local-visibility.service";

class FakeGmbService {
  updateBusinessInfo = updateBusinessInfoMock;
  respondToReview = mock(async () => ({}));
  uploadMedia = mock(async () => ({}));
  fetchLocation = mock(async () => null);
  getProfileDetails = mock(async () => null);
}

describe("approveAction service items auto-patch", () => {
  let service: GMBLocalVisibilityService;

  beforeEach(() => {
    capturedPatches.length = 0;
    actionFindFirstMock.mockReset();
    actionUpdateMock.mockReset();
    actionUpdateMock.mockImplementation(async ({ data }: any) => ({
      id: "action",
      ...data,
    }));
    updateBusinessInfoMock.mockClear();
    // Cast through unknown so the test stub can stand in for the full
    // GoogleMyBusinessService surface — we only exercise updateBusinessInfo.
    service = new GMBLocalVisibilityService(
      new FakeGmbService() as unknown as ConstructorParameters<typeof GMBLocalVisibilityService>[0],
    );
  });

  it("wraps string services into freeFormServiceItem with the resolved primary category", async () => {
    actionFindFirstMock.mockImplementationOnce(async () => ({
      id: "action-1",
      businessId: "biz-1",
      gmbId: "gmb-1",
      actionType: "profile_edit",
      status: "PENDING",
      payloadJson: {
        profileReview: {
          currentProfile: {
            categories: [],
            services: [],
          },
          diffs: [
            {
              field: "categories",
              label: "Categories",
              currentValue: [],
              proposedValue: ["Plumber"],
              applySupported: true,
            },
            {
              field: "services",
              label: "Services",
              currentValue: [],
              proposedValue: [
                "Drain cleaning | Clear blocked drains and restore water flow for local customers.",
                "Pipe repair | Diagnose damaged pipes and complete reliable repair work.",
              ],
              applySupported: true,
            },
          ],
        },
      },
    }));

    await service.approveAction("biz-1", "action-1");

    expect(updateBusinessInfoMock).toHaveBeenCalledTimes(1);
    const patch = capturedPatches[0]!;
    expect(patch.categories).toEqual(["categories/gcid:plumber"]);
    expect(patch.serviceItems).toEqual([
      {
        freeFormServiceItem: {
          category: "categories/gcid:plumber",
          label: {
            displayName: "Drain cleaning",
            description:
              "Clear blocked drains and restore water flow for local customers.",
            languageCode: "en",
          },
        },
      },
      {
        freeFormServiceItem: {
          category: "categories/gcid:plumber",
          label: {
            displayName: "Pipe repair",
            description: "Diagnose damaged pipes and complete reliable repair work.",
            languageCode: "en",
          },
        },
      },
    ]);
  });

  it("skips the services patch when no primary category is resolvable", async () => {
    actionFindFirstMock.mockImplementationOnce(async () => ({
      id: "action-2",
      businessId: "biz-1",
      gmbId: "gmb-1",
      actionType: "profile_edit",
      status: "PENDING",
      payloadJson: {
        profileReview: {
          currentProfile: { categories: [], services: [] },
          diffs: [
            {
              field: "services",
              label: "Services",
              currentValue: [],
              proposedValue: ["Quantum widget repair"],
              applySupported: true,
            },
          ],
        },
      },
    }));

    await service.approveAction("biz-1", "action-2");

    // The action should still update its status (APPROVED, not APPLIED) but
    // no Google patch should fire since there's nothing supported to apply.
    expect(updateBusinessInfoMock).not.toHaveBeenCalled();
  });

  it("preserves already-structured serviceItems when caller supplies them", async () => {
    const structuredItem = {
      freeFormServiceItem: {
        category: "categories/gcid:dentist",
        label: { displayName: "Teeth cleaning", languageCode: "en" },
      },
    };
    actionFindFirstMock.mockImplementationOnce(async () => ({
      id: "action-3",
      businessId: "biz-1",
      gmbId: "gmb-1",
      actionType: "profile_edit",
      status: "PENDING",
      payloadJson: {
        businessData: {
          name: "Smile Dental",
          serviceItems: [structuredItem],
        },
      },
    }));

    await service.approveAction("biz-1", "action-3");

    expect(updateBusinessInfoMock).toHaveBeenCalledTimes(1);
    expect(capturedPatches[0]!.serviceItems).toEqual([structuredItem]);
  });
});
