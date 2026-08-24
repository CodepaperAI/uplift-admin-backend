import { beforeEach, describe, expect, it, mock } from "bun:test";

const invalidateTenantCacheMock = mock(
  async (_userId: string, _businessId?: string | null) => undefined,
);

mock.module("../utils/tenant-response-cache", () => ({
  invalidateTenantCache: invalidateTenantCacheMock,
}));

import {
  markBusinessOnboardingCompleted,
  markBusinessOnboardingRunning,
} from "../services/onboarding-state.service";

describe("onboarding state cache invalidation", () => {
  const updateMock = mock(async (_args: any) => ({ userId: "user-1" }));
  const db = { business: { update: updateMock } } as any;

  beforeEach(() => {
    updateMock.mockClear();
    invalidateTenantCacheMock.mockClear();
  });

  it("invalidates account and business reads when onboarding completes", async () => {
    await markBusinessOnboardingCompleted(db, {
      businessId: "business-1",
      correlationId: "correlation-1",
    });

    expect(updateMock.mock.calls[0]?.[0]?.select).toEqual({ userId: true });
    expect(invalidateTenantCacheMock.mock.calls).toEqual([
      ["user-1"],
      ["user-1", "business-1"],
    ]);
  });

  it("invalidates stale idle or queued reads when onboarding starts running", async () => {
    await markBusinessOnboardingRunning(db, {
      businessId: "business-1",
      correlationId: "correlation-1",
    });

    expect(invalidateTenantCacheMock.mock.calls).toEqual([
      ["user-1"],
      ["user-1", "business-1"],
    ]);
  });
});
