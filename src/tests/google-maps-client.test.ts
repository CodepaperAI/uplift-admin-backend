import { describe, expect, it } from "bun:test";
import { normalizePlacesRegionCode } from "../lib/google-maps.client";

describe("Google Maps Places client", () => {
  it("normalizes country names and aliases to CLDR region codes", () => {
    expect(normalizePlacesRegionCode("Canada")).toBe("CA");
    expect(normalizePlacesRegionCode("United States")).toBe("US");
    expect(normalizePlacesRegionCode("UK")).toBe("GB");
  });

  it("maps common subdivision values to their parent country", () => {
    expect(normalizePlacesRegionCode("ON")).toBe("CA");
    expect(normalizePlacesRegionCode("Ontario")).toBe("CA");
    expect(normalizePlacesRegionCode("California")).toBe("US");
  });

  it("does not pass unknown two-letter values through to Places", () => {
    expect(normalizePlacesRegionCode("ZZ")).toBeUndefined();
  });
});
