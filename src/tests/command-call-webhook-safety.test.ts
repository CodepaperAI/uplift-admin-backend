import { describe, expect, test } from "bun:test";
import {
  claimCommandCallWebhookEvent,
  completeCommandCallWebhookEvent,
  releaseCommandCallWebhookEvent,
  type CommandCallWebhookEventStore,
} from "../command/call-webhook-safety";

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
  const store: CommandCallWebhookEventStore = {
    async create({ data }) {
      if (rows.has(data.id)) throw { code: "P2002" };
      rows.set(data.id, { ...data, processedAt: null });
    },
    async findUnique({ where }) {
      const row = rows.get(where.id);
      return row
        ? { id: row.id, status: row.status, leaseExpiresAt: row.leaseExpiresAt }
        : null;
    },
    async updateMany({ where, data }) {
      const id = typeof where.id === "string" ? where.id : "";
      const row = rows.get(id);
      if (!row) return { count: 0 };
      if (typeof where.status === "string" && row.status !== where.status) {
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
          return (
            branch.status === "failed" ||
            Boolean(
              branch.leaseExpiresAt?.lte &&
                row.leaseExpiresAt &&
                row.leaseExpiresAt <= branch.leaseExpiresAt.lte,
            )
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

describe("Command call webhook processing lease", () => {
  test("does not acknowledge a concurrent delivery as processed", async () => {
    const { store } = testStore();
    const now = new Date("2026-08-17T12:00:00.000Z");
    expect(
      await claimCommandCallWebhookEvent(store, "fathom:evt_1", {
        now,
        leaseSeconds: 120,
      }),
    ).toEqual({ status: "claimed" });
    expect(
      await claimCommandCallWebhookEvent(store, "fathom:evt_1", {
        now: new Date(now.getTime() + 30_000),
        leaseSeconds: 120,
      }),
    ).toEqual({ status: "in_progress", retryAfterSeconds: 90 });
  });

  test("marks completion and then recognizes a provider replay", async () => {
    const { rows, store } = testStore();
    await claimCommandCallWebhookEvent(store, "fathom:evt_2");
    expect(
      await completeCommandCallWebhookEvent(store, "fathom:evt_2"),
    ).toBe(true);
    expect(rows.get("fathom:evt_2")?.status).toBe("processed");
    expect(
      await claimCommandCallWebhookEvent(store, "fathom:evt_2"),
    ).toEqual({ status: "duplicate" });
  });

  test("records a bounded failure and permits a retry", async () => {
    const { rows, store } = testStore();
    await claimCommandCallWebhookEvent(store, "fathom:evt_3");
    expect(
      await releaseCommandCallWebhookEvent(
        store,
        "fathom:evt_3",
        new Error("provider failure " + "x".repeat(1_000)),
      ),
    ).toBe(true);
    expect(rows.get("fathom:evt_3")?.lastError?.length).toBeLessThanOrEqual(500);
    expect(
      await claimCommandCallWebhookEvent(store, "fathom:evt_3"),
    ).toEqual({ status: "claimed" });
    expect(rows.get("fathom:evt_3")?.attemptCount).toBe(2);
  });
});
