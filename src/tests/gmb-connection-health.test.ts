import { describe, expect, test } from "bun:test";
import {
  assessGmbConnectionHealth,
  getPublicGmbConnectionIssue,
} from "../utils/gmb-connection-health";

const now = new Date("2026-08-18T16:00:00.000Z");

function assess(
  overrides: Partial<Parameters<typeof assessGmbConnectionHealth>[0]> = {},
) {
  return assessGmbConnectionHealth(
    {
      accessTokenPresent: true,
      isActive: true,
      accountId: "account-1",
      locationId: "location-1",
      lastSyncAt: "2026-08-18T15:00:00.000Z",
      lastSyncError: null,
      ...overrides,
    },
    { now, staleAfterHours: 36 },
  );
}

describe("assessGmbConnectionHealth", () => {
  test("does not treat a missing credential as connected", () => {
    expect(assess({ accessTokenPresent: false })).toMatchObject({
      state: "disconnected",
      configured: false,
      operational: false,
    });
  });

  test("makes unfinished location selection explicit", () => {
    expect(
      assess({ isActive: false, accountId: null, locationId: null }),
    ).toMatchObject({
      state: "pending_location_selection",
      configured: false,
      operational: false,
    });
  });

  test("requires a successful sync before reporting operational", () => {
    expect(assess({ lastSyncAt: null })).toMatchObject({
      state: "sync_required",
      configured: true,
      operational: false,
    });
  });

  test("surfaces a provider sync failure without losing configuration", () => {
    expect(assess({ lastSyncError: "Google API returned 404" })).toMatchObject({
      state: "sync_error",
      configured: true,
      operational: false,
    });
  });

  test("classifies invalid or revoked OAuth credentials as reconnect required", () => {
    expect(
      assess({
        isActive: false,
        lastSyncError:
          "Google Business Profile reconnect required: refresh token is invalid or revoked",
      }),
    ).toMatchObject({
      state: "reconnect_required",
      operational: false,
    });
  });

  test("marks old successful syncs as stale", () => {
    expect(
      assess({ lastSyncAt: "2026-08-16T00:00:00.000Z" }),
    ).toMatchObject({
      state: "stale",
      configured: true,
      operational: false,
    });
  });

  test("reports healthy only for a configured recent successful sync", () => {
    expect(assess()).toMatchObject({
      state: "healthy",
      configured: true,
      operational: true,
      lastSyncAt: "2026-08-18T15:00:00.000Z",
    });
  });
});

describe("getPublicGmbConnectionIssue", () => {
  test("returns bounded remediation text instead of provider diagnostics", () => {
    expect(getPublicGmbConnectionIssue("sync_error")).toBe(
      "Google Business Profile could not be synced. Try again.",
    );
    expect(getPublicGmbConnectionIssue("reconnect_required")).toBe(
      "Reconnect Google Business Profile to renew access.",
    );
    expect(getPublicGmbConnectionIssue("healthy")).toBeNull();
  });
});
