import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../config/db.config";
import { WEBSITE_ANALYSIS } from "../validators/business.validation";

type WebsiteAnalysisType = z.infer<typeof WEBSITE_ANALYSIS>;
type WebsiteAnalysisDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Save complete website analysis structure to database
 * ALWAYS saves all fields - never skips anything
 * Uses delete + create pattern for upsert with nested relations
 */
export async function saveWebsiteAnalysis(
  db: WebsiteAnalysisDbClient,
  analysis: WebsiteAnalysisType,
  businessId: string
) {
  try {
    const existingAnalysis = await db.websiteAnalysis.findUnique({
      where: { businessId },
    });

    if (existingAnalysis) {
      await db.websiteAnalysis.delete({
        where: { businessId },
      });
      console.log(`🔄 Deleted existing website analysis for business ${businessId}, will recreate`);
    }

    const websiteAnalysis = await db.websiteAnalysis.create({
      data: {
        scrapedUrl: analysis.scrapedUrl,
        domain: analysis.domain,
        userId: analysis.userId,
        businessId: businessId,

        // Brand Identity - ALWAYS create (required in schema)
        brandIdentity: {
          create: {
            name: analysis.brandIdentity.name,
            tagline: analysis.brandIdentity.tagline ?? null,
            platform: analysis.brandIdentity.platform ?? null,
            favicon: analysis.brandIdentity.favicon ?? null,
            logos: {
              create: (analysis.brandIdentity.logos || []).map((logo) => ({
                type: logo.type,
                url: logo.url,
              })),
            },
          },
        },

        // Design - ALWAYS create, even if empty
        design: {
          create: {
            colors: {
              create: (analysis.design?.colors || []).map((color) => ({
                type: color.type,
                hex: color.hex,
                source: color.source ?? null,
              })),
            },
            fonts: {
              create: (analysis.design?.fonts || []).map((font) => ({
                type: font.type,
                family: font.family ?? null,
                weight: font.weight ?? null,
              })),
            },
          },
        },

        // Tech Stack - ALWAYS create, even if arrays are empty
        techStack: {
          create: {
            frontend: analysis.techStack?.frontend || [],
            backend: analysis.techStack?.backend || [],
            database: analysis.techStack?.database || [],
            automation: analysis.techStack?.automation || [],
          },
        },

        // Core Services - ALWAYS create, even if arrays are empty
        coreServices: {
          create: {
            topLevel: analysis.coreServices?.topLevel || [],
            subOfferings: analysis.coreServices?.subOfferings || [],
            industryFocus: analysis.coreServices?.industryFocus || [],
          },
        },

        // Recognition - ALWAYS create, even if arrays are empty
        recognition: {
          create: {
            awards: analysis.recognition?.awards || [],
            partnerships: analysis.recognition?.partnerships || [],
          },
        },

        // SEO - ALWAYS create
        seo: {
          create: {
            title: analysis.seo?.title ?? null,
            metaDescription: analysis.seo?.metaDescription ?? null,
            canonicalUrl: analysis.seo?.canonicalUrl ?? null,
            keywords: analysis.seo?.keywords || [],
            targetKeywords: analysis.seo?.targetKeywords || [],
            targetKeywordsWithType: analysis.seo?.targetKeywordsWithType
              ? JSON.parse(JSON.stringify(analysis.seo.targetKeywordsWithType))
              : null,
            openGraph: analysis.seo?.openGraph
              ? JSON.parse(JSON.stringify(analysis.seo.openGraph))
              : null,
            twitterCard: analysis.seo?.twitterCard
              ? JSON.parse(JSON.stringify(analysis.seo.twitterCard))
              : null,
            schema: analysis.seo?.schema
              ? JSON.parse(JSON.stringify(analysis.seo.schema))
              : null,
            verification: analysis.seo?.verification
              ? JSON.parse(JSON.stringify(analysis.seo.verification))
              : null,
            analytics_tracking: analysis.seo?.analytics_tracking || [],
          },
        },

        // Sitemap - ALWAYS create, even if null
        sitemap: {
          create: {
            url: analysis.sitemap?.url ?? null,
            note: analysis.sitemap?.note ?? null,
          },
        },

        // Contact Info - ALWAYS create, even if fields are null/empty
        contactInfo: {
          create: {
            phone: analysis.contactInfo?.phone ?? null,
            email: analysis.contactInfo?.email ?? null,
            contactUrl: analysis.contactInfo?.contactUrl ?? null,
            bookingUrl: analysis.contactInfo?.bookingUrl ?? null,
            hours: analysis.contactInfo?.hours || [],
            locations: {
              create: (analysis.contactInfo?.locations || []).map((loc) => ({
                type: loc.type,
                address: loc.address,
              })),
            },
          },
        },

        // Social Media - ALWAYS create array (even if empty)
        socialMedia: {
          create: (analysis.socialMedia || []).map((sm) => ({
            name: sm.name,
            url: sm.url,
          })),
        },

        // Navigation - ALWAYS create array (even if empty)
        navigation: {
          create: (analysis.navigation || []).map((nav) => ({
            text: nav.text,
            url: nav.url,
          })),
        },

        // Business Info - Enhanced business information
        businessInfo: analysis.businessInfo
          ? {
              create: {
                businessSummary: analysis.businessInfo.businessSummary ?? null,
                businessGoals: analysis.businessInfo.businessGoals || [],
                targetAudience: analysis.businessInfo.targetAudience ?? null,
                valuePropositions: analysis.businessInfo.valuePropositions || [],
                businessModel: analysis.businessInfo.businessModel ?? null,
                customerPainPoints:
                  analysis.businessInfo.customerPainPoints || [],
                uniqueSellingPoints:
                  analysis.businessInfo.uniqueSellingPoints || [],
                pricingModel: analysis.businessInfo.pricingModel ?? null,
                industryPositioning:
                  analysis.businessInfo.industryPositioning ?? null,
              },
            }
          : undefined,
      },
    });

    console.log(
      `✅ Website analysis saved for business ${businessId} with ALL data`
    );
    return websiteAnalysis;
  } catch (error) {
    console.error("❌ Failed to save website analysis:", error);
    throw error;
  }
}
