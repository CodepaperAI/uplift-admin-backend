import { describe, expect, test } from "bun:test";
import {
  commandDealCorrectionKey,
  COMMAND_DEAL_SERVICE_CORRECTION_INPUT,
  COMMAND_DEAL_SOURCE_TYPES,
} from "../command/deal-service-correction";

describe("Command deal service corrections", () => {
  test("accepts a real service and a meaningful reason", () => {
    expect(
      COMMAND_DEAL_SERVICE_CORRECTION_INPUT.safeParse({
        serviceId: "1d651927-000d-4e44-8f6e-d714af1d50d0",
        reason: "The provider product label maps to GEO SEO.",
      }).success,
    ).toBe(true);
    expect(
      COMMAND_DEAL_SERVICE_CORRECTION_INPUT.safeParse({
        serviceId: "not-a-uuid",
        reason: "The provider product label maps to GEO SEO.",
      }).success,
    ).toBe(false);
  });

  test("uses only commission-supported source types and collision-safe keys", () => {
    expect(COMMAND_DEAL_SOURCE_TYPES).toEqual([
      "stripe_subscription",
      "ghl_subscription",
      "ghl_transaction",
      "legacy_sale",
    ]);
    expect(commandDealCorrectionKey("ab", "c")).not.toBe(
      commandDealCorrectionKey("a", "bc"),
    );
  });
});
