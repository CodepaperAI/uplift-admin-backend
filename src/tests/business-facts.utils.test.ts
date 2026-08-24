import { describe, expect, it } from "bun:test";
import {
  buildBusinessFactsPromptBlock,
  extractDietaryOptions,
  extractFoundingYear,
  extractGroupSize,
  extractLeadTime,
  extractPriceFrom,
  extractPriceRange,
  hasAnyFact,
  mergeFacts,
  parseFactsFromHtml,
} from "../utils/business-facts.utils";

describe("founding year", () => {
  it("extracts from common phrasings, prefers the earliest (real founding)", () => {
    expect(extractFoundingYear("Serving Toronto since 2019.")).toBe(2019);
    expect(extractFoundingYear("Established 2005, updated 2024 site")).toBe(2005);
    expect(extractFoundingYear("Founded in 1998")).toBe(1998);
  });
  it("returns undefined when absent or implausible", () => {
    expect(extractFoundingYear("no year here")).toBeUndefined();
    expect(extractFoundingYear("since 3500")).toBeUndefined();
  });
});

describe("pricing (generalises across business types)", () => {
  it("caterer per-person", () => {
    expect(extractPriceFrom("Platters from $18 per person")).toMatch(/\$18/);
    expect(extractPriceFrom("$18/person and up")).toMatch(/\$18/);
  });
  it("SaaS per-month", () => {
    expect(extractPriceFrom("Plans starting at $29/mo")).toMatch(/\$29/);
  });
  it("price range", () => {
    expect(extractPriceRange("Budget $15–$40 per person")).toMatch(/\$15/);
  });
  it("no price → undefined", () => {
    expect(extractPriceFrom("Contact us for a quote")).toBeUndefined();
  });
});

describe("group size / lead time / dietary", () => {
  it("group size phrases", () => {
    expect(extractGroupSize("We cater groups of 10–500 guests")).toMatch(/10/);
    expect(extractGroupSize("up to 200 people")).toMatch(/200/);
  });
  it("lead time phrases", () => {
    expect(extractLeadTime("Please give 48 hours notice")).toMatch(/48/);
    expect(extractLeadTime("book 2 weeks in advance")).toMatch(/2 weeks/);
  });
  it("dietary tokens, normalised", () => {
    const d = extractDietaryOptions("We offer halal, vegan and gluten free options");
    expect(d).toContain("halal");
    expect(d).toContain("vegan");
    expect(d).toContain("gluten-free");
  });
  it("no dietary tokens → undefined", () => {
    expect(extractDietaryOptions("software for teams")).toBeUndefined();
  });
});

describe("parseFactsFromHtml — end to end, omit-if-not-found", () => {
  it("caterer page yields the facts present and nothing else", () => {
    const html = `<html><body>
      <h1>Shawarma Moose Catering</h1>
      <p>Serving Toronto since 2019. Platters from $18 per person.</p>
      <p>We cater groups of 10–500 guests with halal and vegan options.</p>
    </body></html>`;
    const f = parseFactsFromHtml(html);
    expect(f.foundingYear).toBe(2019);
    expect(f.priceFrom).toMatch(/\$18/);
    expect(f.groupSize).toMatch(/10/);
    expect(f.dietaryOptions).toContain("halal");
    expect(f.leadTime).toBeUndefined(); // not mentioned → omitted
  });

  it("reads founding year from ld+json foundingDate", () => {
    const html = `<script type="application/ld+json">{"@type":"Organization","foundingDate":"2012-06-01"}</script>`;
    expect(parseFactsFromHtml(html).foundingYear).toBe(2012);
  });

  it("empty/garbage HTML yields no facts and never throws", () => {
    expect(parseFactsFromHtml("")).toEqual({});
    expect(hasAnyFact(parseFactsFromHtml("<p>hello</p>"))).toBe(false);
  });
});

describe("merge + prompt block", () => {
  it("mergeFacts keeps the first source's value", () => {
    const merged = mergeFacts({ foundingYear: 2019 }, { foundingYear: 2024, priceFrom: "$18" });
    expect(merged.foundingYear).toBe(2019);
    expect(merged.priceFrom).toBe("$18");
  });
  it("prompt block lists real facts and instructs use-only", () => {
    const block = buildBusinessFactsPromptBlock({ foundingYear: 2019, priceFrom: "$18 per person" });
    expect(block).toContain("2019");
    expect(block).toContain("$18 per person");
    expect(block.toLowerCase()).toContain("do not");
  });
  it("prompt block forbids inventing when no facts found", () => {
    const block = buildBusinessFactsPromptBlock({});
    expect(block.toLowerCase()).toContain("none could be verified");
  });
});
