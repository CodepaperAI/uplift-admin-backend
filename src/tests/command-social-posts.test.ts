import { describe, expect, it } from "bun:test";
import {
  parseSocialPlatformFilter,
  parseSocialStatusFilter,
  previewCaption,
  rollUpSocialClients,
  rollUpSocialPlatforms,
  isDuplicateSuppression,
  summariseAttemptStatuses,
  type SocialClientIdentity,
} from "../command/social-posts";

describe("parseSocialStatusFilter", () => {
  it("accepts a known status in any case", () => {
    expect(parseSocialStatusFilter("published")).toBe("PUBLISHED");
    expect(parseSocialStatusFilter("  Failed ")).toBe("FAILED");
  });

  it("ignores an unknown status rather than filtering to nothing", () => {
    // An empty table reads as "this client never posted". A typo must not say that.
    for (const value of ["posted", "", "  ", "DROP TABLE", null, undefined, 7]) {
      expect(parseSocialStatusFilter(value)).toBeNull();
    }
  });
});

describe("parseSocialPlatformFilter", () => {
  it("normalises case and whitespace", () => {
    expect(parseSocialPlatformFilter(" Instagram ")).toBe("instagram");
  });

  it("rejects empty and oversized values", () => {
    expect(parseSocialPlatformFilter("   ")).toBeNull();
    expect(parseSocialPlatformFilter("x".repeat(41))).toBeNull();
    expect(parseSocialPlatformFilter("x".repeat(40))).toBe("x".repeat(40));
  });
});

describe("summariseAttemptStatuses", () => {
  it("totals each outcome and folds SUBMITTING into pending", () => {
    const totals = summariseAttemptStatuses([
      { status: "PUBLISHED", count: 8 },
      { status: "FAILED", count: 2 },
      { status: "SCHEDULED", count: 5 },
      { status: "PENDING", count: 1 },
      { status: "SUBMITTING", count: 3 },
      { status: "CANCELLED", count: 0 },
    ]);
    expect(totals.attempts).toBe(19);
    expect(totals.published).toBe(8);
    expect(totals.failed).toBe(2);
    expect(totals.scheduled).toBe(5);
    expect(totals.pending).toBe(4);
  });

  it("excludes work still in flight from the success rate", () => {
    // 8 of 10 settled, not 8 of 19 — a week of scheduled posts is not a failure.
    const totals = summariseAttemptStatuses([
      { status: "PUBLISHED", count: 8 },
      { status: "FAILED", count: 2 },
      { status: "SCHEDULED", count: 9 },
    ]);
    expect(totals.successRatePercent).toBe("80.00");
  });

  it("reports no rate when nothing has settled", () => {
    const totals = summariseAttemptStatuses([{ status: "SCHEDULED", count: 4 }]);
    expect(totals.successRatePercent).toBeNull();
    expect(totals.attempts).toBe(4);
  });

  it("counts an unrecognised status toward attempts but no bucket", () => {
    // The provider owns this string; a new state must not vanish from the total.
    const totals = summariseAttemptStatuses([
      { status: "PUBLISHED", count: 1 },
      { status: "SOMETHING_NEW", count: 5 },
    ]);
    expect(totals.attempts).toBe(6);
    expect(totals.published).toBe(1);
  });

  it("is zero everywhere for an empty window", () => {
    const totals = summariseAttemptStatuses([]);
    expect(totals.attempts).toBe(0);
    expect(totals.successRatePercent).toBeNull();
  });
});

describe("rollUpSocialPlatforms", () => {
  it("groups by platform, busiest first", () => {
    const rows = rollUpSocialPlatforms([
      { platform: "instagram", status: "PUBLISHED", count: 10 },
      { platform: "instagram", status: "FAILED", count: 2 },
      { platform: "facebook", status: "PUBLISHED", count: 4 },
    ]);
    expect(rows.map((row) => row.platform)).toEqual(["instagram", "facebook"]);
    expect(rows[0]?.attempts).toBe(12);
    expect(rows[0]?.successRatePercent).toBe("83.33");
  });

  it("labels a blank platform rather than dropping the row", () => {
    const rows = rollUpSocialPlatforms([
      { platform: "", status: "FAILED", count: 3 },
    ]);
    expect(rows[0]?.platform).toBe("unknown");
    expect(rows[0]?.failed).toBe(3);
  });
});

describe("rollUpSocialClients", () => {
  const identities = new Map<string, SocialClientIdentity>([
    [
      "b1",
      {
        businessId: "b1",
        businessName: "Jang Tire Services",
        websiteUrl: "https://jangtires.ca",
        ownerEmail: "jangtires@gmail.com",
        ownerName: "Jang",
      },
    ],
  ]);

  it("attaches identity, platforms and last-published to each client", () => {
    const rows = rollUpSocialClients({
      counts: [
        { businessId: "b1", status: "PUBLISHED", count: 6 },
        { businessId: "b1", status: "FAILED", count: 1 },
      ],
      identities,
      platformsByBusiness: new Map([["b1", ["instagram", "facebook"]]]),
      connectedAccountsByBusiness: new Map([["b1", 2]]),
      lastPublishedByBusiness: new Map([
        ["b1", new Date("2026-08-27T14:00:00.000Z")],
      ]),
      lastAttemptByBusiness: new Map([
        ["b1", new Date("2026-08-28T09:00:00.000Z")],
      ]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.businessName).toBe("Jang Tire Services");
    expect(rows[0]?.ownerEmail).toBe("jangtires@gmail.com");
    // Sorted, so the column does not reorder itself between requests.
    expect(rows[0]?.platforms).toEqual(["facebook", "instagram"]);
    expect(rows[0]?.connectedAccounts).toBe(2);
    expect(rows[0]?.lastPublishedAt).toBe("2026-08-27T14:00:00.000Z");
    expect(rows[0]?.attempts).toBe(7);
  });

  it("keeps a client whose every attempt failed", () => {
    // The row most worth seeing. Dropping it turns a delivery failure into an
    // absence, which reads as "this client has nothing scheduled".
    const rows = rollUpSocialClients({
      counts: [{ businessId: "b1", status: "FAILED", count: 4 }],
      identities,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failed).toBe(4);
    expect(rows[0]?.published).toBe(0);
    expect(rows[0]?.successRatePercent).toBe("0.00");
  });

  it("still returns a client whose business record is missing", () => {
    const rows = rollUpSocialClients({
      counts: [{ businessId: "ghost", status: "PUBLISHED", count: 2 }],
      identities,
    });
    expect(rows[0]?.businessId).toBe("ghost");
    expect(rows[0]?.businessName).toBeNull();
    expect(rows[0]?.published).toBe(2);
  });

  it("orders by attempts, then by name for a stable tie", () => {
    const rows = rollUpSocialClients({
      counts: [
        { businessId: "b1", status: "PUBLISHED", count: 1 },
        { businessId: "b2", status: "PUBLISHED", count: 9 },
        { businessId: "b3", status: "PUBLISHED", count: 1 },
      ],
      identities: new Map([
        ...identities,
        ["b2", { businessId: "b2", businessName: "Zeta", websiteUrl: null, ownerEmail: null, ownerName: null }],
        ["b3", { businessId: "b3", businessName: "Alpha", websiteUrl: null, ownerEmail: null, ownerName: null }],
      ]),
    });
    expect(rows.map((row) => row.businessId)).toEqual(["b2", "b3", "b1"]);
  });

  it("defaults counters when no side tables are supplied", () => {
    const rows = rollUpSocialClients({
      counts: [{ businessId: "b1", status: "PUBLISHED", count: 1 }],
      identities,
    });
    expect(rows[0]?.platforms).toEqual([]);
    expect(rows[0]?.connectedAccounts).toBe(0);
    expect(rows[0]?.lastPublishedAt).toBeNull();
  });
});

describe("previewCaption", () => {
  it("passes a short caption through untouched", () => {
    expect(previewCaption("New winter tyres in stock")).toEqual({
      text: "New winter tyres in stock",
      truncated: false,
    });
  });

  it("cuts a long caption and says that it did", () => {
    const result = previewCaption("a".repeat(400));
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(241); // 240 plus the ellipsis
  });

  it("treats an absent caption as empty rather than throwing", () => {
    expect(previewCaption(null)).toEqual({ text: "", truncated: false });
    expect(previewCaption(undefined).text).toBe("");
  });

  it("trims before measuring, so padding does not force a cut", () => {
    const padded = `   ${"b".repeat(240)}   `;
    expect(previewCaption(padded).truncated).toBe(false);
  });
});

describe("isDuplicateSuppression", () => {
  it("matches the 409 the client derives from the HTTP status", () => {
    expect(isDuplicateSuppression("ZERNIO_HTTP_409", null)).toBe(true);
  });

  it("matches the provider message when the code is something else", () => {
    // The day the provider sends a named code instead of a bare status.
    expect(
      isDuplicateSuppression(
        "SOME_NAMED_CODE",
        "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
      ),
    ).toBe(true);
  });

  it("matches a code that names duplication outright", () => {
    expect(isDuplicateSuppression("DUPLICATE_CONTENT", null)).toBe(true);
  });

  it("does not match a real delivery failure", () => {
    for (const [code, message] of [
      ["ZERNIO_POST_FAILED", "Zernio could not publish this post"],
      ["ZERNIO_HTTP_403", "Application does not have permission for this action"],
      ["SOCIAL_ACCOUNT_RECONNECT_REQUIRED", "The social account authorization has expired."],
      [null, null],
      ["", ""],
    ] as const) {
      expect(isDuplicateSuppression(code, message)).toBe(false);
    }
  });

  it("does not match a 409 that is only part of a longer number", () => {
    // ZERNIO_HTTP_4090 is not a 409, and a substring test would say it was.
    expect(isDuplicateSuppression("ZERNIO_HTTP_4090", null)).toBe(false);
    expect(isDuplicateSuppression("ERR_1409X", null)).toBe(false);
  });
});
