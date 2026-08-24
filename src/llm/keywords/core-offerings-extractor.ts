import { getLLMForKeywords } from "../../config/llm.config";
import type { BusinessDomain } from "../../services/domain-classifier.service";
import { resolveEffectiveServices } from "../../utils/effective-services.utils";

export interface CoreOfferings {
  whatBusinessSells: string;
  primaryOfferings: string[];
  serviceTypes: string[];
  targetCustomers: string;
  explicitStatement: string;
  competitorNames: string[];
  irrelevantTerms: string[];
  technologies: string[];
  subTopics: string[];
  practicalTutorialIdeas: string[];
  detectedDomain?: BusinessDomain;
}

const offeringsLLM = getLLMForKeywords();

function detectDomainFromOfferings(
  offerings: Omit<CoreOfferings, "detectedDomain">,
  businessType?: string,
  businessDescription?: string,
): BusinessDomain {
  const allText = [
    offerings.whatBusinessSells,
    ...offerings.primaryOfferings,
    ...offerings.serviceTypes,
    offerings.targetCustomers,
    businessType || "",
    businessDescription || "",
  ]
    .join(" ")
    .toLowerCase();

  const domainKeywords: Record<BusinessDomain, string[]> = {
    restaurant: [
      "restaurant",
      "food",
      "dining",
      "menu",
      "cuisine",
      "catering",
      "chef",
      "meals",
    ],
    "law-firm": [
      "lawyer",
      "attorney",
      "legal",
      "law firm",
      "litigation",
      "court",
      "lawsuit",
    ],
    "dental-medical": [
      "dental",
      "dentist",
      "medical",
      "healthcare",
      "clinic",
      "doctor",
      "patient",
    ],
    "real-estate": [
      "real estate",
      "property",
      "realtor",
      "homes",
      "houses",
      "buying",
      "selling",
    ],
    "tech-devops": [
      "software",
      "devops",
      "cloud",
      "aws",
      "kubernetes",
      "development",
      "api",
    ],
    "event-venue": [
      "venue",
      "banquet",
      "event space",
      "wedding venue",
      "conference",
      "reception hall",
    ],
    "fitness-gym": [
      "gym",
      "fitness",
      "workout",
      "training",
      "exercise",
      "yoga",
      "personal trainer",
    ],
    "salon-spa": [
      "salon",
      "spa",
      "hair",
      "beauty",
      "massage",
      "facial",
      "nail",
    ],
    "auto-repair": [
      "auto repair",
      "mechanic",
      "car repair",
      "automotive",
      "vehicle",
      "oil change",
    ],
    accounting: [
      "accounting",
      "accountant",
      "tax",
      "bookkeeping",
      "cpa",
      "financial",
    ],
    photography: [
      "photography",
      "photographer",
      "photo",
      "portrait",
      "videography",
    ],
    "plumbing-hvac": [
      "plumbing",
      "plumber",
      "hvac",
      "heating",
      "cooling",
      "air conditioning",
    ],
    "ecommerce-retail": [
      "ecommerce",
      "online store",
      "retail",
      "shop",
      "products",
    ],
    "education-training": [
      "education",
      "training",
      "courses",
      "school",
      "academy",
      "tutoring",
    ],
    "travel-hospitality": [
      "travel",
      "hotel",
      "hospitality",
      "tourism",
      "vacation",
      "resort",
    ],
    construction: [
      "construction",
      "contractor",
      "builder",
      "renovation",
      "remodeling",
    ],
    "marketing-agency": [
      "marketing agency",
      "digital marketing",
      "advertising",
      "seo agency",
      "branding",
    ],
    insurance: ["insurance", "coverage", "policy", "broker", "agent", "claims"],
    "cleaning-services": [
      "cleaning",
      "janitorial",
      "maid",
      "house cleaning",
      "commercial cleaning",
    ],
    general: [],
  };

  let bestMatch: BusinessDomain = "general";
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (domain === "general") continue;

    let score = 0;
    for (const keyword of keywords) {
      if (allText.includes(keyword)) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = domain as BusinessDomain;
    }
  }

  return bestScore >= 2 ? bestMatch : "general";
}

export async function extractCoreOfferings(
  business: any,
): Promise<CoreOfferings> {
  const coreServices = resolveEffectiveServices(business);

  const primaryServices = coreServices?.topLevel || [];
  const secondaryServices = coreServices?.subOfferings || [];
  const industryFocus = coreServices?.industryFocus || [];
  const businessName = business.businessName || "";
  const businessType = business.businessType || "";
  const businessDescription = business.businessDescription || "";
  const businessCity = business.businessCity || "";
  const businessState = business.businessState || "";
  const businessCountry = business.businessCountry || "";
  const targetAudience = business.targetAudience || "";
  const serviceArea = business.serviceArea || "national";

  const prompt = `You are an expert business analyst and SEO strategist. Your task is to deeply analyze this business and extract COMPREHENSIVE offerings, technologies, and content ideas that people actually search for.

BUSINESS DATA:
- Name: ${businessName}
- Type: ${businessType}
- Description: ${businessDescription}
- Primary Services: ${primaryServices.join(", ") || "N/A"}
- Secondary Services/Offerings: ${secondaryServices.join(", ") || "N/A"}
- Industry Focus: ${industryFocus.join(", ") || "N/A"}
- Location: ${businessCity || "N/A"}, ${businessState || "N/A"}, ${
    businessCountry || "N/A"
  }
- Target Audience: ${targetAudience || "N/A"}
- Service Area: ${serviceArea}

YOUR TASK:
Think DEEPLY about this business. What do people actually search for when looking for these services? What problems do they have? What tutorials would help them? What technologies/tools are involved?

1. WHAT BUSINESS SELLS:
   - Create a clear, one-line summary: "This business sells [X] to [Y]"
   - Be specific about the services/products

2. PRIMARY OFFERINGS:
   - List the main services/products the business offers
   - Use specific terms (e.g., "DevOps consulting", "AWS cloud migration", "CI/CD pipeline setup")

3. SERVICE TYPES:
   - Extract the types of services (e.g., "consulting", "migration", "setup", "training")

4. TARGET CUSTOMERS:
   - Who does this business sell to?
   - Be specific (e.g., "Startups and mid-size companies needing cloud infrastructure")

5. EXPLICIT STATEMENT:
   - Create a clear statement about what the business offers

6. COMPETITOR NAMES:
   - Identify 5-10 well-known competitors/brands in this space
   - These are names we should AVOID in keywords (competitor SEO)

7. IRRELEVANT TERMS:
   - Terms that should NOT appear in keywords

🚀 8. TECHNOLOGIES/TOOLS/METHODS (CRITICAL - THINK DEEP FOR ANY INDUSTRY):
   Think about ALL the tools, methods, techniques, ingredients, equipment, platforms, and specialized terms related to this business.
   
   Examples by industry (ADAPT TO ANY BUSINESS TYPE):
   - DevOps/Tech: AWS, Docker, Kubernetes, Terraform, GitHub Actions, CI/CD, Lambda, S3
   - Web Development: React, Next.js, Node.js, PostgreSQL, Prisma, Tailwind CSS, GraphQL
   - Restaurant/Food: **MUST be specific to the restaurant's actual menu items, cuisine type, and services**
     * Specific dishes they serve (e.g., "shawarma", "falafel", "hummus" for Mediterranean restaurants)
     * Their actual cuisine type (e.g., "Mediterranean", "Italian", "Asian fusion")
     * Dietary options they offer (vegan, gluten-free, halal, keto) - ONLY if they actually offer these
     * Services they provide (dine-in, takeout, delivery, catering, private events)
     * Cooking techniques specific to their cuisine
     * Ingredients they use (ONLY if relevant to their menu)
     * Menu types they offer (breakfast, lunch, dinner, brunch) - ONLY if they serve these
     * **DO NOT include generic restaurant terms that don't match their specific offerings**
   - Event Venue: Event types (corporate, wedding, birthday), catering styles, AV equipment, decoration themes, seating arrangements
   - Law Firm: Practice areas, legal procedures, case types, court systems, legal documents, compliance requirements
   - Dental/Medical: Procedures, treatments, conditions, equipment, specializations, insurance types
   - Real Estate: Property types, neighborhoods, financing options, market terms, inspection types
   - Fitness/Gym: Workout types, equipment, training methods, nutrition approaches, certifications
   - Salon/Spa: Services, techniques, products, treatments, styling methods
   - Auto Repair: Vehicle types, repair services, parts, diagnostic tools, maintenance procedures
   - Accounting: Tax types, business structures, financial reports, software, compliance requirements
   - Photography: Styles, equipment, editing software, event types, techniques
   
   List 15-25 specific terms that customers in this industry would search for.

🚀 9. SUB-TOPICS & SPECIALIZATIONS (CRITICAL - THINK DEEP):
   What are ALL the sub-topics, specializations, niches, and specific areas within this business domain?
   
   Examples by industry (ADAPT TO ANY BUSINESS TYPE):
   - Restaurant: **MUST be specific to what THIS restaurant actually offers**
     * Menu planning (if they offer custom menus)
     * Food presentation (if relevant to their service style)
     * Dietary accommodations (ONLY if they actually accommodate these - e.g., halal, vegan, gluten-free)
     * Seasonal specials (if they offer seasonal menus)
     * Catering for events (ONLY if they offer catering services)
     * Takeout/delivery optimization (if they offer these services)
     * Customer loyalty programs (if they have one)
     * **DO NOT include sub-topics that don't relate to their actual menu, cuisine type, or services**
   - Event Venue: Corporate conferences, wedding receptions, birthday celebrations, product launches, holiday parties, team building, outdoor vs indoor events
   - Law Firm: Personal injury, family law, business contracts, real estate closings, estate planning, criminal defense, immigration
   - Dental: Cosmetic dentistry, orthodontics, pediatric dentistry, emergency dental care, dental implants, teeth whitening, root canal treatment
   - Real Estate: First-time buyers, luxury homes, investment properties, commercial real estate, property management, home staging
   - Plumbing: Drain cleaning, water heater repair, pipe installation, bathroom renovation, emergency plumbing, sewer line services
   - HVAC: AC installation, furnace repair, duct cleaning, energy efficiency, smart thermostats, seasonal maintenance
   
   List 15-25 specific sub-topics that people search about in this domain.

🚀 10. PRACTICAL SEARCH QUERIES (CRITICAL - WHAT REAL CUSTOMERS SEARCH):
   Generate 20-30 SPECIFIC search queries that REAL customers commonly type into Google when looking for this type of business or trying to solve problems in this domain.
   
   SEARCH QUERY PATTERNS (apply to ANY industry):
   - "how to [action/solve problem]"
   - "best [service/product] for [use case]"
   - "[service] near me" / "[service] in [city]"
   - "[service] cost" / "how much does [service] cost"
   - "[option A] vs [option B]"
   - "[topic] tips for beginners"
   - "what to look for in a [service provider]"
   - "[problem] solutions"
   - "[service] checklist"
   - "signs you need [service]"
   
   Examples by industry (THINK LIKE A CUSTOMER SEARCHING GOOGLE):
   - Restaurant:
     * "best shawarma near me", "halal catering for corporate events"
     * "mediterranean food catering prices", "healthy lunch catering options"
     * "how to order catering for office party", "group dining options downtown"
     * 
     **🚨 CRITICAL FOR RESTAURANTS: Keywords MUST be specific to the restaurant's ACTUAL menu items and services they offer.**
     * DO NOT generate generic restaurant keywords that don't match their cuisine type, menu, or services
     * If the restaurant serves Mediterranean food, keywords should be about Mediterranean dishes, not Italian or Asian dishes
     * If the restaurant offers catering, keywords should mention their specific catering services
     * If the restaurant has a specific menu (e.g., halal, vegan, gluten-free), keywords should reflect those offerings
     * Keywords should align with what customers would actually search for when looking for THIS specific restaurant's offerings
   
   - Event Venue:
     * "wedding venue checklist", "how to choose a banquet hall"
     * "corporate event planning tips", "birthday party venue ideas"
     * "event venue vs restaurant for reception", "banquet hall prices per person"
   
   - Law Firm:
     * "do I need a lawyer for [situation]", "how to file for [legal action]"
     * "personal injury lawyer cost", "what to expect in a divorce proceeding"
   
   - Dental:
     * "how to whiten teeth naturally", "dental implant vs bridge comparison"
     * "signs you need a root canal", "how much do braces cost"
   
   - Plumber:
     * "how to unclog a drain", "water heater making noise"
     * "signs of a pipe leak", "emergency plumber near me"
   
   - Real Estate:
     * "first time home buyer checklist", "how to stage a home for sale"
     * "best neighborhoods for families in [city]", "home inspection red flags"
   
   These should be ACTUAL searches customers make - put yourself in their shoes!

OUTPUT FORMAT:
Return ONLY a valid JSON object:
{
  "whatBusinessSells": "Clear one-line summary",
  "primaryOfferings": ["offering 1", "offering 2", ...],
  "serviceTypes": ["type 1", "type 2", ...],
  "targetCustomers": "Who the business sells to",
  "explicitStatement": "This business sells [X] to [Y]",
  "competitorNames": ["competitor 1", "competitor 2", ...],
  "irrelevantTerms": ["term 1", "term 2", ...],
  "technologies": ["tech1", "tech2", ... (15-25 items)],
  "subTopics": ["subtopic1", "subtopic2", ... (15-25 items)],
  "practicalTutorialIdeas": ["how to X", "Y tutorial", ... (20-30 items)]
}

CRITICAL RULES:
- Return ONLY valid JSON
- THINK DEEPLY about technologies, sub-topics, and what people search
- Tutorial ideas should be REAL searchable phrases
- Be comprehensive - cover all aspects of the business domain`;

  try {
    const response = await offeringsLLM.invoke([
      {
        role: "system",
        content:
          "You are an expert business analyst. Extract core business offerings in clear, specific terms. Return ONLY valid JSON, no markdown or explanations.",
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

    const result = JSON.parse(jsonMatch[0]) as CoreOfferings;

    if (
      !result.whatBusinessSells ||
      !result.primaryOfferings ||
      !result.explicitStatement
    ) {
      throw new Error("LLM response missing required fields");
    }

    // Detect the business domain from extracted offerings
    const detectedDomain = detectDomainFromOfferings(
      result,
      businessType,
      businessDescription,
    );
    result.detectedDomain = detectedDomain;

    console.log("✅ Core offerings extraction completed");
    console.log(`   What business sells: ${result.whatBusinessSells}`);
    console.log(`   Primary offerings: ${result.primaryOfferings.join(", ")}`);
    console.log(
      `   Technologies: ${result.technologies?.join(", ") || "none extracted"}`,
    );
    console.log(
      `   Sub-topics: ${result.subTopics?.slice(0, 5).join(", ") || "none"}...`,
    );
    console.log(
      `   Tutorial ideas: ${
        result.practicalTutorialIdeas?.slice(0, 3).join(", ") || "none"
      }...`,
    );
    console.log(
      `   Competitors to avoid: ${result.competitorNames.join(", ") || "none"}`,
    );
    console.log(`   Detected domain: ${detectedDomain}`);

    return result;
  } catch (error: any) {
    console.error("❌ Core offerings extraction failed:", error);

    const fallbackOfferings: CoreOfferings = {
      whatBusinessSells: `${
        primaryServices.join(", ") || businessType || "services"
      }`,
      primaryOfferings: primaryServices.slice(0, 5),
      serviceTypes: primaryServices
        .map((s: string) => s.toLowerCase().split(" ")[0])
        .filter((service): service is string => Boolean(service))
        .slice(0, 3),
      targetCustomers: targetAudience || "General customers",
      explicitStatement: `${businessName} sells ${
        primaryServices.join(", ") || businessType || "services"
      } to ${targetAudience || "customers"}`,
      competitorNames: [],
      irrelevantTerms: [],
      technologies: [],
      subTopics: [],
      practicalTutorialIdeas: [],
      detectedDomain: "general",
    };

    console.log("⚠️ Using fallback core offerings");
    return fallbackOfferings;
  }
}
