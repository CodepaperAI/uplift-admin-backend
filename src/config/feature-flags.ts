export const PER_SITE_TRIALS_ENABLED: boolean =
  process.env.PER_SITE_TRIALS === "true";

export const SEO_AUDIT_RELIABILITY_V2_ENABLED: boolean =
  process.env.SEO_AUDIT_RELIABILITY_V2 !== "false";

export const MANAGED_AGENCIES_ENABLED: boolean =
  process.env.MANAGED_AGENCIES === "true";

export const AGENCY_PRICING_ENABLED: boolean =
  process.env.AGENCY_PRICING === "true";

export const AGENCY_SETTLEMENTS_ENABLED: boolean =
  process.env.AGENCY_SETTLEMENTS === "true";
