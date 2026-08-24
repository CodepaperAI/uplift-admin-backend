import { describe, expect, test } from "bun:test";
import {
  COMMAND_DECISION_DEFINITIONS,
  parseCommandDecisionValue,
} from "../command/decision-policy";

describe("Command decision policy contracts", () => {
  test("accepts every supported compensation option", () => {
    for (const windowDays of [0, 30, 60, 90]) {
      expect(parseCommandDecisionValue("clawback_policy", { windowDays })).toEqual({ windowDays });
    }
    for (const type of ["recoverable", "non_recoverable"]) {
      expect(parseCommandDecisionValue("draw_policy", { type })).toEqual({ type });
    }
    for (const policy of ["stop_on_departure", "continue_residual"]) {
      expect(parseCommandDecisionValue("departing_rep_residuals", { policy })).toEqual({ policy });
    }
    for (const policy of ["single_owner", "split_credit"]) {
      expect(parseCommandDecisionValue("deal_credit_policy", { policy })).toEqual({ policy });
    }
    expect(parseCommandDecisionValue("currency_policy", { mode: "separate_currency" })).toEqual({
      mode: "separate_currency",
    });
    expect(parseCommandDecisionValue("currency_policy", {
      mode: "base_currency",
      baseCurrency: "CAD",
      fxSource: "Bank of Canada daily rate",
      fxRates: { USD: "1.35000000" },
    })).toEqual({
      mode: "base_currency",
      baseCurrency: "cad",
      fxSource: "Bank of Canada daily rate",
      fxRates: { usd: "1.35000000" },
    });
  });

  test("accepts both GHL attribution paths and requires the custom-field ID", () => {
    expect(parseCommandDecisionValue("ghl_service_attribution", { method: "pipeline" })).toEqual({
      method: "pipeline",
    });
    expect(parseCommandDecisionValue("ghl_service_attribution", {
      method: "custom_field",
      customFieldId: "PAvLVnl0FIDcduWvsrGH",
    })).toEqual({ method: "custom_field", customFieldId: "PAvLVnl0FIDcduWvsrGH" });
    expect(() => parseCommandDecisionValue("ghl_service_attribution", {
      method: "custom_field",
    })).toThrow("A GHL custom field id is required");
  });

  test("accepts the locked-history and provider-override policies", () => {
    expect(parseCommandDecisionValue("past_due_release_policy", {
      policy: "current_open_period_adjustment",
    })).toEqual({ policy: "current_open_period_adjustment" });
    expect(parseCommandDecisionValue("provider_override_policy", {
      precedence: "approved_override_after_provider",
    })).toEqual({ precedence: "approved_override_after_provider" });
  });

  test("keeps all Decision Center definitions unique", () => {
    const keys = COMMAND_DECISION_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("ships a valid recommended value for every operating decision", () => {
    for (const definition of COMMAND_DECISION_DEFINITIONS) {
      expect(
        parseCommandDecisionValue(definition.key, definition.recommendedValue),
      ).toEqual(definition.recommendedValue);
    }
  });
});
