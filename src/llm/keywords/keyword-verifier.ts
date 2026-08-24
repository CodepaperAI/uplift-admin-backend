import { getLLMForKeywords } from "../../config/llm.config";
import type { BusinessDomain } from "../../services/domain-classifier.service";
import type { BusinessContextAnalysis } from "./business-context-analyzer";
import type { CoreOfferings } from "./core-offerings-extractor";

const verifierLLM = getLLMForKeywords();

const KEYWORD_VERIFICATION_TIMEOUT_DEFAULT_MS = 90_000;

function keywordVerificationTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KEYWORD_VERIFICATION_TIMEOUT_MS ??
      String(KEYWORD_VERIFICATION_TIMEOUT_DEFAULT_MS),
    10,
  );

  return Number.isFinite(configured)
    ? Math.min(180_000, Math.max(15_000, configured))
    : KEYWORD_VERIFICATION_TIMEOUT_DEFAULT_MS;
}

export interface KeywordVerificationResult {
  keyword: string;
  isValid: boolean;
  reason: string;
  relevanceScore: number;
}

export interface DomainValidationRules {
  requiredTerms: string[];
  prohibitedTerms: string[];
  locationRelevance: "high" | "medium" | "low";
}

const DOMAIN_VALIDATION_RULES: Record<BusinessDomain, DomainValidationRules> = {
  restaurant: {
    requiredTerms: [
      "food",
      "restaurant",
      "dining",
      "menu",
      "cuisine",
      "catering",
      "delivery",
      "takeout",
      "meal",
      "dish",
      "eat",
      "lunch",
      "dinner",
      "breakfast",
      "brunch",
    ],
    prohibitedTerms: ["restaurant software", "pos system", "food delivery app"],
    locationRelevance: "high",
  },
  "law-firm": {
    requiredTerms: [
      "lawyer",
      "attorney",
      "legal",
      "law",
      "court",
      "case",
      "lawsuit",
      "litigation",
      "claim",
      "settlement",
      "defense",
    ],
    prohibitedTerms: [
      "legal software",
      "law firm management",
      "case management software",
    ],
    locationRelevance: "high",
  },
  "dental-medical": {
    requiredTerms: [
      "dental",
      "dentist",
      "teeth",
      "oral",
      "medical",
      "doctor",
      "health",
      "treatment",
      "procedure",
      "patient",
      "clinic",
    ],
    prohibitedTerms: [
      "medical software",
      "emr system",
      "practice management software",
    ],
    locationRelevance: "high",
  },
  "real-estate": {
    requiredTerms: [
      "real estate",
      "property",
      "home",
      "house",
      "apartment",
      "condo",
      "buy",
      "sell",
      "rent",
      "lease",
      "realtor",
    ],
    prohibitedTerms: [
      "real estate software",
      "crm for realtors",
      "mls software",
    ],
    locationRelevance: "high",
  },
  "tech-devops": {
    requiredTerms: [
      "software",
      "development",
      "devops",
      "cloud",
      "aws",
      "api",
      "code",
      "programming",
      "automation",
      "deploy",
    ],
    prohibitedTerms: [],
    locationRelevance: "low",
  },
  "event-venue": {
    requiredTerms: [
      "venue",
      "hall",
      "event",
      "wedding",
      "party",
      "banquet",
      "reception",
      "conference",
      "meeting",
      "celebration",
    ],
    prohibitedTerms: [
      "event software",
      "venue management system",
      "booking platform",
    ],
    locationRelevance: "high",
  },
  "fitness-gym": {
    requiredTerms: [
      "gym",
      "fitness",
      "workout",
      "exercise",
      "training",
      "muscle",
      "strength",
      "cardio",
      "weight",
      "class",
    ],
    prohibitedTerms: [
      "gym software",
      "fitness app development",
      "gym management system",
    ],
    locationRelevance: "high",
  },
  "salon-spa": {
    requiredTerms: [
      "salon",
      "spa",
      "hair",
      "nail",
      "beauty",
      "massage",
      "facial",
      "skin",
      "treatment",
      "styling",
    ],
    prohibitedTerms: [
      "salon software",
      "spa management system",
      "booking platform",
    ],
    locationRelevance: "high",
  },
  "auto-repair": {
    requiredTerms: [
      "auto",
      "car",
      "vehicle",
      "repair",
      "mechanic",
      "service",
      "maintenance",
      "oil",
      "brake",
      "tire",
      "engine",
    ],
    prohibitedTerms: ["auto parts store", "car dealership", "auto software"],
    locationRelevance: "high",
  },
  accounting: {
    requiredTerms: [
      "accounting",
      "accountant",
      "tax",
      "bookkeeping",
      "cpa",
      "financial",
      "audit",
      "payroll",
      "budget",
    ],
    prohibitedTerms: [
      "accounting software",
      "quickbooks alternative",
      "bookkeeping app",
    ],
    locationRelevance: "high",
  },
  photography: {
    requiredTerms: [
      "photography",
      "photographer",
      "photo",
      "portrait",
      "wedding",
      "event",
      "session",
      "shoot",
      "video",
    ],
    prohibitedTerms: [
      "camera store",
      "photography equipment",
      "photo editing software",
    ],
    locationRelevance: "high",
  },
  "plumbing-hvac": {
    requiredTerms: [
      "plumbing",
      "plumber",
      "hvac",
      "heating",
      "cooling",
      "air conditioning",
      "ac",
      "furnace",
      "drain",
      "pipe",
    ],
    prohibitedTerms: [
      "plumbing supply store",
      "hvac parts wholesale",
      "plumbing software",
    ],
    locationRelevance: "high",
  },
  "ecommerce-retail": {
    requiredTerms: [
      "buy",
      "shop",
      "product",
      "store",
      "price",
      "sale",
      "deal",
      "discount",
      "order",
      "shipping",
    ],
    prohibitedTerms: [
      "ecommerce platform",
      "shopify app",
      "woocommerce plugin",
    ],
    locationRelevance: "low",
  },
  "education-training": {
    requiredTerms: [
      "course",
      "class",
      "training",
      "learn",
      "education",
      "certification",
      "program",
      "tutor",
      "school",
    ],
    prohibitedTerms: [
      "lms software",
      "education platform",
      "learning management system",
    ],
    locationRelevance: "medium",
  },
  "travel-hospitality": {
    requiredTerms: [
      "travel",
      "trip",
      "vacation",
      "hotel",
      "flight",
      "tour",
      "destination",
      "booking",
      "resort",
    ],
    prohibitedTerms: [
      "travel software",
      "booking platform",
      "hotel management system",
    ],
    locationRelevance: "high",
  },
  construction: {
    requiredTerms: [
      "construction",
      "contractor",
      "builder",
      "renovation",
      "remodel",
      "repair",
      "build",
      "install",
      "roofing",
    ],
    prohibitedTerms: [
      "construction software",
      "project management tool",
      "contractor crm",
    ],
    locationRelevance: "high",
  },
  "marketing-agency": {
    requiredTerms: [
      "marketing",
      "advertising",
      "seo",
      "ppc",
      "social media",
      "content",
      "branding",
      "campaign",
      "lead",
    ],
    prohibitedTerms: [
      "marketing software",
      "crm platform",
      "email marketing tool",
    ],
    locationRelevance: "medium",
  },
  insurance: {
    requiredTerms: [
      "insurance",
      "coverage",
      "policy",
      "premium",
      "claim",
      "quote",
      "deductible",
      "liability",
    ],
    prohibitedTerms: [
      "insurance software",
      "insurance crm",
      "claims management system",
    ],
    locationRelevance: "high",
  },
  "cleaning-services": {
    requiredTerms: [
      "cleaning",
      "clean",
      "maid",
      "janitorial",
      "housekeeping",
      "sanitize",
      "disinfect",
      "carpet",
    ],
    prohibitedTerms: [
      "cleaning software",
      "maid service app",
      "janitorial management",
    ],
    locationRelevance: "high",
  },
  general: {
    requiredTerms: [],
    prohibitedTerms: [],
    locationRelevance: "medium",
  },
};

/**
 * Get domain-specific validation rules
 */
export function getDomainValidationRules(
  domain?: BusinessDomain,
): DomainValidationRules {
  if (!domain) {
    return DOMAIN_VALIDATION_RULES.general;
  }
  return DOMAIN_VALIDATION_RULES[domain] || DOMAIN_VALIDATION_RULES.general;
}

/**
 * Verify if a keyword is relevant to the business
 */
export async function verifyKeyword(
  keyword: string,
  business: any,
  businessContext: BusinessContextAnalysis,
  coreOfferings?: CoreOfferings,
  domain?: BusinessDomain,
): Promise<KeywordVerificationResult> {
  const primaryServices = businessContext.services.primary.join(", ");
  const businessType = business.businessType || "";
  const businessDescription = business.businessDescription || "";
  const businessName = business.businessName || "";

  const keywordLower = keyword.toLowerCase();

  const domainRules = getDomainValidationRules(domain);

  for (const prohibitedTerm of domainRules.prohibitedTerms) {
    if (keywordLower.includes(prohibitedTerm.toLowerCase())) {
      return {
        keyword,
        isValid: false,
        reason: `Keyword matches domain-prohibited pattern: ${prohibitedTerm}`,
        relevanceScore: 0,
      };
    }
  }

  if (domainRules.requiredTerms.length > 0) {
    const hasRequiredTerm = domainRules.requiredTerms.some((term) =>
      keywordLower.includes(term.toLowerCase()),
    );

    if (hasRequiredTerm) {
      return {
        keyword,
        isValid: true,
        reason: `Keyword matches domain-specific required terms for ${domain}`,
        relevanceScore: 0.85,
      };
    }
  }

  const canadianCities = [
    "toronto",
    "duffrin",
    "york",
    "mississauga",
    "vancouver",
    "calgary",
    "montreal",
    "ottawa",
    "edmonton",
    "winnipeg",
    "halifax",
    "victoria",
    "saskatoon",
    "regina",
    "hamilton",
    "kitchener",
    "london",
    "windsor",
    "oshawa",
    "barrie",
  ];

  const usCities = [
    "new york",
    "los angeles",
    "chicago",
    "houston",
    "phoenix",
    "philadelphia",
    "san diego",
    "dallas",
    "san jose",
    "austin",
    "seattle",
    "denver",
    "boston",
    "las vegas",
    "portland",
  ];

  const allCities = [...canadianCities, ...usCities];

  const pureLocationTerms = [
    "ontario",
    "quebec",
    "canada",
    "usa",
    "port",
    "credit",
    "downtown",
    "uptown",
    "east",
    "west",
    "north",
    "south",
    "area",
    "location",
    "city",
    "to",
    "in",
    "near",
    "around",
  ];

  const isPureLocationKeyword = (kw: string): boolean => {
    const words = kw.split(/\s+/).filter((w) => w.length > 1);
    let locationWordCount = 0;
    let nonLocationWordCount = 0;

    for (const word of words) {
      const wordLower = word.toLowerCase();
      const isLocationWord =
        allCities.includes(wordLower) || pureLocationTerms.includes(wordLower);

      if (isLocationWord) {
        locationWordCount++;
      } else {
        nonLocationWordCount++;
      }
    }

    if (locationWordCount > 0 && nonLocationWordCount === 0) {
      return true;
    }

    return false;
  };

  if (coreOfferings) {
    for (const competitor of coreOfferings.competitorNames || []) {
      if (competitor && keywordLower.includes(competitor.toLowerCase())) {
        return {
          keyword,
          isValid: false,
          reason: `Keyword mentions competitor: ${competitor}`,
          relevanceScore: 0,
        };
      }
    }

    const mentionsService =
      (coreOfferings.primaryOfferings || []).some((offering: string) =>
        keywordLower.includes(offering.toLowerCase()),
      ) ||
      (coreOfferings.serviceTypes || []).some((type: string) =>
        keywordLower.includes(type.toLowerCase()),
      );
    const mentionsIndustry = keywordLower.includes(
      businessContext.market.industry.vertical.toLowerCase(),
    );

    if (mentionsService || mentionsIndustry) {
      return {
        keyword,
        isValid: true,
        reason: "Keyword mentions business service/product or industry",
        relevanceScore: 0.9,
      };
    }

    if (isPureLocationKeyword(keywordLower)) {
      return {
        keyword,
        isValid: false,
        reason:
          "Keyword is pure location names without any service/product context",
        relevanceScore: 0,
      };
    }
  }

  const prompt = `You are a keyword verification agent. Your task is to verify if a keyword is relevant and appropriate for a specific business.

BUSINESS INFORMATION:
- Business Name: ${businessName}
- Business Type: ${businessType}
- Business Description: ${businessDescription}
- Primary Services/Products: ${primaryServices}
${
  coreOfferings
    ? `- What Business Sells: ${coreOfferings.whatBusinessSells}`
    : ""
}
${
  coreOfferings
    ? `- Primary Offerings: ${coreOfferings.primaryOfferings.join(", ")}`
    : ""
}
${coreOfferings ? `- Target Customers: ${coreOfferings.targetCustomers}` : ""}
- Business Model: ${businessContext.businessModel.type} (Location Dependent: ${
    businessContext.businessModel.isLocationDependent
  })
- Industry: ${businessContext.market.industry.vertical}
- Target Customers: ${businessContext.market.customerSegment.primary}

KEYWORD TO VERIFY: "${keyword}"

🚨 KEYWORD VALIDATION RULES:

**✅ VALID - SERVICE + LOCATION (HIGH VALUE):**
- "banquet halls mississauga" → VALID (service + location)
- "wedding venue mississauga" → VALID (service + location)
- "event venues mississauga" → VALID (service + location)
- Any keyword with a service/product term = VALID (even with location)

**❌ INVALID - PURE LOCATION (NO SERVICE):**
- "Mississauga, Ontario" → INVALID (only location)
- "mississauga port credit" → INVALID (only locations)
- "toronto downtown" → INVALID (only location)

**❌ INVALID - COMPETITOR NAMES:**
- Keywords containing competitor business/venue names → INVALID

VERIFICATION CRITERIA:
1. **Core Offerings Match**: ${
    coreOfferings
      ? `Does keyword relate to what business sells: ${coreOfferings.whatBusinessSells}?`
      : `Does keyword relate to primary services/products: ${primaryServices}?`
  }
2. **Service/Product Mention**: ${
    coreOfferings
      ? `Does keyword mention at least ONE of: ${coreOfferings.primaryOfferings.join(
          ", ",
        )}?`
      : `Does keyword relate to services/products?`
  }
3. **Competitor Check**: ${
    coreOfferings && coreOfferings.competitorNames.length > 0
      ? `Does keyword mention competitor names: ${coreOfferings.competitorNames.join(
          ", ",
        )}? If yes, REJECT.`
      : `Does keyword mention other companies/brands that are NOT this business?`
  }
4. **Pure Location Check**: Is keyword ONLY made up of location/geographic terms without ANY service/product term? If yes, REJECT IMMEDIATELY.
5. **Location Appropriateness**: ${
    businessContext.businessModel.isLocationDependent
      ? `For service businesses, location is OK ONLY if a service/product term is ALSO present.`
      : `For product businesses, any location keyword should be rejected.`
  }
6. **Specificity**: Is it specific to this business's offerings, not generic?

REJECTION RULES:
- If keyword is ONLY location names (e.g., "toronto to duffrin") → isValid = false
${
  coreOfferings && coreOfferings.competitorNames.length > 0
    ? `- If keyword mentions competitor: ${coreOfferings.competitorNames.join(
        ", ",
      )} → isValid = false`
    : ""
}
- If keyword doesn't mention any service/product → isValid = false
- If keyword is too generic (e.g., just "toronto") → isValid = false

OUTPUT FORMAT:
Return ONLY a valid JSON object:
{
  "isValid": true | false,
  "reason": "Brief explanation (1-2 sentences)",
  "relevanceScore": 0.0-1.0 (1.0 = perfectly relevant, 0.0 = not relevant)
}

CRITICAL RULES:
- Return ONLY valid JSON, no markdown, no code blocks
- If keyword mentions other companies/brands (not this business), isValid = false
- If keyword is too generic and doesn't relate to services/products, isValid = false
- For PRODUCT businesses: If keyword contains location terms, isValid = false
- relevanceScore should reflect how well the keyword matches the business services/products
- Be strict - keywords should be clearly related to what the business offers
- Minimum relevanceScore for acceptance: 0.6`;

  try {
    const response = await verifierLLM.invoke(
      [
        {
          role: "system",
          content:
            "You are a keyword verification agent. Verify if keywords are relevant to specific businesses. Return ONLY valid JSON with isValid, reason, and relevanceScore fields.",
        },
        { role: "user", content: prompt },
      ],
      { signal: AbortSignal.timeout(keywordVerificationTimeoutMs()) },
    );

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        keyword,
        isValid: false,
        reason: "Failed to parse verification response",
        relevanceScore: 0,
      };
    }

    const result = JSON.parse(jsonMatch[0]) as {
      isValid: boolean;
      reason: string;
      relevanceScore: number;
    };

    return {
      keyword,
      isValid: result.isValid ?? false,
      reason: result.reason || "No reason provided",
      relevanceScore: Math.max(0, Math.min(1, result.relevanceScore || 0)),
    };
  } catch (error: any) {
    console.error(`❌ Keyword verification failed for "${keyword}":`, error);
    return {
      keyword,
      isValid: false,
      reason: `Verification error: ${error.message}`,
      relevanceScore: 0,
    };
  }
}

/**
 * Verify multiple keywords in parallel
 */
export async function verifyKeywords(
  keywords: string[],
  business: any,
  businessContext: BusinessContextAnalysis,
  coreOfferings?: CoreOfferings,
  domain?: BusinessDomain,
): Promise<KeywordVerificationResult[]> {
  console.log(
    `🔍 Verifying ${keywords.length} keywords for business relevance${domain ? ` (domain: ${domain})` : ""}...`,
  );

  const verificationPromises = keywords.map((keyword) =>
    verifyKeyword(keyword, business, businessContext, coreOfferings, domain),
  );

  const results = await Promise.all(verificationPromises);

  const validCount = results.filter((r) => r.isValid).length;
  const invalidCount = results.filter((r) => !r.isValid).length;

  console.log(
    `✅ Verification complete: ${validCount} valid, ${invalidCount} invalid keywords`,
  );

  if (invalidCount > 0) {
    console.log("❌ Invalid keywords:");
    results
      .filter((r) => !r.isValid)
      .forEach((r) => {
        console.log(`   - "${r.keyword}": ${r.reason}`);
      });
  }

  return results;
}
