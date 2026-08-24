import { describe, expect, test } from "bun:test";
import { normalizeCommandCostBucket } from "../command/cost-bucket";
import { COMMAND_COST_INPUT } from "../command/cost-input";

const validCost = {
  category: "delivery",
  costCategory: "LLM usage",
  vendor: "OpenAI",
  amountMinor: "12500",
  currency: "CAD",
  description: "Content generation usage",
  occurredAt: "2026-08-18T16:00:00.000Z",
};

describe("Command cost classification", () => {
  test("accepts only the two binding cost buckets", () => {
    expect(COMMAND_COST_INPUT.safeParse(validCost).success).toBe(true);
    expect(
      COMMAND_COST_INPUT.safeParse({ ...validCost, category: "acquisition" })
        .success,
    ).toBe(true);
    expect(
      COMMAND_COST_INPUT.safeParse({ ...validCost, category: "system" })
        .success,
    ).toBe(false);
  });

  test("counts legacy system/tooling rows as delivery cost", () => {
    expect(normalizeCommandCostBucket("system")).toBe("delivery");
    expect(normalizeCommandCostBucket("delivery")).toBe("delivery");
    expect(normalizeCommandCostBucket("acquisition")).toBe("acquisition");
    expect(normalizeCommandCostBucket("unknown")).toBeNull();
  });
});
