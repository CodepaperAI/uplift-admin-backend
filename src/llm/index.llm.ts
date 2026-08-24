import type { AIMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { LlmUsagePurpose } from "@prisma/client";
import { inspect } from "util";
import {
  getGraphMaxToolRounds,
  getGraphRecursionLimit,
  getLLMForOnboarding,
} from "../config/llm.config";
import {
  persistAnalyzedBusiness,
  type PersistAnalyzedBusinessResult,
} from "../services/onboarding-persistence.service";
import { recordLlmUsageFromLangChainMessages } from "../services/llm-usage.service";
import type { BusinessOnboardingFlow } from "../services/onboarding-state.service";
import {
  createStoreDataInDbTool,
  createOnboardingTools,
  extractOnboardingFailureResultFromText,
  extractWebsiteAnalysisFromText,
  extractWebsiteAnalysisFromToolCalls,
  extractPersistedBusinessResultFromText,
  getOnboardingCreateDefaults,
  type OnboardingToolContext,
} from "../tools/llm.tools";
import { shouldContinueWithGuards } from "./utils/graph-guard";

const ONBOARDING_SYSTEM_PROMPT = `You are an expert business analyst and website data extraction specialist with deep expertise in understanding business context, market positioning, and customer needs. Your task is to perform IN-DEPTH analysis of website content and extract comprehensive, detailed business information in a structured JSON format.

**ANALYSIS APPROACH - IN-DEPTH EXTRACTION:**
- Read and understand the ENTIRE website content, not just surface-level information
- Analyze the business narrative, messaging, and positioning throughout all pages
- Extract implicit information by understanding context, not just explicit statements
- Connect information across different sections to build a complete business picture
- Understand the business model, target audience, and value propositions deeply
- Extract keywords that are contextually relevant to the business, not just generic terms
- Analyze competitive positioning and unique differentiators comprehensively
- Extract detailed business information that will help generate accurate, useful content later

You need to include all the information mentioned in the JSON structure. You need to analyze the data IN DEPTH, VERY DEEPLY, and VERY CAREFULLY. Strictly follow the instructions and do not add any other information.

**WORKFLOW:**
1. First, call get-website-info tool to fetch compact onboarding website data for the fixed canonical website URL already supplied in context
2. Check if the response contains "chunked": true
3. If chunked=true:
   - Note the currentChunk and totalChunks values
   - Analyze the current markdown chunk
   - If currentChunk < totalChunks, call get-website-info again with chunk=currentChunk+1
   - Repeat until you have all chunks (currentChunk equals totalChunks)
   - Combine information from ALL markdown chunks into a single comprehensive JSON
4. If chunked=false:
   - Analyze the complete markdown content
   - Extract all information into the JSON structure
5. Use seoSignals for exact SEO/meta fields such as title, canonicalUrl, openGraph, twitterCard, schema, verification, favicon, and navigation when they are present
6. Call save-business-data-to-database tool with the complete JSON
7. Stop immediately when you receive "TASK_COMPLETE" response
8. If get-website-info returns a TASK_FAILED_NON_RETRYABLE payload, STOP immediately and do not call any more tools

**CRITICAL TOOL-CALL RULE:**
- Never return the final WEBSITE_ANALYSIS JSON as plain assistant text
- The final JSON is working data only and MUST be passed to save-business-data-to-database
- If you have enough information to write the final JSON, your next action must be calling save-business-data-to-database
- Returning raw JSON instead of calling save-business-data-to-database is a task failure
- Never invent alternate domains, www variants, sitemap URLs, robots.txt paths, /home URLs, or proxy URLs. The website URL is fixed by context and cannot be changed.

**CONTENT RULES:**
- content.markdown is the authoritative source for understanding the business, services, audience, positioning, and business narrative
- seoSignals contains deterministic SEO/meta data extracted by code; when present, copy those values exactly instead of inferring them from markdown
- Do not ask for or expect raw HTML. The tool already provides the relevant content and SEO fields in compact form

**CRITICAL - CHUNKED PROCESSING:**
- If you receive a response with "chunked": true, check currentChunk and totalChunks
- Keep calling get-website-info with the next chunk number until currentChunk equals totalChunks
- Process ALL markdown chunks before creating the final JSON
- Combine all information from all chunks - do not lose any data
- When merging arrays (keywords, services, etc.), combine unique values and remove duplicates
- If the same information appears in multiple chunks, use the most complete version
- Ensure all required fields are populated from any chunk

**REQUIRED JSON STRUCTURE:**

{
  "scrapedUrl": "https://example.com",
  "domain": "example.com",
  "userId": "REQUIRED - get from user message",
  "brandIdentity": {
    "name": "REQUIRED - extract from title, h1, or schema.org",
    "tagline": "Extract from meta description, hero section, or h2/h3 tags",
    "platform": "Detect from HTML comments, meta tags, or script src (WordPress, Shopify, etc.)",
    "logos": [
      {"type": "Header Logo", "url": "https://..."},
      {"type": "Favicon", "url": "https://..."}
    ],
    "favicon": "Extract from <link rel='icon'> or <link rel='shortcut icon'>"
  },
  "design": {
    "colors": [
      {"type": "Primary", "hex": "#000000", "source": "CSS variable name or class"}
    ],
    "fonts": [
      {"type": "Body", "family": "Arial, sans-serif", "weight": "400"}
    ]
  },
  "techStack": {
    "frontend": ["Detect from script tags, CSS frameworks"],
    "backend": ["Detect from HTML comments, meta tags"],
    "database": ["Infer or detect from platform"],
    "automation": ["Detect from analytics scripts"]
  },
  "coreServices": {
    "topLevel": ["REQUIRED - Extract from main navigation, services section, homepage features"],
    "subOfferings": ["Extract from services pages, features lists, benefits section"],
    "industryFocus": ["Extract from case studies, testimonials, industry mentions"]
  },
  "recognition": {
    "awards": ["Extract from awards section, testimonials, badges"],
    "partnerships": ["Extract from partners section, client logos, testimonials"]
  },
  "seo": {
    "title": "Use seoSignals.title exactly when present; otherwise infer from content",
    "metaDescription": "Use seoSignals.metaDescription exactly when present; otherwise infer from content",
    "canonicalUrl": "Use seoSignals.canonicalUrl exactly when present",
    "targetKeywords": ["CRITICAL: Extract MINIMUM 30 keywords from:"]
      - Meta keywords tag
      - H1, H2, H3 headings
      - Navigation menu items
      - Service/product names
      - Industry terms in content
      - Location-based terms
      - Long-tail keywords from body text
    ],
    "targetKeywordsWithType": ["CRITICAL: Categorize keywords as MUST_HAVE or NICE_TO_HAVE"]
      Array of objects: [{"keyword": "string", "keywordType": "MUST_HAVE" or "NICE_TO_HAVE"}]
     Total 30 keywords 10 must have and 20 nice to have according to the business
    ],
    "openGraph": "Use seoSignals.openGraph exactly when present",
    "twitterCard": "Use seoSignals.twitterCard exactly when present",
    "schema": "Use seoSignals.schema exactly when present",
    "verification": "Use seoSignals.verification exactly when present"
  },
  "competitiveAdvantages": ["CRITICAL: Extract what makes this business unique"]
    Extract from: value propositions, unique selling points, differentiators, "Why Choose Us" sections
    Benefits lists, testimonials highlighting strengths, technology advantages
    Service quality claims, experience mentions, certifications, partnerships, awards
    Look for what makes this business stand out compared to competitors
    MINIMUM 3-5 advantages - extract from website content, do not invent
  ],
  // Find the business competitors
  competitors: z.array(
            z.object({
              name: z.string("Competitor Name is required"),
              url: z.string("Competitor URL is required"),
            })
          ),
  ],
  "contactInfo": {
    "phone": "Extract from footer, contact page, schema.org, or text content",
    "email": "Extract from footer, contact page, schema.org, or mailto: links",
    "locations": [
      {"type": "Main Address", "address": "FULL address string - street, city, state, country, postal code"}
    ]
  },
  "socialMedia": [
    {"name": "Facebook", "url": "ONLY include if URL is found, omit if empty"},
    {"name": "LinkedIn", "url": "ONLY include if URL is found, omit if empty"}
  ],
  "navigation": [
    {"text": "Menu item text", "url": "Full URL"}
  ],
  "businessInfo": {
    "businessSummary": "CRITICAL: Extract comprehensive 2-3 paragraph business description. Combine information from: About Us page, homepage hero section, mission/vision statements, company descriptions, meta descriptions, and any 'Who We Are' sections. This should be a detailed, informative summary that explains what the business does, who they serve, and their core purpose. Extract from actual content, do not invent.",
    "businessGoals": ["Extract business objectives, mission statements, vision statements, and goals from mission/vision pages, About Us sections, company goals pages, and strategic objectives mentioned in content"],
    "targetAudience": "CRITICAL: Extract detailed description of target customers. Look for: customer personas, demographics mentioned, psychographics, target market descriptions, 'Who We Serve' sections, customer testimonials that reveal customer types, and any audience-specific content. Describe who the business serves, their characteristics, needs, and pain points.",
    "valuePropositions": ["Extract key value propositions and benefits. Look for: value proposition sections, benefits lists, feature highlights, 'Why Choose Us' sections, unique benefits, customer benefits, and what makes the business valuable to customers"],
    "businessModel": "Extract how the business operates: revenue model (subscription, one-time, commission, etc.), service delivery method, business approach, how they make money, and operational model. Look in About Us, How It Works sections, pricing pages, and service descriptions.",
    "customerPainPoints": ["Extract problems, challenges, or pain points the business solves. Look for: problem statements, pain point sections, customer testimonials mentioning problems solved, 'Problems We Solve' sections, and implicit problems addressed by services/products"],
    "uniqueSellingPoints": ["Extract detailed unique selling points beyond competitive advantages. Look for: proprietary methods, unique approaches, specific differentiators, exclusive features, and what makes this business truly unique in the market"],
    "pricingModel": "Extract pricing structure, pricing model, or pricing approach if mentioned. Look in pricing pages, service descriptions, and any pricing-related content.",
    "industryPositioning": "Extract how the business positions itself in the industry: market position, competitive positioning, industry leadership claims, market segment, and how they differentiate from competitors"
  }
}

**CRITICAL EXTRACTION REQUIREMENTS:**

1. **targetKeywords (MINIMUM 30 REQUIRED - CRITICAL FOR ACCURATE SEO):**
  - Extract 30+ contextually relevant keywords that accurately represent the business
  - MUST_HAVE keywords (10): Primary business terms, core services/products, main value propositions, essential industry terms
  - NICE_TO_HAVE keywords (20): Secondary services, related terms, long-tail variations, supporting keywords
  - Extract from: Meta keywords, H1-H6 headings, navigation menu, service/product names, industry terms in content, location-based terms, long-tail keywords from body text, value proposition keywords, customer pain point keywords
  - IMPORTANT: Keywords must be ACCURATE and RELEVANT to the actual business - analyze context deeply to ensure accuracy
  - If processing chunks, combine keywords from both chunks and remove duplicates

2. **targetKeywordsWithType (MINIMUM 30 REQUIRED - CRITICAL FOR ACCURATE SEO):**
    - Categorize keywords as MUST_HAVE or NICE_TO_HAVE based on business relevance and importance
    - MUST_HAVE (10): Core business keywords that are essential for SEO and accurately represent primary offerings
    - NICE_TO_HAVE (20): Supporting keywords that are relevant but secondary to core business focus
    - Analyze business context deeply to ensure accurate categorization - keywords must match what the business actually does
    - If processing chunks, combine keywords from both chunks and remove duplicates 

3. **competitiveAdvantages (MINIMUM 3-5 RECOMMENDED):**
  - Extract from value propositions, unique selling points, differentiators
  - Look for "Why Choose Us" sections, benefits lists, testimonials highlighting strengths
  - Identify technology advantages, service quality, experience, certifications, partnerships, awards
  - Extract what makes this business unique compared to competitors
  - If processing chunks, combine advantages from both chunks and remove duplicates
  - DO NOT invent advantages - only extract from actual website content
  - If no advantages found, use empty array []

4. **competitors (CRITICAL FOR FAST ONBOARDING - Extract if available):**
    - Based on the business type, services offered, and industry identified from the website
    - **PRIORITIZE LOCAL COMPETITORS FIRST** - If contactInfo.locations contains address information (city, state/province, country), prioritize finding competitors in the same geographic area
    - For local businesses (restaurants, law firms, event venues, local services): Find competitors in the same city/region first, then expand to national if needed
    - For online/SaaS businesses: Find competitors in the same industry regardless of location
    - Use your knowledge to identify 3-5 well-known, high-ranking competitors in the same field/industry and location (if applicable)
    - Focus on businesses that offer similar services/products and are established players in the market
    - DO NOT extract from website content (not all websites mention competitors)
    - DO NOT include the same website being analyzed - exclude any URLs matching the scrapedUrl domain
    - Each competitor must have: business name and full website URL (https://...)
    - **LOCATION PRIORITY**: If address is found (e.g., "Toronto, Ontario, Canada" or "New York, NY, USA"), prioritize local competitors in that city/region first
    - If you cannot identify competitors based on business type/industry/location, use empty array []
    - Examples: 
      * Local restaurant in Toronto -> Find other restaurants in Toronto first
      * Law firm in Mississauga -> Find other law firms in Mississauga/GTA first
      * SaaS tool -> Find other SaaS tools in that category (location less relevant)

5. **coreServices.topLevel (REQUIRED - MINIMUM 3):**
  - Extract from main navigation menu
  - Extract from homepage services section
  - Extract from "Our Services" or "What We Do" sections
  - Include all primary services offered
  - If processing chunks, combine services from both chunks and remove duplicates

6. **coreServices.subOfferings (MINIMUM 5 RECOMMENDED):**
  - Extract from features lists, benefits, capabilities
  - Extract from services detail pages
  - Include specific offerings under each top-level service
  - If processing chunks, combine offerings from both chunks and remove duplicates

7. **contactInfo.locations (REQUIRED if available):**
  - Extract FULL address: "Street Address, City, State/Province, Country, Postal Code"
  - Look in footer, contact page, schema.org LocalBusiness
  - Keep as single string - do not split into components
  - If found in both chunks, use the most complete version

8. **brandIdentity.name (REQUIRED):**
  - Priority: schema.org Organization > seoSignals.openGraph.site_name > seoSignals.title > h1 > meta
  - Usually found in the first chunk or seoSignals payload, but verify across all chunks

9. **businessInfo (CRITICAL - IN-DEPTH BUSINESS ANALYSIS):**
  - **businessSummary**: REQUIRED - Extract comprehensive 2-3 paragraph description. Read through About Us, homepage hero, mission statements, company descriptions. Combine information to create a detailed, informative summary. This is critical for understanding the business context for content generation.
  - **businessGoals**: Extract from mission/vision pages, About Us sections, company goals. Look for explicit goals and implicit objectives mentioned in content.
  - **targetAudience**: REQUIRED - Extract detailed audience description. Look for customer personas, demographics, psychographics, "Who We Serve" sections, testimonials revealing customer types. Describe who they serve, characteristics, needs, and pain points.
  - **valuePropositions**: Extract from value prop sections, benefits lists, feature highlights, "Why Choose Us" sections. Focus on what makes the business valuable to customers.
  - **businessModel**: Extract from About Us, "How It Works" sections, pricing pages, service descriptions. Understand revenue model, service delivery, operational approach.
  - **customerPainPoints**: Extract from problem statements, pain point sections, testimonials mentioning problems solved, "Problems We Solve" sections. Also infer from service/product descriptions.
  - **uniqueSellingPoints**: Extract proprietary methods, unique approaches, specific differentiators, exclusive features. Go beyond competitive advantages to find truly unique aspects.
  - **pricingModel**: Extract if mentioned in pricing pages, service descriptions, or pricing-related content.
  - **industryPositioning**: Extract from About Us, competitive positioning statements, industry leadership claims, market segment descriptions.
  - IMPORTANT: Analyze content IN-DEPTH to extract implicit information, not just explicit statements. Connect information across pages to build complete picture.

10. **For all optional fields:**
  - Extract if available, use empty array [] or empty string "" if not found
  - Do not omit fields - include them with appropriate values
  - If processing chunks, merge arrays from both chunks and remove duplicates
  - For businessInfo fields, combine information from all pages and sections to create comprehensive descriptions

**JSON OUTPUT RULES:**
- When calling save-business-data-to-database, pass a plain JSON object with no markdown, no code blocks, and no explanation
- Include userId exactly as provided in the user message
- All URLs must be absolute (include https://)
- All arrays must be arrays (use [] not null)
- Extract domain from scrapedUrl automatically

**IMPORTANT:**
- After calling save-business-data-to-database tool, when it returns "TASK_COMPLETE", STOP immediately
- Do not generate any final message or response
- The workflow ends when data is saved`;

export type ExecuteLLMInput = {
  websiteUrl: string;
  userId: string;
  correlationId?: string | null;
  onboardingFlow?: BusinessOnboardingFlow | null;
  preferredBusinessId?: string | null;
};

export class OnboardingLLMExecutionError extends Error {
  code: string;
  stage: string;
  details?: unknown;

  constructor(args: {
    code: string;
    stage: string;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "OnboardingLLMExecutionError";
    this.code = args.code;
    this.stage = args.stage;
    this.details = args.details;
  }
}

function createOnboardingWorkflow(context: OnboardingToolContext) {
  const tools = createOnboardingTools(context);
  const llm = getLLMForOnboarding().bindTools(tools, {
    parallel_tool_calls: false,
    strict: true,
  });
  const toolNode = new ToolNode(tools);

  async function shouldContinue({
    messages,
  }: typeof MessagesAnnotation.State) {
    return shouldContinueWithGuards(messages as AIMessage[], {
      workflowName: "website-analysis",
      maxToolRounds: getGraphMaxToolRounds(),
      duplicateToolCallLimit: 2,
      successMarkers: ["TASK_COMPLETE", "successfully saved"],
    });
  }

  async function callModel(state: typeof MessagesAnnotation.State) {
    const response = await llm.invoke([
      {
        role: "system",
        content: ONBOARDING_SYSTEM_PROMPT,
      },
      ...state.messages,
    ]);

    return { messages: [response] };
  }

  function shouldContinueAfterTool({
    messages,
  }: typeof MessagesAnnotation.State) {
    const lastMessage = messages[messages.length - 1];
    const persistedResult = extractPersistedBusinessResultFromText(
      lastMessage?.content,
    );
    const failureResult = extractOnboardingFailureResultFromText(
      lastMessage?.content,
    );

    if (persistedResult || failureResult) {
      return "__end__";
    }

    return "llm";
  }

  return new StateGraph(MessagesAnnotation)
    .addNode("llm", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "llm")
    .addConditionalEdges("tools", shouldContinueAfterTool)
    .addConditionalEdges("llm", shouldContinue)
    .compile();
}

function findPersistedBusinessResult(
  messages: Array<{ content?: unknown }>,
): PersistAnalyzedBusinessResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const result = extractPersistedBusinessResultFromText(message?.content);
    if (result) {
      return result;
    }
  }

  return null;
}

function findRecoverableWebsiteAnalysis(
  messages: Array<{ content?: unknown; tool_calls?: unknown }>,
  userId: string,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const toolCallAnalysis = extractWebsiteAnalysisFromToolCalls(
      message?.tool_calls,
      userId,
    );
    if (toolCallAnalysis) {
      return toolCallAnalysis;
    }

    const analysis = extractWebsiteAnalysisFromText(message?.content, userId);
    if (analysis) {
      return analysis;
    }
  }

  return null;
}

async function persistRecoveredAnalysisWithTool(
  context: OnboardingToolContext,
  recoveredAnalysis: unknown,
): Promise<PersistAnalyzedBusinessResult | null> {
  const storeDataTool = createStoreDataInDbTool(context);
  const toolResponse = await storeDataTool.invoke(recoveredAnalysis);

  return extractPersistedBusinessResultFromText(toolResponse);
}

export async function executeLLM(
  input: ExecuteLLMInput,
): Promise<PersistAnalyzedBusinessResult>;
export async function executeLLM(
  websiteUrl: string,
  userId: string,
  options?: Omit<ExecuteLLMInput, "websiteUrl" | "userId">,
): Promise<PersistAnalyzedBusinessResult>;
export async function executeLLM(
  inputOrWebsiteUrl: ExecuteLLMInput | string,
  maybeUserId?: string,
  maybeOptions?: Omit<ExecuteLLMInput, "websiteUrl" | "userId">,
): Promise<PersistAnalyzedBusinessResult> {
  const input =
    typeof inputOrWebsiteUrl === "string"
      ? {
          websiteUrl: inputOrWebsiteUrl,
          userId: maybeUserId as string,
          ...maybeOptions,
        }
      : inputOrWebsiteUrl;

  const app = createOnboardingWorkflow({
    userId: input.userId,
    websiteUrl: input.websiteUrl,
    correlationId: input.correlationId,
    onboardingFlow: input.onboardingFlow,
    preferredBusinessId: input.preferredBusinessId,
  });

  const response = await app.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Analyze this website: ${input.websiteUrl}. userId "${input.userId}"`,
        },
      ],
    },
    {
      recursionLimit: getGraphRecursionLimit(),
    },
  );

  let persistedResult = findPersistedBusinessResult(response.messages);
  const toolFailureResult = response.messages
    .map((message) => extractOnboardingFailureResultFromText(message?.content))
    .find((result) => result !== null);
  let fallbackPersistenceError: unknown = null;

  if (!persistedResult) {
    const recoveredAnalysis = findRecoverableWebsiteAnalysis(
      response.messages,
      input.userId,
    );

    if (recoveredAnalysis) {
      console.warn(
        "[OnboardingLLM] Missing explicit persistence confirmation; attempting fallback persistence from recovered analysis payload.",
        inspect(
          {
            websiteUrl: input.websiteUrl,
            userId: input.userId,
            correlationId: input.correlationId ?? null,
            scrapedUrl: recoveredAnalysis.scrapedUrl,
            keywordCount: recoveredAnalysis.seo?.targetKeywords?.length ?? 0,
          },
          { depth: null, colors: true },
        ),
      );

      try {
        persistedResult = await persistRecoveredAnalysisWithTool(
          {
            userId: input.userId,
            websiteUrl: input.websiteUrl,
            correlationId: input.correlationId,
            onboardingFlow: input.onboardingFlow,
            preferredBusinessId: input.preferredBusinessId,
          },
          recoveredAnalysis,
        );
      } catch (error) {
        console.warn(
          "[OnboardingLLM] Tool-based persistence recovery failed; falling back to direct persistence.",
          inspect(
            error instanceof Error
              ? { message: error.message, cause: error.cause }
              : { error: String(error) },
            { depth: null, colors: true },
          ),
        );
      }

      if (!persistedResult) {
        try {
          persistedResult = await persistAnalyzedBusiness({
            rawWebsiteAnalysis: recoveredAnalysis,
            userId: input.userId,
            preferredBusinessId: input.preferredBusinessId,
            correlationId: input.correlationId,
            onboardingFlow: input.onboardingFlow,
            createDefaults: getOnboardingCreateDefaults(input.onboardingFlow),
          });
        } catch (error) {
          fallbackPersistenceError = error;
        }
      }
    }
  }

  void recordLlmUsageFromLangChainMessages(response.messages, {
    purpose: LlmUsagePurpose.onboarding_llm,
    provider: "openai",
    userId: input.userId,
    businessId: persistedResult?.businessId ?? null,
    blogId: null,
    correlationId: input.correlationId ?? null,
  });

  console.log(
    "LLM Response:",
    inspect(response.messages[response.messages.length - 1]?.content, {
      depth: null,
      colors: true,
      maxArrayLength: null,
    }),
  );

  if (fallbackPersistenceError) {
    throw fallbackPersistenceError;
  }

  if (toolFailureResult) {
    throw new OnboardingLLMExecutionError({
      code: toolFailureResult.code,
      stage: toolFailureResult.stage,
      message: toolFailureResult.message,
      details: {
        websiteUrl: input.websiteUrl,
        userId: input.userId,
        correlationId: input.correlationId ?? null,
        failureDetails: toolFailureResult.details ?? null,
      },
    });
  }

  if (!persistedResult) {
    throw new OnboardingLLMExecutionError({
      code: "llm_persistence_not_confirmed",
      stage: "execute_llm",
      message:
        "LLM website analysis finished without a confirmed business persistence result.",
      details: {
        websiteUrl: input.websiteUrl,
        userId: input.userId,
        correlationId: input.correlationId ?? null,
      },
    });
  }

  return persistedResult;
}
