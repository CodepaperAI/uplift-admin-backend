import type { Request, Response } from "express";
import {
  normalizeAuditUrl,
  parseAuditPageFacts,
  buildAuditParserChecks,
} from "../services/seo-audit.runtime";
import {
  applyPublicRateLimitHeaders,
  buildPublicRateLimitError,
  evaluatePublicRateLimit,
} from "../utils/public-rate-limit.utils";
import { SsrfBlocked, safeFetch } from "../utils/ssrf-guard";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * POST /api/public/v1/framer-plugin/audit
 *
 * Runs an SEO audit against the user's published Framer site.
 * Unauthenticated, rate-limited per IP, SSRF-guarded.
 *
 * Response shape (v1 returns JSON, not NDJSON — plugin client handles both).
 */
export async function framerPluginAudit(req: Request, res: Response) {
  try {
    const { url, projectId } = req.body ?? {};

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !["url", "projectId"].includes(key)) ||
      (projectId !== undefined &&
        (typeof projectId !== "string" || projectId.length > 256))
    ) {
      return res.status(400).json({
        success: false,
        code: "invalid_request",
        title: "Invalid request",
      });
    }

    if (!url || typeof url !== "string" || url.length > 2_048) {
      return res.status(400).json({
        success: false,
        code: "invalid_url",
        title: "URL is required",
      });
    }

    const clientIp =
      req.ip || (req.headers["x-forwarded-for"]?.toString() ?? "unknown");
    const rateLimit = evaluatePublicRateLimit({
      store: rateLimitMap,
      key: clientIp,
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
    });
    applyPublicRateLimitHeaders(res, rateLimit);

    if (!rateLimit.allowed) {
      return res
        .status(429)
        .json(
          buildPublicRateLimitError({
            scope: "public_audit",
            status: rateLimit,
            resourceLabel: "Framer SEO audits",
            actionLabel: "run another audit",
            windowLabel: "hour",
          })
        );
    }

    const homepage = normalizeAuditUrl(url);
    if (!homepage) {
      return res.status(400).json({
        success: false,
        code: "invalid_url",
        title: "Invalid URL format",
      });
    }

    // SSRF guard — resolve DNS + reject private IPs before we fetch
    let html = "";
    let httpStatus: number | null = null;
    let finalUrl = homepage;

    try {
      const response = await safeFetch(
        homepage,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; UpliftFramerAudit/1.0)",
            Accept: "text/html,application/xhtml+xml",
          },
        },
        { timeoutMs: 15000, maxRedirects: 3 }
      );
      httpStatus = response.status;
      finalUrl = response.url || homepage;
      html = await response.text();
    } catch (err) {
      if (err instanceof SsrfBlocked) {
        return res.status(400).json({
          success: false,
          code: "ssrf_blocked",
          title: "URL points to a private or reserved address",
        });
      }
      return res.status(502).json({
        success: false,
        code: "network",
        title: `Could not reach ${homepage}. The site may be offline.`,
      });
    }

    if (!html || html.length < 100) {
      return res.status(502).json({
        success: false,
        code: "empty_response",
        title: "Site returned empty content",
      });
    }

    const origin = new URL(homepage).origin;

    const crawledPage = {
      requestedUrl: homepage,
      finalUrl,
      pageKey: "homepage",
      fetchMode: "static" as const,
      httpStatus,
      contentType: "text/html",
      durationMs: 0,
      htmlLength: html.length,
      bodyTextLength: 0,
      error: null as string | null,
      html,
    };

    const pageFacts = parseAuditPageFacts(crawledPage as any, origin, "homepage");

    const siteFacts = {
      websiteUrl: homepage,
      origin,
      sitemapDiscovered: false,
      sitemapUrl: "",
      sitemapUrlCount: 0,
      sitemapSampleUrls: [] as string[],
      robotsTxtFetched: false,
      robotsTxtUrl: `${origin}/robots.txt`,
      robotsTxtSnippet: "",
      robotsTxtRawText: "",
      robotsSitemapDeclarations: [] as string[],
      llmsTxtFound: false,
      crawlAttemptedCount: 1,
      crawlSucceededCount: httpStatus && httpStatus < 400 ? 1 : 0,
      crawlFailedCount: httpStatus && httpStatus >= 400 ? 1 : 0,
      renderedPageCount: 0,
    };

    const checks = buildAuditParserChecks(siteFacts, [pageFacts]);

    const totalChecks = checks.length;
    const passedChecks = checks.filter((c) => c.status === "pass").length;
    const overallScore =
      totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

    const findings = checks.slice(0, 25).map((c, index) => ({
      id: `${c.module}-${c.key || index}`,
      severity: (c.status === "pass"
        ? "pass"
        : c.severity || "info") as "critical" | "warning" | "info" | "pass",
      title: c.label || c.key || "Check",
      detail: c.details || "",
      recommendation:
        c.status !== "pass" && c.details
          ? c.details.slice(0, 200)
          : undefined,
    }));

    return res.json({
      score: overallScore,
      findings,
      partial: false,
      generatedAt: new Date().toISOString(),
      meta: {
        projectId: typeof projectId === "string" ? projectId : undefined,
        url: homepage,
      },
    });
  } catch (err) {
    console.error("[Framer Plugin Audit]", err);
    return res.status(500).json({
      success: false,
      code: "internal",
      title: "Audit failed unexpectedly",
    });
  }
}
