import { prisma } from "../config/db.config";

export type BacklinkServiceIneligibleReason =
  | "user_not_found"
  | "business_not_found"
  | "inactive_business"
  | "disabled"
  | "subscription_required";

export type BacklinkServiceEligibility = {
  eligible: boolean;
  reason?: BacklinkServiceIneligibleReason;
  message?: string;
};

type AccountSubscriptionLike = {
  status: string | null;
  currentPeriodEnd?: Date | null;
} | null;

type WebsiteSubscriptionLike = {
  status: string | null;
  trialStatus?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionItemId?: string | null;
  stripePriceId?: string | null;
} | null;

type UserBacklinkAccessLike = {
  backlinkEnabled: boolean;
  Subscription?: AccountSubscriptionLike;
  business?: Array<{
    isActive?: boolean | null;
    websiteSubscription?: WebsiteSubscriptionLike;
  }>;
};

type BusinessBacklinkAccessLike = {
  isActive?: boolean | null;
  websiteSubscription?: WebsiteSubscriptionLike;
  User: {
    backlinkEnabled: boolean;
    Subscription?: AccountSubscriptionLike;
  };
};

const SUBSCRIPTION_REQUIRED_MESSAGE =
  "Backlink analysis is available with an active subscription.";

export function hasActivePaidAccountSubscription(
  subscription: AccountSubscriptionLike,
  now = new Date(),
): boolean {
  if (!subscription || subscription.status !== "active") {
    return false;
  }

  return !subscription.currentPeriodEnd || subscription.currentPeriodEnd > now;
}

export function hasActivePaidWebsiteSubscription(
  websiteSubscription: WebsiteSubscriptionLike,
): boolean {
  if (!websiteSubscription || websiteSubscription.status !== "active") {
    return false;
  }

  if (
    websiteSubscription.trialStatus === "trialing" ||
    websiteSubscription.trialStatus === "expired"
  ) {
    return false;
  }

  return true;
}

export function getUserBacklinkServiceEligibility(
  user: UserBacklinkAccessLike | null,
): BacklinkServiceEligibility {
  if (!user) {
    return {
      eligible: false,
      reason: "user_not_found",
      message: "User not found.",
    };
  }

  if (!user.backlinkEnabled) {
    return {
      eligible: false,
      reason: "disabled",
      message: "Backlink analysis is disabled for this account.",
    };
  }

  const hasPaidWebsite = (user.business ?? []).some(
    (business) =>
      business.isActive !== false &&
      hasActivePaidWebsiteSubscription(business.websiteSubscription ?? null),
  );

  if (hasPaidWebsite) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: "subscription_required",
    message: SUBSCRIPTION_REQUIRED_MESSAGE,
  };
}

export function getBusinessBacklinkServiceEligibility(
  business: BusinessBacklinkAccessLike | null,
): BacklinkServiceEligibility {
  if (!business) {
    return {
      eligible: false,
      reason: "business_not_found",
      message: "Business not found.",
    };
  }

  if (business.isActive === false) {
    return {
      eligible: false,
      reason: "inactive_business",
      message: "Business is not active.",
    };
  }

  if (!business.User.backlinkEnabled) {
    return {
      eligible: false,
      reason: "disabled",
      message: "Backlink analysis is disabled for this account.",
    };
  }

  if (hasActivePaidWebsiteSubscription(business.websiteSubscription ?? null)) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: "subscription_required",
    message: SUBSCRIPTION_REQUIRED_MESSAGE,
  };
}

export async function getBacklinkServiceEligibilityForUser(
  userId: string,
): Promise<BacklinkServiceEligibility> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      backlinkEnabled: true,
      Subscription: {
        select: {
          status: true,
          currentPeriodEnd: true,
        },
      },
      business: {
        where: { isActive: true },
        select: {
          isActive: true,
          websiteSubscription: {
            select: {
              status: true,
              trialStatus: true,
              stripeSubscriptionId: true,
              stripeSubscriptionItemId: true,
              stripePriceId: true,
            },
          },
        },
      },
    },
  });

  return getUserBacklinkServiceEligibility(user);
}

export async function getBacklinkServiceEligibilityForBusiness(
  businessId: string,
): Promise<BacklinkServiceEligibility> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      isActive: true,
      websiteSubscription: {
        select: {
          status: true,
          trialStatus: true,
          stripeSubscriptionId: true,
          stripeSubscriptionItemId: true,
          stripePriceId: true,
        },
      },
      User: {
        select: {
          backlinkEnabled: true,
          Subscription: {
            select: {
              status: true,
              currentPeriodEnd: true,
            },
          },
        },
      },
    },
  });

  return getBusinessBacklinkServiceEligibility(business);
}
