import { z } from "zod";
import { LlmUsagePurpose } from "@prisma/client";
import {
  getLLMForSeoAudit,
  SEO_AUDIT_MODEL_NAME,
} from "../config/llm.config";
import { recordLlmUsageFromLangChainMessage } from "./llm-usage.service";
import { SEO_AUDIT_RELIABILITY_V2_ENABLED } from "../config/feature-flags";
import {
  fetchWithScraperAPI,
  discoverSitemapUrl,
  fetchSitemapUrls,
} from "../utils/tools.utils";
import type {
  SeoAuditContradiction,
  SeoAuditFullReport,
  SeoAuditModule,
  SeoAuditModuleFinding,
  SeoAuditModuleReport,
  SeoAuditRecommendation,
} from "../validators/seo-audit.validation";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  SEO_AUDIT_PARSER_VERSION,
  buildRecommendationsFromFindings,
  buildSeoAuditRuntimeContext,
  calculateModuleScore,
  calculateVerificationCoverage,
  deriveModuleStatus,
  finalizeFindingFromCheck,
  type SeoAuditRuntimeContext,
} from "./seo-audit.runtime";

const LEGACY_MAX_PAGES_TO_CRAWL = 10;
const LEGACY_MAX_BODY_LENGTH = 5000;
const LEGACY_SCRAPE_TIMEOUT_MS = 30_000;

export const SEO_AUDIT_PROMPT_VERSION = "2026-03-24-r1";

export type SeoAuditRunMeta = {
  userId?: string | null;
  businessId?: string | null;
  seoAuditRunId?: string | null;
};

type LegacyCrawledPage = {
  url: string;
  html: string;
  error: string | null;
};

type LegacyAuditContext = {
  websiteUrl: string;
  businessName: string;
  crawledPages: LegacyCrawledPage[];
  sitemapUrls: string[];
  sitemapDiscovered: boolean;
};

type LegacyModuleParseSuccess = {
  success: true;
  report: SeoAuditModuleReport;
};

type LegacyModuleParseFailure = {
  success: false;
  error: string;
  rawSnippet: string;
};

type LegacyModuleParseResult = LegacyModuleParseSuccess | LegacyModuleParseFailure;
type UnknownRecord = Record<string, unknown>;

type NarrativeDraft = {
  severity: SeoAuditModuleFinding["severity"];
  title: string;
  description: string;
  evidenceRef: string;
  suggestedFix: string;
  affectedUrls: string[];
};

type NarrativeResult = {
  success: true;
  summary: string;
  findings: NarrativeDraft[];
};

type NarrativeFailure = {
  success: false;
  error: string;
  rawSnippet: string;
};

type NarrativeParseResult = NarrativeResult | NarrativeFailure;

type ModuleExecutionResult = {
  report: SeoAuditModuleReport;
  contradictions: SeoAuditContradiction[];
  tokenUsage: number;
};

type FindingMergeResult = {
  findings: SeoAuditModuleFinding[];
  promotedParserIssueCount: number;
};

const NARRATIVE_FINDING_SCHEMA = z.object({
  severity: z.enum(["critical", "warning", "info", "pass"]).default("info"),
  title: z.string().min(1),
  description: z.string().min(1),
  evidenceRef: z.string().min(1),
  suggestedFix: z.string().default(""),
  affectedUrls: z.array(z.string()).default([]),
});

const NARRATIVE_RESPONSE_SCHEMA = z.object({
  summary: z.string().min(1),
  findings: z.array(NARRATIVE_FINDING_SCHEMA).max(8).default([]),
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeScore(value: unknown): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : 0;
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function normalizeSeverity(value: unknown): SeoAuditModuleFinding["severity"] {
  if (typeof value !== "string") {
    return "info";
  }

  const normalized = value.toLowerCase().trim();
  if (
    normalized === "critical" ||
    normalized === "warning" ||
    normalized === "info" ||
    normalized === "pass"
  ) {
    return normalized;
  }

  return "info";
}

function normalizeLegacyFinding(value: unknown): SeoAuditModuleFinding | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    severity: normalizeSeverity(value.severity),
    title: toStringValue(value.title),
    description: toStringValue(value.description),
    evidenceRef: "",
    evidence: toStringValue(value.evidence),
    suggestedFix: toStringValue(value.suggestedFix),
    sourceType: "ai_assessment",
    verificationStatus: "derived",
    affectedUrls: [],
  };
}

function normalizeLegacyModuleReport(
  module: SeoAuditModule,
  value: unknown,
): SeoAuditModuleReport | null {
  if (!isRecord(value)) {
    return null;
  }

  const findings = Array.isArray(value.findings)
    ? value.findings
        .map((finding) => normalizeLegacyFinding(finding))
        .filter((finding): finding is SeoAuditModuleFinding => finding !== null)
    : [];

  return {
    module,
    score: normalizeScore(value.score),
    summary: toStringValue(value.summary),
    findings,
    checks: [],
    verificationCoverage: 0,
    status: "ok",
  };
}

function stripCodeFence(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() ?? content.trim();
}

function extractBalancedObject(content: string): string | null {
  const startIndex = content.indexOf("{");
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function sanitizeJsonCandidate(candidate: string): string {
  return candidate
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, "$1")
    .trim();
}

function buildJsonCandidates(content: string): string[] {
  const stripped = stripCodeFence(content);
  const balanced = extractBalancedObject(stripped);
  const regexCandidate = stripped.match(/\{[\s\S]*\}/)?.[0] ?? "";
  const candidates = [stripped, balanced ?? "", regexCandidate]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(candidates));
}

function parseLegacyModuleReportFromContent(
  module: SeoAuditModule,
  content: string,
): LegacyModuleParseResult {
  const candidates = buildJsonCandidates(content);
  let lastError = "No JSON object found in model response";

  for (const candidate of candidates) {
    const variants = [candidate, sanitizeJsonCandidate(candidate)];
    for (const variant of variants) {
      try {
        const parsed = JSON.parse(variant) as unknown;
        const normalized = normalizeLegacyModuleReport(module, parsed);
        if (normalized) {
          return {
            success: true,
            report: normalized,
          };
        }
        lastError = "Parsed JSON did not match expected module structure";
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        lastError = `JSON Parse error: ${errorMessage}`;
      }
    }
  }

  return {
    success: false,
    error: lastError,
    rawSnippet: content.slice(0, 2000),
  };
}

async function crawlLegacyPage(url: string): Promise<LegacyCrawledPage> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LEGACY_SCRAPE_TIMEOUT_MS);
    const html = await fetchWithScraperAPI(url);
    clearTimeout(timeout);
    return { url, html: html.slice(0, 50_000), error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, html: "", error: message };
  }
}

async function gatherLegacyAuditContext(
  websiteUrl: string,
  businessName: string,
): Promise<LegacyAuditContext> {
  const baseUrl = new URL(websiteUrl);
  const origin = baseUrl.origin;
  const mainPage = await crawlLegacyPage(websiteUrl);

  const sitemapUrl = await discoverSitemapUrl(websiteUrl);
  let sitemapUrls: string[] = [];
  if (sitemapUrl) {
    try {
      sitemapUrls = await fetchSitemapUrls(sitemapUrl);
    } catch {
      sitemapUrls = [];
    }
  }

  const internalLinks: string[] = [];
  if (mainPage.html) {
    const linkRegex = /href=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(mainPage.html)) !== null) {
      const href = match[1];
      if (!href) continue;
      try {
        const resolved = new URL(href, origin);
        if (
          resolved.origin === origin &&
          !resolved.pathname.match(
            /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf)$/i,
          )
        ) {
          internalLinks.push(resolved.href);
        }
      } catch {
        continue;
      }
    }
  }

  const uniqueLinks = Array.from(new Set(internalLinks));
  const pagesToCrawl = uniqueLinks.slice(0, LEGACY_MAX_PAGES_TO_CRAWL - 1);
  const additionalPages = await Promise.allSettled(
    pagesToCrawl.map((url) => crawlLegacyPage(url)),
  );

  const crawledPages: LegacyCrawledPage[] = [mainPage];
  for (const result of additionalPages) {
    if (result.status === "fulfilled") {
      crawledPages.push(result.value);
    }
  }

  return {
    websiteUrl,
    businessName,
    crawledPages,
    sitemapUrls,
    sitemapDiscovered: !!sitemapUrl,
  };
}

function extractLegacyPageSummaries(pages: LegacyCrawledPage[]): string {
  return pages
    .filter((page) => !page.error && page.html)
    .map((page) => {
      const titleMatch = page.html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch?.[1]?.trim() ?? "No title";
      const metaDescMatch = page.html.match(
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      );
      const metaDesc = metaDescMatch?.[1]?.trim() ?? "";
      const h1Match = page.html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      const h1 = h1Match?.[1]?.trim() ?? "";
      const canonicalMatch = page.html.match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      );
      const canonical = canonicalMatch?.[1] ?? "";
      const jsonLdMatches = page.html.match(
        /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      );
      const jsonLdSnippets = jsonLdMatches
        ? jsonLdMatches.map((match) =>
            match.replace(/<\/?script[^>]*>/gi, "").trim().slice(0, 1000),
          )
        : [];
      const hreflangMatches = page.html.match(
        /<link[^>]+hreflang=["'][^"']+["'][^>]*>/gi,
      );
      const hreflangs = hreflangMatches ?? [];
      const bodyMatch = page.html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyRaw = bodyMatch?.[1] ?? "";
      const bodyText = bodyRaw
        ? bodyRaw
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, LEGACY_MAX_BODY_LENGTH)
        : "";

      return [
        `### Page: ${page.url}`,
        `Title: ${title}`,
        `Meta Description: ${metaDesc}`,
        `H1: ${h1}`,
        `Canonical: ${canonical}`,
        `Schema/JSON-LD snippets (${jsonLdSnippets.length}): ${jsonLdSnippets.join("\n")}`,
        `Hreflang tags (${hreflangs.length}): ${hreflangs.join("\n")}`,
        `Body excerpt: ${bodyText.slice(0, 2000)}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

async function runLegacyModuleWithLLM(
  module: SeoAuditModule,
  context: LegacyAuditContext,
  meta: SeoAuditRunMeta | undefined,
): Promise<SeoAuditModuleReport> {
  const llm = getLLMForSeoAudit();
  const pageSummaries = extractLegacyPageSummaries(context.crawledPages);
  const successfulPages = context.crawledPages.filter((page) => !page.error).length;
  const failedPages = context.crawledPages.filter((page) => page.error).length;

  const sitemapInfo = context.sitemapDiscovered
    ? `Sitemap discovered with ${context.sitemapUrls.length} URLs. Sample: ${context.sitemapUrls.slice(0, 20).join(", ")}`
    : "No sitemap discovered.";

  const modulePrompts: Record<SeoAuditModule, string> = {
    technical: `Analyze the technical SEO of this website. Check for:
- Page load indicators
- Mobile responsiveness signals
- URL structure and internal linking
- Canonical tags and meta robots
- Image optimization
- JavaScript/CSS considerations`,
    schema: `Analyze structured data / Schema.org / JSON-LD implementation.`,
    geo: `Analyze local and geographic SEO signals.`,
    sitemap: `Analyze sitemap presence, accessibility, and coverage.`,
    hreflang: `Analyze hreflang and internationalization implementation.`,
    competitorPages: `Analyze page structure and content strategy from an SEO perspective.`,
    plan: `Create a prioritized SEO implementation plan.`,
  };

  const systemPrompt = `You are an expert SEO auditor. Analyze the provided website data and return a structured JSON response.

Website: ${context.websiteUrl}
Business: ${context.businessName}
Pages crawled: ${successfulPages} successful, ${failedPages} failed
${sitemapInfo}

IMPORTANT: Return ONLY valid JSON matching this exact structure:
{
  "module": "${module}",
  "score": <number 0-100>,
  "summary": "<2-3 sentence summary>",
  "findings": [
    {
      "severity": "<critical|warning|info|pass>",
      "title": "<short title>",
      "description": "<detailed description>",
      "evidence": "<specific URL or code snippet as evidence>",
      "suggestedFix": "<actionable fix>"
    }
  ]
}`;

  const userPrompt = `${modulePrompts[module]}

--- PAGE DATA ---
${pageSummaries}`;

  const maxAttempts = 2;
  let attempt = 1;
  let effectiveUserPrompt = userPrompt;
  let lastErrorMessage = "Unknown module failure";
  let lastRawSnippet = "";

  while (attempt <= maxAttempts) {
    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(effectiveUserPrompt),
      ]);

      void recordLlmUsageFromLangChainMessage(response, {
        purpose: LlmUsagePurpose.seo_audit,
        provider: "openai",
        userId: meta?.userId ?? null,
        businessId: meta?.businessId ?? null,
        blogId: null,
        correlationId: meta?.seoAuditRunId ?? null,
        modelFallback: SEO_AUDIT_MODEL_NAME,
      });

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const parsedResult = parseLegacyModuleReportFromContent(module, content);
      if (parsedResult.success) {
        return parsedResult.report;
      } else {
        lastErrorMessage = parsedResult.error;
        lastRawSnippet = parsedResult.rawSnippet;

        if (attempt < maxAttempts) {
          effectiveUserPrompt = `${userPrompt}

Your previous response failed strict JSON parsing with this error:
${parsedResult.error}

Return only valid JSON.`;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lastErrorMessage = message;
      if (attempt < maxAttempts) {
        effectiveUserPrompt = `${userPrompt}

Your previous response attempt failed with this runtime error:
${message}

Return only valid JSON with no markdown fences.`;
      }
    }

    attempt += 1;
  }

  return {
    module,
    score: 0,
    summary: `Module analysis failed: ${lastErrorMessage}`,
    findings: [
      {
        severity: "info",
        title: "Module failed",
        description: `The ${module} analysis encountered an error`,
        evidenceRef: "",
        evidence: lastRawSnippet || lastErrorMessage,
        suggestedFix: "Re-run the audit or check API credentials",
        sourceType: "system",
        verificationStatus: "module_error",
        affectedUrls: [],
      },
    ],
    checks: [],
    verificationCoverage: 0,
    status: "failed",
  };
}

function buildLegacyRecommendations(
  modules: SeoAuditModuleReport[],
): SeoAuditRecommendation[] {
  const recommendations: SeoAuditRecommendation[] = [];

  for (const moduleReport of modules) {
    for (const finding of moduleReport.findings) {
      if (finding.severity === "pass") continue;

      recommendations.push({
        priority:
          finding.severity === "critical"
            ? "P0"
            : finding.severity === "warning"
              ? "P1"
              : "P2",
        title: finding.title,
        description: finding.suggestedFix || finding.description,
        impact:
          finding.severity === "critical"
            ? "high"
            : finding.severity === "warning"
              ? "medium"
              : "low",
        effort: "medium",
        module: moduleReport.module,
      });
    }
  }

  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  recommendations.sort(
    (left, right) =>
      (priorityOrder[left.priority] ?? 2) - (priorityOrder[right.priority] ?? 2),
  );

  return recommendations;
}

async function runLegacyCompleteAudit(
  websiteUrl: string,
  businessName: string,
  modules: SeoAuditModule[],
  onProgress: (module: string, progress: number) => Promise<void>,
  meta: SeoAuditRunMeta | undefined,
): Promise<SeoAuditFullReport> {
  await onProgress("crawling", 5);
  const context = await gatherLegacyAuditContext(websiteUrl, businessName);
  await onProgress("crawling", 15);

  const moduleReports: SeoAuditModuleReport[] = [];
  const totalModules = modules.length;

  for (let index = 0; index < modules.length; index += 1) {
    const module = modules[index]!;
    const baseProgress = 15 + Math.round((index / totalModules) * 75);
    await onProgress(module, baseProgress);

    const report = await runLegacyModuleWithLLM(module, context, meta);
    moduleReports.push(report);

    const endProgress = 15 + Math.round(((index + 1) / totalModules) * 75);
    await onProgress(module, endProgress);
  }

  await onProgress("synthesizing", 92);

  const recommendations = buildLegacyRecommendations(moduleReports);
  const validScores = moduleReports.filter((module) => module.score > 0).map((module) => module.score);
  const overallScore =
    validScores.length > 0
      ? Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length)
      : 0;
  const successfulPages = context.crawledPages.filter((page) => !page.error).length;
  const sources = context.crawledPages
    .filter((page) => !page.error)
    .map((page) => page.url);

  await onProgress("complete", 100);

  return {
    overallScore,
    modules: moduleReports,
    recommendations,
    sources,
    crawlCoverage: successfulPages,
    pagesAnalyzed: successfulPages,
    modelUsed: SEO_AUDIT_MODEL_NAME,
    tokenUsage: null,
  };
}

export function parseSeoAuditNarrativeFromContent(
  content: string,
): NarrativeParseResult {
  const candidates = buildJsonCandidates(content);
  let lastError = "No JSON object found in model response";

  for (const candidate of candidates) {
    const variants = [candidate, sanitizeJsonCandidate(candidate)];
    for (const variant of variants) {
      try {
        const parsed = JSON.parse(variant) as unknown;
        const validated = NARRATIVE_RESPONSE_SCHEMA.safeParse(parsed);
        if (validated.success) {
          return {
            success: true,
            summary: validated.data.summary,
            findings: validated.data.findings.map((finding) => ({
              severity: finding.severity,
              title: finding.title,
              description: finding.description,
              evidenceRef: finding.evidenceRef,
              suggestedFix: finding.suggestedFix,
              affectedUrls: finding.affectedUrls,
            })),
          };
        }
        lastError = validated.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        lastError = `JSON Parse error: ${errorMessage}`;
      }
    }
  }

  return {
    success: false,
    error: lastError,
    rawSnippet: content.slice(0, 2000),
  };
}

function extractTokenUsage(response: unknown): number {
  if (!isRecord(response)) {
    return 0;
  }

  const directUsage = isRecord(response.usage_metadata)
    ? response.usage_metadata
    : isRecord(response.usage)
      ? response.usage
      : null;
  const responseMetadata = isRecord(response.response_metadata)
    ? response.response_metadata
    : null;
  const nestedUsage = responseMetadata && isRecord(responseMetadata.usage)
    ? responseMetadata.usage
    : null;

  const candidates = [directUsage, nestedUsage]
    .filter((candidate): candidate is UnknownRecord => Boolean(candidate))
    .map((candidate) => {
      const total =
        typeof candidate.total_tokens === "number"
          ? candidate.total_tokens
          : typeof candidate.totalTokens === "number"
            ? candidate.totalTokens
            : typeof candidate.input_tokens === "number" &&
                typeof candidate.output_tokens === "number"
              ? candidate.input_tokens + candidate.output_tokens
              : 0;
      return Number.isFinite(total) ? total : 0;
    });

  return candidates.find((value) => value > 0) ?? 0;
}

function buildSuggestedFixForCheck(key: string): string {
  if (key.includes("viewport")) {
    return 'Add a responsive viewport meta tag such as `width=device-width, initial-scale=1`.';
  }
  if (key.includes("h1.count")) {
    return "Use a single descriptive H1 per page and align it with the page topic.";
  }
  if (key.includes("canonical.present")) {
    return "Add a self-referencing canonical tag for the preferred URL.";
  }
  if (key.includes("meta.robots")) {
    return "Review the robots directive and remove noindex on pages that should rank.";
  }
  if (key.includes("html.lang")) {
    return "Set the HTML lang attribute to the primary language of the page.";
  }
  if (key.includes("alt_coverage")) {
    return "Add descriptive alt text to meaningful images and keep decorative images empty-alt.";
  }
  if (key.includes("word_count")) {
    return "Expand the page with helpful, intent-matched content instead of leaving it thin.";
  }
  if (key.includes("heading_depth")) {
    return "Break the page into clearer sections using H2 and H3 headings.";
  }
  if (key.includes("internal_count")) {
    return "Add more internal links to related service, pricing, and conversion pages.";
  }
  if (key.includes("cta.present")) {
    return "Add a stronger call-to-action that matches the page intent.";
  }
  if (key.includes("title.length")) {
    return "Rewrite the title tag so it is descriptive and stays within a typical SERP-safe range.";
  }
  if (key.includes("meta.description.length")) {
    return "Add or rewrite the meta description so it clearly summarizes the page.";
  }
  if (key.includes("jsonld.present")) {
    return "Add parseable JSON-LD that reflects the page entity and content type.";
  }
  if (key.includes("jsonld.validity")) {
    return "Fix invalid JSON-LD syntax so the structured data parses cleanly.";
  }
  if (key.includes("schema.types")) {
    return "Add schema types that match the business and page intent.";
  }
  if (key.includes("local_business_schema")) {
    return "Add LocalBusiness schema with the core business details.";
  }
  if (key.includes("phone_detected")) {
    return "Make a phone number clearly visible on high-intent pages such as the homepage or contact page.";
  }
  if (key.includes("contact_pages")) {
    return "Create or strengthen contact and location pages for local intent coverage.";
  }
  if (key.includes("sitemap.discovered")) {
    return "Publish a crawlable XML sitemap and expose it in robots.txt.";
  }
  if (key.includes("sitemap.url_count")) {
    return "Make sure the sitemap contains indexable URLs for important pages.";
  }
  if (key.includes("sitemap_declarations")) {
    return "Add the sitemap URL to robots.txt for easier discovery.";
  }
  if (key.includes("crawl_coverage")) {
    return "Ensure important indexable pages appear in the sitemap.";
  }
  if (key.includes("hreflang.valid_entries")) {
    return "Correct hreflang values so they use valid language-region codes.";
  }
  if (key.includes("hreflang.x_default")) {
    return "Add an x-default hreflang entry when the cluster needs a fallback page.";
  }
  if (key.includes("hreflang.self_reference")) {
    return "Make each hreflang page reference itself inside the alternate cluster.";
  }

  return "Address the parser-backed issue and re-run the audit to confirm the fix.";
}

function buildFallbackFindingFromCheck(
  check: SeoAuditModuleReport["checks"][number],
): SeoAuditModuleFinding {
  return {
    severity: check.severity === "pass" ? "info" : check.severity,
    title: check.label,
    description: check.details || `${check.label} needs attention.`,
    evidenceRef: check.key,
    evidence: check.rawSnippet || check.value,
    suggestedFix: buildSuggestedFixForCheck(check.key),
    sourceType: "parser",
    verificationStatus: "verified",
    affectedUrls: check.pageUrl ? [check.pageUrl] : [],
  };
}

function dedupeFindings(
  findings: SeoAuditModuleFinding[],
): SeoAuditModuleFinding[] {
  const seen = new Set<string>();
  const deduped: SeoAuditModuleFinding[] = [];

  for (const finding of findings) {
    const signature = [
      finding.evidenceRef,
      finding.title.trim().toLowerCase(),
      finding.verificationStatus,
    ].join("|");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push(finding);
  }

  return deduped;
}

export function mergeFindingsWithParserIssues(
  checks: SeoAuditModuleReport["checks"],
  finalizedFindings: SeoAuditModuleFinding[],
): FindingMergeResult {
  const verifiedByEvidenceRef = new Map<string, SeoAuditModuleFinding>();
  const supplementalFindings: SeoAuditModuleFinding[] = [];

  for (const finding of finalizedFindings) {
    if (
      finding.verificationStatus === "verified" &&
      finding.evidenceRef &&
      !verifiedByEvidenceRef.has(finding.evidenceRef)
    ) {
      verifiedByEvidenceRef.set(finding.evidenceRef, finding);
      continue;
    }

    if (finding.verificationStatus !== "verified") {
      supplementalFindings.push(finding);
    }
  }

  const parserIssueChecks = checks.filter(
    (check) => check.status === "warning" || check.status === "fail",
  );

  let promotedParserIssueCount = 0;
  const parserBackedIssueFindings = parserIssueChecks.map((check) => {
    const verifiedFinding = verifiedByEvidenceRef.get(check.key);
    if (verifiedFinding) {
      return verifiedFinding;
    }

    promotedParserIssueCount += 1;
    return buildFallbackFindingFromCheck(check);
  });

  return {
    findings: dedupeFindings([
      ...parserBackedIssueFindings,
      ...supplementalFindings,
    ]),
    promotedParserIssueCount,
  };
}

function appendParserCoverageNote(
  summary: string,
  promotedParserIssueCount: number,
): string {
  if (promotedParserIssueCount <= 0) {
    return summary;
  }

  const suffix = `${promotedParserIssueCount} additional parser-backed issue${
    promotedParserIssueCount === 1 ? " was" : "s were"
  } added directly from checks because the AI explanation did not cover ${
    promotedParserIssueCount === 1 ? "it" : "them"
  }.`;

  const base = summary.trim();
  if (!base) {
    return suffix;
  }

  return `${base}${/[.!?]$/.test(base) ? "" : "."} ${suffix}`;
}

function buildModuleSummaryFallback(
  module: SeoAuditModule,
  checks: SeoAuditModuleReport["checks"],
  findingsCount: number,
  contradictionsCount: number,
): string {
  const failingChecks = checks.filter((check) => check.status === "fail").length;
  const warningChecks = checks.filter((check) => check.status === "warning").length;
  const passedChecks = checks.filter((check) => check.status === "pass").length;
  const moduleLabel =
    module === "competitorPages" ? "On-page content analysis" : module;

  if (failingChecks === 0 && warningChecks === 0) {
    return `${moduleLabel} is in a healthy state across the verified parser checks. ${passedChecks} checks passed without contradiction.`;
  }

  const contradictionText =
    contradictionsCount > 0
      ? ` ${contradictionsCount} unsupported AI claims were downgraded.`
      : "";

  return `${moduleLabel} surfaced ${failingChecks} failing checks and ${warningChecks} warnings across the verified parser layer. ${findingsCount} grounded findings were included in this module.${contradictionText}`;
}

function buildSystemModuleReport(
  module: SeoAuditModule,
  checks: SeoAuditModuleReport["checks"],
  message: string,
): SeoAuditModuleReport {
  const parserIssueFindings = checks
    .filter((check) => check.status === "warning" || check.status === "fail")
    .map((check) => buildFallbackFindingFromCheck(check));

  return {
    module,
    score: calculateModuleScore(checks),
    summary: parserIssueFindings.length > 0
      ? `Verified parser checks completed and parser-backed issues are listed below, but the AI explanation step failed: ${message}`
      : `Verified parser checks completed, but the AI explanation step failed: ${message}`,
    findings: dedupeFindings([
      ...parserIssueFindings,
      {
        severity: "info",
        title: "AI explanation unavailable",
        description: `Parser-backed checks completed for ${module}, but the narrative response could not be validated.`,
        evidenceRef: `system.${module}`,
        evidence: message,
        suggestedFix: "Re-run the audit to regenerate the explanation layer.",
        sourceType: "system",
        verificationStatus: "module_error",
        affectedUrls: [],
      },
    ]),
    checks,
    verificationCoverage: calculateVerificationCoverage(checks),
    status: "failed",
  };
}

function getModulePrompt(module: SeoAuditModule): string {
  switch (module) {
    case "technical":
      return "Explain the parser-verified technical SEO issues and prioritize fixes. Do not invent missing tags or directives beyond the supplied evidenceRef values.";
    case "schema":
      return "Explain the parser-verified structured data coverage, parseability, and schema type signals. Keep every claim grounded in the provided checks.";
    case "geo":
      return "Explain the parser-verified local SEO signals such as local schema, contact/location pages, and phone visibility.";
    case "sitemap":
      return "Explain the parser-verified sitemap and robots.txt coverage, focusing on discovery and URL coverage.";
    case "hreflang":
      return "Explain the parser-verified hreflang state. If hreflang is not required, say so plainly and do not invent warnings.";
    case "competitorPages":
      return "Explain the parser-verified on-page content quality signals such as titles, meta descriptions, heading depth, internal linking, CTAs, and content depth.";
    case "plan":
      return "Create an action plan from the verified findings only.";
  }
}

function reducePageFactsForPrompt(
  module: SeoAuditModule,
  context: SeoAuditRuntimeContext,
) {
  const relevantChecks = context.parserChecks.filter((check) => check.module === module);
  const relevantUrls = new Set(
    relevantChecks
      .map((check) => check.pageUrl)
      .filter((url): url is string => Boolean(url)),
  );
  const pages = context.pageFacts
    .filter((page) => relevantUrls.size === 0 || relevantUrls.has(page.url))
    .slice(0, 12);

  return pages.map((page) => ({
    pageKey: page.pageKey,
    url: page.url,
    fetchMode: page.fetchMode,
    title: page.title,
    metaDescription: page.metaDescription,
    metaRobots: page.metaRobots,
    viewportContent: page.viewportContent,
    canonicalUrl: page.canonicalUrl,
    htmlLang: page.htmlLang,
    headings: page.headings,
    openGraph: page.openGraph,
    twitter: page.twitter,
    hreflang: page.hreflang,
    images: page.images,
    links: page.links,
    content: page.content,
    jsonLd: page.jsonLd,
    geoSignals: page.geoSignals,
  }));
}

function buildPromptPayload(
  module: SeoAuditModule,
  context: SeoAuditRuntimeContext,
): string {
  const checks = context.parserChecks
    .filter((check) => check.module === module)
    .map((check) => ({
      key: check.key,
      label: check.label,
      status: check.status,
      severity: check.severity,
      pageUrl: check.pageUrl,
      value: check.value,
      details: check.details,
      rawSnippet: check.rawSnippet,
    }));

  const payload = {
    promptVersion: SEO_AUDIT_PROMPT_VERSION,
    module,
    website: context.siteFacts.websiteUrl,
    crawlStats: context.crawlStats,
    siteFacts: {
      ...context.siteFacts,
      sitemapSampleUrls: context.siteFacts.sitemapSampleUrls.slice(0, 20),
    },
    pageFacts: reducePageFactsForPrompt(module, context),
    parserChecks: checks,
  };

  return JSON.stringify(payload, null, 2);
}

async function runVerifiedModuleWithLLM(
  module: SeoAuditModule,
  context: SeoAuditRuntimeContext,
  meta: SeoAuditRunMeta | undefined,
): Promise<ModuleExecutionResult> {
  const checks = context.parserChecks.filter((check) => check.module === module);
  const llm = getLLMForSeoAudit();
  const systemPrompt = `You are a grounded SEO auditor.

You will receive parser-verified site facts and parser checks.
Rules:
- Use only the provided evidenceRef keys.
- Never claim that a tag, schema, or directive is missing if its parser check status is pass or not_applicable.
- Only use severity critical or warning when the referenced parser check status is warning or fail.
- Keep the summary to 2-3 sentences.
- Prefer 3-6 findings, but it is okay to return fewer when the parser checks are mostly healthy.
- Return ONLY valid JSON with this shape:
{
  "summary": "<brief summary>",
  "findings": [
    {
      "severity": "<critical|warning|info|pass>",
      "title": "<short title>",
      "description": "<grounded explanation>",
      "evidenceRef": "<parser check key>",
      "suggestedFix": "<actionable fix>",
      "affectedUrls": ["<url>"]
    }
  ]
}`;

  const userPrompt = `${getModulePrompt(module)}

Ground every finding in a provided parser check.

--- VERIFIED AUDIT DATA ---
${buildPromptPayload(module, context)}`;

  let attempt = 1;
  let effectiveUserPrompt = userPrompt;
  let lastError = "Unknown module failure";
  let lastRawSnippet = "";
  let tokenUsage = 0;

  while (attempt <= 2) {
    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(effectiveUserPrompt),
      ]);
      tokenUsage += extractTokenUsage(response);

      void recordLlmUsageFromLangChainMessage(response, {
        purpose: LlmUsagePurpose.seo_audit,
        provider: "openai",
        userId: meta?.userId ?? null,
        businessId: meta?.businessId ?? null,
        blogId: null,
        correlationId: meta?.seoAuditRunId ?? null,
        modelFallback: SEO_AUDIT_MODEL_NAME,
      });

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const parsed = parseSeoAuditNarrativeFromContent(content);
      if (parsed.success) {
        const checkMap = new Map(checks.map((check) => [check.key, check]));
        const contradictions: SeoAuditContradiction[] = [];
        const finalizedFindings: SeoAuditModuleFinding[] = [];

        for (const draft of parsed.findings) {
          const finalized = finalizeFindingFromCheck(module, draft, checkMap);
          finalizedFindings.push(finalized.finding);
          if (finalized.contradiction) {
            contradictions.push(finalized.contradiction);
          }
        }

        const mergedFindings = mergeFindingsWithParserIssues(
          checks,
          finalizedFindings,
        );
        const summary =
          parsed.summary ||
          buildModuleSummaryFallback(
            module,
            checks,
            mergedFindings.findings.length,
            contradictions.length,
          );

        return {
          report: {
            module,
            score: calculateModuleScore(checks),
            summary: appendParserCoverageNote(
              summary,
              mergedFindings.promotedParserIssueCount,
            ),
            findings: mergedFindings.findings,
            checks,
            verificationCoverage: calculateVerificationCoverage(checks),
            status: deriveModuleStatus(checks, false),
          },
          contradictions,
          tokenUsage,
        };
      } else {
        lastError = parsed.error;
        lastRawSnippet = parsed.rawSnippet;

        if (attempt < 2) {
          effectiveUserPrompt = `${userPrompt}

Your previous response failed schema validation with this error:
${parsed.error}

Return only valid JSON.`;
        }
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 2) {
        effectiveUserPrompt = `${userPrompt}

Your previous response failed with this runtime error:
${lastError}

Return only valid JSON.`;
      }
    }

    attempt += 1;
  }

  const report = buildSystemModuleReport(
    module,
    checks,
    lastRawSnippet || lastError,
  );
  return {
    report,
    contradictions: [],
    tokenUsage,
  };
}

function buildPlanModuleReport(
  moduleReports: SeoAuditModuleReport[],
  recommendations: SeoAuditRecommendation[],
): SeoAuditModuleReport {
  const sourceFindings = moduleReports
    .flatMap((moduleReport) => moduleReport.findings)
    .filter((finding) => finding.verificationStatus === "verified");

  if (recommendations.length === 0) {
    return {
      module: "plan",
      score:
        moduleReports.length > 0
          ? Math.round(
              moduleReports.reduce((sum, moduleReport) => sum + moduleReport.score, 0) /
                moduleReports.length,
            )
          : 100,
      summary:
        "No verified warning or critical findings were detected, so the action plan is currently light-touch. Continue monitoring the parser-backed checks over time.",
      findings: [
        {
          severity: "pass",
          title: "No urgent verified actions",
          description:
            "The parser-backed audit did not surface verified warning or critical issues that need immediate remediation.",
          evidenceRef: "plan.none",
          evidence: "",
          suggestedFix:
            "Re-run the audit after major site changes or content launches to keep this baseline fresh.",
          sourceType: "ai_assessment",
          verificationStatus: "derived",
          affectedUrls: [],
        },
      ],
      checks: [],
      verificationCoverage: 100,
      status: "ok",
    };
  }

  const planFindings: SeoAuditModuleFinding[] = recommendations.slice(0, 6).map((recommendation) => {
    const sourceFinding = sourceFindings.find(
      (finding) =>
        finding.title === recommendation.title &&
        (finding.severity === "critical" || finding.severity === "warning"),
    );

    return {
      severity:
        recommendation.priority === "P0"
          ? "critical"
          : recommendation.priority === "P1"
            ? "warning"
            : "info",
      title: recommendation.title,
      description: recommendation.description,
      evidenceRef: sourceFinding?.evidenceRef ?? `plan.${recommendation.module}.${recommendation.title}`,
      evidence: sourceFinding?.evidence ?? "",
      suggestedFix: recommendation.description,
      sourceType: "ai_assessment" as const,
      verificationStatus: "derived" as const,
      affectedUrls: sourceFinding?.affectedUrls ?? [],
    };
  });

  return {
    module: "plan",
    score:
      moduleReports.length > 0
        ? Math.round(
            moduleReports.reduce((sum, moduleReport) => sum + moduleReport.score, 0) /
              moduleReports.length,
          )
        : 100,
    summary: `The action plan is built from ${recommendations.length} verified recommendations, sorted by parser-backed severity and impact. Start with the P0/P1 items before broadening into lighter improvements.`,
    findings: planFindings,
    checks: [],
    verificationCoverage: 100,
    status: "ok",
  };
}

async function runReliableAudit(
  websiteUrl: string,
  modules: SeoAuditModule[],
  onProgress: (module: string, progress: number) => Promise<void>,
  meta: SeoAuditRunMeta | undefined,
): Promise<SeoAuditFullReport> {
  await onProgress("crawling", 5);
  const runtimeContext = await buildSeoAuditRuntimeContext(websiteUrl);
  await onProgress("crawling", 20);

  const executableModules = modules.filter((module) => module !== "plan");
  const moduleReports: SeoAuditModuleReport[] = [];
  const contradictions: SeoAuditContradiction[] = [];
  let tokenUsage = 0;

  const totalModules = executableModules.length || 1;
  for (let index = 0; index < executableModules.length; index += 1) {
    const module = executableModules[index]!;
    const startProgress = 20 + Math.round((index / totalModules) * 65);
    await onProgress(module, startProgress);

    const executionResult = await runVerifiedModuleWithLLM(
      module,
      runtimeContext,
      meta,
    );
    moduleReports.push(executionResult.report);
    contradictions.push(...executionResult.contradictions);
    tokenUsage += executionResult.tokenUsage;

    const endProgress = 20 + Math.round(((index + 1) / totalModules) * 65);
    await onProgress(module, endProgress);
  }

  await onProgress("synthesizing", 92);
  const recommendations = buildRecommendationsFromFindings(moduleReports);

  if (modules.includes("plan")) {
    moduleReports.push(buildPlanModuleReport(moduleReports, recommendations));
  }

  const scoredModules = moduleReports.filter((moduleReport) => moduleReport.module !== "plan");
  const overallScore =
    scoredModules.length > 0
      ? Math.round(
          scoredModules.reduce((sum, moduleReport) => sum + moduleReport.score, 0) /
            scoredModules.length,
        )
      : 0;

  await onProgress("complete", 100);

  return {
    overallScore,
    modules: moduleReports,
    recommendations,
    sources: runtimeContext.sources,
    crawlCoverage:
      runtimeContext.crawlStats.attemptedPages > 0
        ? Math.round(
            (runtimeContext.crawlStats.successfulPages /
              runtimeContext.crawlStats.attemptedPages) *
              100,
          )
        : 0,
    pagesAnalyzed: runtimeContext.crawlStats.successfulPages,
    crawlStats: runtimeContext.crawlStats,
    siteFacts: runtimeContext.siteFacts,
    pageFacts: runtimeContext.pageFacts,
    parserChecks: runtimeContext.parserChecks,
    contradictions,
    promptVersion: SEO_AUDIT_PROMPT_VERSION,
    parserVersion: SEO_AUDIT_PARSER_VERSION,
    modelUsed: SEO_AUDIT_MODEL_NAME,
    tokenUsage,
  };
}

export async function runCompleteAudit(
  websiteUrl: string,
  businessName: string,
  modules: SeoAuditModule[],
  onProgress: (module: string, progress: number) => Promise<void>,
  meta?: SeoAuditRunMeta,
): Promise<SeoAuditFullReport> {
  if (!SEO_AUDIT_RELIABILITY_V2_ENABLED) {
    return await runLegacyCompleteAudit(
      websiteUrl,
      businessName,
      modules,
      onProgress,
      meta,
    );
  }

  return await runReliableAudit(websiteUrl, modules, onProgress, meta);
}
