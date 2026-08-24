import type { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  getGraphMaxToolRounds,
  getGraphRecursionLimit,
  getLLMForKeywords,
} from "../../config/llm.config";
import { shouldContinueWithGuards } from "../utils/graph-guard";
import { saveKeywordsToDb } from "./tools.keyword";

const tools: StructuredToolInterface[] = [saveKeywordsToDb];
const toolNode = new ToolNode(tools);

export const keywordLLM = getLLMForKeywords().bindTools(tools);

async function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
  return shouldContinueWithGuards(messages as AIMessage[], {
    workflowName: "missing-keyword-generation",
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
      content: `
      You are an expert SEO strategist. Your task is to generate REPLACEMENT keywords for deleted keywords, filling their exact calendar slots.

      CRITICAL REQUIREMENTS:
      1. **ONE replacement per deleted keyword** - Generate exactly ONE improved keyword for EACH deleted keyword provided
      2. **USE THE SAME DATE AND TIME** - Each replacement keyword MUST use the EXACT same publishDate and publishTime as the deleted keyword it replaces
      3. **IMPROVE THE KEYWORD** - Analyze the deleted keyword's intent and generate a better, more powerful, SEO-optimized long-tail keyword in the same content niche
      4. **FUTURE DATES ONLY** - Only process deleted keywords with future publishDate (already filtered, but double-check)

      ## Rules for Keyword Generation
        - Must be improved and better than the deleted keyword
        - Must be relevant and not out of context
        - Must target the same content niche and search intent
        - **KEYWORD FORMAT: Short, searchable noun phrases (2-5 words) - NOT blog post titles or long descriptive phrases**
        - **DO NOT generate full sentences, questions, or titles** - Generate short keyword phrases only
        - Long-tail means *more specific*, not *longer*
        - Suitable for ~1500–2000 words article coverage
        - More specific and SEO-optimized than the original

      ## Output Structure
        data: [
            {
                "keyword": "improved long-tail keyword phrase (2-5 words, not a title)",
                "publishDate": "SAME AS DELETED KEYWORD", // CRITICAL: Use exact same date
                "publishTime": "SAME AS DELETED KEYWORD", // CRITICAL: Use exact same time
                "keywordDiffculty": "estimated difficulty (0-100)",
                "keywordSearchVolumn": "estimated search volume",
                "userId": "userId provided"
            },
            // ... one entry for each deleted keyword
        ]

      ## Important
      1. Generate EXACTLY ONE replacement keyword for EACH deleted keyword provided
      2. Use the EXACT same publishDate and publishTime from the deleted keyword
      3. Make each replacement keyword better, more specific, and more SEO-optimized
      4. **Generate SHORT keyword phrases (2-5 words), NOT blog post titles or full sentences**
      5. All keywords must target the same business niche and help blogs rank
      6. Immediately call saveToDB tool with ALL replacement keywords in the exact structure above
      7. Do not include "json" - just pure output structure as array of objects

      **EXAMPLES of GOOD keywords:**
      - how to choose event venue
      - wedding venue capacity guide
      - corporate event planning tips
      - event venue decoration ideas

      **EXAMPLES of BAD keywords (DO NOT GENERATE):**
      - How to Choose the Perfect Event Venue for Your Special Occasion (this is a title, not a keyword)
      - What are the best wedding venues in Toronto? (this is a question, not a keyword)
      - Complete Guide to Corporate Event Planning and Management (this is too long, like a title)
      `,
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

export async function generateMissingKeywordLLM(
  keywords: string,
  userId: string,
) {
  const deletedKeywords = JSON.parse(keywords);

  if (!Array.isArray(deletedKeywords) || deletedKeywords.length === 0) {
    return "No deleted keywords provided for replacement.";
  }

  const keywordsInfo = deletedKeywords.map((kw: any) => ({
    deletedKeyword: kw.keyword,
    publishDate: kw.publishDate,
    publishTime: kw.publishTime,
    difficulty: kw.keywordDiffculty,
    searchVolume: kw.keywordSearchVolume,
  }));

  const response = await app.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Generate replacement keywords for these ${
            deletedKeywords.length
          } deleted keywords. Each replacement must use the EXACT same publishDate and publishTime as the deleted keyword it replaces. Make each replacement keyword better and more SEO-optimized.

Deleted Keywords:
${JSON.stringify(keywordsInfo, null, 2)}

UserId: ${userId}

Generate exactly ${
          deletedKeywords.length
        } replacement keyword(s), one for each deleted keyword, using their exact dates and times.`,
        },
      ],
    },
    {
      recursionLimit: getGraphRecursionLimit(),
    },
  );

  return response.messages[response.messages.length - 1]?.content;
}

export async function generateSingleMissingKeywordLLM(
  deletedKeyword: string,
  publishDate: string,
  publishTime: string,
  userId: string,
  userInstructions: string,
) {
  const deletedKw = JSON.parse(deletedKeyword);

  const response = await app.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Generate ONE replacement keyword for a deleted keyword. The replacement MUST use the EXACT same publishDate and publishTime as specified.

Deleted Keyword Information:
- Original Keyword: ${deletedKw.keyword || "N/A"}
- Publish Date: ${publishDate} (MUST USE THIS EXACT DATE)
- Publish Time: ${publishTime} (MUST USE THIS EXACT TIME)
- Original Difficulty: ${deletedKw.keywordDiffculty || "N/A"}
- Original Search Volume: ${deletedKw.keywordSearchVolume || "N/A"}

User Instructions:
${userInstructions}

CRITICAL REQUIREMENTS:
1. Generate exactly ONE improved, SEO-optimized long-tail KEYWORD (2-5 words, short phrase)
2. **DO NOT generate a blog post title, question, or full sentence** - Generate a short keyword phrase only
3. Use the EXACT publishDate: ${publishDate}
4. Use the EXACT publishTime: ${publishTime}
5. Follow the user's instructions closely
6. Make the keyword better, more specific, and more SEO-optimized than the original
7. Target the same content niche and search intent
8. Suitable for ~1500–2000 words article coverage

**KEYWORD FORMAT:**
- ✅ GOOD: "how to choose event venue" (short keyword phrase)
- ✅ GOOD: "wedding venue capacity guide" (short keyword phrase)
- ❌ BAD: "How to Choose the Perfect Event Venue for Your Special Occasion" (this is a title, not a keyword)
- ❌ BAD: "What are the best wedding venues?" (this is a question, not a keyword)

UserId: ${userId}

Generate the replacement keyword now (short phrase, 2-5 words, NOT a title or question).`,
        },
      ],
    },
    {
      recursionLimit: getGraphRecursionLimit(),
    },
  );

  return response.messages[response.messages.length - 1]?.content;
}
