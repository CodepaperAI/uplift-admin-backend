import { prisma } from "../config/db.config";
import {
  hasActivePaidWebsiteSubscription,
} from "./backlink-access.utils";

/**
 * AI Visibility access gate
 *
 * Trigger endpoints (scan / score / discover / add-opportunity / override-
 * route / assign-routes) may only be invoked for businesses that have an
 * active subscription OR an ongoing trial. Read endpoints are always
 * available — even downgraded customers should see their historical data.
 *
 * A business qualifies if ANY of the following is true:
 *   1. Its own websiteSubscription is an active paid plan, OR
 *   2. Its own websiteSubscription is currently in a trial
 *      (trialStatus = "trialing" AND trialEndDate > now).
 *
 * This intentionally mirrors the per-site primitives in
 * backlink-access.utils.ts so subscription semantics stay consistent across
 * the product.
 */

type WebsiteSubscriptionLike = {
  status: string | null;
  trialStatus?: string | null;
  trialEndDate?: Date | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionItemId?: string | null;
  stripePriceId?: string | null;
} | null;

export type AiVisibilityAccessLike = {
  isActive?: boolean | null;
  websiteSubscription?: WebsiteSubscriptionLike;
};

export class AiVisibilityAccessError extends Error {
  readonly reason:
    | "business_not_found"
    | "inactive_business"
    | "subscription_required";
  constructor(
    reason:
      | "business_not_found"
      | "inactive_business"
      | "subscription_required",
    message: string,
  ) {
    super(message);
    this.name = "AiVisibilityAccessError";
    this.reason = reason;
  }
}

export function isWebsiteTrialActive(
  websiteSubscription: WebsiteSubscriptionLike,
  now: Date,
): boolean {
  if (!websiteSubscription) return false;
  if (websiteSubscription.trialStatus !== "trialing") return false;
  if (!websiteSubscription.trialEndDate) return true; // trialing with no end — treat as active
  return websiteSubscription.trialEndDate > now;
}

/**
 * Pure predicate — no DB access. Accepts a pre-fetched business shape.
 */
export function hasActiveOrTrialAccess(
  business: AiVisibilityAccessLike | null,
  now: Date = new Date(),
): boolean {
  if (!business) return false;
  if (business.isActive === false) return false;

  if (hasActivePaidWebsiteSubscription(business.websiteSubscription ?? null)) {
    return true;
  }
  if (isWebsiteTrialActive(business.websiteSubscription ?? null, now)) {
    return true;
  }
  return false;
}

export function hasPaidAiVisibilityAccess(
  business: AiVisibilityAccessLike | null,
): boolean {
  if (!business) return false;
  if (business.isActive === false) return false;
  return hasActivePaidWebsiteSubscription(business.websiteSubscription ?? null);
}

export function hasTrialAiVisibilityAccess(
  business: AiVisibilityAccessLike | null,
  now: Date = new Date(),
): boolean {
  if (!business) return false;
  if (business.isActive === false) return false;
  return isWebsiteTrialActive(business.websiteSubscription ?? null, now);
}

/**
 * The Prisma select shape used by `assertAiVisibilityAccess`. Exported so
 * call sites with their own business queries can opt into the same
 * eligibility check without a second DB round-trip.
 */
export const aiVisibilityAccessSelect = {
  id: true,
  isActive: true,
  websiteSubscription: {
    select: {
      status: true,
      trialStatus: true,
      trialEndDate: true,
      stripeSubscriptionId: true,
      stripeSubscriptionItemId: true,
      stripePriceId: true,
    },
  },
} as const;

/**
 * Load the business and gate on trial-or-paid eligibility. Throws a
 * structured {@link AiVisibilityAccessError} so the controller layer can
 * translate the reason into an HTTP status code.
 */
export async function assertAiVisibilityAccess(
  businessId: string,
  now: Date = new Date(),
): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: aiVisibilityAccessSelect,
  });

  if (!business) {
    throw new AiVisibilityAccessError(
      "business_not_found",
      `Business ${businessId} not found.`,
    );
  }
  if (business.isActive === false) {
    throw new AiVisibilityAccessError(
      "inactive_business",
      "This business is not active.",
    );
  }
  if (!hasActiveOrTrialAccess(business, now)) {
    throw new AiVisibilityAccessError(
      "subscription_required",
      "AI Visibility tools are available during a trial or with an active subscription.",
    );
  }
}

export async function assertPaidAiVisibilityAccess(
  businessId: string,
): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: aiVisibilityAccessSelect,
  });

  if (!business) {
    throw new AiVisibilityAccessError(
      "business_not_found",
      `Business ${businessId} not found.`,
    );
  }
  if (business.isActive === false) {
    throw new AiVisibilityAccessError(
      "inactive_business",
      "This business is not active.",
    );
  }
  if (!hasPaidAiVisibilityAccess(business)) {
    throw new AiVisibilityAccessError(
      "subscription_required",
      "AI Visibility manual reruns are available with an active paid subscription.",
    );
  }
}
