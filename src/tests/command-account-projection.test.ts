import { describe, expect, test } from "bun:test";
import {
  canMergeCommandAccountIdentity,
  normalizeCommandAccountEmail,
} from "../command/account-projection.service";

describe("Command account identity", () => {
  test("normalizes exact email identity for cross-provider joins", () => {
    expect(normalizeCommandAccountEmail("  Client@Example.COM ")).toBe(
      "client@example.com",
    );
  });

  test("does not create a join key from missing or malformed provider data", () => {
    expect(normalizeCommandAccountEmail(null)).toBeNull();
    expect(normalizeCommandAccountEmail("not-an-email")).toBeNull();
  });

  test("never overwrites a different stable provider identity on email collision", () => {
    expect(
      canMergeCommandAccountIdentity(
        { stripeCustomerId: "cus_1", ghlContactId: "contact_1" },
        { ghlContactId: "contact_2" },
      ),
    ).toBe(false);
    expect(
      canMergeCommandAccountIdentity(
        { stripeCustomerId: "cus_1", ghlContactId: null },
        { ghlContactId: "contact_2" },
      ),
    ).toBe(true);
  });
});
