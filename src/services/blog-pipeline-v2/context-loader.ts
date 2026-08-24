import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  languageToDefaultLocale,
  validateLocaleCode,
} from "../../utils/language.utils";
import { resolveEffectiveServices } from "../../utils/effective-services.utils";
import {
  hasActiveBlogGenerationAccess,
  isBlogGenerationBusinessLifecycleActive,
} from "../../utils/blog-generation-access.utils";
import {
  loadProductionContentStrategy,
  type ProductionContentStrategyContext,
} from "./content-strategy";

export class ProductionBlogEligibilityError extends Error {
  constructor(
    readonly code:
      | "plan_not_found"
      | "plan_deleted"
      | "ownership_mismatch"
      | "business_inactive"
      | "entitlement_inactive"
      | "plan_state_inconsistent",
    message: string,
  ) {
    super(message);
    this.name = "ProductionBlogEligibilityError";
  }
}

function isActiveEntitlement(input: {
  role: string;
  userSubscriptionStatus?: string | null;
  userTrialStatus?: string | null;
  userTrialStartDate?: Date | null;
  userTrialEndDate?: Date | null;
  websiteSubscription?: {
    status: string;
    trialStatus: string;
    trialStartDate?: Date | null;
    trialEndDate: Date | null;
  } | null;
  now: Date;
}): boolean {
  return hasActiveBlogGenerationAccess({
    user: {
      role: input.role,
      trialStatus: input.userTrialStatus ?? null,
      trialStartDate: input.userTrialStartDate ?? null,
      trialEndDate: input.userTrialEndDate ?? null,
      Subscription: input.userSubscriptionStatus
        ? { status: input.userSubscriptionStatus }
        : null,
    },
    websiteSubscription: input.websiteSubscription ?? null,
    now: input.now,
  });
}

export function resolveProductionPublicationLocale(input: {
  id: string;
  defaultLocale: string | null;
  defaultLanguage: string | null;
  businessCountry: string | null;
}): string {
  const configuredLocale = input.defaultLocale
    ? validateLocaleCode(input.defaultLocale)
    : input.defaultLanguage
      ? validateLocaleCode(
          languageToDefaultLocale(
            input.defaultLanguage,
            input.businessCountry?.toUpperCase(),
          ),
        )
      : "en-US";
  const language = configuredLocale.split(/[-_]/)[0]?.toLocaleLowerCase() || "en";
  const country = input.businessCountry?.trim().toLocaleLowerCase() ?? "";
  // Preserve the proven recovery locale correction: a Canadian business uses
  // its configured language with Canadian spelling even when an old default
  // locale was saved as en-US during onboarding.
  if (["ca", "can", "canada"].includes(country)) return `${language}-CA`;
  return configuredLocale;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item === undefined ? null : item));
}

export async function loadProductionBlogContext(input: {
  planId: string;
  userId: string;
  businessId: string;
  prisma?: PrismaClient;
  now?: Date;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const plan = await prisma.plan.findUnique({
    where: { id: input.planId },
    include: {
      business: {
        include: {
          websiteSubscription: true,
          User: { include: { Subscription: true } },
          keywords: true,
          competitiveAdvantage: true,
          competitiors: true,
          CompetitorIntelligences: true,
          currentRanking: true,
          BrandAnalysis: true,
          GeoProfile: true,
          GMBReviewAnalysis: true,
          GMBBusinessHours: true,
          GoogleMyBusiness: {
            include: {
              gmbReviews: { take: 5, orderBy: { reviewDate: "desc" } },
            },
          },
          websiteAnalysis: {
            include: {
              businessInfo: true,
              coreServices: true,
              seo: true,
              navigation: true,
            },
          },
        },
      },
    },
  });
  if (!plan) {
    throw new ProductionBlogEligibilityError("plan_not_found", "Plan not found");
  }
  if (plan.deletedAt) {
    throw new ProductionBlogEligibilityError("plan_deleted", "Plan is deleted");
  }
  const business = plan.business;
  if (
    plan.userId !== input.userId ||
    plan.businessId !== input.businessId ||
    business?.userId !== input.userId
  ) {
    throw new ProductionBlogEligibilityError(
      "ownership_mismatch",
      "Plan, user, and business ownership do not match",
    );
  }
  if (
    !business ||
    !isBlogGenerationBusinessLifecycleActive({
      isActive: business.isActive,
      websiteStatus: business.websiteStatus,
      websiteSubscription: business.websiteSubscription,
      now,
    })
  ) {
    throw new ProductionBlogEligibilityError(
      "business_inactive",
      "Business is not active",
    );
  }
  if (
    !isActiveEntitlement({
      role: business.User.role,
      userSubscriptionStatus: business.User.Subscription?.status,
      userTrialStatus: business.User.trialStatus,
      userTrialStartDate: business.User.trialStartDate,
      userTrialEndDate: business.User.trialEndDate,
      websiteSubscription: business.websiteSubscription,
      now,
    })
  ) {
    throw new ProductionBlogEligibilityError(
      "entitlement_inactive",
      "Business has no active paid or trial entitlement",
    );
  }
  if (!plan.blogId && (plan.isUsed || plan.usedAt)) {
    throw new ProductionBlogEligibilityError(
      "plan_state_inconsistent",
      "Unlinked Plan is already marked used",
    );
  }
  if (plan.blogId && (!plan.isUsed || !plan.usedAt)) {
    throw new ProductionBlogEligibilityError(
      "plan_state_inconsistent",
      "Linked Plan is not marked used",
    );
  }

  const [recentBlogs, strategyResult] = await Promise.all([
    prisma.blog.findMany({
      where: { businessId: input.businessId },
      select: { title: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    loadProductionContentStrategy({
      prisma,
      businessId: input.businessId,
      userId: input.userId,
      plan,
      now,
    }).catch((error) => {
      console.warn(
        `[BlogPipelineV2] Content strategy context unavailable for plan ${input.planId}:`,
        error instanceof Error ? error.message : String(error),
      );
      const context: ProductionContentStrategyContext = {
        searchConsole: {
          connected: false,
          lookbackDays: 90,
          cannibalization: {
            risk: "none",
            primaryKeyword: plan.keyword,
            matchingQueries: [],
            pages: [],
          },
        },
        cluster: null,
        planningDirective:
          "No Search Console or persisted cluster snapshot is available. Keep the article tightly scoped to the primary keyword and do not invent performance or cluster facts.",
      };
      return { context, preferredInternalLinks: [] };
    }),
  ]);
  const locale = resolveProductionPublicationLocale(business);
  const effectiveServices = resolveEffectiveServices(business as never);
  let realPhotos: Array<{
    url: string;
    altText: string | null;
    category: string;
  }> = [];
  try {
    const { getPreferredBlogPhotos } = await import(
      "../business-photos.service"
    );
    const photos = await getPreferredBlogPhotos(input.businessId, 3);
    realPhotos = photos.map((photo) => ({
      url: photo.url,
      altText: photo.altText,
      category: photo.category,
    }));
  } catch {
    realPhotos = [];
  }
  const businessInformation = compactJson({
    businessName: business.businessName,
    businessType: business.businessType,
    businessDescription: business.businessDescription,
    websiteUrl: business.businessWebsiteUrl,
    location: {
      address: business.businessAddress,
      city: business.businessCity,
      state: business.businessState,
      country: business.businessCountry,
      serviceArea: business.serviceArea,
      serviceAreaLocations: business.serviceAreaLocations,
    },
    targetAudience: business.targetAudience,
    tone: business.contentTone,
    preferredContentTypes: business.preferredContentTypes,
    selectedServices: business.selectedServices,
    effectiveServices,
    servicesPriority: business.servicesPriority,
    keywords: business.keywords,
    competitiveAdvantages: business.competitiveAdvantage,
    competitors: business.competitiors,
    competitorIntelligence: business.CompetitorIntelligences,
    currentRanking: business.currentRanking,
    geoProfile: business.GeoProfile,
    reviewAnalysis: business.GMBReviewAnalysis,
    businessHours: business.GMBBusinessHours,
    recentGoogleReviews: business.GoogleMyBusiness?.gmbReviews ?? [],
    websiteAnalysis: business.websiteAnalysis,
    contentStrategy: strategyResult.context,
    realPhotos,
    author: {
      name: business.authorName,
      biography: business.authorBio,
      jobTitle: business.authorJobTitle,
      expertise: business.authorExpertise,
    },
  });
  return {
    plan,
    business,
    locale,
    businessInformation,
    recentBusinessTitles: recentBlogs.map((blog) => blog.title),
    contentStrategy: strategyResult.context,
    preferredInternalLinks: strategyResult.preferredInternalLinks,
    businessLocation: {
      businessAddress: business.businessAddress,
      businessCity: business.businessCity,
      businessState: business.businessState,
      businessCountry: business.businessCountry,
      serviceArea: business.serviceArea,
      serviceAreaLocations: business.serviceAreaLocations,
    },
    brandData: business.BrandAnalysis
      ? {
          primaryColors: business.BrandAnalysis.primaryColors,
          secondaryColors: business.BrandAnalysis.secondaryColors,
          fontFamily: business.BrandAnalysis.fontFamily,
          logoUrl: business.BrandAnalysis.logoUrl,
          logoAltText: business.BrandAnalysis.logoAltText,
        }
      : null,
  };
}

export function researchLocationForContext(input: {
  locale: string;
  country: string | null;
  region: string | null;
  city: string | null;
}) {
  const country = (input.country ?? "").trim();
  const countryKey = country.toLocaleLowerCase();
  const byCountry: Record<string, number> = {
    canada: 2124,
    ca: 2124,
    "united states": 2840,
    usa: 2840,
    us: 2840,
    "united kingdom": 2826,
    uk: 2826,
    italy: 2380,
    it: 2380,
    india: 2356,
    australia: 2036,
    "united arab emirates": 2784,
    uae: 2784,
  };
  const languageCode = input.locale.split("-")[0]?.toLocaleLowerCase() || "en";
  return {
    locationCode: byCountry[countryKey] ?? 2840,
    languageCode,
    city: input.city,
    region: input.region,
    country: country || null,
  };
}
