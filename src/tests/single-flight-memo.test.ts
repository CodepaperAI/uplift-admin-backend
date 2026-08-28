import { describe, expect, it } from "bun:test";
import { createSingleFlightMemo } from "../utils/single-flight-memo";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlightMemo", () => {
  it("collapses concurrent callers onto one computation", async () => {
    const memo = createSingleFlightMemo<number>({ ttlMs: 1_000, maxEntries: 4 });
    let calls = 0;
    const gate = deferred<number>();
    const compute = () => {
      calls += 1;
      return gate.promise;
    };
    // Exactly the shape the corpus walk produces: three requests for three
    // slices of one dataset, in flight at the same time.
    const all = Promise.all([
      memo.get("k", compute),
      memo.get("k", compute),
      memo.get("k", compute),
    ]);
    gate.resolve(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(calls).toBe(1);
  });

  it("serves a settled value within the TTL", async () => {
    let now = 1_000;
    const memo = createSingleFlightMemo<number>({
      ttlMs: 500,
      maxEntries: 4,
      now: () => now,
    });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await memo.get("k", compute)).toBe(1);
    now = 1_400;
    expect(await memo.get("k", compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it("recomputes once the TTL has passed", async () => {
    let now = 1_000;
    const memo = createSingleFlightMemo<number>({
      ttlMs: 500,
      maxEntries: 4,
      now: () => now,
    });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await memo.get("k", compute)).toBe(1);
    now = 1_500;
    expect(await memo.get("k", compute)).toBe(2);
  });

  it("keys are independent", async () => {
    const memo = createSingleFlightMemo<string>({ ttlMs: 1_000, maxEntries: 4 });
    expect(await memo.get("a", async () => "A")).toBe("A");
    expect(await memo.get("b", async () => "B")).toBe("B");
    expect(await memo.get("a", async () => "changed")).toBe("A");
  });

  it("evicts a rejection instead of serving it for the whole TTL", async () => {
    const memo = createSingleFlightMemo<number>({ ttlMs: 10_000, maxEntries: 4 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return 42;
    };
    await expect(memo.get("k", compute)).rejects.toThrow("transient");
    // The next caller must get a real attempt, not the cached failure.
    expect(await memo.get("k", compute)).toBe(42);
    expect(calls).toBe(2);
  });

  it("still surfaces the error to every concurrent caller", async () => {
    const memo = createSingleFlightMemo<number>({ ttlMs: 10_000, maxEntries: 4 });
    const gate = deferred<number>();
    const first = memo.get("k", () => gate.promise);
    const second = memo.get("k", () => gate.promise);
    gate.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });

  it("holds no more than maxEntries", async () => {
    const memo = createSingleFlightMemo<number>({ ttlMs: 10_000, maxEntries: 2 });
    await memo.get("a", async () => 1);
    await memo.get("b", async () => 2);
    await memo.get("c", async () => 3);
    expect(memo.size()).toBeLessThanOrEqual(2);
    // The newest key survives the eviction.
    expect(await memo.get("c", async () => 99)).toBe(3);
  });

  it("reports zero once everything has expired", async () => {
    let now = 0;
    const memo = createSingleFlightMemo<number>({
      ttlMs: 100,
      maxEntries: 4,
      now: () => now,
    });
    await memo.get("a", async () => 1);
    expect(memo.size()).toBe(1);
    now = 200;
    expect(memo.size()).toBe(0);
  });
});
