import { describe, expect, it } from "bun:test";

import {
  buildAllowedClaimLedger,
  claimSupportsService,
  deduplicateRetrievedClaimEvidence,
  isAuthoritativeEvidenceUrl,
  isMalformedPriceEvidence,
  rankFirstPartyEvidenceUrls,
} from "../services/blog-claim-evidence.service";
import { compileCanonicalBlogFacts } from "../services/canonical-blog-facts.service";

describe("blog claim evidence ledger", () => {
  it("accepts public authoritative hosts and rejects ordinary or private hosts", () => {
    expect(isAuthoritativeEvidenceUrl("https://www.canada.ca/en/services.html")).toBe(true);
    expect(isAuthoritativeEvidenceUrl("https://www.osha.gov/laws-regs")).toBe(true);
    expect(isAuthoritativeEvidenceUrl("https://example.edu/research")).toBe(true);
    expect(isAuthoritativeEvidenceUrl("https://example.com/article")).toBe(false);
    expect(isAuthoritativeEvidenceUrl("http://127.0.0.1/private")).toBe(false);
  });

  it("adds sourced regulatory and statistical claims without changing business claims", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Ridge Security",
        selectedServices: ["Mobile Patrols"],
      },
    });
    const claims = buildAllowedClaimLedger({
      packet,
      evidence: [
        {
          url: "https://www.osha.gov/example",
          title: "Official guidance",
          excerpt: "The regulation requires employers to document the listed safety inspection.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
        },
        {
          url: "https://example.com/blog",
          title: "Untrusted",
          excerpt: "Companies respond within ten minutes.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    });

    expect(claims.some((claim) => claim.type === "business_service")).toBe(true);
    expect(claims.some((claim) => claim.type === "regulatory")).toBe(true);
    expect(claims.some((claim) => claim.sourceUrl === "https://example.com/blog")).toBe(false);
  });

  it("accepts an explicitly first-party passage as a sourced business claim", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        businessWebsiteUrl: "https://fitness.example.com",
        selectedServices: ["Personal training"],
      },
    });
    const claims = buildAllowedClaimLedger({
      packet,
      evidence: [
        {
          url: "https://fitness.example.com/personal-training",
          title: "Personal training",
          excerpt:
            "Personal training sessions begin with a consultation to identify goals and preferred coaching format.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
          authority: "owned_website",
        },
      ],
    });

    expect(
      claims.some(
        (claim) =>
          claim.authority === "owned_website" &&
          claim.classification === "business" &&
          claim.sourceUrl ===
            "https://fitness.example.com/personal-training",
      ),
    ).toBe(true);
  });

  it("rejects truncated storefront price chrome while preserving a complete topic price", () => {
    expect(isMalformedPriceEvidence("00 USD")).toBe(true);
    expect(isMalformedPriceEvidence("00 CAD Add to cart")).toBe(true);
    expect(
      isMalformedPriceEvidence("Unit price / per Sale $508 USD"),
    ).toBe(true);
    expect(isMalformedPriceEvidence("Sectional sofa from $508 USD")).toBe(false);

    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "AFBDECOR",
        businessWebsiteUrl: "https://afbdecor.example",
        selectedServices: ["Sectionals"],
      },
    });
    const claims = buildAllowedClaimLedger({
      packet,
      evidence: [
        {
          url: "https://afbdecor.example/products/broken-usd",
          title: "Broken price fragment",
          excerpt: "00 USD Add to cart for this storefront product.",
          retrievedAt: "2026-07-20T00:00:00.000Z",
          authority: "owned_website",
        },
        {
          url: "https://afbdecor.example/products/broken-cad",
          title: "Unit price chrome",
          excerpt: "Unit price / per Sale $508 CAD for this storefront item.",
          retrievedAt: "2026-07-20T00:00:00.000Z",
          authority: "owned_website",
        },
        {
          url: "https://afbdecor.example/products/sectional",
          title: "Sectional sofa",
          excerpt: "This sectional sofa is listed from $508 USD.",
          retrievedAt: "2026-07-20T00:00:00.000Z",
          authority: "owned_website",
        },
      ],
    });

    expect(
      claims.some((claim) => claim.sourceUrl?.endsWith("/broken-usd")),
    ).toBe(false);
    expect(
      claims.some((claim) => claim.sourceUrl?.endsWith("/broken-cad")),
    ).toBe(false);
    expect(
      claims.some((claim) => claim.sourceUrl?.endsWith("/sectional")),
    ).toBe(true);
  });

  it("maps evidence to the named service without treating generic fitness words as coverage", () => {
    const claim = {
      text: "The mobile app includes on-demand workouts and workout booking.",
      evidenceExcerpt:
        "The mobile app includes on-demand workouts and workout booking.",
    };
    expect(claimSupportsService(claim, "On-demand workouts")).toBe(true);
    expect(claimSupportsService(claim, "Workout booking")).toBe(true);
    expect(claimSupportsService(claim, "Recovery rooms")).toBe(false);
    expect(claimSupportsService(claim, "Corporate wellness memberships")).toBe(false);
  });

  it("atomizes first-party marketing copy into neutral closed-world claims", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        businessWebsiteUrl: "https://fitness.example.com",
        selectedServices: ["Workout booking", "Personal training"],
      },
    });
    const claims = buildAllowedClaimLedger({
      packet,
      evidence: [
        {
          url: "https://fitness.example.com/app",
          title: "App",
          excerpt:
            "Book your next workout in advance to guarantee time and space and avoid lineups. Our nationally recognized certified trainers deliver lifelong results.",
          retrievedAt: "2026-07-13T00:00:00.000Z",
          authority: "owned_website",
        },
      ],
    }).filter((claim) => claim.authority === "owned_website");

    expect(claims.map((claim) => claim.text)).toContain(
      "Book your next workout in advance.",
    );
    expect(claims.some((claim) => /guarantee|avoid lineups/i.test(claim.text))).toBe(
      false,
    );
    expect(claims.some((claim) => /certified|recognized|lifelong/i.test(claim.text))).toBe(
      false,
    );
  });

  it("prioritizes keyword-matched service pages over unrelated event and about pages", () => {
    const urls = rankFirstPartyEvidenceUrls({
      website: "https://catering.example.com",
      keyword: "corporate catering toronto",
      serviceNames: ["Catering services", "Private event catering"],
      maxPages: 6,
      navigation: [
        { text: "About", url: "/about" },
        { text: "Wedding catering", url: "/catering/event/wedding" },
        { text: "Birthday catering", url: "/catering/event/birthday-party" },
        { text: "Corporate lunch", url: "/catering/event/corporate-lunch" },
        { text: "Catering", url: "/catering" },
      ],
    });

    expect(urls.indexOf("https://catering.example.com/catering/event/corporate-lunch"))
      .toBeLessThan(urls.indexOf("https://catering.example.com/catering/event/wedding"));
    expect(urls.indexOf("https://catering.example.com/catering"))
      .toBeLessThan(urls.indexOf("https://catering.example.com/about"));
  });

  it("deduplicates repeated website passages and keeps the most relevant source", () => {
    const evidence = deduplicateRetrievedClaimEvidence([
      {
        url: "https://catering.example.com/catering/event/wedding",
        title: "Wedding catering",
        excerpt: "Corporate lunches can use boxed bowls and buffet formats.",
        retrievedAt: "2026-07-14T00:00:00.000Z",
        authority: "owned_website",
        relevanceScore: 4,
      },
      {
        url: "https://catering.example.com/catering/event/corporate-lunch",
        title: "Corporate lunch",
        excerpt: "Corporate lunches can use boxed bowls and buffet formats.",
        retrievedAt: "2026-07-14T00:01:00.000Z",
        authority: "owned_website",
        relevanceScore: 18,
      },
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.url).toBe(
      "https://catering.example.com/catering/event/corporate-lunch",
    );
  });

  it("does not create duplicate atomic claims from the same repeated passage", () => {
    const packet = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Catering",
        businessWebsiteUrl: "https://catering.example.com",
        selectedServices: ["Corporate catering"],
      },
    });
    const claims = buildAllowedClaimLedger({
      packet,
      evidence: [
        {
          url: "https://catering.example.com/corporate",
          title: "Corporate",
          excerpt: "Boxed bowls and buffet formats are available for corporate lunches.",
          retrievedAt: "2026-07-14T00:00:00.000Z",
          authority: "owned_website",
          relevanceScore: 10,
        },
        {
          url: "https://catering.example.com/home",
          title: "Home",
          excerpt: "Boxed bowls and buffet formats are available for corporate lunches.",
          retrievedAt: "2026-07-14T00:00:00.000Z",
          authority: "owned_website",
          relevanceScore: 2,
        },
      ],
    }).filter(
      (claim) =>
        claim.authority === "owned_website" &&
        /boxed bowls/i.test(claim.text),
    );

    expect(claims).toHaveLength(1);
    expect(claims[0]?.sourceUrl).toBe(
      "https://catering.example.com/corporate",
    );
  });
});
