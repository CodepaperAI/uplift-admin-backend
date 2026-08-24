/**
 * blog-author.utils.ts
 *
 * Resolves a CREDIBLE author identity for a blog's E-E-A-T byline + author bio.
 *
 * The bug this fixes: when a business has no explicit `authorName`, the pipeline
 * fell back to the owner account's `User.name` — which for these records is a
 * junk/PII test value ("Car Detailinig", "Jenish Clean", "Tester Testing") that
 * then appeared on the public byline. We never use `User.name` for the byline.
 *
 * Resolution:
 *   1. A real configured author (valid `authorName`, not a placeholder) is used
 *      as-is, with its job title + expertise.
 *   2. Otherwise a branded TEAM byline ("The {Business} Team") — a legitimate
 *      org-author E-E-A-T pattern — with a role + expertise derived from the
 *      business type and its real services.
 */

export interface ResolvedBlogAuthor {
  name: string;
  jobTitle: string;
  expertise: string[];
  isTeam: boolean;
}

const PLACEHOLDER_NAME =
  /\b(test|tester|testing|demo|sample|admin|administrator|account|owner|placeholder|unknown|n\/?a|na|asdf|qwerty|foo|bar|xxx|user\d*)\b/i;

function clean(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => clean(v)).filter((v): v is string => v !== null);
}

function isPlaceholderName(name: string): boolean {
  if (name.length < 2) return true;
  if (PLACEHOLDER_NAME.test(name)) return true;
  // A single lowercase token or obvious gibberish is not a credible byline.
  return false;
}

/**
 * @param business the business record (may include authorName/authorJobTitle/authorExpertise)
 * @param services the business's real, resolved service names (used to derive
 *   grounded expertise for a team byline)
 */
export function resolveBlogAuthor(
  business: Record<string, unknown>,
  services: string[] = [],
): ResolvedBlogAuthor {
  const name = clean(business.authorName);
  const jobTitle = clean(business.authorJobTitle);
  const expertise = toStringArray(business.authorExpertise);
  const businessName = clean(business.businessName) ?? "Our";
  const businessType = clean(business.businessType);

  const derivedExpertise = expertise.length
    ? expertise
    : services.slice(0, 4);

  // 1) Real, credible individual author.
  if (name && !isPlaceholderName(name)) {
    return {
      name,
      jobTitle: jobTitle ?? `Contributor at ${businessName}`,
      expertise: derivedExpertise,
      isTeam: false,
    };
  }

  // 2) Branded team byline (never the owner's User.name). Businesses named
  // "The …" must not double the article ("The The Hamilton Plumber Team").
  return {
    name: /^the\s/i.test(businessName)
      ? `${businessName} Team`
      : `The ${businessName} Team`,
    jobTitle: `Editorial team at ${businessName}`,
    expertise: derivedExpertise,
    isTeam: true,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Deterministic Author E-E-A-T bio block, built entirely from resolved author
 * data (never the model). Used to GUARANTEE the mandatory author-bio module
 * renders with correct, grounded data even when the model omits it. Emits the
 * exact `author-bio` marker the module gate checks for.
 */
export function buildAuthorBioHtml(
  author: { name: string; jobTitle: string; expertise: string[] },
  businessName: string,
  websiteUrl?: string | null,
): string {
  const name = escapeHtml(author.name);
  const role = escapeHtml(author.jobTitle);
  const biz = escapeHtml(businessName || author.name);
  const expertise = author.expertise
    .slice(0, 4)
    .map((e) => escapeHtml(e))
    .filter(Boolean);
  const expSentence = expertise.length
    ? ` Our team's focus areas include ${expertise.join(", ")}.`
    : "";
  const link =
    websiteUrl && /^https?:\/\//i.test(websiteUrl)
      ? ` Learn more at <a href="${escapeHtml(websiteUrl)}">${biz}</a>.`
      : "";
  return (
    `<div class="author-bio" data-uplift-assembled="author-bio">` +
    `<h3>About the Author</h3>` +
    `<p><strong>${name}</strong> — ${role}.${expSentence}${link}</p>` +
    `</div>`
  );
}
