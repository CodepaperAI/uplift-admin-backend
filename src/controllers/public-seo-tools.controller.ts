import type { Request, Response } from "express";
import { z } from "zod";
import { LLM_MODELS } from "../config/llm.config";
import {
  analyzeCanonicalTool,
  analyzeCrawlerTool,
  analyzeMetadataTool,
  analyzeRobotsTool,
  analyzeSitemapTool,
} from "../services/public-seo-tools.service";
import { getKeywordSuggestionsWithMetrics } from "../utils/dataforseo.utils";
import {
  applyPublicRateLimitHeaders,
  buildPublicRateLimitError,
  evaluatePublicRateLimit,
} from "../utils/public-rate-limit.utils";
import { guardUrl } from "../utils/ssrf-guard";

const CURRENT_YEAR = new Date().getFullYear();
const PUBLIC_TOOL_MODEL = LLM_MODELS.GPT5_MINI;
const BLOG_IDEAS_FALLBACK_MODEL = LLM_MODELS.GPT5_MINI;
const TOOL_RATE_LIMIT = 10;
const TOOL_RATE_WINDOW_MS = 3_600_000;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

type PublicToolCheck = {
  key: string;
  label: string;
  status: "pass" | "warning" | "fail" | "info";
  details: string;
  value?: string;
};

type PublicToolMetric = {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "critical";
};

type PublicToolRecommendation = {
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
};

type AiSource = {
  facts: Array<{ label: string; value: string }>;
  notes: string[];
};

type StructuredArrayOptions<T> = {
  prompt: string;
  repairHint: string;
  schema: z.ZodArray<z.ZodType<T>>;
  maxTokens: number;
  minimumCount: number;
  desiredCount?: number;
  fallbackModel?: string;
  userFailureMessage?: string;
  validateItem?: (item: T) => boolean;
};

type PublicToolGenerationErrorCode =
  | "invalid_ai_format"
  | "insufficient_valid_results"
  | "provider_failure"
  | "provider_unavailable";

export class PublicToolGenerationError extends Error {
  code: PublicToolGenerationErrorCode;
  userMessage: string;
  statusCode: number;

  constructor(params: {
    code: PublicToolGenerationErrorCode;
    message: string;
    userMessage: string;
    statusCode?: number;
  }) {
    super(params.message);
    this.name = "PublicToolGenerationError";
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.statusCode = params.statusCode ?? 500;
  }
}

const metaDescriptionSchema = z.object({
  text: z.string().min(1),
  approach: z.enum(["benefit", "question", "action"]),
});

const titleTagSchema = z.object({
  text: z.string().min(1),
  style: z.enum(["how-to", "list", "question", "benefit", "power-word"]),
});

const blogIdeaSchema = z.object({
  title: z.string().min(1),
  intent: z.enum(["informational", "commercial", "transactional", "how-to"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  description: z.string().min(1),
});

const altTextSchema = z.object({
  text: z.string().min(1),
  style: z.enum(["descriptive", "contextual", "seo-optimized"]),
});

const keywordSuggestionSchema = z.object({
  keyword: z.string().min(1),
  intent: z.enum(["informational", "commercial", "transactional", "navigational"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  volume: z.number().int().nonnegative(),
});

function getClientIp(req: Request): string {
  return (
    req.ip ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown"
  );
}

function enforceRateLimit(req: Request, res: Response, limit = TOOL_RATE_LIMIT): boolean {
  const rateLimit = evaluatePublicRateLimit({
    store: rateLimitMap,
    key: getClientIp(req),
    limit,
    windowMs: TOOL_RATE_WINDOW_MS,
  });

  applyPublicRateLimitHeaders(res, rateLimit);

  if (rateLimit.allowed) {
    return true;
  }

  res.status(429).json(
    buildPublicRateLimitError({
      scope: "public_tools",
      status: rateLimit,
      resourceLabel: "public SEO tool runs",
      actionLabel: "use the public tools again",
      windowLabel: "hour",
    }),
  );
  return false;
}

function normalizeUserUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2_048
  ) {
    return null;
  }

  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).toString();
  } catch {
    return null;
  }
}

async function validatedPublicToolUrl(
  req: Request,
  res: Response,
): Promise<string | null> {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).some((key) => key !== "url")
  ) {
    res.status(400).json({ success: false, message: "Invalid request" });
    return null;
  }
  const normalizedUrl = normalizeUserUrl(req.body.url);
  if (!normalizedUrl) {
    res.status(400).json({ success: false, message: "Invalid URL" });
    return null;
  }
  try {
    await guardUrl(normalizedUrl);
    return normalizedUrl;
  } catch {
    res.status(400).json({ success: false, message: "URL is not allowed" });
    return null;
  }
}

function extractJsonArray(rawText: string): unknown[] {
  const match = rawText.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error("AI returned invalid format");
  }

  return JSON.parse(match[0]);
}

function containsKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.trim().toLowerCase());
}

function hasCta(text: string): boolean {
  return /learn more|get started|discover|contact|try|explore|find out|start|book|schedule|request/i.test(
    text,
  );
}

async function callOpenAI(params: {
  prompt: string;
  maxTokens: number;
  model?: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new PublicToolGenerationError({
      code: "provider_unavailable",
      message: "OpenAI API key is not configured for public tool generation.",
      userMessage: "The AI writing service is not available right now. Please try again later.",
      statusCode: 503,
    });
  }

  let response: globalThis.Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.model ?? PUBLIC_TOOL_MODEL,
        max_completion_tokens: params.maxTokens,
        messages: [{ role: "user", content: params.prompt }],
      }),
    });
  } catch (error) {
    throw new PublicToolGenerationError({
      code: "provider_failure",
      message:
        error instanceof Error
          ? error.message
          : "OpenAI generation request failed before a response was returned.",
      userMessage:
        "The AI writing service is temporarily unavailable. Please try again in a moment.",
      statusCode: 503,
    });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("OpenAI generation failed:", errorBody);
    throw new PublicToolGenerationError({
      code: "provider_failure",
      message: errorBody || "OpenAI generation request failed.",
      userMessage:
        "The AI writing service is temporarily unavailable. Please try again in a moment.",
      statusCode: 503,
    });
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content.map((block: any) => block?.text || "").join("\n").trim()
    : "";
}

export async function generateStructuredArray<T>(
  options: StructuredArrayOptions<T>,
): Promise<T[]> {
  let lastError: Error | null = null;
  let previousResponse = "";
  let lastFailureCode: "invalid_ai_format" | "insufficient_valid_results" =
    "insufficient_valid_results";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? options.prompt
        : `${options.prompt}

Your previous response was invalid for this reason:
${lastError?.message || options.repairHint}

Previous response:
${previousResponse}

Return ONLY a valid JSON array that satisfies every rule.`;

    try {
      const rawText = await callOpenAI({
        prompt,
        maxTokens: options.maxTokens,
        model:
          attempt === 0 ? PUBLIC_TOOL_MODEL : options.fallbackModel ?? PUBLIC_TOOL_MODEL,
      });
      previousResponse = rawText;
      const parsed = options.schema.parse(extractJsonArray(rawText));
      const valid = options.validateItem
        ? parsed.filter((item) => options.validateItem!(item))
        : parsed;

      if (valid.length >= options.minimumCount) {
        return valid.slice(0, options.desiredCount ?? valid.length);
      }

      lastError = new Error(options.repairHint);
      lastFailureCode = "insufficient_valid_results";
    } catch (error: any) {
      if (error instanceof PublicToolGenerationError) {
        throw error;
      }

      lastFailureCode = "invalid_ai_format";
      lastError =
        error instanceof Error
          ? error
          : new Error(options.repairHint || "AI returned invalid JSON");
    }
  }

  throw new PublicToolGenerationError({
    code: lastFailureCode,
    message: lastError?.message || options.repairHint || "AI generation failed validation.",
    userMessage:
      options.userFailureMessage ||
      "We couldn't generate a strong enough set of suggestions right now. Please try again in a moment.",
    statusCode: 422,
  });
}

function sendPublicToolGenerationError(
  res: Response,
  error: unknown,
  logLabel: string,
  fallbackMessage: string,
) {
  console.error(logLabel, error);

  if (error instanceof PublicToolGenerationError) {
    return res.status(error.statusCode).json({
      success: false,
      errorCode: error.code,
      message: error.userMessage,
    });
  }

  return res.status(500).json({
    success: false,
    errorCode: "generation_failed",
    message: fallbackMessage,
  });
}

function summarizeChecks(checks: PublicToolCheck[]) {
  const failCount = checks.filter((check) => check.status === "fail").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const score = checks.length > 0 ? Math.round((passCount / checks.length) * 100) : null;

  if (failCount > 0) {
    return {
      status: "critical" as const,
      title: "Results need manual review",
      description: `${failCount} checks failed the deterministic validation rules.`,
      score,
    };
  }

  if (warningCount > 0) {
    return {
      status: "warning" as const,
      title: "Suggestions look usable with review",
      description: `${warningCount} checks are worth reviewing before publishing.`,
      score,
    };
  }

  return {
    status: "healthy" as const,
    title: "Suggestions passed validation",
    description: "The generated suggestions satisfied the rule checks we ran on them.",
    score,
  };
}

function buildRecommendations(checks: PublicToolCheck[]): PublicToolRecommendation[] {
  return checks
    .filter((check) => check.status !== "pass")
    .slice(0, 4)
    .map((check) => ({
      priority: check.status === "fail" ? "high" : "medium",
      title: check.label,
      description: check.details,
    }));
}

function buildAiEnvelope(params: {
  checks: PublicToolCheck[];
  metrics: PublicToolMetric[];
  source: AiSource;
  limitations: string[];
}) {
  return {
    summary: summarizeChecks(params.checks),
    metrics: params.metrics,
    checks: params.checks,
    recommendations: buildRecommendations(params.checks),
    source: params.source,
    limitations: params.limitations,
  };
}

function aiSourceFacts(label: string, notes: string[]): AiSource {
  return {
    facts: [
      { label: "Source", value: label },
      { label: "Validation", value: "Deterministic post-validation" },
    ],
    notes,
  };
}

function bucketDifficulty(score: number): "easy" | "medium" | "hard" {
  if (score < 34) {
    return "easy";
  }
  if (score < 67) {
    return "medium";
  }
  return "hard";
}

function inferKeywordIntent(keyword: string): "informational" | "commercial" | "transactional" | "navigational" {
  const value = keyword.toLowerCase();
  if (/how|what|why|guide|tips|ideas|examples|template|checklist/.test(value)) {
    return "informational";
  }
  if (/best|top|vs|alternative|review|compare/.test(value)) {
    return "commercial";
  }
  if (/near me|price|cost|services|agency|hire|buy|book|quote/.test(value)) {
    return "transactional";
  }
  return "informational";
}

function scoreMetaDescription(text: string, keyword: string) {
  const length = text.length;
  const keywordMatch = containsKeyword(text, keyword);
  const cta = hasCta(text);
  const reasons: string[] = [];
  let score = 0;

  if (length >= 120 && length <= 155) {
    score += 40;
    reasons.push("Length is in the ideal meta description range.");
  } else if (length >= 110 && length <= 160) {
    score += 25;
    reasons.push("Length is usable but outside the ideal sweet spot.");
  } else {
    reasons.push("Length is outside the recommended search snippet range.");
  }

  if (keywordMatch) {
    score += 30;
    reasons.push("Primary keyword is included.");
  } else {
    reasons.push("Primary keyword is missing.");
  }

  if (cta) {
    score += 20;
    reasons.push("Includes a clear CTA.");
  } else {
    reasons.push("CTA is weak or missing.");
  }

  if (text.includes("&amp;")) {
    reasons.push("Contains HTML entities that should be cleaned up.");
  } else {
    score += 10;
  }

  return {
    length,
    hasKeyword: keywordMatch,
    hasCta: cta,
    score,
    rating: score >= 80 ? "High" : score >= 55 ? "Medium" : "Low",
    reasons,
    valid: length >= 120 && length <= 155 && keywordMatch && cta && !text.includes("&amp;"),
  };
}

function scoreTitleTag(text: string, keyword: string) {
  const length = text.length;
  const hasKeyword = containsKeyword(text, keyword);
  const startsWithKeyword = text.toLowerCase().startsWith(keyword.toLowerCase());
  const hasPowerWord = /\b(expert|ultimate|proven|essential|complete|top)\b/i.test(text);
  const reasons: string[] = [];
  let score = 0;

  if (length >= 50 && length <= 60) {
    score += 40;
    reasons.push("Length is in the ideal title tag range.");
  } else {
    reasons.push("Title length is outside the recommended 50-60 character range.");
  }

  if (hasKeyword) {
    score += 30;
    reasons.push("Primary keyword is included.");
  } else {
    reasons.push("Primary keyword is missing.");
  }

  if (startsWithKeyword) {
    score += 15;
    reasons.push("Keyword is front-loaded.");
  }

  if (hasPowerWord) {
    score += 15;
    reasons.push("Contains a compelling modifier.");
  }

  return {
    length,
    hasKeyword,
    inRange: length >= 50 && length <= 60,
    score,
    rating: score >= 80 ? "Excellent" : score >= 55 ? "Good" : "Needs Work",
    reasons,
    valid: length >= 50 && length <= 60 && hasKeyword,
  };
}

function scoreAltText(text: string, keyword?: string) {
  const length = text.length;
  const hasKeyword = keyword ? containsKeyword(text, keyword) : false;
  const bannedPrefix = /^(image|photo|picture) of\b/i.test(text.trim());
  const descriptiveEnough = text.trim().split(/\s+/).length >= 6;
  const reasons: string[] = [];
  let score = 0;

  if (length >= 80 && length <= 125) {
    score += 40;
    reasons.push("Length is in the accessible SEO-friendly range.");
  } else {
    reasons.push("Length is outside the recommended 80-125 character range.");
  }

  if (descriptiveEnough) {
    score += 25;
    reasons.push("Description is specific enough to be useful.");
  } else {
    reasons.push("Description is too thin to be fully descriptive.");
  }

  if (!bannedPrefix) {
    score += 20;
  } else {
    reasons.push('Avoid starting alt text with "image of" or "photo of".');
  }

  if (keyword) {
    if (hasKeyword) {
      score += 15;
      reasons.push("Target keyword is included naturally.");
    } else {
      reasons.push("Target keyword is not included.");
    }
  }

  return {
    length,
    hasKeyword,
    inRange: length >= 80 && length <= 125,
    score,
    rating: score >= 80 ? "High" : score >= 55 ? "Medium" : "Low",
    reasons,
    valid: length >= 80 && length <= 125 && descriptiveEnough && !bannedPrefix,
  };
}

function scoreBlogIdea(item: z.infer<typeof blogIdeaSchema>) {
  const titleLength = item.title.length;
  const descriptionLength = item.description.length;
  let score = 0;

  if (titleLength >= 50 && titleLength <= 70) score += 40;
  if (descriptionLength >= 45) score += 35;
  if (item.intent) score += 15;
  if (item.difficulty) score += 10;

  return {
    score,
    rating: score >= 80 ? "Strong" : score >= 55 ? "Usable" : "Needs Review",
    valid: titleLength >= 50 && titleLength <= 70 && descriptionLength >= 45,
  };
}

export async function checkRobotsTxt(req: Request, res: Response) {
  const normalizedUrl = await validatedPublicToolUrl(req, res);
  if (!normalizedUrl) return;
  if (!enforceRateLimit(req, res)) {
    return;
  }

  return res.json({ success: true, data: await analyzeRobotsTool(normalizedUrl) });
}

export async function checkSitemap(req: Request, res: Response) {
  const normalizedUrl = await validatedPublicToolUrl(req, res);
  if (!normalizedUrl) return;
  if (!enforceRateLimit(req, res)) {
    return;
  }

  return res.json({ success: true, data: await analyzeSitemapTool(normalizedUrl) });
}

export async function checkCanonicalTag(req: Request, res: Response) {
  const normalizedUrl = await validatedPublicToolUrl(req, res);
  if (!normalizedUrl) return;
  if (!enforceRateLimit(req, res)) {
    return;
  }

  return res.json({ success: true, data: await analyzeCanonicalTool(normalizedUrl) });
}

export async function checkMetadata(req: Request, res: Response) {
  const normalizedUrl = await validatedPublicToolUrl(req, res);
  if (!normalizedUrl) return;
  if (!enforceRateLimit(req, res)) {
    return;
  }

  return res.json({ success: true, data: await analyzeMetadataTool(normalizedUrl) });
}

export async function simulateCrawler(req: Request, res: Response) {
  const normalizedUrl = await validatedPublicToolUrl(req, res);
  if (!normalizedUrl) return;
  if (!enforceRateLimit(req, res)) {
    return;
  }

  return res.json({ success: true, data: await analyzeCrawlerTool(normalizedUrl) });
}

export async function generateMetaDescriptions(req: Request, res: Response) {
  try {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
    const tone =
      typeof req.body?.tone === "string" &&
      ["professional", "casual", "urgent", "playful"].includes(req.body.tone)
        ? req.body.tone
        : "professional";

    if (!title || !keyword) {
      return res.status(400).json({
        success: false,
        message: "Title and keyword are required",
      });
    }
    if (!enforceRateLimit(req, res)) {
      return;
    }

    const descriptions = await generateStructuredArray({
      prompt: `You are an expert SEO copywriter. The current year is ${CURRENT_YEAR}. Generate exactly 3 meta descriptions.

Page title: ${title}
Primary keyword: ${keyword}
Tone: ${tone}

Rules:
1. Every description must be between 120 and 155 characters.
2. Include "${keyword}" naturally.
3. Include a clear CTA.
4. Use 3 different approaches: benefit, question, action.
5. No markdown, no commentary, no HTML entities.

Return ONLY valid JSON:
[{"text":"...","approach":"benefit"},{"text":"...","approach":"question"},{"text":"...","approach":"action"}]`,
      repairHint:
        "Each description must be 120-155 characters, include the primary keyword, include a CTA, and use one of the allowed approaches.",
      schema: z.array(metaDescriptionSchema),
      maxTokens: 600,
      minimumCount: 3,
      desiredCount: 3,
      userFailureMessage:
        "We couldn't generate a strong enough set of meta descriptions right now. Please try again in a moment.",
      validateItem: (item) => scoreMetaDescription(item.text, keyword).valid,
    });

    const scored = descriptions.map((item) => {
      const score = scoreMetaDescription(item.text, keyword);
      return {
        ...item,
        ...score,
      };
    });

    const avgLength = Math.round(
      scored.reduce((sum, item) => sum + item.length, 0) / scored.length,
    );
    const avgScore = Math.round(
      scored.reduce((sum, item) => sum + item.score, 0) / scored.length,
    );

    const checks: PublicToolCheck[] = [
      {
        key: "meta.count",
        label: "Required variations returned",
        status: scored.length >= 3 ? "pass" : "fail",
        details: `${scored.length} validated descriptions returned.`,
      },
      {
        key: "meta.length",
        label: "Length validation",
        status: scored.every((item) => item.length >= 120 && item.length <= 155)
          ? "pass"
          : "warning",
        details: "Every description should stay between 120 and 155 characters.",
      },
      {
        key: "meta.keyword",
        label: "Keyword coverage",
        status: scored.every((item) => item.hasKeyword) ? "pass" : "warning",
        details: `Keyword was included in ${scored.filter((item) => item.hasKeyword).length}/${scored.length} descriptions.`,
      },
      {
        key: "meta.cta",
        label: "CTA coverage",
        status: scored.every((item) => item.hasCta) ? "pass" : "warning",
        details: `CTA language detected in ${scored.filter((item) => item.hasCta).length}/${scored.length} descriptions.`,
      },
    ];

    const envelope = buildAiEnvelope({
      checks,
      metrics: [
        {
          label: "Validated options",
          value: String(scored.length),
          tone: "success",
        },
        {
          label: "Average length",
          value: `${avgLength} chars`,
          hint: "Aim for 120-155 characters.",
          tone: avgLength >= 120 && avgLength <= 155 ? "success" : "warning",
        },
        {
          label: "Average score",
          value: `${avgScore}/100`,
          tone: avgScore >= 75 ? "success" : avgScore >= 55 ? "warning" : "critical",
        },
      ],
      source: aiSourceFacts("OpenAI GPT-5 mini", [
        "These are AI-generated suggestions, not live search snippets.",
        "Each option was validated against length, keyword, and CTA rules before being returned.",
      ]),
      limitations: [
        "Always review final copy against the actual page content before publishing.",
      ],
    });

    return res.json({
      success: true,
      data: {
        descriptions: scored,
        stats: {
          avgLength,
          charOptimization:
            avgLength >= 120 && avgLength <= 155
              ? "Optimal"
              : avgLength < 120
                ? "Too Short"
                : "Too Long",
          potentialCtr: avgScore >= 75 ? "High" : avgScore >= 55 ? "Medium" : "Low",
          variations: scored.length,
        },
        ...envelope,
      },
    });
  } catch (error: any) {
    return sendPublicToolGenerationError(
      res,
      error,
      "Meta description generation error:",
      "We couldn't generate meta descriptions right now. Please try again.",
    );
  }
}

export async function generateTitleTags(req: Request, res: Response) {
  try {
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
    const brandName =
      typeof req.body?.brandName === "string" ? req.body.brandName.trim() : "";

    if (!topic || !keyword) {
      return res.status(400).json({
        success: false,
        message: "Topic and keyword are required",
      });
    }
    if (!enforceRateLimit(req, res)) {
      return;
    }

    const titles = await generateStructuredArray({
      prompt: `The current year is ${CURRENT_YEAR}. Generate exactly 5 SEO title tags.

Topic: ${topic}
Primary keyword: ${keyword}
${brandName ? `Brand name: ${brandName}` : ""}

Rules:
1. Each title must be 50-60 characters.
2. Include "${keyword}" naturally.
3. Use these styles exactly once each: how-to, list, question, benefit, power-word.
4. ${brandName ? `Use " | ${brandName}" only if it still fits within 60 characters.` : "No brand suffix is required."}
5. No markdown or commentary.

Return ONLY valid JSON:
[{"text":"...","style":"how-to"},{"text":"...","style":"list"},{"text":"...","style":"question"},{"text":"...","style":"benefit"},{"text":"...","style":"power-word"}]`,
      repairHint:
        "Every title must be 50-60 characters, include the primary keyword, and use one of the allowed styles.",
      schema: z.array(titleTagSchema),
      maxTokens: 700,
      minimumCount: 5,
      desiredCount: 5,
      userFailureMessage:
        "We couldn't generate a strong enough set of title tags right now. Please try again in a moment.",
      validateItem: (item) => scoreTitleTag(item.text, keyword).valid,
    });

    const scored = titles.map((item) => ({
      ...item,
      ...scoreTitleTag(item.text, keyword),
    }));

    const avgScore = Math.round(
      scored.reduce((sum, item) => sum + item.score, 0) / scored.length,
    );

    const checks: PublicToolCheck[] = [
      {
        key: "title.count",
        label: "Required variations returned",
        status: scored.length >= 5 ? "pass" : "fail",
        details: `${scored.length} validated title tags returned.`,
      },
      {
        key: "title.length",
        label: "Length validation",
        status: scored.every((item) => item.inRange) ? "pass" : "warning",
        details: "Every title should stay within 50-60 characters.",
      },
      {
        key: "title.keyword",
        label: "Keyword inclusion",
        status: scored.every((item) => item.hasKeyword) ? "pass" : "warning",
        details: `Keyword present in ${scored.filter((item) => item.hasKeyword).length}/${scored.length} titles.`,
      },
    ];

    const envelope = buildAiEnvelope({
      checks,
      metrics: [
        {
          label: "Validated titles",
          value: String(scored.length),
          tone: "success",
        },
        {
          label: "Average score",
          value: `${avgScore}/100`,
          tone: avgScore >= 75 ? "success" : avgScore >= 55 ? "warning" : "critical",
        },
      ],
      source: aiSourceFacts("OpenAI GPT-5 mini", [
        "These are AI-generated suggestions and should be reviewed against the final SERP context.",
      ]),
      limitations: [
        "SERP truncation can still vary by device and query context even for titles in range.",
      ],
    });

    return res.json({
      success: true,
      data: {
        titles: scored,
        ...envelope,
      },
    });
  } catch (error: any) {
    return sendPublicToolGenerationError(
      res,
      error,
      "Title tag generation error:",
      "We couldn't generate title tags right now. Please try again.",
    );
  }
}

export async function generateBlogIdeas(req: Request, res: Response) {
  try {
    const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
    const industry = typeof req.body?.industry === "string" ? req.body.industry.trim() : "";

    if (!keyword || !industry) {
      return res.status(400).json({
        success: false,
        message: "Keyword and industry are required",
      });
    }
    if (!enforceRateLimit(req, res)) {
      return;
    }

    const ideas = await generateStructuredArray({
      prompt: `The current year is ${CURRENT_YEAR}. Generate exactly 10 blog post ideas.

Keyword/topic: ${keyword}
Industry: ${industry}

Rules:
1. Each title must be 52-66 characters and read like a real blog headline.
2. Allowed intents: informational, commercial, transactional, how-to.
3. Allowed difficulty values: easy, medium, hard.
4. Each description must be exactly one sentence and at least 45 characters.
5. Avoid near-duplicate angles or repetitive wording across the set.
6. Use specific, premium-quality phrasing that fits the industry and topic.
7. No markdown, no numbering, and no commentary.
8. Silently verify every item satisfies the rules before returning.

Return ONLY valid JSON:
[{"title":"...","intent":"informational","difficulty":"easy","description":"..."}]`,
      repairHint:
        "Each idea needs a 50-70 character title, one allowed intent, one allowed difficulty, and a useful one-sentence description.",
      schema: z.array(blogIdeaSchema),
      maxTokens: 1_800,
      minimumCount: 6,
      desiredCount: 10,
      fallbackModel: BLOG_IDEAS_FALLBACK_MODEL,
      userFailureMessage:
        "We couldn't generate a strong enough set of blog ideas for this topic right now. Try broadening or slightly rephrasing the topic, correcting any wording, or try again in a moment.",
      validateItem: (item) => scoreBlogIdea(item).valid,
    });

    const scored = ideas.map((item) => ({
      ...item,
      ...scoreBlogIdea(item),
    }));

    const checks: PublicToolCheck[] = [
      {
        key: "ideas.count",
        label: "Idea volume",
        status: scored.length >= 8 ? "pass" : "warning",
        details:
          scored.length >= 8
            ? `${scored.length} validated blog ideas returned.`
            : `${scored.length} validated blog ideas returned. A fuller set usually lands closer to 8-10 ideas.`,
      },
      {
        key: "ideas.title_range",
        label: "Title length consistency",
        status: scored.every((item) => item.valid) ? "pass" : "warning",
        details: "Titles should stay within 50-70 characters and descriptions should be specific enough to brief a writer.",
      },
    ];

    const envelope = buildAiEnvelope({
      checks,
      metrics: [
        {
          label: "Validated ideas",
          value: String(scored.length),
          tone: "success",
        },
        {
          label: "Commercial ideas",
          value: String(scored.filter((item) => item.intent === "commercial").length),
        },
        {
          label: "How-to ideas",
          value: String(scored.filter((item) => item.intent === "how-to").length),
        },
      ],
      source: aiSourceFacts("OpenAI GPT-5 mini", [
        "Use these as ideation prompts, then validate final search opportunity with live keyword data when possible.",
      ]),
      limitations: [
        "Difficulty labels here are AI-assisted estimates, not live SERP competition metrics.",
      ],
    });

    return res.json({
      success: true,
      data: {
        ideas: scored,
        ...envelope,
      },
    });
  } catch (error: any) {
    return sendPublicToolGenerationError(
      res,
      error,
      "Blog ideas generation error:",
      "We couldn't generate blog ideas right now. Please try again.",
    );
  }
}

export async function generateAltText(req: Request, res: Response) {
  try {
    const imageDescription =
      typeof req.body?.imageDescription === "string"
        ? req.body.imageDescription.trim()
        : "";
    const pageContext =
      typeof req.body?.pageContext === "string" ? req.body.pageContext.trim() : "";
    const keyword =
      typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";

    if (!imageDescription || !pageContext) {
      return res.status(400).json({
        success: false,
        message: "Image description and page context are required",
      });
    }
    if (!enforceRateLimit(req, res)) {
      return;
    }

    const altTexts = await generateStructuredArray({
      prompt: `The current year is ${CURRENT_YEAR}. Generate exactly 3 alt text variations.

Image description: ${imageDescription}
Page context: ${pageContext}
${keyword ? `Target keyword: ${keyword}` : ""}

Rules:
1. Each alt text must be 80-125 characters.
2. Do not start with "image of", "photo of", or "picture of".
3. Use these styles exactly once each: descriptive, contextual, seo-optimized.
4. Keep the wording specific and screen-reader friendly.
5. No markdown or commentary.

Return ONLY valid JSON:
[{"text":"...","style":"descriptive"},{"text":"...","style":"contextual"},{"text":"...","style":"seo-optimized"}]`,
      repairHint:
        "Each alt text must be 80-125 characters, descriptive, and avoid the banned prefixes.",
      schema: z.array(altTextSchema),
      maxTokens: 600,
      minimumCount: 3,
      desiredCount: 3,
      userFailureMessage:
        "We couldn't generate a strong enough set of alt text suggestions right now. Please try again in a moment.",
      validateItem: (item) => scoreAltText(item.text, keyword || undefined).valid,
    });

    const scored = altTexts.map((item) => ({
      ...item,
      ...scoreAltText(item.text, keyword || undefined),
    }));

    const keywordCoverage =
      keyword.length > 0
        ? scored.filter((item) => item.hasKeyword).length
        : 0;

    const checks: PublicToolCheck[] = [
      {
        key: "alt.count",
        label: "Required variations returned",
        status: scored.length >= 3 ? "pass" : "fail",
        details: `${scored.length} validated alt text suggestions returned.`,
      },
      {
        key: "alt.length",
        label: "Length validation",
        status: scored.every((item) => item.inRange) ? "pass" : "warning",
        details: "Every alt text should stay within 80-125 characters.",
      },
      {
        key: "alt.keyword",
        label: "Keyword coverage",
        status:
          keyword.length === 0 || keywordCoverage >= 2 ? "pass" : "warning",
        details:
          keyword.length === 0
            ? "No target keyword was supplied."
            : `Keyword appears in ${keywordCoverage}/${scored.length} variations.`,
      },
    ];

    const envelope = buildAiEnvelope({
      checks,
      metrics: [
        {
          label: "Validated options",
          value: String(scored.length),
          tone: "success",
        },
        {
          label: "Keyword coverage",
          value:
            keyword.length === 0
              ? "N/A"
              : `${keywordCoverage}/${scored.length}`,
          tone:
            keyword.length === 0
              ? "default"
              : keywordCoverage >= 2
                ? "success"
                : "warning",
        },
      ],
      source: aiSourceFacts("OpenAI GPT-5 mini", [
        "These are AI-generated accessibility suggestions and should be reviewed against the actual image before publishing.",
      ]),
      limitations: [
        "Alt text should reflect the real visual content, not only the target keyword strategy.",
      ],
    });

    return res.json({
      success: true,
      data: {
        altTexts: scored,
        ...envelope,
      },
    });
  } catch (error: any) {
    return sendPublicToolGenerationError(
      res,
      error,
      "Alt text generation error:",
      "We couldn't generate alt text suggestions right now. Please try again.",
    );
  }
}

export async function generateKeywordSuggestions(req: Request, res: Response) {
  try {
    const keyword = typeof req.body?.keyword === "string" ? req.body.keyword.trim() : "";
    const industry = typeof req.body?.industry === "string" ? req.body.industry.trim() : "";

    if (!keyword) {
      return res.status(400).json({
        success: false,
        message: "Keyword is required",
      });
    }
    if (!enforceRateLimit(req, res)) {
      return;
    }

    const seedKeywords = [keyword, industry ? `${keyword} ${industry}` : null].filter(
      Boolean,
    ) as string[];

    const liveSuggestions = await getKeywordSuggestionsWithMetrics(
      seedKeywords,
      undefined,
      "en",
      30,
    );

    if (liveSuggestions.length > 0) {
      const keywords = liveSuggestions
        .map((item) => ({
          keyword: item.keyword,
          intent: inferKeywordIntent(item.keyword),
          difficulty: bucketDifficulty(item.difficulty),
          difficultyScore: item.difficulty,
          volume: item.searchVolume,
          source: "dataforseo" as const,
          confidence: "high" as const,
          cpc: item.cpc,
          competition: item.competition,
          ctr: item.ctr,
        }))
        .filter((item, index, array) => array.findIndex((entry) => entry.keyword === item.keyword) === index)
        .slice(0, 20);

      const checks: PublicToolCheck[] = [
        {
          key: "keywords.live_data",
          label: "Live keyword metrics",
          status: "pass",
          details: "Search volume and competition came from DataForSEO.",
        },
        {
          key: "keywords.intent_mix",
          label: "Intent coverage",
          status:
            new Set(keywords.map((item) => item.intent)).size >= 2 ? "pass" : "warning",
          details: `Detected ${new Set(keywords.map((item) => item.intent)).size} intent type(s) across the returned suggestions.`,
        },
      ];

      const envelope = buildAiEnvelope({
        checks,
        metrics: [
          {
            label: "Keywords returned",
            value: String(keywords.length),
            tone: "success",
          },
          {
            label: "Average search volume",
            value: `${Math.round(
              keywords.reduce((sum, item) => sum + item.volume, 0) / keywords.length,
            ).toLocaleString()}`,
          },
          {
            label: "Source",
            value: "DataForSEO live metrics",
            tone: "success",
          },
        ],
        source: {
          facts: [
            { label: "Source", value: "DataForSEO" },
            { label: "Mode", value: "Live keyword metrics" },
          ],
          notes: [
            "Metrics are provider-backed and may still vary slightly from Google Ads UI snapshots.",
          ],
        },
        limitations: [
          "These metrics are keyword-level estimates and do not replace SERP-level competitive review.",
        ],
      });

      return res.json({
        success: true,
        data: {
          keywords,
          stats: {
            total: keywords.length,
            source: "dataforseo",
          },
          ...envelope,
        },
      });
    }

    const estimatedKeywords = await generateStructuredArray({
      prompt: `The current year is ${CURRENT_YEAR}. Generate exactly 20 SEO keyword suggestions.

Seed keyword: ${keyword}
${industry ? `Industry: ${industry}` : ""}

Rules:
1. Allowed intents: informational, commercial, transactional, navigational.
2. Allowed difficulty values: easy, medium, hard.
3. volume must be a realistic integer monthly estimate.
4. Return natural search queries, not labels or categories.
5. No markdown or commentary.

Return ONLY valid JSON:
[{"keyword":"...","intent":"informational","difficulty":"easy","volume":1000}]`,
      repairHint:
        "Each item must include a keyword, one allowed intent, one allowed difficulty, and an integer volume estimate.",
      schema: z.array(keywordSuggestionSchema),
      maxTokens: 1_500,
      minimumCount: 15,
      desiredCount: 20,
      userFailureMessage:
        "We couldn't generate a reliable fallback keyword set right now. Try a broader seed keyword or try again in a moment.",
      validateItem: (item) => item.keyword.length >= 3 && item.volume >= 0,
    });

    const keywords = estimatedKeywords
      .map((item) => ({
        ...item,
        source: "estimated" as const,
        confidence: "medium" as const,
        difficultyScore:
          item.difficulty === "easy" ? 25 : item.difficulty === "medium" ? 55 : 80,
      }))
      .slice(0, 20);

    const checks: PublicToolCheck[] = [
      {
        key: "keywords.live_data",
        label: "Live keyword metrics",
        status: "warning",
        details:
          "DataForSEO was unavailable, so these volumes and difficulty labels are AI-estimated.",
      },
      {
        key: "keywords.estimated_data",
        label: "Estimated fallback labels",
        status: "pass",
        details: "Each row is clearly marked as estimated so the UI can label it honestly.",
      },
    ];

    const envelope = buildAiEnvelope({
      checks,
      metrics: [
        {
          label: "Keywords returned",
          value: String(keywords.length),
          tone: "success",
        },
        {
          label: "Source",
          value: "AI-estimated fallback",
          tone: "warning",
        },
      ],
      source: {
        facts: [
          { label: "Source", value: "OpenAI GPT-5 mini" },
          { label: "Mode", value: "Estimated keyword ideas" },
        ],
        notes: [
          "DataForSEO was unavailable for this request, so the metrics are estimated rather than provider-backed.",
        ],
      },
      limitations: [
        "Treat estimated keyword volume and difficulty as directional only until live provider data is available.",
      ],
    });

    return res.json({
      success: true,
      data: {
        keywords,
        stats: {
          total: keywords.length,
          source: "estimated",
        },
        ...envelope,
      },
    });
  } catch (error: any) {
    return sendPublicToolGenerationError(
      res,
      error,
      "Keyword research error:",
      "We couldn't generate keyword ideas right now. Please try again.",
    );
  }
}
