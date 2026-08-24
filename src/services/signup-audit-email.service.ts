import { Resend } from "resend";
import { BRAND } from "../config/brand.config";
import type {
  SeoAuditFindingSeverity,
  SeoAuditFullReport,
  SeoAuditModule,
  SeoAuditModuleFinding,
} from "../validators/seo-audit.validation";

export type SignupAuditIssue = {
  module: SeoAuditModule;
  severity: Exclude<SeoAuditFindingSeverity, "pass">;
  title: string;
  description: string;
  evidence: string;
  suggestedFix: string;
  affectedUrls: string[];
};

type SignupAuditEmailBundle = {
  subject: string;
  html: string;
  text: string;
};

type ProspectEmailInput = {
  userName: string;
  userEmail: string;
  businessName: string;
  websiteUrl: string;
  overallScore: number;
  issues: SignupAuditIssue[];
};

type InternalIssueEmailInput = {
  userName: string;
  userEmail: string;
  businessName: string;
  websiteUrl: string;
  overallScore: number;
  issue: SignupAuditIssue;
  issueIndex: number;
  issueCount: number;
};

type SendResult = {
  success: boolean;
  emailId?: string;
  error?: string;
};

type ActionableAuditFinding = SeoAuditModuleFinding & {
  severity: SignupAuditIssue["severity"];
};

const FROM_EMAIL = BRAND.fromEmail;
const FROM_NAME = BRAND.fromName;
const APP_URL = BRAND.frontendUrl;
const MEETING_URL = BRAND.meetingUrl;

const MODULE_LABELS: Record<SeoAuditModule, string> = {
  technical: "Technical SEO",
  schema: "Schema",
  geo: "Local/GEO visibility",
  sitemap: "Sitemap",
  hreflang: "International SEO",
  competitorPages: "Competitive coverage",
  plan: "Action plan",
};

const MODULE_PRIORITY: Record<SeoAuditModule, number> = {
  technical: 0,
  schema: 1,
  geo: 2,
  sitemap: 3,
  hreflang: 4,
  competitorPages: 5,
  plan: 6,
};

const SEVERITY_PRIORITY: Record<SignupAuditIssue["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function cleanText(value: string | null | undefined, fallback = "") {
  return (value ?? fallback).replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSeverity(severity: SignupAuditIssue["severity"]) {
  return severity === "critical" ? "Critical" : severity === "warning" ? "Warning" : "Info";
}

function getIssueLimit() {
  const raw = Number.parseInt(process.env.SIGNUP_AUDIT_INTERNAL_ISSUE_LIMIT ?? "", 10);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(Math.max(raw, 1), 25);
}

function isActionableFinding(
  finding: SeoAuditModuleFinding,
): finding is ActionableAuditFinding {
  return (
    (finding.severity === "critical" || finding.severity === "warning") &&
    finding.verificationStatus !== "contradicted" &&
    finding.verificationStatus !== "module_error"
  );
}

export function extractSignupAuditIssues(
  report: SeoAuditFullReport,
  limit = getIssueLimit(),
): SignupAuditIssue[] {
  const seen = new Set<string>();
  const issues = report.modules
    .flatMap((moduleReport) =>
      moduleReport.findings
        .filter(isActionableFinding)
        .map((finding): SignupAuditIssue => ({
          module: moduleReport.module,
          severity: finding.severity,
          title: cleanText(finding.title, "Website issue found"),
          description: cleanText(finding.description),
          evidence: truncateText(finding.evidence || finding.evidenceRef, 400),
          suggestedFix: cleanText(finding.suggestedFix),
          affectedUrls: Array.from(
            new Set(
              finding.affectedUrls
                .map((url) => cleanText(url))
                .filter(Boolean),
            ),
          ).slice(0, 5),
        })),
    )
    .filter((issue) => {
      const key = `${issue.module}:${issue.title.toLowerCase()}:${issue.affectedUrls.join("|")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const severityDelta = SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return MODULE_PRIORITY[a.module] - MODULE_PRIORITY[b.module];
    });

  return issues.slice(0, limit);
}

function buildIssueListHtml(issues: SignupAuditIssue[], limit: number) {
  return issues
    .slice(0, limit)
    .map(
      (issue) => `
        <li style="margin: 0 0 18px 0;">
          <div style="font-weight: 700; color: #171717; font-size: 15px;">${escapeHtml(issue.title)}</div>
          <div style="color: #6b7280; font-size: 13px; margin: 4px 0 8px 0;">${escapeHtml(formatSeverity(issue.severity))} · ${escapeHtml(MODULE_LABELS[issue.module])}</div>
          <div style="color: #374151; font-size: 14px; line-height: 1.6;">${escapeHtml(truncateText(issue.description, 260))}</div>
          ${issue.suggestedFix ? `<div style="color: #374151; font-size: 14px; line-height: 1.6; margin-top: 8px;"><strong>Fix:</strong> ${escapeHtml(truncateText(issue.suggestedFix, 240))}</div>` : ""}
        </li>
      `,
    )
    .join("");
}

export function buildSignupAuditProspectEmail(
  input: ProspectEmailInput,
): SignupAuditEmailBundle {
  const topIssueCount = Math.min(input.issues.length, 5);
  const subject = `${input.businessName}: ${input.issues.length} website issue${input.issues.length === 1 ? "" : "s"} found`;
  const safeName = escapeHtml(input.userName || "there");
  const safeBusiness = escapeHtml(input.businessName || "your business");
  const safeWebsite = escapeHtml(input.websiteUrl);
  const issueText = input.issues
    .slice(0, topIssueCount)
    .map(
      (issue, index) =>
        `${index + 1}. [${formatSeverity(issue.severity)} / ${MODULE_LABELS[issue.module]}] ${issue.title}: ${truncateText(issue.description, 220)}${issue.suggestedFix ? ` Fix: ${truncateText(issue.suggestedFix, 180)}` : ""}`,
    )
    .join("\n");

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:0; background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; color:#171717;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:32px 18px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px; border:1px solid #e5e7eb; border-radius:14px; overflow:hidden;">
          <tr>
            <td style="padding:30px 30px 12px 30px;">
              <p style="margin:0 0 12px 0; color:#6b7280; font-size:14px;">${safeWebsite}</p>
              <h1 style="margin:0; color:#171717; font-size:26px; line-height:1.25;">We found ${input.issues.length} website issue${input.issues.length === 1 ? "" : "s"} that may be holding back ${safeBusiness}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 30px 8px 30px;">
              <p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">Hi ${safeName},</p>
              <p style="margin:0 0 16px 0; color:#374151; font-size:15px; line-height:1.7;">We ran a quick technical and visibility audit for your site. The score came back at <strong>${input.overallScore}/100</strong>. A few of the issues below can make it harder for search engines and AI answer engines to understand, trust, or recommend your business.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 30px 6px 30px;">
              <ol style="padding-left:22px; margin:0;">
                ${buildIssueListHtml(input.issues, topIssueCount)}
              </ol>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 30px 30px 30px;">
              <p style="margin:0 0 20px 0; color:#374151; font-size:15px; line-height:1.7;">Nothing here is meant to scare you; these are fixable items. The important part is handling them before they quietly cost you more leads.</p>
              <a href="${escapeHtml(MEETING_URL)}" style="display:inline-block; background:#171717; color:#ffffff; text-decoration:none; padding:13px 18px; border-radius:999px; font-weight:700; font-size:14px;">Book a demo</a>
              <p style="margin:22px 0 0 0; color:#6b7280; font-size:12px; line-height:1.6;">You are receiving this because you signed up for ${escapeHtml(BRAND.name)}. Prefer not to receive these audit follow-ups? Reply to this email and we will remove you.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${input.userName || "there"},`,
    "",
    `We ran a quick technical and visibility audit for ${input.businessName} (${input.websiteUrl}). The score came back at ${input.overallScore}/100.`,
    "",
    `Top issue${topIssueCount === 1 ? "" : "s"}:`,
    issueText,
    "",
    "These are fixable items. The important part is handling them before they quietly cost you more leads.",
    `Book a demo: ${MEETING_URL}`,
    "",
    `You are receiving this because you signed up for ${BRAND.name}. Prefer not to receive these audit follow-ups? Reply to this email and we will remove you.`,
  ].join("\n");

  return { subject, html, text };
}

export function buildSignupAuditInternalIssueEmail(
  input: InternalIssueEmailInput,
): SignupAuditEmailBundle {
  const subject = `[Signup audit] ${formatSeverity(input.issue.severity)} issue for ${input.businessName}`;
  const affectedUrls =
    input.issue.affectedUrls.length > 0
      ? input.issue.affectedUrls.map((url) => `- ${url}`).join("\n")
      : "- No specific URL attached";
  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:24px; background:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; color:#171717;">
  <div style="max-width:720px; border:1px solid #e5e7eb; border-radius:12px; padding:24px;">
    <p style="margin:0 0 10px 0; color:#6b7280;">Issue ${input.issueIndex + 1} of ${input.issueCount} · ${escapeHtml(formatSeverity(input.issue.severity))} · ${escapeHtml(MODULE_LABELS[input.issue.module])}</p>
    <h1 style="margin:0 0 16px 0; font-size:22px;">${escapeHtml(input.issue.title)}</h1>
    <p style="margin:0 0 16px 0; line-height:1.6;">${escapeHtml(input.issue.description)}</p>
    <p style="margin:0 0 16px 0; line-height:1.6;"><strong>Suggested fix:</strong> ${escapeHtml(input.issue.suggestedFix || "Review the audit evidence and propose a fix.")}</p>
    <p style="margin:0 0 16px 0; line-height:1.6;"><strong>Evidence:</strong> ${escapeHtml(input.issue.evidence || "No evidence snippet available.")}</p>
    <div style="background:#f9fafb; border-radius:10px; padding:16px; margin:18px 0;">
      <p style="margin:0 0 8px 0;"><strong>Prospect:</strong> ${escapeHtml(input.userName)} &lt;${escapeHtml(input.userEmail)}&gt;</p>
      <p style="margin:0 0 8px 0;"><strong>Business:</strong> ${escapeHtml(input.businessName)}</p>
      <p style="margin:0 0 8px 0;"><strong>Website:</strong> ${escapeHtml(input.websiteUrl)}</p>
      <p style="margin:0;"><strong>Audit score:</strong> ${input.overallScore}/100</p>
    </div>
    <p style="margin:0 0 8px 0;"><strong>Affected URLs:</strong></p>
    <pre style="white-space:pre-wrap; background:#f9fafb; border-radius:10px; padding:14px; color:#374151;">${escapeHtml(affectedUrls)}</pre>
    <p style="margin:18px 0 0 0;"><a href="${escapeHtml(APP_URL)}dashboard/superadmin/overview" style="color:#171717;">Open ${escapeHtml(BRAND.name)}</a></p>
  </div>
</body>
</html>`;
  const text = [
    `Issue ${input.issueIndex + 1} of ${input.issueCount}: ${input.issue.title}`,
    `Severity: ${formatSeverity(input.issue.severity)}`,
    `Module: ${MODULE_LABELS[input.issue.module]}`,
    "",
    input.issue.description,
    "",
    `Suggested fix: ${input.issue.suggestedFix || "Review the audit evidence and propose a fix."}`,
    `Evidence: ${input.issue.evidence || "No evidence snippet available."}`,
    "",
    `Prospect: ${input.userName} <${input.userEmail}>`,
    `Business: ${input.businessName}`,
    `Website: ${input.websiteUrl}`,
    `Audit score: ${input.overallScore}/100`,
    "",
    "Affected URLs:",
    affectedUrls,
  ].join("\n");

  return { subject, html, text };
}

export function getSignupAuditInternalRecipients(): string[] {
  const raw =
    process.env.SIGNUP_AUDIT_INTERNAL_EMAILS ||
    process.env.QUOTA_ALERT_EMAIL ||
    "info@codepaper.com";

  return raw
    .split(",")
    .map((email) => email.trim())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

async function sendEmail(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: string; value: string }>;
}): Promise<SendResult> {
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "RESEND_API_KEY is not configured" };
  }
  if (input.to.length === 0) {
    return { success: false, error: "No recipients configured" };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    tags: input.tags,
  });

  if (result.error) {
    return {
      success: false,
      error: result.error.message || "Failed to send email",
    };
  }

  return { success: true, emailId: result.data?.id ?? "" };
}

export async function sendSignupAuditProspectEmail(
  input: ProspectEmailInput,
): Promise<SendResult> {
  const email = buildSignupAuditProspectEmail(input);
  return sendEmail({
    to: [input.userEmail],
    ...email,
    tags: [
      { name: "type", value: "signup-audit-prospect" },
      { name: "category", value: "nurture" },
    ],
  });
}

export async function sendSignupAuditInternalIssueEmail(
  input: InternalIssueEmailInput,
): Promise<SendResult> {
  const email = buildSignupAuditInternalIssueEmail(input);
  return sendEmail({
    to: getSignupAuditInternalRecipients(),
    ...email,
    tags: [
      { name: "type", value: "signup-audit-internal" },
      { name: "category", value: "internal-alert" },
    ],
  });
}
