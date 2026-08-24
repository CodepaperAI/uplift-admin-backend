import { describe, expect, it } from "bun:test";
// Pin the closed-world contract for deterministic gate tests; production
// default enables general industry knowledge (product decision 2026-07-14).
process.env.BLOG_GENERAL_KNOWLEDGE_ENABLED = "false";

import {
  InsufficientBlogEvidenceError,
  planEvidenceSupportedWordCount,
} from "../services/blog-evidence-budget.service";
import {
  compileCanonicalBlogFacts,
  withCanonicalClaims,
} from "../services/canonical-blog-facts.service";
import { buildAllowedClaimLedger } from "../services/blog-claim-evidence.service";

describe("blog evidence budget", () => {
  it("caps a 4000-word request when only narrow first-party evidence exists", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Fitness",
        businessWebsiteUrl: "https://fitness.example.com",
        selectedServices: ["Group classes", "Personal training"],
      },
    });
    const evidence = Array.from({ length: 10 }, (_, index) => ({
      url: `https://fitness.example.com/service-${index % 4}`,
      title: "Service",
      excerpt: `Example Fitness documents service option ${index + 1} for members.`,
      retrievedAt: "2026-07-13T00:00:00.000Z",
      authority: "owned_website" as const,
    }));
    const packet = withCanonicalClaims(
      base,
      buildAllowedClaimLedger({ packet: base, evidence }),
    );

    const budget = planEvidenceSupportedWordCount({
      packet,
      requestedTarget: 4_000,
    });

    expect(budget.sufficient).toBe(true);
    expect(budget.capped).toBe(true);
    expect(budget.target).toBeLessThan(2_500);
    expect(budget.min).toBe(Math.max(700, Math.round(budget.target * 0.7)));
    expect(budget.min).toBeLessThan(budget.target);
    expect(budget.max).toBeGreaterThan(budget.target);
  });

  it("allows deeper content when authoritative educational evidence exists", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Northstar",
        businessWebsiteUrl: "https://northstar.example.com",
        selectedServices: ["Consulting", "Implementation"],
      },
    });
    const claims = [
      ...base.claims,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `external-${index}`,
        type: "educational" as const,
        text: `Authoritative educational claim ${index + 1}.`,
        classification: "educational" as const,
        factIds: [],
        sourceUrl: `https://example${index}.gov/research`,
        authority: "authoritative_external" as const,
        evidenceExcerpt: `Authoritative educational claim ${index + 1}.`,
      })),
    ];
    const packet = withCanonicalClaims(base, claims);

    const budget = planEvidenceSupportedWordCount({
      packet,
      requestedTarget: 3_000,
    });

    expect(budget.sufficient).toBe(true);
    expect(budget.target).toBe(3_000);
    expect(budget.capped).toBe(false);
    expect(budget.min).toBe(Math.round(budget.target * 0.85));
  });

  it("does not inflate article length when many claims share one evidence passage", () => {
    const base = compileCanonicalBlogFacts({
      business: {
        businessName: "Example Catering",
        businessWebsiteUrl: "https://catering.example.com",
        selectedServices: ["Corporate catering"],
      },
    });
    const packet = withCanonicalClaims(base, [
      ...base.claims,
      ...Array.from({ length: 20 }, (_value, index) => ({
        id: `owned-${index}`,
        type: "business_service" as const,
        text: `Normalized claim ${index + 1}.`,
        classification: "business" as const,
        factIds: [],
        sourceUrl: "https://catering.example.com/corporate",
        authority: "owned_website" as const,
        evidenceExcerpt:
          "One shared retrieved passage about corporate catering.",
      })),
    ]);
    const budget = planEvidenceSupportedWordCount({
      packet,
      requestedTarget: 4_000,
    });

    expect(budget.counts.ownedWebsiteClaims).toBe(20);
    expect(budget.counts.ownedWebsiteEvidenceUnits).toBe(1);
    expect(budget.target).toBeLessThan(1_500);
  });

  it("marks an empty profile as insufficient instead of generating filler", () => {
    const packet = compileCanonicalBlogFacts({
      business: { businessName: "Sparse Company" },
    });
    const budget = planEvidenceSupportedWordCount({
      packet,
      requestedTarget: 1_400,
    });

    expect(budget.sufficient).toBe(false);
    expect(() => {
      if (!budget.sufficient) throw new InsufficientBlogEvidenceError(budget);
    }).toThrow("INSUFFICIENT_BLOG_EVIDENCE");
  });
});
