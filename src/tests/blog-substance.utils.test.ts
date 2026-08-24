import { describe, expect, it } from "bun:test";
import {
  buildBusinessSubstanceSection,
  buildCompetitorPromptBlock,
  buildOfferingPromptBlock,
  detectBusinessModelType,
  extractBusinessSubstance,
  extractCompetitors,
  extractOfferings,
} from "../utils/blog-substance.utils";

describe("detectBusinessModelType", () => {
  it("defaults to service for empty / malformed input", () => {
    expect(detectBusinessModelType(undefined)).toBe("service");
    expect(detectBusinessModelType(null)).toBe("service");
    expect(detectBusinessModelType("nonsense")).toBe("service");
    expect(detectBusinessModelType(123)).toBe("service");
    expect(detectBusinessModelType({})).toBe("service");
  });

  it("detects product/e-commerce from businessType", () => {
    expect(detectBusinessModelType({ businessType: "E-Commerce Store" })).toBe("product");
    expect(detectBusinessModelType({ businessType: "online shop" })).toBe("product");
    expect(detectBusinessModelType({ businessType: "Retail brand" })).toBe("product");
  });

  it("detects product from enhancedBusinessInfo.businessModel", () => {
    expect(
      detectBusinessModelType({
        businessType: "Brand",
        enhancedBusinessInfo: { businessModel: "DTC ecommerce selling products" },
      }),
    ).toBe("product");
  });

  it("detects service", () => {
    expect(detectBusinessModelType({ businessType: "Plumbing Services" })).toBe("service");
    expect(detectBusinessModelType({ businessType: "Catering company" })).toBe("service");
  });

  it("detects mixed when both signals present", () => {
    expect(
      detectBusinessModelType({ businessType: "Retail store with installation services" }),
    ).toBe("mixed");
  });
});

describe("extractCompetitors", () => {
  it("returns [] for missing / malformed input", () => {
    expect(extractCompetitors(undefined)).toEqual([]);
    expect(extractCompetitors({})).toEqual([]);
    expect(extractCompetitors({ competitiors: "nope" })).toEqual([]);
  });

  it("reads the misspelled competitiors key", () => {
    const out = extractCompetitors({
      competitiors: [{ name: "Acme", url: "https://acme.com" }],
    });
    expect(out).toEqual([{ name: "Acme", url: "https://acme.com", strengthAreas: undefined, contentTopics: undefined }]);
  });

  it("falls back to correctly-spelled competitors key", () => {
    const out = extractCompetitors({
      competitors: [{ name: "Acme", url: "https://acme.com" }],
    });
    expect(out[0]?.name).toBe("Acme");
  });

  it("filters entries without a name and dedupes case-insensitively", () => {
    const out = extractCompetitors({
      competitiors: [
        { name: "Acme", url: "https://acme.com" },
        { name: "", url: "https://noname.com" },
        { name: "acme", url: "https://dupe.com" },
        { url: "https://nameless.com" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("Acme");
  });

  it("caps the number of competitors", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, url: `https://c${i}.com` }));
    expect(extractCompetitors({ competitiors: many }).length).toBeLessThanOrEqual(6);
  });

  it("enriches from CompetitorIntelligences by name", () => {
    const out = extractCompetitors({
      competitiors: [{ name: "Acme", url: "https://acme.com" }],
      CompetitorIntelligences: [
        {
          competitorName: "Acme",
          strengthAreas: ["speed", "pricing"],
          contentTopics: ["guides"],
        },
      ],
    });
    expect(out[0]?.strengthAreas).toEqual(["speed", "pricing"]);
    expect(out[0]?.contentTopics).toEqual(["guides"]);
  });

  it("enriches by domain when name does not match", () => {
    const out = extractCompetitors({
      competitiors: [{ name: "Acme Corp", url: "https://www.acme.com/about" }],
      CompetitorIntelligences: [
        { competitorDomain: "acme.com", strengthAreas: ["seo"] },
      ],
    });
    expect(out[0]?.strengthAreas).toEqual(["seo"]);
  });

  it("leaves enrichment undefined when no intel matches", () => {
    const out = extractCompetitors({
      competitiors: [{ name: "Acme", url: "https://acme.com" }],
      CompetitorIntelligences: [{ competitorName: "Other" }],
    });
    expect(out[0]?.strengthAreas).toBeUndefined();
  });
});

describe("extractOfferings", () => {
  it("returns empty offering with detected type for missing input", () => {
    expect(extractOfferings(undefined)).toEqual({ type: "service", categories: [], items: [] });
  });

  it("reads from effectiveServices, preferring orderedPrimaryServices", () => {
    const out = extractOfferings({
      businessType: "Plumbing",
      effectiveServices: {
        topLevel: ["Plumbing", "Heating"],
        orderedPrimaryServices: ["Drain Cleaning", "Water Heater Repair"],
        subOfferings: ["Tankless install", "Sewer line"],
      },
    });
    expect(out.type).toBe("service");
    expect(out.categories).toEqual(["Drain Cleaning", "Water Heater Repair"]);
    expect(out.items).toEqual(["Tankless install", "Sewer line"]);
  });

  it("falls back to coreServices when effectiveServices absent", () => {
    const out = extractOfferings({
      coreServices: { topLevel: ["Catering"], subOfferings: ["Shawarma platter"] },
    });
    expect(out.categories).toEqual(["Catering"]);
    expect(out.items).toEqual(["Shawarma platter"]);
  });

  it("uses topLevel when orderedPrimaryServices is empty", () => {
    const out = extractOfferings({
      effectiveServices: { topLevel: ["A", "B"], orderedPrimaryServices: [], subOfferings: [] },
    });
    expect(out.categories).toEqual(["A", "B"]);
  });

  it("last-resorts to selectedServices string array", () => {
    const out = extractOfferings({ selectedServices: ["X", "Y"] });
    expect(out.categories).toEqual(["X", "Y"]);
    expect(out.items).toEqual([]);
  });

  it("classifies e-commerce offerings as product", () => {
    const out = extractOfferings({
      businessType: "ecommerce store",
      effectiveServices: { topLevel: ["Shoes"], subOfferings: ["Running shoe"] },
    });
    expect(out.type).toBe("product");
  });
});

describe("buildCompetitorPromptBlock", () => {
  it("forbids fabrication when no competitors", () => {
    const block = buildCompetitorPromptBlock([], "Moose Catering");
    expect(block).toContain("none verified");
    expect(block.toLowerCase()).toContain("do not fabricate");
  });

  it("lists real competitor names and forbids fake vs", () => {
    const block = buildCompetitorPromptBlock(
      [{ name: "Acme", url: "https://acme.com", strengthAreas: ["speed"] }],
      "Moose Catering",
    );
    expect(block).toContain("Acme");
    expect(block).toContain("https://acme.com");
    expect(block).toContain("known for: speed");
    expect(block).toContain("Moose Catering");
    expect(block.toLowerCase()).toContain("never invent");
  });
});

describe("buildOfferingPromptBlock", () => {
  it("frames product businesses around the real catalog", () => {
    const block = buildOfferingPromptBlock(
      { type: "product", categories: ["Shoes"], items: ["Trail Runner"] },
      "Sole Co",
    );
    expect(block).toContain("PRODUCT / E-COMMERCE");
    expect(block).toContain("Shoes");
    expect(block).toContain("Trail Runner");
    expect(block.toLowerCase()).toContain("do not invent product");
  });

  it("frames service businesses around real services", () => {
    const block = buildOfferingPromptBlock(
      { type: "service", categories: ["Catering"], items: ["Shawarma platter"] },
      "Moose Catering",
    );
    expect(block).toContain("SERVICE business");
    expect(block).toContain("Catering");
    expect(block).toContain("Shawarma platter");
  });

  it("handles mixed and empty offerings", () => {
    expect(buildOfferingPromptBlock({ type: "mixed", categories: ["A"], items: [] }, "X")).toContain(
      "BOTH products and services",
    );
    const empty = buildOfferingPromptBlock({ type: "service", categories: [], items: [] }, "X");
    expect(empty).toContain("none explicitly listed");
  });
});

describe("extractBusinessSubstance + buildBusinessSubstanceSection", () => {
  it("assembles name, competitors and offering", () => {
    const substance = extractBusinessSubstance({
      businessName: "Moose Catering",
      businessType: "Catering Services",
      competitiors: [{ name: "Rival Eats", url: "https://rival.com" }],
      effectiveServices: { topLevel: ["Catering"], subOfferings: ["Platters"] },
    });
    expect(substance.businessName).toBe("Moose Catering");
    expect(substance.competitors[0]?.name).toBe("Rival Eats");
    expect(substance.offering.categories).toEqual(["Catering"]);

    const section = buildBusinessSubstanceSection(substance);
    expect(section).toContain("REAL SUBSTANCE");
    expect(section).toContain("Rival Eats");
    expect(section).toContain("Catering");
  });
});

describe("real product grounding in prompt blocks", () => {
  it("renders the business's real catalog products for e-commerce", () => {
    const block = buildOfferingPromptBlock(
      {
        type: "product",
        categories: ["Headphones"],
        items: ["guessed item"],
        products: [
          { name: "Wireless ANC Headphones", url: "https://shop.com/products/anc" },
        ],
      },
      "Sound Co",
    );
    expect(block).toContain("ACTUAL products from this store's catalog");
    expect(block).toContain("Wireless ANC Headphones");
    expect(block).toContain("https://shop.com/products/anc");
    // real products take precedence over the guessed item label
    expect(block).not.toContain("guessed item");
  });

  it("renders real product price and brand when present", () => {
    const block = buildOfferingPromptBlock(
      {
        type: "product",
        categories: [],
        items: [],
        products: [
          {
            name: "ANC Headphones",
            url: "https://shop.com/products/anc",
            price: "199.99",
            currency: "USD",
            brand: "SoundCo",
          },
        ],
      },
      "Sound Co",
    );
    expect(block).toContain("ANC Headphones");
    expect(block).toContain("[SoundCo]");
    expect(block).toContain("USD 199.99");
  });

  it("lists competitor products and adds X-vs-Y guidance when present", () => {
    const block = buildCompetitorPromptBlock(
      [
        {
          name: "Rival Audio",
          url: "https://rival.com",
          products: [{ name: "Rival Pro Buds", url: "https://rival.com/products/pro-buds" }],
        },
      ],
      "Sound Co",
    );
    expect(block).toContain("Rival Audio");
    expect(block).toContain("real products: Rival Pro Buds");
    expect(block).toContain('"X vs Y"');
    expect(block).toContain("head-to-head");
  });

  it("omits X-vs-Y guidance when no competitor products are present", () => {
    const block = buildCompetitorPromptBlock(
      [{ name: "Rival Audio", url: "https://rival.com" }],
      "Sound Co",
    );
    expect(block).not.toContain("head-to-head");
  });
});
