import { describe, expect, it } from "bun:test";

import {
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  isRemovalLifecycleProtected,
  releaseFailedStripeWebhookEvent,
  resolveSafeSubscriptionItemForBusiness,
  type StripeWebhookEventStore,
} from "../utils/stripe-webhook-safety";

type Row = {
  id: string;
  status: string;
  attemptCount: number;
  leaseExpiresAt: Date | null;
  processedAt: Date | null;
  lastError: string | null;
};

function testStore() {
  const rows = new Map<string, Row>();
  const store: StripeWebhookEventStore = {
    async create({ data }) {
      if (rows.has(data.id)) throw { code: "P2002" };
      rows.set(data.id, {
        ...data,
        processedAt: null,
      });
    },
    async findUnique({ where }) {
      const row = rows.get(where.id);
      return row
        ? {
            id: row.id,
            status: row.status,
            leaseExpiresAt: row.leaseExpiresAt,
          }
        : null;
    },
    async updateMany({ where, data }) {
      const id = typeof where.id === "string" ? where.id : "";
      const row = rows.get(id);
      if (!row) return { count: 0 };
      if (
        typeof where.status === "string" &&
        row.status !== where.status
      ) {
        return { count: 0 };
      }
      if (Array.isArray(where.OR)) {
        const takeoverAllowed = where.OR.some((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const branch = candidate as {
            status?: string;
            leaseExpiresAt?: { lte?: Date };
          };
          if (branch.status !== row.status) return false;
          return branch.status === "failed" ||
            Boolean(
              branch.leaseExpiresAt?.lte &&
                row.leaseExpiresAt &&
                row.leaseExpiresAt <= branch.leaseExpiresAt.lte,
            );
        });
        if (!takeoverAllowed) return { count: 0 };
      }
      for (const [key, value] of Object.entries(data)) {
        if (
          key === "attemptCount" &&
          value &&
          typeof value === "object" &&
          "increment" in value
        ) {
          row.attemptCount += Number(value.increment);
        } else {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return { count: 1 };
    },
  };
  return { rows, store };
}

describe("Stripe webhook processing lease", () => {
  it("does not acknowledge a concurrent in-progress delivery as processed", async () => {
    const { store } = testStore();
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(
      await claimStripeWebhookEvent(store, "evt_concurrent", {
        now,
        leaseSeconds: 120,
      }),
    ).toEqual({ status: "claimed" });
    expect(
      await claimStripeWebhookEvent(store, "evt_concurrent", {
        now: new Date(now.getTime() + 30_000),
        leaseSeconds: 120,
      }),
    ).toEqual({ status: "in_progress", retryAfterSeconds: 90 });
  });

  it("marks completion and treats later replay as a processed duplicate", async () => {
    const { rows, store } = testStore();
    await claimStripeWebhookEvent(store, "evt_complete");
    expect(
      await completeStripeWebhookEvent(store, "evt_complete"),
    ).toBe(true);
    expect(rows.get("evt_complete")?.status).toBe("processed");
    expect(
      await claimStripeWebhookEvent(store, "evt_complete"),
    ).toEqual({ status: "duplicate" });
  });

  it("retains a bounded failure and permits a retry takeover", async () => {
    const { rows, store } = testStore();
    const now = new Date("2026-08-14T12:00:00.000Z");
    await claimStripeWebhookEvent(store, "evt_retry", { now });
    expect(
      await releaseFailedStripeWebhookEvent(
        store,
        "evt_retry",
        new Error("provider failure " + "x".repeat(1_000)),
      ),
    ).toBe(true);
    expect(rows.get("evt_retry")?.status).toBe("failed");
    expect(rows.get("evt_retry")?.lastError?.length).toBeLessThanOrEqual(500);
    expect(
      await claimStripeWebhookEvent(store, "evt_retry", {
        now: new Date(now.getTime() + 1_000),
      }),
    ).toEqual({ status: "claimed" });
    expect(rows.get("evt_retry")?.attemptCount).toBe(2);
  });

  it("takes over an expired processing lease", async () => {
    const { rows, store } = testStore();
    const now = new Date("2026-08-14T12:00:00.000Z");
    await claimStripeWebhookEvent(store, "evt_expired", {
      now,
      leaseSeconds: 30,
    });
    expect(
      await claimStripeWebhookEvent(store, "evt_expired", {
        now: new Date(now.getTime() + 31_000),
      }),
    ).toEqual({ status: "claimed" });
    expect(rows.get("evt_expired")?.attemptCount).toBe(2);
  });
});

describe("removed website billing sync safety", () => {
  it("blocks every non-active removal lifecycle", () => {
    expect(isRemovalLifecycleProtected("active")).toBe(false);
    expect(isRemovalLifecycleProtected(null)).toBe(false);
    expect(isRemovalLifecycleProtected("cancellation_pending")).toBe(true);
    expect(isRemovalLifecycleProtected("removed")).toBe(true);
    expect(isRemovalLifecycleProtected("future_state")).toBe(true);
  });

  it("never guesses among sibling subscription items", () => {
    const items = [
      { id: "si_1", metadata: { businessId: "business-1" } },
      { id: "si_2", metadata: {} },
    ];
    expect(
      resolveSafeSubscriptionItemForBusiness({
        businessId: "business-1",
        items,
      })?.id,
    ).toBe("si_1");
    expect(
      resolveSafeSubscriptionItemForBusiness({
        businessId: "business-removed",
        existingSubscriptionItemId: "si_removed",
        items,
      }),
    ).toBeNull();
    expect(
      resolveSafeSubscriptionItemForBusiness({
        businessId: "business-unknown",
        items,
      }),
    ).toBeNull();
  });
});
