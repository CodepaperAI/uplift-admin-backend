import { createHash } from "node:crypto";
import { buildAuthorBioHtml } from "../utils/blog-author.utils";
import {
  isMalformedPriceEvidence,
  isTextRelevantToTopic,
  topicMatchTokens,
} from "./blog-claim-evidence.service";

export interface AssemblyLink {
  url: string;
  title: string;
  businessId?: string;
}

export interface AssemblyImage {
  url: string;
  altText?: string;
}

export interface VerifiedBusinessAssembly {
  businessName: string | null;
  website: string | null;
  description: string | null;
  phone: string | null;
  location: {
    verified: boolean;
    city: string | null;
    region: string | null;
    country: string | null;
  };
  serviceAreas: string[];
  services: string[];
  operatingFacts: string[];
  reviews?: Array<{
    reviewer: string | null;
    rating: number | null;
    text: string;
  }>;
}

export interface ArticleSchemaInput {
  title: string;
  description: string;
  authorName: string;
  businessName: string;
  businessWebsiteUrl?: string | null;
  canonicalUrl?: string | null;
  featuredImageUrl?: string | null;
  datePublished: string;
  dateModified?: string;
}

export interface ApplicationAssemblyInput {
  html: string;
  title: string;
  businessWebsiteUrl?: string | null;
  allowedExternalUrls: string[];
  internalLinks: AssemblyLink[];
  images: AssemblyImage[];
  verifiedBusiness?: VerifiedBusinessAssembly;
  author?: { name: string; jobTitle: string; expertise: string[] };
  includeKeyTakeaways?: boolean;
  includeLocalTip?: boolean;
  includeReviews?: boolean;
  /** Locked keyword/title used to exclude unrelated inventory and facts. */
  topic?: string;
  /** False for non-location-dependent and broad-reach articles. */
  useLocalFacts?: boolean;
}

export interface ApplicationAssemblyResult {
  html: string;
  featuredImageUrl: string | null;
  insertedInternalLinks: AssemblyLink[];
  insertedBodyImages: AssemblyImage[];
  removedUntrustedExternalLinks: string[];
  headingIds: string[];
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value: string): string {
  const slug = stripTags(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || `section-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
}

function normalizeAbsoluteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function hostFor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    try {
      return new URL(`https://${value}`).hostname
        .replace(/^www\./, "")
        .toLowerCase();
    } catch {
      return null;
    }
  }
}

function ensureStableH2Ids(html: string): {
  html: string;
  headings: Array<{ id: string; text: string }>;
} {
  const used = new Set<string>();
  const headings: Array<{ id: string; text: string }> = [];
  const normalized = html.replace(
    /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi,
    (_match, attrs: string, body: string) => {
      const existing = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const base = slugify(existing || body);
      let id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
      headings.push({ id, text: stripTags(body) });
      const attrsWithoutId = attrs.replace(/\s+id\s*=\s*["'][^"']*["']/gi, "");
      return `<h2${attrsWithoutId} id="${escapeHtml(id)}">${body}</h2>`;
    },
  );
  return { html: normalized, headings };
}

function buildToc(headings: Array<{ id: string; text: string }>): string {
  if (headings.length < 2) return "";
  return [
    '<nav class="toc" data-uplift-component="article-toc" aria-label="Table of contents">',
    '<h2 class="article-toc-title">Table of contents</h2>',
    "<ol>",
    ...headings.map(
      (heading) =>
        `<li><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    ),
    "</ol>",
    "</nav>",
  ].join("");
}

function insertBeforeFirstHeading(html: string, block: string): string {
  if (!block) return html;
  const firstH2 = html.search(/<h2\b/i);
  if (firstH2 >= 0) {
    return `${html.slice(0, firstH2)}${block}\n${html.slice(firstH2)}`;
  }
  return `${block}\n${html}`;
}

/**
 * Remove H3/H4 headings with no content before the next heading — the
 * grounding sanitizer can empty a subsection, leaving a dangling promise
 * heading ("Evaluating Response Protocols…") that reads as broken AI output.
 * Locked H2s stay: deleting one would break the approved outline.
 */
function stripOrphanHeadings(html: string): string {
  // Tempered pattern: the heading body may not cross its own closing tag.
  // A naive [\s\S]*? here backtracks PAST </h3> to satisfy the lookahead and
  // swallows entire subsections (heading + paragraphs + next heading) — that
  // bug once gutted an article to 399 words.
  return html.replace(
    /<h([34])\b[^>]*>(?:(?!<\/h[34]>)[\s\S])*<\/h\1>\s*(?=<h[1-4]\b|<div\b[^>]*data-uplift-assembled|$)/gi,
    "",
  );
}

function buildKeyTakeaways(facts: VerifiedBusinessAssembly | undefined): string {
  const bullets: string[] = [];
  if (facts?.services.length) {
    bullets.push(
      `${facts.businessName} lists ${facts.services.slice(0, 4).join(", ")} among its current services.`,
    );
  }
  if (facts?.operatingFacts.length) {
    bullets.push(`Website-verified details include ${facts.operatingFacts.slice(0, 4).join(", ")}.`);
  }
  if (facts?.serviceAreas.length) {
    bullets.push(`Confirmed service areas include ${facts.serviceAreas.slice(0, 6).join(", ")}.`);
  }
  // No generic filler bullets: a hardcoded catering-era line ("match the
  // format to the event, guest…") shipped in every article across every
  // industry and was instantly flagged by the editorial judge as pasted
  // boilerplate. Keep exactly one closing verification bullet.
  bullets.push(
    "Confirm current pricing and availability directly before committing.",
  );
  return [
    '<div class="key-takeaways" data-uplift-assembled="key-takeaways">',
    "<h2>Key Takeaways</h2>",
    "<ul>",
    ...bullets.slice(0, 5).map((bullet) => `<li>${escapeHtml(bullet)}</li>`),
    "</ul>",
    "</div>",
  ].join("");
}

function buildLocalTip(facts: VerifiedBusinessAssembly | undefined): string {
  const verifiedCity =
    facts?.location.verified && facts.location.city ? facts.location.city : null;
  const serviceAreas = facts?.serviceAreas ?? [];
  // Without a verified city, fall back to the canonical service areas — still
  // packet-grounded. When neither exists the module is unrenderable and the
  // gate must not require it (see the local-tip filter in the save gate).
  if (!verifiedCity && serviceAreas.length === 0) return "";
  const anchorCity = verifiedCity ?? serviceAreas[0]!;
  const coverage = serviceAreas.length
    ? ` Confirmed service areas currently list ${serviceAreas.slice(0, 8).join(", ")}.`
    : "";
  const profileLine = verifiedCity
    ? `${facts?.businessName ?? "The business"} has a verified profile location in ${[
        verifiedCity,
        facts?.location.region ?? null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(", ")}.`
    : "";
  return [
    '<div class="local-tip" data-uplift-assembled="local-tip">',
    `<h3>Local planning note for ${escapeHtml(anchorCity)}</h3>`,
    `<p>${escapeHtml(`${profileLine}${coverage}`.trim())} Confirm coverage for the exact address and current fulfillment details before committing.</p>`,
    "</div>",
  ].join("");
}

function buildReviews(facts: VerifiedBusinessAssembly | undefined): string {
  const reviews = (facts?.reviews ?? []).filter((review) => review.text.trim()).slice(0, 2);
  if (reviews.length === 0) return "";
  return [
    '<div class="reviews" data-uplift-assembled="reviews">',
    "<h3>Verified customer feedback</h3>",
    ...reviews.map((review) => {
      const label = [
        review.reviewer,
        typeof review.rating === "number" ? `${review.rating}/5` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      return `<blockquote><p>${escapeHtml(review.text)}</p>${label ? `<cite>${escapeHtml(label)}</cite>` : ""}</blockquote>`;
    }),
    "</div>",
  ].join("");
}

function scopeVerifiedBusiness(
  facts: VerifiedBusinessAssembly | undefined,
  topic: string,
  useLocalFacts: boolean,
): VerifiedBusinessAssembly | undefined {
  if (!facts) return undefined;
  const hasTopicTerms = topicMatchTokens(topic).length > 0;
  const services = hasTopicTerms
    ? facts.services.filter((service) =>
        isTextRelevantToTopic(service, topic),
      )
    : facts.services;
  const operatingFacts = hasTopicTerms
    ? facts.operatingFacts.filter(
        (fact) =>
          !isMalformedPriceEvidence(fact) &&
          isTextRelevantToTopic(fact, topic),
      )
    : facts.operatingFacts.filter((fact) => !isMalformedPriceEvidence(fact));
  return {
    ...facts,
    location: useLocalFacts
      ? facts.location
      : {
          verified: false,
          city: null,
          region: null,
          country: null,
        },
    serviceAreas: useLocalFacts ? facts.serviceAreas : [],
    services,
    operatingFacts,
  };
}

function insertBeforeClosingSections(html: string, block: string): string {
  if (!block) return html;
  const closing = /<h2\b[^>]*>\s*(?:Frequently asked questions|FAQ|Next steps|Conclusion|Summary)\s*<\/h2>/gi;
  const match = closing.exec(html);
  if (match?.index !== undefined) {
    return `${html.slice(0, match.index)}${block}\n${html.slice(match.index)}`;
  }
  return `${html}\n${block}`;
}

function stripModelOwnedBlocks(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<nav\b(?=[^>]*(?:data-uplift-component=["']article-toc["']|class=["']toc["']))[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<figure\b[^>]*data-uplift-assembled=["']image["'][^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<section\b[^>]*data-uplift-assembled=["']verified-business-facts["'][^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*key-takeaways[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*local-tip[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*reviews[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*author-bio[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim();
}

function buildVerifiedBusinessBlock(
  facts: VerifiedBusinessAssembly | undefined,
): string {
  if (!facts?.businessName) return "";
  const rows: string[] = [];
  if (facts.services.length > 0) {
    const visibleServices = facts.services.slice(0, 3);
    const remaining = Math.max(0, facts.services.length - visibleServices.length);
    rows.push(
      `<p><strong>Verified profile:</strong> ${escapeHtml(facts.businessName)} lists ${visibleServices
        .map(escapeHtml)
        .join(", ")}${remaining > 0 ? `, and ${remaining} additional service${remaining === 1 ? "" : "s"}` : ""}.</p>`,
    );
  }
  if (facts.location.verified) {
    const location = [
      facts.location.city,
      facts.location.region,
      facts.location.country,
    ].filter((value): value is string => Boolean(value));
    if (location.length > 0) {
      rows.push(`<p><strong>Verified location:</strong> ${location.map(escapeHtml).join(", ")}.</p>`);
    }
  }
  if (facts.serviceAreas.length > 0) {
    rows.push(
      `<p><strong>Confirmed service areas:</strong> ${facts.serviceAreas
        .slice(0, 12)
        .map(escapeHtml)
        .join(", ")}.</p>`,
    );
  }
  if (facts.operatingFacts.length > 0) {
    rows.push(
      `<p><strong>Website-verified details:</strong> ${facts.operatingFacts
        .slice(0, 8)
        .map(escapeHtml)
        .join("; ")}.</p>`,
    );
  }
  const website = normalizeAbsoluteUrl(facts.website ?? "");
  if (website) {
    rows.push(
      `<p><a href="${escapeHtml(website)}">Visit ${/^the\s/i.test(facts.businessName ?? "") ? "" : "the "}${escapeHtml(facts.businessName)} website</a> for current details.</p>`,
    );
  }
  if (rows.length === 0) return "";
  return [
    '<section class="verified-business-facts" data-uplift-assembled="verified-business-facts">',
    ...rows,
    "</section>",
  ].join("");
}

function sanitizeAnchors(input: {
  html: string;
  allowedExternalUrls: Set<string>;
  allowedInternalUrls: Set<string>;
  businessHost: string | null;
}): { html: string; removed: string[] } {
  const removed: string[] = [];
  const html = input.html.replace(
    /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, before: string, href: string, after: string, body: string) => {
      if (href.startsWith("#")) return _match;
      const normalized = normalizeAbsoluteUrl(href);
      if (!normalized) {
        removed.push(href);
        return body;
      }
      const host = hostFor(normalized);
      const ownSite = Boolean(
        input.businessHost &&
          host &&
          (host === input.businessHost || host.endsWith(`.${input.businessHost}`)),
      );
      if (
        !ownSite &&
        !input.allowedExternalUrls.has(normalized) &&
        !input.allowedInternalUrls.has(normalized)
      ) {
        removed.push(normalized);
        return body;
      }
      const rel = ownSite ? "" : ' rel="noopener noreferrer"';
      return `<a${before}href="${escapeHtml(normalized)}"${after}${rel}>${body}</a>`;
    },
  );
  return { html, removed: [...new Set(removed)] };
}

function injectInternalLinks(
  html: string,
  candidates: AssemblyLink[],
): { html: string; inserted: AssemblyLink[] } {
  let output = html;
  const inserted: AssemblyLink[] = [];
  const unique = new Map<string, AssemblyLink>();
  for (const candidate of candidates) {
    const url = normalizeAbsoluteUrl(candidate.url);
    const title = stripTags(candidate.title);
    if (url && title && !unique.has(url)) unique.set(url, { ...candidate, url, title });
  }

  const sections = [...output.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)];
  const selected = [...unique.values()].slice(0, Math.min(5, sections.length));
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const candidate = selected[index];
    const section = sections[index];
    if (!candidate || !section || section.index === undefined) continue;
    const insertionPoint = output.indexOf("</p>", section.index);
    if (insertionPoint < 0) continue;
    const sentence = ` For more context, see <a href="${escapeHtml(candidate.url)}">${escapeHtml(candidate.title)}</a>.`;
    output = `${output.slice(0, insertionPoint)}${sentence}${output.slice(insertionPoint)}`;
    inserted.unshift(candidate);
  }
  return { html: output, inserted };
}

function insertBodyImages(
  html: string,
  images: AssemblyImage[],
): { html: string; inserted: AssemblyImage[] } {
  let output = html;
  const valid = images
    .map((image) => ({ ...image, url: normalizeAbsoluteUrl(image.url) ?? "" }))
    .filter((image) => image.url)
    .slice(1, 3);
  const headings = [...output.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)];
  const targetIndexes = [1, 3];
  const inserted: AssemblyImage[] = [];
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const image = valid[index];
    const heading = headings[targetIndexes[index] ?? index] ?? headings[index];
    if (!image || !heading || heading.index === undefined) continue;
    const headingEnd = heading.index + heading[0].length;
    const figure = [
      '<figure class="article-image" data-uplift-assembled="image">',
      `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText || "Article illustration")}" loading="lazy" decoding="async" />`,
      "</figure>",
    ].join("");
    output = `${output.slice(0, headingEnd)}\n${figure}\n${output.slice(headingEnd)}`;
    inserted.unshift(image);
  }
  return { html: output, inserted };
}

export function assembleApplicationOwnedArticle(
  input: ApplicationAssemblyInput,
): ApplicationAssemblyResult {
  let html = stripOrphanHeadings(stripModelOwnedBlocks(input.html));
  const useLocalFacts = input.useLocalFacts !== false;
  const verifiedBusiness = scopeVerifiedBusiness(
    input.verifiedBusiness,
    input.topic ?? input.title,
    useLocalFacts,
  );
  const verifiedBusinessBlock = buildVerifiedBusinessBlock(verifiedBusiness);
  if (input.includeKeyTakeaways) {
    html = insertBeforeClosingSections(html, buildKeyTakeaways(verifiedBusiness));
  }
  if (input.includeLocalTip && useLocalFacts) {
    html = insertBeforeClosingSections(html, buildLocalTip(verifiedBusiness));
  }
  if (input.includeReviews) {
    html = insertBeforeClosingSections(html, buildReviews(verifiedBusiness));
  }
  if (input.author && input.verifiedBusiness?.businessName) {
    html = `${html}\n${buildAuthorBioHtml(
      input.author,
      input.verifiedBusiness.businessName,
      input.verifiedBusiness.website,
    )}`;
  }
  const normalized = ensureStableH2Ids(html);
  html = normalized.html;
  html = insertBeforeFirstHeading(
    html,
    [buildToc(normalized.headings), verifiedBusinessBlock]
      .filter(Boolean)
      .join("\n"),
  );

  const external = new Set(
    input.allowedExternalUrls
      .map(normalizeAbsoluteUrl)
      .filter((url): url is string => Boolean(url)),
  );
  const internal = new Set(
    input.internalLinks
      .map((link) => normalizeAbsoluteUrl(link.url))
      .filter((url): url is string => Boolean(url)),
  );
  const sanitized = sanitizeAnchors({
    html,
    allowedExternalUrls: external,
    allowedInternalUrls: internal,
    businessHost: hostFor(input.businessWebsiteUrl),
  });
  html = sanitized.html;

  const linked = injectInternalLinks(html, input.internalLinks);
  html = linked.html;
  const imaged = insertBodyImages(html, input.images);
  html = imaged.html;

  return {
    html,
    featuredImageUrl: normalizeAbsoluteUrl(input.images[0]?.url ?? ""),
    insertedInternalLinks: linked.inserted,
    insertedBodyImages: imaged.inserted,
    removedUntrustedExternalLinks: sanitized.removed,
    headingIds: normalized.headings.map((heading) => heading.id),
  };
}

export function appendVerifiedArticleJsonLd(
  html: string,
  input: ArticleSchemaInput,
): string {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: {
      "@type": "Person",
      name: input.authorName,
    },
    publisher: {
      "@type": "Organization",
      name: input.businessName,
      ...(input.businessWebsiteUrl ? { url: input.businessWebsiteUrl } : {}),
    },
    ...(input.canonicalUrl ? { mainEntityOfPage: input.canonicalUrl } : {}),
    ...(input.featuredImageUrl ? { image: [input.featuredImageUrl] } : {}),
  };
  const serialized = JSON.stringify(schema).replace(/<\//g, "<\\/");
  return `${html}\n<script type="application/ld+json" data-uplift-assembled="article-schema">${serialized}</script>`;
}
