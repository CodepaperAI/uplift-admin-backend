import { describe, expect, it } from "bun:test";
import { summarizeOffPageRefreshBackfill } from "../scripts/offpage-refresh-caches";

describe("summarizeOffPageRefreshBackfill", () => {
  it("summarizes dry-run candidates without claiming queued work", () => {
    const summary = summarizeOffPageRefreshBackfill(
      [
        {
          businessId: "b1",
          userId: "u1",
          businessName: "Business 1",
          generatedAt: "2026-06-22T00:00:00.000Z",
          expiresAt: "2026-06-29T00:00:00.000Z",
          reason: "expired_and_legacy_v2_metadata",
        },
        {
          businessId: "b2",
          userId: "u2",
          businessName: "Business 2",
          generatedAt: "2026-06-30T00:00:00.000Z",
          expiresAt: "2026-07-07T00:00:00.000Z",
          reason: "legacy_v2_metadata",
        },
      ],
      { commit: false },
      0,
    );

    expect(summary.commit).toBe(false);
    expect(summary.queued).toBe(0);
    expect(summary.candidateCount).toBe(2);
    expect(summary.reasons).toEqual({
      expired_and_legacy_v2_metadata: 1,
      legacy_v2_metadata: 1,
    });
    expect(summary.note).toContain("Dry run only");
  });
});
