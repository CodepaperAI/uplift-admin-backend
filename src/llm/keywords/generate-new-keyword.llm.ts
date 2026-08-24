import type { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.config";
import {
  getGraphMaxToolRounds,
  getGraphRecursionLimit,
  getLLMForKeywords,
} from "../../config/llm.config";
import {
  countFutureUndeletedKeywordSlots,
  getLatestScheduledKeywordDate,
  KEYWORD_RUNWAY_TARGET,
  normalizePlanDate,
} from "../../utils/keyword-plan-runway.utils";
import { resolveEffectiveServices } from "../../utils/effective-services.utils";
import { getLocationCode } from "../../utils/location.utils";
import { savePlanKeywords } from "../../utils/plan-keyword-save.utils";

import { analyzeBusinessContext } from "./business-context-analyzer";
import { extractCoreOfferings } from "./core-offerings-extractor";
import { shouldContinueWithGuards } from "../utils/graph-guard";
import { verifyKeyword, verifyKeywords } from "./keyword-verifier";
import { saveKeywordsToDb } from "./tools.keyword";

const tools: StructuredToolInterface[] = [saveKeywordsToDb];
const toolNode = new ToolNode(tools);

export const keywordLLM = getLLMForKeywords().bindTools(tools);

/**
 * Helper: Categorize keyword based on content
 */
function categorizeKeyword(keyword: string): string {
  const lower = keyword.toLowerCase();
  if (lower.match(/how to|what is|guide|tutorial|why|when/))
    return "informational";
  if (lower.match(/best|top|review|compare|vs|alternative/))
    return "commercial";
  if (lower.match(/near me|in \w+|local|\w+ \w+ area/)) return "local";
  if (lower.match(/buy|price|order|cost|purchase|hire|book/))
    return "transactional";
  return "informational";
}

/**
 * Helper: Determine search intent
 */
function determineIntent(keyword: string): string {
  const category = categorizeKeyword(keyword);
  if (category === "local") return "navigational";
  return category;
}

type KeywordWithMetrics = {
  keyword: string;
  searchVolume?: number;
  difficulty?: number;
  competition?: number;
};

function normalizeKeywordItem(item: unknown): KeywordWithMetrics | null {
  if (!item || typeof item !== "object" || !("keyword" in item)) return null;
  const raw = item as Record<string, unknown>;
  const keyword =
    typeof raw.keyword === "string"
      ? raw.keyword.trim()
      : String(raw.keyword ?? "").trim();
  if (!keyword) return null;
  const searchVolume =
    typeof raw.searchVolume === "number" && raw.searchVolume >= 0
      ? raw.searchVolume
      : typeof raw.searchVolume === "string"
        ? Math.max(0, parseInt(String(raw.searchVolume), 10) || 0)
        : undefined;
  const difficulty =
    typeof raw.difficulty === "number" &&
    raw.difficulty >= 0 &&
    raw.difficulty <= 100
      ? Math.round(raw.difficulty)
      : typeof raw.difficulty === "string"
        ? Math.min(100, Math.max(0, parseInt(String(raw.difficulty), 10) || 50))
        : undefined;
  const competition =
    typeof raw.competition === "number" && raw.competition >= 0
      ? raw.competition
      : typeof raw.competition === "string"
        ? parseFloat(String(raw.competition))
        : undefined;
  return { keyword, searchVolume, difficulty, competition };
}

function parseLLMSelection(content: string): KeywordWithMetrics[] {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => normalizeKeywordItem(item))
        .filter((item): item is KeywordWithMetrics => item !== null);
    }
    return [];
  } catch (error) {
    console.error("Failed to parse LLM selection:", error);
    return [];
  }
}

// GEO-KW-1: Local country-only stub removed. Now imported from
// ../../utils/location.utils.ts (city-aware, 54+ metro codes).

/**
 * Helper: Check if keyword has valid and comprehensive DataForSEO data
 * Requires: search volume, CPC (pricing), competition, and engagement data (clicks/impressions)
 */
function hasValidData(metrics: any): boolean {
  if (!metrics) return false;

  // CRITICAL: Must have search volume
  const hasSearchVolume =
    (metrics.searchVolume ?? 0) > 0 || (metrics.monthlySearches ?? 0) > 0;
  if (!hasSearchVolume) return false;

  // IMPORTANT: Must have CPC (pricing) information
  const hasCPC =
    metrics.cpc !== null && metrics.cpc !== undefined && metrics.cpc >= 0;
  if (!hasCPC) return false;

  // IMPORTANT: Must have competition data (for SEO strategy)
  const hasCompetition =
    metrics.competition !== null &&
    metrics.competition !== undefined &&
    metrics.competition >= 0;
  if (!hasCompetition) return false;

  // RECOMMENDED: Should have engagement data (clicks OR impressions)
  // This is optional but preferred - we'll still accept if missing
  const hasEngagement =
    (metrics.clicks !== null && metrics.clicks !== undefined) ||
    (metrics.impressions !== null && metrics.impressions !== undefined);

  // Return true only if all critical fields are present
  // Note: We're lenient on engagement data, but require search volume, CPC, and competition
  return hasSearchVolume && hasCPC && hasCompetition;
}

/**
 * NEW APPROACH: LLM-first keyword generation
 * LLM decides 30 keywords, then DataForSEO enriches them with real metrics
 * Keywords without valid data are automatically replaced
 */
export async function generateNewKeywordLLM(
  businessInfo: string,
  keywords: string,
  userId: string,
  businessId: string,
) {
  try {
    const business = JSON.parse(businessInfo);
    const previousKeywords = JSON.parse(keywords);

    console.log(`🎯 Starting LLM-only keyword generation for user ${userId}, business ${businessId}`);

    const existingKeywordsData = await prisma.plan.findMany({
      where: {
        userId,
        businessId,
        deletedAt: null,
      },
      select: {
        keyword: true,
        publishDate: true,
      },
    });

    const existingKeywordsCount = existingKeywordsData.length;
    const existingFutureKeywordCount =
      countFutureUndeletedKeywordSlots(existingKeywordsData);
    const existingKeywordTexts = new Set<string>(
      existingKeywordsData.map((kw) => kw.keyword.toLowerCase().trim()),
    );
    const existingDates = existingKeywordsData.map((kw) => kw.publishDate);

    console.log(
      `📊 User currently has ${existingKeywordsCount} undeleted keywords, ${existingFutureKeywordCount} of them scheduled for today/future`,
    );

    const TARGET_TOTAL = KEYWORD_RUNWAY_TARGET;
    const keywordsNeeded = Math.max(
      0,
      TARGET_TOTAL - existingFutureKeywordCount,
    );

    if (keywordsNeeded === 0) {
      console.log(
        `✅ User already has ${TARGET_TOTAL} scheduled keywords for today/future - no generation needed`,
      );
      return {
        success: true,
        count: 0,
        skipped: 0,
        method: "skipped",
        message: `User already has ${TARGET_TOTAL} scheduled keywords`,
        keywords: [],
      };
    }

    console.log(
      `🎯 Need to generate ${keywordsNeeded} keywords to reach ${TARGET_TOTAL} scheduled keywords`,
    );

    const businessContext = await analyzeBusinessContext(business);
    console.log("✅ Business context analysis completed");

    // GEO-FIX-6: Load geo context for the LLM-first fallback path so it
    // gets the same city-aware targeting as the main keyword planner.
    let geoCtx: import("../../utils/geo-keyword-context").GeoKeywordContext | null = null;
    if (businessId) {
      try {
        const { buildGeoKeywordContext } = await import("../../utils/geo-keyword-context");
        geoCtx = await buildGeoKeywordContext(businessId);
      } catch (err) {
        console.warn("[generate-new-keyword] GEO context failed:", (err as Error).message);
      }
    }

    const coreOfferings = await extractCoreOfferings(business);
    console.log("✅ Core offerings extraction completed");

    const coreServices = resolveEffectiveServices(business);

    const subOfferings: string[] = coreServices?.subOfferings || [];
    const businessSubOfferings =
      subOfferings.length > 0 ? subOfferings.join(", ") : "N/A";

    // 🔧 FIX: Define expandedSubOfferings for use in prompts
    const expandedSubOfferings = subOfferings.flatMap((offering) => {
      // Split on common separators and clean
      return offering
        .split(/[,/&+]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    });

    console.log(
      `📋 Sub-offerings found: ${subOfferings.length > 0 ? subOfferings.join(", ") : "None"}`,
    );
    console.log(
      `🔍 Expanded sub-offerings: ${expandedSubOfferings.length} items`,
    );

    const mustHaveKeywords =
      business.keywords
        ?.filter((k: any) => k.keywordType === "MUST_HAVE")
        .map((k: any) => k.keyword) || [];

    const llmPrompt = `You are an expert SEO strategist. Your task is to generate exactly ${keywordsNeeded} strategic keywords for a ${TARGET_TOTAL}-day BLOG CONTENT plan.

🧠 BUSINESS INTELLIGENCE ANALYSIS:
- Business Model: ${businessContext.businessModel.type} (Location Dependent: ${
      businessContext.businessModel.isLocationDependent ? "Yes" : "No"
    })
- Primary Services/Products: ${businessContext.services.primary.join(", ")}
- Secondary Services/Products: ${
      businessContext.services.secondary.join(", ") || "N/A"
    }
- Sub-Offerings/Sub-Services: ${businessSubOfferings}
  ${businessSubOfferings !== "N/A" ? `  ⚠️ CRITICAL: Sub-offerings are specific services within the main services. Generate keywords for BOTH main services AND sub-offerings to create a comprehensive 30-day plan.` : ""}
- Industry: ${businessContext.market.industry.vertical}
- Market Scope: ${businessContext.market.geographic.scope}
${
  businessContext.businessModel.isLocationDependent
    ? `- Primary Location: ${businessContext.market.geographic.primary}`
    : "- Location: NOT RELEVANT (product-based business)"
}
- Target Customers: ${businessContext.market.customerSegment.primary}
- Business Model: ${businessContext.market.industry.b2bOrB2c}

CORE BUSINESS OFFERINGS:
This business sells: ${coreOfferings.whatBusinessSells}
Primary offerings: ${coreOfferings.primaryOfferings.join(", ")}
Target customers: ${coreOfferings.targetCustomers}

🚨 ABSOLUTE REJECTION RULES:
- ❌ REJECT: Keywords that are ONLY location names (e.g., "toronto", "duffrin", "toronto to duffrin") without service context
- ❌ REJECT: Keywords mentioning competitor names: ${
      coreOfferings.competitorNames.length > 0
        ? coreOfferings.competitorNames.join(", ")
        : "none identified"
    }
- ❌ REJECT: Keywords that don't mention any service/product the business offers
- ❌ REJECT: Generic location terms without service context
- ✅ ACCEPT: Location + service (e.g., "shawarma catering toronto", "mediterranean catering in toronto")
- ✅ ACCEPT: Service-focused keywords (e.g., "office catering", "greek catering")

CRITICAL RULE: Keywords MUST relate to these specific offerings: ${coreOfferings.primaryOfferings.join(
      ", ",
    )}. 
REJECT keywords that are generic area names, competitor names, or don't mention services/products.

📊 KEYWORD STRATEGY:
- Intent Distribution: Informational ${
      businessContext.keywordStrategy.intentDistribution.informational
    }%, Commercial ${
      businessContext.keywordStrategy.intentDistribution.commercial
    }%, Transactional ${
      businessContext.keywordStrategy.intentDistribution.transactional
    }%, Navigational ${
      businessContext.keywordStrategy.intentDistribution.navigational
    }%
- Difficulty Distribution: Easy ${
      businessContext.keywordStrategy.difficultyDistribution.easy.count
    }, Medium ${
      businessContext.keywordStrategy.difficultyDistribution.medium.count
    }, Hard ${businessContext.keywordStrategy.difficultyDistribution.hard.count}
- Must-Have Keywords (CRITICAL): ${
      businessContext.keywordStrategy.mustHaveKeywords.join(", ") || "N/A"
    }
- Focus Areas: ${businessContext.keywordStrategy.focusAreas.join(", ") || "N/A"}

📋 ADDITIONAL BUSINESS CONTEXT:
- Name: ${business.businessName}
- Type: ${business.businessType}
- Description: ${business.businessDescription}
- Location: ${business.businessCity || "N/A"}, ${
      business.businessState || "N/A"
    }
${
  geoCtx?.geoEligible
    ? `
🗺️ GEO-AWARE TARGETING (local/regional business):
- Primary City: ${geoCtx.primaryTarget?.city ?? business.businessCity ?? "N/A"}${geoCtx.primaryTarget?.isResolved ? " (Google Maps verified)" : ""}
- Service-Area Cities: ${geoCtx.serviceAreaTargets.length > 0 ? geoCtx.serviceAreaTargets.map((t) => t.city).join(", ") : "none"}
- Neighborhood: ${geoCtx.neighborhoodTargets.length > 0 ? geoCtx.neighborhoodTargets.map((t) => t.city).join(", ") : "N/A"}
- INSTRUCTION: generate ~35-55% of keywords WITH city/neighborhood names from the lists above (e.g., "${geoCtx.priorityServices[0] ?? "service"} ${geoCtx.primaryTarget?.city ?? business.businessCity ?? ""}", "${geoCtx.priorityServices[0] ?? "service"} ${geoCtx.serviceAreaTargets[0]?.city ?? ""}"). ONLY use cities listed above. Do NOT invent city names.
`
    : ""
}

Previous ${previousKeywords.length} Keywords Used (avoid similar topics):
${previousKeywords
  .slice(0, 10)
  .map((k: any) => `- ${k.keyword}`)
  .join("\n")}

---
🚨 CRITICAL: BLOG POSTS vs SERVICE PAGES 🚨
**DO NOT generate keywords for service pages or landing pages. Generate keywords for BLOG POSTS only.**

Service Page Keywords (DO NOT GENERATE - these belong on your website's main pages):
- ❌ "event venue [location]" (This is your Home Page)
- ❌ "wedding venue [location]" (This is your "Weddings" service page)
- ❌ "corporate event center" (This is your "Corporate Events" service page)
- ❌ "banquet hall [location]" (This is your service page)

Blog Post Keywords (DO GENERATE - these are educational/informational content):
- ✅ "how to choose an event venue"
- ✅ "wedding venue vs banquet hall differences"
- ✅ "corporate event planning checklist"
- ✅ "event venue capacity calculator"
- ✅ "wedding venue decoration ideas"
- ✅ "corporate event catering tips"

**Rule: If the keyword sounds like it belongs on a service/landing page, it's WRONG. Generate keywords that would be blog post topics instead.**

YOUR KEYWORD SELECTION MUST:
1. Be SPECIFIC to what this business sells: ${coreOfferings.whatBusinessSells}
2. Mention at least ONE primary offering: ${coreOfferings.primaryOfferings.join(
      ", ",
    )}
${
  businessSubOfferings !== "N/A"
    ? `3. MUST EXPLORE technologies, frameworks, tools, and related topics: ${businessSubOfferings}
   - Focus on EXPLORING topics rather than just service keywords
   - Generate educational content around technologies (e.g., "React.js best practices", "Next.js vs React", "Full stack development guide")
   - Create keywords that explore these deeper topics, not just service variations`
    : ""
}
4. Generate a BALANCED MIX covering:
   - Main services (${businessContext.services.primary.length} main services)
   ${businessSubOfferings !== "N/A" ? `- Technologies, frameworks, tools, and related topics (${expandedSubOfferings.length} items: ${expandedSubOfferings.slice(0, 10).join(", ")}...)` : ""}
   - Service combinations and variations
   - How-to guides, best practices, and educational content
   - Technology-specific tutorials and guides
   - Framework comparisons and deep dives
${
  businessContext.businessModel.isLocationDependent
    ? `${businessSubOfferings !== "N/A" ? "5" : "3"}. For SERVICE businesses: Location may be relevant (${businessContext.market.geographic.primary}) IF service is mentioned`
    : `${businessSubOfferings !== "N/A" ? "5" : "3"}. 🚨 For PRODUCT businesses: REJECT all location-specific keywords (NO city names, NO "near me", NO location terms)`
}
3. Match intent distribution: ${
      businessContext.keywordStrategy.intentDistribution.informational
    }% informational, ${
      businessContext.keywordStrategy.intentDistribution.commercial
    }% commercial, ${
      businessContext.keywordStrategy.intentDistribution.transactional
    }% transactional, ${
      businessContext.keywordStrategy.intentDistribution.navigational
    }% navigational
4. Prioritize must-have keywords: ${
      businessContext.keywordStrategy.mustHaveKeywords.join(", ") || "N/A"
    }
5. Target focus areas: ${
      businessContext.keywordStrategy.focusAreas.join(", ") || "N/A"
    }
6. Focus on what the business SELLS/OFFERS, not generic or location-based terms
${
  businessContext.businessModel.isLocationDependent
    ? `7. Consider the ${businessContext.market.geographic.scope} market targeting ${businessContext.market.customerSegment.primary}`
    : `7. Focus on product features, reviews, comparisons, buying guides (NO location)`
}

---
CRITICAL KEYWORD FORMATTING RULES:
1.  **DO NOT** generate blog post titles, questions, or long descriptive phrases.
2.  **DO** generate short, searchable noun phrases (2-5 words) that describe a BLOG TOPIC, not a service page.
3.  **DO** generate keywords that are informational, educational, or guide-based (blog content).
4.  **DO NOT** generate keywords that are transactional service searches (those belong on service pages).
5.  "Long-tail" means *more specific*, not *longer*.

**EXAMPLES of GOOD blog post keywords:**
- how to choose event venue
- wedding venue capacity guide
- corporate event planning tips
- event venue decoration ideas
- banquet hall vs event space
- event venue pricing factors
- wedding venue checklist
- corporate event catering guide

**EXAMPLES of BAD keywords (service pages - DO NOT GENERATE):**
- event venue [location] (service page)
- wedding venue [location] (service page)
- corporate event center (service page)
- banquet hall [location] (service page)

${
  businessContext.businessModel.type === "product"
    ? `
🚨 CRITICAL FOR PRODUCT BUSINESSES: NO LOCATION-SPECIFIC KEYWORDS 🚨
- ❌ REJECT: "product in [city]", "product near me", "product in [location]"
- ✅ ACCEPT: "best product", "product review", "product buying guide", "product comparison"
- Products can be shipped anywhere - focus on product features, reviews, comparisons
`
    : ""
}

---
🚨 CRITICAL: KEYWORD UNIQUENESS REQUIREMENTS 🚨
- **EACH keyword must be COMPLETELY DIFFERENT from all others**
- **DO NOT generate similar or synonymous keywords** (e.g., don't generate both "event venue" and "event venue [location]")
- **DO NOT generate variations of the same keyword** (e.g., don't generate "wedding venue" and "wedding receptions" - they target the same search intent)
- **DO NOT generate keywords with the same search intent** (e.g., "wedding venue [location]" and "wedding receptions [location]" - Google treats these as the same topic)
- **Each keyword should cover a DISTINCT topic or question**
- **Avoid keywords that are too similar in meaning** (e.g., don't generate "event venue" and "event space" - they're too similar)
- **If two keywords would target the same search intent or compete for the same ranking, only include ONE**

Examples of TOO SIMILAR / SAME INTENT (pick only one):
- ❌ "event venue [location]" AND "event venue [location]" (direct duplicate)
- ❌ "wedding venue [location]" AND "wedding receptions [location]" (same search intent - users searching for wedding receptions want wedding venues)
- ❌ "banquet hall" AND "banquet hall [location]" (same topic, just location variation)
- ❌ "corporate event center" AND "corporate events [location]" (same search intent)
- ✅ "how to choose event venue" AND "wedding venue capacity guide" AND "corporate event planning tips" (distinct blog topics)

---
TASK:
Generate 30 strategic BLOG POST keywords based on:
1. **BLOG CONTENT ONLY** - Generate keywords for blog posts, NOT service pages
2. RELEVANCE to business (highest priority)
3. Mix of intent types: informational (guides, how-tos, tips), educational content
4. Difficulty progression:
   - Days 1-10: Lower difficulty, specific long-tail blog topics (e.g., "how to choose event venue")
   - Days 11-20: Medium difficulty, core educational content (e.g., "event venue capacity guide")
   - Days 21-30: Higher difficulty, comprehensive guides (e.g., "complete event planning checklist")
5. **EACH keyword must be UNIQUE and DISTINCT from all others - no similar or synonymous terms**
6. **NO THEMATIC DUPLICATES** - If two keywords target the same search intent, only include ONE
7. **NO SERVICE PAGE KEYWORDS** - Only generate blog post topics
8. Avoid topics too similar to previous keywords
9. Create diverse topic coverage across ALL of the business's services AND technologies/frameworks/tools
   ${
     businessSubOfferings !== "N/A"
       ? `   - Ensure keywords cover:
   * Main services (${businessContext.services.primary.length} services)
   * Technologies, frameworks, and tools (${expandedSubOfferings.length} items)
   * Educational and exploratory content around these technologies
   * This creates a comprehensive, practical 30-day plan that explores all aspects of what the business offers`
       : ""
   }

**BEFORE GENERATING EACH KEYWORD, ASK YOURSELF:**
- Is this a blog post topic or a service page? (If service page, skip it)
- Does this keyword have the same search intent as another keyword I'm generating? (If yes, skip it)
- Is this keyword too similar to another keyword? (If yes, skip it)

For each keyword provide your ESTIMATES:
- searchVolume: estimated monthly Google searches (number, e.g. 100-5000)
- difficulty: SEO difficulty 0-100 (number, 0=easy, 100=very hard)

Output ONLY a JSON array with exactly ${keywordsNeeded} keywords:
[
  { "keyword": "keyword 1", "searchVolume": 1200, "difficulty": 35 },
  { "keyword": "keyword 2", "searchVolume": 800, "difficulty": 52 },
  ...${keywordsNeeded} total
]

IMPORTANT: 
- Generate keywords yourself (do not ask for suggestions)
- Output ONLY the JSON array, no explanation
- Generate exactly ${keywordsNeeded} unique, DISTINCT, non-similar keywords
- Do NOT output duplicate keywords - each keyword text must appear only once (no repeated or same keyword, case-insensitive)
- Each keyword must include searchVolume (number) and difficulty (0-100)
- Each keyword must be completely different from all others
- NO service page keywords - only blog post topics
- NO keywords with the same search intent

**🚨 RESTAURANT-SPECIFIC RULES:**
- For restaurants, keywords MUST be specific to their actual menu items, cuisine type, and services
- Keywords should match the dishes, ingredients, and services listed on their menu/website
- DO NOT generate generic restaurant keywords that could apply to any restaurant
- Example: For a Mediterranean restaurant, use "how to make authentic falafel", "mediterranean diet benefits", "best shawarma recipe" - NOT "best pizza recipe", "sushi making guide", or generic "restaurant menu ideas"`;

    const llmResponse = await keywordLLM.invoke([
      {
        role: "system",
        content: `You are an SEO expert. Generate strategic BLOG POST keywords for content planning. CRITICAL RULES: 1) Generate BLOG POST topics only, NOT service page keywords. 2) Each keyword must be completely unique and distinct - no similar, synonymous, or variation keywords. 3) NO keywords with the same search intent. 4) NO service page keywords (e.g., 'event venue [location]' is a service page, not a blog post). 5) For restaurants, keywords MUST be specific to their actual menu items, cuisine type, and services - NOT generic restaurant terms. 6) Output ONLY a JSON array of exactly ${keywordsNeeded} objects, each with "keyword" (string), "searchVolume" (number, estimated monthly searches), and "difficulty" (number 0-100).`,
      },
      { role: "user", content: llmPrompt },
    ]);

    // Parse LLM-generated keywords
    const llmContent =
      typeof llmResponse.content === "string"
        ? llmResponse.content
        : JSON.stringify(llmResponse.content);
    let generatedKeywords = parseLLMSelection(llmContent);

    if (generatedKeywords.length === 0) {
      throw new Error("LLM failed to generate keywords");
    }

    const uniqueGeneratedMap = new Map<string, KeywordWithMetrics>();
    for (const kw of generatedKeywords) {
      const key = kw.keyword.toLowerCase().trim();
      if (!uniqueGeneratedMap.has(key)) {
        uniqueGeneratedMap.set(key, kw);
      }
    }
    generatedKeywords = Array.from(uniqueGeneratedMap.values());
    console.log(
      `✅ LLM generated ${generatedKeywords.length} unique keywords (deduplicated)`,
    );

    // No DataForSEO - use LLM keywords directly (no slicing - let LLM decide)
    let allValidKeywords = generatedKeywords;
    const keywordMetrics = new Map(); // Empty - no metrics needed

    // STEP 2: Build 30-day plan with LLM-generated keywords
    // Use existing keyword data from earlier fetch (already have existingKeywordTexts)
    console.log(
      `📋 Filtering out ${existingKeywordTexts.size} existing keywords from generated list`,
    );

    // 🚀 FIX: Filter out existing keywords from final selection
    let finalKeywords = allValidKeywords.filter(
      (kw) => !existingKeywordTexts.has(kw.keyword.toLowerCase().trim()),
    );

    // 🚀 CRITICAL: Ensure we have the needed number of keywords
    if (finalKeywords.length < keywordsNeeded) {
      const needed = keywordsNeeded - finalKeywords.length;
      console.warn(
        `⚠️ Only ${finalKeywords.length} unique keywords after excluding existing ones. Need ${needed} more. Generating additional keywords...`,
      );

      // Generate additional keywords to reach the needed amount
      const finalSelectedTexts = new Set(
        finalKeywords.map((kw) => kw.keyword.toLowerCase().trim()),
      );

      const additionalPrompt = `You are an SEO strategist. Generate ${needed} additional unique keywords for a 30-day content plan.

Business Context:
- Name: ${business.businessName}
- Type: ${business.businessType}
- Description: ${business.businessDescription}
- Location: ${business.businessCity || "N/A"}, ${
        business.businessState || "N/A"
      }
- Must-Have Keywords: ${
        mustHaveKeywords.length > 0 ? mustHaveKeywords.join(", ") : "N/A"
      }

🚨 CRITICAL: These keywords must be COMPLETELY DIFFERENT from the ones already selected below.

Keywords ALREADY SELECTED (DO NOT duplicate or create similar variations):
${Array.from(finalSelectedTexts)
  .slice(0, 30)
  .map((k) => `- "${k}"`)
  .join("\n")}

Previous ${previousKeywords.length} Keywords Used (avoid similar topics):
${previousKeywords
  .slice(0, 10)
  .map((k: any) => `- ${k.keyword}`)
  .join("\n")}

CRITICAL KEYWORD FORMATTING RULES:
1. **DO NOT** generate blog post titles, questions, or long descriptive phrases.
2. **DO** generate short, searchable noun phrases (2-5 words) that describe a service, technology, or user intent.
3. **EACH keyword must be COMPLETELY DIFFERENT from all already selected keywords above**
4. **DO NOT generate similar or synonymous keywords** to the ones already selected
5. **Each keyword should cover a DISTINCT topic or service**

For each keyword provide ESTIMATES: searchVolume (number, monthly searches), difficulty (number 0-100).
Output ONLY a JSON array with exactly ${needed} keywords:
[
  { "keyword": "keyword 1", "searchVolume": 1200, "difficulty": 35 },
  { "keyword": "keyword 2", "searchVolume": 800, "difficulty": 52 },
  ...${needed} total
]

IMPORTANT: 
- Generate keywords yourself (do not ask for suggestions)
- Output ONLY the JSON array, no explanation
- Generate exactly ${needed} unique, DISTINCT, non-similar keywords
- Do NOT output duplicate keywords - each keyword text must appear only once (no repeated or same keyword)
- Each keyword must include searchVolume and difficulty
- Each keyword must be completely different from all already selected keywords`;

      try {
        const additionalResponse = await keywordLLM.invoke([
          {
            role: "system",
            content:
              "You are an SEO expert. Generate additional unique keywords. No duplicates - each keyword text must appear only once. Each object must have keyword (string), searchVolume (number), difficulty (number 0-100). Output ONLY a JSON array.",
          },
          { role: "user", content: additionalPrompt },
        ]);

        const additionalContent =
          typeof additionalResponse.content === "string"
            ? additionalResponse.content
            : JSON.stringify(additionalResponse.content);
        let additionalKeywords = parseLLMSelection(additionalContent);

        // Deduplicate additional keywords
        const additionalUniqueMap = new Map<string, KeywordWithMetrics>();
        for (const kw of additionalKeywords) {
          const key = kw.keyword.toLowerCase().trim();
          if (
            !additionalUniqueMap.has(key) &&
            !finalSelectedTexts.has(key) &&
            !existingKeywordTexts.has(key)
          ) {
            additionalUniqueMap.set(key, kw);
          }
        }
        additionalKeywords = Array.from(additionalUniqueMap.values());

        // Add to final keywords
        finalKeywords.push(...additionalKeywords.slice(0, needed));
        console.log(
          `✅ Added ${Math.min(
            additionalKeywords.length,
            needed,
          )} additional unique keywords`,
        );

        // If still not enough, generate more (max 2 more attempts)
        let retryCount = 0;
        while (finalKeywords.length < keywordsNeeded && retryCount < 2) {
          const stillNeeded = keywordsNeeded - finalKeywords.length;
          const retrySelectedTexts = new Set(
            finalKeywords.map((kw) => kw.keyword.toLowerCase().trim()),
          );

          const retryPrompt = `Generate ${stillNeeded} more unique keywords. These must be DIFFERENT from:
${Array.from(retrySelectedTexts)
  .slice(-20)
  .map((k) => `- "${k}"`)
  .join("\n")}

For each keyword provide searchVolume (number) and difficulty (0-100). Do NOT output duplicate keywords - each keyword text must appear only once.
Output ONLY a JSON array with exactly ${stillNeeded} keywords: [ { "keyword": "...", "searchVolume": 500, "difficulty": 40 }, ... ]`;

          const retryResponse = await keywordLLM.invoke([
            {
              role: "system",
              content:
                "Generate unique keywords. No duplicates - each keyword text must appear only once. Each object: keyword (string), searchVolume (number), difficulty (number 0-100). Output ONLY a JSON array.",
            },
            { role: "user", content: retryPrompt },
          ]);

          const retryContent =
            typeof retryResponse.content === "string"
              ? retryResponse.content
              : JSON.stringify(retryResponse.content);
          const retryKeywords = parseLLMSelection(retryContent);

          for (const kw of retryKeywords) {
            const key = kw.keyword.toLowerCase().trim();
            if (
              !retrySelectedTexts.has(key) &&
              !existingKeywordTexts.has(key) &&
              finalKeywords.length < 30
            ) {
              finalKeywords.push(kw);
              retrySelectedTexts.add(key);
            }
          }

          retryCount++;
        }
      } catch (error) {
        console.error("Error generating additional keywords:", error);
      }
    }

    // Ensure we have exactly the needed amount (or as many as possible)
    finalKeywords = finalKeywords.slice(0, keywordsNeeded);
    console.log(
      `✅ Final selection: ${finalKeywords.length} unique keywords (target: ${keywordsNeeded})`,
    );

    if (finalKeywords.length < keywordsNeeded) {
      console.warn(
        `⚠️ Could only generate ${finalKeywords.length} unique keywords after deduplication (target: ${keywordsNeeded})`,
      );
    }

    // Use existing dates from earlier fetch (already filtered)

    // Create a Set of taken dates (as YYYY-MM-DD strings)
    const takenDates = new Set<string>(
      existingDates
        .map((dateValue) => normalizePlanDate(dateValue))
        .filter((date): date is string => date !== null),
    );

    console.log(
      `📅 Found ${takenDates.size} existing keyword dates - will skip these when assigning new dates`,
    );

    const latestScheduledDate = getLatestScheduledKeywordDate(existingKeywordsData);
    const latestDate = latestScheduledDate
      ? new Date(`${latestScheduledDate}T00:00:00.000Z`)
      : new Date();
    if (isNaN(latestDate.getTime())) {
      latestDate.setTime(Date.now());
    }

    const startDate = new Date(latestDate);
    startDate.setDate(startDate.getDate() + 1);

    const planKeywordMap = new Map<string, KeywordWithMetrics>();
    for (const kw of finalKeywords) {
      const key = kw.keyword.toLowerCase().trim();
      if (!planKeywordMap.has(key)) {
        planKeywordMap.set(key, kw);
      }
    }
    let deduplicatedFinalKeywords = Array.from(planKeywordMap.values());
    console.log(
      `🔍 Final deduplication: ${finalKeywords.length} → ${deduplicatedFinalKeywords.length} unique keywords`,
    );

    // Use whatever LLM generated (no slicing or truncation)
    const keywordsToUse = deduplicatedFinalKeywords;

    console.log(
      `✅ Using ${keywordsToUse.length} keywords selected by LLM (no truncation)`,
    );

    const allowedDaysOfWeek =
      Array.isArray(business.publishDaysOfWeek) &&
      business.publishDaysOfWeek.length > 0
        ? new Set(business.publishDaysOfWeek)
        : new Set([0, 1, 2, 3, 4, 5, 6]);

    let dateOffset = 0;
    const keywordPlan = keywordsToUse
      .map((kw: any, index) => {
        if (!kw || !kw.keyword) {
          return null;
        }
        const metrics = keywordMetrics.get(kw.keyword) || null;

        let publishDate: Date;
        let dateString: string | undefined;
        do {
          publishDate = new Date(startDate);
          publishDate.setDate(publishDate.getDate() + dateOffset);
          if (!allowedDaysOfWeek.has(publishDate.getDay())) {
            dateOffset++;
            if (dateOffset > 365) break;
            continue;
          }
          const isoString = publishDate.toISOString();
          dateString = isoString.split("T")[0];
          dateOffset++;

          if (dateOffset > 365) {
            console.warn(
              `⚠️ Could not find available date after 365 days - using date ${dateString}`,
            );
            break;
          }
        } while (dateString && takenDates.has(dateString));

        if (!dateString) {
          console.error("❌ Failed to generate date string");
          return null;
        }

        takenDates.add(dateString);

        const searchVolume =
          typeof kw.searchVolume === "number" && kw.searchVolume >= 0
            ? kw.searchVolume
            : 0;
        const competition =
          typeof kw.competition === "number" && kw.competition >= 0
            ? kw.competition
            : null;
        let difficulty = 50;
        if (
          typeof kw.difficulty === "number" &&
          kw.difficulty >= 0 &&
          kw.difficulty <= 100
        ) {
          difficulty = Math.round(kw.difficulty);
        } else {
          if (dateOffset <= 10) {
            difficulty = 30 + Math.floor(Math.random() * 10);
          } else if (dateOffset <= 20) {
            difficulty = 50 + Math.floor(Math.random() * 15);
          } else {
            difficulty = 65 + Math.floor(Math.random() * 15);
          }
        }

        return {
          keyword: kw.keyword,
          publishDate: dateString,
          publishTime: "08:00",
          keywordDiffculty: difficulty.toString(),
          keywordSearchVolume: searchVolume.toString(),
          keywordCategory: categorizeKeyword(kw.keyword),
          keywordIntent: determineIntent(kw.keyword),
          userId,
          businessId,
          keywordCpc: null,
          keywordCompetition: competition,
          keywordMonthlySearches: searchVolume > 0 ? searchVolume : null,
          keywordClicks: null,
          keywordImpressions: null,
          keywordCTR: null,
          keywordTrend: null,
          keywordLowTopOfPageBid: null,
          keywordHighTopOfPageBid: null,
          keywordDataUpdatedAt: null,
        };
      })
      .filter(Boolean);

    // Use whatever keywords were assigned dates (no truncation or filling)
    if (keywordPlan.length === 0) {
      throw new Error(
        "No keywords were assigned dates - all keywords may have been filtered out",
      );
    }

    console.log(
      `✅ Generated ${keywordPlan.length} keywords for 30-day plan using LLM-only approach (LLM selected, no truncation)`,
    );

    // 🔍 VERIFICATION STEP: Verify all keywords with verification agent
    console.log("🔍 Starting keyword verification with verification agent...");
    const keywordTexts = keywordPlan.map((kp: any) => kp.keyword);
    const verificationResults = await verifyKeywords(
      keywordTexts,
      business,
      businessContext,
      coreOfferings,
    );

    const invalidKeywords: Array<{ keyword: string; index: number }> = [];
    verificationResults.forEach((result, index) => {
      if (!result.isValid || result.relevanceScore < 0.6) {
        invalidKeywords.push({ keyword: result.keyword, index });
        console.log(
          `❌ Invalid keyword at index ${index}: "${result.keyword}" - ${
            result.reason
          } (relevance: ${result.relevanceScore.toFixed(2)})`,
        );
      }
    });

    if (invalidKeywords.length > 0) {
      console.log(
        `🔄 Regenerating ${invalidKeywords.length} invalid keywords...`,
      );

      const validKeywordSet = new Set(
        verificationResults
          .filter((r) => r.isValid && r.relevanceScore >= 0.6)
          .map((r) => r.keyword.toLowerCase().trim()),
      );

      const currentPlanKeywordsSet = new Set(
        keywordPlan.map((kp: any) => (kp.keyword ?? "").toLowerCase().trim()),
      );

      for (const invalid of invalidKeywords) {
        const replacementPrompt = `Generate a single keyword replacement for a business.

Business: ${business.businessName} (${business.businessType})
Services/Products: ${businessContext.services.primary.join(", ")}
Industry: ${businessContext.market.industry.vertical}
${
  businessContext.businessModel.isLocationDependent
    ? `Location: ${businessContext.market.geographic.primary}`
    : "Location: NOT RELEVANT (product business)"
}

Invalid keyword to replace: "${invalid.keyword}"

Generate ONE keyword that:
- Is relevant to services/products: ${businessContext.services.primary.join(
          ", ",
        )}
- Is specific to what this business sells/offers
${
  businessContext.businessModel.isLocationDependent
    ? `- May include location if relevant`
    : `- Does NOT include location terms`
}
- Is different from these already selected: ${Array.from(validKeywordSet)
          .slice(0, 10)
          .join(", ")}

Output ONLY the keyword text, no JSON, no explanation.`;

        try {
          const replacementResponse = await keywordLLM.invoke([
            {
              role: "system",
              content:
                "Generate a single business-relevant keyword. Output ONLY the keyword text.",
            },
            { role: "user", content: replacementPrompt },
          ]);

          const replacementText =
            typeof replacementResponse.content === "string"
              ? replacementResponse.content.trim().replace(/^["']|["']$/g, "")
              : String(replacementResponse.content).trim();

          if (replacementText && replacementText.length > 0) {
            const replacementKey = replacementText.toLowerCase().trim();
            if (currentPlanKeywordsSet.has(replacementKey)) {
              console.warn(
                `⚠️ Replacement "${replacementText}" is already in the plan (duplicate), skipping`,
              );
            } else {
              const replacementVerification = await verifyKeyword(
                replacementText,
                business,
                businessContext,
                coreOfferings,
              );

              if (
                replacementVerification.isValid &&
                replacementVerification.relevanceScore >= 0.6
              ) {
                const planItem = keywordPlan[invalid.index];
                if (planItem) {
                  planItem.keyword = replacementText;
                  validKeywordSet.add(replacementKey);
                  currentPlanKeywordsSet.add(replacementKey);
                  console.log(
                    `✅ Replaced "${
                      invalid.keyword
                    }" with "${replacementText}" (relevance: ${replacementVerification.relevanceScore.toFixed(
                      2,
                    )})`,
                  );
                }
              } else {
                console.warn(
                  `⚠️ Replacement "${replacementText}" also failed verification, keeping original`,
                );
              }
            }
          }
        } catch (error: any) {
          console.error(
            `❌ Failed to regenerate keyword "${invalid.keyword}": ${error.message}`,
          );
        }
      }
    } else {
      console.log("✅ All keywords passed verification!");
    }

    const nonNullKeywordPlan = keywordPlan.filter(
      (kp): kp is NonNullable<(typeof keywordPlan)[number]> => kp != null,
    );
    const seenKeys = new Set<string>();
    const dedupedKeywordPlan = nonNullKeywordPlan.filter((kp: any) => {
      const key = (kp.keyword ?? "").toLowerCase().trim();
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    if (dedupedKeywordPlan.length < nonNullKeywordPlan.length) {
      console.warn(
        `⚠️ Removed ${nonNullKeywordPlan.length - dedupedKeywordPlan.length} duplicate keywords before save`,
      );
    }
    const keywordPlanToSave = dedupedKeywordPlan;

    // Assign keywords to content clusters
    const { assignKeywordClusters } = await import("../../utils/keyword-cluster.utils");
    const clusterMap = await assignKeywordClusters(
      keywordPlanToSave.map((k: any) => ({ keyword: k.keyword, keywordCategory: k.keywordCategory, keywordIntent: k.keywordIntent })),
      businessId,
      userId,
    );

    // Merge cluster assignments into keyword plan
    for (const item of keywordPlanToSave) {
      const assignment = clusterMap.get((item as any).keyword.toLowerCase());
      if (assignment) {
        (item as any).clusterId = assignment.clusterId;
        (item as any).clusterRole = assignment.clusterRole;
      }
    }

    // GEO-FIX-6: tag keywords that mention known service-area cities with
    // GEO metadata. This ensures the allocation step uses per-keyword GEO
    // scope even for the LLM-first fallback path.
    const geoTargetsByCity = new Map<string, { city: string; locationCode: number; type: string; isResolved: boolean }>();
    if (geoCtx?.geoEligible) {
      for (const target of geoCtx.allTargets) {
        geoTargetsByCity.set(target.city.toLowerCase(), {
          city: target.city,
          locationCode: target.locationCode,
          type: target.type,
          isResolved: target.isResolved,
        });
      }
    }
    function matchGeoTarget(keyword: string) {
      const lower = keyword.toLowerCase();
      for (const [cityLower, target] of geoTargetsByCity) {
        if (lower.includes(cityLower)) return target;
      }
      return null;
    }

    console.log(`💾 Saving ${keywordPlanToSave.length} keywords directly to database (${clusterMap.size} cluster-assigned)`);

    const saveResult = await savePlanKeywords(
      keywordPlanToSave.map((kp) => {
        const geo = matchGeoTarget(kp.keyword);
        return {
        keyword: kp.keyword,
        publishDate: kp.publishDate,
        publishTime: kp.publishTime,
        keywordDiffculty: kp.keywordDiffculty,
        keywordSearchVolume: kp.keywordSearchVolume,
        userId: kp.userId,
        businessId: kp.businessId,
        keywordCategory: kp.keywordCategory || null,
        keywordIntent: kp.keywordIntent || null,
        keywordCpc: kp.keywordCpc ?? null,
        keywordCompetition: kp.keywordCompetition ?? null,
        keywordTrend: kp.keywordTrend ?? Prisma.JsonNull,
        keywordMonthlySearches: kp.keywordMonthlySearches ?? null,
        keywordClicks: kp.keywordClicks ?? null,
        keywordImpressions: kp.keywordImpressions ?? null,
        keywordCTR: kp.keywordCTR ?? null,
        keywordLowTopOfPageBid: kp.keywordLowTopOfPageBid ?? null,
        keywordHighTopOfPageBid: kp.keywordHighTopOfPageBid ?? null,
        keywordDataUpdatedAt: kp.keywordDataUpdatedAt ?? null,
        clusterId: (kp as any).clusterId ?? undefined,
        clusterRole: (kp as any).clusterRole ?? undefined,
        // GEO-FIX-6: persist geo target for allocation
        ...(geo ? {
          selectionMetadata: {
            geo: {
              targetCity: geo.city,
              targetLocationCode: geo.locationCode,
              geoSource: geo.type,
              isResolved: geo.isResolved,
            },
          },
        } : {}),
      };
      }),
    );

    const savedCount = saveResult.count;
    const skippedCount = saveResult.skipped;

    console.log(`✅ Keywords saved: ${savedCount} saved, ${skippedCount} skipped`);

    if (skippedCount > 0) {
      saveResult.skippedDetails.forEach((s) => {
        console.warn(`   ⚠️ Skipped "${s.keyword}" on ${s.date}: ${s.reason}`);
      });
    }

    if (savedCount === 0) {
      console.error(
        `❌ CRITICAL: No keywords were saved to database! Skipped: ${skippedCount}, Total attempted: ${keywordPlanToSave.length}`,
      );
      throw new Error(
        `No keywords were saved. ${skippedCount} were skipped due to duplicate dates. Please check date assignment logic.`,
      );
    }

    return {
      success: true,
      count: savedCount,
      skipped: skippedCount,
      method: "llm-first-then-dataforseo",
      message: `Saved ${savedCount} keywords successfully`,
      keywords: keywordPlanToSave,
    };
  } catch (error: any) {
    console.error("❌ Keyword generation failed:", error.message);
    // Last resort: fallback to original LLM method (without DataForSEO)
    const business = JSON.parse(businessInfo);
    const previousKeywords = JSON.parse(keywords);
    return await fallbackToLLMGeneration(
      business,
      previousKeywords,
      userId,
      businessId,
      error.message,
    );
  }
}

/**
 * Fallback: Original LLM-only generation (when DataForSEO fails)
 */
async function fallbackToLLMGeneration(
  business: { id: string; businessName?: string; businessType?: string },
  previousKeywords: { keyword?: string }[],
  userId: string,
  businessId: string,
  fallbackReason?: string,
) {
  console.log(
    "⚠️ Using LLM-only fallback (not recommended - data will be estimates)",
  );

  async function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
    return shouldContinueWithGuards(messages as AIMessage[], {
      workflowName: "new-keyword-fallback-generation",
      maxToolRounds: getGraphMaxToolRounds(),
      duplicateToolCallLimit: 2,
      successMarkers: ["Saved", "keywords successfully"],
      failureMarkers: ["Tool execution failed", "Error:"],
    });
  }

  async function callModel(state: typeof MessagesAnnotation.State) {
    const response = await keywordLLM.invoke([
      {
        role: "system",
        content: `You are an expert SEO Strategist. Generate 30 keyword ideas for a 30-day content plan.

IMPORTANT: Your keyword difficulty and search volume will be ESTIMATES only. Real data from DataForSEO API is not available.

Generate keywords based on:
- Business: ${business.businessName ?? ""} (${business.businessType ?? ""})
- Previous topics covered: ${previousKeywords
          .slice(0, 10)
          .map((k) => k.keyword ?? "")
          .join(", ")}

Output format (include businessId and userId in every item):
{
  "data": [
    {
      "keyword": "your keyword suggestion",
      "publishDate": "YYYY-MM-DD",
      "publishTime": "08:00",
      "keywordDiffculty": "estimated 0-100",
      "keywordSearchVolume": "estimated monthly searches",
      "keywordCategory": "informational|commercial|local|transactional",
      "keywordIntent": "informational|navigational|commercial|transactional",
      "userId": "${userId}",
      "businessId": "${businessId}"
    }
  ]
}`,
      },
      ...state.messages,
    ]);

    return { messages: [response] };
  }

  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("llm", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "llm")
    .addEdge("tools", "llm")
    .addConditionalEdges("llm", shouldContinue);

  const app = workflow.compile();

  const response = await app.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Generate 30-day keyword plan. Business: ${JSON.stringify(
            business,
          )}, Previous: ${JSON.stringify(previousKeywords)}`,
        },
      ],
    },
    {
      recursionLimit: getGraphRecursionLimit(),
    },
  );

  // 🔧 FIX: Parse the tool response to extract saved count
  const lastMessage = response.messages[response.messages.length - 1];
  let savedCount = 0;
  let skippedCount = 0;

  // Try to extract count from tool calls in the response
  const toolCalls = lastMessage && "tool_calls" in lastMessage && Array.isArray(lastMessage.tool_calls)
    ? lastMessage.tool_calls
    : [];
  for (const toolCall of toolCalls) {
      if (toolCall.name === "saveKeywordsToDb") {
        const toolResultIndex = response.messages.findIndex(
          (msg) =>
            (msg as { role?: string; tool_call_id?: string }).role === "tool" &&
            (msg as { role?: string; tool_call_id?: string }).tool_call_id === toolCall.id,
        );
        if (toolResultIndex !== -1) {
          const toolResult = response.messages[toolResultIndex] as {
            role?: string;
            content?: string | unknown;
          };
          const rawContent = toolResult?.content;
          const contentStr =
            typeof rawContent === "string"
              ? rawContent
              : Array.isArray(rawContent)
                ? ""
                : rawContent != null
                  ? String(rawContent)
                  : "";
          try {
            const result = JSON.parse(contentStr) as {
              data?: { count?: number; skipped?: number };
            };
            savedCount = result?.data?.count ?? 0;
            skippedCount = result?.data?.skipped ?? 0;
          } catch {
            const countMatch = contentStr.match(/Saved (\d+) keywords/);
            const skippedMatch = contentStr.match(/(\d+) keywords were skipped/);
            if (countMatch) savedCount = parseInt(countMatch[1] ?? "0", 10) || 0;
            if (skippedMatch) skippedCount = parseInt(skippedMatch[1] ?? "0", 10) || 0;
          }
        }
      }
  }

  console.log(
    `✅ Fallback completed: ${savedCount} saved, ${skippedCount} skipped`,
  );

  return {
    success: true,
    count: savedCount,
    skipped: skippedCount,
    method: "llm-fallback",
    message: `Used LLM fallback. Saved ${savedCount} keywords, skipped ${skippedCount}`,
    response: lastMessage?.content,
    fallbackReason: fallbackReason ?? null,
  };
}
