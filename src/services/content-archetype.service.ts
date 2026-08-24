import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";

export type ContentArchetype =
  | "complete-guide"
  | "how-to"
  | "listicle"
  | "comparison"
  | "service-page";

const CONTENT_ARCHETYPES = new Set<ContentArchetype>([
  "complete-guide",
  "how-to",
  "listicle",
  "comparison",
  "service-page",
]);

/** Normalize a persisted Plan.keywordInstructions value into a supported lock. */
export function normalizeContentArchetype(
  value: unknown,
): ContentArchetype | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as ContentArchetype;
  return CONTENT_ARCHETYPES.has(normalized) ? normalized : null;
}

export interface ArchetypeSelection {
  archetype: ContentArchetype;
  reasoning: string;
  wordCountRange: { min: number; max: number };
  targetWordCount: number;
  requiredSections: string[];
  schemaTypes: string[];
  visualRequirements: {
    featuredImage: string;
    bodyImages: number;
    imageTypes: string[];
  };
}

export interface SERPAnalysis {
  top10Results: Array<{
    title: string;
    url: string;
    wordCount?: number;
    structure?: string;
  }>;
  averageWordCount: number;
  commonSections: string[];
  contentGaps: string[];
  dominantFormat: "guide" | "list" | "how-to" | "service" | "mixed";
}

export class ContentArchetypeService {
  /**
   * Determine the best content archetype based on keyword, intent, and business context
   */
  determineArchetype(
    keyword: string,
    searchIntent: "informational" | "commercial" | "transactional" | "navigational",
    businessContext: BusinessContextAnalysis,
    serpAnalysis?: SERPAnalysis
  ): ArchetypeSelection {
    const keywordLower = keyword.toLowerCase();
    const isLocationDependent = businessContext.businessModel.isLocationDependent;
    const businessType = businessContext.businessModel.type;
    const b2bOrB2c = businessContext.market.industry.b2bOrB2c;
    const location = businessContext.market.geographic.primary;
    const locationLower = location?.toLowerCase().trim() || "";

    // PRIORITY 1: Service Page Archetype
    // For location-dependent service businesses with transactional/navigational intent
    if (
      isLocationDependent &&
      businessType === "service" &&
      (searchIntent === "transactional" || searchIntent === "navigational") &&
      ((locationLower.length > 0 && keywordLower.includes(locationLower)) ||
        keywordLower.includes("near me") ||
        keywordLower.match(/in \w+|local/))
    ) {
      return {
        archetype: "service-page",
        reasoning: `Service business with location-dependent model. Keyword "${keyword}" has ${searchIntent} intent and includes location context. Best suited for service landing page archetype.`,
        // Right-sized for genuinely-helpful content; padding is demoted. The
        // strategist may override this per the live SERP.
        wordCountRange: { min: 900, max: 1600 },
        targetWordCount: 1200,
        requiredSections: [
          "Hero Section",
          "Introduction",
          "Services Offered",
          "The Process",
          "Pricing",
          "Why Choose Us",
          "Service Area",
          "Testimonials",
          "FAQ",
          "Final CTA Section",
        ],
        schemaTypes: ["LocalBusiness", "Service", "FAQPage"],
        visualRequirements: {
          featuredImage: "Service photo or team photo",
          bodyImages: 2,
          imageTypes: ["service photos", "team photos", "project photos", "process diagram"],
        },
      };
    }

    // PRIORITY 2: How-to Archetype
    // For keywords with "how to", "tutorial", "step by step" patterns
    if (
      keywordLower.match(/how to|how-to|tutorial|step by step|guide to|learn to|teach/) ||
      searchIntent === "informational" &&
        (keywordLower.includes("how") || keywordLower.includes("tutorial"))
    ) {
      return {
        archetype: "how-to",
        reasoning: `Keyword "${keyword}" matches how-to pattern. Search intent is ${searchIntent}. Best suited for tutorial/how-to archetype.`,
        wordCountRange: { min: 1000, max: 1800 },
        targetWordCount: 1400,
        requiredSections: [
          "Introduction",
          "Before You Start (Prerequisites)",
          "Step-by-Step Process",
          "Troubleshooting",
          "Advanced Tips (Optional)",
          "FAQ",
          "Conclusion",
          "Additional Resources",
        ],
        schemaTypes: ["HowTo", "Article", "FAQPage"],
        visualRequirements: {
          featuredImage: "Process overview or result visualization",
          bodyImages: 2,
          imageTypes: ["screenshots", "step visuals", "before/after", "diagrams"],
        },
      };
    }

    // PRIORITY 3: Comparison Archetype
    // Keep a true two-or-more-option decision query distinct from a numbered
    // roundup. This prevents arbitrary "Top 7" titles for explicit comparisons.
    if (
      keywordLower.match(
        /\b(vs\.?|versus|compare|compared|comparison|difference between|which is better)\b/,
      )
    ) {
      return {
        archetype: "comparison",
        reasoning: `Keyword "${keyword}" promises an explicit comparison. Use a criteria-led comparison rather than inventing a numbered roundup.`,
        wordCountRange: { min: 1100, max: 1900 },
        targetWordCount: 1500,
        requiredSections: [
          "Direct Answer",
          "At-a-Glance Comparison Table",
          "Decision Criteria",
          "Option-by-Option Tradeoffs",
          "Which Option Fits Which Situation",
          "Limitations and Exclusions",
          "FAQ",
          "Next Step",
        ],
        schemaTypes: ["Article", "FAQPage"],
        visualRequirements: {
          featuredImage: "Balanced comparison visual",
          bodyImages: 2,
          imageTypes: ["comparison table", "decision diagram", "option visuals"],
        },
      };
    }

    // PRIORITY 4: Listicle Archetype
    // For genuine numbered lists, roundups, and best-of queries.
    if (
      keywordLower.match(/best|top \d+|list of|\d+ ways|\d+ tips|\d+ strategies|alternatives/) ||
      searchIntent === "commercial"
    ) {
      return {
        archetype: "listicle",
        reasoning: `Keyword "${keyword}" matches listicle/comparison pattern. Search intent is ${searchIntent}. Best suited for listicle/roundup archetype.`,
        wordCountRange: { min: 1100, max: 2000 },
        targetWordCount: 1500,
        requiredSections: [
          "Introduction",
          "Quick Comparison Table",
          "Our Top Pick",
          "Entry #2-10 (or more)",
          "How to Choose",
          "Buying Guide (Optional)",
          "FAQ",
          "Methodology",
          "Conclusion",
        ],
        schemaTypes: ["ItemList", "Article", "FAQPage"],
        visualRequirements: {
          featuredImage: "Comparison visual or top pick highlight",
          bodyImages: 2,
          imageTypes: ["one per entry", "comparison visuals", "screenshots", "product photos"],
        },
      };
    }

    // PRIORITY 5: Complete Guide Archetype (Default)
    // For broad informational keywords, B2B content, or comprehensive topics
    if (
      searchIntent === "informational" ||
      b2bOrB2c === "B2B" ||
      keywordLower.match(/complete guide|ultimate guide|comprehensive|everything about|what is|overview/)
    ) {
      return {
        archetype: "complete-guide",
        reasoning: `Keyword "${keyword}" is informational with ${searchIntent} intent. Business model is ${b2bOrB2c}. Best suited for comprehensive guide archetype.`,
        wordCountRange: { min: 1400, max: 2200 },
        targetWordCount: 1800,
        requiredSections: [
          "Above-Fold Section (Hook + TOC)",
          "What Is [Topic]?",
          "Why [Topic] Matters",
          "How [Topic] Works",
          "Types/Methods/Approaches",
          "Best Practices",
          "Tools/Resources",
          "Verified Examples or Clearly Labelled Decision Scenarios",
          "FAQ",
          "Conclusion",
        ],
        schemaTypes: ["Article", "FAQPage"],
        visualRequirements: {
          featuredImage: "Main topic in full context",
          bodyImages: 2,
          imageTypes: ["infographics", "diagrams", "process visuals", "data charts"],
        },
      };
    }

    // FALLBACK: Complete Guide (safest default)
    return {
      archetype: "complete-guide",
      reasoning: `Default to complete guide archetype for keyword "${keyword}" with ${searchIntent} intent.`,
      wordCountRange: { min: 1200, max: 2200 },
      targetWordCount: 1600,
      requiredSections: [
        "Above-Fold Section",
        "What Is [Topic]?",
        "Why [Topic] Matters",
        "How [Topic] Works",
        "Types/Methods",
        "Best Practices",
        "Tools/Resources",
        "Verified Examples or Clearly Labelled Decision Scenarios",
        "FAQ",
        "Conclusion",
      ],
      schemaTypes: ["Article", "FAQPage"],
      visualRequirements: {
        featuredImage: "Main topic overview",
        bodyImages: 2,
        imageTypes: ["infographics", "diagrams", "visuals"],
      },
    };
  }

  /**
   * Generate Skyscraper strategy based on SERP analysis
   */
  generateSkyscraperStrategy(
    serpAnalysis: SERPAnalysis,
    selectedArchetype: ContentArchetype
  ): {
    moreComprehensive: string[];
    moreCurrent: string[];
    moreVisual: string[];
    moreActionable: string[];
    uniqueAngle: string;
  } {
    const strategy = {
      moreComprehensive: [] as string[],
      moreCurrent: [] as string[],
      moreVisual: [] as string[],
      moreActionable: [] as string[],
      uniqueAngle: "",
    };

    // Analyze gaps
    const coveredSections = new Set(serpAnalysis.commonSections);
    const missingSections = serpAnalysis.contentGaps;

    // More Comprehensive
    strategy.moreComprehensive = [
      `Cover ${missingSections.length > 0 ? missingSections.join(", ") : "additional subtopics"} that competitors miss`,
      `Add more examples (aim for ${serpAnalysis.top10Results.length + 5} examples vs competitor average)`,
      `Include deeper technical detail where competitors are surface-level`,
      `Add case studies (competitors have ${serpAnalysis.top10Results.filter((r) => r.structure?.includes("case")).length} case studies - add more)`,
    ];

    // More Current
    strategy.moreCurrent = [
      `Update with ${new Date().getFullYear()} data and statistics`,
      `Include latest developments and trends`,
      `Reference recent examples (last 6 months)`,
      `Update outdated information from competitors`,
    ];

    // More Visual
    strategy.moreVisual = [
      `Create custom infographics (competitors average ${Math.round(serpAnalysis.averageWordCount / 500)} images - add more)`,
      `Add interactive elements (diagrams, charts, before/after sliders)`,
      `Include video embeds if relevant`,
      `Use high-quality, branded visuals`,
    ];

    // More Actionable
    strategy.moreActionable = [
      `Provide step-by-step instructions (${selectedArchetype === "how-to" ? "detailed" : "clear"} steps)`,
      `Include downloadable templates/checklists`,
      `Add tool recommendations with links`,
      `Create actionable takeaways in each section`,
    ];

    // Unique Angle
    strategy.uniqueAngle = `Combine ${selectedArchetype} format with ${serpAnalysis.dominantFormat !== selectedArchetype ? serpAnalysis.dominantFormat : "enhanced"} elements to stand out. Focus on ${missingSections.length > 0 ? missingSections[0] : "practical application"} that competitors overlook.`;

    return strategy;
  }

  /**
   * Get archetype-specific content brief template
   */
  getContentBrief(
    keyword: string,
    archetypeSelection: ArchetypeSelection,
    businessContext: BusinessContextAnalysis,
    skyscraperStrategy?: {
      moreComprehensive: string[];
      moreCurrent: string[];
      moreVisual: string[];
      moreActionable: string[];
      uniqueAngle: string;
    }
  ): string {
    const brief = `
# CONTENT BRIEF: ${keyword}

## 1. INTENT ANALYSIS
Primary Intent: ${this.getIntentFromKeyword(keyword)}
Confidence: High
User Goal: ${this.getUserGoal(keyword, archetypeSelection.archetype)}
Buyer Stage: ${this.getBuyerStage(archetypeSelection.archetype)}

## 2. ARCHETYPE SELECTION
Content Type: ${archetypeSelection.archetype}
Reasoning: ${archetypeSelection.reasoning}

## 3. COMPETITIVE ANALYSIS
Target Word Count: ${archetypeSelection.targetWordCount} words (range: ${archetypeSelection.wordCountRange.min}-${archetypeSelection.wordCountRange.max})
Required Sections: ${archetypeSelection.requiredSections.join(", ")}

## 4. SKYSCRAPER STRATEGY
${skyscraperStrategy ? `
MORE COMPREHENSIVE:
${skyscraperStrategy.moreComprehensive.map((s) => `- ${s}`).join("\n")}

MORE CURRENT:
${skyscraperStrategy.moreCurrent.map((s) => `- ${s}`).join("\n")}

MORE VISUAL:
${skyscraperStrategy.moreVisual.map((s) => `- ${s}`).join("\n")}

MORE ACTIONABLE:
${skyscraperStrategy.moreActionable.map((s) => `- ${s}`).join("\n")}

UNIQUE ANGLE: ${skyscraperStrategy.uniqueAngle}
` : "SERP analysis not available - use standard best practices"}

## 5. CONTENT OUTLINE
[Full H1/H2/H3 structure based on ${archetypeSelection.archetype} template]

## 6. SEO REQUIREMENTS
Target Word Count: ${archetypeSelection.targetWordCount} words
Primary Keyword: ${keyword}
Schema Types: ${archetypeSelection.schemaTypes.join(", ")}
Visual Requirements: ${archetypeSelection.visualRequirements.bodyImages} body images + 1 featured image

## 7. BUSINESS CONTEXT
Business Type: ${businessContext.businessModel.type}
Location Dependent: ${businessContext.businessModel.isLocationDependent}
B2B/B2C: ${businessContext.market.industry.b2bOrB2c}
Industry: ${businessContext.market.industry.vertical}
Target Audience: ${businessContext.market.customerSegment.primary}
`;

    return brief;
  }

  private getIntentFromKeyword(keyword: string): string {
    const lower = keyword.toLowerCase();
    if (lower.match(/how to|how-to|what is|why|guide|learn/)) return "Informational";
    if (lower.match(/best|top|review|compare|vs|alternative/)) return "Commercial";
    if (lower.match(/buy|price|cost|hire|book|order|near me/)) return "Transactional";
    return "Informational";
  }

  private getUserGoal(keyword: string, archetype: ContentArchetype): string {
    if (archetype === "how-to") return "Learn how to accomplish a specific task";
    if (archetype === "listicle") return "Compare options and make a decision";
    if (archetype === "comparison") return "Compare explicit options using clear decision criteria";
    if (archetype === "service-page") return "Find and hire a service provider";
    return "Understand a topic comprehensively";
  }

  private getBuyerStage(archetype: ContentArchetype): string {
    if (archetype === "service-page") return "Decision";
    if (archetype === "listicle" || archetype === "comparison") return "Consideration";
    return "Awareness";
  }
}
