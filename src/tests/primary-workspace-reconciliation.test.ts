import { describe, expect, test } from "bun:test";

import { selectPrimaryWorkspaceCandidate } from "../services/primary-workspace-reconciliation.service";

const website = (input: Partial<{
  id: string;
  isPrimary: boolean;
  isActive: boolean;
  websiteStatus: string;
  onboardingStatus: string;
  subscriptionStatus: string;
}> = {}) => ({
  id: input.id ?? "site",
  isPrimary: input.isPrimary ?? false,
  isActive: input.isActive ?? true,
  websiteStatus: input.websiteStatus ?? "active",
  onboardingFlow: "trial_primary",
  onboardingStatus: input.onboardingStatus ?? "completed",
  removalStatus: "active",
  websiteSubscription: {
    status: input.subscriptionStatus ?? "active",
  },
});

describe("primary workspace reconciliation", () => {
  test("replaces a canceled primary with an accessible workspace", () => {
    const canceled = website({
      id: "canceled",
      isPrimary: true,
      isActive: false,
      websiteStatus: "canceled",
      subscriptionStatus: "canceled",
    });
    const active = website({ id: "active" });

    expect(selectPrimaryWorkspaceCandidate([canceled, active])?.id).toBe(
      "active",
    );
  });

  test("returns no primary when all owned records are unavailable", () => {
    expect(
      selectPrimaryWorkspaceCandidate([
        website({
          id: "canceled",
          isPrimary: true,
          isActive: false,
          websiteStatus: "canceled",
          subscriptionStatus: "canceled",
        }),
      ]),
    ).toBeNull();
  });

  test("preserves an accessible current primary deterministically", () => {
    expect(
      selectPrimaryWorkspaceCandidate([
        website({ id: "first" }),
        website({ id: "current", isPrimary: true }),
      ])?.id,
    ).toBe("current");
  });
});
