export const WEBSITE_PLAN_TIERS = ["SEO", "SEO_SOCIAL"] as const;
export type WebsitePlanTier = (typeof WEBSITE_PLAN_TIERS)[number];

export function parseWebsitePlanTier(value: unknown): WebsitePlanTier | null {
  return WEBSITE_PLAN_TIERS.includes(value as WebsitePlanTier)
    ? (value as WebsitePlanTier)
    : null;
}

export function getWebsitePlanTierFromPriceId(
  priceId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WebsitePlanTier {
  return getKnownWebsitePlanTierFromPriceId(priceId, env) ?? "SEO";
}

export function getKnownWebsitePlanTierFromPriceId(
  priceId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WebsitePlanTier | null {
  const seoPriceIds = new Set(
    [
      env.UPLIFT_PLAN_PRICE_ID,
      env.UPLIFT_YEARLY_PRICE_ID,
      env.WEBSITE_PRICE_ID,
      env.WEBSITE_YEARLY_PRICE_ID,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const socialPriceIds = new Set(
    [env.UPLIFT_SEO_SOCIAL_PRICE_ID, env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  if (!priceId) {
    return null;
  }
  if (socialPriceIds.has(priceId)) {
    return "SEO_SOCIAL";
  }
  if (seoPriceIds.has(priceId)) {
    return "SEO";
  }
  return null;
}

export function resolveWebsitePlanTier(
  input: {
    databasePlanTier: unknown;
    stripeMetadataPlanTier?: unknown;
    stripePriceId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): WebsitePlanTier {
  return (
    parseWebsitePlanTier(input.stripeMetadataPlanTier) ??
    getKnownWebsitePlanTierFromPriceId(input.stripePriceId, env) ??
    parseWebsitePlanTier(input.databasePlanTier) ??
    "SEO"
  );
}

export function websitePlanDisplayName(planTier: WebsitePlanTier): string {
  return planTier === "SEO_SOCIAL" ? "SEO + Social" : "SEO";
}
