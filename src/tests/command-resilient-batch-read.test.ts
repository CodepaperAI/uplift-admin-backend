import { describe, expect, it } from "bun:test";
import { resilientBatchRead } from "../utils/resilient-batch-read";

type Row = { id: string };

/** A reader that throws whenever the requested slice contains a poison id. */
function readerRejecting(poison: Set<string>) {
  let calls = 0;
  const read = async (ids: string[]): Promise<Row[]> => {
    calls += 1;
    if (ids.some((id) => poison.has(id))) {
      throw new Error("Inconsistent query result: field is required");
    }
    return ids.map((id) => ({ id }));
  };
  return { read, calls: () => calls };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

describe("resilientBatchRead", () => {
  it("costs exactly one query when nothing is wrong", async () => {
    const reader = readerRejecting(new Set());
    const result = await resilientBatchRead({ ids: ids(500), read: reader.read });
    expect(result.cleanRead).toBe(true);
    expect(result.rows).toHaveLength(500);
    expect(result.failedIds).toEqual([]);
    // The normal path must not pay for the failure path.
    expect(reader.calls()).toBe(1);
  });

  it("returns every readable row and names the one that is not", async () => {
    const reader = readerRejecting(new Set(["u137"]));
    const result = await resilientBatchRead({ ids: ids(500), read: reader.read });
    expect(result.cleanRead).toBe(false);
    expect(result.failedIds).toEqual(["u137"]);
    // 499 of 500 is the whole point: the page renders instead of blanking.
    expect(result.rows).toHaveLength(499);
    expect(result.rows.some((row) => row.id === "u137")).toBe(false);
  });

  it("isolates several bad rows", async () => {
    const reader = readerRejecting(new Set(["u3", "u250", "u499"]));
    const result = await resilientBatchRead({ ids: ids(500), read: reader.read });
    expect(result.failedIds.sort()).toEqual(["u250", "u3", "u499"]);
    expect(result.rows).toHaveLength(497);
  });

  it("bisects rather than probing every id", async () => {
    const reader = readerRejecting(new Set(["u137"]));
    await resilientBatchRead({ ids: ids(500), read: reader.read });
    // Linear probing would be 500+ queries; halving is far fewer.
    expect(reader.calls()).toBeLessThan(60);
  });

  it("reports each failure with the error that caused it", async () => {
    const seen: Array<{ id: string; message: string }> = [];
    const reader = readerRejecting(new Set(["u2"]));
    await resilientBatchRead({
      ids: ids(10),
      read: reader.read,
      onRowFailure: (id, error) =>
        seen.push({
          id,
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe("u2");
    expect(seen[0]?.message).toContain("Inconsistent query result");
  });

  it("handles every row being unreadable without looping forever", async () => {
    const reader = readerRejecting(new Set(ids(8)));
    const result = await resilientBatchRead({ ids: ids(8), read: reader.read });
    expect(result.rows).toEqual([]);
    expect(result.failedIds.sort()).toEqual(ids(8).sort());
  });

  it("does no work for an empty id list", async () => {
    const reader = readerRejecting(new Set());
    const result = await resilientBatchRead({ ids: [], read: reader.read });
    expect(result).toEqual({ rows: [], failedIds: [], cleanRead: true });
    expect(reader.calls()).toBe(0);
  });

  it("deduplicates ids before reading", async () => {
    const reader = readerRejecting(new Set());
    const result = await resilientBatchRead({
      ids: ["a", "a", "b"],
      read: reader.read,
    });
    expect(result.rows).toHaveLength(2);
  });

  it("survives a single id that is itself the poison", async () => {
    const reader = readerRejecting(new Set(["only"]));
    const result = await resilientBatchRead({ ids: ["only"], read: reader.read });
    expect(result.rows).toEqual([]);
    expect(result.failedIds).toEqual(["only"]);
  });
});
