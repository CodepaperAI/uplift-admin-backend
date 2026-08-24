import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---- Prisma mock ----
const businessFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
mock.module("../config/db.config", () => ({
  prisma: {
    business: { findUnique: businessFindUniqueMock },
  },
}));

let utils: typeof import("../utils/ai-visibility-access.utils");

beforeAll(async () => {
  utils = await import("../utils/ai-visibility-access.utils");
});

beforeEach(() => {
  businessFindUniqueMock.mockReset();
});

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

function shape(overrides: Record<string, any>): any {
  return {
    id: "biz-1",
    isActive: true,
    websiteSubscription: null,
    User: { trialStatus: null, trialEndDate: null, Subscription: null },
    ...overrides,
  };
}

describe("hasActiveOrTrialAccess", () => {
  it("does not grant access from account subscription alone", () => {
    const biz = shape({
      User: undefined,
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(false);
  });

  it("paid website subscription → true", () => {
    const biz = shape({
      websiteSubscription: {
        status: "active",
        trialStatus: "converted",
        stripeSubscriptionId: "sub_123",
      },
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(true);
    expect(utils.hasPaidAiVisibilityAccess(biz)).toBe(true);
    expect(utils.hasTrialAiVisibilityAccess(biz)).toBe(false);
  });

  it("website-level trial (trialing + future end) → true", () => {
    const biz = shape({
      websiteSubscription: {
        status: "trialing",
        trialStatus: "trialing",
        trialEndDate: FUTURE,
      },
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(true);
    expect(utils.hasPaidAiVisibilityAccess(biz)).toBe(false);
    expect(utils.hasTrialAiVisibilityAccess(biz)).toBe(true);
  });

  it("does not grant access from account-level trial data alone", () => {
    const biz = shape({
      User: undefined,
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(false);
    expect(utils.hasPaidAiVisibilityAccess(biz)).toBe(false);
    expect(utils.hasTrialAiVisibilityAccess(biz)).toBe(false);
  });

  it("expired trial, no paid → false", () => {
    const biz = shape({
      User: { trialStatus: "active", trialEndDate: PAST },
      websiteSubscription: {
        status: "trialing",
        trialStatus: "trialing",
        trialEndDate: PAST,
      },
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(false);
  });

  it("no subscription and no trial → false", () => {
    const biz = shape({});
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(false);
  });

  it("inactive business → false even with paid", () => {
    const biz = shape({
      isActive: false,
      User: undefined,
      websiteSubscription: {
        status: "active",
        trialStatus: "converted",
        stripeSubscriptionId: "sub_123",
      },
    });
    expect(utils.hasActiveOrTrialAccess(biz)).toBe(false);
  });

  it("null business → false", () => {
    expect(utils.hasActiveOrTrialAccess(null)).toBe(false);
  });
});

describe("assertAiVisibilityAccess", () => {
  it("throws business_not_found when business missing", async () => {
    businessFindUniqueMock.mockImplementation(async () => null);
    await expect(utils.assertAiVisibilityAccess("missing")).rejects.toThrow();
    try {
      await utils.assertAiVisibilityAccess("missing");
    } catch (err) {
      expect(err).toBeInstanceOf(utils.AiVisibilityAccessError);
      expect((err as any).reason).toBe("business_not_found");
    }
  });

  it("throws inactive_business when isActive=false", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      shape({ isActive: false }),
    );
    try {
      await utils.assertAiVisibilityAccess("biz-1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(utils.AiVisibilityAccessError);
      expect((err as any).reason).toBe("inactive_business");
    }
  });

  it("throws subscription_required when no access", async () => {
    businessFindUniqueMock.mockImplementation(async () => shape({}));
    try {
      await utils.assertAiVisibilityAccess("biz-1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(utils.AiVisibilityAccessError);
      expect((err as any).reason).toBe("subscription_required");
    }
  });

  it("resolves for trial user", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      shape({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: FUTURE,
        },
      }),
    );
    await expect(utils.assertAiVisibilityAccess("biz-1")).resolves.toBeUndefined();
  });

  it("paid-only assertion rejects trial users", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      shape({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: FUTURE,
        },
      }),
    );
    try {
      await utils.assertPaidAiVisibilityAccess("biz-1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(utils.AiVisibilityAccessError);
      expect((err as any).reason).toBe("subscription_required");
    }
  });

  it("paid-only assertion resolves for paid users", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      shape({
        websiteSubscription: {
          status: "active",
          trialStatus: "converted",
          stripeSubscriptionId: "sub_123",
        },
      }),
    );
    await expect(utils.assertPaidAiVisibilityAccess("biz-1")).resolves.toBeUndefined();
  });
});
