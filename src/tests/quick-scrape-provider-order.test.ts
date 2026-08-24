import { describe, expect, it } from "bun:test";
import {
  mergeContextDevBrandProfile,
  normalizeContextDevQuickScrapeResult,
  normalizeOnboardingServiceList,
  quickScrapeServices,
  resolveQuickScrapeSource,
  type QuickScrapeProviderDependencies,
  type QuickScrapeResult,
} from "../utils/quick-scrape.utils";

const RETRIEVED_AT = "2026-08-09T12:00:00.000Z";

const contextResult: QuickScrapeResult = {
  businessName: "Example Plumbing",
  businessType: "Plumbing company",
  businessDescription: "Residential plumbing repairs in Toronto.",
  targetAudience: "Toronto homeowners",
  brandContext: {
    schemaVersion: 2,
    provider: "context.dev.web.extract",
    retrievedAt: RETRIEVED_AT,
    provenance: {
      identitySource: "existing-extraction",
      semanticSource: "context.dev.web.extract",
    },
    brandVoice: ["Helpful", "Direct"],
    keyMessages: ["Same-day repairs"],
    socialContentAngles: ["Seasonal plumbing tips"],
  },
  detectedServices: ["Drain cleaning", "Water heater repair"],
  businessCity: "Toronto",
  businessPhone: "(416) 555-0199",
  businessLocationMode: "service_area",
  extractionSource: "context.dev",
  extractionConfidence: 0.94,
  success: true,
};

function makeProviders(
  overrides: Partial<QuickScrapeProviderDependencies> = {},
): QuickScrapeProviderDependencies {
  return {
    contextDev: async () => null,
    scraperApi: async () => null,
    puppeteer: async () => null,
    ...overrides,
  };
}

describe("quick scrape provider order", () => {
  it("bounds and deduplicates provider service labels before onboarding persistence", () => {
    const longService = `Home buying guidance ${"with detailed support ".repeat(20)}`;
    const services = normalizeOnboardingServiceList(
      [longService, "  Seller representation  ", "seller representation"],
      10,
    );

    expect(services).toHaveLength(2);
    expect(services[0]!.length).toBeLessThanOrEqual(200);
    expect(services[0]!.endsWith(" ")).toBe(false);
    expect(services[1]).toBe("Seller representation");
  });

  it("normalizes a fact-checked Context.dev extraction into the existing onboarding contract", () => {
    expect(
      normalizeContextDevQuickScrapeResult(
        {
          businessName: "  Example Plumbing  ",
          businessType: "Plumbing company",
          businessDescription: "Residential plumbing repairs in Toronto.",
          targetAudience: "Toronto homeowners",
          brandVoice: ["Helpful", "Direct"],
          keyMessages: ["Same-day repairs"],
          socialContentAngles: ["Seasonal plumbing tips"],
          primaryColors: ["#123456"],
          secondaryColors: ["#abcdef"],
          fontFamily: "Inter",
          logoUrl: "https://example.com/logo.svg",
          logoAltText: "Example Plumbing",
          faviconUrl: "https://example.com/favicon.ico",
          referenceImageUrl: "https://example.com/van.jpg",
          services: ["Drain cleaning", "Contact Us", "Water heater repair"],
          businessAddress: "10 King Street",
          businessCity: "Toronto",
          businessState: "Ontario",
          businessCountry: "Canada",
          businessPhone: "(416) 555-0199",
          serviceArea: "local",
          serviceAreaLocations: ["Toronto", "Etobicoke"],
          businessLocationMode: "service_area",
          extractionConfidence: 1.4,
        },
        { retrievedAt: RETRIEVED_AT },
      ),
    ).toEqual({
      businessName: "Example Plumbing",
      businessType: "Plumbing company",
      businessDescription: "Residential plumbing repairs in Toronto.",
      targetAudience: "Toronto homeowners",
      brandContext: {
        schemaVersion: 2,
        provider: "context.dev.web.extract",
        retrievedAt: RETRIEVED_AT,
        provenance: {
          identitySource: "existing-extraction",
          semanticSource: "context.dev.web.extract",
        },
        brandVoice: ["Helpful", "Direct"],
        keyMessages: ["Same-day repairs"],
        socialContentAngles: ["Seasonal plumbing tips"],
        primaryColors: ["#123456"],
        secondaryColors: ["#abcdef"],
        fontFamily: "Inter",
        logoUrl: "https://example.com/logo.svg",
        logoAltText: "Example Plumbing",
        faviconUrl: "https://example.com/favicon.ico",
        referenceImageUrl: "https://example.com/van.jpg",
      },
      detectedServices: ["Drain cleaning", "Water heater repair"],
      businessAddress: "10 King Street",
      businessCity: "Toronto",
      businessState: "Ontario",
      businessCountry: "Canada",
      businessPhone: "(416) 555-0199",
      serviceArea: "local",
      serviceAreaLocations: ["Toronto", "Etobicoke"],
      businessLocationMode: "service_area",
      extractionSource: "context.dev",
      extractionConfidence: 1,
      success: true,
    });
  });

  it("rejects a structurally valid but thin Context.dev response", () => {
    expect(
      normalizeContextDevQuickScrapeResult({
        businessName: "",
        businessType: "",
        services: [],
      }),
    ).toBeNull();
  });

  it("keeps a coherent semantic result when services are empty", () => {
    const result = normalizeContextDevQuickScrapeResult(
      {
        businessName: "Example Plumbing",
        businessType: "Plumbing company",
        services: [],
      },
      { retrievedAt: RETRIEVED_AT },
    );

    expect(result?.detectedServices).toEqual([]);
    expect(result?.success).toBe(true);
  });

  it("merges normalized brand identity over visual fields without replacing semantic facts", () => {
    const merged = mergeContextDevBrandProfile(contextResult, {
      schemaVersion: 1,
      provider: "context.dev.brand.retrieve",
      domain: "example.com",
      retrievedAt: "2026-08-09T12:30:00.000Z",
      title: "Provider title must not replace semantic name",
      description: "Provider description must not replace semantic facts",
      slogan: "Plumbing made simple",
      primaryColors: ["#aa0000", "#bb0000"],
      secondaryColors: ["#00aa00"],
      logoUrl: "https://cdn.context.dev/logo.png",
      logoAltText: "Example Plumbing logo",
      faviconUrl: "https://cdn.context.dev/favicon.png",
      referenceImageUrl: "https://cdn.context.dev/backdrop.jpg",
      phone: "+14165550123",
      usage: { creditsConsumed: 10, creditsRemaining: 500 },
    });

    expect(merged).toMatchObject({
      businessName: "Example Plumbing",
      businessDescription: "Residential plumbing repairs in Toronto.",
      targetAudience: "Toronto homeowners",
      detectedServices: ["Drain cleaning", "Water heater repair"],
      brandContext: {
        schemaVersion: 2,
        provider: "context.dev.brand.retrieve",
        retrievedAt: "2026-08-09T12:30:00.000Z",
        provenance: {
          identitySource: "context.dev.brand.retrieve",
          identityRetrievedAt: "2026-08-09T12:30:00.000Z",
          identityDomain: "example.com",
          semanticSource: "context.dev.web.extract",
        },
        brandVoice: ["Helpful", "Direct"],
        keyMessages: ["Same-day repairs"],
        socialContentAngles: ["Seasonal plumbing tips"],
        primaryColors: ["#aa0000", "#bb0000"],
        secondaryColors: ["#00aa00"],
        logoUrl: "https://cdn.context.dev/logo.png",
        logoAltText: "Example Plumbing logo",
        faviconUrl: "https://cdn.context.dev/favicon.png",
        referenceImageUrl: "https://cdn.context.dev/backdrop.jpg",
        slogan: "Plumbing made simple",
      },
    });
    expect(merged.businessPhone).toBe("(416) 555-0199");
    expect(merged.brandContext).not.toHaveProperty("usage");
    expect(merged).not.toHaveProperty("phone");
  });

  it("does not clear extracted visual fields when the retrieved profile is partial", () => {
    const extractedVisuals: QuickScrapeResult = {
      ...contextResult,
      brandContext: {
        ...contextResult.brandContext!,
        fontFamily: "Inter",
        logoUrl: "https://example.com/extracted-logo.svg",
        primaryColors: ["#123456"],
      },
    };
    const merged = mergeContextDevBrandProfile(extractedVisuals, {
      domain: "example.com",
      retrievedAt: "2026-08-09T12:30:00.000Z",
      slogan: "Reliable help",
      primaryColors: [],
      secondaryColors: [],
      logoUrl: null,
    });

    expect(merged.brandContext).toMatchObject({
      fontFamily: "Inter",
      logoUrl: "https://example.com/extracted-logo.svg",
      primaryColors: ["#123456"],
      slogan: "Reliable help",
      provenance: {
        identitySource: "context.dev.brand.retrieve",
      },
    });
  });

  it("keeps extracted identity when the brand lookup is unavailable", () => {
    expect(mergeContextDevBrandProfile(contextResult, null)).toEqual(
      contextResult,
    );
  });

  it("uses Context.dev first and skips every fallback on a usable extraction", async () => {
    const calls: string[] = [];
    const result = await quickScrapeServices(
      "example.com",
      makeProviders({
        contextDev: async () => {
          calls.push("context.dev");
          return contextResult;
        },
        scraperApi: async () => {
          calls.push("scraperapi");
          return "unexpected";
        },
        puppeteer: async () => {
          calls.push("puppeteer");
          return { text: "unexpected", html: "unexpected" };
        },
      }),
    );

    expect(calls).toEqual(["context.dev"]);
    expect(result).toEqual(contextResult);
  });

  it("uses ScraperAPI only after Context.dev returns no usable result", async () => {
    const calls: string[] = [];
    const source = await resolveQuickScrapeSource(
      "https://example.com",
      makeProviders({
        contextDev: async () => {
          calls.push("context.dev");
          return null;
        },
        scraperApi: async () => {
          calls.push("scraperapi");
          return "Useful fallback website content";
        },
        puppeteer: async () => {
          calls.push("puppeteer");
          return null;
        },
      }),
    );

    expect(calls).toEqual(["context.dev", "scraperapi"]);
    expect(source).toEqual({
      provider: "scraperapi",
      content: "Useful fallback website content",
      candidateSource: "Useful fallback website content",
    });
  });

  it("uses Puppeteer only after Context.dev and ScraperAPI both miss", async () => {
    const calls: string[] = [];
    const source = await resolveQuickScrapeSource(
      "https://example.com",
      makeProviders({
        contextDev: async () => {
          calls.push("context.dev");
          return null;
        },
        scraperApi: async () => {
          calls.push("scraperapi");
          return null;
        },
        puppeteer: async () => {
          calls.push("puppeteer");
          return {
            text: "Rendered page text",
            html: '<script type="application/ld+json">{}</script>',
          };
        },
      }),
    );

    expect(calls).toEqual(["context.dev", "scraperapi", "puppeteer"]);
    expect(source).toEqual({
      provider: "puppeteer",
      content: "Rendered page text",
      candidateSource: '<script type="application/ld+json">{}</script>',
    });
  });

  it("fails closed only after all three providers miss", async () => {
    const source = await resolveQuickScrapeSource(
      "https://example.com",
      makeProviders(),
    );

    expect(source).toBeNull();
  });
});
