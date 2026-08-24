import { describe, expect, it } from "bun:test";
import {
  dedupByNormalized,
  dedupStringsByNormalized,
  normalizeQueryForDedup,
} from "../utils/query-dedup.utils";

describe("normalizeQueryForDedup", () => {
  it("collapses near-duplicate phrasings that differ only in filler words", () => {
    // "does" and "a" are filler words — both phrasings normalize to the
    // same token set once filler + punctuation are stripped.
    const a = normalizeQueryForDedup("How much does plumbing cost?");
    const b = normalizeQueryForDedup("how much is a plumbing cost");
    expect(a).toBe(b);
  });

  it("case and punctuation insensitive", () => {
    expect(normalizeQueryForDedup("Plumbing Cost?")).toBe(
      normalizeQueryForDedup("plumbing cost"),
    );
    expect(normalizeQueryForDedup("plumbing, cost!")).toBe(
      normalizeQueryForDedup("plumbing cost"),
    );
  });

  it("order-insensitive", () => {
    expect(normalizeQueryForDedup("plumbing cost")).toBe(
      normalizeQueryForDedup("cost plumbing"),
    );
  });

  it("distinct queries produce distinct keys", () => {
    const a = normalizeQueryForDedup("how much does plumbing cost");
    const b = normalizeQueryForDedup("how to fix a leaking pipe");
    expect(a).not.toBe(b);
  });

  it("returns empty string for empty / filler-only input", () => {
    expect(normalizeQueryForDedup("")).toBe("");
    expect(normalizeQueryForDedup("the a is?")).toBe("");
  });
});

describe("dedupByNormalized", () => {
  it("preserves first-occurrence order", () => {
    const items = [
      { query: "How much does plumbing cost?" },
      { query: "Best plumbers near me" },
      { query: "how much is a plumbing cost" }, // near-dup of first → drop
      { query: "best plumbers near me" }, // case-dup after normalize → drop
    ];
    const out = dedupByNormalized(items);
    expect(out.map((i) => i.query)).toEqual([
      "How much does plumbing cost?",
      "Best plumbers near me",
    ]);
  });

  it("works on string arrays via dedupStringsByNormalized", () => {
    const out = dedupStringsByNormalized([
      "How much does plumbing cost?",
      "how much is a plumbing cost", // filler-words only differ
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe("How much does plumbing cost?");
  });

  it("drops empty / filler-only queries entirely", () => {
    const out = dedupByNormalized([
      { query: "" },
      { query: "the a is?" },
      { query: "plumbing cost" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.query).toBe("plumbing cost");
  });
});
