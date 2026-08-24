import { describe, expect, it } from "bun:test";
import {
  buildSignupAuditInternalIssueEmail,
  buildSignupAuditProspectEmail,
  extractSignupAuditIssues,
  type SignupAuditIssue,
} from "../services/signup-audit-email.service";
import type { SeoAuditFullReport } from "../validators/seo-audit.validation";

function makeReport(): SeoAuditFullReport {
  return {
    overallScore: 62,
    modules: [
      {
        module: "technical",
        score: 55,
        summary: "Technical issues found",
        findings: [
          {
            severity: "warning",
            title: "Viewport tag missing",
            description: "The homepage is missing a responsive viewport declaration.",
            evidenceRef: "page.home.meta.viewport.present",
            evidence: "<head></head>",
            suggestedFix: "Add a standard viewport meta tag.",
            sourceType: "parser",
            verificationStatus: "verified",
            affectedUrls: ["https://example.com/"],
          },
          {
            severity: "pass",
            title: "Canonical present",
            description: "Canonical tag exists.",
            evidenceRef: "page.home.canonical.present",
            evidence: "<link rel='canonical'>",
            suggestedFix: "",
            sourceType: "parser",
            verificationStatus: "verified",
            affectedUrls: ["https://example.com/"],
          },
        ],
        checks: [],
        verificationCoverage: 100,
        status: "ok",
      },
      {
        module: "schema",
        score: 40,
        summary: "Schema issues found",
        findings: [
          {
            severity: "critical",
            title: "Invalid JSON-LD",
            description: "The homepage has JSON-LD that cannot be parsed.",
            evidenceRef: "page.home.schema.jsonld.parseable",
            evidence: "{ invalid json",
            suggestedFix: "Fix or remove the invalid JSON-LD block.",
            sourceType: "parser",
            verificationStatus: "verified",
            affectedUrls: ["https://example.com/"],
          },
          {
            severity: "warning",
            title: "Contradicted model note",
            description: "This should not be emailed.",
            evidenceRef: "model.bad.note",
            evidence: "",
            suggestedFix: "Ignore.",
            sourceType: "ai_assessment",
            verificationStatus: "contradicted",
            affectedUrls: [],
          },
        ],
        checks: [],
        verificationCoverage: 100,
        status: "ok",
      },
    ],
    recommendations: [],
    sources: [],
    crawlCoverage: 100,
    pagesAnalyzed: 1,
  };
}

describe("signup audit email service", () => {
  it("extracts only actionable warning and critical audit issues", () => {
    const issues = extractSignupAuditIssues(makeReport());

    expect(issues).toHaveLength(2);
    expect(issues[0]?.title).toBe("Invalid JSON-LD");
    expect(issues[0]?.severity).toBe("critical");
    expect(issues[1]?.title).toBe("Viewport tag missing");
  });

  it("builds a prospect email with score, issue detail, and demo CTA", () => {
    const issues = extractSignupAuditIssues(makeReport());
    const email = buildSignupAuditProspectEmail({
      userName: "Jamie",
      userEmail: "jamie@example.com",
      businessName: "Example Co",
      websiteUrl: "https://example.com/",
      overallScore: 62,
      issues,
    });

    expect(email.subject).toContain("Example Co");
    expect(email.text).toContain("62/100");
    expect(email.text).toContain("Invalid JSON-LD");
    expect(email.text).toContain("Book a demo:");
    expect(email.html).toContain("href=");
  });

  it("builds a separate internal issue email with prospect context", () => {
    const issue: SignupAuditIssue = {
      module: "technical",
      severity: "warning",
      title: "Missing H1",
      description: "The homepage does not have a primary H1.",
      evidence: "Detected 0 H1 tags.",
      suggestedFix: "Add one descriptive H1.",
      affectedUrls: ["https://example.com/"],
    };

    const email = buildSignupAuditInternalIssueEmail({
      userName: "Jamie",
      userEmail: "jamie@example.com",
      businessName: "Example Co",
      websiteUrl: "https://example.com/",
      overallScore: 62,
      issue,
      issueIndex: 0,
      issueCount: 1,
    });

    expect(email.subject).toContain("Signup audit");
    expect(email.text).toContain("Jamie <jamie@example.com>");
    expect(email.text).toContain("Missing H1");
    expect(email.text).toContain("Affected URLs:");
  });
});
