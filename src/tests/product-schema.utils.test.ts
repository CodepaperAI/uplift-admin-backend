import { describe, expect, it } from "bun:test";
import {
  extractProductDetailsFromHtml,
  parseProductSchema,
} from "../utils/product-schema.utils";

describe("parseProductSchema", () => {
  it("parses a simple Product with an offers object", () => {
    const d = parseProductSchema(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Wireless ANC Headphones",
        description: "Noise cancelling over-ear headphones",
        brand: { "@type": "Brand", name: "SoundCo" },
        offers: { "@type": "Offer", price: "199.99", priceCurrency: "USD" },
      }),
    );
    expect(d).toEqual({
      name: "Wireless ANC Headphones",
      description: "Noise cancelling over-ear headphones",
      brand: "SoundCo",
      price: "199.99",
      currency: "USD",
    });
  });

  it("finds Product inside an @graph wrapper", () => {
    const d = parseProductSchema(
      JSON.stringify({
        "@graph": [
          { "@type": "WebPage", name: "page" },
          { "@type": "Product", name: "Trail Runner", offers: { price: 89 } },
        ],
      }),
    );
    expect(d?.name).toBe("Trail Runner");
    expect(d?.price).toBe("89");
  });

  it("handles an array of nodes and offers-as-array", () => {
    const d = parseProductSchema(
      JSON.stringify([
        { "@type": "BreadcrumbList" },
        {
          "@type": ["Product", "IndividualProduct"],
          name: "Studio Buds",
          brand: "BudCo",
          offers: [{ price: "50", priceCurrency: "CAD" }],
        },
      ]),
    );
    expect(d?.name).toBe("Studio Buds");
    expect(d?.brand).toBe("BudCo");
    expect(d?.price).toBe("50");
    expect(d?.currency).toBe("CAD");
  });

  it("returns null for non-product and malformed JSON", () => {
    expect(parseProductSchema(JSON.stringify({ "@type": "Article", name: "x" }))).toBeNull();
    expect(parseProductSchema("{not json")).toBeNull();
    expect(parseProductSchema("")).toBeNull();
  });
});

describe("extractProductDetailsFromHtml", () => {
  it("extracts the first Product from ld+json script blocks", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>
      <script type="application/ld+json">
        {"@type":"Product","name":"Gadget","offers":{"price":"12.50","priceCurrency":"GBP"}}
      </script>
      </head><body>...</body></html>`;
    const d = extractProductDetailsFromHtml(html);
    expect(d?.name).toBe("Gadget");
    expect(d?.price).toBe("12.50");
    expect(d?.currency).toBe("GBP");
  });

  it("returns null when no Product schema is present", () => {
    expect(extractProductDetailsFromHtml("<html>no schema</html>")).toBeNull();
    expect(extractProductDetailsFromHtml("")).toBeNull();
  });
});
