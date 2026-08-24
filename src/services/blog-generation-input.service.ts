/**
 * blog-generation-input.service.ts
 *
 * READ-ONLY. Assembles the inputs that the production blog generator expects
 * (the same shape the Inngest handler builds), so the comparison harness can
 * drive the REAL pipeline in dry-run without duplicating the handler or writing
 * anything. Mirrors inngest/client.ts businessInfoForBlog assembly.
 *
 * Only prisma findUnique. No writes. brandData is intentionally null (it only
 * affects image styling, which dry-run skips), keeping this faithful for the
 * text-quality comparison without guessing BrandAnalysis field shapes.
 */

import { prisma } from "../config/db.config";
import { resolveEffectiveServices } from "../utils/effective-services.utils";

export interface AssembledBlogInputs {
  blogInformation: string;
  keywordInfo: string;
  businessLocation: {
    businessCity?: string;
    businessState?: string;
    businessCountry?: string;
    businessAddress?: string;
    verified: boolean;
  };
  brandData: null;
  locale: string;
}

export interface AssembledPlanBlogInputs extends AssembledBlogInputs {
  plan: {
    id: string;
    userId: string;
    businessId: string;
    keyword: string;
    keywordInstructions: string | null;
    publishDate: string;
    publishTime: string;
  };
}

export async function assembleBlogGenerationInputs(
  userId: string,
  businessId: string,
  keyword: string,
): Promise<AssembledBlogInputs | null> {
  const businessInfo = await prisma.business.findUnique({
    where: { id: businessId, userId },
    include: {
      keywords: true,
      competitiveAdvantage: true,
      competitiors: true,
      CompetitorIntelligences: true,
      currentRanking: true,
      User: true,
      BrandAnalysis: true,
      // Local + social-proof grounding for the rank-modules (parity with the
      // production inngest path).
      GeoProfile: true,
      GMBReviewAnalysis: true,
      GMBBusinessHours: true,
      GoogleMyBusiness: {
        include: { gmbReviews: { take: 5, orderBy: { reviewDate: "desc" } } },
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
  });
  if (!businessInfo) return null;

  const effectiveServices = resolveEffectiveServices(businessInfo as never);

  let realPhotos: Array<{
    url: string;
    altText: string | null;
    category: string;
  }> = [];
  try {
    const { getPreferredBlogPhotos } = await import(
      "./business-photos.service"
    );
    const photos = await getPreferredBlogPhotos(businessId, 3);
    realPhotos = photos.map((p) => ({
      url: p.url,
      altText: p.altText,
      category: p.category,
    }));
  } catch {
    realPhotos = [];
  }

  const businessInfoForBlog = {
    ...businessInfo,
    enhancedBusinessInfo: businessInfo.websiteAnalysis?.businessInfo || null,
    coreServices: effectiveServices,
    effectiveServices,
    realPhotos,
  };

  return {
    blogInformation: JSON.stringify(businessInfoForBlog),
    keywordInfo: JSON.stringify({ keyword }),
    businessLocation: {
      businessCity: businessInfo.businessCity ?? undefined,
      businessState: businessInfo.businessState ?? undefined,
      businessCountry: businessInfo.businessCountry ?? undefined,
      businessAddress: businessInfo.businessAddress ?? undefined,
      verified: false,
    },
    brandData: null,
    locale: businessInfo.defaultLocale || "en-US",
  };
}

/**
 * Assemble the real generator input for one immutable recovery Plan. Passing
 * the complete Plan JSON preserves its exact schedule and content lock instead
 * of resolving another same-business keyword by text.
 */
export async function assembleBlogGenerationInputsForPlan(
  planId: string,
): Promise<AssembledPlanBlogInputs | null> {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      businessId: true,
      keyword: true,
      keywordInstructions: true,
      publishDate: true,
      publishTime: true,
      blogId: true,
      isUsed: true,
      usedAt: true,
      deletedAt: true,
    },
  });
  if (
    !plan?.businessId ||
    plan.blogId ||
    plan.isUsed ||
    plan.usedAt ||
    plan.deletedAt
  ) {
    return null;
  }

  const base = await assembleBlogGenerationInputs(
    plan.userId,
    plan.businessId,
    plan.keyword,
  );
  if (!base) return null;

  const exactPlan = {
    id: plan.id,
    userId: plan.userId,
    businessId: plan.businessId,
    keyword: plan.keyword,
    keywordInstructions: plan.keywordInstructions,
    publishDate: plan.publishDate,
    publishTime: plan.publishTime,
  };
  return {
    ...base,
    keywordInfo: JSON.stringify(exactPlan),
    plan: exactPlan,
  };
}
