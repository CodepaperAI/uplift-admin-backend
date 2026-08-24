import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import Stripe from "stripe";

import { prisma } from "../config/db.config";

export const WEBSITE_REMOVAL_RECOVERY_DAYS = 30;

export const WEBSITE_REMOVAL_STATUSES = [
  "active",
  "cancellation_pending",
  "removed",
] as const;
export type WebsiteRemovalStatus = (typeof WEBSITE_REMOVAL_STATUSES)[number];

export const WEBSITE_REMOVAL_BILLING_ACTIONS = [
  "none",
  "cancel_dedicated_subscription",
  "delete_shared_subscription_item",
  "unknown",
] as const;
export type WebsiteRemovalBillingAction =
  (typeof WEBSITE_REMOVAL_BILLING_ACTIONS)[number];

export type WebsiteRemovalBillingOutcome =
  | "not_required"
  | "confirmed"
  | "pending";

export type WebsiteRemovalRestoreEligibility =
  | "eligible"
  | "billing_required"
  | "expired"
  | "not_removed";

export type WebsiteRemovalDto = {
  businessId: string;
  removalStatus: WebsiteRemovalStatus;
  billingAction: WebsiteRemovalBillingAction;
  billingOutcome: WebsiteRemovalBillingOutcome;
  recoveryDeadline: string | null;
  replacementBusinessId: string | null;
  selectedWebsiteId: string | null;
  retryable: boolean;
  idempotent: boolean;
};

export type WebsiteRestoreDto = {
  businessId: string;
  removalStatus: "active";
  isActive: boolean;
  websiteStatus: string;
  selectedWebsiteId: string | null;
  billingAction: "restore_shared_subscription_item" | "none";
  requiresSubscription: boolean;
  idempotent: boolean;
};

type AggregateBillingSurvivor = {
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
};

export function buildAggregateSubscriptionReconciliation(input: {
  aggregateStripeSubscriptionId: string | null;
  canceledStripeSubscriptionId: string;
  survivor: AggregateBillingSurvivor | null;
  now: Date;
}) {
  if (
    !input.aggregateStripeSubscriptionId ||
    input.aggregateStripeSubscriptionId !== input.canceledStripeSubscriptionId
  ) {
    return null;
  }
  if (input.survivor) {
    const status = input.survivor.status === "trialing" ? "trialing" : "active";
    return {
      status,
      stripeStatus: status,
      stripeSubscriptionId: input.survivor.stripeSubscriptionId,
      stripePriceId: input.survivor.stripePriceId,
      stripeCurrentPeriodEnd: input.survivor.currentPeriodEnd,
      currentPeriodEnd: input.survivor.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      stripeCancelAtPeriodEnd: false,
      canceledAt: null,
    };
  }
  return {
    status: "canceled",
    stripeStatus: "canceled",
    stripeSubscriptionId: null,
    stripePriceId: null,
    stripeCurrentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCancelAtPeriodEnd: false,
    canceledAt: input.now,
  };
}

export class WebsiteRemovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WebsiteRemovalError";
  }
}

type DbClient = PrismaClient;
type StripeClient = Stripe;

type WebsiteRemovalDeps = {
  db?: DbClient;
  stripe?: StripeClient;
  now?: () => Date;
  operationId?: () => string;
};

type StoredRemovalBusiness = {
  id: string;
  userId: string;
  isActive: boolean;
  isPrimary: boolean;
  websiteStatus: string;
  removalStatus: string;
  removalRequestedAt: Date | null;
  removalCompletedAt: Date | null;
  removalRecoveryDeadline: Date | null;
  removalRestoredAt: Date | null;
  removalPreviousWebsiteStatus: string | null;
  removalPreviousSubscriptionStatus: string | null;
  removalBillingAction: string | null;
  removalBillingObjectId: string | null;
  removalOperationKey: string | null;
  removalReplacementBusinessId: string | null;
  websiteSubscription: {
    id: string;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    stripePriceId: string | null;
    status: string;
    trialEndDate: Date | null;
  } | null;
};

type ReplacementCandidate = {
  id: string;
  isPrimary: boolean;
  websiteStatus: string;
  onboardingStatus: string;
};

export function selectWebsiteRemovalReplacement(
  candidates: ReplacementCandidate[],
): ReplacementCandidate | null {
  const eligible = candidates.filter((candidate) => {
    if (
      ["failed", "suspended", "cancellation_pending"].includes(
        candidate.websiteStatus,
      )
    ) {
      return false;
    }
    if (["queued", "running", "failed"].includes(candidate.onboardingStatus)) {
      return false;
    }
    return !(
      candidate.websiteStatus === "pending" &&
      candidate.onboardingStatus !== "awaiting_confirmation"
    );
  });
  return eligible.find((candidate) => candidate.isPrimary) ?? eligible[0] ?? null;
}

function defaultStripe(): StripeClient {
  return new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
  });
}

function asRemovalStatus(value: string): WebsiteRemovalStatus {
  return value === "cancellation_pending" || value === "removed"
    ? value
    : "active";
}

function asBillingAction(value: string | null): WebsiteRemovalBillingAction {
  return WEBSITE_REMOVAL_BILLING_ACTIONS.includes(
    value as WebsiteRemovalBillingAction,
  )
    ? (value as WebsiteRemovalBillingAction)
    : "unknown";
}

function pendingError(error: unknown): { message: string; at: string } {
  const message = error instanceof Error ? error.message : "Stripe operation failed";
  return {
    message: message.replace(/\s+/g, " ").trim().slice(0, 500),
    at: new Date().toISOString(),
  };
}

function isStripeResourceMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown };
  };
  return (
    record.code === "resource_missing" ||
    record.raw?.code === "resource_missing" ||
    record.statusCode === 404
  );
}

function stripeSubscriptionId(
  value: string | Stripe.Subscription | null | undefined,
): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function isStripeSubscriptionActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

export function classifyWebsiteRemovalBilling(input: {
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
  liveSubscriptionItemIds: string[];
  siblingWebsiteSubscriptionCount: number;
  subscriptionMetadata?: Record<string, string> | null;
  businessId: string;
}): WebsiteRemovalBillingAction {
  if (!input.stripeSubscriptionId && !input.stripeSubscriptionItemId) {
    return "none";
  }

  const storedItemIsLive = Boolean(
    input.stripeSubscriptionItemId &&
      input.liveSubscriptionItemIds.includes(input.stripeSubscriptionItemId),
  );
  const hasOtherLiveItems = storedItemIsLive
    ? input.liveSubscriptionItemIds.some(
        (itemId) => itemId !== input.stripeSubscriptionItemId,
      )
    : false;
  const shared = input.siblingWebsiteSubscriptionCount > 0 || hasOtherLiveItems;

  if (shared) {
    return input.stripeSubscriptionItemId
      ? "delete_shared_subscription_item"
      : "unknown";
  }

  // A live item different from the DB-mapped item is not proof that the old
  // item was removed. It can be stale/corrupt mapping on a still-billing
  // dedicated subscription, so never report convergence from this state.
  if (
    input.stripeSubscriptionItemId &&
    input.liveSubscriptionItemIds.length > 0 &&
    !storedItemIsLive
  ) {
    return "unknown";
  }

  // Metadata is supporting evidence, not the authority: old shared subscriptions
  // do not have item metadata, while new per-site subscriptions do. Live item
  // cardinality plus the DB sibling mapping is what prevents sibling cancellation.
  const metadataBusinessId = input.subscriptionMetadata?.businessId;
  if (metadataBusinessId && metadataBusinessId !== input.businessId) {
    return "unknown";
  }

  return input.stripeSubscriptionId
    ? "cancel_dedicated_subscription"
    : input.stripeSubscriptionItemId
      ? "delete_shared_subscription_item"
      : "none";
}

export function getWebsiteRestoreEligibility(input: {
  removalStatus: string;
  recoveryDeadline: Date | null;
  billingAction: string | null;
  previousSubscriptionStatus?: string | null;
  trialEndDate?: Date | null;
  isStaff?: boolean;
  now?: Date;
}): WebsiteRemovalRestoreEligibility {
  if (input.removalStatus !== "removed") return "not_removed";
  const now = input.now ?? new Date();
  if (!input.recoveryDeadline || input.recoveryDeadline.getTime() <= now.getTime()) {
    return "expired";
  }
  if (input.billingAction === "delete_shared_subscription_item") {
    return "eligible";
  }
  if (input.billingAction === "none") {
    const trialStillValid =
      input.previousSubscriptionStatus === "trialing" &&
      Boolean(input.trialEndDate && input.trialEndDate.getTime() > now.getTime());
    return input.isStaff || trialStillValid ? "eligible" : "billing_required";
  }
  return "billing_required";
}

export function serializeWebsiteRemovalLifecycle(
  website: StoredRemovalBusiness,
  input: { now?: Date; isStaff?: boolean } = {},
) {
  const status = asRemovalStatus(website.removalStatus);
  const billingAction =
    status === "active" ? "none" : asBillingAction(website.removalBillingAction);
  return {
    status,
    requestedAt: website.removalRequestedAt?.toISOString() ?? null,
    completedAt: website.removalCompletedAt?.toISOString() ?? null,
    recoveryDeadline: website.removalRecoveryDeadline?.toISOString() ?? null,
    billingAction,
    retryable: status === "cancellation_pending",
    restoreEligibility: getWebsiteRestoreEligibility({
      removalStatus: status,
      recoveryDeadline: website.removalRecoveryDeadline,
      billingAction: website.removalBillingAction,
      previousSubscriptionStatus: website.removalPreviousSubscriptionStatus,
      trialEndDate: website.websiteSubscription?.trialEndDate,
      isStaff: input.isStaff,
      now: input.now,
    }),
  };
}

function removalDto(
  website: StoredRemovalBusiness,
  input: { idempotent: boolean; billingOutcome?: WebsiteRemovalBillingOutcome },
): WebsiteRemovalDto {
  const removalStatus = asRemovalStatus(website.removalStatus);
  const billingAction =
    removalStatus === "active"
      ? "none"
      : asBillingAction(website.removalBillingAction);
  const billingOutcome =
    input.billingOutcome ??
    (removalStatus === "active"
      ? "not_required"
      : removalStatus === "cancellation_pending"
      ? "pending"
      : billingAction === "none"
        ? "not_required"
        : "confirmed");
  return {
    businessId: website.id,
    removalStatus,
    billingAction,
    billingOutcome,
    recoveryDeadline: website.removalRecoveryDeadline?.toISOString() ?? null,
    replacementBusinessId: website.removalReplacementBusinessId,
    selectedWebsiteId: website.removalReplacementBusinessId,
    retryable: removalStatus === "cancellation_pending",
    idempotent: input.idempotent,
  };
}

async function loadRemovalBusiness(
  db: DbClient,
  businessId: string,
): Promise<StoredRemovalBusiness | null> {
  return db.business.findUnique({
    where: { id: businessId },
    include: { websiteSubscription: true },
  }) as Promise<StoredRemovalBusiness | null>;
}

async function updateWebsiteCount(db: DbClient, userId: string) {
  const activeCount = await db.business.count({
    where: { userId, isActive: true, removalStatus: "active" },
  });
  await db.subscription.updateMany({
    where: { userId },
    data: { websiteCount: activeCount },
  });
}

async function claimWebsiteRemoval(input: {
  db: DbClient;
  business: StoredRemovalBusiness;
  now: Date;
  operationKey: string;
}) {
  const { db, business, now, operationKey } = input;
  const recoveryDeadline = new Date(
    now.getTime() + WEBSITE_REMOVAL_RECOVERY_DAYS * 24 * 60 * 60 * 1000,
  );

  return db.$transaction(async (tx) => {
    const activeCount = await tx.business.count({
      where: {
        userId: business.userId,
        isActive: true,
        removalStatus: "active",
      },
    });
    const candidates = await tx.business.findMany({
      where: {
        userId: business.userId,
        id: { not: business.id },
        isActive: true,
        removalStatus: "active",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        isPrimary: true,
        websiteStatus: true,
        onboardingStatus: true,
      },
    });
    const replacement = selectWebsiteRemovalReplacement(
      candidates.map((candidate) => ({
        ...candidate,
        onboardingStatus: String(candidate.onboardingStatus),
      })),
    );
    const replacementBusinessId = replacement?.id ?? null;
    if (!replacementBusinessId) {
      throw new WebsiteRemovalError(
        "LAST_ACTIVE_WEBSITE",
        "Add another website before removing your final active website.",
        409,
      );
    }

    const claimed = await tx.business.updateMany({
      where: {
        id: business.id,
        userId: business.userId,
        isActive: true,
        removalStatus: "active",
      },
      data: {
        isActive: false,
        isPrimary: false,
        websiteStatus: "cancellation_pending",
        removalStatus: "cancellation_pending",
        removalRequestedAt: now,
        removalCompletedAt: null,
        removalRecoveryDeadline: recoveryDeadline,
        removalPreviousWebsiteStatus: business.websiteStatus,
        removalPreviousSubscriptionStatus:
          business.websiteSubscription?.status ?? null,
        removalBillingAction: "unknown",
        removalBillingObjectId: null,
        removalOperationKey: operationKey,
        removalReplacementBusinessId: replacementBusinessId,
        removalLastError: Prisma.DbNull,
      },
    });
    if (claimed.count !== 1) return null;

    if (business.isPrimary || !replacement?.isPrimary) {
      await tx.business.updateMany({
        where: {
          userId: business.userId,
          id: { not: replacementBusinessId },
          isActive: true,
          removalStatus: "active",
          isPrimary: true,
        },
        data: { isPrimary: false },
      });
      await tx.business.update({
        where: { id: replacementBusinessId },
        data: { isPrimary: true },
      });
    }

    await tx.stripeRetryQueue.create({
      data: {
        userId: business.userId,
        businessId: business.id,
        operationKey,
        operationType: "remove_website",
        stripeObjectId:
          business.websiteSubscription?.stripeSubscriptionId ??
          business.websiteSubscription?.stripeSubscriptionItemId ??
          business.id,
        stripeObjectType: business.websiteSubscription?.stripeSubscriptionId
          ? "subscription"
          : business.websiteSubscription?.stripeSubscriptionItemId
            ? "subscription_item"
            : "business",
        payload: {
          businessId: business.id,
          websiteSubscriptionId: business.websiteSubscription?.id ?? null,
        },
        status: "pending",
        nextRetryAt: now,
        maxRetries: 5,
      },
    });

    await tx.subscription.updateMany({
      where: { userId: business.userId },
      data: { websiteCount: activeCount - 1 },
    });
    return replacementBusinessId;
  });
}

type BillingRemovalResult = {
  action: Exclude<WebsiteRemovalBillingAction, "unknown">;
  objectId: string | null;
  outcome: "not_required" | "confirmed";
};

export async function executeWebsiteRemovalBilling(input: {
  db: DbClient;
  stripe: StripeClient;
  business: StoredRemovalBusiness;
  operationKey: string;
}): Promise<BillingRemovalResult> {
  const { db, stripe, business, operationKey } = input;
  const storedSubscriptionId =
    business.websiteSubscription?.stripeSubscriptionId ?? null;
  const storedItemId =
    business.websiteSubscription?.stripeSubscriptionItemId ?? null;

  if (!storedSubscriptionId && !storedItemId) {
    return { action: "none", objectId: null, outcome: "not_required" };
  }

  let subscriptionId = storedSubscriptionId;
  let retrievedItem: Stripe.SubscriptionItem | null = null;
  if (!subscriptionId && storedItemId) {
    try {
      retrievedItem = await stripe.subscriptionItems.retrieve(storedItemId);
      subscriptionId = stripeSubscriptionId(retrievedItem.subscription);
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        return {
          action: "delete_shared_subscription_item",
          objectId: storedItemId,
          outcome: "confirmed",
        };
      }
      throw error;
    }
  }

  if (!subscriptionId) {
    throw new WebsiteRemovalError(
      "WEBSITE_BILLING_UNKNOWN",
      "The website billing record could not be verified.",
      503,
    );
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      const siblingCount = await db.websiteSubscription.count({
        where: {
          stripeSubscriptionId: subscriptionId,
          businessId: { not: business.id },
          business: { removalStatus: { not: "removed" } },
        },
      });
      return {
        action:
          siblingCount > 0
            ? "delete_shared_subscription_item"
            : "cancel_dedicated_subscription",
        objectId: siblingCount > 0 ? storedItemId : subscriptionId,
        outcome: "confirmed",
      };
    }
    throw error;
  }

  const siblingCount = await db.websiteSubscription.count({
    where: {
      stripeSubscriptionId: subscriptionId,
      businessId: { not: business.id },
      business: { removalStatus: { not: "removed" } },
    },
  });
  const liveItemIds = subscription.items.data.map((item) => item.id);

  const persistedAction = asBillingAction(business.removalBillingAction);
  if (
    persistedAction === "delete_shared_subscription_item" &&
    business.removalBillingObjectId === storedItemId &&
    storedItemId
  ) {
    try {
      retrievedItem =
        retrievedItem ?? (await stripe.subscriptionItems.retrieve(storedItemId));
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        return {
          action: "delete_shared_subscription_item",
          objectId: storedItemId,
          outcome: "confirmed",
        };
      }
      throw error;
    }
    if (stripeSubscriptionId(retrievedItem.subscription) !== subscriptionId) {
      throw new WebsiteRemovalError(
        "WEBSITE_BILLING_UNKNOWN",
        "The shared subscription item does not belong to the expected subscription.",
        503,
      );
    }
    if (!liveItemIds.includes(storedItemId)) liveItemIds.push(storedItemId);
  }

  if (storedItemId && !retrievedItem) {
    try {
      retrievedItem = await stripe.subscriptionItems.retrieve(storedItemId);
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
    }
    if (retrievedItem) {
      if (stripeSubscriptionId(retrievedItem.subscription) !== subscriptionId) {
        throw new WebsiteRemovalError(
          "WEBSITE_BILLING_UNKNOWN",
          "The subscription item does not belong to the expected subscription.",
          503,
        );
      }
      if (!liveItemIds.includes(storedItemId)) liveItemIds.push(storedItemId);
    }
  }

  const classifiedAction = classifyWebsiteRemovalBilling({
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionItemId: storedItemId,
    liveSubscriptionItemIds: liveItemIds,
    siblingWebsiteSubscriptionCount: siblingCount,
    subscriptionMetadata: subscription.metadata,
    businessId: business.id,
  });

  const action =
    persistedAction === "delete_shared_subscription_item" ||
    persistedAction === "cancel_dedicated_subscription"
      ? persistedAction
      : classifiedAction;

  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    return {
      action:
        action === "unknown"
          ? siblingCount > 0
            ? "delete_shared_subscription_item"
            : "cancel_dedicated_subscription"
          : action,
      objectId:
        siblingCount > 0 ? storedItemId : subscriptionId,
      outcome: "confirmed",
    };
  }

  if (action === "unknown") {
    throw new WebsiteRemovalError(
      "WEBSITE_BILLING_UNKNOWN",
      "The website billing record could not be safely isolated.",
      503,
    );
  }

  await db.business.updateMany({
    where: {
      id: business.id,
      removalStatus: "cancellation_pending",
      removalOperationKey: operationKey,
    },
    data: {
      removalBillingAction: action,
      removalBillingObjectId:
        action === "cancel_dedicated_subscription"
          ? subscriptionId
          : storedItemId,
    },
  });

  if (action === "cancel_dedicated_subscription") {
    const canceled = await stripe.subscriptions.cancel(
      subscriptionId,
      {},
      { idempotencyKey: `website-remove-sub:${operationKey}` },
    );
    if (canceled.status !== "canceled") {
      const confirmed = await stripe.subscriptions.retrieve(subscriptionId);
      if (confirmed.status !== "canceled") {
        throw new Error("Stripe subscription cancellation is not confirmed");
      }
    }
    return { action, objectId: subscriptionId, outcome: "confirmed" };
  }

  if (!storedItemId) {
    throw new WebsiteRemovalError(
      "WEBSITE_BILLING_UNKNOWN",
      "The shared subscription item could not be identified.",
      503,
    );
  }

  if (!retrievedItem) {
    try {
      retrievedItem = await stripe.subscriptionItems.retrieve(storedItemId);
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        return { action, objectId: storedItemId, outcome: "confirmed" };
      }
      throw error;
    }
  }
  if (stripeSubscriptionId(retrievedItem.subscription) !== subscriptionId) {
    throw new WebsiteRemovalError(
      "WEBSITE_BILLING_UNKNOWN",
      "The shared subscription item does not belong to the expected subscription.",
      503,
    );
  }

  const deleted = await stripe.subscriptionItems.del(
    storedItemId,
    {},
    { idempotencyKey: `website-remove-item:${operationKey}` },
  );
  if (!deleted.deleted) {
    throw new Error("Stripe subscription item deletion is not confirmed");
  }
  return { action, objectId: storedItemId, outcome: "confirmed" };
}

async function markRemovalFailed(input: {
  db: DbClient;
  businessId: string;
  operationKey: string;
  error: unknown;
  now: Date;
}) {
  const queue = await input.db.stripeRetryQueue.findUnique({
    where: { operationKey: input.operationKey },
  });
  const nextRetryCount = (queue?.retryCount ?? 0) + 1;
  const maxRetries = queue?.maxRetries ?? 5;
  const exhausted = nextRetryCount >= maxRetries;
  const retryDelayMinutes = Math.min(60, 5 * 2 ** Math.max(0, nextRetryCount - 1));
  const safeError = pendingError(input.error);

  await input.db.$transaction([
    input.db.business.updateMany({
      where: {
        id: input.businessId,
        removalStatus: "cancellation_pending",
        removalOperationKey: input.operationKey,
      },
      data: { removalLastError: safeError },
    }),
    input.db.stripeRetryQueue.updateMany({
      where: { operationKey: input.operationKey },
      data: {
        status: exhausted ? "failed" : "pending",
        retryCount: nextRetryCount,
        lastError: safeError.message,
        nextRetryAt: exhausted
          ? null
          : new Date(input.now.getTime() + retryDelayMinutes * 60 * 1000),
      },
    }),
  ]);
}

async function finalizeRemoval(input: {
  db: DbClient;
  business: StoredRemovalBusiness;
  operationKey: string;
  billing: BillingRemovalResult;
  now: Date;
}) {
  const { db, business, operationKey, billing, now } = input;
  await db.$transaction(async (tx) => {
    const updated = await tx.business.updateMany({
      where: {
        id: business.id,
        removalStatus: "cancellation_pending",
        removalOperationKey: operationKey,
      },
      data: {
        isActive: false,
        isPrimary: false,
        websiteStatus: "suspended",
        removalStatus: "removed",
        removalCompletedAt: now,
        removalBillingAction: billing.action,
        removalBillingObjectId: billing.objectId,
        removalLastError: Prisma.DbNull,
      },
    });
    if (updated.count !== 1) return;

    if (business.websiteSubscription) {
      await tx.websiteSubscription.updateMany({
        where: { id: business.websiteSubscription.id },
        data: { status: "canceled" },
      });
    }

    if (
      billing.action === "cancel_dedicated_subscription" &&
      billing.objectId
    ) {
      const aggregate = await tx.subscription.findUnique({
        where: { userId: business.userId },
        select: { stripeSubscriptionId: true },
      });
      if (aggregate?.stripeSubscriptionId === billing.objectId) {
        const survivingBusinesses = await tx.business.findMany({
          where: {
            userId: business.userId,
            id: { not: business.id },
            isActive: true,
            removalStatus: "active",
            websiteSubscription: {
              is: {
                status: { in: ["active", "trialing"] },
                stripeSubscriptionId: { not: null },
              },
            },
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
          select: {
            websiteSubscription: {
              select: {
                stripeSubscriptionId: true,
                stripePriceId: true,
                status: true,
                currentPeriodEnd: true,
              },
            },
          },
        });
        const survivingSubscription = survivingBusinesses[0]?.websiteSubscription;
        const survivor = survivingSubscription?.stripeSubscriptionId
          ? {
              stripeSubscriptionId: survivingSubscription.stripeSubscriptionId,
              stripePriceId: survivingSubscription.stripePriceId,
              status: survivingSubscription.status,
              currentPeriodEnd: survivingSubscription.currentPeriodEnd,
            }
          : null;
        const aggregateUpdate = buildAggregateSubscriptionReconciliation({
          aggregateStripeSubscriptionId: aggregate.stripeSubscriptionId,
          canceledStripeSubscriptionId: billing.objectId,
          survivor,
          now,
        });
        if (aggregateUpdate) {
          await tx.subscription.update({
            where: { userId: business.userId },
            data: aggregateUpdate,
          });
        }
      }
    }
    await tx.stripeRetryQueue.updateMany({
      where: { operationKey },
      data: {
        status: "completed",
        completedAt: now,
        nextRetryAt: null,
        lastError: null,
      },
    });
  });
  await updateWebsiteCount(db, business.userId);
}

export async function processWebsiteRemovalOperation(
  businessId: string,
  operationKey: string,
  deps: WebsiteRemovalDeps = {},
): Promise<WebsiteRemovalDto> {
  const db = deps.db ?? prisma;
  const stripe = deps.stripe ?? defaultStripe();
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await db.stripeRetryQueue.updateMany({
    where: {
      operationKey,
      businessId,
      status: { in: ["pending", "failed"] },
    },
    data: { status: "processing", nextRetryAt: null },
  });
  if (claimed.count !== 1) {
    const existing = await loadRemovalBusiness(db, businessId);
    if (!existing) {
      throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
    }
    return removalDto(existing, { idempotent: true });
  }

  const business = await loadRemovalBusiness(db, businessId);
  if (!business || business.removalOperationKey !== operationKey) {
    throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
  }
  if (business.removalStatus === "removed") {
    await db.stripeRetryQueue.updateMany({
      where: { operationKey },
      data: { status: "completed", completedAt: now, nextRetryAt: null },
    });
    return removalDto(business, { idempotent: true });
  }

  try {
    const billing = await executeWebsiteRemovalBilling({
      db,
      stripe,
      business,
      operationKey,
    });
    await finalizeRemoval({ db, business, operationKey, billing, now });
    const finalized = await loadRemovalBusiness(db, businessId);
    if (!finalized) {
      throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
    }
    return removalDto(finalized, {
      idempotent: false,
      billingOutcome: billing.outcome,
    });
  } catch (error) {
    await markRemovalFailed({ db, businessId, operationKey, error, now });
    const pending = await loadRemovalBusiness(db, businessId);
    if (!pending) throw error;
    return removalDto(pending, {
      idempotent: false,
      billingOutcome: "pending",
    });
  }
}

export async function requestWebsiteRemoval(
  userId: string,
  businessId: string,
  deps: WebsiteRemovalDeps = {},
): Promise<WebsiteRemovalDto> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  let business = await loadRemovalBusiness(db, businessId);
  if (!business || business.userId !== userId) {
    throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
  }

  if (business.removalStatus === "removed") {
    return removalDto(business, { idempotent: true });
  }
  if (business.removalStatus === "cancellation_pending") {
    return removalDto(business, { idempotent: true });
  }
  if (!business.isActive) {
    throw new WebsiteRemovalError(
      "WEBSITE_NOT_ACTIVE",
      "Only an active website can be removed.",
      409,
    );
  }

  const operationKey = (deps.operationId ?? randomUUID)();
  const claimed = await claimWebsiteRemoval({ db, business, now, operationKey });
  if (!claimed) {
    business = await loadRemovalBusiness(db, businessId);
    if (!business || business.userId !== userId) {
      throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
    }
    return removalDto(business, { idempotent: true });
  }

  return processWebsiteRemovalOperation(businessId, operationKey, {
    ...deps,
    db,
    now: () => now,
  });
}

export async function retryWebsiteRemoval(
  userId: string,
  businessId: string,
  deps: WebsiteRemovalDeps = {},
): Promise<WebsiteRemovalDto> {
  const db = deps.db ?? prisma;
  const business = await loadRemovalBusiness(db, businessId);
  if (!business || business.userId !== userId) {
    throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
  }
  if (business.removalStatus !== "cancellation_pending" || !business.removalOperationKey) {
    return removalDto(business, { idempotent: true });
  }
  await db.stripeRetryQueue.updateMany({
    where: {
      operationKey: business.removalOperationKey,
      status: { in: ["pending", "failed"] },
    },
    data: { status: "pending", nextRetryAt: new Date(), retryCount: 0 },
  });
  return processWebsiteRemovalOperation(
    business.id,
    business.removalOperationKey,
    deps,
  );
}

export async function restoreWebsite(
  userId: string,
  businessId: string,
  deps: WebsiteRemovalDeps = {},
): Promise<WebsiteRestoreDto> {
  const db = deps.db ?? prisma;
  const stripe = deps.stripe ?? defaultStripe();
  const now = (deps.now ?? (() => new Date()))();
  const business = await loadRemovalBusiness(db, businessId);
  if (!business || business.userId !== userId) {
    throw new WebsiteRemovalError("WEBSITE_NOT_FOUND", "Website not found.", 404);
  }
  if (business.removalStatus === "active") {
    if (!business.isActive) {
      if (business.removalRestoredAt && business.websiteStatus === "expired") {
        return {
          businessId,
          removalStatus: "active",
          isActive: false,
          websiteStatus: "expired",
          selectedWebsiteId: business.removalReplacementBusinessId,
          billingAction: "none",
          requiresSubscription: true,
          idempotent: true,
        };
      }
      throw new WebsiteRemovalError(
        "WEBSITE_NOT_REMOVED",
        "This inactive website was not removed through the recoverable removal flow.",
        409,
      );
    }
    return {
      businessId,
      removalStatus: "active",
      isActive: true,
      websiteStatus: business.websiteStatus,
      selectedWebsiteId: businessId,
      billingAction: "none",
      requiresSubscription: false,
      idempotent: true,
    };
  }
  if (business.removalStatus === "cancellation_pending") {
    throw new WebsiteRemovalError(
      "WEBSITE_REMOVAL_PENDING",
      "Billing cancellation is still pending. Retry removal before restoring.",
      409,
    );
  }
  if (
    !business.removalRecoveryDeadline ||
    business.removalRecoveryDeadline.getTime() <= now.getTime()
  ) {
    throw new WebsiteRemovalError(
      "WEBSITE_RESTORE_WINDOW_EXPIRED",
      "The 30-day website recovery window has expired.",
      410,
      { businessId, recoveryDeadline: business.removalRecoveryDeadline?.toISOString() ?? null },
    );
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const isStaff = user?.role === "ADMIN" || user?.role === "SUPERADMIN";
  const eligibility = getWebsiteRestoreEligibility({
    removalStatus: business.removalStatus,
    recoveryDeadline: business.removalRecoveryDeadline,
    billingAction: business.removalBillingAction,
    previousSubscriptionStatus: business.removalPreviousSubscriptionStatus,
    trialEndDate: business.websiteSubscription?.trialEndDate,
    isStaff,
    now,
  });
  if (eligibility !== "eligible") {
    // Recover the retained record without reactivating entitlement. This makes
    // the website available to the existing Subscribe flow while keeping all
    // paid features disabled and preserving the current active selection.
    await db.business.update({
      where: { id: businessId },
      data: {
        isActive: false,
        isPrimary: false,
        websiteStatus: "expired",
        removalStatus: "active",
        removalRestoredAt: now,
        removalRequestedAt: null,
        removalCompletedAt: null,
        removalRecoveryDeadline: null,
        removalPreviousWebsiteStatus: null,
        removalPreviousSubscriptionStatus: null,
        removalBillingAction: null,
        removalBillingObjectId: null,
        removalOperationKey: null,
        removalLastError: Prisma.DbNull,
      },
    });
    return {
      businessId,
      removalStatus: "active",
      isActive: false,
      websiteStatus: "expired",
      selectedWebsiteId: business.removalReplacementBusinessId,
      billingAction: "none",
      requiresSubscription: true,
      idempotent: false,
    };
  }

  let restoredItemId: string | null = null;
  let restoreBillingAction: "restore_shared_subscription_item" | "none" = "none";
  if (business.removalBillingAction === "delete_shared_subscription_item") {
    const websiteSubscription = business.websiteSubscription;
    if (
      !websiteSubscription?.stripeSubscriptionId ||
      !websiteSubscription.stripePriceId ||
      !business.removalOperationKey
    ) {
      throw new WebsiteRemovalError(
        "WEBSITE_RESTORE_BILLING_REQUIRED",
        "A new website subscription is required to restore this website.",
        409,
        { businessId, checkoutRequired: true },
      );
    }
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(
        websiteSubscription.stripeSubscriptionId,
      );
    } catch (error) {
      if (isStripeResourceMissing(error)) {
        throw new WebsiteRemovalError(
          "WEBSITE_RESTORE_BILLING_REQUIRED",
          "A new website subscription is required to restore this website.",
          409,
          { businessId, checkoutRequired: true },
        );
      }
      throw error;
    }
    if (!isStripeSubscriptionActive(subscription.status)) {
      throw new WebsiteRemovalError(
        "WEBSITE_RESTORE_BILLING_REQUIRED",
        "A new website subscription is required to restore this website.",
        409,
        { businessId, checkoutRequired: true },
      );
    }
    const item = await stripe.subscriptionItems.create(
      {
        subscription: subscription.id,
        price: websiteSubscription.stripePriceId,
        quantity: 1,
        proration_behavior: "create_prorations",
        metadata: { businessId, type: "website_restore" },
      },
      { idempotencyKey: `website-restore-item:${business.removalOperationKey}` },
    );
    if (stripeSubscriptionId(item.subscription) !== subscription.id) {
      throw new Error("Restored Stripe subscription item is not confirmed");
    }
    restoredItemId = item.id;
    restoreBillingAction = "restore_shared_subscription_item";
  }

  const restoredWebsiteStatus = business.removalPreviousWebsiteStatus || "active";
  await db.$transaction(async (tx) => {
    if (business.websiteSubscription) {
      await tx.websiteSubscription.update({
        where: { id: business.websiteSubscription.id },
        data: {
          status: business.removalPreviousSubscriptionStatus || "active",
          ...(restoredItemId
            ? { stripeSubscriptionItemId: restoredItemId }
            : {}),
        },
      });
    }
    const primaryCount = await tx.business.count({
      where: { userId, isActive: true, isPrimary: true, removalStatus: "active" },
    });
    await tx.business.update({
      where: { id: businessId },
      data: {
        isActive: true,
        isPrimary: primaryCount === 0,
        websiteStatus: restoredWebsiteStatus,
        removalStatus: "active",
        removalRestoredAt: now,
        removalRequestedAt: null,
        removalCompletedAt: null,
        removalRecoveryDeadline: null,
        removalPreviousWebsiteStatus: null,
        removalPreviousSubscriptionStatus: null,
        removalBillingAction: null,
        removalBillingObjectId: null,
        removalOperationKey: null,
        removalReplacementBusinessId: null,
        removalLastError: Prisma.DbNull,
      },
    });
  });
  await updateWebsiteCount(db, userId);

  return {
    businessId,
    removalStatus: "active",
    isActive: true,
    websiteStatus: restoredWebsiteStatus,
    selectedWebsiteId: businessId,
    billingAction: restoreBillingAction,
    requiresSubscription: false,
    idempotent: false,
  };
}

export async function processWebsiteRemovalRetryBatch(
  deps: WebsiteRemovalDeps & { limit?: number } = {},
) {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
  await db.stripeRetryQueue.updateMany({
    where: {
      operationType: "remove_website",
      status: "processing",
      updatedAt: { lte: staleBefore },
    },
    data: { status: "pending", nextRetryAt: now },
  });
  const jobs = await db.stripeRetryQueue.findMany({
    where: {
      operationType: "remove_website",
      status: "pending",
      nextRetryAt: { lte: now },
      businessId: { not: null },
      operationKey: { not: null },
    },
    orderBy: [{ nextRetryAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(deps.limit ?? 20, 100)),
    select: { businessId: true, operationKey: true },
  });

  let completed = 0;
  let pending = 0;
  for (const job of jobs) {
    if (!job.businessId || !job.operationKey) continue;
    try {
      const result = await processWebsiteRemovalOperation(
        job.businessId,
        job.operationKey,
        { ...deps, db, now: () => now },
      );
      if (result.removalStatus === "removed") completed += 1;
      else pending += 1;
    } catch {
      // Keep the batch moving; a stale `processing` job is reclaimed on a
      // later pass even if the database failed before its retry state changed.
      pending += 1;
    }
  }
  return { scanned: jobs.length, completed, pending };
}
