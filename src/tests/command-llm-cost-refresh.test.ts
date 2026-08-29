import { beforeEach, describe, expect, it, mock } from "bun:test";

const findUnique = mock(async (_args: unknown) => null as unknown);
const upsert = mock(async (_args: unknown) => ({}));
const update = mock(async (_args: unknown) => ({}));
const groupBy = mock(async (_args: unknown) => [] as unknown[]);
const aggregate = mock(async (_args: unknown) => ({ _sum: { estimatedUsd: null } }));
const count = mock(async (_args: unknown) => 0);

/**
 * The whole surface the refresh touches, not just the staleness probe.
 *
 * Mocking only `findUnique` made every stale case fail: the refresh went on to
 * call the real sync, which threw on an unmocked `llmUsageEvent`, which the
 * helper swallowed and reported as "not refreshed". The test was passing on the
 * error path and asserting the wrong thing.
 */
mock.module("../config/db.config", () => ({
  prisma: {
    commandCostEntry: { findUnique, upsert, update },
    llmUsageEvent: { groupBy, aggregate, count },
  },
}));

const service = await import("../command/llm-cost-sync.service");
const { refreshLlmCostsIfStale, LLM_COST_REFRESH_INTERVAL_MS } = service;
const realSync = service.syncLlmUsageCostsForMonth;

beforeEach(() => {
  for (const m of [findUnique, upsert, update, groupBy, aggregate, count]) {
    m.mockReset();
  }
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue({});
  update.mockResolvedValue({});
  // One model with tokens, so the sync produces a non-zero figure and takes the
  // upsert path rather than the retire-the-entry path.
  groupBy.mockResolvedValue([
    { model: "gpt-5.6-luna", _sum: { inputTokens: 1_000_000, outputTokens: 500_000 } },
  ]);
  aggregate.mockResolvedValue({ _sum: { estimatedUsd: null } });
  count.mockResolvedValue(42);
});

const NOW = new Date("2026-08-28T18:00:00.000Z");

describe("refreshLlmCostsIfStale", () => {
  it("never touches a past month", async () => {
    // History does not change, so re-deriving it on every read is work for
    // nothing — and a write on a read path should be as rare as possible.
    const result = await refreshLlmCostsIfStale({
      month: "2026-07",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result).toEqual({ refreshed: false, syncedAt: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("skips a refresh when the entry is inside the interval", async () => {
    const updatedAt = new Date(NOW.getTime() - 60_000);
    findUnique.mockResolvedValue({ updatedAt, deletedAt: null });
    const result = await refreshLlmCostsIfStale({
      month: "2026-08",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result.refreshed).toBe(false);
    expect(result.syncedAt).toEqual(updatedAt);
  });

  it("treats an entry older than the interval as stale", async () => {
    // `findUnique` is hit twice: once by the staleness probe, then again inside
    // the sync, which reads amountMinor and description to decide whether the
    // row actually changed. A stub missing those fields throws there and the
    // helper reports "not refreshed" — which is the error path, not the one
    // under test.
    findUnique.mockResolvedValue({
      updatedAt: new Date(NOW.getTime() - LLM_COST_REFRESH_INTERVAL_MS - 1),
      deletedAt: null,
      amountMinor: { equals: () => false },
      description: "",
    });
    const result = await refreshLlmCostsIfStale({
      month: "2026-08",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result.refreshed).toBe(true);
  });

  it("treats a soft-deleted entry as stale rather than fresh", async () => {
    // Zero spend retires the entry; spend resuming has to bring it back.
    findUnique.mockResolvedValue({
      updatedAt: new Date(NOW.getTime() - 1_000),
      deletedAt: new Date(NOW.getTime() - 1_000),
    });
    const result = await refreshLlmCostsIfStale({
      month: "2026-08",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result.refreshed).toBe(true);
  });

  it("refreshes when no entry exists at all", async () => {
    findUnique.mockResolvedValue(null);
    const result = await refreshLlmCostsIfStale({
      month: "2026-08",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result.refreshed).toBe(true);
  });

  it("reports a failure as not-refreshed instead of throwing", async () => {
    // The costs endpoint must render with stale figures rather than 500.
    findUnique.mockRejectedValue(new Error("connection reset"));
    const result = await refreshLlmCostsIfStale({
      month: "2026-08",
      currentMonth: "2026-08",
      now: NOW,
    });
    expect(result).toEqual({ refreshed: false, syncedAt: null });
  });
});

describe("the sync itself is still exported", () => {
  it("remains callable for the manual endpoint", () => {
    expect(typeof realSync).toBe("function");
  });
});
