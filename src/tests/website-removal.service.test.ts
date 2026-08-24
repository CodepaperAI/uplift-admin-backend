import { describe, expect, it } from "bun:test";

import {
  buildAggregateSubscriptionReconciliation,
  classifyWebsiteRemovalBilling,
  executeWebsiteRemovalBilling,
  getWebsiteRestoreEligibility,
  processWebsiteRemovalRetryBatch,
  requestWebsiteRemoval,
  restoreWebsite,
  selectWebsiteRemovalReplacement,
  serializeWebsiteRemovalLifecycle,
  WebsiteRemovalError,
} from "../services/website-removal.service";

const business = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    isActive: false,
    isPrimary: false,
    websiteStatus: "cancellation_pending",
    removalStatus: "cancellation_pending",
    removalRequestedAt: new Date("2026-08-09T12:00:00.000Z"),
    removalCompletedAt: null,
    removalRecoveryDeadline: new Date("2026-09-08T12:00:00.000Z"),
    removalRestoredAt: null,
    removalPreviousWebsiteStatus: "active",
    removalPreviousSubscriptionStatus: "active",
    removalBillingAction: "unknown",
    removalBillingObjectId: null,
    removalOperationKey: "op-1",
    removalReplacementBusinessId: "33333333-3333-4333-8333-333333333333",
    websiteSubscription: {
      id: "ws-1",
      stripeSubscriptionId: "sub-1",
      stripeSubscriptionItemId: "si-1",
      stripePriceId: "price-1",
      status: "active",
      trialEndDate: null,
    },
    ...overrides,
  }) as any;

describe("website removal billing classification", () => {
  it("treats a single live item with no sibling mapping as dedicated", () => {
    expect(
      classifyWebsiteRemovalBilling({
        stripeSubscriptionId: "sub-1",
        stripeSubscriptionItemId: "si-1",
        liveSubscriptionItemIds: ["si-1"],
        siblingWebsiteSubscriptionCount: 0,
        subscriptionMetadata: {
          type: "add_website",
          businessId: "business-1",
        },
        businessId: "business-1",
      }),
    ).toBe("cancel_dedicated_subscription");
  });

  it("deletes only the exact item when DB or live Stripe proves sharing", () => {
    for (const input of [
      { liveSubscriptionItemIds: ["si-1"], siblingWebsiteSubscriptionCount: 1 },
      {
        liveSubscriptionItemIds: ["si-1", "si-sibling"],
        siblingWebsiteSubscriptionCount: 0,
      },
    ]) {
      expect(
        classifyWebsiteRemovalBilling({
          stripeSubscriptionId: "sub-1",
          stripeSubscriptionItemId: "si-1",
          subscriptionMetadata: null,
          businessId: "business-1",
          ...input,
        }),
      ).toBe("delete_shared_subscription_item");
    }
  });

  it("fails closed when a shared subscription item cannot be identified", () => {
    expect(
      classifyWebsiteRemovalBilling({
        stripeSubscriptionId: "sub-1",
        stripeSubscriptionItemId: null,
        liveSubscriptionItemIds: ["si-1", "si-2"],
        siblingWebsiteSubscriptionCount: 1,
        subscriptionMetadata: null,
        businessId: "business-1",
      }),
    ).toBe("unknown");
  });

  it("fails closed when the sole live item differs from the stored item", () => {
    expect(
      classifyWebsiteRemovalBilling({
        stripeSubscriptionId: "sub-1",
        stripeSubscriptionItemId: "si-stale",
        liveSubscriptionItemIds: ["si-live"],
        siblingWebsiteSubscriptionCount: 0,
        subscriptionMetadata: null,
        businessId: "business-1",
      }),
    ).toBe("unknown");
  });

  it("requires no provider operation when no Stripe object is stored", () => {
    expect(
      classifyWebsiteRemovalBilling({
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
        liveSubscriptionItemIds: [],
        siblingWebsiteSubscriptionCount: 0,
        businessId: "business-1",
      }),
    ).toBe("none");
  });
});

describe("website removal Stripe execution", () => {
  it("cancels the entire dedicated subscription and never deletes its item", async () => {
    const calls: string[] = [];
    const db = {
      websiteSubscription: { count: async () => 0 },
      business: { updateMany: async () => ({ count: 1 }) },
    } as any;
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub-1",
          status: "active",
          metadata: { type: "add_website", businessId: business().id },
          items: { data: [{ id: "si-1" }] },
        }),
        cancel: async () => {
          calls.push("cancel_subscription");
          return { id: "sub-1", status: "canceled" };
        },
      },
      subscriptionItems: {
        retrieve: async () => ({ id: "si-1", subscription: "sub-1" }),
        del: async () => {
          calls.push("delete_item");
          return { deleted: true };
        },
      },
    } as any;

    const result = await executeWebsiteRemovalBilling({
      db,
      stripe,
      business: business(),
      operationKey: "op-1",
    });

    expect(result.action).toBe("cancel_dedicated_subscription");
    expect(calls).toEqual(["cancel_subscription"]);
  });

  it("deletes only the verified target item on a shared subscription", async () => {
    const calls: string[] = [];
    const db = {
      websiteSubscription: { count: async () => 1 },
      business: { updateMany: async () => ({ count: 1 }) },
    } as any;
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub-1",
          status: "active",
          metadata: {},
          items: { data: [{ id: "si-1" }, { id: "si-sibling" }] },
        }),
        cancel: async () => {
          calls.push("cancel_subscription");
          return { status: "canceled" };
        },
      },
      subscriptionItems: {
        retrieve: async () => ({ id: "si-1", subscription: "sub-1" }),
        del: async () => {
          calls.push("delete_item");
          return { deleted: true };
        },
      },
    } as any;

    const result = await executeWebsiteRemovalBilling({
      db,
      stripe,
      business: business(),
      operationKey: "op-1",
    });

    expect(result.action).toBe("delete_shared_subscription_item");
    expect(calls).toEqual(["delete_item"]);
  });

  it("does not mutate Stripe when local billing identifiers are absent", async () => {
    const result = await executeWebsiteRemovalBilling({
      db: {} as any,
      stripe: {} as any,
      business: business({ websiteSubscription: null }),
      operationKey: "op-local",
    });
    expect(result).toEqual({
      action: "none",
      objectId: null,
      outcome: "not_required",
    });
  });

  it("converges after shared item deletion succeeded but DB finalization crashed", async () => {
    const db = {
      websiteSubscription: { count: async () => 0 },
      business: { updateMany: async () => ({ count: 1 }) },
    } as any;
    const missing = Object.assign(new Error("No such subscription_item"), {
      code: "resource_missing",
    });
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub-1",
          status: "active",
          metadata: {},
          items: { data: [{ id: "si-survivor" }] },
        }),
      },
      subscriptionItems: {
        retrieve: async () => {
          throw missing;
        },
        del: async () => {
          throw new Error("must not delete twice");
        },
      },
    } as any;
    const result = await executeWebsiteRemovalBilling({
      db,
      stripe,
      business: business({
        removalBillingAction: "delete_shared_subscription_item",
        removalBillingObjectId: "si-1",
      }),
      operationKey: "op-1",
    });
    expect(result).toEqual({
      action: "delete_shared_subscription_item",
      objectId: "si-1",
      outcome: "confirmed",
    });
  });
});

describe("website removal replacement selection", () => {
  it("chooses the first deterministic switchable survivor", () => {
    expect(
      selectWebsiteRemovalReplacement([
        {
          id: "queued-primary",
          isPrimary: true,
          websiteStatus: "pending",
          onboardingStatus: "queued",
        },
        {
          id: "ready-first",
          isPrimary: false,
          websiteStatus: "active",
          onboardingStatus: "completed",
        },
        {
          id: "ready-second",
          isPrimary: false,
          websiteStatus: "active",
          onboardingStatus: "completed",
        },
      ])?.id,
    ).toBe("ready-first");
  });

  it("does not count failed, suspended, running, or unconfirmed pending sites", () => {
    expect(
      selectWebsiteRemovalReplacement([
        {
          id: "failed",
          isPrimary: false,
          websiteStatus: "failed",
          onboardingStatus: "failed",
        },
        {
          id: "suspended",
          isPrimary: false,
          websiteStatus: "suspended",
          onboardingStatus: "completed",
        },
        {
          id: "running",
          isPrimary: false,
          websiteStatus: "active",
          onboardingStatus: "running",
        },
        {
          id: "pending",
          isPrimary: false,
          websiteStatus: "pending",
          onboardingStatus: "idle",
        },
      ]),
    ).toBeNull();
  });
});

describe("website removal aggregate subscription reconciliation", () => {
  it("re-anchors an aggregate subscription to the deterministic surviving site", () => {
    const currentPeriodEnd = new Date("2026-09-09T00:00:00.000Z");
    expect(
      buildAggregateSubscriptionReconciliation({
        aggregateStripeSubscriptionId: "sub-canceled",
        canceledStripeSubscriptionId: "sub-canceled",
        survivor: {
          stripeSubscriptionId: "sub-survivor",
          stripePriceId: "price-survivor",
          status: "active",
          currentPeriodEnd,
        },
        now: new Date("2026-08-09T00:00:00.000Z"),
      }),
    ).toMatchObject({
      status: "active",
      stripeStatus: "active",
      stripeSubscriptionId: "sub-survivor",
      stripePriceId: "price-survivor",
      currentPeriodEnd,
      canceledAt: null,
    });
  });

  it("marks the aggregate canceled when no paid per-site anchor survives", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    expect(
      buildAggregateSubscriptionReconciliation({
        aggregateStripeSubscriptionId: "sub-canceled",
        canceledStripeSubscriptionId: "sub-canceled",
        survivor: null,
        now,
      }),
    ).toMatchObject({
      status: "canceled",
      stripeStatus: "canceled",
      stripeSubscriptionId: null,
      canceledAt: now,
    });
  });

  it("does not touch an aggregate anchored to a different subscription", () => {
    expect(
      buildAggregateSubscriptionReconciliation({
        aggregateStripeSubscriptionId: "sub-keep",
        canceledStripeSubscriptionId: "sub-canceled",
        survivor: null,
        now: new Date(),
      }),
    ).toBeNull();
  });
});

describe("website removal recovery", () => {
  it("allows shared-item recovery during the 30-day window", () => {
    expect(
      getWebsiteRestoreEligibility({
        removalStatus: "removed",
        recoveryDeadline: new Date("2026-09-01T00:00:00.000Z"),
        billingAction: "delete_shared_subscription_item",
        now: new Date("2026-08-15T00:00:00.000Z"),
      }),
    ).toBe("eligible");
  });

  it("requires checkout for a canceled dedicated subscription", () => {
    expect(
      getWebsiteRestoreEligibility({
        removalStatus: "removed",
        recoveryDeadline: new Date("2026-09-01T00:00:00.000Z"),
        billingAction: "cancel_dedicated_subscription",
        now: new Date("2026-08-15T00:00:00.000Z"),
      }),
    ).toBe("billing_required");
  });

  it("expires recovery at the deadline", () => {
    expect(
      getWebsiteRestoreEligibility({
        removalStatus: "removed",
        recoveryDeadline: new Date("2026-08-15T00:00:00.000Z"),
        billingAction: "delete_shared_subscription_item",
        now: new Date("2026-08-15T00:00:00.000Z"),
      }),
    ).toBe("expired");
  });

  it("serializes pending state without leaking the internal error", () => {
    expect(
      serializeWebsiteRemovalLifecycle(business(), {
        now: new Date("2026-08-15T00:00:00.000Z"),
      }),
    ).toEqual({
      status: "cancellation_pending",
      requestedAt: "2026-08-09T12:00:00.000Z",
      completedAt: null,
      recoveryDeadline: "2026-09-08T12:00:00.000Z",
      billingAction: "unknown",
      retryable: true,
      restoreEligibility: "not_removed",
    });
  });

  it("recovers a dedicated record without reactivating unpaid access", async () => {
    const target = business({
      removalStatus: "removed",
      removalBillingAction: "cancel_dedicated_subscription",
      removalCompletedAt: new Date("2026-08-09T12:00:00.000Z"),
      isActive: false,
      websiteStatus: "suspended",
      websiteSubscription: {
        ...business().websiteSubscription,
        status: "canceled",
      },
    });
    let updateData: Record<string, unknown> | null = null;
    const db = {
      business: {
        findUnique: async () => target,
        update: async (args: { data: Record<string, unknown> }) => {
          updateData = args.data;
          return { ...target, ...args.data };
        },
      },
      user: { findUnique: async () => ({ role: "USER" }) },
    } as any;

    const result = await restoreWebsite(target.userId, target.id, {
      db,
      stripe: {} as any,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(result).toEqual({
      businessId: target.id,
      removalStatus: "active",
      isActive: false,
      websiteStatus: "expired",
      selectedWebsiteId: target.removalReplacementBusinessId,
      billingAction: "none",
      requiresSubscription: true,
      idempotent: false,
    });
    expect(updateData).toMatchObject({
      isActive: false,
      isPrimary: false,
      websiteStatus: "expired",
      removalStatus: "active",
    });
  });
});

describe("website removal request safety", () => {
  it("returns not-found for a business owned by another user without mutation", async () => {
    let transactionCalls = 0;
    const db = {
      business: { findUnique: async () => business({ isActive: true, removalStatus: "active" }) },
      $transaction: async () => {
        transactionCalls += 1;
      },
    } as any;

    await expect(
      requestWebsiteRemoval("different-user", business().id, { db }),
    ).rejects.toMatchObject({ code: "WEBSITE_NOT_FOUND", statusCode: 404 });
    expect(transactionCalls).toBe(0);
  });

  it("blocks the final active website before queueing or contacting Stripe", async () => {
    let queueCreates = 0;
    const target = business({ isActive: true, removalStatus: "active" });
    const tx = {
      business: {
        count: async () => 1,
        findMany: async () => [],
      },
      stripeRetryQueue: {
        create: async () => {
          queueCreates += 1;
        },
      },
    };
    const db = {
      business: { findUnique: async () => target },
      $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
    } as any;

    let caught: unknown;
    try {
      await requestWebsiteRemoval(target.userId, target.id, { db });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebsiteRemovalError);
    expect(caught).toMatchObject({ code: "LAST_ACTIVE_WEBSITE", statusCode: 409 });
    expect(queueCreates).toBe(0);
  });

  it("returns a completed removal idempotently without a second DB transaction", async () => {
    let transactionCalls = 0;
    const target = business({
      removalStatus: "removed",
      removalCompletedAt: new Date("2026-08-09T12:10:00.000Z"),
      removalBillingAction: "cancel_dedicated_subscription",
    });
    const db = {
      business: { findUnique: async () => target },
      $transaction: async () => {
        transactionCalls += 1;
      },
    } as any;

    const result = await requestWebsiteRemoval(target.userId, target.id, { db });
    expect(result).toMatchObject({
      removalStatus: "removed",
      billingOutcome: "confirmed",
      idempotent: true,
    });
    expect(transactionCalls).toBe(0);
  });
});

describe("website removal retry worker", () => {
  it("reclaims stale processing work before scanning due jobs", async () => {
    let reclaimWhere: Record<string, unknown> | undefined;
    const db = {
      stripeRetryQueue: {
        updateMany: async (args: { where: Record<string, unknown> }) => {
          reclaimWhere = args.where;
          return { count: 1 };
        },
        findMany: async () => [],
      },
    } as any;
    const result = await processWebsiteRemovalRetryBatch({
      db,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    expect(reclaimWhere).toMatchObject({
      operationType: "remove_website",
      status: "processing",
    });
    expect(result).toEqual({ scanned: 0, completed: 0, pending: 0 });
  });
});
