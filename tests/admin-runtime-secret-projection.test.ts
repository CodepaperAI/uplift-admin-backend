import { describe, expect, test } from "bun:test";

const projectionScript = await Bun.file(
  "scripts/sync-production-runtime-secret.sh",
).text();

describe("production admin runtime secret projection", () => {
  test("includes every production credential used directly by the admin API", () => {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "STRIPE_SECRET_KEY",
      "REWARDFUL_API_SECRET",
      "INNGEST_EVENT_KEY",
      "GHL_COMMAND_READ_TOKEN",
      "GHL_COMMAND_LOCATION_ID",
      "GHL_COMMAND_CONTACTS_VERSION",
      "GHL_COMMAND_OPPORTUNITIES_VERSION",
      "GHL_COMMAND_PAYMENTS_VERSION",
      "GHL_COMMAND_CONVERSATIONS_VERSION",
      "GHL_COMMAND_CALENDARS_VERSION",
      "COMMAND_GHL_SYNC_ENABLED",
      "COMMAND_GHL_PAYMENTS_SYNC_ENABLED",
      "COMMAND_GHL_ACTIVITY_SYNC_ENABLED",
    ]) {
      expect(projectionScript).toContain(`"${key}"`);
    }
  });

  test("does not project core-owned webhook and worker signing credentials", () => {
    for (const key of [
      "STRIPE_WEBHOOK_SECRET",
      "REWARDFUL_WEBHOOK_SECRET",
      "INNGEST_SIGNING_KEY",
      "INNGEST_UI_BASIC_AUTH_HASH",
    ]) {
      expect(projectionScript).not.toContain(`"${key}"`);
    }
  });
});
