/**
 * offpage-research.service.ts
 *
 * Assembles the BusinessResearchBrief — the DEEP, business-specific context that
 * lets the research agents produce concrete, leverageable off-page suggestions
 * instead of generic ones. Pulls the full scraped profile (WebsiteAnalysis →
 * businessInfo / coreServices / recognition / brandIdentity), the geo profile,
 * and competitor intelligence. Pure (no I/O): the caller loads the Business with
 * those relations and hands the record + the already-built profile here.
 */

import type {
  BusinessOffPageProfile,
  BusinessResearchBrief,
} from "./offpage-types";
import { pickBusinessCity } from "./offpage-location";

/** Loose, structural shape of the loaded business (avoids Prisma type friction). */
interface BusinessResearchInput {
  businessType?: string | null;
  businessDescription?: string | null;
  businessWebsiteUrl?: string | null;
  targetAudience?: string | null;
  selectedServices?: string[] | null;
  detectedServices?: unknown;
  serviceAreaLocations?: string[] | null;
  businessCity?: string | null;
  businessCountry?: string | null;
  competitiors?: Array<{ name?: string | null; url?: string | null }> | null;
  /** Content plan: planned keywords (with intent) the business is building content around. */
  Plan?: Array<{ keyword?: string | null; keywordIntent?: string | null }> | null;
  /** Published/planned blog topics. */
  Blog?: Array<{ title?: string | null }> | null;
  websiteAnalysis?: {
    businessInfo?: {
      businessSummary?: string | null;
      businessGoals?: string[] | null;
      targetAudience?: string | null;
      valuePropositions?: string[] | null;
      businessModel?: string | null;
      customerPainPoints?: string[] | null;
      uniqueSellingPoints?: string[] | null;
      industryPositioning?: string | null;
    } | null;
    coreServices?: {
      topLevel?: string[] | null;
      subOfferings?: string[] | null;
      industryFocus?: string[] | null;
    } | null;
    recognition?: {
      awards?: string[] | null;
      partnerships?: string[] | null;
    } | null;
    brandIdentity?: {
      tagline?: string | null;
    } | null;
  } | null;
  GeoProfile?: {
    formattedAddress?: string | null;
    locality?: string | null;
    neighborhood?: string | null;
    adminArea1?: string | null;
  } | null;
  CompetitorIntelligences?: Array<{
    competitorName?: string | null;
    contentTopics?: string[] | null;
  }> | null;
  [k: string]: unknown;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function uniqStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** detectedServices is free-form Json — pull human-readable service names out of it. */
function parseDetectedServices(value: unknown): string[] {
  if (!value) return [];
  const collect = (item: unknown): string | null => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const name = o.name ?? o.service ?? o.title ?? o.label;
      if (typeof name === "string") return name;
    }
    return null;
  };
  if (Array.isArray(value)) {
    return value.map(collect).filter((s): s is string => Boolean(s));
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

export function buildBusinessResearchBrief(
  business: BusinessResearchInput,
  profile: BusinessOffPageProfile,
): BusinessResearchBrief {
  const info = business.websiteAnalysis?.businessInfo ?? null;
  const core = business.websiteAnalysis?.coreServices ?? null;
  const recognition = business.websiteAnalysis?.recognition ?? null;
  const geo = business.GeoProfile ?? null;
  const city = pickBusinessCity(business.businessCity, geo?.locality);

  const services = uniqStrings(
    [
      ...asArray(business.selectedServices),
      ...parseDetectedServices(business.detectedServices),
      ...asArray(core?.topLevel),
      ...asArray(core?.subOfferings),
    ],
    14,
  );

  const competitors = Array.isArray(business.competitiors)
    ? business.competitiors
        .map((c) => ({ name: (c?.name ?? "").trim(), url: c?.url ?? null }))
        .filter((c) => c.name.length > 0)
        .slice(0, 8)
    : [];

  const competitorTopics = uniqStrings(
    (business.CompetitorIntelligences ?? []).flatMap((c) =>
      asArray(c?.contentTopics),
    ),
    12,
  );

  const neighborhoods = uniqStrings(
    [geo?.neighborhood, geo?.locality].filter(
      (s): s is string => Boolean(s && s.trim()),
    ),
    4,
  );

  const differentiators = uniqStrings(
    [...asArray(info?.uniqueSellingPoints), ...asArray(info?.valuePropositions)],
    8,
  );

  // Content plan = the topics the business is deliberately building content around.
  // Informational/question-intent planned keywords are the best Reddit fodder
  // (people ask exactly those questions), so surface them first, then the rest of
  // the planned keywords, then published blog titles.
  const planRows = Array.isArray(business.Plan) ? business.Plan : [];
  const blogRows = Array.isArray(business.Blog) ? business.Blog : [];
  const informationalPlan = planRows
    .filter((p) => /inform|question|how|guide|what|why|best|vs/i.test(String(p?.keywordIntent ?? "")))
    .map((p) => (typeof p?.keyword === "string" ? p.keyword.trim() : ""));
  const otherPlan = planRows.map((p) =>
    typeof p?.keyword === "string" ? p.keyword.trim() : "",
  );
  const blogTitles = blogRows.map((b) =>
    typeof b?.title === "string" ? b.title.trim() : "",
  );
  const contentTopics = uniqStrings(
    [...informationalPlan, ...otherPlan, ...blogTitles],
    16,
  );

  return {
    businessId: profile.businessId,
    businessName: profile.businessName,
    category: business.businessType ?? profile.category ?? null,
    description: business.businessDescription ?? info?.businessSummary ?? null,
    websiteUrl: business.businessWebsiteUrl ?? null,
    targetAudience: business.targetAudience ?? info?.targetAudience ?? null,
    services,
    competitors,
    keywords: profile.keywords,
    location: {
      city,
      serviceArea: profile.serviceArea ?? null,
      serviceAreaLocations: uniqStrings(asArray(business.serviceAreaLocations), 8),
      country: business.businessCountry ?? null,
      formattedAddress: geo?.formattedAddress ?? null,
      neighborhoods,
    },
    scope: profile.scope,
    businessModelType: profile.businessModelType,

    // Deep context
    tagline: business.websiteAnalysis?.brandIdentity?.tagline ?? null,
    summary: info?.businessSummary ?? null,
    differentiators,
    painPoints: uniqStrings(asArray(info?.customerPainPoints), 8),
    businessGoals: uniqStrings(asArray(info?.businessGoals), 6),
    industryPositioning: info?.industryPositioning ?? null,
    recognition: uniqStrings(
      [...asArray(recognition?.awards), ...asArray(recognition?.partnerships)],
      6,
    ),
    competitorTopics,
    contentTopics,
  };
}

/**
 * Render the brief as a compact, deep prompt block shared by every research
 * agent (Reddit, directory, planner, validator) so they all reason from the SAME
 * complete business + location context instead of a thin name+keywords summary.
 */
export function formatBriefForPrompt(brief: BusinessResearchBrief): string {
  const loc = brief.location;
  const locationLine = [
    loc.formattedAddress,
    loc.city,
    loc.neighborhoods.length ? `neighbourhoods: ${loc.neighborhoods.join(", ")}` : null,
    loc.serviceAreaLocations.length ? `serves: ${loc.serviceAreaLocations.join(", ")}` : null,
    loc.serviceArea,
    loc.country,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines: string[] = [
    `Business: ${brief.businessName || "(unknown)"}${brief.tagline ? ` — "${brief.tagline}"` : ""}`,
    brief.category ? `Category: ${brief.category}` : "",
    brief.summary
      ? `Summary: ${brief.summary.slice(0, 500)}`
      : brief.description
        ? `What they do: ${brief.description.slice(0, 500)}`
        : "",
    brief.services.length ? `Services/offerings: ${brief.services.join(", ")}` : "",
    brief.differentiators.length
      ? `What makes them different (USPs/value): ${brief.differentiators.join("; ")}`
      : "",
    brief.painPoints.length
      ? `Customer pain points they solve: ${brief.painPoints.join("; ")}`
      : "",
    brief.targetAudience ? `Target audience: ${brief.targetAudience}` : "",
    brief.industryPositioning ? `Positioning: ${brief.industryPositioning}` : "",
    brief.recognition.length ? `Recognition: ${brief.recognition.join(", ")}` : "",
    brief.keywords.length ? `Topics/keywords: ${brief.keywords.slice(0, 15).join(", ")}` : "",
    brief.competitors.length
      ? `Competitors: ${brief.competitors.map((c) => c.name).slice(0, 8).join(", ")}`
      : "",
    brief.competitorTopics.length
      ? `Competitor content topics: ${brief.competitorTopics.join(", ")}`
      : "",
    brief.contentTopics?.length
      ? `Planned content topics (what they're building content around — prime Reddit + topic targets): ${brief.contentTopics.slice(0, 16).join(", ")}`
      : "",
    `Business model: ${brief.businessModelType}; geographic scope: ${brief.scope}`,
    locationLine ? `Location/area: ${locationLine}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
