import { beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, unknown>();
const readCommandProviderCache = mock(async (ns: string) => store.get(ns) ?? null);
const writeCommandProviderCache = mock(
  async (ns: string, value: unknown, _ttl: number) => {
    store.set(ns, JSON.parse(JSON.stringify(value)));
  },
);

mock.module("../utils/command-cache", () => ({
  readCommandProviderCache,
  writeCommandProviderCache,
}));

const { readThroughProviderCache } = await import("../utils/provider-cache");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  store.clear();
  readCommandProviderCache.mockClear();
  writeCommandProviderCache.mockClear();
  clock = 1_000_000;
});

describe("readThroughProviderCache", () => {
  const base = { softTtlSeconds: 300, hardTtlSeconds: 3600, now };

  it("computes and stores on the first call", async () => {
    let calls = 0;
    const value = await readThroughProviderCache({
      ...base,
      namespace: "ns-first",
      compute: async () => {
        calls += 1;
        return { a: 1 };
      },
    });
    expect(value).toEqual({ a: 1 });
    expect(calls).toBe(1);
    expect(writeCommandProviderCache).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh value without touching the provider", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { n: calls };
    };
    await readThroughProviderCache({ ...base, namespace: "ns-fresh", compute });
    clock += 100_000; // still inside the 300s soft window
    const second = await readThroughProviderCache({
      ...base,
      namespace: "ns-fresh",
      compute,
    });
    expect(second).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("returns the stale value immediately and refreshes behind it", async () => {
    let calls = 0;
    const gate = deferred<{ n: number }>();
    const compute = async () => {
      calls += 1;
      return calls === 1 ? { n: 1 } : gate.promise;
    };
    await readThroughProviderCache({ ...base, namespace: "ns-swr", compute });
    clock += 301_000; // past the soft age, inside the hard TTL

    // The caller must not wait on the refresh: this resolves while the second
    // compute is still pending. That is the whole point of the change.
    const stale = await readThroughProviderCache({
      ...base,
      namespace: "ns-swr",
      compute,
    });
    expect(stale).toEqual({ n: 1 });
    expect(calls).toBe(2);

    gate.resolve({ n: 2 });
    await settle();
    await settle();
    const after = await readThroughProviderCache({
      ...base,
      namespace: "ns-swr",
      compute,
    });
    expect(after).toEqual({ n: 2 });
  });

  it("single-flights the refresh across concurrent stale readers", async () => {
    let calls = 0;
    const gate = deferred<{ n: number }>();
    const compute = async () => {
      calls += 1;
      return calls === 1 ? { n: 1 } : gate.promise;
    };
    await readThroughProviderCache({ ...base, namespace: "ns-stampede", compute });
    clock += 301_000;
    const readers = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        readThroughProviderCache({ ...base, namespace: "ns-stampede", compute }),
      ),
    );
    expect(readers.every((r) => JSON.stringify(r) === JSON.stringify({ n: 1 }))).toBe(true);
    // One refresh for five stale readers, not five.
    expect(calls).toBe(2);
    gate.resolve({ n: 2 });
    await settle();
  });

  it("single-flights concurrent cold callers", async () => {
    let calls = 0;
    const gate = deferred<{ n: number }>();
    const compute = async () => {
      calls += 1;
      return gate.promise;
    };
    const all = Promise.all(
      [1, 2, 3].map(() =>
        readThroughProviderCache({ ...base, namespace: "ns-cold", compute }),
      ),
    );
    gate.resolve({ n: 7 });
    const results = await all;
    expect(calls).toBe(1);
    expect(results).toEqual([{ n: 7 }, { n: 7 }, { n: 7 }]);
  });

  it("keeps serving the last good value when a refresh fails", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) return { n: 1 };
      throw new Error("stripe is having a bad minute");
    };
    await readThroughProviderCache({ ...base, namespace: "ns-fail", compute });
    clock += 301_000;
    const stale = await readThroughProviderCache({
      ...base,
      namespace: "ns-fail",
      compute,
    });
    expect(stale).toEqual({ n: 1 });
    await settle();
    await settle();
    // The failed refresh must not have evicted the good value.
    clock += 1_000;
    const again = await readThroughProviderCache({
      ...base,
      namespace: "ns-fail",
      compute,
    });
    expect(again).toEqual({ n: 1 });
  });

  it("throws to the caller when there is nothing cached and the provider fails", async () => {
    await expect(
      readThroughProviderCache({
        ...base,
        namespace: "ns-cold-fail",
        compute: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toThrow("down");
  });

  it("refetches rather than trusting an entry that fails validation", async () => {
    // A shape written by older code, or a hand-edited key.
    store.set("ns-bad", { v: 1, softUntil: clock + 100_000, value: { legacy: true } });
    let calls = 0;
    const value = await readThroughProviderCache({
      ...base,
      namespace: "ns-bad",
      validate: (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "wanted" in (candidate as Record<string, unknown>),
      compute: async () => {
        calls += 1;
        return { wanted: true };
      },
    });
    expect(calls).toBe(1);
    expect(value).toEqual({ wanted: true });
  });

  it("ignores an entry that is not one of ours", async () => {
    store.set("ns-foreign", { some: "other shape" });
    let calls = 0;
    const value = await readThroughProviderCache({
      ...base,
      namespace: "ns-foreign",
      compute: async () => {
        calls += 1;
        return { ours: true };
      },
    });
    expect(calls).toBe(1);
    expect(value).toEqual({ ours: true });
  });

  it("passes the hard TTL to the store, not the soft one", async () => {
    await readThroughProviderCache({
      ...base,
      namespace: "ns-ttl",
      compute: async () => ({ a: 1 }),
    });
    expect(writeCommandProviderCache.mock.calls[0]?.[2]).toBe(3600);
  });
});
