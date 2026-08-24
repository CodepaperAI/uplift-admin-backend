import { describe, expect, test } from "bun:test";
import {
  COMMAND_SERVICE_CREATE_INPUT,
  COMMAND_SERVICE_UPDATE_INPUT,
  uniqueProviderIds,
} from "../command/service-input";

describe("Command service input", () => {
  test("accepts exact minor-unit prices and normalizes currency", () => {
    const result = COMMAND_SERVICE_CREATE_INPUT.safeParse({
      key: "geo-seo",
      name: "UpliftAI GEO/SEO",
      kind: "subscription",
      listPriceMinor: "9900",
      currency: "CAD",
      stripePriceIds: ["price_monthly"],
      ghlPipelineIds: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe("cad");
  });

  test("rejects unpaired money and currency", () => {
    expect(
      COMMAND_SERVICE_CREATE_INPUT.safeParse({
        key: "website",
        name: "Website design",
        kind: "one_time",
        listPriceMinor: "250000",
        currency: null,
      }).success,
    ).toBe(false);
  });

  test("does not accept unsigned commission rate fields", () => {
    const result = COMMAND_SERVICE_CREATE_INPUT.safeParse({
      key: "geo-seo",
      name: "UpliftAI GEO/SEO",
      kind: "subscription",
      listPriceMinor: "9900",
      currency: "cad",
      firstRate: "0.5",
      recurringRate: "0.1",
    });
    expect(result.success).toBe(false);
  });

  test("requires a real update and deduplicates provider mappings", () => {
    expect(COMMAND_SERVICE_UPDATE_INPUT.safeParse({}).success).toBe(false);
    expect(uniqueProviderIds([" pipe-2 ", "pipe-1", "pipe-2"]))
      .toEqual(["pipe-1", "pipe-2"]);
  });
});
