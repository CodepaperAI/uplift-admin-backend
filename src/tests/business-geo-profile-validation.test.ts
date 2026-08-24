import { describe, expect, it } from "bun:test";
import { validateGeoProfile } from "../services/business-geo-profile.service";

describe("business geo profile validation", () => {
  it("treats a verified Google profile as complete regional location evidence", () => {
    const status = validateGeoProfile({
      id: "business-1",
      businessName: "Shawarma West",
      businessAddress: "75 Derry Rd W",
      businessCity: null,
      businessState: null,
      businessCountry: null,
      geoProfile: {
        placeId: "places/abc123",
        formattedAddress: "75 Derry Rd W, Mississauga, ON L5W 1G3, Canada",
        latitude: 43.643,
        longitude: -79.703,
        locality: "Mississauga",
        adminArea1: "ON",
        countryCode: "CA",
      },
    });

    expect(status.qualityScore).toBe(100);
    expect(status.missingFields).toEqual([]);
    expect(status.isComplete).toBe(true);
  });

  it("does not ask for a street address when Google has canonical street details", () => {
    const status = validateGeoProfile({
      id: "business-1",
      businessName: "Shawarma West",
      businessAddress: null,
      businessCity: "Mississauga",
      businessState: "ON",
      businessCountry: "Canada",
      geoProfile: {
        placeId: "places/abc123",
        formattedAddress: null,
        latitude: 43.643,
        longitude: -79.703,
        streetNumber: "75",
        route: "Derry Rd W",
        locality: "Mississauga",
        adminArea1: "ON",
        countryCode: "CA",
      },
    });

    expect(status.missingFields).not.toContain("businessAddress");
    expect(status.qualityScore).toBe(100);
  });
});
