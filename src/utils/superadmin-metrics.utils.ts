import type { Subscription, WebsiteSubscription } from "@prisma/client";

export type WebsiteBillingBucket =
  | "paid_active"
  | "trialing"
  | "expired_or_inactive";

export function classifyWebsiteSubscription(
  ws: Pick<
    WebsiteSubscription,
    "status" | "stripeSubscriptionId" | "trialStatus" | "trialEndDate"
  >,
  now: Date = new Date(),
): WebsiteBillingBucket {
  if (
    ws.status === "active" &&
    ws.trialStatus !== "trialing" &&
    ws.trialStatus !== "expired"
  ) {
    return "paid_active";
  }
  if (
    ws.status === "trialing" ||
    (ws.trialStatus === "trialing" &&
      (ws.trialEndDate === null || ws.trialEndDate > now))
  ) {
    return "trialing";
  }
  return "expired_or_inactive";
}

export function parseOptionalDate(
  value: string | undefined,
): Date | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const d: Date = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return undefined;
  }
  return d;
}

export type UserSubscriptionStatus = "paid" | "trial" | "expired";

type UserStatusSubscription = Pick<
  Subscription,
  "status" | "stripeSubscriptionId" | "currentPeriodEnd"
>;

type UserStatusWebsiteSubscription = Pick<
  WebsiteSubscription,
  "status" | "stripeSubscriptionId" | "trialStatus" | "trialEndDate"
>;

type UserStatusBusiness = {
  websiteStatus?: string | null;
  websiteSubscription?: UserStatusWebsiteSubscription | null;
};

function isFutureDate(value: Date | null | undefined, now: Date): boolean {
  return value instanceof Date && value > now;
}

function isPastDate(value: Date | null | undefined, now: Date): boolean {
  return value instanceof Date && value <= now;
}

function hasPaidWebsiteSubscription(
  businesses: UserStatusBusiness[],
  now: Date,
): boolean {
  return businesses.some((business) => {
    const ws = business.websiteSubscription;
    if (!ws) {
      return false;
    }

    return classifyWebsiteSubscription(ws, now) === "paid_active";
  });
}

function hasActiveWebsiteTrial(
  businesses: UserStatusBusiness[],
  now: Date,
): boolean {
  return businesses.some((business) => {
    const ws = business.websiteSubscription;
    if (!ws) return false;

    if (ws.trialStatus === "trialing") {
      return ws.trialEndDate == null || isFutureDate(ws.trialEndDate, now);
    }

    return ws.status === "trialing" && !isPastDate(ws.trialEndDate, now);
  });
}

function hasExpiredWebsiteTrial(
  businesses: UserStatusBusiness[],
  now: Date,
): boolean {
  return businesses.some((business) => {
    const ws = business.websiteSubscription;
    if (!ws) return false;

    if (ws.trialStatus === "expired" || ws.status === "expired") {
      return true;
    }

    return (
      (ws.trialStatus === "trialing" || ws.status === "trialing") &&
      isPastDate(ws.trialEndDate, now)
    );
  });
}

export function classifyUserSubscriptionStatus(
  user: {
    trialStatus: string | null;
    trialEndDate?: Date | null;
    business?: UserStatusBusiness[];
  },
  _subscription: UserStatusSubscription | null,
  now: Date = new Date(),
): UserSubscriptionStatus {
  const businesses = user.business ?? [];

  if (hasPaidWebsiteSubscription(businesses, now)) {
    return "paid";
  }

  if (hasActiveWebsiteTrial(businesses, now)) {
    return "trial";
  }

  if (hasExpiredWebsiteTrial(businesses, now)) {
    return "expired";
  }

  return "expired";
}
