import { prisma } from "../config/db.config";
import { AGENCY_PRICING_ENABLED } from "../config/feature-flags";

type BillingInterval = "monthly" | "yearly";

type AgencyPriceResolution = {
  stripePriceId: string;
  priceCents: number;
  currency: string;
  agencyId: string | null;
  agencyPricingConfigId: string | null;
  source: "agency" | "platform_default";
};

type PlatformDefaults = {
  monthly: { stripePriceId: string; priceCents: number };
  yearly: { stripePriceId: string; priceCents: number };
};

const getPlatformDefaults = (
  overrides?: Partial<PlatformDefaults>,
): PlatformDefaults => ({
  monthly: {
    stripePriceId:
      overrides?.monthly?.stripePriceId ?? process.env.UPLIFT_PLAN_PRICE_ID ?? "",
    priceCents: overrides?.monthly?.priceCents ?? 9900,
  },
  yearly: {
    stripePriceId:
      overrides?.yearly?.stripePriceId ?? process.env.UPLIFT_YEARLY_PRICE_ID ?? "",
    priceCents: overrides?.yearly?.priceCents ?? 99000,
  },
});

const buildPlatformDefault = (
  interval: BillingInterval,
  overrides?: Partial<PlatformDefaults>,
): AgencyPriceResolution => {
  const defaults: PlatformDefaults = getPlatformDefaults(overrides);
  const selected = defaults[interval];
  return {
    stripePriceId: selected.stripePriceId,
    priceCents: selected.priceCents,
    currency: "usd",
    agencyId: null,
    agencyPricingConfigId: null,
    source: "platform_default",
  };
};

export const resolveSubscriptionPrice = async (
  agencyId: string | null,
  interval: BillingInterval,
  platformDefaults?: Partial<PlatformDefaults>,
  planTier: "SEO" | "SEO_SOCIAL" = "SEO",
): Promise<AgencyPriceResolution> => {
  if (!AGENCY_PRICING_ENABLED || agencyId === null) {
    return buildPlatformDefault(interval, platformDefaults);
  }

  const config = await prisma.agencyPricingConfig.findFirst({
    where: {
      agencyId,
      isActive: true,
      planTier,
      agency: { isActive: true },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!config) {
    return buildPlatformDefault(interval, platformDefaults);
  }

  const stripePriceId: string | null =
    interval === "monthly"
      ? config.stripeMonthlyPriceId
      : config.stripeYearlyPriceId;

  if (!stripePriceId) {
    return buildPlatformDefault(interval, platformDefaults);
  }

  const priceCents: number =
    interval === "monthly"
      ? config.monthlyPriceCents
      : config.yearlyPriceCents;

  return {
    stripePriceId,
    priceCents,
    currency: config.currency,
    agencyId,
    agencyPricingConfigId: config.id,
    source: "agency",
  };
};

export const getAgencyAttributionMetadata = async (
  agencyId: string | null,
  businessId: string
): Promise<Record<string, string>> => {
  const metadata: Record<string, string> = { businessId };

  if (!agencyId) {
    metadata.ownershipType = "uplift_direct";
    return metadata;
  }

  metadata.agencyId = agencyId;
  metadata.ownershipType = "agency_managed";

  const config = await prisma.agencyPricingConfig.findFirst({
    where: { agencyId, isActive: true, agency: { isActive: true } },
    orderBy: { createdAt: "desc" },
  });

  if (config) {
    metadata.agencyPricingConfigId = config.id;
  }

  return metadata;
};
