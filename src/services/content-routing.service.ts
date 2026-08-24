import { prisma } from "../config/db.config";
import { ContentRouteType } from "@prisma/client";

/**
 * Content Routing Engine
 *
 * Determines optimal content strategy for each keyword/blog:
 * - GOOGLE: Traditional SEO (transactional intent)
 * - LLM: Citation-optimized (informational intent, not ranking on Google)
 * - DUAL: Both (informational + already ranking, or unclear intent)
 */

interface RouteDecision {
  route: ContentRouteType;
  confidence: number;
  reason: string;
}

const INFORMATIONAL_PATTERNS = [
  /^how\s+to\b/i,
  /^what\s+(is|are|does|do)\b/i,
  /^why\s+(is|are|does|do)\b/i,
  /^when\s+(to|should|do)\b/i,
  /^where\s+(to|can|do)\b/i,
  /\bguide\b/i,
  /\btutorial\b/i,
  /\btips\b/i,
  /\bexplained\b/i,
  /\bvs\b/i,
  /\bcompar/i,
  /\bdifference\s+between\b/i,
  /\bbest\s+way\s+to\b/i,
  /\bsteps\s+to\b/i,
  /\bbenefits\s+of\b/i,
  /\bsigns\s+(you|that|of)\b/i,
];

const TRANSACTIONAL_PATTERNS = [
  /\bbuy\b/i,
  /\bhire\b/i,
  /\bnear\s+me\b/i,
  /\bpric(e|ing|es)\b/i,
  /\bcost\s+of\b/i,
  /\baffordable\b/i,
  /\bcheap(est)?\b/i,
  /\bbook\s+(a|an)\b/i,
  /\bschedule\b/i,
  /\bget\s+a\s+quote\b/i,
  /\bfor\s+sale\b/i,
  /\bfree\s+(trial|estimate|consultation)\b/i,
  /\bservice(s)?\s+in\b/i,
  /\bcompany\s+in\b/i,
];

function classifyIntent(keyword: string): "informational" | "transactional" | "unclear" {
  const isInformational = INFORMATIONAL_PATTERNS.some((p) => p.test(keyword));
  const isTransactional = TRANSACTIONAL_PATTERNS.some((p) => p.test(keyword));

  if (isTransactional && !isInformational) return "transactional";
  if (isInformational && !isTransactional) return "informational";
  if (isTransactional && isInformational) return "unclear"; // Mixed signals
  return "unclear";
}

/**
 * Also checks the Plan model's keywordIntent field if available
 */
function getIntentFromPlan(keywordIntent: string | null | undefined): "informational" | "transactional" | "unclear" {
  if (!keywordIntent) return "unclear";
  const lower = keywordIntent.toLowerCase();
  if (lower === "informational") return "informational";
  if (lower === "transactional" || lower === "commercial") return "transactional";
  if (lower === "navigational") return "transactional"; // navigational = specific brand/site
  return "unclear";
}

export function determineContentRoute(
  keyword: string,
  keywordIntent?: string | null,
  hasExistingGoogleRanking?: boolean,
): RouteDecision {
  // Use Plan's keywordIntent if available, fallback to pattern matching
  const planIntent = getIntentFromPlan(keywordIntent);
  const patternIntent = classifyIntent(keyword);
  const intent = planIntent !== "unclear" ? planIntent : patternIntent;

  if (intent === "transactional") {
    return {
      route: "GOOGLE",
      confidence: 0.8,
      reason: "Transactional intent — purchase/hire queries still flow through Google search",
    };
  }

  if (intent === "informational") {
    if (hasExistingGoogleRanking) {
      return {
        route: "DUAL",
        confidence: 0.85,
        reason: "Informational intent with existing Google ranking — protect position while adding LLM signals",
      };
    }
    return {
      route: "LLM",
      confidence: 0.75,
      reason: "Informational intent — these are the queries people ask AI chatbots",
    };
  }

  // Default: DUAL (conservative)
  return {
    route: "DUAL",
    confidence: 0.5,
    reason: "Intent unclear — defaulting to dual optimization for both Google and LLM visibility",
  };
}

/**
 * Assign a content route to a blog post
 */
export async function assignContentRoute(
  blogId: string,
  businessId: string,
  keyword: string,
  keywordIntent?: string | null,
  hasExistingGoogleRanking?: boolean,
) {
  const decision = determineContentRoute(keyword, keywordIntent, hasExistingGoogleRanking);

  return prisma.contentRoute.upsert({
    where: { blogId },
    create: {
      blogId,
      businessId,
      route: decision.route,
      confidence: decision.confidence,
      reason: decision.reason,
    },
    update: {
      route: decision.route,
      confidence: decision.confidence,
      reason: decision.reason,
      assignedAt: new Date(),
    },
  });
}

/**
 * Override a content route manually
 */
export async function overrideContentRoute(
  blogId: string,
  route: ContentRouteType,
  reason?: string,
) {
  return prisma.contentRoute.update({
    where: { blogId },
    data: {
      route,
      confidence: 1.0,
      reason: reason || `Manually set to ${route}`,
      assignedAt: new Date(),
    },
  });
}

/**
 * Get content routes for a business
 */
export async function getContentRoutes(businessId: string) {
  return prisma.contentRoute.findMany({
    where: { businessId },
    include: {
      blog: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          createdAt: true,
        },
      },
    },
    orderBy: { assignedAt: "desc" },
  });
}

/**
 * Bulk-assign routes for all blogs in a business that don't have routes yet
 */
export async function assignRoutesForBusiness(businessId: string) {
  const blogsWithoutRoutes = await prisma.blog.findMany({
    where: {
      businessId,
      contentRoute: null,
    },
    include: {
      Plan: {
        select: {
          keyword: true,
          keywordIntent: true,
        },
        take: 1,
      },
    },
  });

  const results = [];
  for (const blog of blogsWithoutRoutes) {
    const plan = blog.Plan[0];
    if (plan) {
      const result = await assignContentRoute(
        blog.id,
        businessId,
        plan.keyword,
        plan.keywordIntent,
      );
      results.push(result);
    }
  }

  return results;
}
