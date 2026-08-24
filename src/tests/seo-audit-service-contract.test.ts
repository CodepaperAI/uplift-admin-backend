import { describe, expect, it } from "bun:test";
import {
  mergeFindingsWithParserIssues,
  parseSeoAuditNarrativeFromContent,
} from "../services/seo-audit.service";
import { buildRecommendationsFromFindings } from "../services/seo-audit.runtime";
import type { SeoAuditModuleReport } from "../validators/seo-audit.validation";

describe("seo-audit narrative contract", () => {
  it("rejects model output without evidenceRef", () => {
    const parsed = parseSeoAuditNarrativeFromContent(`
      {
        "summary": "Parser-backed issues were found.",
        "findings": [
          {
            "severity": "warning",
            "title": "Missing viewport",
            "description": "A responsive viewport is missing.",
            "suggestedFix": "Add one.",
            "affectedUrls": ["https://example.com/"]
          }
        ]
      }
    `);

    expect(parsed.success).toBe(false);
    if (parsed.success === false) {
      expect(parsed.error).toContain("evidenceRef");
    }
  });

  it("accepts strict JSON with grounded findings", () => {
    const parsed = parseSeoAuditNarrativeFromContent(`
      {
        "summary": "Technical parser checks found two issues.",
        "findings": [
          {
            "severity": "warning",
            "title": "Viewport tag missing",
            "description": "The page is missing a responsive viewport declaration.",
            "evidenceRef": "page.home.meta.viewport.present",
            "suggestedFix": "Add a standard viewport meta tag.",
            "affectedUrls": ["https://example.com/"]
          }
        ]
      }
    `);

    expect(parsed.success).toBe(true);
    if (parsed.success === true) {
      expect(parsed.findings[0]?.evidenceRef).toBe("page.home.meta.viewport.present");
    }
  });

  it("builds recommendations only from verified critical and warning findings", () => {
    const modules: SeoAuditModuleReport[] = [
      {
        module: "technical",
        score: 55,
        summary: "Technical summary",
        findings: [
          {
            severity: "warning",
            title: "Viewport tag missing",
            description: "Missing viewport.",
            evidenceRef: "page.home.meta.viewport.present",
            evidence: "<meta ...>",
            suggestedFix: "Add viewport.",
            sourceType: "parser",
            verificationStatus: "verified",
            affectedUrls: ["https://example.com/"],
          },
          {
            severity: "info",
            title: "Legacy AI note",
            description: "Ungrounded note.",
            evidenceRef: "unknown.fact",
            evidence: "",
            suggestedFix: "Ignore",
            sourceType: "ai_assessment",
            verificationStatus: "derived",
            affectedUrls: [],
          },
        ],
        checks: [],
        verificationCoverage: 100,
        status: "ok",
      },
      {
        module: "plan",
        score: 55,
        summary: "Plan summary",
        findings: [],
        checks: [],
        verificationCoverage: 100,
        status: "ok",
      },
    ];

    const recommendations = buildRecommendationsFromFindings(modules);

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.title).toBe("Viewport tag missing");
    expect(recommendations[0]?.priority).toBe("P1");
  });

  it("auto-promotes uncovered parser warning checks into findings", () => {
    const result = mergeFindingsWithParserIssues(
      [
        {
          module: "technical",
          key: "page.home.meta.viewport.present",
          label: "Viewport meta tag",
          status: "warning",
          severity: "warning",
          pageUrl: "https://example.com/",
          pageKey: "home",
          value: "Missing viewport meta tag",
          rawSnippet: "<head></head>",
          details: "Mobile-friendly pages should declare a viewport.",
          verifiedBy: "parser",
        },
        {
          module: "technical",
          key: "page.home.headings.h1.count",
          label: "Primary H1 heading count",
          status: "warning",
          severity: "warning",
          pageUrl: "https://example.com/",
          pageKey: "home",
          value: "0",
          rawSnippet: "<body></body>",
          details: "Detected 0 H1 tags.",
          verifiedBy: "parser",
        },
      ],
      [
        {
          severity: "warning",
          title: "Viewport tag missing",
          description: "The homepage is missing a viewport tag.",
          evidenceRef: "page.home.meta.viewport.present",
          evidence: "<head></head>",
          suggestedFix: "Add a viewport tag.",
          sourceType: "parser",
          verificationStatus: "verified",
          affectedUrls: ["https://example.com/"],
        },
      ],
    );

    expect(result.promotedParserIssueCount).toBe(1);
    expect(result.findings).toHaveLength(2);
    expect(
      result.findings.some(
        (finding) => finding.evidenceRef === "page.home.headings.h1.count",
      ),
    ).toBe(true);
  });
});
