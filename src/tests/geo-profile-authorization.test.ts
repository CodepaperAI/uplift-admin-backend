import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Response } from "express";

const businessFindFirstMock = mock();
const businessFindUniqueMock = mock();
const validateGeoProfileMock = mock();
const searchPlaceCandidatesMock = mock();
const enrichGeoProfileMock = mock();
const recomputeGeoProfileQualityMock = mock();

mock.module("../config/db.config", () => ({
  prisma: {
    business: {
      findFirst: businessFindFirstMock,
      findUnique: businessFindUniqueMock,
    },
  },
}));

mock.module("../services/business-geo-profile.service", () => ({
  validateGeoProfile: validateGeoProfileMock,
  searchPlaceCandidates: searchPlaceCandidatesMock,
  enrichGeoProfile: enrichGeoProfileMock,
  recomputeGeoProfileQuality: recomputeGeoProfileQualityMock,
}));

const {
  autoEnrichGeoProfile,
  getGeoProfileStatus,
  resolveGeoProfile,
  searchPlaces,
} = await import("../controllers/business-geo-profile.controller");

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as unknown as Response & {
    statusCode: number;
    body: { success: boolean; message: string; data?: unknown };
  };
}

function createRequest(body: Record<string, unknown>, authUserId?: string) {
  return { body, authUserId } as any;
}

describe("geo-profile endpoint authorization", () => {
  beforeEach(() => {
    businessFindFirstMock.mockReset();
    businessFindUniqueMock.mockReset();
    validateGeoProfileMock.mockReset();
    searchPlaceCandidatesMock.mockReset();
    enrichGeoProfileMock.mockReset();
    recomputeGeoProfileQualityMock.mockReset();

    businessFindUniqueMock.mockResolvedValue({
      id: "business-1",
      businessName: "Example Co",
      businessAddress: "1 Main St",
      businessCity: "Toronto",
      businessState: "ON",
      businessCountry: "CA",
      GeoProfile: null,
    });
    validateGeoProfileMock.mockReturnValue({ qualityScore: 80 });
    searchPlaceCandidatesMock.mockResolvedValue([{ placeId: "place-1" }]);
    enrichGeoProfileMock.mockResolvedValue({ enriched: true });
    recomputeGeoProfileQualityMock.mockResolvedValue({ qualityScore: 95 });
  });

  it("rejects missing auth before reading geo profile status", async () => {
    const response = createMockResponse();

    await getGeoProfileStatus(createRequest({ businessId: "business-1" }), response);

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(businessFindFirstMock).not.toHaveBeenCalled();
    expect(validateGeoProfileMock).not.toHaveBeenCalled();
  });

  it("rejects non-owned businesses before searching Places", async () => {
    businessFindFirstMock.mockResolvedValue(null);
    const response = createMockResponse();

    await searchPlaces(
      createRequest({ businessId: "business-1", query: "Example Co" }, "user-2"),
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.success).toBe(false);
    expect(searchPlaceCandidatesMock).not.toHaveBeenCalled();
  });

  it("returns status for an owned business", async () => {
    businessFindFirstMock.mockResolvedValue({ id: "business-1" });
    const response = createMockResponse();

    await getGeoProfileStatus(
      createRequest({ businessId: "business-1" }, "user-1"),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(validateGeoProfileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves confirmed Place IDs only for the owner", async () => {
    businessFindFirstMock.mockResolvedValue({ id: "business-1" });
    const response = createMockResponse();

    await resolveGeoProfile(
      createRequest({ businessId: "business-1", placeId: "place-1" }, "user-1"),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(enrichGeoProfileMock).toHaveBeenCalledWith("business-1", "place-1");
    expect(recomputeGeoProfileQualityMock).toHaveBeenCalledWith("business-1");
  });

  it("runs auto-enrich only for the owner", async () => {
    businessFindFirstMock.mockResolvedValue({ id: "business-1" });
    const response = createMockResponse();

    await autoEnrichGeoProfile(
      createRequest({ businessId: "business-1" }, "user-1"),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(enrichGeoProfileMock).toHaveBeenCalledWith("business-1");
    expect(recomputeGeoProfileQualityMock).toHaveBeenCalledWith("business-1");
  });
});
