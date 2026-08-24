/**
 * location-policy.utils.ts
 *
 * Decides the RIGHT geographic granularity for a blog instead of stamping the
 * full street address everywhere. A national/e-commerce/online business should
 * reference country (or nothing), a regional one its state, a local service
 * business its city/neighborhood — and the street address/postal code should
 * never appear in article prose (that belongs in structured data).
 *
 * Driven by reach signals that already exist (businessModel.isLocationDependent,
 * market.geographic.scope, Business.serviceArea) + keyword intent. Pure, tested.
 */

export type LocationTier = "none" | "country" | "region" | "city";

export interface LocationPolicy {
  tier: LocationTier;
  /** City tier only: may name up to two verified nearby landmarks. */
  useNeighborhoodAndLandmarks: boolean;
  /** Whether to include a dedicated "Local considerations" section. */
  useLocalSection: boolean;
  /** Whether the closing CTA may be location-anchored. */
  useLocalCTA: boolean;
  reason: string;
}

export interface LocationPolicyInput {
  isLocationDependent?: boolean | null;
  scope?: string | null; // local | regional | national | international
  businessModelType?: string | null; // service | product | mixed
  serviceArea?: string | null; // local | regional | national | international
  keyword?: string;
  hasCity?: boolean;
  hasRegion?: boolean;
  hasCountry?: boolean;
  verifiedGeo?: boolean;
}

/** Local search intent in the keyword ("near me", "local", "...nearby"). */
export function detectLocalIntent(keyword?: string): boolean {
  if (!keyword) return false;
  return /\b(near me|nearby|near you|in my area|local|closest|around me)\b/i.test(
    keyword,
  );
}

function geoTier(input: LocationPolicyInput): LocationTier {
  if (input.hasCity) return "city";
  if (input.hasRegion) return "region";
  if (input.hasCountry) return "country";
  return "none";
}

export function decideLocationPolicy(
  input: LocationPolicyInput,
): LocationPolicy {
  const scope = (input.scope ?? "").toLowerCase();
  const sa = (input.serviceArea ?? "").toLowerCase();
  const model = (input.businessModelType ?? "").toLowerCase();
  const localIntent = detectLocalIntent(input.keyword);

  const isNationalOrWider =
    model === "product" ||
    input.isLocationDependent === false ||
    scope === "national" ||
    scope === "international" ||
    sa === "national" ||
    sa === "international";
  // A broad-reach/product signal outranks a legacy local service-area value.
  // E-commerce businesses may keep `serviceArea=local` for a showroom or
  // warehouse while their actual market is national/international. Treat them
  // as local only for an explicitly local-intent keyword.
  const isLocal =
    !isNationalOrWider &&
    (input.isLocationDependent === true ||
      scope === "local" ||
      sa === "local");
  const isRegional =
    !isNationalOrWider && (scope === "regional" || sa === "regional");

  // Local business, or a local-intent topic where a city is available.
  if (isLocal || (localIntent && input.hasCity)) {
    const tier = geoTier(input);
    return {
      tier,
      useNeighborhoodAndLandmarks:
        Boolean(input.verifiedGeo) && isLocal && tier === "city",
      useLocalSection: isLocal && tier !== "none",
      useLocalCTA: isLocal && tier !== "none",
      reason: isLocal
        ? "location-dependent / local business"
        : "local-intent keyword with a known city",
    };
  }

  if (isRegional) {
    const tier: LocationTier = input.hasRegion
      ? "region"
      : input.hasCountry
        ? "country"
        : "none";
    return {
      tier,
      useNeighborhoodAndLandmarks: false,
      useLocalSection: false,
      useLocalCTA: false,
      reason: "regional reach",
    };
  }

  if (isNationalOrWider) {
    const tier: LocationTier = input.hasCountry ? "country" : "none";
    return {
      tier,
      useNeighborhoodAndLandmarks: false,
      useLocalSection: false,
      useLocalCTA: false,
      reason: "national / international / product business",
    };
  }

  // Reach unknown: allow a light city reference if present, but never force a
  // local section / CTA / street address.
  return {
    tier: geoTier(input),
    useNeighborhoodAndLandmarks: false,
    useLocalSection: false,
    useLocalCTA: false,
    reason: "reach unknown — conservative",
  };
}

export interface LocationFields {
  businessCity?: string | null;
  businessState?: string | null;
  businessCountry?: string | null;
  neighborhood?: string | null;
}

/** Authoritative geo-usage policy block for the prompt. */
export function buildLocationPolicyBlock(
  policy: LocationPolicy,
  loc: LocationFields | null | undefined,
): string {
  const city = loc?.neighborhood || loc?.businessCity || "";
  const state = loc?.businessState || "";
  const country = loc?.businessCountry || "";

  const lines: string[] = [
    'GEOGRAPHIC USAGE POLICY (follow exactly — OVERRIDES any generic "use local context" instruction):',
  ];

  switch (policy.tier) {
    case "none":
      lines.push(
        "- This business/topic is NOT location-specific. Do NOT reference any city, neighborhood, street address, postal code, or local landmarks. Write for a general/national audience.",
      );
      break;
    case "country":
      lines.push(
        `- Reference location at the COUNTRY level only${country ? ` (${country})` : ""}. Do NOT include any city, neighborhood, street address, postal code, or local landmarks.`,
      );
      break;
    case "region":
      lines.push(
        `- Reference location at the STATE/PROVINCE level at most${state ? ` (${state})` : ""}. Do NOT include street address, postal code, or specific local landmarks.`,
      );
      break;
    case "city":
      lines.push(
        `- Reference location at the CITY / neighborhood level${city ? ` (${city})` : ""}.`,
      );
      lines.push(
        policy.useNeighborhoodAndLandmarks
          ? "- You MAY mention up to two real nearby landmarks (from the verified-location data below)."
          : "- Do NOT mention specific landmarks or street names.",
      );
      break;
  }

  lines.push(
    "- NEVER print the full street address or postal code in the article body — those belong only in structured data, not prose.",
  );
  if (!policy.useLocalSection) {
    lines.push(
      '- Do NOT add a dedicated "Local considerations" section; weave any allowed geography in naturally, only where it genuinely adds value.',
    );
  }
  if (!policy.useLocalCTA) {
    lines.push("- The closing CTA must NOT be location-anchored.");
  }

  return lines.join("\n");
}
