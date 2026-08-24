import { describe, expect, test } from "bun:test";

import {
  loadSocialCreativeBrandAfterEntitlement,
} from "../controllers/social-creative.controller";
import type { ContextDevBrandProfile } from "../services/context-dev-brand.service";
import {
  loadSocialCreativeBrandContext,
  selectRecentPositiveGoogleReviews,
} from "../services/social-creative/brand-context";

const contextProfile: ContextDevBrandProfile = {
  schemaVersion: 1,
  provider: "context.dev.brand.retrieve",
  domain: "example.com",
  retrievedAt: "2026-08-09T12:00:00.000Z",
  title: "Example Business",
  description: null,
  slogan: null,
  primaryColors: ["#6633ff"],
  secondaryColors: ["#f2efff"],
  logoUrl: "https://cdn.example/logo.png",
  logoAltText: "Example Business",
  faviconUrl: "https://cdn.example/favicon.png",
  referenceImageUrl: "https://cdn.example/backdrop.jpg",
  phone: null,
  email: null,
  address: null,
  socials: [],
};

describe("social creative Prisma brand context", () => {
  test("maps verified business, brand, design, logo, photo, locale, and history fields", async () => {
    let businessQuery: any;
    let providerCalls = 0;
    const prisma = {
      business: {
        findFirst: async (query: any) => {
          businessQuery = query;
          return {
            id: "business-1",
            userId: "user-1",
            isActive: true,
            businessName: "Atelier Nord",
            businessType: "Interior design studio",
            businessDescription: "Residential interior design and space planning.",
            businessWebsiteUrl: "https://atelier.example",
            businessPhone: "+1 416 555 0100",
            businessCity: "Montréal",
            businessState: "Québec",
            businessCountry: "Canada",
            defaultLanguage: "fr",
            defaultLocale: "fr-CA",
            contentTone: "warm and expert",
            targetAudience: "Homeowners",
            selectedServices: ["Space planning", { name: "Colour consultation" }],
            detectedServices: ["Space planning", "Renovation design"],
            BrandAnalysis: {
              primaryColors: ["#123456"],
              secondaryColors: ["#f4efe9"],
              logoUrl: "https://cdn.example/logo.png",
              referenceImageUrl: "https://cdn.example/reference.jpg",
              fontFamily: "Poppins",
            },
            Photos: [{ url: "https://cdn.example/project.jpg" }],
            websiteAnalysis: {
              brandIdentity: { logos: [] },
              design: {
                colors: [{ type: "primary", hex: "#123456" }],
                fonts: [{ family: "Montserrat" }],
              },
            },
            GoogleMyBusiness: {
              isActive: true,
              isDemo: false,
              accountId: "account-1",
              locationId: "location-1",
              lastSyncAt: new Date("2026-08-18T12:00:00.000Z"),
              verified: true,
              totalReviewCount: 12,
              cachedAverageRating: 4.8,
              gmbReviews: [
                {
                  rating: 5,
                  comment:
                    "They understood our space and made the entire process feel easy.",
                  reviewDate: new Date("2026-08-17T12:00:00.000Z"),
                },
              ],
            },
            socialPromotionCampaign: {
              enabled: true,
              title: "Design consultation week",
              information: "Book an approved consultation during the campaign.",
              preferredContent: "Plan a calmer home this August.",
              startsOn: "2026-08-19",
              endsOn: "2026-08-26",
              imageUrl: "https://cdn.example/promotion.png",
              documentName: "consultation-details.pdf",
              documentText: "The consultation includes a space-planning review.",
            },
          };
        },
      },
      socialCreativePost: {
        findMany: async () => [
          {
            headline: "A calmer living room",
            archetype: "benefit-led",
            layoutFamily: "split-focus",
          },
        ],
      },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      { businessId: "business-1", userId: "user-1" },
      prisma,
      {
        now: () => new Date("2026-08-19T12:00:00.000Z"),
        retrieveBrand: async () => {
          providerCalls += 1;
          return contextProfile;
        },
      },
    );

    expect(businessQuery.where).toEqual({
      id: "business-1",
      userId: "user-1",
      isActive: true,
    });
    expect(context).toMatchObject({
      businessName: "Atelier Nord",
      language: "fr",
      locale: "fr-CA",
      tone: "warm and expert",
      services: ["Space planning", "Colour consultation", "Renovation design"],
      primaryColors: ["#123456"],
      fontFamily: "Poppins",
      logoUrl: "https://cdn.example/logo.png",
      referenceImageUrls: [
        "https://cdn.example/reference.jpg",
        "https://cdn.example/project.jpg",
      ],
      recentPositiveReviews: [
        {
          excerpt:
            "They understood our space and made the entire process feel easy.",
          rating: 5,
          reviewedAt: "2026-08-17T12:00:00.000Z",
          source: "google-business-profile",
        },
      ],
      promotion: {
        enabled: true,
        title: "Design consultation week",
        startsOn: "2026-08-19",
        endsOn: "2026-08-26",
        imageUrl: "https://cdn.example/promotion.png",
        documentName: "consultation-details.pdf",
      },
    });
    expect(
      businessQuery.include.GoogleMyBusiness.select.gmbReviews,
    ).toMatchObject({
      where: {
        rating: { gte: 4 },
        comment: { not: null },
        reviewDate: { gte: new Date("2026-02-19T12:00:00.000Z") },
      },
      take: 10,
    });
    expect(businessQuery.include.socialPromotionCampaign.select).toMatchObject({
      enabled: true,
      documentText: true,
      imageUrl: true,
    });
    expect(context.recentCreativeHistory).toHaveLength(1);
    expect(providerCalls).toBe(0);
  });

  test("selects only recent positive review text from a live connected profile", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const connected = {
      isActive: true,
      isDemo: false,
      accountId: "account-1",
      locationId: "location-1",
      lastSyncAt: new Date("2026-08-19T11:00:00.000Z"),
      gmbReviews: [
        {
          rating: 4,
          comment: "Professional, thoughtful, and easy to work with from start to finish.",
          reviewDate: new Date("2026-08-10T12:00:00.000Z"),
        },
        {
          rating: 5,
          comment: "The team made every step clear and delivered a wonderful result.",
          reviewDate: new Date("2026-08-18T12:00:00.000Z"),
        },
        {
          rating: 3,
          comment: "This neutral review should never be used in promotional creative.",
          reviewDate: new Date("2026-08-17T12:00:00.000Z"),
        },
        {
          rating: 5,
          comment: "Call me at +1 416 555 0199 because this contains private contact data.",
          reviewDate: new Date("2026-08-16T12:00:00.000Z"),
        },
        {
          rating: 5,
          comment: "An old positive review outside the configured recent-review window.",
          reviewDate: new Date("2025-12-01T12:00:00.000Z"),
        },
      ],
    };

    expect(selectRecentPositiveGoogleReviews(connected, now)).toEqual([
      {
        excerpt: "The team made every step clear and delivered a wonderful result.",
        rating: 5,
        reviewedAt: "2026-08-18T12:00:00.000Z",
        source: "google-business-profile",
      },
      {
        excerpt: "Professional, thoughtful, and easy to work with from start to finish.",
        rating: 4,
        reviewedAt: "2026-08-10T12:00:00.000Z",
        source: "google-business-profile",
      },
    ]);
    expect(
      selectRecentPositiveGoogleReviews(
        { ...connected, isActive: false },
        now,
      ),
    ).toEqual([]);
    expect(
      selectRecentPositiveGoogleReviews(
        { ...connected, lastSyncAt: null },
        now,
      ),
    ).toEqual([]);
  });

  test("uses stored WebsiteAnalysis identity before the remote fallback", async () => {
    let providerCalls = 0;
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-website-analysis",
          businessName: "Website Identity",
          businessType: "Professional service",
          businessDescription: "A complete business description.",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: "en",
          defaultLocale: "en-US",
          contentTone: "professional",
          targetAudience: "Teams",
          selectedServices: ["Consulting"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: null,
          Photos: [],
          websiteAnalysis: {
            brandIdentity: { tagline: "Stored first", logos: [] },
            design: {
              colors: [{ type: "primary", hex: "#123456" }],
              fonts: [],
            },
            coreServices: null,
            contactInfo: null,
            businessInfo: null,
          },
          GoogleMyBusiness: null,
        }),
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      {
        businessId: "business-website-analysis",
        userId: "user-1",
      },
      prisma,
      {
        retrieveBrand: async () => {
          providerCalls += 1;
          return contextProfile;
        },
      },
    );

    expect(context.primaryColors).toEqual(["#123456"]);
    expect(context.tagline).toBe("Stored first");
    expect(providerCalls).toBe(0);
  });

  test("uses the owned unfinished onboarding snapshot before remote retrieval", async () => {
    let providerCalls = 0;
    const prisma = {
      quickScrapeBusiness: {
        findUnique: async () => ({
          userId: "user-1",
          onboardingV2BusinessId: "business-onboarding",
          onboardingV2GenerationRevision: 2,
          onboardingV2Status: "in_progress",
          onboardingV2CompletedAt: null,
          businessDescription: "Saved onboarding business description.",
          targetAudience: "Local teams",
          selectedServices: ["Planning"],
          detectedServices: [],
          brandContext: {
            schemaVersion: 2,
            primaryColors: ["#abcdef"],
            logoUrl: "https://cdn.example/onboarding-logo.png",
            slogan: "Saved onboarding identity",
          },
        }),
      },
      business: {
        findFirst: async () => ({
          id: "business-onboarding",
          businessName: "Onboarding Business",
          businessType: "Consultancy",
          businessDescription: "",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: null,
          defaultLocale: null,
          contentTone: null,
          targetAudience: null,
          selectedServices: [],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: null,
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      {
        businessId: "business-onboarding",
        userId: "user-1",
        onboardingPreview: { quickBusinessId: "quick-1", revision: 2 },
      },
      prisma,
      {
        retrieveBrand: async () => {
          providerCalls += 1;
          return contextProfile;
        },
      },
    );

    expect(context.primaryColors).toEqual(["#abcdef"]);
    expect(context.logoUrl).toBe(
      "https://cdn.example/onboarding-logo.png",
    );
    expect(context.tagline).toBe("Saved onboarding identity");
    expect(providerCalls).toBe(0);
  });

  test("replaces failed and exact synthetic analysis defaults with retrieved branding", async () => {
    let providerCalls = 0;
    for (const fixture of [
      {
        businessId: "business-error-analysis",
        analysisVersion: "3.0-error",
        primaryColors: ["#000000", "#ffffff"],
        secondaryColors: ["#2563eb"],
      },
      {
        businessId: "business-exact-synthetic-analysis",
        analysisVersion: "3.0",
        primaryColors: ["#007bff", "#ffffff", "#000000"],
        secondaryColors: ["#dc3545", "#6c757d", "#28a745"],
      },
    ]) {
      let analysis: any = {
        id: `analysis-${fixture.businessId}`,
        primaryColors: fixture.primaryColors,
        secondaryColors: fixture.secondaryColors,
        fontFamily: "Arial, sans-serif",
        logoUrl: null,
        logoAltText: null,
        faviconUrl: null,
        referenceImageUrl: null,
        analysisVersion: fixture.analysisVersion,
        lastAnalyzed: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      };
      const prisma = {
        business: {
          findFirst: async () => ({
            id: fixture.businessId,
            businessName: "Recovered Brand",
            businessType: "Professional service",
            businessDescription: "A complete business description.",
            businessWebsiteUrl: "https://example.com",
            businessPhone: null,
            businessCity: null,
            businessState: null,
            businessCountry: null,
            defaultLanguage: "en",
            defaultLocale: "en-US",
            contentTone: "professional",
            targetAudience: "Teams",
            selectedServices: ["Consulting"],
            detectedServices: [],
            serviceAreaLocations: [],
            BrandAnalysis: analysis,
            Photos: [],
            websiteAnalysis: null,
            GoogleMyBusiness: null,
          }),
        },
        brandAnalysis: {
          findUnique: async () => analysis,
          updateMany: async (input: any) => {
            analysis = {
              ...analysis,
              ...input.data,
              updatedAt: new Date("2026-08-09T12:00:01.000Z"),
            };
            return { count: 1 };
          },
        },
        socialCreativePost: { findMany: async () => [] },
      } as any;

      const context = await loadSocialCreativeBrandContext(
        { businessId: fixture.businessId, userId: "user-1" },
        prisma,
        {
          validateWebsiteUrl: async (url: string) => new URL(url),
          retrieveBrand: async () => {
            providerCalls += 1;
            return contextProfile;
          },
        },
      );

      expect(context.primaryColors).toEqual(["#6633ff"]);
      expect(context.secondaryColors).toEqual(["#f2efff"]);
      expect(context.fontFamily).toBeNull();
      expect(context.logoUrl).toBe("https://cdn.example/logo.png");
      expect(analysis).toMatchObject({
        primaryColors: ["#6633ff"],
        secondaryColors: ["#f2efff"],
        fontFamily: null,
        logoUrl: "https://cdn.example/logo.png",
        analysisVersion: "context-dev-brand-v1",
      });
    }
    expect(providerCalls).toBe(2);
  });

  test("keeps an otherwise default-looking analysis when it has a real asset", async () => {
    let providerCalls = 0;
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-real-asset",
          businessName: "Real Asset Brand",
          businessType: "Professional service",
          businessDescription: "A complete business description.",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: "en",
          defaultLocale: "en-US",
          contentTone: "professional",
          targetAudience: "Teams",
          selectedServices: ["Consulting"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: {
            primaryColors: ["#000000", "#ffffff", "#007bff"],
            secondaryColors: ["#6c757d", "#28a745", "#dc3545"],
            fontFamily: "Arial, sans-serif",
            logoUrl: "https://cdn.example/real-logo.png",
            faviconUrl: null,
            referenceImageUrl: null,
            analysisVersion: "3.0",
          },
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      { businessId: "business-real-asset", userId: "user-1" },
      prisma,
      {
        retrieveBrand: async () => {
          providerCalls += 1;
          return contextProfile;
        },
      },
    );

    expect(providerCalls).toBe(0);
    expect(context.logoUrl).toBe("https://cdn.example/real-logo.png");
    expect(context.primaryColors).toEqual([
      "#000000",
      "#ffffff",
      "#007bff",
    ]);
  });

  test("repairs a daily SVG logo to Bunny PNG before it reaches image generation", async () => {
    const originalLogoUrl = "https://brand.example/approved-logo.svg";
    const canonicalLogoUrl = "https://cdn.example/approved-logo.png";
    const analysis = {
      id: "analysis-svg",
      primaryColors: ["#ef3124"],
      secondaryColors: ["#ffffff"],
      fontFamily: "Inter",
      logoUrl: originalLogoUrl,
      logoAltText: "Approved logo",
      faviconUrl: null,
      referenceImageUrl: null,
      analysisVersion: "context-dev-brand-v1",
      lastAnalyzed: new Date("2026-08-14T00:00:00.000Z"),
      updatedAt: new Date("2026-08-14T00:00:00.000Z"),
    };
    let canonicalizeInput: unknown;
    let updateInput: unknown;
    const prisma = {
      quickScrapeBusiness: { findFirst: async () => null },
      business: {
        findFirst: async () => ({
          id: "business-svg",
          businessName: "SVG Brand",
          businessType: "Restaurant",
          businessDescription: "Fresh food for local events.",
          businessWebsiteUrl: "https://brand.example",
          businessPhone: null,
          businessCity: "Toronto",
          businessState: "Ontario",
          businessCountry: "Canada",
          defaultLanguage: "en",
          defaultLocale: "en-CA",
          contentTone: "friendly",
          targetAudience: "Local event planners",
          selectedServices: ["Catering"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: analysis,
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      brandAnalysis: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 1 };
        },
        findUnique: async () => analysis,
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      { businessId: "business-svg", userId: "user-1" },
      prisma,
      {
        canonicalizeDailyLogo: async (input) => {
          canonicalizeInput = input;
          return {
            bytes: 100,
            canonicalMimeType: "image/png",
            checksumSha256: "A".repeat(64),
            format: "png",
            height: 100,
            objectKey: "social-creatives/logo.png",
            provider: "bunny",
            sizeBytes: 100,
            sourceMimeType: "image/svg+xml",
            sourceUrl: originalLogoUrl,
            storageZone: "test",
            url: canonicalLogoUrl,
            width: 100,
          };
        },
      },
    );

    expect(canonicalizeInput).toEqual({
      businessId: "business-svg",
      logoUrl: originalLogoUrl,
      userId: "user-1",
    });
    expect(updateInput).toEqual({
      where: { id: "analysis-svg", logoUrl: originalLogoUrl },
      data: { logoUrl: canonicalLogoUrl },
    });
    expect(context.logoUrl).toBe(canonicalLogoUrl);
  });

  test("promotes the confirmed onboarding Bunny PNG for daily generation", async () => {
    const originalLogoUrl = "https://brand.example/approved-logo.svg";
    const canonicalLogoUrl =
      "https://uplift-ai-images.b-cdn.net/onboarding-v2/brand-logos/user-1/quick-1/logo.png";
    const analysis = {
      id: "analysis-confirmed-logo",
      primaryColors: ["#ef3124"],
      secondaryColors: ["#ffffff"],
      fontFamily: "Inter",
      logoUrl: originalLogoUrl,
      logoAltText: "Approved logo",
      faviconUrl: null,
      referenceImageUrl: null,
      analysisVersion: "context-dev-brand-v1",
      lastAnalyzed: new Date("2026-08-14T00:00:00.000Z"),
      updatedAt: new Date("2026-08-14T00:00:00.000Z"),
    };
    let updateInput: unknown;
    let canonicalizeCalls = 0;
    const prisma = {
      quickScrapeBusiness: {
        findFirst: async () => ({
          brandContext: {
            logoUrl: canonicalLogoUrl,
            brandLogo: {
              provider: "bunny",
              canonicalMimeType: "image/png",
              url: canonicalLogoUrl,
            },
          },
        }),
      },
      business: {
        findFirst: async () => ({
          id: "business-confirmed-logo",
          businessName: "Confirmed Brand",
          businessType: "Restaurant",
          businessDescription: "Fresh food for local events.",
          businessWebsiteUrl: "https://brand.example",
          businessPhone: null,
          businessCity: "Toronto",
          businessState: "Ontario",
          businessCountry: "Canada",
          defaultLanguage: "en",
          defaultLocale: "en-CA",
          contentTone: "friendly",
          targetAudience: "Local event planners",
          selectedServices: ["Catering"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: analysis,
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      brandAnalysis: {
        updateMany: async (input: unknown) => {
          updateInput = input;
          return { count: 1 };
        },
        findUnique: async () => analysis,
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      { businessId: "business-confirmed-logo", userId: "user-1" },
      prisma,
      {
        canonicalizeDailyLogo: async () => {
          canonicalizeCalls += 1;
          throw new Error("confirmed onboarding logo must win");
        },
      },
    );

    expect(canonicalizeCalls).toBe(0);
    expect(updateInput).toEqual({
      where: {
        id: "analysis-confirmed-logo",
        logoUrl: originalLogoUrl,
      },
      data: { logoUrl: canonicalLogoUrl },
    });
    expect(context.logoUrl).toBe(canonicalLogoUrl);
  });

  test("does not run the daily SVG repair inside onboarding previews", async () => {
    let canonicalizeCalls = 0;
    const prisma = {
      quickScrapeBusiness: {
        findUnique: async () => ({
          userId: "user-1",
          onboardingV2BusinessId: "business-onboarding-svg",
          onboardingV2GenerationRevision: 3,
          onboardingV2Status: "in_progress",
          onboardingV2CompletedAt: null,
          businessDescription: "Onboarding description",
          targetAudience: "Local customers",
          selectedServices: ["Service"],
          detectedServices: [],
          brandContext: {
            primaryColors: ["#123456"],
            logoUrl: "https://brand.example/onboarding-logo.svg",
          },
        }),
      },
      business: {
        findFirst: async () => ({
          id: "business-onboarding-svg",
          businessName: "Onboarding SVG",
          businessType: "Service",
          businessDescription: "",
          businessWebsiteUrl: "https://brand.example",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: "en",
          defaultLocale: "en-US",
          contentTone: "professional",
          targetAudience: null,
          selectedServices: [],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: null,
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      {
        businessId: "business-onboarding-svg",
        userId: "user-1",
        onboardingPreview: { quickBusinessId: "quick-1", revision: 3 },
      },
      prisma,
      {
        canonicalizeDailyLogo: async () => {
          canonicalizeCalls += 1;
          throw new Error("daily repair must not run during onboarding");
        },
      },
    );

    expect(canonicalizeCalls).toBe(0);
    expect(context.logoUrl).toBe(
      "https://brand.example/onboarding-logo.svg",
    );
  });

  test("does not forward a legacy IP-literal logo reference to image generation", async () => {
    let providerCalls = 0;
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-ip-logo",
          businessName: "Legacy IP Logo",
          businessType: "Professional service",
          businessDescription: "A complete business description.",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: "en",
          defaultLocale: "en-US",
          contentTone: "professional",
          targetAudience: "Teams",
          selectedServices: ["Consulting"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: {
            primaryColors: ["#123456"],
            secondaryColors: [],
            fontFamily: null,
            logoUrl: "https://34.49.205.230/legacy-logo.png",
            faviconUrl: null,
            referenceImageUrl: null,
            analysisVersion: "context-dev-brand-v1",
          },
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    const context = await loadSocialCreativeBrandContext(
      { businessId: "business-ip-logo", userId: "user-1" },
      prisma,
      {
        retrieveBrand: async () => {
          providerCalls += 1;
          return contextProfile;
        },
      },
    );

    expect(context.logoUrl).toBeNull();
    expect(context.primaryColors).toEqual(["#123456"]);
    expect(providerCalls).toBe(0);
  });

  test("retrieves once under concurrency, persists normalized fields, and preserves valid stored fields", async () => {
    let providerCalls = 0;
    let analysis: any = {
      id: "analysis-1",
      primaryColors: ["not-a-color"],
      secondaryColors: [],
      fontFamily: null,
      logoUrl: "javascript:alert(1)",
      logoAltText: "Stored alt text",
      faviconUrl: "https://stored.example/favicon.png",
      referenceImageUrl: "https://stored.example/reference.jpg",
      analysisVersion: "3.0",
      lastAnalyzed: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-fallback",
          businessName: "Fallback Business",
          businessType: "Professional service",
          businessDescription: "A complete business description.",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: "en",
          defaultLocale: "en-US",
          contentTone: "professional",
          targetAudience: "Teams",
          selectedServices: ["Consulting"],
          detectedServices: [],
          serviceAreaLocations: [],
          BrandAnalysis: analysis,
          Photos: [],
          websiteAnalysis: null,
          GoogleMyBusiness: null,
        }),
      },
      brandAnalysis: {
        findUnique: async () => analysis,
        create: async () => {
          throw new Error("unexpected create");
        },
        updateMany: async (input: any) => {
          analysis = {
            ...analysis,
            ...input.data,
            updatedAt: new Date("2026-08-09T12:00:01.000Z"),
          };
          return { count: 1 };
        },
      },
      socialCreativePost: { findMany: async () => [] },
    } as any;
    const dependencies = {
      validateWebsiteUrl: async (url: string) => new URL(url),
      retrieveBrand: async () => {
        providerCalls += 1;
        await Promise.resolve();
        return contextProfile;
      },
    };

    const [first, second] = await Promise.all([
      loadSocialCreativeBrandContext(
        { businessId: "business-fallback", userId: "user-1" },
        prisma,
        dependencies,
      ),
      loadSocialCreativeBrandContext(
        { businessId: "business-fallback", userId: "user-1" },
        prisma,
        dependencies,
      ),
    ]);

    expect(providerCalls).toBe(1);
    expect(first.primaryColors).toEqual(["#6633ff"]);
    expect(second.logoUrl).toBe("https://cdn.example/logo.png");
    expect(analysis).toMatchObject({
      primaryColors: ["#6633ff"],
      secondaryColors: ["#f2efff"],
      logoUrl: "https://cdn.example/logo.png",
      logoAltText: "Stored alt text",
      faviconUrl: "https://stored.example/favicon.png",
      referenceImageUrl: "https://stored.example/reference.jpg",
      analysisVersion: "3.0",
    });
    expect(analysis).not.toHaveProperty("provider");
    expect(analysis).not.toHaveProperty("usage");
  });

  test("fails closed when stored and retrieved identity remain unusable", async () => {
    let providerCalls = 0;
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-2",
          businessName: "Example Business",
          businessType: "Professional service",
          businessDescription: "",
          businessWebsiteUrl: "https://example.com",
          businessPhone: null,
          businessCity: null,
          businessState: null,
          businessCountry: null,
          defaultLanguage: null,
          defaultLocale: null,
          contentTone: null,
          targetAudience: null,
          selectedServices: null,
          detectedServices: null,
          BrandAnalysis: null,
          Photos: [],
          websiteAnalysis: null,
        }),
      },
      brandAnalysis: { findUnique: async () => null },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    await expect(
      loadSocialCreativeBrandContext(
        { businessId: "business-2", userId: "user-2" },
        prisma,
        {
          validateWebsiteUrl: async () => {
            throw new Error("website URL is not public");
          },
          retrieveBrand: async () => {
            providerCalls += 1;
            return contextProfile;
          },
        },
      ),
    ).rejects.toThrow("website URL is not public");
    expect(providerCalls).toBe(0);

    await expect(
      loadSocialCreativeBrandContext(
        { businessId: "business-2", userId: "user-2" },
        prisma,
        {
          validateWebsiteUrl: async (url) => new URL(url),
          retrieveBrand: async () => {
            providerCalls += 1;
            return null;
          },
        },
      ),
    ).rejects.toThrow("Approved business brand identity is required");
    expect(providerCalls).toBe(1);
  });

  test("does not load brand/provider context when entitlement is denied", async () => {
    let brandLoads = 0;
    const result = await loadSocialCreativeBrandAfterEntitlement(
      { businessId: "business-1", userId: "user-1" },
      { hasAccess: false },
      async () => {
        brandLoads += 1;
        return {} as any;
      },
    );

    expect(result).toBeNull();
    expect(brandLoads).toBe(0);
  });

  test("rejects inactive, missing, or unowned businesses", async () => {
    const prisma = {
      business: { findFirst: async () => null },
      socialCreativePost: { findMany: async () => [] },
    } as any;

    await expect(
      loadSocialCreativeBrandContext(
        { businessId: "business-3", userId: "user-3" },
        prisma,
      ),
    ).rejects.toThrow("ownership mismatch");
  });
});
