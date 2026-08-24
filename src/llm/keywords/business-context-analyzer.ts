import { getLLMForKeywords } from "../../config/llm.config";
import { resolveEffectiveServices } from "../../utils/effective-services.utils";

export interface BusinessContextAnalysis {
  businessModel: {
    type: "service" | "product" | "mixed";
    isLocationDependent: boolean;
  };
  services: {
    primary: string[];
    secondary: string[];
    industry: string;
  };
  market: {
    geographic: {
      primary: string;
      secondary?: string[];
      scope: "local" | "regional" | "national" | "international";
    };
    industry: {
      vertical: string;
      subVertical?: string[];
      b2bOrB2c: "B2B" | "B2C" | "B2B2C" | "mixed";
    };
    customerSegment: {
      primary: string;
      characteristics: string[];
    };
  };
  keywordStrategy: {
    intentDistribution: {
      informational: number;
      commercial: number;
      transactional: number;
      navigational: number;
    };
    difficultyDistribution: {
      easy: { min: number; max: number; count: number };
      medium: { min: number; max: number; count: number };
      hard: { min: number; max: number; count: number };
    };
    mustHaveKeywords: string[];
    focusAreas: string[];
  };
  coreOfferings: {
    primary: string[];
    secondary: string[];
    explicitDescription: string;
    whatBusinessSells: string;
  };
  competitorNames: string[];
}

const contextLLM = getLLMForKeywords();

export async function analyzeBusinessContext(
  business: any,
): Promise<BusinessContextAnalysis> {
  const coreServices = resolveEffectiveServices(business);

  const primaryServices = coreServices?.topLevel || [];
  const secondaryServices = coreServices?.subOfferings || [];
  const industryFocus = coreServices?.industryFocus || [];
  const serviceArea = business.serviceArea || "national";
  const targetAudience = business.targetAudience || "";
  const businessType = business.businessType || "";
  const businessDescription = business.businessDescription || "";
  const businessCity = business.businessCity || "";
  const businessState = business.businessState || "";
  const businessCountry = business.businessCountry || "";
  const mustHaveKeywords =
    business.keywords
      ?.filter((k: any) => k.keywordType === "MUST_HAVE")
      .map((k: any) => k.keyword) || [];

  const prompt = `You are an expert business analyst and SEO strategist. Analyze this business and create a comprehensive context analysis for keyword strategy.

BUSINESS DATA:
- Name: ${business.businessName || "N/A"}
- Type: ${businessType}
- Description: ${businessDescription}
- Primary Services: ${primaryServices.join(", ") || "N/A"}
- Secondary Services/Offerings: ${secondaryServices.join(", ") || "N/A"}
- Industry Focus: ${industryFocus.join(", ") || "N/A"}
- Location: ${businessCity || "N/A"}, ${businessState || "N/A"}, ${
    businessCountry || "N/A"
  }
- Service Area: ${serviceArea}
- Target Audience: ${targetAudience || "N/A"}
- Must-Have Keywords: ${mustHaveKeywords.join(", ") || "N/A"}

YOUR TASK:
Analyze this business comprehensively and create a strategic keyword plan. Consider:

1. BUSINESS MODEL ANALYSIS:
   - Is this a SERVICE-based business (e.g., consulting, local services, professional services) or PRODUCT-based business (e.g., e-commerce, software, physical products)?
   - For SERVICE businesses: Location may be relevant (e.g., "plumber in Toronto")
   - For PRODUCT businesses: Location should NOT be included in keywords (e.g., "best running shoes" NOT "best running shoes in Toronto")
   - Determine: type = "service" | "product" | "mixed"
   - Determine: isLocationDependent = true for services that require physical presence, false for products that can be shipped

2. SERVICES/PRODUCTS ANALYSIS:
   - What are the PRIMARY services/products this business sells? (extract from primaryServices)
   - What are SECONDARY offerings? (extract from secondaryServices)
   - What INDUSTRY does this business operate in? (infer from industryFocus, businessType, services)
   - CRITICAL: Keywords MUST be specific to these services/products - NOT generic or location-focused

3. MARKET ANALYSIS:
   - GEOGRAPHIC MARKET:
     * Primary location: ${
       businessCity || businessState || businessCountry || "Global"
     }
     * Secondary locations: Any other markets they serve?
     * Scope: Based on serviceArea ("${serviceArea}") - determine if local, regional, national, or international
   
   - INDUSTRY MARKET:
     * What vertical/industry? (e.g., SaaS, E-commerce, Local Services, Professional Services, Healthcare, etc.)
     * Sub-verticals if applicable
     * B2B or B2C? (infer from businessType, services, targetAudience)
   
   - CUSTOMER SEGMENT:
     * Who is the primary customer? (extract from targetAudience, infer from services)
     * What are their characteristics? (e.g., small businesses, enterprises, consumers, specific demographics)

3. KEYWORD STRATEGY:
   - INTENT DISTRIBUTION (must total 100%):
     * Informational: % (educational content, how-to, guides)
     * Commercial: % (best, top, reviews, comparisons)
     * Transactional: % (buy, price, order, hire)
     * Navigational: % (branded, location-specific)
     * Consider: B2B typically needs more informational, B2C needs more commercial/transactional
   
   - DIFFICULTY DISTRIBUTION (must total 30 keywords):
     * Easy (< 45 difficulty): Count (quick wins, long-tail)
     * Medium (45-70 difficulty): Count (competitive positioning)
     * Hard (70-85 difficulty): Count (authority building)
     * Typical distribution: 10 easy, 12 medium, 8 hard
   
   - MUST-HAVE KEYWORDS:
     * Critical keywords the business MUST rank for (from mustHaveKeywords list)
     * These are non-negotiable and should be included
   
   - FOCUS AREAS:
     * Topic clusters to target (e.g., "web design basics", "SEO strategies", "running shoe reviews")
     * Should align with primary services/products and customer needs
     * For PRODUCT businesses: Focus on product features, comparisons, reviews, buying guides
     * For SERVICE businesses: Focus on service benefits, how-to guides, industry insights
     * NEVER include generic location-based topics unless it's a location-dependent service

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this structure:
{
  "businessModel": {
    "type": "service" | "product" | "mixed",
    "isLocationDependent": true | false
  },
  "services": {
    "primary": ["service1", "service2", ...],
    "secondary": ["offering1", "offering2", ...],
    "industry": "industry name"
  },
  "market": {
    "geographic": {
      "primary": "primary location",
      "secondary": ["location2", "location3"] or null,
      "scope": "local" | "regional" | "national" | "international"
    },
    "industry": {
      "vertical": "main industry",
      "subVertical": ["sub1", "sub2"] or null,
      "b2bOrB2c": "B2B" | "B2C" | "B2B2C" | "mixed"
    },
    "customerSegment": {
      "primary": "primary customer type",
      "characteristics": ["char1", "char2", ...]
    }
  },
  "keywordStrategy": {
    "intentDistribution": {
      "informational": 60,
      "commercial": 25,
      "transactional": 10,
      "navigational": 5
    },
    "difficultyDistribution": {
      "easy": { "min": 0, "max": 45, "count": 10 },
      "medium": { "min": 45, "max": 70, "count": 12 },
      "hard": { "min": 70, "max": 85, "count": 8 }
    },
    "mustHaveKeywords": ["keyword1", "keyword2", ...],
    "focusAreas": ["topic cluster 1", "topic cluster 2", ...]
  }
}

CRITICAL RULES:
- Return ONLY valid JSON, no markdown, no code blocks, no explanations
- Intent distribution percentages must total 100
- Difficulty distribution counts must total 30
- Must-have keywords should come from the provided list
- Focus areas should be specific topic clusters related to services/products, NOT generic terms
- For PRODUCT businesses: isLocationDependent MUST be false (products can be shipped anywhere)
- For SERVICE businesses: isLocationDependent depends on whether service requires physical presence
- Keywords MUST be business-specific (related to what they sell/offer), NOT location-focused unless it's a location-dependent service
- Be strategic: consider what keywords will generate meaningful traffic for THIS specific business`;

  try {
    const response = await contextLLM.invoke([
      {
        role: "system",
        content:
          "You are an expert business analyst and SEO strategist. Analyze businesses and create strategic keyword plans. Return ONLY valid JSON, no markdown or explanations.",
      },
      { role: "user", content: prompt },
    ]);

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM did not return valid JSON");
    }

    const analysis = JSON.parse(jsonMatch[0]) as BusinessContextAnalysis;

    if (!analysis.services || !analysis.market || !analysis.keywordStrategy) {
      throw new Error("LLM response missing required fields");
    }

    console.log("✅ Business context analysis completed");
    console.log(
      `   Business Model: ${analysis.businessModel.type} (Location Dependent: ${analysis.businessModel.isLocationDependent})`,
    );
    console.log(
      `   Services/Products: ${analysis.services.primary.join(", ")}`,
    );
    console.log(
      `   Industry: ${analysis.market.industry.vertical} (${analysis.market.industry.b2bOrB2c})`,
    );
    console.log(`   Market Scope: ${analysis.market.geographic.scope}`);
    console.log(
      `   Target Customers: ${analysis.market.customerSegment.primary}`,
    );

    return analysis;
  } catch (error: any) {
    console.error("❌ Business context analysis failed:", error);

    const isProductBusiness =
      businessType.toLowerCase().includes("product") ||
      businessType.toLowerCase().includes("ecommerce") ||
      businessType.toLowerCase().includes("e-commerce") ||
      primaryServices.some((s: string) => s.toLowerCase().includes("product"));
    const isLocationDependent =
      !isProductBusiness &&
      (serviceArea === "local" || serviceArea === "regional");

    const fallbackAnalysis: BusinessContextAnalysis = {
      businessModel: {
        type: isProductBusiness ? "product" : "service",
        isLocationDependent: isLocationDependent,
      },
      services: {
        primary: primaryServices.slice(0, 5),
        secondary: secondaryServices.slice(0, 5),
        industry: industryFocus[0] || businessType || "General",
      },
      market: {
        geographic: {
          primary: businessCity || businessState || businessCountry || "Global",
          scope:
            (serviceArea as
              | "local"
              | "regional"
              | "national"
              | "international") || "national",
        },
        industry: {
          vertical: industryFocus[0] || businessType || "General",
          b2bOrB2c: businessType.toLowerCase().includes("b2b")
            ? "B2B"
            : businessType.toLowerCase().includes("b2c")
              ? "B2C"
              : "mixed",
        },
        customerSegment: {
          primary: targetAudience || "General consumers",
          characteristics: [],
        },
      },
      keywordStrategy: {
        intentDistribution: {
          informational: 60,
          commercial: 25,
          transactional: 10,
          navigational: 5,
        },
        difficultyDistribution: {
          easy: { min: 0, max: 45, count: 10 },
          medium: { min: 45, max: 70, count: 12 },
          hard: { min: 70, max: 85, count: 8 },
        },
        mustHaveKeywords: mustHaveKeywords.slice(0, 10),
        focusAreas: primaryServices.slice(0, 5),
      },
      coreOfferings: {
        primary: primaryServices.slice(0, 5),
        secondary: secondaryServices.slice(0, 5),
        explicitDescription: `${
          business.businessName || "Business"
        } offers ${primaryServices.slice(0, 3).join(", ")}`,
        whatBusinessSells:
          primaryServices.slice(0, 3).join(", ") || businessType || "services",
      },
      competitorNames: [],
    };

    console.log("⚠️ Using fallback business context analysis");
    return fallbackAnalysis;
  }
}
