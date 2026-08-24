import { describe, expect, it } from "bun:test";
import {
  extractProductsFromUrls,
  filterProductUrls,
  isProductUrl,
  slugToProductName,
} from "../utils/product-catalog.utils";
import { enrichSubstanceWithCatalog } from "../services/product-catalog.service";
import type { BusinessSubstance } from "../utils/blog-substance.utils";

describe("isProductUrl", () => {
  it("matches common product URL shapes", () => {
    expect(isProductUrl("https://shop.com/products/red-shoes")).toBe(true);
    expect(isProductUrl("https://shop.com/product/red-shoes")).toBe(true);
    expect(isProductUrl("/shop/red-shoes")).toBe(true);
    expect(isProductUrl("/store/red-shoes")).toBe(true);
    expect(isProductUrl("/item/red-shoes")).toBe(true);
    expect(isProductUrl("/p/red-shoes")).toBe(true);
    expect(isProductUrl("/buy/red-shoes")).toBe(true);
    expect(isProductUrl("/dp/B07ABC123")).toBe(true);
    expect(isProductUrl("https://shop.com/collections/summer/products/hat")).toBe(true);
    expect(isProductUrl("https://shop.com/products/hat?variant=2")).toBe(true);
  });

  it("rejects non-product and taxonomy URLs", () => {
    expect(isProductUrl("https://shop.com/products")).toBe(false); // listing root, no slug
    expect(isProductUrl("https://shop.com/product-category/shoes")).toBe(false);
    expect(isProductUrl("https://shop.com/blog/how-to-choose")).toBe(false);
    expect(isProductUrl("https://shop.com/about")).toBe(false);
    expect(isProductUrl("")).toBe(false);
    expect(isProductUrl(undefined as unknown as string)).toBe(false);
  });
});

describe("filterProductUrls", () => {
  it("keeps only product URLs and tolerates junk entries", () => {
    const urls = [
      "https://shop.com/products/a",
      "https://shop.com/about",
      "https://shop.com/product/b",
      123 as unknown as string,
    ];
    expect(filterProductUrls(urls)).toEqual([
      "https://shop.com/products/a",
      "https://shop.com/product/b",
    ]);
    expect(filterProductUrls(null as unknown as string[])).toEqual([]);
  });
});

describe("slugToProductName", () => {
  it("de-slugifies kebab and snake case", () => {
    expect(slugToProductName("/products/wireless-noise-cancelling-headphones")).toBe(
      "Wireless Noise Cancelling Headphones",
    );
    expect(slugToProductName("/products/red_running_shoes")).toBe("Red Running Shoes");
  });

  it("strips file extension and query", () => {
    expect(slugToProductName("/products/foo-bar.html")).toBe("Foo Bar");
    expect(slugToProductName("/products/cool-widget?variant=2")).toBe("Cool Widget");
  });

  it("preserves uppercase brand/acronym tokens", () => {
    expect(slugToProductName("/products/APPLE-iphone-case")).toBe("APPLE Iphone Case");
  });

  it("returns empty for ID-like or junk slugs", () => {
    expect(slugToProductName("/dp/B07ABC123")).toBe("");
    expect(slugToProductName("/products/12345")).toBe("");
    expect(slugToProductName("/products/")).toBe("");
    expect(slugToProductName("/products/p")).toBe("");
    expect(slugToProductName("")).toBe("");
  });
});

describe("extractProductsFromUrls", () => {
  it("extracts named products, dedupes by name, and caps", () => {
    const urls = [
      "https://shop.com/products/red-shoes",
      "https://shop.com/products/red-shoes", // exact dupe
      "https://shop.com/product/RED-SHOES", // case dupe
      "https://shop.com/products/blue-hat",
      "https://shop.com/about",
      "https://shop.com/dp/B07XYZ999", // ID-like, dropped
    ];
    const products = extractProductsFromUrls(urls);
    expect(products).toEqual([
      { name: "Red Shoes", url: "https://shop.com/products/red-shoes" },
      { name: "Blue Hat", url: "https://shop.com/products/blue-hat" },
    ]);
  });

  it("respects the max cap", () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://shop.com/products/item-${i}`);
    expect(extractProductsFromUrls(urls, 10)).toHaveLength(10);
  });

  it("handles empty / non-array input", () => {
    expect(extractProductsFromUrls([])).toEqual([]);
    expect(extractProductsFromUrls(null as unknown as string[])).toEqual([]);
  });
});

describe("enrichSubstanceWithCatalog (service passthrough)", () => {
  it("returns service businesses unchanged without any I/O", async () => {
    const substance: BusinessSubstance = {
      businessName: "Moose Catering",
      competitors: [{ name: "Rival" }],
      offering: { type: "service", categories: ["Catering"], items: ["Platters"] },
    };
    const out = await enrichSubstanceWithCatalog(substance, {
      userId: "u1",
      businessId: "b1",
      includeCompetitorProducts: true,
    });
    expect(out).toBe(substance); // same reference — short-circuited, no DB/network
  });
});
