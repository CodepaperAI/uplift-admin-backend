import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const businessFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const businessFindManyMock = mock(async (_args: unknown): Promise<any[]> => []);

const createdJobs: any[] = [];
const createdTrialRuns: any[] = [];
let nextId = 1;

const tx = {
  aiVisibilityJob: {
    create: mock(async ({ data }: any) => {
      const job = {
        id: `job-${nextId++}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      createdJobs.push(job);
      return job;
    }),
  },
  aiVisibilityTrialRun: {
    create: mock(async ({ data }: any) => {
      const run = {
        id: `trial-${nextId++}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      createdTrialRuns.push(run);
      return run;
    }),
  },
};

mock.module("../config/db.config", () => ({
  prisma: {
    business: {
      findUnique: businessFindUniqueMock,
      findMany: businessFindManyMock,
    },
    $transaction: async (callback: (txArg: typeof tx) => Promise<unknown>) =>
      callback(tx),
  },
}));

let service: typeof import("../services/ai-visibility-run-policy.service");

beforeAll(async () => {
  service = await import("../services/ai-visibility-run-policy.service");
});

beforeEach(() => {
  businessFindUniqueMock.mockReset();
  businessFindManyMock.mockReset();
  tx.aiVisibilityJob.create.mockClear();
  tx.aiVisibilityTrialRun.create.mockClear();
  createdJobs.length = 0;
  createdTrialRuns.length = 0;
  nextId = 1;
});

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function business(overrides: Record<string, any> = {}) {
  return {
    id: "biz-1",
    isActive: true,
    websiteSubscription: null,
    aiVisibilityTrialRun: null,
    ...overrides,
  };
}

describe("AI Visibility run policy", () => {
  it("builds monthly UTC period keys", () => {
    expect(service.getAiVisibilityPeriodKey(new Date("2026-05-01T06:00:00Z"))).toBe("2026-05");
  });

  it("returns paid mode for active paid website subscriptions", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      business({
        websiteSubscription: {
          status: "active",
          trialStatus: "converted",
          trialEndDate: null,
          stripeSubscriptionId: "sub_123",
        },
      }),
    );

    const status = await service.getAiVisibilityRunPolicyStatus("biz-1");

    expect(status.mode).toBe("paid");
    expect(status.canRunMonthly).toBe(true);
    expect(status.canTriggerTrialRun).toBe(false);
  });

  it("returns trial_unused for active trials with no prior trial run", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      business({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: FUTURE,
        },
      }),
    );

    const status = await service.getAiVisibilityRunPolicyStatus("biz-1");

    expect(status.mode).toBe("trial_unused");
    expect(status.canTriggerTrialRun).toBe(true);
  });

  it("returns trial_used when a trial run already exists", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      business({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: FUTURE,
        },
        aiVisibilityTrialRun: {
          id: "trial-1",
          status: "queued",
          citationJobId: "job-1",
          discoveryJobId: "job-2",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    );

    const status = await service.getAiVisibilityRunPolicyStatus("biz-1");

    expect(status.mode).toBe("trial_used");
    expect(status.canTriggerTrialRun).toBe(false);
  });

  it("blocks expired trials", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      business({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: PAST,
        },
      }),
    );

    const status = await service.getAiVisibilityRunPolicyStatus("biz-1");

    expect(status.mode).toBe("ineligible");
    expect(status.canTriggerTrialRun).toBe(false);
  });

  it("creates exactly one trial run with citation and discovery jobs", async () => {
    businessFindUniqueMock.mockImplementation(async () =>
      business({
        websiteSubscription: {
          status: "trialing",
          trialStatus: "trialing",
          trialEndDate: FUTURE,
        },
      }),
    );

    const result = await service.createTrialAiVisibilityRun({
      businessId: "biz-1",
      requestedByUserId: "user-1",
    });

    expect(result.citationJob.type).toBe("citation_scan");
    expect(result.discoveryJob.type).toBe("query_discovery");
    expect(result.citationJob.source).toBe("trial_once");
    expect(result.discoveryJob.periodKey).toBe("trial");
    expect(result.trialRun.citationJobId).toBe(result.citationJob.id);
    expect(result.trialRun.discoveryJobId).toBe(result.discoveryJob.id);
    expect(createdJobs.length).toBe(2);
    expect(createdTrialRuns.length).toBe(1);
  });

  it("selects only paid subscription-shaped businesses for monthly automation", async () => {
    businessFindManyMock.mockImplementation(async () => []);

    await service.listMonthlyPaidAiVisibilityBusinesses();

    const call = businessFindManyMock.mock.calls[0]?.[0] as any;
    expect(call.where.websiteSubscription.is.status).toBe("active");
    expect(call.where.websiteSubscription.is.trialStatus.notIn).toEqual([
      "trialing",
      "expired",
    ]);
    expect(call.where.User.role.notIn).toEqual(["ADMIN", "SUPERADMIN"]);
  });
});
