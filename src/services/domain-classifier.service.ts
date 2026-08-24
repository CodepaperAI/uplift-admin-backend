import { getLLMForKeywords } from "../config/llm.config";
import { resolveEffectiveServices } from "../utils/effective-services.utils";

export type BusinessDomain =
  | "restaurant"
  | "law-firm"
  | "dental-medical"
  | "real-estate"
  | "tech-devops"
  | "event-venue"
  | "fitness-gym"
  | "salon-spa"
  | "auto-repair"
  | "accounting"
  | "photography"
  | "plumbing-hvac"
  | "ecommerce-retail"
  | "education-training"
  | "travel-hospitality"
  | "construction"
  | "marketing-agency"
  | "insurance"
  | "cleaning-services"
  | "general";

export interface DomainClassificationResult {
  domain: BusinessDomain;
  confidence: number;
  matchedKeywords: string[];
  classificationMethod: "keyword" | "llm";
}

interface DomainKeywords {
  domain: BusinessDomain;
  primaryKeywords: string[];
  secondaryKeywords: string[];
  excludeKeywords: string[];
}

const DOMAIN_KEYWORD_MAP: DomainKeywords[] = [
  {
    domain: "restaurant",
    primaryKeywords: [
      "restaurant",
      "food service",
      "dining",
      "eatery",
      "bistro",
      "cafe",
      "cafeteria",
      "diner",
      "pizzeria",
      "sushi",
      "steakhouse",
      "grill",
      "tavern",
      "pub food",
      "food truck",
      "fast food",
      "fine dining",
      "casual dining",
      "takeout",
      "delivery food",
    ],
    secondaryKeywords: [
      "catering",
      "menu",
      "cuisine",
      "chef",
      "kitchen",
      "meals",
      "breakfast",
      "lunch",
      "dinner",
      "brunch",
      "appetizers",
      "entrees",
      "desserts",
      "beverages",
      "halal",
      "kosher",
      "vegan food",
      "vegetarian",
      "gluten-free",
      "organic food",
    ],
    excludeKeywords: ["equipment", "supply", "software", "management system"],
  },
  {
    domain: "law-firm",
    primaryKeywords: [
      "law firm",
      "legal services",
      "attorney",
      "lawyer",
      "legal practice",
      "law office",
      "legal counsel",
      "barrister",
      "solicitor",
      "legal representation",
      "litigation",
      "legal advice",
    ],
    secondaryKeywords: [
      "personal injury",
      "family law",
      "criminal defense",
      "corporate law",
      "real estate law",
      "immigration law",
      "bankruptcy",
      "estate planning",
      "intellectual property",
      "employment law",
      "tax law",
      "civil litigation",
      "contract law",
      "divorce",
      "custody",
      "will",
      "trust",
    ],
    excludeKeywords: ["software", "tech", "management"],
  },
  {
    domain: "dental-medical",
    primaryKeywords: [
      "dental",
      "dentist",
      "medical",
      "healthcare",
      "clinic",
      "hospital",
      "doctor",
      "physician",
      "health center",
      "medical practice",
      "dental office",
      "orthodontist",
      "oral surgeon",
      "periodontist",
      "endodontist",
    ],
    secondaryKeywords: [
      "teeth",
      "oral health",
      "dental care",
      "braces",
      "implants",
      "root canal",
      "whitening",
      "cleaning",
      "checkup",
      "x-ray",
      "surgery",
      "treatment",
      "diagnosis",
      "patient care",
      "pediatric",
      "cosmetic dentistry",
      "emergency dental",
      "family medicine",
      "urgent care",
    ],
    excludeKeywords: ["software", "equipment sales", "supply"],
  },
  {
    domain: "real-estate",
    primaryKeywords: [
      "real estate",
      "realty",
      "property",
      "realtor",
      "real estate agent",
      "broker",
      "property management",
      "real estate agency",
      "home sales",
      "property sales",
      "real estate brokerage",
    ],
    secondaryKeywords: [
      "homes",
      "houses",
      "apartments",
      "condos",
      "townhouses",
      "commercial property",
      "residential",
      "land",
      "listings",
      "mls",
      "buying",
      "selling",
      "renting",
      "leasing",
      "mortgage",
      "investment property",
      "foreclosure",
      "open house",
    ],
    excludeKeywords: ["software", "crm", "platform"],
  },
  {
    domain: "tech-devops",
    primaryKeywords: [
      "software development",
      "web development",
      "app development",
      "devops",
      "cloud services",
      "it consulting",
      "technology solutions",
      "saas",
      "software company",
      "tech startup",
      "it services",
      "software engineering",
      "programming",
      "coding",
    ],
    secondaryKeywords: [
      "aws",
      "azure",
      "google cloud",
      "kubernetes",
      "docker",
      "ci/cd",
      "api",
      "database",
      "frontend",
      "backend",
      "fullstack",
      "react",
      "node",
      "python",
      "java",
      "mobile app",
      "web app",
      "automation",
      "infrastructure",
      "cybersecurity",
      "data analytics",
      "machine learning",
      "ai",
    ],
    excludeKeywords: [],
  },
  {
    domain: "event-venue",
    primaryKeywords: [
      "event venue",
      "banquet hall",
      "wedding venue",
      "conference center",
      "event space",
      "reception hall",
      "party venue",
      "meeting space",
      "convention center",
      "ballroom",
      "event center",
    ],
    secondaryKeywords: [
      "wedding",
      "corporate events",
      "birthday party",
      "anniversary",
      "graduation",
      "baby shower",
      "retirement party",
      "holiday party",
      "team building",
      "seminars",
      "workshops",
      "galas",
      "fundraisers",
      "private events",
      "capacity",
      "seating",
      "decorations",
    ],
    excludeKeywords: ["planning software", "management platform"],
  },
  {
    domain: "fitness-gym",
    primaryKeywords: [
      "gym",
      "fitness center",
      "fitness studio",
      "health club",
      "workout",
      "personal training",
      "crossfit",
      "yoga studio",
      "pilates",
      "martial arts",
      "boxing gym",
      "sports club",
    ],
    secondaryKeywords: [
      "exercise",
      "weight training",
      "cardio",
      "strength training",
      "muscle",
      "bodybuilding",
      "weight loss",
      "fitness classes",
      "group fitness",
      "spin class",
      "zumba",
      "aerobics",
      "personal trainer",
      "nutrition",
      "supplements",
      "membership",
    ],
    excludeKeywords: ["equipment sales", "software", "app"],
  },
  {
    domain: "salon-spa",
    primaryKeywords: [
      "salon",
      "spa",
      "beauty salon",
      "hair salon",
      "nail salon",
      "barbershop",
      "day spa",
      "med spa",
      "wellness spa",
      "beauty parlor",
      "aesthetics",
      "skincare clinic",
    ],
    secondaryKeywords: [
      "haircut",
      "hair color",
      "highlights",
      "balayage",
      "blowout",
      "manicure",
      "pedicure",
      "facial",
      "massage",
      "waxing",
      "threading",
      "lash extensions",
      "microblading",
      "botox",
      "fillers",
      "laser treatment",
      "body treatment",
    ],
    excludeKeywords: ["equipment", "supply", "wholesale"],
  },
  {
    domain: "auto-repair",
    primaryKeywords: [
      "auto repair",
      "car repair",
      "mechanic",
      "automotive",
      "auto shop",
      "garage",
      "car service",
      "auto service",
      "vehicle repair",
      "auto body",
      "collision repair",
      "tire shop",
    ],
    secondaryKeywords: [
      "oil change",
      "brake repair",
      "engine repair",
      "transmission",
      "alignment",
      "tune-up",
      "diagnostics",
      "inspection",
      "maintenance",
      "tires",
      "battery",
      "exhaust",
      "suspension",
      "ac repair",
      "detailing",
      "windshield",
    ],
    excludeKeywords: ["parts store", "dealership sales", "software"],
  },
  {
    domain: "accounting",
    primaryKeywords: [
      "accounting",
      "accountant",
      "cpa",
      "bookkeeping",
      "tax services",
      "financial services",
      "accounting firm",
      "tax preparation",
      "auditing",
      "payroll services",
    ],
    secondaryKeywords: [
      "tax return",
      "business tax",
      "personal tax",
      "financial planning",
      "budgeting",
      "financial statements",
      "quarterly taxes",
      "tax filing",
      "irs",
      "compliance",
      "small business accounting",
      "corporate tax",
      "estate tax",
      "audit",
      "consulting",
    ],
    excludeKeywords: ["software", "platform", "app"],
  },
  {
    domain: "photography",
    primaryKeywords: [
      "photography",
      "photographer",
      "photo studio",
      "photography services",
      "videography",
      "videographer",
      "photo booth",
      "portrait studio",
    ],
    secondaryKeywords: [
      "wedding photography",
      "portrait",
      "headshots",
      "family photos",
      "newborn photography",
      "maternity",
      "event photography",
      "corporate photography",
      "product photography",
      "real estate photography",
      "drone photography",
      "photo editing",
      "albums",
      "prints",
    ],
    excludeKeywords: ["camera store", "equipment sales", "software"],
  },
  {
    domain: "plumbing-hvac",
    primaryKeywords: [
      "plumbing",
      "plumber",
      "hvac",
      "heating",
      "cooling",
      "air conditioning",
      "furnace",
      "ac repair",
      "plumbing services",
      "hvac services",
      "heating services",
    ],
    secondaryKeywords: [
      "drain cleaning",
      "pipe repair",
      "water heater",
      "leak repair",
      "toilet repair",
      "faucet",
      "sewer",
      "garbage disposal",
      "ac installation",
      "furnace repair",
      "duct cleaning",
      "thermostat",
      "ventilation",
      "emergency plumber",
      "24 hour",
    ],
    excludeKeywords: ["parts store", "wholesale", "equipment sales"],
  },
  {
    domain: "ecommerce-retail",
    primaryKeywords: [
      "ecommerce",
      "e-commerce",
      "online store",
      "retail",
      "shop",
      "store",
      "marketplace",
      "boutique",
      "online shop",
      "retail store",
    ],
    secondaryKeywords: [
      "products",
      "merchandise",
      "inventory",
      "shipping",
      "delivery",
      "orders",
      "cart",
      "checkout",
      "payment",
      "returns",
      "discounts",
      "sale",
      "promotions",
      "brands",
      "categories",
    ],
    excludeKeywords: ["platform", "software", "development"],
  },
  {
    domain: "education-training",
    primaryKeywords: [
      "education",
      "school",
      "academy",
      "training",
      "learning center",
      "tutoring",
      "courses",
      "classes",
      "institute",
      "college",
      "university",
      "online learning",
    ],
    secondaryKeywords: [
      "certification",
      "diploma",
      "degree",
      "curriculum",
      "students",
      "teachers",
      "instructors",
      "workshops",
      "seminars",
      "skills",
      "professional development",
      "continuing education",
      "test prep",
      "tutors",
    ],
    excludeKeywords: ["software", "platform", "lms"],
  },
  {
    domain: "travel-hospitality",
    primaryKeywords: [
      "travel",
      "hotel",
      "hospitality",
      "resort",
      "vacation",
      "tourism",
      "travel agency",
      "tour operator",
      "bed and breakfast",
      "inn",
      "motel",
      "lodging",
    ],
    secondaryKeywords: [
      "booking",
      "reservation",
      "accommodation",
      "destination",
      "flights",
      "cruise",
      "tours",
      "packages",
      "honeymoon",
      "adventure travel",
      "business travel",
      "luxury travel",
      "budget travel",
      "amenities",
      "concierge",
    ],
    excludeKeywords: ["software", "platform", "booking system"],
  },
  {
    domain: "construction",
    primaryKeywords: [
      "construction",
      "contractor",
      "builder",
      "general contractor",
      "construction company",
      "building",
      "remodeling",
      "renovation",
      "home improvement",
      "roofing",
      "flooring",
    ],
    secondaryKeywords: [
      "residential construction",
      "commercial construction",
      "kitchen remodel",
      "bathroom remodel",
      "additions",
      "decks",
      "patios",
      "basement finishing",
      "drywall",
      "painting",
      "carpentry",
      "electrical",
      "permits",
      "blueprints",
    ],
    excludeKeywords: ["software", "management platform", "equipment rental"],
  },
  {
    domain: "marketing-agency",
    primaryKeywords: [
      "marketing agency",
      "digital marketing",
      "advertising agency",
      "marketing services",
      "branding agency",
      "creative agency",
      "pr agency",
      "public relations",
      "media agency",
    ],
    secondaryKeywords: [
      "seo",
      "ppc",
      "social media marketing",
      "content marketing",
      "email marketing",
      "branding",
      "graphic design",
      "web design",
      "campaigns",
      "analytics",
      "strategy",
      "lead generation",
      "conversion",
      "roi",
    ],
    excludeKeywords: ["software", "platform", "saas"],
  },
  {
    domain: "insurance",
    primaryKeywords: [
      "insurance",
      "insurance agency",
      "insurance broker",
      "insurance agent",
      "insurance company",
      "insurance services",
    ],
    secondaryKeywords: [
      "auto insurance",
      "car insurance",
      "home insurance",
      "life insurance",
      "health insurance",
      "business insurance",
      "commercial insurance",
      "liability insurance",
      "property insurance",
      "coverage",
      "policy",
      "claims",
      "premiums",
      "deductible",
      "quotes",
    ],
    excludeKeywords: ["software", "platform", "tech"],
  },
  {
    domain: "cleaning-services",
    primaryKeywords: [
      "cleaning",
      "cleaning service",
      "janitorial",
      "maid service",
      "house cleaning",
      "commercial cleaning",
      "office cleaning",
      "cleaning company",
    ],
    secondaryKeywords: [
      "residential cleaning",
      "deep cleaning",
      "move in cleaning",
      "move out cleaning",
      "carpet cleaning",
      "window cleaning",
      "pressure washing",
      "disinfection",
      "sanitization",
      "recurring cleaning",
      "one time cleaning",
      "spring cleaning",
    ],
    excludeKeywords: ["supplies", "equipment", "software"],
  },
];

export class DomainClassifierService {
  private classifierLLM: ReturnType<typeof getLLMForKeywords>;

  constructor() {
    this.classifierLLM = getLLMForKeywords();
  }

  async classify(businessData: {
    businessType?: string;
    businessDescription?: string;
    businessName?: string;
    coreServices?: {
      topLevel?: string[];
      subOfferings?: string[];
    };
    websiteAnalysis?: {
      coreServices?: {
        topLevel?: string[];
        subOfferings?: string[];
      };
    };
  }): Promise<DomainClassificationResult> {
    const keywordResult = this.classifyByKeywords(businessData);

    if (keywordResult.confidence >= 0.7) {
      console.log(
        `🎯 Domain classified by keywords: ${keywordResult.domain} (confidence: ${keywordResult.confidence})`,
      );
      return keywordResult;
    }

    console.log(
      `🤔 Keyword classification uncertain (${keywordResult.confidence}), using LLM fallback...`,
    );
    const llmResult = await this.classifyByLLM(businessData);

    if (llmResult.confidence > keywordResult.confidence) {
      return llmResult;
    }

    return keywordResult;
  }

  private classifyByKeywords(businessData: {
    businessType?: string;
    businessDescription?: string;
    businessName?: string;
    coreServices?: {
      topLevel?: string[];
      subOfferings?: string[];
    };
    websiteAnalysis?: {
      coreServices?: {
        topLevel?: string[];
        subOfferings?: string[];
      };
    };
  }): DomainClassificationResult {
    const textToAnalyze = this.buildTextForAnalysis(businessData).toLowerCase();

    const scores: Array<{
      domain: BusinessDomain;
      score: number;
      matchedKeywords: string[];
    }> = [];

    for (const domainConfig of DOMAIN_KEYWORD_MAP) {
      let score = 0;
      const matchedKeywords: string[] = [];

      let hasExcludeKeyword = false;
      for (const excludeKeyword of domainConfig.excludeKeywords) {
        if (textToAnalyze.includes(excludeKeyword.toLowerCase())) {
          hasExcludeKeyword = true;
          break;
        }
      }

      for (const primaryKeyword of domainConfig.primaryKeywords) {
        if (textToAnalyze.includes(primaryKeyword.toLowerCase())) {
          score += hasExcludeKeyword ? 1 : 3;
          matchedKeywords.push(primaryKeyword);
        }
      }

      for (const secondaryKeyword of domainConfig.secondaryKeywords) {
        if (textToAnalyze.includes(secondaryKeyword.toLowerCase())) {
          score += hasExcludeKeyword ? 0.3 : 1;
          matchedKeywords.push(secondaryKeyword);
        }
      }

      scores.push({
        domain: domainConfig.domain,
        score,
        matchedKeywords,
      });
    }

    scores.sort((a, b) => b.score - a.score);

    const topScore = scores[0];
    const secondScore = scores[1];

    if (!topScore || topScore.score === 0) {
      return {
        domain: "general",
        confidence: 0.5,
        matchedKeywords: [],
        classificationMethod: "keyword",
      };
    }

    let confidence = Math.min(
      1.0,
      topScore.score / 10 +
        (secondScore ? (topScore.score - secondScore.score) / 10 : 0.2),
    );

    if (topScore.matchedKeywords.length >= 3) {
      confidence = Math.min(1.0, confidence + 0.1);
    }

    return {
      domain: topScore.domain,
      confidence: Math.round(confidence * 100) / 100,
      matchedKeywords: topScore.matchedKeywords,
      classificationMethod: "keyword",
    };
  }

  private async classifyByLLM(businessData: {
    businessType?: string;
    businessDescription?: string;
    businessName?: string;
    coreServices?: {
      topLevel?: string[];
      subOfferings?: string[];
    };
    websiteAnalysis?: {
      coreServices?: {
        topLevel?: string[];
        subOfferings?: string[];
      };
    };
  }): Promise<DomainClassificationResult> {
    const domains: BusinessDomain[] = [
      "restaurant",
      "law-firm",
      "dental-medical",
      "real-estate",
      "tech-devops",
      "event-venue",
      "fitness-gym",
      "salon-spa",
      "auto-repair",
      "accounting",
      "photography",
      "plumbing-hvac",
      "ecommerce-retail",
      "education-training",
      "travel-hospitality",
      "construction",
      "marketing-agency",
      "insurance",
      "cleaning-services",
      "general",
    ];

    const coreServices = resolveEffectiveServices(businessData);

    const prompt = `Classify this business into ONE of the following domains:

DOMAINS:
${domains.map((d) => `- ${d}`).join("\n")}

BUSINESS DATA:
- Name: ${businessData.businessName || "N/A"}
- Type: ${businessData.businessType || "N/A"}
- Description: ${businessData.businessDescription || "N/A"}
- Services: ${coreServices?.topLevel?.join(", ") || "N/A"}
- Sub-offerings: ${coreServices?.subOfferings?.join(", ") || "N/A"}

CLASSIFICATION RULES:
1. Choose the MOST SPECIFIC domain that matches the business
2. Use "general" ONLY if no other domain fits
3. Consider ALL provided information
4. Focus on what the business DOES, not what tools they use

Return ONLY a JSON object:
{
  "domain": "domain-name",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}`;

    try {
      const response = await this.classifierLLM.invoke([
        {
          role: "system",
          content:
            "You are a business classification expert. Classify businesses into specific industry domains. Return ONLY valid JSON.",
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

      const result = JSON.parse(jsonMatch[0]) as {
        domain: string;
        confidence: number;
        reasoning: string;
      };

      const domain = domains.includes(result.domain as BusinessDomain)
        ? (result.domain as BusinessDomain)
        : "general";

      console.log(
        `🤖 LLM classification: ${domain} (confidence: ${result.confidence}) - ${result.reasoning}`,
      );

      return {
        domain,
        confidence: Math.round(result.confidence * 100) / 100,
        matchedKeywords: [],
        classificationMethod: "llm",
      };
    } catch (error) {
      console.error("❌ LLM classification failed:", error);
      return {
        domain: "general",
        confidence: 0.5,
        matchedKeywords: [],
        classificationMethod: "llm",
      };
    }
  }

  private buildTextForAnalysis(businessData: {
    businessType?: string;
    businessDescription?: string;
    businessName?: string;
    coreServices?: {
      topLevel?: string[];
      subOfferings?: string[];
    };
    websiteAnalysis?: {
      coreServices?: {
        topLevel?: string[];
        subOfferings?: string[];
      };
    };
  }): string {
    const parts: string[] = [];

    if (businessData.businessName) {
      parts.push(businessData.businessName);
    }
    if (businessData.businessType) {
      parts.push(businessData.businessType);
    }
    if (businessData.businessDescription) {
      parts.push(businessData.businessDescription);
    }

    const coreServices = resolveEffectiveServices(businessData);

    if (coreServices?.topLevel) {
      parts.push(coreServices.topLevel.join(" "));
    }
    if (coreServices?.subOfferings) {
      parts.push(coreServices.subOfferings.join(" "));
    }

    return parts.join(" ");
  }

  getDomainDisplayName(domain: BusinessDomain): string {
    const displayNames: Record<BusinessDomain, string> = {
      restaurant: "Restaurant & Food Service",
      "law-firm": "Law Firm & Legal Services",
      "dental-medical": "Dental & Medical Healthcare",
      "real-estate": "Real Estate",
      "tech-devops": "Technology & DevOps",
      "event-venue": "Event Venue & Banquet Hall",
      "fitness-gym": "Fitness & Gym",
      "salon-spa": "Salon & Spa",
      "auto-repair": "Auto Repair & Automotive",
      accounting: "Accounting & Financial Services",
      photography: "Photography & Videography",
      "plumbing-hvac": "Plumbing & HVAC",
      "ecommerce-retail": "E-commerce & Retail",
      "education-training": "Education & Training",
      "travel-hospitality": "Travel & Hospitality",
      construction: "Construction & Contracting",
      "marketing-agency": "Marketing & Advertising Agency",
      insurance: "Insurance",
      "cleaning-services": "Cleaning Services",
      general: "General Business",
    };

    return displayNames[domain] || "General Business";
  }
}

export const domainClassifier = new DomainClassifierService();
