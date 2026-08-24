import { getLLMForKeywords } from "../config/llm.config";
import { getKeywordSuggestionsWithMetrics } from "./dataforseo.utils";
import { getLocationCode } from "./location.utils";

export interface QuickKeyword {
  keyword: string;
  searchVolume: string;
  difficulty: string;
  currentRanking: string;
  expectedRanking: string;
}

interface KeywordWithRanking {
  keyword: string;
  searchVolume?: number;
  difficulty?: number;
  currentRanking: string;
  expectedRanking: string;
  reasoning?: string;
}

interface StrategicKeyword {
  keyword: string;
  intent: string;
  buyerStage: string;
  rationale: string;
  primaryService?: string;
}

function isAwkwardPhrasing(keyword: string): boolean {
  const lower = keyword.toLowerCase().trim();
  const words = lower.split(/\s+/);
  const seen = new Set<string>();

  for (const w of words) {
    if (seen.has(w)) return true;
    seen.add(w);
  }

  const last = words[words.length - 1];
  if (!last) return false;

  const rest = words.slice(0, -1).join(" ");
  if (rest.length > 0 && rest.includes(last)) return true;

  return false;
}

function normalizeCore(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/\b(website|web)s?\b/gi, "web")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .sort()
    .join(" ");
}

function deduplicateByCore(
  keywords: Array<{
    keyword: string;
    searchVolume?: number;
    difficulty?: number;
  }>,
): typeof keywords {
  const coreMap = new Map<string, (typeof keywords)[0]>();

  for (const kw of keywords) {
    const core = normalizeCore(kw.keyword);
    const existing = coreMap.get(core);

    if (!existing || (kw.searchVolume || 0) > (existing.searchVolume || 0)) {
      coreMap.set(core, kw);
    }
  }

  return Array.from(coreMap.values());
}

async function estimateMetricsWithAI(
  strategicKeywords: StrategicKeyword[],
  businessType: string,
  services: string[],
  locationContext: string,
  isLocalBusiness: boolean,
  llm: any,
): Promise<
  Array<{
    keyword: string;
    searchVolume: number;
    difficulty: number;
    intent: string;
    buyerStage: string;
    primaryService?: string;
    rationale: string;
  }>
> {
  const estimationPrompt = `You are an SEO expert. Estimate realistic search metrics for these blog topic keywords.

**BUSINESS CONTEXT:**
- Business Type: ${businessType}
- Services: ${services.join(", ")}
${locationContext ? `- Location: ${locationContext} (${isLocalBusiness ? "local" : "online"} business)` : ""}

**ESTIMATION GUIDELINES:**

**Search Volume (monthly):**
- Local business keywords: 20-500/mo typically
- Online/broad keywords: 100-5000/mo typically
- "How to" questions: 50-800/mo
- "What is" questions: 100-1000/mo
- "vs" comparisons: 80-600/mo
- Very specific: 20-150/mo
- Broad topics: 200-2000/mo

**Difficulty (0-100):**
- Very specific long-tail: 15-35%
- Informational "how to": 20-45%
- Local + service: 25-50%
- Commercial intent: 35-60%
- Broad competitive: 50-80%

**BE REALISTIC:**
- Don't overestimate volume
- Consider competition level
- Local businesses = lower volume, lower difficulty
- Niche topics = lower volume, lower difficulty
- Broad topics = higher volume, higher difficulty

**KEYWORDS TO ESTIMATE:**
${strategicKeywords.map((kw, i) => `${i + 1}. "${kw.keyword}" (${kw.intent}, ${kw.buyerStage} stage)`).join("\n")}

**OUTPUT FORMAT (JSON only):**
[
  {
    "keyword": "exact keyword from list",
    "searchVolume": 150,
    "difficulty": 35,
    "reasoning": "Brief explanation of estimates"
  }
]

Estimate realistic metrics for ALL keywords above.`;

  try {
    const response = await llm.invoke([
      { role: "user", content: estimationPrompt },
    ]);

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      console.warn(
        "⚠️ AI metric estimation failed to return JSON, using defaults",
      );
      return strategicKeywords.map((kw) => ({
        keyword: kw.keyword,
        searchVolume: isLocalBusiness ? 120 : 250,
        difficulty: 40,
        intent: kw.intent,
        buyerStage: kw.buyerStage,
        primaryService: kw.primaryService,
        rationale: kw.rationale,
      }));
    }

    const estimates = JSON.parse(jsonMatch[0]) as Array<{
      keyword: string;
      searchVolume: number;
      difficulty: number;
      reasoning?: string;
    }>;

    return strategicKeywords.map((stratKw) => {
      const estimate = estimates.find(
        (e) => e.keyword.toLowerCase() === stratKw.keyword.toLowerCase(),
      );

      return {
        keyword: stratKw.keyword,
        searchVolume: estimate?.searchVolume || (isLocalBusiness ? 120 : 250),
        difficulty: estimate?.difficulty || 40,
        intent: stratKw.intent,
        buyerStage: stratKw.buyerStage,
        primaryService: stratKw.primaryService,
        rationale: estimate?.reasoning || stratKw.rationale,
      };
    });
  } catch (error) {
    console.error("❌ AI metric estimation failed:", error);
    return strategicKeywords.map((kw) => ({
      keyword: kw.keyword,
      searchVolume: isLocalBusiness ? 120 : 250,
      difficulty: 40,
      intent: kw.intent,
      buyerStage: kw.buyerStage,
      primaryService: kw.primaryService,
      rationale: kw.rationale,
    }));
  }
}

export async function fetchQuickKeywordsForTrial(
  services: string[],
  businessType: string,
  businessCity?: string,
  businessCountry?: string,
): Promise<QuickKeyword[]> {
  console.log(
    `🔍 [Quick Keywords] AI-driven strategy (minimal filters) for ${businessType}, services: ${services.join(", ")}`,
  );

  const locationCode = getLocationCode(businessCountry, businessCity);
  const locationContext = businessCity
    ? `${businessCity}, ${businessCountry || ""}`
    : businessCountry || "";
  const isLocalBusiness = !!businessCity;

  const primaryServices = services.slice(0, 3);
  const allServices = services.join(", ");

  try {
    const llm = getLLMForKeywords();

    const strategyPrompt = `You are an expert SEO strategist specializing in ${businessType} businesses.

**BUSINESS CONTEXT:**
- Business Type: ${businessType}
- PRIMARY Services (focus here): ${primaryServices.join(", ")}
- All Services: ${allServices}
${locationContext ? `- Location: ${locationContext} (local business - location matters!)` : "- Scope: Online/Global (location doesn't matter)"}

**YOUR TASK:**
Generate 20-30 strategic keyword ideas that will help THIS SPECIFIC BUSINESS attract customers and rank on Google.

**CRITICAL INSTRUCTIONS:**

1. **PRIORITIZE PRIMARY SERVICES** (70% of keywords):
   Focus on: ${primaryServices.join(", ")}
   Only 30% of keywords for other services.

2. **BLOG TOPICS ONLY** (NOT service page keywords):
   ✅ GOOD: "how to choose a ${primaryServices[0]?.toLowerCase() || businessType.toLowerCase()}"
   ✅ GOOD: "${primaryServices[0]?.toLowerCase() || businessType.toLowerCase()} common mistakes to avoid"
   ✅ GOOD: "what to expect from ${businessType.toLowerCase()} consultation"
   ❌ BAD: "${primaryServices[0]?.toLowerCase() || businessType.toLowerCase()}" (just the service name)
   ❌ BAD: "best ${businessType.toLowerCase()} near me" (service page keyword)
   ❌ BAD: "${primaryServices[0]?.toLowerCase() || businessType.toLowerCase()} ${businessCity || ""}" (service page)

3. **THINK STRATEGICALLY** about buyer journey:
   - 40% Awareness stage: "how to", "what is", "guide to", "mistakes to avoid"
   - 40% Consideration stage: "vs", "comparison", "types of", "choosing", "cost factors"
   - 20% Decision stage: "consultation", "hiring", "working with", "expectations"

4. **BE SPECIFIC TO THIS BUSINESS**:
   - Use actual services they offer
   - Consider their location context
   - Think about their target customers' real questions
   - NO generic "best practices" or "trends 2023" topics

5. **NATURAL PHRASING**:
   - Keywords should sound like real Google searches
   - No awkward repetition (e.g., "web design web")
   - 2-8 words typically

**OUTPUT FORMAT:**
Return ONLY a JSON array of keyword objects:
[
  {
    "keyword": "how to choose an immigration lawyer in Canada",
    "intent": "educational",
    "buyerStage": "awareness", 
    "primaryService": "Immigration Lawyer",
    "rationale": "High-intent awareness keyword for primary service, location-specific"
  }
]

Generate 20-30 strategic keywords now. Focus 70% on primary services: ${primaryServices.join(", ")}

**BUSINESS CONTEXT:**
- Business Type: ${businessType}
- Services: ${services.join(", ")}
${locationContext ? `- Location: ${locationContext} (local business)` : "- Scope: Can serve customers anywhere (online/product business)"}

**YOUR TASK:**
Generate 15-20 strategic keyword ideas that will actually help this business attract customers. Think about:

1. **What problems do their customers need solved?**
2. **What questions are customers asking before they buy?**
3. **What alternatives or comparisons are they researching?**
4. **What educational content would build trust?**
5. **What specific services/features matter most?**

**KEYWORD STRATEGY RULES:**

✅ **DO Generate:**
- Problem-solving keywords (e.g., "how to choose ${services[0]}", "${businessType} mistakes to avoid")
- Comparison keywords (e.g., "${services[0]} vs [alternative]", "best ${businessType} for [use case]")
- Educational keywords (e.g., "${services[0]} best practices", "what to look for in ${businessType}")
- Service-specific keywords (e.g., "custom ${services[0]}", "${services[0]} for [target audience]")
- Decision-stage keywords (e.g., "hire ${businessType}", "${services[0]} cost factors")
${isLocalBusiness ? `- Local intent keywords (e.g., "${services[0]} ${businessCity}", "best ${businessType} near me")` : ""}

❌ **DO NOT Generate:**
- Generic single words (e.g., just "${businessType}")
- Near-duplicates with tiny variations
- Awkward redundant phrases (e.g., "web design web", "website design website")
- Keywords about OTHER businesses (competitors, suppliers, software for this industry)
- Pure location keywords with no service context

**DIVERSITY REQUIREMENTS:**
- Cover different buyer journey stages: Awareness (40%), Consideration (40%), Decision (20%)
- Mix intent types: Educational, Comparison, Service-specific, Problem-solving
- Each keyword should have a DISTINCT purpose and audience
${isLocalBusiness ? "- Include 2-3 location-aware keywords but ensure they mention services too" : ""}

**OUTPUT FORMAT:**
Return ONLY a JSON array of objects with: keyword, intent, buyerStage, rationale

Example:
[
  {
    "keyword": "how to choose a web design agency",
    "intent": "educational",
    "buyerStage": "awareness",
    "rationale": "Helps prospects in research phase, positions us as experts"
  },
  {
    "keyword": "custom software vs off-the-shelf",
    "intent": "comparison",
    "buyerStage": "consideration",
    "rationale": "Addresses key decision point, highlights our custom service value"
  }
]

Generate 15-20 strategic keywords now.`;

    console.log(
      "🧠 [Quick Keywords] Step 1: AI generating strategic keywords...",
    );
    const strategyResponse = await llm.invoke([
      { role: "user", content: strategyPrompt },
    ]);

    const strategyContent =
      typeof strategyResponse.content === "string"
        ? strategyResponse.content
        : JSON.stringify(strategyResponse.content);

    const strategyJsonMatch = strategyContent.match(/\[[\s\S]*\]/);
    if (!strategyJsonMatch) {
      console.warn(
        "⚠️ [Quick Keywords] AI strategy generation failed, falling back to DataForSEO-first",
      );
      return fallbackToDataForSEO(services, businessType, locationCode);
    }

    const strategicKeywords = JSON.parse(
      strategyJsonMatch[0],
    ) as StrategicKeyword[];
    console.log(
      `✅ [Quick Keywords] AI generated ${strategicKeywords.length} strategic keywords`,
    );

    const keywordsToValidate = strategicKeywords.map((k) => k.keyword);

    // 🚀 COMMENTED OUT: DataForSEO integration - using AI-only approach
    // console.log(
    //   "📊 [Quick Keywords] Step 2: Enriching keywords with DataForSEO (will fallback to AI if unavailable)...",
    // );

    // let enrichedKeywords: Array<{
    //   keyword: string;
    //   searchVolume: number;
    //   difficulty: number;
    //   intent: string;
    //   buyerStage: string;
    //   primaryService?: string;
    //   rationale: string;
    // }> = [];

    // let dataForSEOFailed = false;

    // try {
    //   for (const stratKw of strategicKeywords) {
    //     try {
    //       const metrics = await getKeywordSuggestionsWithMetrics(
    //         [stratKw.keyword],
    //         locationCode,
    //         "en",
    //         1,
    //       );

    //       if (metrics && metrics.length > 0 && metrics[0]) {
    //         enrichedKeywords.push({
    //           keyword: metrics[0].keyword || stratKw.keyword,
    //           searchVolume: metrics[0].searchVolume || 0,
    //           difficulty: metrics[0].difficulty || 50,
    //           intent: stratKw.intent,
    //           buyerStage: stratKw.buyerStage,
    //           primaryService: stratKw.primaryService,
    //           rationale: stratKw.rationale,
    //         });
    //       } else {
    //         console.warn(
    //           `⚠️ No DataForSEO data for "${stratKw.keyword}", will try alternatives`,
    //         );

    //         const seedWords = stratKw.keyword.split(" ").slice(0, 3);
    //         const alternatives = await getKeywordSuggestionsWithMetrics(
    //           seedWords,
    //           locationCode,
    //           "en",
    //           5,
    //         );

    //         if (alternatives && alternatives.length > 0) {
    //           for (const alt of alternatives.slice(0, 2)) {
    //             enrichedKeywords.push({
    //               keyword: alt.keyword,
    //               searchVolume: alt.searchVolume || 0,
    //               difficulty: alt.difficulty || 50,
    //               intent: stratKw.intent,
    //               buyerStage: stratKw.buyerStage,
    //               primaryService: stratKw.primaryService,
    //               rationale: `Alternative for "${stratKw.keyword}": ${stratKw.rationale}`,
    //             });
    //           }
    //         }
    //       }
    //     } catch (err) {
    //       console.warn(
    //         `⚠️ [Quick Keywords] Failed to enrich "${stratKw.keyword}":`,
    //         err,
    //       );
    //     }
    //   }

    //   console.log(
    //     `✅ [Quick Keywords] Enriched ${enrichedKeywords.length} keywords with real DataForSEO metrics`,
    //   );

    //   if (enrichedKeywords.length === 0) {
    //     console.warn(
    //       "⚠️ DataForSEO returned 0 keywords, will use AI-only fallback",
    //     );
    //     dataForSEOFailed = true;
    //   }
    // } catch (error) {
    //   console.warn(
    //     "⚠️ DataForSEO completely failed, using AI-only fallback:",
    //     error,
    //   );
    //   dataForSEOFailed = true;
    // }

    // if (dataForSEOFailed || enrichedKeywords.length === 0) {
    //   console.log(
    //     "🤖 [Quick Keywords] Step 2 (Fallback): Using AI to estimate metrics...",
    //   );
    //   enrichedKeywords = await estimateMetricsWithAI(
    //     strategicKeywords,
    //     businessType,
    //     services,
    //     locationContext,
    //     isLocalBusiness,
    //     llm,
    //   );
    //   console.log(
    //     `✅ [Quick Keywords] AI estimated metrics for ${enrichedKeywords.length} keywords`,
    //   );
    // }

    // 🤖 AI-ONLY MODE: Skip DataForSEO entirely, use AI to estimate metrics
    console.log(
      "🤖 [Quick Keywords] Step 2: Using AI to estimate metrics (DataForSEO disabled)...",
    );
    const enrichedKeywords = await estimateMetricsWithAI(
      strategicKeywords,
      businessType,
      services,
      locationContext,
      isLocalBusiness,
      llm,
    );
    console.log(
      `✅ [Quick Keywords] AI estimated metrics for ${enrichedKeywords.length} keywords`,
    );

    const minimalSafetyFiltered = enrichedKeywords.filter((kw) => {
      const wordCount = kw.keyword.split(" ").length;
      return kw.searchVolume >= 10 && wordCount >= 2 && wordCount <= 10;
    });

    console.log(
      `✅ [Quick Keywords] ${minimalSafetyFiltered.length} keywords passed minimal safety filters (volume ≥10, 2-10 words)`,
    );

    if (minimalSafetyFiltered.length === 0) {
      console.warn(
        "⚠️ No keywords passed safety filters, falling back to DataForSEO",
      );
      return fallbackToDataForSEO(services, businessType, locationCode);
    }

    console.log(
      "🔍 [Quick Keywords] Step 3: AI relevance filter (removing irrelevant keywords)...",
    );

    const relevancePrompt = `You are an expert SEO analyst. Filter keywords for a ${businessType} business.

**BUSINESS CONTEXT:**
- Business Type: ${businessType}
- Services Offered: ${allServices}
${locationContext ? `- Location: ${locationContext}` : ""}

**YOUR TASK:**
Review each keyword and determine if it's RELEVANT or IRRELEVANT to this business.

**RELEVANT means:**
- The keyword relates to the business's services or industry
- Someone searching this might become a customer
- It's about topics this business would write blog posts about

**IRRELEVANT means:**
- Sports, entertainment, celebrities, or completely unrelated industries
- The keyword has nothing to do with ${businessType} or ${allServices}
- It's clearly a data error or mismatch

**CRITICAL EXAMPLES TO REJECT:**
❌ "real madrid v barcelona" - Sports (NOT related to ${businessType})
❌ "amazon hiring" - Job listings (NOT related to ${businessType})
❌ "celebrity news" - Entertainment (NOT related to ${businessType})
❌ Any keyword about a different industry entirely

**KEYWORDS TO EVALUATE:**
${minimalSafetyFiltered.map((kw, i) => `${i + 1}. "${kw.keyword}" (${kw.searchVolume}/mo)`).join("\n")}

**OUTPUT FORMAT:**
Return ONLY a JSON array of RELEVANT keyword strings (nothing else):
["keyword1", "keyword2", "keyword3"]

Filter out ALL irrelevant keywords now. Only return keywords that actually relate to ${businessType} services.`;

    const relevanceResponse = await llm.invoke([
      { role: "user", content: relevancePrompt },
    ]);

    const relevanceContent =
      typeof relevanceResponse.content === "string"
        ? relevanceResponse.content
        : JSON.stringify(relevanceResponse.content);

    const relevanceJsonMatch = relevanceContent.match(/\[[\s\S]*?\]/);

    let relevantKeywordsList: string[] = [];
    if (relevanceJsonMatch) {
      try {
        relevantKeywordsList = JSON.parse(relevanceJsonMatch[0]) as string[];
      } catch (err) {
        console.warn(
          "⚠️ Failed to parse AI relevance response, using all keywords",
        );
        relevantKeywordsList = minimalSafetyFiltered.map((kw) => kw.keyword);
      }
    } else {
      console.warn("⚠️ AI relevance filter failed, using all keywords");
      relevantKeywordsList = minimalSafetyFiltered.map((kw) => kw.keyword);
    }

    const relevantKeywords = minimalSafetyFiltered.filter((kw) =>
      relevantKeywordsList.some(
        (rel) => rel.toLowerCase() === kw.keyword.toLowerCase(),
      ),
    );

    const rejectedCount =
      minimalSafetyFiltered.length - relevantKeywords.length;
    if (rejectedCount > 0) {
      console.log(
        `✅ [Quick Keywords] AI filtered out ${rejectedCount} irrelevant keywords`,
      );
      const rejected = minimalSafetyFiltered.filter(
        (kw) =>
          !relevantKeywordsList.some(
            (rel) => rel.toLowerCase() === kw.keyword.toLowerCase(),
          ),
      );
      rejected.slice(0, 5).forEach((kw) => {
        console.log(`   ❌ Rejected: "${kw.keyword}" (${kw.searchVolume}/mo)`);
      });
      if (rejected.length > 5) {
        console.log(`   ... and ${rejected.length - 5} more`);
      }
    }

    console.log(
      `✅ [Quick Keywords] ${relevantKeywords.length} relevant keywords remain`,
    );

    if (relevantKeywords.length < 5) {
      console.warn(
        `⚠️ Only ${relevantKeywords.length} relevant keywords found, supplementing with DataForSEO`,
      );
      const supplemental = await fallbackToDataForSEO(
        services,
        businessType,
        locationCode,
      );
      return supplemental.slice(0, 5);
    }

    console.log(
      "🎯 [Quick Keywords] Step 4: AI final selection (picking TOP 5)...",
    );

    const selectionPrompt = `You are an expert SEO strategist. Analyze these keyword candidates and select the TOP 5 that will drive the most valuable traffic for a ${businessType} business.

**BUSINESS CONTEXT:**
- Business Type: ${businessType}
- PRIMARY Services (prioritize these): ${primaryServices.join(", ")}
- All Services: ${allServices}
${locationContext ? `- Location: ${locationContext} (local business)` : "- Scope: Online/Global"}

**YOUR DECISION CRITERIA:**

1. **Customer Intent & Value** (Most Important)
   - Will searchers actually become customers?
   - Is this solving a real problem they have?
   - Does it match the business's PRIMARY services?

2. **Ranking Feasibility**
   - Can this business realistically rank given the difficulty?
   - For LOCAL businesses: Lower volume is OK if difficulty is low
   - For ONLINE businesses: Need decent volume to be worth it

3. **Search Volume vs. Difficulty Balance**
   - High volume + high difficulty: Only if VERY relevant
   - Medium volume + low difficulty: Great choice!
   - Low volume + low difficulty: Good for local businesses
   - Low volume + high difficulty: Usually skip (unless exceptional relevance)

4. **Keyword Quality**
   - Is it a natural Google search?
   - Is it a BLOG TOPIC (not a service page keyword)?
   - Will it be awkward or confusing?

5. **Portfolio Diversity**
   - Select 5 keywords with DIFFERENT purposes
   - Mix of buyer journey stages
   - NO near-duplicates (only ONE "immigration lawyer" style keyword)

**IMPORTANT: YOU DECIDE** what volume/difficulty thresholds make sense for THIS SPECIFIC BUSINESS.
- Don't follow rigid rules like "must be >100 volume" or "must be <50% difficulty"
- Use your judgment based on the business context
- A 30/mo keyword with 15% difficulty might be PERFECT for a local business
- A 5000/mo keyword with 80% difficulty might be WORTH IT if it's their core service

**CANDIDATES TO EVALUATE:**
(Note: These have already been filtered for relevance to ${businessType})
${relevantKeywords
  .map(
    (kw, i) =>
      `${i + 1}. "${kw.keyword}"
   - Volume: ${kw.searchVolume}/mo
   - Difficulty: ${kw.difficulty}%
   - Intent: ${kw.intent}
   - Stage: ${kw.buyerStage}
   ${kw.primaryService ? `- Service: ${kw.primaryService}` : ""}
   - Why AI suggested: ${kw.rationale}`,
  )
  .join("\n\n")}

**YOUR TASK:**
1. Evaluate each keyword considering ALL factors above
2. Select exactly 5 keywords that will be MOST VALUABLE for this business
3. For each, provide ranking predictions:
   - currentRanking: Always "Not ranked" (new businesses)
   - expectedRanking: Your realistic prediction in 3-6 months based on difficulty
     * 0-25%: "1-5" (Page 1, top)
     * 26-40%: "3-10" (Page 1)
     * 41-55%: "5-15" (Page 1-2)
     * 56-70%: "8-20" (Page 2-3)
     * 71-85%: "12-30" (Page 3-4)
4. Explain your reasoning for each choice

**OUTPUT FORMAT:**
Return ONLY a JSON array:
[
  {
    "keyword": "exact keyword from list above",
    "currentRanking": "Not ranked",
    "expectedRanking": "3-10",
    "reasoning": "Why you picked this - consider volume, difficulty, relevance, buyer intent"
  }
]

Select the 5 BEST keywords for this ${businessType} business now.`;

    const selectionResponse = await llm.invoke([
      { role: "user", content: selectionPrompt },
    ]);

    const selectionContent =
      typeof selectionResponse.content === "string"
        ? selectionResponse.content
        : JSON.stringify(selectionResponse.content);

    const selectionJsonMatch = selectionContent.match(/\[[\s\S]*\]/);
    if (!selectionJsonMatch) {
      console.warn("⚠️ AI selection failed, using top candidates by volume");
      const topFive = relevantKeywords
        .sort((a, b) => b.searchVolume - a.searchVolume)
        .slice(0, 5)
        .map((kw) => ({
          keyword: kw.keyword,
          searchVolume: String(kw.searchVolume),
          difficulty: String(kw.difficulty),
          currentRanking: "Not ranked",
          expectedRanking: getExpectedRanking(kw.difficulty),
        }));
      console.log(
        `✅ [Quick Keywords] Fallback: ${topFive.map((k) => k.keyword).join(", ")}`,
      );
      return topFive;
    }

    const selectedKeywords = JSON.parse(
      selectionJsonMatch[0],
    ) as KeywordWithRanking[];

    console.log(
      `\n🤖 [Quick Keywords] AI SELECTED ${selectedKeywords.length} KEYWORDS:\n`,
    );

    const result: QuickKeyword[] = [];
    const usedCores = new Set<string>();

    for (const selected of selectedKeywords) {
      const found = relevantKeywords.find(
        (kw) => kw.keyword.toLowerCase() === selected.keyword.toLowerCase(),
      );

      if (found) {
        const core = normalizeCore(found.keyword);
        if (usedCores.has(core)) {
          console.warn(
            `⚠️ [Quick Keywords] Skipping near-duplicate: "${found.keyword}"`,
          );
          continue;
        }

        usedCores.add(core);

        console.log(`\n✅ "${found.keyword}"`);
        console.log(
          `   📊 ${found.searchVolume}/mo, ${found.difficulty}% difficulty`,
        );
        console.log(`   🎯 ${found.buyerStage} stage, ${found.intent} intent`);
        if (selected.reasoning) {
          console.log(`   💡 AI reasoning: ${selected.reasoning}`);
        }

        result.push({
          keyword: found.keyword,
          searchVolume: String(found.searchVolume),
          difficulty: String(found.difficulty),
          currentRanking: selected.currentRanking || "Not ranked",
          expectedRanking:
            selected.expectedRanking || getExpectedRanking(found.difficulty),
        });
      } else {
        console.warn(
          `⚠️ AI selected "${selected.keyword}" but not found in candidates`,
        );
      }
    }

    if (result.length < 5) {
      console.warn(
        `⚠️ Only ${result.length} keywords selected, filling to 5...`,
      );
      for (const kw of relevantKeywords) {
        if (result.length >= 5) break;

        const core = normalizeCore(kw.keyword);
        if (usedCores.has(core)) continue;

        if (
          !result.find(
            (r) => r.keyword.toLowerCase() === kw.keyword.toLowerCase(),
          )
        ) {
          usedCores.add(core);
          console.log(
            `\n➕ Adding fallback: "${kw.keyword}" (${kw.searchVolume}/mo, ${kw.difficulty}%)`,
          );
          result.push({
            keyword: kw.keyword,
            searchVolume: String(kw.searchVolume),
            difficulty: String(kw.difficulty),
            currentRanking: "Not ranked",
            expectedRanking: getExpectedRanking(kw.difficulty),
          });
        }
      }
    }

    console.log(
      `\n✅ [Quick Keywords] FINAL 5 KEYWORDS: ${result.map((k) => k.keyword).join(", ")}\n`,
    );
    return result;
  } catch (error) {
    console.error("❌ [Quick Keywords] AI-first strategy failed:", error);
    return fallbackToDataForSEO(services, businessType, locationCode);
  }
}

async function fallbackToDataForSEO(
  services: string[],
  businessType: string,
  locationCode: number,
): Promise<QuickKeyword[]> {
  console.log("🔄 [Quick Keywords] Using DataForSEO fallback");

  const seedTerms = [...services.slice(0, 3), businessType].filter(Boolean);

  const dataForSEOKeywords = await getKeywordSuggestionsWithMetrics(
    seedTerms,
    locationCode,
    "en",
    30,
  );

  if (!dataForSEOKeywords || dataForSEOKeywords.length === 0) {
    return [];
  }

  const validKeywords = dataForSEOKeywords
    .filter((kw) => {
      const volume = kw.searchVolume || 0;
      const wordCount = kw.keyword.split(" ").length;
      return (
        volume >= 50 &&
        wordCount >= 2 &&
        wordCount <= 6 &&
        !isAwkwardPhrasing(kw.keyword)
      );
    })
    .sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0));

  const deduped = deduplicateByCore(validKeywords).slice(0, 5);

  return deduped.map((kw) => ({
    keyword: kw.keyword,
    searchVolume: String(kw.searchVolume || 0),
    difficulty: String(kw.difficulty || 50),
    currentRanking: "Not ranked",
    expectedRanking: getExpectedRanking(kw.difficulty || 50),
  }));
}

export function getExpectedRanking(difficulty: number): string {
  if (difficulty <= 25) {
    return "1-5";
  } else if (difficulty <= 40) {
    return "3-10";
  } else if (difficulty <= 55) {
    return "5-15";
  } else if (difficulty <= 70) {
    return "8-20";
  } else {
    return "12-30";
  }
}

export interface KeywordWithMetrics {
  keyword: string;
  searchVolume: string | number;
  difficulty: string | number;
}

export async function predictRankingsForKeywords(
  keywords: KeywordWithMetrics[],
  businessName: string,
): Promise<QuickKeyword[]> {
  if (keywords.length === 0) return [];

  const llm = getLLMForKeywords();

  const list = keywords
    .map(
      (kw, i) =>
        `${i + 1}. "${kw.keyword}" (${kw.searchVolume} monthly searches, ${kw.difficulty}% difficulty)`,
    )
    .join("\n");

  const prompt = `You are an SEO expert predicting ranking growth for ${businessName}.

For each keyword below, provide:
- currentRanking: "Not ranked" (new businesses typically don't rank yet)
- expectedRanking: Where this business can rank in 3-6 months. Be optimistic but realistic based on difficulty. Use a range like "3-5", "5-10", "8-20".

Guidelines by difficulty:
- 0-25%: expectedRanking "1-5"
- 26-40%: "3-10"
- 41-55%: "5-15"
- 56-70%: "8-20"
- 71-100%: "12-30"

Keywords:
${list}

Return ONLY a JSON array, one object per keyword in the same order, with keys: keyword, currentRanking, expectedRanking.
Example: [{"keyword":"commercial cleaning","currentRanking":"Not ranked","expectedRanking":"3-5"}, ...]`;

  try {
    const response = await llm.invoke([{ role: "user", content: prompt }]);
    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return keywords.map((kw) => {
        const d =
          typeof kw.difficulty === "string"
            ? parseInt(kw.difficulty, 10)
            : Number(kw.difficulty);
        const diff = Number.isFinite(d) ? d : 50;
        return {
          keyword: kw.keyword,
          searchVolume: String(kw.searchVolume ?? ""),
          difficulty: String(kw.difficulty ?? 50),
          currentRanking: "Not ranked",
          expectedRanking: getExpectedRanking(diff),
        };
      });
    }
    const parsed = JSON.parse(jsonMatch[0]) as KeywordWithRanking[];
    const result: QuickKeyword[] = [];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      if (!kw) continue;

      const d =
        typeof kw.difficulty === "string"
          ? parseInt(kw.difficulty, 10)
          : Number(kw.difficulty);
      const diff = Number.isFinite(d) ? d : 50;
      const selected = parsed[i];
      result.push({
        keyword: kw.keyword,
        searchVolume: String(kw.searchVolume ?? ""),
        difficulty: String(kw.difficulty ?? 50),
        currentRanking: selected?.currentRanking ?? "Not ranked",
        expectedRanking: selected?.expectedRanking ?? getExpectedRanking(diff),
      });
    }
    return result;
  } catch (err) {
    console.error(
      "❌ [predictRankingsForKeywords] LLM failed, using difficulty fallback:",
      err,
    );
    return keywords.map((kw) => {
      const d =
        typeof kw.difficulty === "string"
          ? parseInt(kw.difficulty, 10)
          : Number(kw.difficulty);
      const diff = Number.isFinite(d) ? d : 50;
      return {
        keyword: kw.keyword,
        searchVolume: String(kw.searchVolume ?? ""),
        difficulty: String(kw.difficulty ?? 50),
        currentRanking: "Not ranked",
        expectedRanking: getExpectedRanking(diff),
      };
    });
  }
}
