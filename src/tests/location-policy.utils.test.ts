import { describe, expect, it } from "bun:test";
import {
  buildLocationPolicyBlock,
  decideLocationPolicy,
  detectLocalIntent,
} from "../utils/location-policy.utils";

const LOC = {
  businessCity: "Calgary",
  businessState: "Alberta",
  businessCountry: "Canada",
  neighborhood: "Beltline",
};

describe("detectLocalIntent", () => {
  it("flags near-me / local intent", () => {
    expect(detectLocalIntent("caterer near me")).toBe(true);
    expect(detectLocalIntent("local plumber")).toBe(true);
    expect(detectLocalIntent("best noise cancelling headphones")).toBe(false);
    expect(detectLocalIntent("")).toBe(false);
  });
});

describe("decideLocationPolicy", () => {
  it("local service business → city tier with local section + landmarks (verified)", () => {
    const p = decideLocationPolicy({
      isLocationDependent: true,
      scope: "local",
      businessModelType: "service",
      keyword: "emergency plumber",
      hasCity: true,
      hasRegion: true,
      hasCountry: true,
      verifiedGeo: true,
    });
    expect(p.tier).toBe("city");
    expect(p.useLocalSection).toBe(true);
    expect(p.useLocalCTA).toBe(true);
    expect(p.useNeighborhoodAndLandmarks).toBe(true);
  });

  it("e-commerce / product business → country tier, no local extras", () => {
    const p = decideLocationPolicy({
      isLocationDependent: false,
      scope: "national",
      businessModelType: "product",
      keyword: "best running shoes",
      hasCity: true,
      hasRegion: true,
      hasCountry: true,
      verifiedGeo: true,
    });
    expect(p.tier).toBe("country");
    expect(p.useLocalSection).toBe(false);
    expect(p.useLocalCTA).toBe(false);
    expect(p.useNeighborhoodAndLandmarks).toBe(false);
  });

  it("product reach outranks a legacy local showroom service-area flag", () => {
    const p = decideLocationPolicy({
      isLocationDependent: false,
      scope: "international",
      businessModelType: "product",
      serviceArea: "local",
      keyword: "sectional sofa",
      hasCity: true,
      hasRegion: true,
      hasCountry: true,
      verifiedGeo: true,
    });
    expect(p.tier).toBe("country");
    expect(p.useLocalSection).toBe(false);
    expect(p.useLocalCTA).toBe(false);
  });

  it("national business with NO country data → none", () => {
    const p = decideLocationPolicy({
      scope: "national",
      businessModelType: "product",
      hasCity: false,
      hasRegion: false,
      hasCountry: false,
    });
    expect(p.tier).toBe("none");
  });

  it("regional business → region tier", () => {
    const p = decideLocationPolicy({
      scope: "regional",
      hasCity: true,
      hasRegion: true,
      hasCountry: true,
    });
    expect(p.tier).toBe("region");
    expect(p.useLocalSection).toBe(false);
  });

  it("local-intent keyword on a national business still references the city (no forced local section)", () => {
    const p = decideLocationPolicy({
      isLocationDependent: false,
      scope: "national",
      keyword: "plumber near me",
      hasCity: true,
      hasRegion: true,
      hasCountry: true,
    });
    expect(p.tier).toBe("city");
    expect(p.useLocalSection).toBe(false); // not a local business → no forced local section
  });

  it("unknown reach with a city → conservative city tier, no local extras", () => {
    const p = decideLocationPolicy({ hasCity: true });
    expect(p.tier).toBe("city");
    expect(p.useLocalSection).toBe(false);
    expect(p.useLocalCTA).toBe(false);
  });
});

describe("buildLocationPolicyBlock", () => {
  it("city policy names the city + forbids street/postal", () => {
    const block = buildLocationPolicyBlock(
      {
        tier: "city",
        useNeighborhoodAndLandmarks: true,
        useLocalSection: true,
        useLocalCTA: true,
        reason: "",
      },
      LOC,
    );
    expect(block).toContain("CITY / neighborhood level");
    expect(block).toContain("Beltline");
    expect(block).toContain("up to two real nearby landmarks");
    expect(block).toContain("NEVER print the full street address");
  });

  it("country policy forbids city/landmarks and street", () => {
    const block = buildLocationPolicyBlock(
      {
        tier: "country",
        useNeighborhoodAndLandmarks: false,
        useLocalSection: false,
        useLocalCTA: false,
        reason: "",
      },
      LOC,
    );
    expect(block).toContain("COUNTRY level only");
    expect(block).toContain("Canada");
    expect(block).toContain("Do NOT include any city");
    expect(block).toContain('Do NOT add a dedicated "Local considerations" section');
    expect(block).toContain("CTA must NOT be location-anchored");
  });

  it("none policy forbids all geography", () => {
    const block = buildLocationPolicyBlock(
      {
        tier: "none",
        useNeighborhoodAndLandmarks: false,
        useLocalSection: false,
        useLocalCTA: false,
        reason: "",
      },
      LOC,
    );
    expect(block).toContain("NOT location-specific");
    expect(block).toContain("Do NOT reference any city");
  });
});
