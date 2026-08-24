/**
 * directory-lever.ts
 *
 * Off-page lever for LOCAL businesses: surfaces directories/citation sites the
 * business should be listed on, matched by country + category + business type.
 * v1 = self-marked checklist (the user claims a listing and marks it done);
 * automatic "already-listed" detection is a deferred later phase.
 *
 * Pure (matches against the static catalog). No I/O.
 */

import { computePriority, makeOpportunityKey } from "../offpage-engine";
import type {
  BusinessOffPageProfile,
  Lever,
  OffPageResearchStrategy,
  Opportunity,
} from "../offpage-types";
import { DIRECTORY_CATALOG, type DirectoryEntry } from "./directory-catalog";
import { generateDirectorySuggestionsLLM } from "../../../llm/offpage/directory-suggestions.llm";
import { discoverDirectoryDomains } from "../../../utils/directory-discovery";

/** Normalize a free-text country to ISO-2 (best effort). */
export function normalizeCountry(country?: string | null): string {
  const c = (country ?? "").trim().toLowerCase();
  if (!c) return "";
  if (["ca", "can", "canada"].includes(c)) return "CA";
  if (["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"].includes(c)) return "US";
  if (c.length === 2) return c.toUpperCase();
  return c.toUpperCase();
}

function countryMatches(entry: DirectoryEntry, iso2: string): boolean {
  if (entry.countries.includes("*")) return true;
  if (!iso2) return false;
  return entry.countries.includes(iso2);
}

function typeMatches(entry: DirectoryEntry, profile: BusinessOffPageProfile): boolean {
  if (entry.appliesToTypes.includes("*")) return true;
  return entry.appliesToTypes.includes(profile.businessModelType);
}

function isGeneralDirectory(entry: DirectoryEntry): boolean {
  return entry.categories.includes("*");
}

/** A niche directory matches only when its categories hit the business. */
function nicheMatches(
  entry: DirectoryEntry,
  profile: BusinessOffPageProfile,
): boolean {
  const haystack = [profile.category ?? "", ...profile.keywords]
    .join(" ")
    .toLowerCase();
  return entry.categories.some((cat) => haystack.includes(cat.toLowerCase()));
}

export const directoryLever: Lever = {
  key: "directory",

  appliesTo(profile: BusinessOffPageProfile): boolean {
    // EVERY business type has directories worth being on — local → Google/Yelp/
    // TripAdvisor; SaaS → G2/Capterra/Product Hunt; e-commerce → Amazon/Shopping;
    // B2B → Clutch/GoodFirms; startups → Crunchbase/AngelList. The AI directory
    // agent + the 3-layer framework pick the right set per type, so this applies
    // wherever we have any business identity to work from (not just local).
    return (
      Boolean(profile.category) ||
      Boolean(profile.businessName) ||
      profile.keywords.length > 0
    );
  },

  findOpportunities(profile: BusinessOffPageProfile): Opportunity[] {
    const iso2 = normalizeCountry(profile.country);
    const out: Opportunity[] = [];

    for (const entry of DIRECTORY_CATALOG) {
      if (!countryMatches(entry, iso2)) continue;
      if (!typeMatches(entry, profile)) continue;
      const general = isGeneralDirectory(entry);
      if (!general && !nicheMatches(entry, profile)) continue;

      // Applies → relevance 1.0; authority does the ranking (so universal
      // high-authority citations like Google Business Profile rank first).
      out.push({
        leverKey: "directory",
        key: makeOpportunityKey("directory", entry.name),
        title: `List ${profile.businessName || "your business"} on ${entry.name}`,
        url: entry.url,
        action: `Create/claim your ${entry.name} listing. Keep name, address, and phone (NAP) identical to your other listings.`,
        priority: computePriority(1, entry.authority),
        rationale: general
          ? `${entry.name} is a core business directory; consistent citations build local trust signals.`
          : `${entry.name} is a high-relevance directory for your category — consistent citations are a local-ranking factor.`,
        status: "todo",
        businessTypeFit: "local / multi-location",
      });
    }

    return out;
  },

  /**
   * LLM-researched, business- and LOCATION-aware directory opportunities: real
   * directories matched to this business's category, country, city and model
   * (including national/local/niche ones the static catalog misses). Returns []
   * on failure so the engine falls back to the deterministic catalog above.
   */
  async researchOpportunities(
    profile,
    brief,
    strategy?: OffPageResearchStrategy,
  ): Promise<Opportunity[]> {
    if (strategy && strategy.directory.enabled === false) return [];

    // Ground the AI in directories that actually rank for this business's niche.
    const discovered = await discoverDirectoryDomains(brief, strategy).catch(() => []);
    const suggestions = await generateDirectorySuggestionsLLM(
      brief,
      discovered,
      strategy,
    );
    if (suggestions.length === 0) return [];

    const AUTHORITY: Record<string, number> = {
      global: 90,
      national: 82,
      local: 76,
      niche: 70,
    };

    return suggestions.map((s): Opportunity => ({
      leverKey: "directory",
      key: makeOpportunityKey("directory", s.name),
      title: `List ${profile.businessName || "your business"} on ${s.name}`,
      url: s.url,
      action: `Create/claim your ${s.name} listing. Keep name, address, and phone (NAP) identical across every listing.`,
      priority: computePriority(
        s.relevance > 0 ? s.relevance : 0.7,
        AUTHORITY[s.scope] ?? 75,
      ),
      rationale:
        s.fit ||
        `${s.name} is a relevant directory for ${profile.businessName || "your business"}.`,
      source: "researched",
      status: "todo",
      businessTypeFit: "local / multi-location",
    }));
  },
};
