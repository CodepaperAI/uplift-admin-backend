import { describe, expect, it } from "bun:test";
// Pin the closed-world contract for deterministic gate tests; production
// default enables general industry knowledge (product decision 2026-07-14).
process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED = "false";

import {
  BusinessDataConflictError,
  compileCanonicalBlogFacts,
  serializeCanonicalBlogFacts,
} from "../services/canonical-blog-facts.service";

describe("canonical blog fact compiler", () => {
  it("blocks a province stored as a city before generation", () => {
    expect(() =>
      compileCanonicalBlogFacts({
        business: {
          businessName: "Ridge Security",
          businessCity: "British Columbia",
          businessState: "Ontario",
          businessCountry: "Canada",
          selectedServices: ["Mobile Patrols"],
        },
      }),
    ).toThrow(BusinessDataConflictError);

    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        businessCity: "British Columbia",
        businessState: "Ontario",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });
    expect(packet.status).toBe("blocked");
    expect(packet.conflicts.map((conflict) => conflict.code)).toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
  });

  it("blocks when a geocode relocates the business to another country", () => {
    // Real incident: businessCity="ON", businessState="L8H 4S3" (postal code in
    // the region column) let "227 Kenilworth Ave N" geocode to Tiffin, Ohio for
    // a Hamilton, Ontario business. The US geocode outranked the stored Canada
    // country, so no same-rank conflict fired.
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "The Hamilton Plumber",
        businessCity: "ON",
        businessState: "L8H 4S3",
        businessCountry: "Canada",
        GeoProfile: {
          placeId: "place-123",
          resolutionSource: "manual",
          locality: "Tiffin",
          adminArea1: "Ohio",
          countryCode: "US",
        },
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("blocked");
    expect(packet.conflicts.map((conflict) => conflict.code)).toContain(
      "CONFLICTING_COUNTRY",
    );
  });

  it("does not treat country alias spellings as a conflict", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Acme Services",
        businessCountry: "United States",
        GeoProfile: {
          placeId: "place-123",
          resolutionSource: "manual",
          locality: "Columbus",
          adminArea1: "Ohio",
          countryCode: "US",
        },
      },
      throwOnConflict: false,
    });

    expect(
      packet.conflicts.filter(
        (conflict) => conflict.code === "CONFLICTING_COUNTRY",
      ),
    ).toHaveLength(0);
  });

  it("never accepts a postal code as an authoritative region", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "The Hamilton Plumber",
        businessCountry: "Canada",
      },
      businessLocation: {
        verified: true,
        businessCity: "Hamilton",
        businessState: "L8H 4S3",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });

    expect(packet.location.region).not.toBe("L8H 4S3");
  });

  it("treats an unconfirmed Canadian province name and abbreviation as equivalent without admitting either", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Verma Accounting & Financial Services",
        businessCity: "Ontario",
        businessState: "ON",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("ready");
    expect(packet.location.city).toBeNull();
    expect(packet.location.region).toBeNull();
    expect(packet.conflicts.map((conflict) => conflict.code)).not.toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
    expect(packet.excludedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "city", reason: "not_user_confirmed" }),
        expect.objectContaining({ field: "region", reason: "not_user_confirmed" }),
      ]),
    );
  });

  it("still blocks an unconfirmed Ontario and British Columbia mismatch", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Conflicted Canadian Business",
        businessCity: "Ontario",
        businessState: "BC",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("blocked");
    expect(packet.conflicts.map((conflict) => conflict.code)).toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
  });

  it("still blocks an unconfirmed Ontario and Quebec mismatch", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Another Conflicted Canadian Business",
        businessCity: "Ontario",
        businessState: "QC",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("blocked");
    expect(packet.conflicts.map((conflict) => conflict.code)).toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
  });

  it("does not mistake an unconfirmed Canadian city for a province", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Toronto Canadian Business",
        businessCity: "Toronto",
        businessState: "ON",
        businessCountry: "Canada",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("ready");
    expect(packet.location.city).toBeNull();
    expect(packet.location.region).toBeNull();
    expect(packet.conflicts.map((conflict) => conflict.code)).not.toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
  });

  it("normalizes a US state abbreviation when a ZIP was stored in the region field", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "New York Jeweller",
        businessCountry: "United States",
      },
      businessLocation: {
        verified: true,
        businessCity: "New York",
        businessState: "NY 10036",
        businessCountry: "United States",
        postalCode: "10036",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("ready");
    expect(packet.location.city).toBe("New York");
    expect(packet.location.region).toBe("New York");
    expect(packet.location.postalCode).toBe("10036");
    expect(packet.conflicts).toHaveLength(0);
  });

  it("still blocks a genuine city/state conflict when the region includes a ZIP", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Conflicted Jeweller",
        businessCountry: "United States",
      },
      businessLocation: {
        verified: true,
        businessCity: "New York",
        businessState: "NJ 07030",
        businessCountry: "United States",
        postalCode: "07030",
      },
      throwOnConflict: false,
    });

    expect(packet.status).toBe("blocked");
    expect(packet.location.region).toBe("New Jersey");
    expect(packet.conflicts.map((conflict) => conflict.code)).toContain(
      "LOCATION_LEVEL_MISMATCH",
    );
  });

  it("uses verified location data over contradictory lower-trust raw fields", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        businessCity: "British Columbia",
        businessState: "Ontario",
        businessCountry: "Canada",
      },
      businessLocation: {
        verified: true,
        businessCity: "Burnaby",
        businessState: "British Columbia",
        businessCountry: "Canada",
        formattedAddress: "Burnaby, British Columbia, Canada",
      },
    });

    expect(packet.status).toBe("ready");
    expect(packet.location.city).toBe("Burnaby");
    expect(packet.location.region).toBe("British Columbia");
    expect(packet.location.address).toBe("Burnaby, British Columbia, Canada");
    expect(packet.provenance.find((fact) => fact.field === "city")?.source).toBe(
      "verified_geo",
    );
  });

  it("permits a confirmed target city only when it is a configured service area", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        businessCity: "Surrey",
        businessState: "British Columbia",
        serviceAreaLocations: ["Burnaby", "Vancouver"],
      },
      businessLocation: {
        verified: true,
        businessCity: "Surrey",
        businessState: "British Columbia",
        targetCity: "Burnaby",
      },
    });

    expect(packet.location.city).toBe("Burnaby");
    expect(packet.provenance.find((fact) => fact.field === "city")?.source).toBe(
      "user_selected",
    );
  });

  it("keeps unknown values empty instead of inferring plausible business facts", () => {
    const packet = compileCanonicalBlogFacts({
      business: { businessName: "Sparse Company" },
    });

    expect(packet.location.city).toBeNull();
    expect(packet.services).toEqual([]);
    expect(packet.operatingFacts).toEqual([]);
    expect(packet.reviews).toEqual([]);
    expect(serializeCanonicalBlogFacts(packet)).not.toContain("24/7");
  });

  it("drops malformed scraped price fragments before canonical claims are compiled", () => {
    const usd = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
      },
      scrapedFacts: {
        priceFrom: "00 USD Add to cart",
        priceRange: "Unit price / per Sale $508 CAD",
      },
    });

    expect(usd.operatingFacts).toEqual([]);
    expect(usd.claims.some((claim) => /00 USD|per Sale/i.test(claim.text))).toBe(
      false,
    );
  });

  it("excludes legacy LLM-enriched profile prose from the allowed claim ledger", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        businessWebsiteUrl: "https://ridge.example.com",
        businessDescription: "Licensed guards with 24/7 rapid response",
        businessPhone: "+1 604 555 0100",
        secondaryDetailsConfirmed: false,
        selectedServices: ["Mobile Patrols"],
        coreServices: {
          topLevel: ["24/7 Emergency Dispatch"],
          subOfferings: ["Guaranteed ten-minute response"],
        },
        effectiveServices: {
          topLevel: ["24/7 Emergency Dispatch"],
          subOfferings: ["Guaranteed ten-minute response"],
        },
        enhancedBusinessInfo: {
          targetAudience: "Clients requiring insurance compliance",
          valuePropositions: ["Licensed and insured rapid response"],
          uniqueSellingPoints: ["Free assessments and fast quotes"],
          credentials: ["Provincially accredited"],
        },
        authorJobTitle: "Security specialist",
        authorExpertise: ["Regulatory compliance"],
      },
    });

    expect(packet.services).toEqual(["Mobile Patrols"]);
    expect(packet.identity.description).toBeNull();
    expect(packet.contact.phone).toBeNull();
    expect(packet.audiences).toEqual([]);
    expect(packet.approvedBenefits).toEqual([]);
    expect(packet.credentials).toEqual([]);
    expect(packet.author.jobTitle).toBe("Editorial team at Ridge Security");
    expect(packet.excludedFacts.map((fact) => fact.field)).toEqual(
      expect.arrayContaining([
        "description",
        "phone",
        "service",
        "audience",
        "benefit",
        "credential",
      ]),
    );

    const writerPacket = serializeCanonicalBlogFacts(packet);
    expect(writerPacket).not.toContain("24/7 Emergency Dispatch");
    expect(writerPacket).not.toContain("Guaranteed ten-minute response");
    expect(writerPacket).not.toContain("Licensed and insured");
    expect(writerPacket).not.toContain("Provincially accredited");
  });

  it("admits explicitly confirmed profile fields and verified GMB facts", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Confirmed Co",
        businessWebsiteUrl: "https://confirmed.example.com",
        businessDescription: "Commercial cleaning for offices",
        businessPhone: "+1 416 555 0110",
        businessCity: "Toronto",
        businessState: "Ontario",
        businessCountry: "Canada",
        targetAudience: "Office managers",
        secondaryDetailsConfirmed: true,
        selectedServices: ["Office cleaning"],
        GoogleMyBusiness: {
          isActive: true,
          verified: true,
          businessPhone: "+1 416 555 0199",
          cachedAverageRating: 4.8,
          totalReviewCount: 27,
          gmbReviews: [
            { reviewerName: "A Customer", rating: 5, comment: "Careful work." },
          ],
        },
        GMBBusinessHours: [
          { dayOfWeek: 1, isClosed: false, is24Hours: false, openTime: "09:00", closeTime: "17:00" },
        ],
      },
    });

    expect(packet.identity.description).toBe("Commercial cleaning for offices");
    expect(packet.contact.phone).toBe("+1 416 555 0199");
    expect(packet.audiences).toEqual(["Office managers"]);
    expect(packet.businessHours).toEqual(["Monday: 09:00-17:00"]);
    expect(packet.reviews[0]?.text).toBe("Careful work.");
    expect(packet.reputationFacts).toEqual([
      "Average rating: 4.8",
      "Review count: 27",
    ]);
    expect(packet.provenance.find((fact) => fact.field === "phone")?.source).toBe("gmb");
  });

  it("generates a stable packet hash and traceable claim ledger", () => {
    const input = {
      business: {
        businessName: "Northstar Dental",
        businessWebsiteUrl: "https://northstar.example.com",
        selectedServices: ["Emergency dental assessment"],
      },
      compiledAt: new Date("2026-07-13T12:00:00.000Z"),
    };
    const first = compileCanonicalBlogFacts(input);
    const second = compileCanonicalBlogFacts({
      ...input,
      compiledAt: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(first.packetHash).toBe(second.packetHash);
    const serviceFact = first.provenance.find((fact) => fact.field === "service");
    const serviceClaim = first.claims.find((claim) =>
      claim.factIds.includes(serviceFact?.id ?? ""),
    );
    expect(serviceFact?.value).toBe("Emergency dental assessment");
    expect(serviceClaim?.type).toBe("business_service");
    expect(serviceClaim?.evidenceExcerpt).toBe("Emergency dental assessment");
  });
});
