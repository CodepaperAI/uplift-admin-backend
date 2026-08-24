import { describe, expect, it } from "bun:test";
import { normalizeDataForSEOLocalMapItems } from "../utils/dataforseo.utils";

describe("DataForSEO local Maps parser", () => {
  it("normalizes Maps results for rank storage and competitor matching", () => {
    const [result] = normalizeDataForSEOLocalMapItems("emergency dentist toronto", [
      {
        title: "Example Dental",
        rank_group: 2,
        rank_absolute: 5,
        place_id: "ChIJ123",
        cid: "123456789",
        domain: "example.com",
        url: "https://example.com",
        rating: {
          value: 4.7,
          votes_count: 88,
        },
        category: "Dentist",
        additional_categories: ["Emergency dental service"],
        address: "10 King Street, Toronto, ON",
        latitude: 43.65,
        longitude: -79.38,
      },
    ]);

    expect(result).toMatchObject({
      keyword: "emergency dentist toronto",
      title: "Example Dental",
      rankGroup: 2,
      rankAbsolute: 5,
      placeId: "ChIJ123",
      cid: "123456789",
      domain: "example.com",
      rating: 4.7,
      reviewCount: 88,
      address: "10 King Street, Toronto, ON",
      latitude: 43.65,
      longitude: -79.38,
    });
    expect(result?.categories).toEqual([
      "Dentist",
      "Emergency dental service",
    ]);
  });
});
