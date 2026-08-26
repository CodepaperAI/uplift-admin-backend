/**
 * Which Stripe price is which Uplift plan.
 *
 * The four product prices are configured as environment variables, so the sets
 * are derived from them rather than from a name match on whatever Stripe
 * returns. A name match is what the plan chart used to do, and a rename in
 * Stripe silently emptied a whole plan line.
 *
 * Lives here rather than in a controller because two endpoints need it now, and
 * a controller importing another controller for it would be worse than either.
 */

export type UpliftPriceSets = {
  socialPriceIds: ReadonlySet<string>;
  annualPriceIds: ReadonlySet<string>;
  corePriceIds: ReadonlySet<string>;
  /** False when nothing is configured, so callers can say so. */
  configured: boolean;
};

function id(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function upliftPriceSets(env: NodeJS.ProcessEnv = process.env): UpliftPriceSets {
  const coreMonthly = id(env.UPLIFT_PLAN_PRICE_ID);
  const coreAnnual = id(env.UPLIFT_YEARLY_PRICE_ID);
  const socialMonthly = id(env.UPLIFT_SEO_SOCIAL_PRICE_ID);
  const socialAnnual = id(env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID);

  const social = new Set([socialMonthly, socialAnnual].filter((v): v is string => v !== null));
  const annual = new Set([coreAnnual, socialAnnual].filter((v): v is string => v !== null));
  const core = new Set([coreMonthly, coreAnnual].filter((v): v is string => v !== null));

  return {
    socialPriceIds: social,
    annualPriceIds: annual,
    corePriceIds: core,
    configured: social.size > 0 || core.size > 0,
  };
}
