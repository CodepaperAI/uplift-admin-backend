import { describe, expect, test } from "bun:test";
import { parseCommandStripeMonthlyMovement } from "../command/stripe-monthly-rollup.service";

describe("Command Stripe monthly rollup", () => {
  test("accepts exact serialized movement payloads", () => {
    expect(
      parseCommandStripeMonthlyMovement({
        openingMrrMinorByCurrency: { cad: "9900.0000" },
        newMrrMinorByCurrency: { cad: "9900.0000" },
        churnedMrrMinorByCurrency: { cad: "0.0000" },
        revenueChurnPercentByCurrency: { cad: "0.00" },
        openingAccounts: 1,
        churnedAccounts: 0,
        logoChurnPercent: "0.00",
      }),
    ).not.toBeNull();
  });

  test("rejects malformed cached JSON so the source facts are recomputed", () => {
    expect(
      parseCommandStripeMonthlyMovement({
        openingMrrMinorByCurrency: { cad: 9900 },
      }),
    ).toBeNull();
  });
});
