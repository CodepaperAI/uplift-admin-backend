import { z } from "zod";

export const SEO_AUDIT_MODULES = [
  "technical",
  "schema",
  "geo",
  "sitemap",
  "hreflang",
  "competitorPages",
  "plan",
] as const;

export type SeoAuditModule = (typeof SEO_AUDIT_MODULES)[number];

export const TRIGGER_SEO_AUDIT_SCHEMA = z.object({
  businessId: z.string().min(1, "Business ID is required"),
  modules: z
    .array(z.enum(SEO_AUDIT_MODULES))
    .min(1)
    .optional()
    .default([...SEO_AUDIT_MODULES]),
});

export type TriggerSeoAuditPayload = z.infer<typeof TRIGGER_SEO_AUDIT_SCHEMA>;

export const GET_AUDIT_STATUS_PARAMS = z.object({
  runId: z.string().uuid("Invalid run ID"),
});

export const GET_LATEST_AUDIT_PARAMS = z.object({
  businessId: z.string().min(1, "Business ID is required"),
});

export const SEO_AUDIT_FINDING_SEVERITIES = [
  "critical",
  "warning",
  "info",
  "pass",
] as const;

export const SEO_AUDIT_CHECK_STATUSES = [
  "pass",
  "warning",
  "fail",
  "not_applicable",
  "unknown",
] as const;

export const SEO_AUDIT_FINDING_SOURCE_TYPES = [
  "parser",
  "ai_assessment",
  "system",
] as const;

export const SEO_AUDIT_FINDING_VERIFICATION_STATUSES = [
  "verified",
  "derived",
  "contradicted",
  "module_error",
] as const;

export const SEO_AUDIT_MODULE_STATUSES = [
  "ok",
  "partial",
  "failed",
] as const;

export type SeoAuditFindingSeverity =
  (typeof SEO_AUDIT_FINDING_SEVERITIES)[number];

export type SeoAuditCheckStatus = (typeof SEO_AUDIT_CHECK_STATUSES)[number];

export type SeoAuditFindingSourceType =
  (typeof SEO_AUDIT_FINDING_SOURCE_TYPES)[number];

export type SeoAuditFindingVerificationStatus =
  (typeof SEO_AUDIT_FINDING_VERIFICATION_STATUSES)[number];

export type SeoAuditModuleStatus = (typeof SEO_AUDIT_MODULE_STATUSES)[number];

export type SeoAuditCrawlPage = {
  requestedUrl: string;
  finalUrl: string;
  pageKey: string | null;
  fetchMode: "static" | "rendered";
  httpStatus: number | null;
  contentType: string;
  durationMs: number;
  htmlLength: number;
  bodyTextLength: number;
  error: string | null;
};

export type SeoAuditCrawlStats = {
  attemptedPages: number;
  successfulPages: number;
  failedPages: number;
  renderedPages: number;
  pages: SeoAuditCrawlPage[];
};

export type SeoAuditPageFacts = {
  pageKey: string;
  requestedUrl: string;
  url: string;
  fetchMode: "static" | "rendered";
  title: string;
  metaDescription: string;
  metaRobots: string;
  viewportContent: string;
  canonicalUrl: string;
  htmlLang: string;
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
  };
  openGraph: {
    title: string;
    description: string;
    image: string;
    url: string;
  };
  twitter: {
    card: string;
    title: string;
    description: string;
    image: string;
  };
  hreflang: {
    count: number;
    values: string[];
    hrefs: string[];
    hasXDefault: boolean;
    selfReferencing: boolean;
    invalidEntries: string[];
  };
  images: {
    count: number;
    missingAltCount: number;
    lazyLoadedCount: number;
  };
  links: {
    internalCount: number;
    ctaCount: number;
  };
  content: {
    wordCount: number;
    bodyTextLength: number;
    bodyTextExcerpt: string;
    hasVisibleLastUpdated: boolean;
  };
  jsonLd: {
    count: number;
    parseableCount: number;
    invalidCount: number;
    schemaTypes: string[];
    hasArticleDateModified: boolean;
    latestArticleDateModified: string | null;
  };
  geoSignals: {
    phoneDetected: boolean;
    contactPageCandidate: boolean;
    locationPageCandidate: boolean;
  };
  snippets: {
    head: string;
    body: string;
  };
};

export type SeoAuditSiteFacts = {
  websiteUrl: string;
  origin: string;
  sitemapDiscovered: boolean;
  sitemapUrl: string;
  sitemapUrlCount: number;
  sitemapSampleUrls: string[];
  robotsTxtFetched: boolean;
  robotsTxtUrl: string;
  robotsTxtSnippet: string;
  robotsTxtRawText: string;
  robotsSitemapDeclarations: string[];
  llmsTxtFound: boolean;
  crawlAttemptedCount: number;
  crawlSucceededCount: number;
  crawlFailedCount: number;
  renderedPageCount: number;
};

export type SeoAuditParserCheck = {
  module: SeoAuditModule;
  key: string;
  label: string;
  status: SeoAuditCheckStatus;
  severity: SeoAuditFindingSeverity;
  pageUrl: string | null;
  pageKey: string | null;
  value: string;
  rawSnippet: string;
  details: string;
  verifiedBy: "parser";
};

export type SeoAuditContradiction = {
  module: SeoAuditModule;
  evidenceRef: string;
  findingTitle: string;
  reason: string;
  originalSeverity: SeoAuditFindingSeverity;
  finalSeverity: SeoAuditFindingSeverity;
  affectedUrls: string[];
};

export type SeoAuditModuleFinding = {
  severity: SeoAuditFindingSeverity;
  title: string;
  description: string;
  evidenceRef: string;
  evidence: string;
  suggestedFix: string;
  sourceType: SeoAuditFindingSourceType;
  verificationStatus: SeoAuditFindingVerificationStatus;
  affectedUrls: string[];
};

export type SeoAuditModuleReport = {
  module: SeoAuditModule;
  score: number;
  findings: SeoAuditModuleFinding[];
  summary: string;
  checks: SeoAuditParserCheck[];
  verificationCoverage: number;
  status: SeoAuditModuleStatus;
};

export type SeoAuditRecommendation = {
  priority: "P0" | "P1" | "P2";
  title: string;
  description: string;
  impact: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
  module: SeoAuditModule;
};

export type SeoAuditFullReport = {
  overallScore: number;
  modules: SeoAuditModuleReport[];
  recommendations: SeoAuditRecommendation[];
  sources: string[];
  crawlCoverage: number;
  pagesAnalyzed: number;
  crawlStats?: SeoAuditCrawlStats;
  siteFacts?: SeoAuditSiteFacts;
  pageFacts?: SeoAuditPageFacts[];
  parserChecks?: SeoAuditParserCheck[];
  contradictions?: SeoAuditContradiction[];
  promptVersion?: string;
  parserVersion?: string;
  modelUsed?: string;
  tokenUsage?: number | null;
};
