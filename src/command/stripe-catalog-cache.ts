import { Prisma } from "@prisma/client";
import type {
  ResolvedStripeDiscount,
  UpliftSubscriptionPlanBilling,
} from "./stripe-discount-metrics";

/**
 * Serialisation for the two Stripe-derived values the panel caches.
 *
 * Both cross Redis, so both have to survive `JSON.stringify` and come back as
 * the same types the callers already expect. `Prisma.Decimal` is the reason this
 * file exists rather than a bare `JSON.parse`: a Decimal stringifies to `"1500"`
 * and would come back as a *string*, which reads fine in a log and then throws —
 * or worse, silently concatenates — the first time money arithmetic touches it.
 * Every Decimal field is named here and rehydrated explicitly.
 */

export type CachedPlanDefinition = {
  priceId: string;
  name: string;
  billingPeriod: string;
  currency: string | null;
  unitAmountMinor: string | null;
};

export type CachedSubscriptionBilling = {
  /** Every live Stripe subscription Stripe returned, not only a caller's slice. */
  entries: Array<[string, UpliftSubscriptionPlanBilling[]]>;
};

type WireBilling = {
  priceId: string;
  currency: string;
  grossMonthlyMinor: string;
  netMonthlyMinor: string;
  discountMonthlyMinor: string;
  discounts: ResolvedStripeDiscount[];
};

type WireSubscriptionBilling = {
  entries: Array<[string, WireBilling[]]>;
};

function toWire(billing: UpliftSubscriptionPlanBilling): WireBilling {
  return {
    priceId: billing.priceId,
    currency: billing.currency,
    grossMonthlyMinor: billing.grossMonthlyMinor.toString(),
    netMonthlyMinor: billing.netMonthlyMinor.toString(),
    discountMonthlyMinor: billing.discountMonthlyMinor.toString(),
    discounts: billing.discounts,
  };
}

function fromWire(billing: WireBilling): UpliftSubscriptionPlanBilling {
  return {
    priceId: billing.priceId,
    currency: billing.currency,
    grossMonthlyMinor: new Prisma.Decimal(billing.grossMonthlyMinor),
    netMonthlyMinor: new Prisma.Decimal(billing.netMonthlyMinor),
    discountMonthlyMinor: new Prisma.Decimal(billing.discountMonthlyMinor),
    discounts: billing.discounts,
  };
}

export function serializeSubscriptionBilling(
  input: ReadonlyMap<string, UpliftSubscriptionPlanBilling[]>,
): WireSubscriptionBilling {
  return {
    entries: [...input.entries()].map(([subscriptionId, rows]) => [
      subscriptionId,
      rows.map(toWire),
    ]),
  };
}

/**
 * Rejects a malformed cache entry rather than trusting it.
 *
 * A cached shape can outlive the code that wrote it — an old key surviving a
 * deploy, a truncated value, a hand-edited key. Returning null makes the caller
 * fall back to Stripe, which is slow but correct; returning a half-built Map
 * would put wrong money on the dashboard with no error anywhere.
 */
export function deserializeSubscriptionBilling(
  value: unknown,
): Map<string, UpliftSubscriptionPlanBilling[]> | null {
  if (typeof value !== "object" || value === null) return null;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const result = new Map<string, UpliftSubscriptionPlanBilling[]>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [subscriptionId, rows] = entry as [unknown, unknown];
    if (typeof subscriptionId !== "string" || !Array.isArray(rows)) return null;
    const parsed: UpliftSubscriptionPlanBilling[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) return null;
      const candidate = row as Record<string, unknown>;
      if (
        typeof candidate.priceId !== "string" ||
        typeof candidate.currency !== "string" ||
        typeof candidate.grossMonthlyMinor !== "string" ||
        typeof candidate.netMonthlyMinor !== "string" ||
        typeof candidate.discountMonthlyMinor !== "string" ||
        !Array.isArray(candidate.discounts)
      ) {
        return null;
      }
      try {
        parsed.push(fromWire(candidate as unknown as WireBilling));
      } catch {
        return null;
      }
    }
    result.set(subscriptionId, parsed);
  }
  return result;
}

export function deserializePlanDefinitions(
  value: unknown,
): CachedPlanDefinition[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: CachedPlanDefinition[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) return null;
    const candidate = row as Record<string, unknown>;
    if (
      typeof candidate.priceId !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.billingPeriod !== "string" ||
      !(candidate.currency === null || typeof candidate.currency === "string") ||
      !(
        candidate.unitAmountMinor === null ||
        typeof candidate.unitAmountMinor === "string"
      )
    ) {
      return null;
    }
    parsed.push(candidate as unknown as CachedPlanDefinition);
  }
  return parsed;
}

/**
 * A cache key that changes when the plan set does.
 *
 * The billing projection is computed against a set of Uplift price ids, so a
 * cached projection is only valid for the same set. Sorting first means the key
 * does not depend on the order the ids happened to be discovered in.
 */
export function upliftPriceSetKey(priceIds: Iterable<string>): string {
  return [...priceIds].sort().join(",") || "none";
}

/**
 * Stripe prices and products are effectively static — a price is immutable once
 * created and a product name changes when someone edits it by hand. An hour of
 * staleness on a plan label is invisible; paying four HTTP round trips for it on
 * every cache miss is not.
 */
export const PLAN_DEFINITION_TTL_SECONDS = 60 * 60;

/**
 * How long a plan definition stays usable while a refresh runs behind a
 * response. Generous, because a stale plan *label* is a cosmetic problem and
 * waiting on four HTTP round trips is not — and because keeping the last good
 * value through a Stripe outage is better than reverting to
 * "Uplift AI legacy plan" across three endpoints.
 */
export const PLAN_DEFINITION_HARD_TTL_SECONDS = 24 * 60 * 60;

/**
 * Discounts do change by hand, so this stays short. It only has to be long
 * enough that the 60-second response cache stops re-walking Stripe's entire
 * subscription list underneath it — which is where the seconds actually went.
 */
export const SUBSCRIPTION_BILLING_TTL_SECONDS = 5 * 60;

/**
 * The billing projection stays servable for an hour past its soft age.
 *
 * The soft age is what governs freshness in practice: past it, the value is
 * still returned but a refresh starts behind the response, so a reader sees data
 * at most one soft period old and never waits. This longer clock only decides
 * how much traffic-free time it takes before someone has to pay the ~3.8 s
 * Stripe walk again — an hour means that is effectively only the first load
 * after a deploy.
 */
export const SUBSCRIPTION_BILLING_HARD_TTL_SECONDS = 60 * 60;
