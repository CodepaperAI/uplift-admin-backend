import { describe, expect, it } from "bun:test";
import { isProviderManagedCostSource } from "../command/cost-source-policy";

describe("Command cost source policy", () => {
  it("allows edits only for audited manual rows", () => {
    expect(isProviderManagedCostSource("manual")).toBe(false);
    expect(isProviderManagedCostSource("meta_api")).toBe(true);
    expect(isProviderManagedCostSource("google_ads")).toBe(true);
  });
});
