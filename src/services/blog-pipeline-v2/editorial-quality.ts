import { load } from "cheerio";

import {
  BLOG_PIPELINE_V2_TITLE_MAX_CHARS,
  BLOG_PIPELINE_V2_TITLE_MIN_CHARS,
} from "./constants";

export const BLOG_EDITORIAL_QUALITY_CONTRACT = [
  "UPLIFT AI BLOG SEO / AIO / GEO / AEO PUBLICATION CONTRACT:",
  "- Topic fidelity: the title, H1, meta description, direct answer, headings, body, FAQ, and conclusion must answer the same primary keyword and search intent. Reject an adjacent, broader, sensational, clickbait, or unsupported angle. Deliver every promise made by the title.",
  "- Title and metadata: write a unique 50-60 character title and aim for 52-58 so the hard limit has a safety margin. Begin with the exact primary keyword only when it reads naturally. When the keyword is a long, compressed, or query-like phrase, treat it as an intent brief rather than text to paste: preserve every meaningful concept while reordering words, adding necessary grammar, or inflecting singulars and plurals so the title reads naturally aloud; lead with the core topic and never force an awkward raw search string. Use the exact final title as the only H1. Write a unique, accurate plain-text meta description of 140-155 characters and aim for 145-148; normalize whitespace, count every character including spaces and punctuation, rewrite and recount until it is inside the hard range. Express the primary topic naturally, state a concrete reader benefit or decision, and summarize the article rather than advertise vaguely.",
  "- Evidence-backed promises: a title or slug that promises reviews, ratings, prices, costs, rankings, statistics, compliance, case results, or a numbered set creates an exact content obligation. Select that angle only when the supplied business data or accepted evidence can fulfil it completely. Use only real, attributable review records when a review angle is genuinely supported; never turn a rating summary into a quotation or invent a reviewer, result, aggregate score, price, or compliance claim. When the evidence is insufficient, choose an honest narrower angle before writing instead of filling the article with adjacent advice.",
  "- Keyword use: treat the primary keyword as the article's search-intent specification, not a literal insertion quota. Express its meaningful concepts naturally across the title, H1, opening answer, at least one useful heading, meta description, body, FAQ, and conclusion. Use an exact phrase only where a fluent editor would keep it; for a long, compressed, or query-like keyword, add grammar, reorder terms, and use natural inflections. Never paste an awkward raw query, count exact occurrences, keyword-stuff, or repeat close variants merely to satisfy SEO mechanics.",
  "- Direct answer and AI-search structure: immediately after the H1, add <aside class=\"blog-key-takeaway\" data-uplift-component=\"direct-answer\"><strong>Key takeaway:</strong><p>...</p></aside>. Its first sentence must answer the primary search intent directly in natural language; do not force it to begin with a raw keyword string. Its paragraph must give a quotable, self-contained answer in two or three sentences. Then use a logical H2/H3 hierarchy built from specific reader questions, decisions, comparisons, entities, and outcomes. Never skip heading levels, use H4-H6, or put the labels AIO, GEO, AEO, or AI optimization into reader-facing headings unless they are genuinely the topic.",
  "- Helpfulness and E-E-A-T: write specific, checkable, client-relevant guidance from supplied facts and evidence. Use named steps, real constraints, supported numbers, standards, services, and local details where supplied. A paragraph that could be moved unchanged to a competitor after replacing the business name is too generic. Do not invent facts to create specificity.",
  "- Scannability and semantic structure: keep most paragraphs to two to four sentences. Use a list for a genuine sequence or checklist and a semantic HTML table for a genuine side-by-side comparison. Cost drivers, decision factors, steps, and other independently useful subtopics must use descriptive H3 headings rather than bold text pretending to be a heading. Do not turn ordinary prose into decorative lists or force a table where the evidence does not support one.",
  "- Contextual link inventory: every URL in approvedContextualLinks has already passed application relevance checks. Assign each one to exactly one relevant educational body section and use it exactly once before the FAQ. Never omit it, repeat it in the FAQ or CTA, move it to a resources list, or use it as evidence unless it also appears in acceptedResearchEvidence.",
  "- Internal links: use every supplied approved same-site link exactly once in a relevant body paragraph, aiming for three to five when at least three approved candidates exist. If fewer are supplied, use each available candidate and never invent, guess, or derive another URL. Prioritize service pages, the cluster pillar, and closely related articles. Write concise, varied, destination-specific anchors that describe what readers will find. Never use click here, learn more, read more, website, resource, or repeat one anchor across destinations.",
  "- External links: use one or two directly relevant authoritative citations when accepted evidence is supplied. Use only approved URLs. Every off-site HTML anchor—including a managed backlink—must include rel=\"nofollow noopener noreferrer\". Same-site internal links must remain followable.",
  "- Search Console and cannibalization: treat the supplied search-performance snapshot as planning evidence, not article evidence. Do not create a duplicate angle for an existing ranking page. When competing pages are listed, choose a clearly complementary cluster angle and use the strongest relevant existing page as contextual internal support when it is approved.",
  "- Topic clusters: respect the supplied cluster name, pillar, role, and sibling coverage. A pillar should cover the broad decision space; a supporting article should answer its narrower intent without repeating a sibling's primary promise.",
  "- URL slug: return a short lowercase hyphenated slug whose contiguous words include the normalized primary keyword. Remove filler, dates, and marketing language unless they are part of the keyword.",
  "- FAQ and ending: put a genuine topic-specific FAQ after all educational body sections. Write four to six search-style H3 questions, each followed by a self-contained two-to-four-sentence answer that matches the visible FAQPage schema the application will build. Follow it with one concise final CTA H2 as the article's last heading and section. Only that final CTA may use the official homepage URL.",
  "- Images and alt text: plan one concrete, realistic visual scene for each requested image, with two supporting body visuals in addition to the featured image. For pricing or comparison content, make at least one visual useful to that decision. Every alt text must be unique and clearly, concisely describe the visible subject, setting, and action or decision detail. Do not keyword-stuff or use generic labels such as image, picture, photo, logo, blog, article illustration, editorial feature image, explained, or practical considerations.",
  "- Local relevance: when verified locations or service areas are supplied and the topic is locally dependent, weave in two or three genuinely relevant municipalities, neighbourhoods, regulations, climate details, or service-area facts. Never fabricate or mechanically list locations.",
  "- Publication data: do not write JSON-LD, canonical tags, robots tags, Open Graph tags, Twitter tags, Review schema, AggregateRating schema, or hidden metadata inside the article. The application owns publication metadata and builds BlogPosting, FAQPage, and BreadcrumbList schema from the final visible content so they cannot drift. Never imply that review or rating schema exists when no genuine visible review records were supplied.",
  "Before returning, silently compare every public field and section against this contract and correct any mismatch.",
].join("\n");

const TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "best",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "with",
  "your",
]);

function stemTopicToken(value: string): string {
  if (value.length > 5 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) {
    return value.slice(0, -1);
  }
  return value;
}

export function editorialTopicTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !TOPIC_STOP_WORDS.has(token))
        .map(stemTopicToken),
    ),
  ];
}

export function primaryKeywordSlug(keyword: string): string {
  return keyword
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function productionSlugIssues(slug: string, keyword: string): string[] {
  const normalizedSlug = primaryKeywordSlug(slug.replace(/^\/+|\/+$/g, ""));
  const keywordSlug = primaryKeywordSlug(keyword);
  const maximumLength = Math.max(72, keywordSlug.length + 16);
  return [
    !normalizedSlug || slug !== normalizedSlug ? "slug_not_lowercase_hyphenated" : null,
    keywordSlug && !normalizedSlug.includes(keywordSlug)
      ? `slug_missing_primary_keyword:${keywordSlug}`
      : null,
    normalizedSlug.length > maximumLength
      ? `slug_too_long:${normalizedSlug.length}>${maximumLength}`
      : null,
    /(?:^|-)(?:19|20)\d{2}(?:-|$)/.test(normalizedSlug) &&
    !/(?:^|-)(?:19|20)\d{2}(?:-|$)/.test(keywordSlug)
      ? "slug_contains_unrequested_year"
      : null,
  ].filter((issue): issue is string => Boolean(issue));
}

export function descriptiveAltTextIssues(value: string): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  return [
    words.length < 5 ? `alt_text_too_vague:${words.length}_words` : null,
    words.length > 24 || normalized.length > 160
      ? `alt_text_not_concise:${words.length}_words_${normalized.length}_characters`
      : null,
    /^(?:image|picture|photo|photograph|illustration|logo|blog)\b|\b(?:article illustration|editorial feature image|useful image|explained|practical considerations)\b/i.test(
      normalized,
    )
      ? "alt_text_generic_label"
      : null,
  ].filter((issue): issue is string => Boolean(issue));
}

export function anchorTextRelevanceIssues(
  anchorText: string,
  destinationTitle: string,
  surroundingText: string,
): string[] {
  const normalizedAnchor = anchorText.replace(/\s+/g, " ").trim();
  const anchorTokens = new Set(editorialTopicTokens(normalizedAnchor));
  const destinationTokens = editorialTopicTokens(destinationTitle);
  const surroundingTokens = new Set(editorialTopicTokens(surroundingText));
  const anchorOverlap = destinationTokens.filter((token) => anchorTokens.has(token)).length;
  const contextOverlap = destinationTokens.filter((token) => surroundingTokens.has(token)).length;
  return [
    anchorTokens.size < 2 ||
    /^(?:click here|learn more|read more|visit(?: the)? website|website|resource|related resource|planning resource)$/i.test(
      normalizedAnchor,
    )
      ? "weak_anchor_text"
      : null,
    anchorOverlap < 1 ? "anchor_not_destination_specific" : null,
    contextOverlap < 1 ? "link_not_relevant_to_surrounding_text" : null,
  ].filter((issue): issue is string => Boolean(issue));
}

function normalizedHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLocaleLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isSameProductionWebsite(url: string, websiteUrl: string): boolean {
  const targetHost = normalizedHostname(url);
  const websiteHost = normalizedHostname(websiteUrl);
  return Boolean(
    targetHost &&
      websiteHost &&
      (targetHost === websiteHost ||
        targetHost.endsWith(`.${websiteHost}`) ||
        websiteHost.endsWith(`.${targetHost}`)),
  );
}

export function normalizeProductionLinkRelations(
  html: string,
  websiteUrl: string,
): string {
  const $ = load(html, null, false);
  $("a[href]").each((_index, anchor) => {
    const href = ($(anchor).attr("href") ?? "").trim();
    if (!/^https?:\/\//i.test(href)) return;
    const existing = new Set(
      ($(anchor).attr("rel") ?? "")
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    );
    const required = isSameProductionWebsite(href, websiteUrl)
      ? [...existing].filter((token) => !["nofollow", "sponsored", "ugc"].includes(token))
      : [...existing, "nofollow", "noopener", "noreferrer"];
    const rel = [...new Set(required)].join(" ");
    if (rel) $(anchor).attr("rel", rel);
    else $(anchor).removeAttr("rel");
  });
  return $.html().trim();
}

export function answerEngineHeadingIssues(html: string): string[] {
  const $ = load(html, null, false);
  const seen = new Set<string>();
  const issues: string[] = [];
  $("h2,h3").each((_index, heading) => {
    const text = $(heading).text().replace(/\s+/g, " ").trim();
    const normalized = text.toLocaleLowerCase();
    if (/^(?:introduction|overview|background|more information|more info|conclusion|summary)$/i.test(text)) {
      issues.push(`generic_heading:${normalized}`);
    }
    if (seen.has(normalized)) issues.push(`duplicate_heading:${normalized}`);
    seen.add(normalized);
  });
  return [...new Set(issues)];
}

export function productionTitleTagIssues(title: string, _keyword = ""): string[] {
  const length = title.replace(/\s+/g, " ").trim().length;
  // Keyword wording is an editorial prompt responsibility. Publication only
  // enforces the objective title bounds here so natural variants are not
  // discarded by brittle string matching after the model has written them.
  return [
    length < BLOG_PIPELINE_V2_TITLE_MIN_CHARS
      ? `title_below_${BLOG_PIPELINE_V2_TITLE_MIN_CHARS}_characters:${length}`
      : null,
    length > BLOG_PIPELINE_V2_TITLE_MAX_CHARS
      ? `title_above_${BLOG_PIPELINE_V2_TITLE_MAX_CHARS}_characters:${length}`
      : null,
  ].filter((issue): issue is string => Boolean(issue));
}
