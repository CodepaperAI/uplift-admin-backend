import z from "zod";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";

const keywordType = z.enum(["MUST_HAVE", "NICE_TO_HAVE"]);
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ABSENT_OPTIONAL_FIELD_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "not available",
  "not found",
  "unknown",
  "no email",
  "no email found",
  "-",
]);

export function normalizeOptionalEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  let candidate = value.trim();
  if (!candidate) {
    return undefined;
  }

  const lowered = candidate.toLowerCase();
  if (ABSENT_OPTIONAL_FIELD_VALUES.has(lowered)) {
    return undefined;
  }

  if (lowered.startsWith("mailto:")) {
    candidate = candidate.slice("mailto:".length).split("?")[0]?.trim() ?? "";
  }

  return candidate.match(EMAIL_PATTERN)?.[0]?.toLowerCase();
}

// Rich Website Analysis Schema for comprehensive extraction
// Moved to top so it can be referenced by CREATE_BUSINESS
export const WEBSITE_ANALYSIS = z.object({
  scrapedUrl: z.string().url(),
  domain: z.string(),
  userId: z.string(), // Added userId to the analysis schema
  brandIdentity: z.object({
    name: z.string(),
    tagline: z.string().optional(),
    platform: z.string().optional(),
    logos: z
      .array(
        z.object({
          type: z.string(),
          url: z.string().url(),
        }),
      )
      .optional(),
    favicon: z.string().url().optional(),
  }),
  design: z
    .object({
      colors: z
        .array(
          z.object({
            type: z.string(),
            hex: z.string(),
            source: z.string().optional(),
          }),
        )
        .optional(),
      fonts: z
        .array(
          z.object({
            type: z.string(),
            family: z.string().optional(),
            weight: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  techStack: z
    .object({
      frontend: z.array(z.string()).optional(),
      backend: z.array(z.string()).optional(),
      database: z.array(z.string()).optional(),
      automation: z.array(z.string()).optional(),
    })
    .optional(),
  coreServices: z
    .object({
      topLevel: z.array(z.string()).optional(),
      subOfferings: z.array(z.string()).optional(),
      industryFocus: z.array(z.string()).optional(),
    })
    .optional(),
  recognition: z
    .object({
      awards: z.array(z.string()).optional(),
      partnerships: z.array(z.string()).optional(),
    })
    .optional(),
  seo: z
    .object({
      title: z.string().optional(),
      metaDescription: z.string().optional(),
      canonicalUrl: z.string().url().optional(),
      keywords: z.array(z.string()).optional(),
      targetKeywords: z.array(z.string()).optional(),
      // 🆕 NEW: LLM-categorized keywords with MUST_HAVE/NICE_TO_HAVE types
      targetKeywordsWithType: z
        .array(
          z.object({
            keyword: z.string(),
            keywordType: z.enum(["MUST_HAVE", "NICE_TO_HAVE"]),
          }),
        )
        .optional(),
      openGraph: z.record(z.string(), z.string()).optional(),
      twitterCard: z.record(z.string(), z.string()).optional(),
      schema: z.array(z.record(z.string(), z.string())).optional(),
      verification: z.record(z.string(), z.string()).optional(),
      analytics_tracking: z.array(z.string()).optional(),
    })
    .optional(),
  sitemap: z
    .object({
      url: z.string().url().optional(),
      note: z.string().optional(),
    })
    .optional(),
  contactInfo: z
    .object({
      phone: z.string().optional(),
      email: z.string().email().optional(),
      contactUrl: z.string().url().optional(),
      bookingUrl: z.string().url().optional(),
      locations: z
        .array(
          z.object({
            type: z.string(),
            address: z.string(),
          }),
        )
        .optional(),
      hours: z.array(z.string()).optional(),
    })
    .optional(),
  socialMedia: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
  navigation: z
    .array(
      z.object({
        text: z.string(),
        url: z.string().url(),
      }),
    )
    .optional(),
  // 🆕 NEW: LLM-extracted competitive advantages
  competitiveAdvantages: z.array(z.string()).optional(),
  // 🆕 NEW: LLM-extracted competitors
  competitors: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().url().optional(),
      }),
    )
    .optional(),
  // 🆕 ENHANCED: Detailed business information for better context
  businessInfo: z
    .object({
      businessSummary: z
        .string()
        .optional()
        .describe(
          "Comprehensive 2-3 paragraph business description extracted from About Us, homepage hero, mission statements, and company descriptions",
        ),
      businessGoals: z
        .array(z.string())
        .optional()
        .describe(
          "Business objectives, mission statements, and goals extracted from mission/vision pages, About Us sections",
        ),
      targetAudience: z
        .string()
        .optional()
        .describe(
          "Detailed description of target customers, demographics, psychographics, and customer personas",
        ),
      valuePropositions: z
        .array(z.string())
        .optional()
        .describe(
          "Key value propositions and benefits the business offers to customers, extracted from value prop sections, benefits lists, and feature highlights",
        ),
      businessModel: z
        .string()
        .optional()
        .describe(
          "How the business operates, revenue model, service delivery method, and business approach",
        ),
      customerPainPoints: z
        .array(z.string())
        .optional()
        .describe(
          "Problems, challenges, or pain points the business solves for customers, extracted from problem statements, pain point sections, and customer testimonials",
        ),
      uniqueSellingPoints: z
        .array(z.string())
        .optional()
        .describe(
          "Detailed unique selling points beyond competitive advantages, including specific differentiators, proprietary methods, or unique approaches",
        ),
      pricingModel: z
        .string()
        .optional()
        .describe(
          "Pricing structure, pricing model, or pricing approach if mentioned on the website",
        ),
      industryPositioning: z
        .string()
        .optional()
        .describe(
          "How the business positions itself in the industry, market position, and competitive positioning",
        ),
    })
    .optional(),
});

export const CREATE_BUSINESS = z
  .object({
    businessName: z.string("Name is required").trim().min(3).max(USER_INPUT_LIMITS.businessName),
    businessType: z.string("Business Type is required").trim().min(3).max(USER_INPUT_LIMITS.businessType),
    businessDescription: z
      .string("Business description is required")
      .trim()
      .min(3)
      .max(USER_INPUT_LIMITS.businessDescription),
    websiteURL: z.string().trim().max(USER_INPUT_LIMITS.url).url("Website URL is required"),
    userId: z.string("User Id is required"),
    // keywords data

    // Keywords: LLM-extracted during onboarding (no DataForSEO validation for speed)
    keywords: z
      .array(
        z.object({
          keyword: z.string("keyword is required").trim().min(1).max(USER_INPUT_LIMITS.keyword),
          keywordType: keywordType,
        }),
      )
      .min(1, "At least one keyword is required")
      .max(100),

    // Advantage: LLM-extracted competitive advantages
    advantage: z
      .array(z.string("Competitor Advantage Required").trim().max(500))
      .max(25),

    // Competitor: LLM-extracted competitors (optional - may be empty if not found on website)
    competitors: z.array(
      z.object({
        name: z.string("Competitor Name is required").trim().max(USER_INPUT_LIMITS.competitorName),
        url: z.string("Competitor URL is required").trim().max(USER_INPUT_LIMITS.url),
      }),
    ).max(25), // Empty array allowed if LLM doesn't find competitors

    // Ranking
    ranking: z.string("Current Ranking is required").max(USER_INPUT_LIMITS.genericInput),
    website: z.string().max(USER_INPUT_LIMITS.url).url("Ranking Website Url Is required"),

    // Geographic Information (optional - extracted during onboarding)
    businessAddress: z.string().trim().max(USER_INPUT_LIMITS.address).optional(),
    businessCity: z.string().trim().max(USER_INPUT_LIMITS.locationName).optional(),
    businessState: z.string().trim().max(USER_INPUT_LIMITS.locationName).optional(),
    businessCountry: z.string().trim().max(USER_INPUT_LIMITS.country).optional(),
    serviceArea: z
      .enum(["local", "regional", "national", "international"])
      .optional(),

    // Target Audience & Content Preferences (optional - extracted during onboarding)
    targetAudience: z.string().trim().max(USER_INPUT_LIMITS.targetAudience).optional(),
    contentTone: z
      .enum(["professional", "casual", "technical", "friendly"])
      .optional(),
    publishingFrequency: z
      .enum(["daily", "weekly", "bi-weekly", "monthly"])
      .optional(),
    publishDaysOfWeek: z.array(z.number().min(0).max(6)).optional(),
    preferredContentTypes: z
      .array(
        z.enum([
          "guides",
          "reviews",
          "news",
          "tutorials",
          "case-studies",
          "how-to",
        ]),
      )
      .optional(),
    // Add this near the end of CREATE_BUSINESS schema, before .strict()
    designInfo: z
      .object({
        colors: z
          .array(
            z.object({
              type: z.string(),
              hex: z.string(),
              source: z.string().optional(),
            }),
          )
          .optional(),
        fonts: z
          .array(
            z.object({
              type: z.string(),
              family: z.string().optional(),
              weight: z.string().optional(),
            }),
          )
          .optional(),
        logos: z
          .array(
            z.object({
              type: z.string(),
              url: z.string().url(),
            }),
          )
          .optional(),
        favicon: z.string().url().optional(),
      })
      .optional(),
    // 🆕 NEW: Add rawWebsiteAnalysis to accept complete LLM output
    rawWebsiteAnalysis: WEBSITE_ANALYSIS.optional(),
  })
  .strict();

export const GET_BUSINESS_INFO = z
  .object({
    userId: z.string(),
    businessId: z.string().optional(),
  })
  .strict();

export const GET_SITEMAP_URL = z
  .object({
    websiteUrl: z.string().trim().url().max(2048),
    businessId: z.string().uuid().optional(),
  })
  .strict();
