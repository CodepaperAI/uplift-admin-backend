import { describe, expect, it } from "bun:test";
import {
  filterGoogleReviewsToWindow,
  getGmbReviewWindowStart,
  shouldStopGoogleReviewPagination,
} from "../utils/gmb-review-window.utils";

describe("GMB review window helpers", () => {
  it("uses a calendar six-month cutoff", () => {
    expect(getGmbReviewWindowStart(new Date("2026-04-29T12:00:00.000Z")).toISOString()).toBe(
      "2025-10-29T12:00:00.000Z",
    );
  });

  it("keeps only reviews created inside the six-month window", () => {
    const cutoff = new Date("2025-10-29T12:00:00.000Z");
    const reviews = [
      { name: "recent", createTime: "2026-01-01T00:00:00.000Z" },
      { name: "boundary", createTime: "2025-10-29T12:00:00.000Z" },
      { name: "old", createTime: "2025-10-01T00:00:00.000Z" },
    ];

    expect(filterGoogleReviewsToWindow(reviews, cutoff).map((r) => r.name)).toEqual([
      "recent",
      "boundary",
    ]);
  });

  it("stops pagination only when the whole page is older than the cutoff", () => {
    const cutoff = new Date("2025-10-29T12:00:00.000Z");

    expect(
      shouldStopGoogleReviewPagination(
        [
          { createTime: "2025-10-01T00:00:00.000Z" },
          { createTime: "2025-09-01T00:00:00.000Z" },
        ],
        cutoff,
      ),
    ).toBe(true);

    expect(
      shouldStopGoogleReviewPagination(
        [
          { createTime: "2025-10-01T00:00:00.000Z" },
          { createTime: "2026-01-01T00:00:00.000Z" },
        ],
        cutoff,
      ),
    ).toBe(false);
  });
});
