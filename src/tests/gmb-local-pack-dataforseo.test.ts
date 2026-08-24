// Local Pack feature: verify the parser logic in isolation.
//
// We test `extractLocalPackEntries` (the SERP-item walker) and
// `normalizeDataForSEOLocalMapItems` (the per-item normalizer) directly
// rather than mocking node-fetch — that mocking is fragile in bun:test when
// the module is already loaded by sibling test files.

import { describe, expect, it } from "bun:test";

import {
  extractLocalPackEntries,
  normalizeDataForSEOLocalMapItems,
} from "../utils/dataforseo.utils";

function entriesFromSerp(items: unknown[]) {
  return Array.from(extractLocalPackEntries(items));
}

describe("extractLocalPackEntries", () => {
  it("yields each local_pack item in flat shape", () => {
    const items = [
      { type: "organic", title: "Just a web result" },
      { type: "local_pack", title: "Mr. Shawarma", place_id: "p-1" },
      { type: "local_pack", title: "Shawarma Express", place_id: "p-2" },
      { type: "people_also_ask", title: "PAA" },
    ];

    const entries = entriesFromSerp(items);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.title)).toEqual(["Mr. Shawarma", "Shawarma Express"]);
  });

  it("yields inner items when a container has type=local_pack with nested items array", () => {
    const items = [
      {
        type: "local_pack",
        items: [
          { title: "Nested A", place_id: "n-a" },
          { title: "Nested B", place_id: "n-b" },
          { title: "Nested C", place_id: "n-c" },
        ],
      },
    ];

    const entries = entriesFromSerp(items);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.title)).toEqual(["Nested A", "Nested B", "Nested C"]);
  });

  it("returns nothing when no local_pack items exist", () => {
    const items = [
      { type: "organic", title: "x" },
      { type: "people_also_ask", items: [{ q: "?" }] },
      { type: "knowledge_graph", title: "kg" },
    ];
    expect(entriesFromSerp(items)).toEqual([]);
  });

  it("ignores malformed entries", () => {
    const items = [
      null,
      "string-not-object",
      { type: "local_pack", title: "Valid" },
      undefined,
      42,
    ];
    const entries = entriesFromSerp(items);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Valid");
  });

  it("skips non-object inner entries inside a container", () => {
    const items = [
      {
        type: "local_pack",
        items: [{ title: "Real" }, null, "string", 42, { title: "AlsoReal" }],
      },
    ];
    const entries = entriesFromSerp(items);
    expect(entries.map((e) => e.title)).toEqual(["Real", "AlsoReal"]);
  });
});

describe("normalizeDataForSEOLocalMapItems with local-pack entries", () => {
  it("normalizes a Google rating object shape", () => {
    const result = normalizeDataForSEOLocalMapItems("shawarma toronto", [
      {
        title: "Mr. Shawarma",
        rank_group: 1,
        rank_absolute: 1,
        place_id: "place-1",
        rating: { value: 4.5, votes_count: 234 },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Mr. Shawarma",
      placeId: "place-1",
      rating: 4.5,
      reviewCount: 234,
      rankGroup: 1,
      rankAbsolute: 1,
    });
  });

  it("normalizes a flat rating number", () => {
    const result = normalizeDataForSEOLocalMapItems("k", [
      { title: "X", rating: 4.2, review_count: 89 },
    ]);
    expect(result[0]!.rating).toBe(4.2);
    expect(result[0]!.reviewCount).toBe(89);
  });

  it("handles missing rating gracefully", () => {
    const result = normalizeDataForSEOLocalMapItems("k", [
      { title: "No-rating biz", place_id: "p-x" },
    ]);
    expect(result[0]).toMatchObject({ title: "No-rating biz", rating: null, reviewCount: null });
  });

  it("filters out non-object items", () => {
    const result = normalizeDataForSEOLocalMapItems("k", [
      { title: "Real" },
      null,
      "string",
      42,
    ] as unknown[]);
    expect(result).toHaveLength(1);
  });
});
