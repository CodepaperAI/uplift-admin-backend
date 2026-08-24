import type { Response } from "express";
import { z, ZodError } from "zod";
import { prisma } from "../config/db.config";
import {
  upsertBusinessProfile,
  upsertSitemapUrls,
} from "../config/pinecone.config";
import { inngest } from "../inngest/client";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { extractDesignInfoFromPayload } from "../utils/business-mapper.utils";
import {
  handleValidationError,
  sendError,
  sendLegacySuccess,
  sendSuccess,
} from "../utils/response.utils";
import { resolveAgencyAssignmentForRequest } from "../utils/agency-context.utils";
import {
  isBlockedAdultWebsiteUrl,
  UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE,
} from "../utils/adult-domain-blocklist.utils";
import { resolveEffectiveServices } from "../utils/effective-services.utils";
import { filterOutGenericServices } from "../utils/generic-services.utils";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";
import { discoverSitemapUrl, fetchSitemapUrls } from "../utils/tools.utils";
import {
  OnboardingPersistenceError,
  persistAnalyzedBusiness,
} from "../services/onboarding-persistence.service";
import {
  CREATE_BUSINESS,
  GET_BUSINESS_INFO,
  GET_SITEMAP_URL,
} from "../validators/business.validation";
import {
  inspectOnboardingV2AuthorImage,
  OnboardingV2AuthorImageValidationError,
  safeOnboardingV2AuthorImageName,
} from "../services/onboarding-v2-author-image.service";
import {
  OnboardingV2BrandLogoValidationError,
  uploadBusinessBrandLogo,
} from "../services/onboarding-v2-brand-logo.service";
import { uploadImageBufferWithMetadata } from "../lib/image-storage";
import {
  isBrandAnalysisPending,
  MANUAL_BRAND_ANALYSIS_PENDING_VERSION,
  ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
} from "../utils/brand-analysis-status.utils";
import { guardUrl, SsrfBlocked } from "../utils/ssrf-guard";

export async function createBusiness(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;

    if (body.rawWebsiteAnalysis) {
      const rawWebsiteAnalysis = body.rawWebsiteAnalysis as Record<string, unknown>;
      const rawWebsiteUrl =
        typeof rawWebsiteAnalysis.scrapedUrl === "string"
          ? rawWebsiteAnalysis.scrapedUrl
          : typeof rawWebsiteAnalysis.domain === "string"
            ? rawWebsiteAnalysis.domain
            : null;
      if (rawWebsiteUrl && isBlockedAdultWebsiteUrl(rawWebsiteUrl)) {
        return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
          code: "UNSUPPORTED_WEBSITE_CATEGORY",
        });
      }

      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);
      const result = await persistAnalyzedBusiness({
        rawWebsiteAnalysis: body.rawWebsiteAnalysis,
        userId: authUserId,
        agencyAssignment,
        createDefaults: {
          websiteStatus: "active",
          isActive: true,
        },
      });

      const business = await prisma.business.findUnique({
        where: { id: result.businessId },
      });

      if (!business) {
        return sendError(res, "Failed to setup business", 500);
      }

      return sendLegacySuccess(
        res,
        {
          business,
          brandAnalysis: {
            status: "processing",
            message: "Brand analysis started in background",
          },
        },
        "Your account setup has been completed. Brand analysis is running in the background.",
      );
    }

    const payload = CREATE_BUSINESS.parse(body);

    const normalizedUrl = normalizeWebsiteUrl(payload.websiteURL ?? "");
    if (isBlockedAdultWebsiteUrl(normalizedUrl || payload.websiteURL)) {
      return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
        code: "UNSUPPORTED_WEBSITE_CATEGORY",
      });
    }

    const websiteUrlCandidates = getEquivalentWebsiteUrls(
      normalizedUrl || payload.websiteURL,
    );

    const existingBusiness = await prisma.business.findFirst({
      where: {
        userId: authUserId,
        businessWebsiteUrl: { in: websiteUrlCandidates },
      },
    });

    console.log(
      `[createBusiness] Existing business by URL: ${existingBusiness?.id || "none"}`,
    );

    // Also check for placeholder businesses (My Business with empty URL)
    const placeholderBusiness = await prisma.business.findFirst({
      where: {
        userId: authUserId,
        businessName: "My Business",
        businessWebsiteUrl: "", // Empty URL indicates placeholder
      },
    });

    console.log(
      `[createBusiness] Placeholder business: ${placeholderBusiness?.id || "none"}`,
    );

    // Check if this is the first business for this user
    const existingBusinesses = await prisma.business.findMany({
      where: { userId: authUserId },
    });

    console.log(
      `[createBusiness] Total existing businesses: ${existingBusinesses.length}`,
    );
    existingBusinesses.forEach((b, i) => {
      console.log(
        `[createBusiness]   ${i + 1}. ${b.businessName} (${b.businessWebsiteUrl || "no URL"})`,
      );
    });

    const isFirstBusiness =
      existingBusinesses.length === 0 ||
      (existingBusinesses.length === 1 && existingBusiness !== null);

    // Clean up placeholder if it exists and we're creating a real business
    if (
      placeholderBusiness &&
      payload.websiteURL &&
      payload.websiteURL.trim() !== ""
    ) {
      console.log(
        `🗑️ Cleaning up placeholder business ${placeholderBusiness.id} before creating real business`,
      );
      await prisma.business.delete({
        where: { id: placeholderBusiness.id },
      });
      console.log(`✅ Placeholder deleted`);
    } else if (placeholderBusiness) {
      console.log(
        `[createBusiness] Placeholder exists but websiteURL is empty or missing, keeping it`,
      );
    }

	    let business;
      const agencyAssignment = await resolveAgencyAssignmentForRequest(req);

	    if (existingBusiness) {
      console.log(
        `🔄 Updating existing business ${existingBusiness.id} for URL: ${payload.websiteURL}`,
      );

      business = await prisma.business.update({
        where: { id: existingBusiness.id },
        data: {
          businessName: payload.businessName,
          businessDescription: payload.businessDescription,
          businessType: payload.businessType,
          businessAddress: payload.businessAddress,
          businessCity: payload.businessCity,
          businessState: payload.businessState,
          businessCountry: payload.businessCountry,
          serviceArea: payload.serviceArea,
          targetAudience: payload.targetAudience,
          contentTone: payload.contentTone,
          publishingFrequency: payload.publishingFrequency,
          publishDaysOfWeek: payload.publishDaysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
	          preferredContentTypes: payload.preferredContentTypes || [],
	          isActive: true,
	          websiteStatus: "active",
            agencyId: existingBusiness.agencyId ?? agencyAssignment.agencyId,
            ownershipType:
              existingBusiness.agencyId != null
                ? existingBusiness.ownershipType === "agency_managed"
                  ? "agency_managed"
                  : "uplift_direct"
                : agencyAssignment.ownershipType,
            onboardedByUserId: existingBusiness.onboardedByUserId ?? authUserId,
	        },
	      });

      await prisma.keywords.deleteMany({
        where: { businessId: business.id },
      });

      await prisma.competitiveAdvantage.deleteMany({
        where: { businessId: business.id },
      });

      await prisma.competitors.deleteMany({
        where: { businessId: business.id },
      });

      await prisma.currentRanking.deleteMany({
        where: { businessId: business.id },
      });
    } else {
      business = await prisma.business.create({
        data: {
          businessName: payload.businessName,
          businessDescription: payload.businessDescription,
          businessType: payload.businessType,
          businessWebsiteUrl: normalizedUrl || payload.websiteURL,
          userId: authUserId,
          businessAddress: payload.businessAddress,
          businessCity: payload.businessCity,
          businessState: payload.businessState,
          businessCountry: payload.businessCountry,
          serviceArea: payload.serviceArea,
          targetAudience: payload.targetAudience,
          contentTone: payload.contentTone,
          publishingFrequency: payload.publishingFrequency,
          publishDaysOfWeek: payload.publishDaysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
	          preferredContentTypes: payload.preferredContentTypes || [],
	          isActive: true,
	          isPrimary: isFirstBusiness,
	          websiteStatus: "active",
            agencyId: agencyAssignment.agencyId,
            ownershipType: agencyAssignment.ownershipType,
            onboardedByUserId: authUserId,
	        },
	      });
	    }

    // D1: on initial business create, if address is provided, kick off Maps
    // enrichment in the background so the first blog generated has a verified
    // location context (neighborhood, coordinates, landmarks) rather than
    // falling back to the unverified prompt path. Fire-and-forget + gated.
    if (process.env.GOOGLE_MAPS_API_KEY && payload.businessAddress) {
      void import("../services/business-geo-profile.service").then(
        ({ enrichGeoProfile, recomputeGeoProfileQuality }) =>
          Promise.all([
            enrichGeoProfile(business.id),
            recomputeGeoProfileQuality(business.id),
          ]).catch((err) => {
            console.error(
              "⚠️ enrichGeoProfile failed after business create:",
              err,
            );
          }),
      );
    }

    await prisma.keywords.createMany({
      data: payload.keywords.map((data) => ({
        keyword: data.keyword,
        keywordType: data.keywordType,
        businessId: business.id,
      })),
    });

    await prisma.competitiveAdvantage.create({
      data: {
        businessId: business.id,
        advantage: payload.advantage,
      },
    });

    await prisma.competitors.createMany({
      data: payload.competitors.map((data) => ({
        name: data.name,
        url: data.url,
        businessId: business.id,
      })),
    });

    await prisma.currentRanking.create({
      data: {
        ranking: payload.ranking,
        website: payload.website,
        businessId: business.id,
      },
    });

    try {
      await upsertBusinessProfile(
        business.id,
        {
          businessDescription: payload.businessDescription,
          businessType: payload.businessType,
          advantage: payload.advantage,
          keywords: payload.keywords,
          userId: authUserId,
          websiteURL: payload.websiteURL,
          competitors: payload.competitors,
        },
        payload.businessName,
      );
    } catch (error) {
      console.error(
        "❌ Failed to upsert business profile to Pinecone (continuing anyway):",
        error,
      );
    }

    // 🆕 NEW: Create or Update BrandAnalysis if designInfo is provided
    if (payload.designInfo) {
      try {
        const designData = extractDesignInfoFromPayload(payload.designInfo);

        await prisma.brandAnalysis.upsert({
          where: { businessId: business.id },
          create: {
            businessId: business.id,
            ...designData,
            lastAnalyzed: new Date(),
            analysisVersion: ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
          },
          update: {
            ...designData,
            lastAnalyzed: new Date(),
            analysisVersion: ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
          },
        });
        console.log(
          `✅ Brand analysis saved for business ${business.id} with all design data`,
        );
      } catch (error) {
        console.error("❌ Failed to save brand analysis:", error);
      }
    }

    if (payload.websiteURL && payload.websiteURL.trim() !== "") {
      try {
        await inngest.send({
          name: "brand/analyze",
          data: {
            businessId: business.id,
            websiteUrl: payload.websiteURL,
            userId: authUserId,
            forceRefresh: true,
            source: "create_business",
          },
        });
        console.log(`✅ Brand analysis triggered for business ${business.id}`);
      } catch (error) {
        console.error("❌ Failed to trigger brand analysis:", error);
      }
    } else {
      console.log(`⚠️ Skipping brand analysis trigger: no website URL for business ${business.id}`);
    }

    return sendLegacySuccess(
      res,
      {
        business,
        brandAnalysis: {
          status: "processing",
          message: "Brand analysis started in background",
        },
      },
      "Your account setup has been completed. Brand analysis is running in the background.",
    );
  } catch (error) {
    console.log(error);

    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    if (
      error instanceof OnboardingPersistenceError &&
      error.code === "unsupported_website_category"
    ) {
      return sendError(res, UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE, 400, {
        code: "UNSUPPORTED_WEBSITE_CATEGORY",
      });
    }

    return sendError(res, "Failed to setup business", 500, error);
  }
}

export async function getBusinessInfo(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = GET_BUSINESS_INFO.parse(body);

    let businessInfo;
    if (payload.businessId) {
      businessInfo = await prisma.business.findFirst({
        where: {
          id: payload.businessId,
          userId: authUserId,
          isActive: true,
        },
        include: {
          competitiors: true,
          competitiveAdvantage: true,
          currentRanking: true,
          keywords: true,
          BrandAnalysis: true,
          websiteAnalysis: {
            include: {
              brandIdentity: {
                include: {
                  logos: true,
                },
              },
              design: {
                include: {
                  colors: true,
                  fonts: true,
                },
              },
              techStack: true,
              coreServices: true,
              recognition: true,
              seo: true,
              sitemap: true,
              contactInfo: {
                include: {
                  locations: true,
                },
              },
              socialMedia: true,
              navigation: true,
            },
          },
          User: {
            select: {
              email: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      });
    } else {
      const businessInclude = {
        competitiors: true,
        competitiveAdvantage: true,
        currentRanking: true,
        keywords: true,
        BrandAnalysis: true,
        websiteAnalysis: {
          include: {
            brandIdentity: {
              include: {
                logos: true,
              },
            },
            design: {
              include: {
                colors: true,
                fonts: true,
              },
            },
            techStack: true,
            coreServices: true,
            recognition: true,
            seo: true,
            sitemap: true,
            contactInfo: {
              include: {
                locations: true,
              },
            },
            socialMedia: true,
            navigation: true,
          },
        },
        User: {
          select: {
            email: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      } as const;

      businessInfo = await prisma.business.findFirst({
        where: {
          userId: authUserId,
          isPrimary: true,
          isActive: true,
        },
        include: businessInclude,
      });

      if (!businessInfo) {
        businessInfo = await prisma.business.findFirst({
          where: {
            userId: authUserId,
            isActive: true,
          },
          orderBy: { createdAt: "asc" },
          include: businessInclude,
        });
      }
    }

    if (!businessInfo) {
      return sendError(res, "Business information not found", 404);
    }

    if (businessInfo.websiteAnalysis) {
      if (businessInfo.websiteAnalysis.design) {
        console.log(
          "  - Design Colors Count:",
          businessInfo.websiteAnalysis.design.colors?.length || 0,
        );
        console.log(
          "  - Design Fonts Count:",
          businessInfo.websiteAnalysis.design.fonts?.length || 0,
        );
      }

      if (businessInfo.websiteAnalysis.brandIdentity) {
        console.log(
          "  - Brand Logos Count:",
          businessInfo.websiteAnalysis.brandIdentity.logos?.length || 0,
        );
      }

      if (businessInfo.websiteAnalysis.seo) {
        console.log(
          "  - Target Keywords Count:",
          businessInfo.websiteAnalysis.seo.targetKeywords?.length || 0,
        );
      }
    }

    const effectiveServices = resolveEffectiveServices(businessInfo);

    // Strip generic/e-commerce labels from scraped fields before sending to
    // the frontend. Keeps `selectedServices` (user-curated) raw — only the
    // scrape outputs are filtered. Defensive layer: even if a legacy DB row
    // still contains "Order Delivery", the FE never sees it.
    const cleanedDetectedServices = Array.isArray(businessInfo.detectedServices)
      ? filterOutGenericServices(
          businessInfo.detectedServices.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : businessInfo.detectedServices;
    const cleanedCoreServices = businessInfo.websiteAnalysis?.coreServices
      ? {
          ...businessInfo.websiteAnalysis.coreServices,
          topLevel: filterOutGenericServices(
            (businessInfo.websiteAnalysis.coreServices.topLevel ?? []).filter(
              (value): value is string => typeof value === "string",
            ),
          ),
          subOfferings: filterOutGenericServices(
            (businessInfo.websiteAnalysis.coreServices.subOfferings ?? []).filter(
              (value): value is string => typeof value === "string",
            ),
          ),
          industryFocus: filterOutGenericServices(
            (businessInfo.websiteAnalysis.coreServices.industryFocus ?? []).filter(
              (value): value is string => typeof value === "string",
            ),
          ),
        }
      : null;

    // 🆕 NEW: Return structured response with all data clearly visible
    return sendSuccess(
      res,
      {
        businessInfo: {
          // Basic business info
          id: businessInfo.id,
          businessName: businessInfo.businessName,
          businessType: businessInfo.businessType,
          businessDescription: businessInfo.businessDescription,
          businessWebsiteUrl: businessInfo.businessWebsiteUrl,
          selectedServices: businessInfo.selectedServices,
          detectedServices: cleanedDetectedServices,
          effectiveServices,

          // Geographic & Preferences
          geographic: {
            address: businessInfo.businessAddress,
            city: businessInfo.businessCity,
            state: businessInfo.businessState,
            country: businessInfo.businessCountry,
            serviceArea: businessInfo.serviceArea,
          },
          preferences: {
            targetAudience: businessInfo.targetAudience,
            contentTone: businessInfo.contentTone,
            publishingFrequency: businessInfo.publishingFrequency,
            publishDaysOfWeek: businessInfo.publishDaysOfWeek,
            preferredContentTypes: businessInfo.preferredContentTypes,
          },

          // Author profile (flat — consumed directly by frontend components)
          authorName: businessInfo.authorName,
          authorBio: businessInfo.authorBio,
          authorJobTitle: businessInfo.authorJobTitle,
          authorImage: businessInfo.authorImage,
          authorExpertise: businessInfo.authorExpertise,
          authorSocialLinks: businessInfo.authorSocialLinks,

          // Related data
          keywords: businessInfo.keywords,
          competitors: businessInfo.competitiors,
          competitiveAdvantages: businessInfo.competitiveAdvantage,
          currentRankings: businessInfo.currentRanking,
          brandAnalysis: businessInfo.BrandAnalysis,

          // 🆕 Complete Website Analysis Structure
          websiteAnalysis: businessInfo.websiteAnalysis
            ? {
                id: businessInfo.websiteAnalysis.id,
                scrapedUrl: businessInfo.websiteAnalysis.scrapedUrl,
                domain: businessInfo.websiteAnalysis.domain,
                userId: businessInfo.websiteAnalysis.userId,
                createdAt: businessInfo.websiteAnalysis.createdAt,
                updatedAt: businessInfo.websiteAnalysis.updatedAt,

                brandIdentity: businessInfo.websiteAnalysis.brandIdentity,
                design: businessInfo.websiteAnalysis.design,
                techStack: businessInfo.websiteAnalysis.techStack,
                coreServices: cleanedCoreServices,
                recognition: businessInfo.websiteAnalysis.recognition,
                seo: businessInfo.websiteAnalysis.seo,
                sitemap: businessInfo.websiteAnalysis.sitemap,
                contactInfo: businessInfo.websiteAnalysis.contactInfo,
                socialMedia: businessInfo.websiteAnalysis.socialMedia,
                navigation: businessInfo.websiteAnalysis.navigation,
              }
            : null,

          // User info
          user: businessInfo.User,

          // Timestamps
          createdAt: businessInfo.createdAt,
          updatedAt: businessInfo.updatedAt,
        },

        // Summary for quick reference
        summary: {
          hasWebsiteAnalysis: !!businessInfo.websiteAnalysis,
          hasBrandAnalysis: !!businessInfo.BrandAnalysis,
          keywordsCount: businessInfo.keywords.length,
          competitorsCount: businessInfo.competitiors.length,
          websiteAnalysisDataPoints: businessInfo.websiteAnalysis
            ? {
                hasBrandIdentity: !!businessInfo.websiteAnalysis.brandIdentity,
                hasDesign: !!businessInfo.websiteAnalysis.design,
                hasTechStack: !!businessInfo.websiteAnalysis.techStack,
                hasCoreServices: !!businessInfo.websiteAnalysis.coreServices,
                hasSEO: !!businessInfo.websiteAnalysis.seo,
                socialMediaCount:
                  businessInfo.websiteAnalysis.socialMedia?.length || 0,
                navigationCount:
                  businessInfo.websiteAnalysis.navigation?.length || 0,
              }
            : null,
        },
      },
      "Business information retrieved successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(
      res,
      "Failed to retrieve business information",
      500,
      error,
    );
  }
}

export async function getSitemapUrl(req: AuthenticatedRequest, res: Response) {
  try {
    const authUserId = req.authUserId;
    if (!authUserId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = GET_SITEMAP_URL.parse(body);

    let targetBusiness;

    if (payload.businessId) {
      targetBusiness = await prisma.business.findFirst({
        where: {
          id: payload.businessId,
          userId: authUserId,
          isActive: true,
        },
      });
    } else {
      targetBusiness = await prisma.business.findFirst({
        where: {
          userId: authUserId,
          isPrimary: true,
          isActive: true,
        },
      });
    }

    if (!targetBusiness) {
      return sendError(res, "Business not found", 404);
    }

    let requestedUrl: URL;
    let ownedUrl: URL;
    try {
      requestedUrl = new URL(payload.websiteUrl);
      ownedUrl = new URL(targetBusiness.businessWebsiteUrl);
    } catch {
      return sendError(res, "Invalid website URL", 400);
    }
    const canonicalHost = (hostname: string) =>
      hostname.toLowerCase().replace(/^www\./, "");
    if (canonicalHost(requestedUrl.hostname) !== canonicalHost(ownedUrl.hostname)) {
      return sendError(res, "Invalid website URL", 400);
    }
    try {
      await guardUrl(payload.websiteUrl);
    } catch (error) {
      if (error instanceof SsrfBlocked) {
        return sendError(res, "Invalid website URL", 400);
      }
      throw error;
    }

    let sitemapUrlToUse = payload.websiteUrl;
    let discoveredSitemapUrl: string | null = null;
    try {
      discoveredSitemapUrl = await discoverSitemapUrl(payload.websiteUrl);
      if (discoveredSitemapUrl) {
        sitemapUrlToUse = discoveredSitemapUrl;
        console.log(`✅ Found sitemap for business ${targetBusiness.id}`);
      }
    } catch (discoverError) {
      console.warn("Sitemap auto-discovery failed; trying the submitted URL");
    }

    const sitemapUrls = await fetchSitemapUrls(sitemapUrlToUse);

    if (!sitemapUrls || sitemapUrls.length === 0) {
      console.log("No URLs found in sitemap");
    }

    const existingSitemap = await prisma.sitemapUrls.findFirst({
      where: {
        userId: authUserId,
        businessId: targetBusiness.id,
      },
    });

    const result = existingSitemap
      ? await prisma.sitemapUrls.update({
          where: { id: existingSitemap.id },
          data: {
            urls: sitemapUrls || [],
          },
        })
      : await prisma.sitemapUrls.create({
          data: {
            urls: sitemapUrls || [],
            businessId: targetBusiness.id,
            userId: authUserId,
          },
        });

    if (sitemapUrls && sitemapUrls.length > 0) {
      upsertSitemapUrls(targetBusiness.id, authUserId, sitemapUrls).catch(
        console.error,
      );
    }

    return sendSuccess(
      res,
      {
        sitemap: result,
        discoveredSitemapUrl: discoveredSitemapUrl,
        totalUrls: sitemapUrls?.length || 0,
      },
      discoveredSitemapUrl
        ? "Sitemap auto-discovered and processed successfully"
        : "Sitemap URLs processed successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to process sitemap URLs", 500, error);
  }
}

export async function getBrandAnalysisStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const brandAnalysis = await prisma.brandAnalysis.findUnique({
      where: { businessId: business.id },
      select: {
        id: true,
        primaryColors: true,
        secondaryColors: true,
        fontFamily: true,
        logoUrl: true,
        logoAltText: true,
        faviconUrl: true,
        lastAnalyzed: true,
        analysisVersion: true,
      },
    });

    if (!brandAnalysis) {
      return sendLegacySuccess(
        res,
        {
          status: "idle",
          message: "Brand analysis not yet performed",
        },
        "Brand analysis status",
      );
    }

    if (isBrandAnalysisPending(brandAnalysis.analysisVersion)) {
      return sendLegacySuccess(
        res,
        {
          status: "processing",
          message: "Brand analysis is still running",
        },
        "Brand analysis status",
      );
    }

    return sendLegacySuccess(
      res,
      {
        status: "completed",
        brandData: brandAnalysis,
        message: "Brand analysis completed successfully",
      },
      "Brand analysis status",
    );
  } catch (error) {
    console.error("Error getting brand analysis status:", error);
    return sendError(res, "Failed to get brand analysis status", 500, error);
  }
}

export async function triggerBrandAnalysis(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: {
          id: true,
          businessWebsiteUrl: true,
          BrandAnalysis: true,
        },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: {
          id: true,
          businessWebsiteUrl: true,
          BrandAnalysis: true,
        },
      });
    }

    if (!business) {
      return sendError(
        res,
        "Business not found. Please complete onboarding first.",
        404,
      );
    }

    if (!business.businessWebsiteUrl) {
      return sendError(res, "Business website URL not found", 400);
    }

    await prisma.brandAnalysis.upsert({
      where: { businessId: business.id },
      create: {
        businessId: business.id,
        primaryColors: [],
        secondaryColors: [],
        fontFamily: null,
        logoUrl: null,
        logoAltText: null,
        faviconUrl: null,
        referenceImageUrl: null,
        lastAnalyzed: new Date(),
        analysisVersion: MANUAL_BRAND_ANALYSIS_PENDING_VERSION,
      },
      update: {
        lastAnalyzed: new Date(),
        analysisVersion: MANUAL_BRAND_ANALYSIS_PENDING_VERSION,
      },
    });
    console.log(
      `🔄 Marked brand analysis as pending for business ${business.id}`,
    );

    await inngest.send({
      name: "brand/analyze",
      data: {
        businessId: business.id,
        websiteUrl: business.businessWebsiteUrl,
        userId: userId,
        forceRefresh: true,
        source: "manual_reanalysis",
      },
    });

    console.log(
      `✅ Brand analysis triggered manually for business ${business.id}`,
    );

    return sendLegacySuccess(
      res,
      {
        status: "processing",
        message: "Brand analysis started. This may take a few moments.",
        businessId: business.id,
      },
      "Brand analysis triggered successfully",
    );
  } catch (error) {
    console.error("Error triggering brand analysis:", error);
    return sendError(res, "Failed to trigger brand analysis", 500, error);
  }
}

export async function getBlogImages(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const images = await prisma.blogImage.findMany({
      where: { businessId: business.id },
      orderBy: [
        { isSelected: "desc" },
        { imageType: "asc" },
        { extractedAt: "desc" },
      ],
    });

    return sendSuccess(res, { images }, "Blog images retrieved successfully");
  } catch (error) {
    console.error("Error fetching blog images:", error);
    return sendError(res, "Failed to fetch blog images", 500, error);
  }
}

export async function updateBlogImageSelection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { imageId, isSelected, businessId } = req.body as {
      imageId?: string;
      isSelected?: boolean;
      businessId?: string;
    };

    if (!imageId || typeof isSelected !== "boolean") {
      return sendError(
        res,
        "imageId and isSelected are required",
        400,
      );
    }

    const business = await prisma.business.findFirst({
      where: businessId
        ? { id: businessId, userId, isActive: true }
        : { userId, isPrimary: true, isActive: true },
      select: { id: true },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const existingImage = await prisma.blogImage.findFirst({
      where: { id: imageId, businessId: business.id },
      select: { id: true },
    });
    if (!existingImage) {
      return sendError(res, "Image not found", 404);
    }

    const image = await prisma.blogImage.update({
      where: { id: existingImage.id },
      data: { isSelected },
    });

    if (isSelected) {
      await prisma.blogImage.updateMany({
        where: {
          businessId: business.id,
          id: { not: existingImage.id },
        },
        data: { isSelected: false },
      });
    }

    return sendSuccess(
      res,
      { image },
      "Blog image selection updated successfully",
    );
  } catch (error) {
    console.error("Error updating blog image selection:", error);
    return sendError(res, "Failed to update blog image selection", 500, error);
  }
}

export async function deleteBlogImage(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { imageId, businessId } = req.body as {
      imageId?: string;
      businessId?: string;
    };

    if (!imageId) {
      return sendError(res, "imageId is required", 400);
    }

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const existingImage = await prisma.blogImage.findFirst({
      where: {
        id: imageId,
        businessId: business.id,
      },
      select: { id: true },
    });

    if (!existingImage) {
      return sendError(res, "Image not found", 404);
    }

    await prisma.blogImage.delete({
      where: { id: existingImage.id },
    });

    return sendSuccess(
      res,
      { deleted: true, imageId: existingImage.id },
      "Blog image deleted successfully",
    );
  } catch (error) {
    console.error("Error deleting blog image:", error);
    return sendError(res, "Failed to delete blog image", 500, error);
  }
}

export async function uploadBlogImage(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };
    type ReqWithFile = AuthenticatedRequest & { file?: { fieldname: string; originalname: string; encoding: string; mimetype: string; size: number; buffer: Buffer } };
    const file = (req as ReqWithFile).file;

    if (!file) {
      return sendError(res, "No image file provided", 400);
    }

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    let inspection;
    try {
      const { inspectImageUpload } = await import(
        "../services/onboarding-v2-author-image.service"
      );
      inspection = inspectImageUpload(file.buffer, file.mimetype, {
        maxBytes: 10 * 1024 * 1024,
        maxDimension: 8_192,
        maxPixels: 40_000_000,
      });
    } catch (error) {
      if (error instanceof OnboardingV2AuthorImageValidationError) {
        return sendError(res, error.message, error.statusCode);
      }
      throw error;
    }

    // Persist through the platform-wide Bunny image storage adapter.
    const { uploadImageBuffer } = await import("../lib/image-storage");
    const imageUrl = await uploadImageBuffer(
      file.buffer,
      inspection.mimeType,
      "blog-images",
    );

    const blogImage = await prisma.blogImage.create({
      data: {
        businessId: business.id,
        imageUrl,
        imageAlt: safeOnboardingV2AuthorImageName(file.originalname, "blog-image"),
        source: "manual",
        uploadedBy: userId,
        imageType: "reference",
      },
    });

    return sendSuccess(
      res,
      { image: blogImage },
      "Image uploaded successfully",
    );
  } catch (error) {
    console.error("Error uploading blog image:", error);
    return sendError(res, "Failed to upload image", 500, error);
  }
}

export async function uploadBusinessAuthorImage(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);

    const businessId =
      typeof req.body?.businessId === "string" ? req.body.businessId.trim() : "";
    if (!businessId) {
      return sendError(res, "Business is required", 400, {
        code: "BUSINESS_AUTHOR_IMAGE_BUSINESS_REQUIRED",
      });
    }

    const file = (
      req as AuthenticatedRequest & { file?: Express.Multer.File }
    ).file;
    if (!file) {
      return sendError(res, "Author image is required", 400, {
        code: "BUSINESS_AUTHOR_IMAGE_REQUIRED",
      });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId, isActive: true },
      select: { id: true },
    });
    if (!business) return sendError(res, "Business not found", 404);

    let inspection;
    try {
      inspection = inspectOnboardingV2AuthorImage(
        file.buffer,
        file.mimetype,
      );
    } catch (error) {
      if (error instanceof OnboardingV2AuthorImageValidationError) {
        return sendError(res, error.message, error.statusCode, {
          code: error.code.replace("ONBOARDING_V2_", "BUSINESS_"),
          message: error.message,
        });
      }
      throw error;
    }

    let upload;
    try {
      upload = await uploadImageBufferWithMetadata(
        file.buffer,
        inspection.mimeType,
        {
          folder: `businesses/${userId}/${business.id}/author-images`,
          publicId: `author-${inspection.checksumSha256.toLowerCase().slice(0, 32)}`,
        },
      );
    } catch (error) {
      console.error("[Business author image] Bunny upload failed", error);
      return sendError(res, "Author image storage is temporarily unavailable", 503, {
        code: "BUSINESS_AUTHOR_IMAGE_STORAGE_FAILED",
        message: "The author image was not saved. Please retry the upload.",
        details: { retryable: true },
      });
    }

    return sendSuccess(
      res,
      {
        image: {
          height: inspection.height,
          mimeType: inspection.mimeType,
          name: safeOnboardingV2AuthorImageName(file.originalname),
          provider: upload.provider,
          sizeBytes: inspection.sizeBytes,
          url: upload.url,
          width: inspection.width,
        },
      },
      "Author image uploaded successfully",
    );
  } catch (error) {
    console.error("Error uploading business author image:", error);
    return sendError(res, "Failed to upload author image", 500, error);
  }
}

export async function uploadBusinessBrandLogoController(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);

    const businessId =
      typeof req.body?.businessId === "string" ? req.body.businessId.trim() : "";
    if (!businessId) {
      return sendError(res, "Business is required", 400, {
        code: "BUSINESS_BRAND_LOGO_BUSINESS_REQUIRED",
      });
    }

    const file = (
      req as AuthenticatedRequest & { file?: Express.Multer.File }
    ).file;
    if (!file) {
      return sendError(res, "Brand logo is required", 400, {
        code: "BUSINESS_BRAND_LOGO_REQUIRED",
      });
    }

    const business = await prisma.business.findFirst({
      where: { id: businessId, userId, isActive: true },
      select: {
        id: true,
        businessName: true,
        BrandAnalysis: { select: { logoAltText: true } },
      },
    });
    if (!business) return sendError(res, "Business not found", 404);

    let upload;
    try {
      upload = await uploadBusinessBrandLogo({
        buffer: file.buffer,
        businessId: business.id,
        declaredMimeType: file.mimetype,
        userId,
      });
    } catch (error) {
      if (error instanceof OnboardingV2BrandLogoValidationError) {
        return sendError(res, error.message, error.statusCode, {
          code: error.code.replace("ONBOARDING_V2_", "BUSINESS_"),
          message: error.message,
        });
      }
      console.error("[Business brand logo] Bunny upload failed", error);
      return sendError(res, "Brand logo storage is temporarily unavailable", 503, {
        code: "BUSINESS_BRAND_LOGO_STORAGE_FAILED",
        message: "The brand logo was not saved. Please retry the upload.",
        details: { retryable: true },
      });
    }

    const logoAltText =
      business.BrandAnalysis?.logoAltText?.trim() ||
      `${business.businessName.trim() || "Business"} logo`;
    const brandData = await prisma.brandAnalysis.upsert({
      where: { businessId: business.id },
      create: {
        businessId: business.id,
        primaryColors: [],
        secondaryColors: [],
        logoUrl: upload.url,
        logoAltText,
        analysisVersion: "manual-logo-v1",
      },
      update: {
        logoUrl: upload.url,
        logoAltText,
      },
      select: {
        id: true,
        primaryColors: true,
        secondaryColors: true,
        fontFamily: true,
        logoUrl: true,
        logoAltText: true,
        faviconUrl: true,
        lastAnalyzed: true,
        analysisVersion: true,
      },
    });

    return sendSuccess(
      res,
      {
        brandData,
        logo: {
          height: upload.height,
          mimeType: upload.canonicalMimeType,
          provider: upload.provider,
          sizeBytes: upload.sizeBytes,
          sourceMimeType: upload.sourceMimeType,
          url: upload.url,
          width: upload.width,
        },
      },
      "Brand logo uploaded successfully",
    );
  } catch (error) {
    console.error("Error uploading business brand logo:", error);
    return sendError(res, "Failed to upload brand logo", 500, error);
  }
}

export async function triggerBlogImageExtraction(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const { businessId } = req.body as { businessId?: string };

    let business;
    if (businessId) {
      business = await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true, businessWebsiteUrl: true },
      });
    } else {
      business = await prisma.business.findFirst({
        where: {
          userId,
          isPrimary: true,
          isActive: true,
        },
        select: { id: true, businessWebsiteUrl: true },
      });
    }

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    // Trigger background task
    await inngest.send({
      name: "blog-images/extract",
      data: {
        businessId: business.id,
        userId,
        websiteUrl: business.businessWebsiteUrl,
        useSitemap: true,
      },
    });

    return sendSuccess(
      res,
      { status: "processing" },
      "Blog image extraction started",
    );
  } catch (error) {
    console.error("Error triggering blog image extraction:", error);
    return sendError(res, "Failed to trigger extraction", 500, error);
  }
}
