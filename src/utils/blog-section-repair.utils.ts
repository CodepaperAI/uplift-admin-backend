import { createHash } from "node:crypto";

import type { GroundingIssue } from "./blog-grounding.utils";

export interface BlogHtmlSection {
  id: string;
  heading: string | null;
  html: string;
  hash: string;
}

export interface SectionValidationFailure {
  sectionId: string;
  claimExcerpt: string;
  reason: string;
  issueKind: GroundingIssue["kind"] | "structure" | "phrase" | "length";
  allowedFacts: string[];
}

function stripTags(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionId(heading: string, index: number): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug ? `section-${index}-${slug}` : `section-${index}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripApplicationOwnedRepairBlocks(html: string): string {
  return String(html ?? "")
    .replace(
      /<nav\b[^>]*(?:data-uplift-component=["']article-toc["']|class=["'][^"']*\btoc\b[^"']*["'])[^>]*>[\s\S]*?<\/nav>/gi,
      "",
    )
    .replace(
      /<(section|div|aside)\b(?=[^>]*data-uplift-assembled=["'](?:verified-business-facts|key-takeaways|local-tip|reviews|author-bio)["'])[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(
      /<figure\b[^>]*data-uplift-assembled=["']image["'][^>]*>[\s\S]*?<\/figure>/gi,
      "",
    )
    .replace(
      /<script\b[^>]*data-uplift-assembled=["']article-schema["'][^>]*>[\s\S]*?<\/script>/gi,
      "",
    )
    .trim();
}

export function splitBlogHtmlSections(html: string): BlogHtmlSection[] {
  const source = String(html ?? "");
  const headings = [...source.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)];
  if (headings.length === 0) {
    return [{ id: "document", heading: null, html: source, hash: hash(source) }];
  }

  const sections: BlogHtmlSection[] = [];
  const firstStart = headings[0]?.index ?? 0;
  if (firstStart > 0) {
    const intro = source.slice(0, firstStart);
    sections.push({ id: "intro", heading: null, html: intro, hash: hash(intro) });
  }

  headings.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? source.length;
    const sectionHtml = source.slice(start, end);
    const heading = stripTags(match[0] ?? "");
    const outlineId = (match[0] ?? "").match(
      /\bdata-outline-id\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    sections.push({
      id: outlineId ?? sectionId(heading, index + 1),
      heading,
      html: sectionHtml,
      hash: hash(sectionHtml),
    });
  });
  return sections;
}

export function locateFailureSection(
  html: string,
  excerpt: string,
): string {
  const needle = stripTags(excerpt).toLowerCase();
  if (!needle) return "document";
  const compactNeedle = needle.slice(0, 120);
  const section = splitBlogHtmlSections(html).find((candidate) =>
    stripTags(candidate.html).toLowerCase().includes(compactNeedle),
  );
  return section?.id ?? "document";
}

export function mapGroundingIssuesToSections(
  html: string,
  issues: GroundingIssue[],
  allowedFacts: string[],
): SectionValidationFailure[] {
  return issues.map((issue) => ({
    sectionId: locateFailureSection(html, issue.excerpt),
    claimExcerpt: issue.excerpt,
    reason: issue.reason,
    issueKind: issue.kind,
    allowedFacts,
  }));
}

export function preservePassingSections(input: {
  previousHtml: string;
  candidateHtml: string;
  failedSectionIds: string[];
}): { html: string; restoredSectionIds: string[] } {
  const failed = new Set(input.failedSectionIds);
  if (failed.has("document")) {
    return { html: input.candidateHtml, restoredSectionIds: [] };
  }

  const previous = splitBlogHtmlSections(
    stripApplicationOwnedRepairBlocks(input.previousHtml),
  );
  const candidate = new Map(
    splitBlogHtmlSections(stripApplicationOwnedRepairBlocks(input.candidateHtml)).map(
      (section) => [section.id, section],
    ),
  );
  const restoredSectionIds: string[] = [];
  const html = previous
    .map((section) => {
      if (failed.has(section.id)) {
        return candidate.get(section.id)?.html ?? section.html;
      }
      restoredSectionIds.push(section.id);
      return section.html;
    })
    .join("");

  return { html, restoredSectionIds };
}

export function buildSectionRepairInstruction(
  failures: SectionValidationFailure[],
): string {
  const grouped = new Map<string, SectionValidationFailure[]>();
  for (const failure of failures) {
    const current = grouped.get(failure.sectionId) ?? [];
    current.push(failure);
    grouped.set(failure.sectionId, current);
  }

  const blocks = [...grouped.entries()].map(([id, entries]) => {
    const details = entries
      .map(
        (entry) =>
          `- ${entry.issueKind}: "${entry.claimExcerpt}" (${entry.reason})`,
      )
      .join("\n");
    const allowed = [...new Set(entries.flatMap((entry) => entry.allowedFacts))];
    return [
      `SECTION ${id}`,
      details,
      allowed.length > 0
        ? `Allowed business facts: ${allowed.join(" | ")}`
        : "Allowed business facts: none; omit the unsupported claim.",
    ].join("\n");
  });

  return [
    "SECTION-ONLY REPAIR CONTRACT",
    "Modify only the sections listed below. Passing sections are immutable and will be restored by the application.",
    "Remove unsupported claims instead of replacing them with plausible alternatives.",
    "Submit the complete payload through save-blog-info because that is the transport contract; unchanged sections must remain present.",
    ...blocks,
  ].join("\n\n");
}
