import { describe, expect, it } from "bun:test";
import {
  directoryLever,
  normalizeCountry,
} from "../services/offpage/levers/directory-lever";
import { redditLever } from "../services/offpage/levers/reddit-lever";
import type { BusinessOffPageProfile } from "../services/offpage/offpage-types";

function profile(over: Partial<BusinessOffPageProfile> = {}): BusinessOffPageProfile {
  return {
    businessId: "b1",
    businessName: "Test Co",
    businessModelType: "service",
    isLocationDependent: true,
    scope: "local",
    country: "Canada",
    city: "Calgary",
    category: "Catering",
    keywords: ["catering calgary", "wedding catering"],
    ...over,
  };
}

describe("normalizeCountry", () => {
  it("maps common forms to ISO-2", () => {
    expect(normalizeCountry("Canada")).toBe("CA");
    expect(normalizeCountry("united states")).toBe("US");
    expect(normalizeCountry("us")).toBe("US");
    expect(normalizeCountry("")).toBe("");
  });
});

describe("directoryLever", () => {
  it("applies to every business type — local AND national/SaaS/e-commerce", () => {
    expect(directoryLever.appliesTo(profile())).toBe(true);
    // A national product business (SaaS / e-commerce) now ALSO gets directories
    // (G2 / Product Hunt / Amazon via the AI agent), not just local citations.
    expect(
      directoryLever.appliesTo(
        profile({
          businessModelType: "product",
          isLocationDependent: false,
          scope: "national",
          city: null,
          serviceArea: "national",
        }),
      ),
    ).toBe(true);
    // Only skips when there is no business identity at all to work from.
    expect(
      directoryLever.appliesTo(
        profile({ businessName: "", category: null, keywords: [] }),
      ),
    ).toBe(false);
  });

  it("surfaces general + category-matched directories for a Canadian caterer", () => {
    const opps = directoryLever.findOpportunities(profile());
    const names = opps.map((o) => o.title);
    // general (CA-eligible)
    expect(names.some((t) => t.includes("Google Business Profile"))).toBe(true);
    // CA-specific
    expect(names.some((t) => t.includes("YellowPages.ca"))).toBe(true);
    // category-matched (catering → TripAdvisor)
    expect(names.some((t) => t.includes("TripAdvisor"))).toBe(true);
    // every opp is a todo with a priority
    expect(opps.every((o) => o.status === "todo" && o.priority > 0)).toBe(true);
  });

  it("excludes US-only and wrong-country directories", () => {
    const opps = directoryLever.findOpportunities(profile());
    const names = opps.map((o) => o.title);
    expect(names.some((t) => t.includes("Yellow Pages") && !t.includes(".ca"))).toBe(false);
    expect(names.some((t) => t.includes("Angi"))).toBe(false); // US-only
  });

  it("Google Business Profile ranks at the top (authority 100)", () => {
    const opps = [...directoryLever.findOpportunities(profile())].sort(
      (a, b) => b.priority - a.priority,
    );
    expect(opps[0]?.title).toContain("Google Business Profile");
  });
});

describe("redditLever", () => {
  it("applies broadly when there is enough business identity to plan Reddit research", () => {
    expect(
      redditLever.appliesTo(
        profile({
          category: "Plumbing Services",
          keywords: ["drain cleaning calgary"],
        }),
      ),
    ).toBe(true);
    expect(
      redditLever.appliesTo(
        profile({
          businessName: "",
          category: null,
          keywords: [],
        }),
      ),
    ).toBe(false);
  });

  it("applies to local food/consumer businesses with Reddit recommendation demand", () => {
    expect(redditLever.appliesTo(profile())).toBe(true); // catering
    expect(
      redditLever.appliesTo(
        profile({
          category: "Restaurant",
          keywords: ["shawarma toronto", "late night food"],
          city: "Toronto",
        }),
      ),
    ).toBe(true);
  });

  it("applies to a SaaS/e-commerce business with keywords", () => {
    expect(
      redditLever.appliesTo(
        profile({
          businessModelType: "product",
          isLocationDependent: false,
          scope: "national",
          keywords: ["noise cancelling headphones"],
        }),
      ),
    ).toBe(true);
  });

  it("emits a subreddit-finder + per-keyword searches, capped, with anti-spam framing", () => {
    const p = profile({
      businessModelType: "product",
      isLocationDependent: false,
      scope: "national",
      keywords: ["a", "b", "c", "d", "e", "f", "g"],
    });
    const opps = redditLever.findOpportunities(p);
    // 1 subreddit-finder + 5 keyword searches (capped at 5)
    expect(opps).toHaveLength(6);
    expect(opps[0]?.title.toLowerCase()).toContain("subreddit");
    expect(opps.every((o) => o.action.toLowerCase().includes("genuine") || o.action.toLowerCase().includes("value"))).toBe(true);
    // never instructs auto-posting
    expect(opps.every((o) => !o.action.toLowerCase().includes("auto"))).toBe(true);
    // every reddit opp points at reddit.com
    expect(opps.every((o) => (o.url ?? "").includes("reddit.com"))).toBe(true);
  });
});
