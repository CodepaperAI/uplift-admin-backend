import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";

const DEMO_SOURCE = "gmb_demo";
const DEMO_ALLOWED_ENVS = new Set(["development", "dev", "local", "test"]);
const PRODUCTION_ENVS = new Set(["production", "prod"]);

type DemoBusiness = {
  id: string;
  businessName: string;
  businessType: string;
  businessDescription: string;
  businessWebsiteUrl: string;
  businessPhone: string | null;
  businessAddress: string | null;
  businessCity: string | null;
  businessState: string | null;
  businessCountry: string | null;
  selectedServices: string[];
};

export function isGmbDemoModeEnabled() {
  const runtimeEnv = getGmbDemoRuntimeEnv();

  return (
    DEMO_ALLOWED_ENVS.has(runtimeEnv) &&
    process.env.GMB_DEMO_MODE === "true"
  );
}

export function assertGmbDemoModeEnabled() {
  if (!isGmbDemoModeEnabled()) {
    const error = new Error("GMB demo mode is not enabled");
    (error as Error & { statusCode?: number }).statusCode =
      PRODUCTION_ENVS.has(getGmbDemoRuntimeEnv()) ? 404 : 403;
    throw error;
  }
}

function getGmbDemoRuntimeEnv() {
  return (
    process.env.APP_ENV ||
    process.env.DEPLOY_ENV ||
    process.env.ENVIRONMENT ||
    process.env.NODE_ENV ||
    ""
  ).toLowerCase();
}

export function isDemoGmbConnection(connection?: { isDemo?: boolean } | null) {
  return Boolean(connection?.isDemo && isGmbDemoModeEnabled());
}

function demoId(prefix: string, businessId: string) {
  return `demo-${prefix}-${businessId}`;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function atStartOfDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function monthStart(monthOffset = 0) {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthOffset, 1));
}

function demoBusinessAddress(business: DemoBusiness) {
  return (
    business.businessAddress ||
    [
      "123 Demo Street",
      business.businessCity || "Toronto",
      business.businessState || "ON",
      business.businessCountry || "CA",
    ]
      .filter(Boolean)
      .join(", ")
  );
}

function demoCategories(business: DemoBusiness) {
  const categories = [
    business.businessType,
    ...business.selectedServices.slice(0, 2),
    "Local SEO Service",
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(categories));
}

function safeDomain(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

export class GMBDemoDataService {
  async connectDemoBusiness(businessId: string, options: { reset?: boolean } = {}) {
    assertGmbDemoModeEnabled();

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        businessName: true,
        businessType: true,
        businessDescription: true,
        businessWebsiteUrl: true,
        businessPhone: true,
        businessAddress: true,
        businessCity: true,
        businessState: true,
        businessCountry: true,
        selectedServices: true,
      },
    });

    if (!business) {
      throw new Error("Business not found");
    }

    const existing = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true, isDemo: true },
    });

    if (existing && !existing.isDemo) {
      throw new Error("A real Google Business Profile is already connected");
    }

    if (existing && options.reset) {
      await this.resetDemoRows(businessId, existing.id);
    }

    const categories = demoCategories(business);
    const address = demoBusinessAddress(business);
    const now = new Date();

    const gmb = await prisma.googleMyBusiness.upsert({
      where: { businessId },
      update: {
        accessToken: "demo-access-token",
        refreshToken: "demo-refresh-token",
        tokenExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        accountId: demoId("account", businessId),
        accountName: "Demo Google Business Account",
        locationId: demoId("location", businessId),
        locationName: business.businessName,
        placeId: demoId("place", businessId),
        businessName: business.businessName,
        businessAddress: address,
        businessPhone: business.businessPhone || "+1 416-555-0199",
        businessWebsite: business.businessWebsiteUrl,
        isActive: true,
        isDemo: true,
        lastSyncAt: now,
        lastSyncError: null,
        totalReviewCount: 5,
        cachedInsightsViews: 2480,
        cachedInsightsClicks: 184,
        cachedInsightsCalls: 36,
        cachedInsightsDirections: 51,
        cachedAverageRating: 4.6,
        cachedCategories: categories,
      },
      create: {
        id: demoId("gmb", businessId),
        businessId,
        accessToken: "demo-access-token",
        refreshToken: "demo-refresh-token",
        tokenExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        accountId: demoId("account", businessId),
        accountName: "Demo Google Business Account",
        locationId: demoId("location", businessId),
        locationName: business.businessName,
        placeId: demoId("place", businessId),
        businessName: business.businessName,
        businessAddress: address,
        businessPhone: business.businessPhone || "+1 416-555-0199",
        businessWebsite: business.businessWebsiteUrl,
        isActive: true,
        isDemo: true,
        lastSyncAt: now,
        lastSyncError: null,
        totalReviewCount: 5,
        cachedInsightsViews: 2480,
        cachedInsightsClicks: 184,
        cachedInsightsCalls: 36,
        cachedInsightsDirections: 51,
        cachedAverageRating: 4.6,
        cachedCategories: categories,
      },
    });

    await this.seedDemoRows(business, gmb.id);

    return {
      businessId,
      gmbId: gmb.id,
      seeded: true,
      reset: Boolean(options.reset),
    };
  }

  async resetDemoBusiness(businessId: string) {
    return this.connectDemoBusiness(businessId, { reset: true });
  }

  async disconnectDemoBusiness(businessId: string) {
    assertGmbDemoModeEnabled();

    const existing = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true, isDemo: true },
    });

    if (!existing) {
      return { businessId, disconnected: true };
    }

    if (!existing.isDemo) {
      throw new Error("Refusing to disconnect a real Google Business Profile from demo mode");
    }

    await this.resetDemoRows(businessId, existing.id);
    await prisma.googleMyBusiness.delete({ where: { businessId } });

    return { businessId, disconnected: true };
  }

  async createDemoPost(
    businessId: string,
    postData: {
      postType: string;
      title?: string;
      summary?: string;
      callToAction?: string;
      mediaUrls?: string[];
    },
  ) {
    const gmb = await this.getDemoConnection(businessId);
    return prisma.gMBPost.create({
      data: {
        gmbId: gmb.id,
        postId: `accounts/${gmb.accountId}/locations/${gmb.locationId}/localPosts/demo-${Date.now()}`,
        postType: postData.postType,
        title: postData.title ?? "Demo Google post",
        summary: postData.summary ?? null,
        callToAction: postData.callToAction ?? null,
        mediaUrls: postData.mediaUrls ?? [],
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });
  }

  async respondToDemoReview(businessId: string, reviewId: string, response: string) {
    const gmb = await this.getDemoConnection(businessId);
    const review = await prisma.gMBReview.findFirst({
      where: { gmbId: gmb.id, reviewId },
      select: { id: true, reviewId: true, isResponded: true, response: true, responseDate: true },
    });

    if (!review) {
      throw new Error("Review not found for this Google Business Profile");
    }

    if (review.isResponded) {
      return {
        status: "already_responded_local" as const,
        reviewId: review.reviewId,
        response: review.response ?? response,
        responseDate: review.responseDate?.toISOString() ?? null,
      };
    }

    const responseDate = new Date();
    await prisma.gMBReview.update({
      where: { id: review.id },
      data: { response, responseDate, isResponded: true },
    });

    return {
      status: "posted" as const,
      reviewId: review.reviewId,
      response,
      responseDate: responseDate.toISOString(),
    };
  }

  async getDemoProfileDetails(businessId: string) {
    const gmb = await this.getDemoConnection(businessId);
    const snapshot = await prisma.gMBProfileSnapshot.findFirst({
      where: { businessId, gmbId: gmb.id },
      orderBy: { syncedAt: "desc" },
    });

    if (snapshot?.profileJson) {
      return snapshot.profileJson as Record<string, unknown>;
    }

    return {
      name: `locations/${gmb.locationId}`,
      title: gmb.businessName,
      websiteUri: gmb.businessWebsite,
      phoneNumbers: { primaryPhone: gmb.businessPhone },
      metadata: {
        placeId: gmb.placeId,
        mapsUri: `https://maps.google.com/?cid=${encodeURIComponent(gmb.placeId ?? "")}`,
      },
    };
  }

  async updateDemoProfileDetails(
    businessId: string,
    businessData: Record<string, unknown>,
  ) {
    const gmb = await this.getDemoConnection(businessId);
    const current = await this.getDemoProfileDetails(businessId);
    const next = structuredClone(current) as Record<string, unknown>;

    if (typeof businessData.name === "string" && businessData.name.trim()) {
      next.title = businessData.name.trim();
    }

    if (
      typeof businessData.phoneNumber === "string" &&
      businessData.phoneNumber.trim()
    ) {
      next.phoneNumbers = {
        ...((next.phoneNumbers as Record<string, unknown> | undefined) ?? {}),
        primaryPhone: businessData.phoneNumber.trim(),
      };
    }

    if (
      typeof businessData.websiteUrl === "string" &&
      businessData.websiteUrl.trim()
    ) {
      next.websiteUri = businessData.websiteUrl.trim();
    }

    if (
      typeof businessData.description === "string" &&
      businessData.description.trim()
    ) {
      next.profile = {
        ...((next.profile as Record<string, unknown> | undefined) ?? {}),
        description: businessData.description.trim(),
      };
    }

    if (typeof businessData.address === "string" && businessData.address.trim()) {
      next.storefrontAddress = {
        ...((next.storefrontAddress as Record<string, unknown> | undefined) ?? {}),
        addressLines: [businessData.address.trim()],
      };
    }

    await prisma.gMBProfileSnapshot.create({
      data: {
        businessId,
        gmbId: gmb.id,
        profileJson: next as Prisma.InputJsonValue,
        categoriesJson:
          ((next.categories as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        attributesJson:
          ((next.attributes as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        servicesJson:
          ((next.serviceItems as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        hoursJson:
          ((next.regularHours as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        specialHoursJson:
          ((next.specialHours as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        moreHoursJson:
          ((next.moreHours as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        serviceAreaJson:
          ((next.serviceArea as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        googleUpdatesJson:
          ((next.googleUpdated as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull),
        source: DEMO_SOURCE,
        syncedAt: new Date(),
      },
    });

    await prisma.googleMyBusiness.update({
      where: { businessId },
      data: {
        businessName:
          typeof next.title === "string" ? next.title : gmb.businessName,
        businessPhone:
          typeof (next.phoneNumbers as { primaryPhone?: unknown } | undefined)
            ?.primaryPhone === "string"
            ? ((next.phoneNumbers as { primaryPhone: string }).primaryPhone)
            : gmb.businessPhone,
        businessWebsite:
          typeof next.websiteUri === "string" ? next.websiteUri : gmb.businessWebsite,
        businessAddress:
          typeof businessData.address === "string"
            ? businessData.address
            : gmb.businessAddress,
        lastSyncAt: new Date(),
        lastSyncError: null,
      },
    });

    return next;
  }

  async getDemoPerformanceDailyMetrics(businessId: string, days = 90) {
    const since = daysAgo(days);
    const rows = await prisma.gMBDailyMetric.findMany({
      where: {
        businessId,
        metricDate: { gte: since },
      },
      orderBy: { metricDate: "asc" },
    });

    return rows.map((row) => ({
      date: row.metricDate.toISOString().slice(0, 10),
      impressionsSearch: row.impressionsSearch,
      impressionsMaps: row.impressionsMaps,
      websiteClicks: row.websiteClicks,
      callClicks: row.callClicks,
      directionRequests: row.directionRequests,
      bookings: row.bookings,
      menuClicks: row.menuClicks,
      foodOrders: row.foodOrders,
      raw: {
        source: 1,
        impressionsSearch: row.impressionsSearch,
        impressionsMaps: row.impressionsMaps,
      },
    }));
  }

  async getDemoDiscoveryKeywordImpressions(businessId: string, months = 3) {
    const since = monthStart(-Math.max(0, months - 1));
    const rows = await prisma.gMBDiscoveryKeyword.findMany({
      where: {
        businessId,
        month: { gte: since },
      },
      orderBy: [{ month: "asc" }, { impressions: "desc" }],
    });

    return rows.map((row) => ({
      keyword: row.keyword,
      month: row.month.toISOString().slice(0, 10),
      impressions: row.impressions,
      raw: row.rawJson,
    }));
  }

  async getDemoConnection(businessId: string) {
    assertGmbDemoModeEnabled();

    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
    });

    if (!gmb || !gmb.isDemo || !gmb.isActive) {
      throw new Error("Google My Business not connected");
    }

    return gmb;
  }

  private async resetDemoRows(businessId: string, gmbId: string) {
    await prisma.gMBReviewAnalysis.deleteMany({ where: { businessId } });
    await prisma.gMBAISuggestion.deleteMany({ where: { businessId } });
    await prisma.gMBPostSuggestion.deleteMany({ where: { businessId } });
    await this.resetBusinessScopedDemoRows(businessId);
    await prisma.gMBPost.deleteMany({ where: { gmbId } });
    await prisma.gMBReview.deleteMany({ where: { gmbId } });
  }

  private async resetBusinessScopedDemoRows(businessId: string) {
    await prisma.gMBAlert.deleteMany({ where: { businessId } });
    await prisma.gMBAttributionLink.deleteMany({ where: { businessId } });
    await prisma.gMBReviewCampaign.deleteMany({ where: { businessId } });
    await prisma.gMBCompetitorSnapshot.deleteMany({ where: { businessId } });
    await prisma.gMBLocalRankScan.deleteMany({ where: { businessId } });
    await prisma.gMBMediaAsset.deleteMany({ where: { businessId } });
    await prisma.gMBActionRecommendation.deleteMany({ where: { businessId } });
    await prisma.gMBProfileHealthRun.deleteMany({ where: { businessId } });
    await prisma.gMBDiscoveryKeyword.deleteMany({ where: { businessId } });
    await prisma.gMBDailyMetric.deleteMany({ where: { businessId } });
    await prisma.gMBProfileSnapshot.deleteMany({ where: { businessId } });
  }

  private async seedDemoRows(business: DemoBusiness, gmbId: string) {
    await this.resetDemoRows(business.id, gmbId);

    const categories = demoCategories(business);
    const address = demoBusinessAddress(business);
    const gmb = await prisma.googleMyBusiness.findUniqueOrThrow({
      where: { id: gmbId },
    });

    await this.seedProfileSnapshot(business, gmbId, categories, address);
    await this.seedPosts(gmbId, business);
    await this.seedReviews(gmb);
    await this.seedMetrics(gmbId, business.id);
    await this.seedDiscoveryKeywords(gmbId, business);
    await this.seedHealthAndActions(gmbId, business);
    await this.seedMedia(gmbId, business);
    await this.seedRankScansAndCompetitors(gmbId, business, categories, address);
    await this.seedAttribution(gmbId, business);
    await this.seedReviewCampaign(gmbId, business, gmb.placeId);
    await this.seedAlerts(gmbId, business.id);
    await this.seedAiCaches(business);
  }

  private async seedProfileSnapshot(
    business: DemoBusiness,
    gmbId: string,
    categories: string[],
    address: string,
  ) {
    const profile = {
      name: `locations/${demoId("location", business.id)}`,
      title: business.businessName,
      storefrontAddress: {
        addressLines: [address],
        locality: business.businessCity || "Toronto",
        administrativeArea: business.businessState || "ON",
        postalCode: "M5H 2N2",
        regionCode: business.businessCountry || "CA",
      },
      phoneNumbers: {
        primaryPhone: business.businessPhone || "+1 416-555-0199",
      },
      websiteUri: business.businessWebsiteUrl,
      categories: {
        primaryCategory: { displayName: categories[0] ?? business.businessType },
        additionalCategories: categories.slice(1).map((category) => ({ displayName: category })),
      },
      regularHours: {
        periods: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((day) => ({
          openDay: day,
          openTime: { hours: 9 },
          closeDay: day,
          closeTime: { hours: 17 },
        })),
      },
      specialHours: { specialHourPeriods: [] },
      moreHours: {},
      serviceArea: { places: { placeInfos: [{ placeName: business.businessCity || "Toronto" }] } },
      serviceItems: business.selectedServices.map((service) => ({ structuredServiceItem: { serviceTypeId: service } })),
      attributes: [{ attributeId: "has_website", valueType: "BOOL", values: [true] }],
      profile: {
        description:
          business.businessDescription ||
          `${business.businessName} helps local customers with ${business.businessType}.`,
      },
      metadata: {
        placeId: demoId("place", business.id),
        mapsUri: `https://maps.google.com/?cid=${demoId("place", business.id)}`,
        newReviewUri: `https://search.google.com/local/writereview?placeid=${demoId("place", business.id)}`,
      },
      googleUpdated: [
        {
          field: "regularHours",
          value: "Google suggested a holiday-hours confirmation.",
          detectedAt: daysAgo(3).toISOString(),
        },
      ],
    };

    await prisma.gMBProfileSnapshot.create({
      data: {
        businessId: business.id,
        gmbId,
        profileJson: profile as Prisma.InputJsonValue,
        categoriesJson: categories as Prisma.InputJsonValue,
        attributesJson: profile.attributes as Prisma.InputJsonValue,
        servicesJson: profile.serviceItems as Prisma.InputJsonValue,
        hoursJson: profile.regularHours as Prisma.InputJsonValue,
        specialHoursJson: profile.specialHours as Prisma.InputJsonValue,
        moreHoursJson: profile.moreHours as Prisma.InputJsonValue,
        serviceAreaJson: profile.serviceArea as Prisma.InputJsonValue,
        googleUpdatesJson: profile.googleUpdated as Prisma.InputJsonValue,
        source: DEMO_SOURCE,
        syncedAt: new Date(),
      },
    });
  }

  private async seedPosts(gmbId: string, business: DemoBusiness) {
    await prisma.gMBPost.createMany({
      data: [
        {
          id: demoId("post-1", business.id),
          gmbId,
          postId: `accounts/${demoId("account", business.id)}/locations/${demoId("location", business.id)}/localPosts/demo-1`,
          postType: "UPDATE",
          title: "Local visibility checklist",
          summary: "We shared a quick checklist to help local customers understand what to look for before booking.",
          callToAction: business.businessWebsiteUrl,
          mediaUrls: ["https://images.unsplash.com/photo-1497366754035-f200968a6e72"],
          status: "PUBLISHED",
          publishedAt: daysAgo(4),
        },
        {
          id: demoId("post-2", business.id),
          gmbId,
          postId: `accounts/${demoId("account", business.id)}/locations/${demoId("location", business.id)}/localPosts/demo-2`,
          postType: "OFFER",
          title: "Seasonal consultation offer",
          summary: "Book a free local consultation this week and get a clear next-step plan.",
          callToAction: business.businessWebsiteUrl,
          mediaUrls: ["https://images.unsplash.com/photo-1556761175-4b46a572b786"],
          status: "PUBLISHED",
          publishedAt: daysAgo(18),
        },
      ],
    });
  }

  private async seedReviews(gmb: { id: string; accountId: string | null; locationId: string | null }) {
    const prefix = `accounts/${gmb.accountId}/locations/${gmb.locationId}/reviews`;
    const reviews = [
      {
        id: demoId("review-1", gmb.id),
        reviewId: `${prefix}/demo-recent-1`,
        reviewerName: "Maya Chen",
        rating: 5,
        comment: "Fast, professional, and easy to work with. The team explained every step clearly.",
        reviewDate: daysAgo(12),
        isResponded: false,
      },
      {
        id: demoId("review-2", gmb.id),
        reviewId: `${prefix}/demo-recent-2`,
        reviewerName: "Jordan Patel",
        rating: 4,
        comment: "Good experience overall. I would love to see more weekend appointment options.",
        reviewDate: daysAgo(34),
        response: "Thanks Jordan. We appreciate the feedback and are reviewing weekend availability.",
        responseDate: daysAgo(33),
        isResponded: true,
      },
      {
        id: demoId("review-3", gmb.id),
        reviewId: `${prefix}/demo-recent-3`,
        reviewerName: "Sofia Martinez",
        rating: 5,
        comment: "Helpful service and great communication from start to finish.",
        reviewDate: daysAgo(72),
        isResponded: false,
      },
      {
        id: demoId("review-old", gmb.id),
        reviewId: `${prefix}/demo-old-hidden`,
        reviewerName: "Old Demo Review",
        rating: 2,
        comment: "This older review should stay cached but hidden by the six-month window.",
        reviewDate: daysAgo(230),
        isResponded: false,
      },
    ];

    for (const review of reviews) {
      await prisma.gMBReview.create({
        data: {
          reviewerPhoto: null,
          response: null,
          responseDate: null,
          ...review,
          gmbId: gmb.id,
        },
      });
    }

    await prisma.gMBAIReviewResponse.create({
      data: {
        reviewId: demoId("review-1", gmb.id),
        response: "Thank you, Maya. We are glad the process felt clear and professional.",
        intent: "praise",
        generatedAt: new Date(),
        expiresAt: daysAgo(-7),
      },
    });
  }

  private async seedMetrics(gmbId: string, businessId: string) {
    const rows = Array.from({ length: 45 }, (_, index) => {
      const date = atStartOfDay(daysAgo(44 - index));
      const wave = Math.round(12 * Math.sin(index / 4));
      return {
        businessId,
        gmbId,
        metricDate: date,
        impressionsSearch: 42 + index + wave,
        impressionsMaps: 31 + Math.round(index * 0.7),
        websiteClicks: 3 + (index % 6),
        callClicks: 1 + (index % 3),
        directionRequests: 1 + (index % 4),
        bookings: index % 9 === 0 ? 1 : 0,
        menuClicks: index % 7,
        foodOrders: 0,
        rawJson: { source: DEMO_SOURCE, dayIndex: index } as Prisma.InputJsonValue,
      };
    });

    await prisma.gMBDailyMetric.createMany({ data: rows });
  }

  private async seedDiscoveryKeywords(gmbId: string, business: DemoBusiness) {
    const services = business.selectedServices.length > 0
      ? business.selectedServices.slice(0, 4)
      : [business.businessType, "local service"];
    const city = business.businessCity || "Toronto";
    const keywords = [
      `${business.businessType} near me`,
      `${services[0]} ${city}`,
      `best ${business.businessType} ${city}`,
      `${services[1] ?? business.businessType} reviews`,
      `${business.businessName} directions`,
    ];

    const rows = keywords.flatMap((keyword, keywordIndex) =>
      [0, -1, -2].map((offset, monthIndex) => ({
        businessId: business.id,
        gmbId,
        keyword,
        month: monthStart(offset),
        impressions: 220 - keywordIndex * 24 - monthIndex * 18,
        source: DEMO_SOURCE,
        rawJson: { source: DEMO_SOURCE, keywordIndex, monthIndex } as Prisma.InputJsonValue,
      })),
    );

    await prisma.gMBDiscoveryKeyword.createMany({ data: rows });
  }

  private async seedHealthAndActions(gmbId: string, business: DemoBusiness) {
    const categories = [
      business.businessType,
      "Local Service",
      "Service Establishment",
    ].filter(Boolean);

    await prisma.gMBProfileHealthRun.create({
      data: {
        businessId: business.id,
        gmbId,
        score: 82,
        completenessScore: 22,
        reputationScore: 20,
        engagementScore: 16,
        visibilityScore: 16,
        conversionScore: 8,
        summary: "Demo profile is strong, with review response and photo cadence opportunities.",
        source: DEMO_SOURCE,
        items: {
          create: [
            {
              checkKey: "profile_complete",
              title: "Core profile fields are complete",
              description: "Name, website, phone, address, and categories are present.",
              category: "completeness",
              status: "pass",
              priority: "low",
              scoreImpact: 0,
              recommendedAction: "Keep profile basics current.",
            },
            {
              checkKey: "review_response_gap",
              title: "Two recent reviews need replies",
              description: "Replying quickly improves trust and conversion.",
              category: "reputation",
              status: "warning",
              priority: "high",
              scoreImpact: 8,
              recommendedAction: "Approve or write replies for recent unanswered reviews.",
            },
            {
              checkKey: "photo_cadence",
              title: "Add fresh profile photos",
              description: "Recent photos help customers confirm the business is active.",
              category: "engagement",
              status: "warning",
              priority: "medium",
              scoreImpact: 5,
              recommendedAction: "Upload one fresh team, work, or location photo this week.",
            },
          ],
        },
      },
    });

    await prisma.gMBActionRecommendation.createMany({
      data: [
        {
          id: demoId("action-review", business.id),
          businessId: business.id,
          gmbId,
          actionType: "review_reply",
          title: "Approve AI reply for Maya Chen",
          description: "A recent five-star review has a ready-to-review AI response.",
          category: "reputation",
          priority: "high",
          status: "PENDING",
          payloadJson: {
            source: DEMO_SOURCE,
            reviewId: `accounts/${demoId("account", business.id)}/locations/${demoId("location", business.id)}/reviews/demo-recent-1`,
            response: "Thank you, Maya. We appreciate the kind words and are glad the process was clear.",
          } as Prisma.InputJsonValue,
          source: DEMO_SOURCE,
        },
        {
          id: demoId("action-profile", business.id),
          businessId: business.id,
          gmbId,
          actionType: "profile_edit",
          title: "Add service-focused profile description",
          description: "Make the profile description more specific to local search intent.",
          category: "completeness",
          priority: "medium",
          status: "PENDING",
          payloadJson: {
            source: DEMO_SOURCE,
            businessData: {
              description: `${business.businessName} helps customers in ${business.businessCity || "Toronto"} with ${business.selectedServices.slice(0, 3).join(", ") || business.businessType}. Request service, directions, or a quick consultation from our Google profile.`,
            },
            requiresGooglePatch: true,
            profileReview: {
              currentProfile: {
                syncedAt: new Date().toISOString(),
                businessName: business.businessName,
                description:
                  business.businessDescription ||
                  `${business.businessName} helps local customers with ${business.businessType}.`,
                phoneNumber: business.businessPhone || "+1 416-555-0199",
                websiteUrl: business.businessWebsiteUrl,
                address: demoBusinessAddress(business),
                categories,
                services: business.selectedServices,
                regularHours: "Regular hours configured",
                specialHours: "Special hours configured",
              },
              diffs: [
                {
                  field: "description",
                  label: "Business description",
                  currentValue:
                    business.businessDescription ||
                    `${business.businessName} helps local customers with ${business.businessType}.`,
                  proposedValue: `${business.businessName} helps customers in ${business.businessCity || "Toronto"} with ${business.selectedServices.slice(0, 3).join(", ") || business.businessType}. Request service, directions, or a quick consultation from our Google profile.`,
                  googleField: "profile.description",
                  applySupported: true,
                },
              ],
            },
          } as Prisma.InputJsonValue,
          source: DEMO_SOURCE,
        },
      ],
    });
  }

  private async seedMedia(gmbId: string, business: DemoBusiness) {
    await prisma.gMBMediaAsset.createMany({
      data: [
        {
          id: demoId("media-1", business.id),
          businessId: business.id,
          gmbId,
          sourceUrl: "https://images.unsplash.com/photo-1521737604893-d14cc237f11d",
          googleUrl: null,
          mediaType: "PHOTO",
          category: "TEAM",
          status: "PENDING",
          caption: "Team photo ready for Google Business Profile approval.",
        },
        {
          id: demoId("media-2", business.id),
          businessId: business.id,
          gmbId,
          sourceUrl: "https://images.unsplash.com/photo-1497366754035-f200968a6e72",
          googleUrl: "https://lh3.googleusercontent.com/demo-photo",
          mediaType: "PHOTO",
          category: "INTERIOR",
          status: "PUBLISHED",
          caption: "Demo workspace photo already published.",
          publishedAt: daysAgo(8),
        },
      ],
    });
  }

  private async seedRankScansAndCompetitors(
    gmbId: string,
    business: DemoBusiness,
    categories: string[],
    address: string,
  ) {
    const keyword = `${business.businessType} ${business.businessCity || "Toronto"}`;
    await prisma.gMBLocalRankScan.create({
      data: {
        id: demoId("rank-scan", business.id),
        businessId: business.id,
        gmbId,
        keyword,
        locationLabel: business.businessCity || "Toronto",
        locationCode: 2124,
        latitude: 43.6532,
        longitude: -79.3832,
        status: "COMPLETE",
        source: DEMO_SOURCE,
        requestedAt: daysAgo(2),
        completedAt: daysAgo(2),
        rawJson: { source: DEMO_SOURCE, resultCount: 4 } as Prisma.InputJsonValue,
        results: {
          create: [
            {
              position: 1,
              rankAbsolute: 1,
              matchConfidence: 0.96,
              matchedBy: "place_id",
              title: business.businessName,
              domain: safeDomain(business.businessWebsiteUrl),
              url: business.businessWebsiteUrl,
              placeId: demoId("place", business.id),
              cid: demoId("cid", business.id),
              rating: 4.6,
              reviewCount: 5,
              categoriesJson: categories as Prisma.InputJsonValue,
              address,
              latitude: 43.6532,
              longitude: -79.3832,
              isClient: true,
              rawJson: { source: DEMO_SOURCE } as Prisma.InputJsonValue,
            },
            {
              position: 2,
              rankAbsolute: 2,
              matchConfidence: 0,
              title: "North Star Local Services",
              domain: "northstarlocal.example",
              url: "https://northstarlocal.example",
              placeId: "demo-competitor-place-1",
              cid: "demo-competitor-cid-1",
              rating: 4.8,
              reviewCount: 126,
              categoriesJson: categories as Prisma.InputJsonValue,
              address: "85 King St W, Toronto, ON",
              latitude: 43.6487,
              longitude: -79.3817,
              isClient: false,
              rawJson: { source: DEMO_SOURCE } as Prisma.InputJsonValue,
            },
            {
              position: 3,
              rankAbsolute: 3,
              matchConfidence: 0,
              title: "Maple Growth Studio",
              domain: "maplegrowth.example",
              url: "https://maplegrowth.example",
              placeId: "demo-competitor-place-2",
              cid: "demo-competitor-cid-2",
              rating: 4.5,
              reviewCount: 84,
              categoriesJson: categories as Prisma.InputJsonValue,
              address: "120 Queen St W, Toronto, ON",
              latitude: 43.6511,
              longitude: -79.384,
              isClient: false,
              rawJson: { source: DEMO_SOURCE } as Prisma.InputJsonValue,
            },
          ],
        },
      },
    });

    await prisma.gMBCompetitorSnapshot.createMany({
      data: [
        {
          id: demoId("competitor-1", business.id),
          businessId: business.id,
          gmbId,
          name: "North Star Local Services",
          domain: "northstarlocal.example",
          url: "https://northstarlocal.example",
          placeId: "demo-competitor-place-1",
          cid: "demo-competitor-cid-1",
          rating: 4.8,
          reviewCount: 126,
          categoriesJson: categories as Prisma.InputJsonValue,
          strengthsJson: { reviews: "Higher review count", source: DEMO_SOURCE } as Prisma.InputJsonValue,
          weaknessesJson: { website: "Thin service pages", source: DEMO_SOURCE } as Prisma.InputJsonValue,
          source: DEMO_SOURCE,
          lastSeenAt: daysAgo(2),
        },
        {
          id: demoId("competitor-2", business.id),
          businessId: business.id,
          gmbId,
          name: "Maple Growth Studio",
          domain: "maplegrowth.example",
          url: "https://maplegrowth.example",
          placeId: "demo-competitor-place-2",
          cid: "demo-competitor-cid-2",
          rating: 4.5,
          reviewCount: 84,
          categoriesJson: categories as Prisma.InputJsonValue,
          strengthsJson: { categories: "Strong category match", source: DEMO_SOURCE } as Prisma.InputJsonValue,
          weaknessesJson: { posts: "Low posting cadence", source: DEMO_SOURCE } as Prisma.InputJsonValue,
          source: DEMO_SOURCE,
          lastSeenAt: daysAgo(2),
        },
      ],
    });
  }

  private async seedAttribution(gmbId: string, business: DemoBusiness) {
    const destination = business.businessWebsiteUrl || "https://upliftai.co/";
    await prisma.gMBAttributionLink.createMany({
      data: [
        {
          id: demoId("attribution-profile", business.id),
          businessId: business.id,
          gmbId,
          surface: "profile_website",
          destinationUrl: destination,
          taggedUrl: `${destination}${destination.includes("?") ? "&" : "?"}utm_source=google&utm_medium=organic&utm_campaign=gbp&utm_content=profile`,
          campaign: "gbp",
          content: "profile",
        },
        {
          id: demoId("attribution-post", business.id),
          businessId: business.id,
          gmbId,
          surface: "post_cta",
          destinationUrl: destination,
          taggedUrl: `${destination}${destination.includes("?") ? "&" : "?"}utm_source=google&utm_medium=organic&utm_campaign=gbp&utm_content=post`,
          campaign: "gbp",
          content: "post",
        },
      ],
    });
  }

  private async seedReviewCampaign(gmbId: string, business: DemoBusiness, placeId: string | null) {
    await prisma.gMBReviewCampaign.create({
      data: {
        id: demoId("review-campaign", business.id),
        businessId: business.id,
        gmbId,
        name: "Demo review request campaign",
        status: "DRAFT",
        reviewLink: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId ?? demoId("place", business.id))}`,
        emailSubject: `How was your experience with ${business.businessName}?`,
        emailBody:
          "Thank you for choosing us. If you have a moment, please share an honest Google review.",
        qrCodeUrl: "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=demo",
        sentCount: 18,
        clickedCount: 7,
      },
    });
  }

  private async seedAlerts(gmbId: string, businessId: string) {
    await prisma.gMBAlert.createMany({
      data: [
        {
          id: demoId("alert-review", businessId),
          businessId,
          gmbId,
          alertType: "unanswered_reviews",
          title: "Two recent reviews need replies",
          description: "Approve AI replies or write manual responses before the next review digest.",
          severity: "high",
          status: "OPEN",
          payloadJson: { source: DEMO_SOURCE } as Prisma.InputJsonValue,
        },
        {
          id: demoId("alert-hours", businessId),
          businessId,
          gmbId,
          alertType: "holiday_hours",
          title: "Confirm upcoming holiday hours",
          description: "Google may show suggested holiday hours if you do not confirm them.",
          severity: "medium",
          status: "OPEN",
          payloadJson: { source: DEMO_SOURCE } as Prisma.InputJsonValue,
        },
      ],
    });
  }

  private async seedAiCaches(business: DemoBusiness) {
    await prisma.gMBAISuggestion.create({
      data: {
        businessId: business.id,
        suggestions: [
          {
            id: "demo-suggestion-1",
            title: "Reply to recent reviews",
            description: "Two recent reviews are unanswered and ready for AI-assisted replies.",
            priority: "high",
            category: "engagement",
            impact: "Improve trust signals and profile conversion.",
          },
        ] as Prisma.InputJsonValue,
        profileCompleteness: 86,
        expiresAt: daysAgo(-7),
      },
    });

    await prisma.gMBReviewAnalysis.create({
      data: {
        businessId: business.id,
        sentimentSummary: {
          positive: 3,
          neutral: 1,
          negative: 0,
          positivePercent: 75,
          neutralPercent: 25,
          negativePercent: 0,
        } as Prisma.InputJsonValue,
        commonThemes: [
          {
            theme: "Communication",
            count: 3,
            sentiment: "positive",
            examples: ["explained every step clearly", "great communication"],
          },
        ] as Prisma.InputJsonValue,
        businessInsights: [
          {
            category: "Review response",
            insight: "Recent reviews mention communication quality; replies can reinforce that differentiator.",
            priority: "high",
            actionItems: ["Approve pending review replies", "Mention fast communication in posts"],
          },
        ] as Prisma.InputJsonValue,
        totalReviewsAnalyzed: 3,
        averageRating: 4.7,
        expiresAt: daysAgo(-7),
      },
    });

    await prisma.gMBPostSuggestion.create({
      data: {
        id: demoId("post-suggestion", business.id),
        businessId: business.id,
        postType: "UPDATE",
        title: "Local customer checklist",
        summary: "Share a short checklist that helps local customers choose the right provider before booking.",
        callToAction: business.businessWebsiteUrl,
        mediaUrls: ["https://images.unsplash.com/photo-1556761175-4b46a572b786"] as Prisma.InputJsonValue,
        status: "PENDING",
        generatedAt: new Date(),
        expiresAt: daysAgo(-14),
      },
    });
  }
}

export const gmbDemoDataService = new GMBDemoDataService();
