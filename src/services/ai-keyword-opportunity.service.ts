import { prisma } from "../config/db.config";
import { isNearDuplicateKeyword } from "../utils/dataforseo-keyword-plan.utils";

/**
 * AI Keyword Opportunity Discovery Service
 *
 * Analyzes citation data to find "gap keywords" — keywords where
 * competitors get cited by AI but the business doesn't. These are
 * the highest-potential opportunities for AI visibility.
 */

export interface KeywordOpportunity {
  keyword: string;
  competitorDomains: string[];
  citationGap: number; // 0-1: how much opportunity exists
  ourCitationRate: number;
  competitorCitationCount: number;
  suggestedPriority: "high" | "medium";
  reason: string;
  inPlan: boolean;
}

/**
 * Discover keywords where competitors are cited but we're not.
 */
export async function discoverAiKeywordOpportunities(
  businessId: string,
): Promise<KeywordOpportunity[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const citations = await prisma.llmCitation.findMany({
    where: {
      businessId,
      createdAt: { gte: thirtyDaysAgo },
    },
    orderBy: { createdAt: "desc" },
  });

  if (citations.length === 0) return [];

  const existingPlans = await prisma.plan.findMany({
    where: {
      businessId,
      deletedAt: null,
    },
    select: { keyword: true },
  });

  // Group by keyword
  const keywordData = new Map<
    string,
    {
      totalCited: number;
      totalRuns: number;
      competitors: Map<string, number>; // domain -> count of citations
    }
  >();

  for (const c of citations) {
    if (!keywordData.has(c.keyword)) {
      keywordData.set(c.keyword, {
        totalCited: 0,
        totalRuns: 0,
        competitors: new Map(),
      });
    }
    const data = keywordData.get(c.keyword)!;
    data.totalCited += c.citedCount;
    data.totalRuns += c.totalRuns;

    const comps = (c.competitorsCited as any[]) || [];
    for (const comp of comps) {
      if (comp.domain) {
        data.competitors.set(
          comp.domain,
          (data.competitors.get(comp.domain) || 0) + 1,
        );
      }
    }
  }

  // Find opportunities: keywords where competitors are cited but we have low/no citation
  const opportunities: KeywordOpportunity[] = [];

  for (const [keyword, data] of keywordData) {
    const ourRate = data.totalRuns > 0 ? data.totalCited / data.totalRuns : 0;
    const competitorCount = data.competitors.size;

    if (competitorCount > 0 && ourRate < 0.5) {
      const competitorDomains = Array.from(data.competitors.keys());
      const citationGap = (1 - ourRate) * Math.min(competitorCount / 3, 1);

      const priority = citationGap > 0.7 ? "high" : "medium";
      const reason =
        ourRate === 0
          ? `${competitorCount} competitor(s) cited but you're not — big opportunity`
          : `You're cited ${Math.round(ourRate * 100)}% of the time but ${competitorCount} competitor(s) also cited — room to improve`;

      opportunities.push({
        keyword,
        competitorDomains,
        citationGap,
        ourCitationRate: ourRate,
        competitorCitationCount: competitorCount,
        suggestedPriority: priority,
        reason,
        inPlan: existingPlans.some((plan) =>
          isNearDuplicateKeyword(plan.keyword, keyword),
        ),
      });
    }
  }

  // Sort by gap (highest opportunity first)
  return opportunities.sort((a, b) => b.citationGap - a.citationGap);
}

/**
 * Add an opportunity keyword to the content plan for blog generation.
 *
 * Handles:
 * - Near-duplicate detection (Jaccard similarity, not just exact match)
 * - Respects business publishDaysOfWeek
 * - Appends AFTER existing plan (doesn't replace anything)
 * - Limits AI-discovered keywords to max 10 per business per month
 */
export async function addOpportunityKeywordToPlan(
  businessId: string,
  userId: string,
  keyword: string,
) {
  // Check near-duplicate against ALL existing plan keywords (not just exact match)
  const existingPlans = await prisma.plan.findMany({
    where: {
      businessId,
      deletedAt: null,
    },
    select: { id: true, keyword: true },
  });

  const duplicate = existingPlans.find((p) => isNearDuplicateKeyword(p.keyword, keyword));
  if (duplicate) {
    return {
      success: false,
      message: `Similar keyword "${duplicate.keyword}" already exists in your content plan`,
      planId: duplicate.id,
    };
  }

  // Check monthly limit: max 10 AI-discovered keywords per business per month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const aiKeywordsThisMonth = await prisma.plan.count({
    where: {
      businessId,
      keywordSource: "ai_opportunity",
      createdAt: { gte: monthStart },
      deletedAt: null,
    },
  });

  if (aiKeywordsThisMonth >= 10) {
    return {
      success: false,
      message: "Monthly limit reached (10 AI-discovered keywords per month). Existing keywords will be generated first.",
    };
  }

  // Get business publish day preferences
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { publishDaysOfWeek: true },
  });
  const allowedDays = business?.publishDaysOfWeek?.length
    ? business.publishDaysOfWeek
    : [0, 1, 2, 3, 4, 5, 6]; // Default: all days

  // Find next available publish date AFTER all existing scheduled keywords
  const lastPlan = await prisma.plan.findFirst({
    where: { businessId, deletedAt: null },
    orderBy: { publishDate: "desc" },
    select: { publishDate: true },
  });

  const nextDate = new Date();
  if (lastPlan?.publishDate) {
    const lastDate = new Date(lastPlan.publishDate);
    if (lastDate > nextDate) {
      nextDate.setTime(lastDate.getTime());
    }
  }
  nextDate.setDate(nextDate.getDate() + 1);

  // Skip to next allowed day of week (max 7 iterations)
  for (let i = 0; i < 7; i++) {
    if (allowedDays.includes(nextDate.getDay())) break;
    nextDate.setDate(nextDate.getDate() + 1);
  }

  const plan = await prisma.plan.create({
    data: {
      keyword,
      publishDate: nextDate.toISOString().slice(0, 10),
      publishTime: "09:00",
      keywordDiffculty: "0",
      keywordSearchVolume: "0",
      keywordIntent: "informational",
      keywordSource: "ai_opportunity",
      keywordCategory: "ai_citation_gap",
      userId,
      businessId,
    },
  });

  return {
    success: true,
    planId: plan.id,
    publishDate: plan.publishDate,
    message: `Added to plan for ${plan.publishDate}`,
  };
}
