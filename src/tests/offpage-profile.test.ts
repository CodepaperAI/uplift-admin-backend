import { describe, expect, it } from "bun:test";
import { buildOffPageProfile } from "../services/offpage/offpage-opportunities.service";

describe("buildOffPageProfile", () => {
  it("local service business with a city → location-dependent, local scope", () => {
    const p = buildOffPageProfile({
      id: "b1",
      businessName: "Moose Catering",
      businessType: "Catering Services",
      businessCity: "Calgary",
      businessCountry: "Canada",
      keywords: [{ keyword: "catering calgary" }, { keyword: "wedding catering" }],
    });
    expect(p.businessModelType).toBe("service");
    expect(p.isLocationDependent).toBe(true);
    expect(p.scope).toBe("local");
    expect(p.keywords).toEqual(["catering calgary", "wedding catering"]);
    expect(p.country).toBe("Canada");
  });

  it("e-commerce / product business → not location-dependent", () => {
    const p = buildOffPageProfile({
      id: "b2",
      businessName: "Sole Co",
      businessType: "ecommerce shoe store",
      businessCity: "Toronto",
      serviceArea: "national",
      keywords: [{ keyword: "running shoes" }],
    });
    expect(p.businessModelType).toBe("product");
    expect(p.isLocationDependent).toBe(false);
    expect(p.scope).toBe("national");
  });

  it("explicit serviceArea drives scope + location-dependence", () => {
    expect(
      buildOffPageProfile({ businessType: "Plumbing", serviceArea: "regional", businessCity: "X" })
        .isLocationDependent,
    ).toBe(true);
    expect(
      buildOffPageProfile({ businessType: "Consulting", serviceArea: "international" }).scope,
    ).toBe("international");
  });

  it("handles missing keywords and missing fields safely", () => {
    const p = buildOffPageProfile({});
    expect(p.keywords).toEqual([]);
    expect(p.businessName).toBe("");
    expect(["service", "product", "mixed", "unknown"]).toContain(p.businessModelType);
  });

  it("filters blank/invalid keyword entries", () => {
    const p = buildOffPageProfile({
      businessType: "SaaS",
      keywords: [{ keyword: "  seo tool  " }, { keyword: "" }, { keyword: null }, {}],
    });
    expect(p.keywords).toEqual(["seo tool"]);
  });

  it("does not treat street addresses or province codes as cities", () => {
    const addressOnly = buildOffPageProfile({
      businessName: "Everest Plumbing",
      businessType: "Plumbing Services",
      serviceArea: "local",
      businessCity: "31 Commercial Rd",
      businessCountry: "ON",
    });
    expect(addressOnly.city).toBeNull();

    const withGeo = buildOffPageProfile({
      businessName: "Shawarma West",
      businessType: "Restaurant",
      serviceArea: "regional",
      businessCity: "746 Queen St W",
      businessCountry: "ON",
      GeoProfile: { locality: "Mississauga" },
    });
    expect(withGeo.city).toBe("Mississauga");
  });
});
