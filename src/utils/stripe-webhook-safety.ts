export type StripeWebhookEventRow = {
  id: string;
  status: string;
  leaseExpiresAt: Date | null;
};

export type StripeWebhookEventStore = {
  create(input: {
    data: {
      id: string;
      status: string;
      attemptCount: number;
      leaseExpiresAt: Date;
      lastError: null;
    };
  }): Promise<unknown>;
  findUnique(input: {
    where: { id: string };
    select: {
      id: true;
      status: true;
      leaseExpiresAt: true;
    };
  }): Promise<StripeWebhookEventRow | null>;
  updateMany(input: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

export type StripeWebhookEventClaim =
  | { status: "claimed" }
  | { status: "duplicate" }
  | { status: "in_progress"; retryAfterSeconds: number }
  | { status: "untracked"; errorCode: string | null };

const DEFAULT_LEASE_SECONDS = 5 * 60;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Webhook processing failed";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function claimStripeWebhookEvent(
  store: StripeWebhookEventStore,
  eventId: string,
  options?: { now?: Date; leaseSeconds?: number },
): Promise<StripeWebhookEventClaim> {
  const now = options?.now ?? new Date();
  const leaseSeconds = Math.max(
    30,
    Math.min(15 * 60, options?.leaseSeconds ?? DEFAULT_LEASE_SECONDS),
  );
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  try {
    await store.create({
      data: {
        id: eventId,
        status: "processing",
        attemptCount: 1,
        leaseExpiresAt,
        lastError: null,
      },
    });
    return { status: "claimed" };
  } catch (error) {
    const code = errorCode(error);
    if (code !== "P2002") {
      return { status: "untracked", errorCode: code };
    }
  }

  try {
    const existing = await store.findUnique({
      where: { id: eventId },
      select: { id: true, status: true, leaseExpiresAt: true },
    });
    if (!existing) return { status: "untracked", errorCode: "CLAIM_MISSING" };
    if (existing.status === "processed") return { status: "duplicate" };

    if (
      existing.status === "processing" &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    ) {
      return {
        status: "in_progress",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.leaseExpiresAt.getTime() - now.getTime()) / 1000),
        ),
      };
    }

    const takeover = await store.updateMany({
      where: {
        id: eventId,
        OR: [
          { status: "failed" },
          { status: "processing", leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "processing",
        leaseExpiresAt,
        lastError: null,
        attemptCount: { increment: 1 },
        processedAt: null,
      },
    });
    return takeover.count === 1
      ? { status: "claimed" }
      : { status: "in_progress", retryAfterSeconds: 5 };
  } catch (error) {
    return { status: "untracked", errorCode: errorCode(error) };
  }
}

export async function completeStripeWebhookEvent(
  store: StripeWebhookEventStore,
  eventId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const completed = await store.updateMany({
      where: { id: eventId, status: "processing" },
      data: {
        status: "processed",
        processedAt: now,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return completed.count === 1;
  } catch {
    return false;
  }
}

export async function releaseFailedStripeWebhookEvent(
  store: StripeWebhookEventStore,
  eventId: string,
  error?: unknown,
): Promise<boolean> {
  try {
    const released = await store.updateMany({
      where: { id: eventId, status: "processing" },
      data: {
        status: "failed",
        leaseExpiresAt: null,
        lastError: boundedError(error),
      },
    });
    return released.count === 1;
  } catch {
    return false;
  }
}

export function isRemovalLifecycleProtected(
  removalStatus: string | null | undefined,
): boolean {
  return Boolean(removalStatus && removalStatus !== "active");
}

type StripeItemIdentity = {
  id: string;
  metadata?: { businessId?: string | null } | null;
};

export function resolveSafeSubscriptionItemForBusiness<
  TItem extends StripeItemIdentity,
>(input: {
  businessId: string;
  existingSubscriptionItemId?: string | null;
  items: readonly TItem[];
}): TItem | null {
  if (input.existingSubscriptionItemId) {
    return (
      input.items.find(
        (item) => item.id === input.existingSubscriptionItemId,
      ) ?? null
    );
  }
  const metadataMatch = input.items.find(
    (item) => item.metadata?.businessId === input.businessId,
  );
  if (metadataMatch) return metadataMatch;
  return input.items.length === 1 ? (input.items[0] ?? null) : null;
}

export class WebsiteRemovalSyncBlockedError extends Error {
  readonly businessId: string;
  readonly removalStatus: string;

  constructor(businessId: string, removalStatus: string) {
    super(
      "Billing sync blocked for business " +
        businessId +
        " while removal status is " +
        removalStatus,
    );
    this.name = "WebsiteRemovalSyncBlockedError";
    this.businessId = businessId;
    this.removalStatus = removalStatus;
  }
}
