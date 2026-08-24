import { describe, expect, test } from "bun:test";
import {
  COMMAND_REP_CREATE_INPUT,
  COMMAND_REP_UPDATE_INPUT,
  normalizeOptionalText,
} from "../command/rep-input";

describe("Command rep input", () => {
  test("accepts exact decimal draw metadata with an explicit currency", () => {
    const result = COMMAND_REP_CREATE_INPUT.safeParse({
      userId: "1d651927-000d-4e44-8f6e-d714af1d50d0",
      name: "Avery Sales",
      basePay: "2500.0000",
      currency: "CAD",
      ghlUserId: "ghl-user-1",
      startDate: "2026-08-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe("cad");
  });

  test("never accepts draw money without a currency", () => {
    const result = COMMAND_REP_CREATE_INPUT.safeParse({
      userId: "1d651927-000d-4e44-8f6e-d714af1d50d0",
      name: "Avery Sales",
      basePay: "2500",
      startDate: "2026-08-12T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  test("requires a real patch and supports clearing paired draw fields", () => {
    expect(COMMAND_REP_UPDATE_INPUT.safeParse({}).success).toBe(false);
    expect(
      COMMAND_REP_UPDATE_INPUT.safeParse({ basePay: null, currency: null }).success,
    ).toBe(true);
  });

  test("normalizes optional provider ids without inventing a value", () => {
    expect(normalizeOptionalText("  ghl-9  ")).toBe("ghl-9");
    expect(normalizeOptionalText(null)).toBeNull();
    expect(normalizeOptionalText(undefined)).toBeUndefined();
  });

  test("rejects a departure date before the employment start", () => {
    expect(COMMAND_REP_CREATE_INPUT.safeParse({
      userId: "1d651927-000d-4e44-8f6e-d714af1d50d0",
      name: "Test Rep",
      startDate: "2026-08-10T12:00:00.000Z",
      endDate: "2026-08-09T12:00:00.000Z",
      isActive: false,
    }).success).toBe(false);
  });
});
