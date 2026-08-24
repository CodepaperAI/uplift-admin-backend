import type { Request, Response } from "express";
import {
  buildSeoAuditRuntimeContext,
  normalizeAuditUrl,
  SEO_AUDIT_PARSER_VERSION,
} from "../services/seo-audit.runtime";
import {
  applyPublicRateLimitHeaders,
  buildPublicRateLimitError,
  evaluatePublicRateLimit,
} from "../utils/public-rate-limit.utils";
import { guardUrl, SsrfBlocked } from "../utils/ssrf-guard";

// Simple in-memory rate limiting (IP-based)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export async function runPublicAudit(req: Request, res: Response) {
  try {
    const { url } = req.body ?? {};

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== "url") ||
      !url ||
      typeof url !== "string" ||
      url.length > 2_048
    ) {
      return res.status(400).json({ success: false, message: "URL is required" });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.startsWith("http") ? url : `https://${url}`);
    } catch {
      return res.status(400).json({ success: false, message: "Invalid URL format" });
    }

    const clientIp = req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown";
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
            resourceLabel: "public audits",
            actionLabel: "run another audit",
            windowLabel: "hour",
          }),
        );
    }

    const targetUrl = parsedUrl.toString();
    const homepage = normalizeAuditUrl(targetUrl);
    if (!homepage) {
      return res.status(400).json({ success: false, message: "Invalid URL" });
    }
    try {
      await guardUrl(homepage);
    } catch (error) {
      if (error instanceof SsrfBlocked) {
        return res.status(400).json({
          success: false,
          message: "URL is not allowed",
        });
      }
      throw error;
    }

    let runtimeContext: Awaited<ReturnType<typeof buildSeoAuditRuntimeContext>>;
    try {
      runtimeContext = await buildSeoAuditRuntimeContext(homepage);
    } catch {
      return res.status(502).json({
        success: false,
        message: `Could not reach ${homepage}. The website may be down or blocking our requests.`,
      });
    }

    if (runtimeContext.crawlStats.successfulPages === 0) {
      return res.status(502).json({
        success: false,
        message: "Website returned empty or very short content.",
      });
    }

    const checks = runtimeContext.parserChecks;

    // Calculate scores
    const totalChecks = checks.length;
    const passedChecks = checks.filter((c) => c.status === "pass").length;
    const criticalCount = checks.filter((c) => c.severity === "critical").length;
    const warningCount = checks.filter((c) => c.severity === "warning").length;
    const infoCount = checks.filter((c) => c.severity === "info").length;
    const overallScore = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

    const findings = checks
      .filter((c) => c.status !== "pass")
      .map((c) => ({
        title: c.label || c.key,
        description: c.details || "",
        severity: c.severity,
        module: c.module,
        value: c.value || null,
      }))
      .slice(0, 25);

    const passedItems = checks
      .filter((c) => c.status === "pass")
      .map((c) => ({
        title: c.label || c.key,
        module: c.module,
      }));

    const aiPrompt = `I ran an SEO audit on ${targetUrl} and found the following issues. Please help me fix them:\n\n${findings
      .map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}: ${f.description}`)
      .join("\n")}\n\nOverall SEO Score: ${overallScore}/100\nPlease provide specific code/configuration changes to fix each issue.`;

    return res.json({
      success: true,
      data: {
        url: targetUrl,
        overallScore,
        parserVersion: SEO_AUDIT_PARSER_VERSION,
        summary: {
          total: totalChecks,
          passed: passedChecks,
          critical: criticalCount,
          warnings: warningCount,
          info: infoCount,
        },
        findings,
        passed: passedItems,
        aiPrompt,
        crawlStats: {
          pagesAnalyzed: runtimeContext.crawlStats.successfulPages,
          attemptedPages: runtimeContext.crawlStats.attemptedPages,
          failedPages: runtimeContext.crawlStats.failedPages,
          renderedPages: runtimeContext.crawlStats.renderedPages,
          sources: runtimeContext.sources,
          sitemapDiscovered: runtimeContext.siteFacts.sitemapDiscovered,
          sitemapUrl: runtimeContext.siteFacts.sitemapUrl,
          sitemapUrlCount: runtimeContext.siteFacts.sitemapUrlCount,
        },
      },
    });
  } catch (error: any) {
    console.error("Public audit error:", error);
    return res.status(500).json({
      success: false,
      message: "Audit failed. The website may be unreachable or blocking our crawler.",
    });
  }
}
