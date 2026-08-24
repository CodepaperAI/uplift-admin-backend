export type CommandCallWebhookEventRow = {
  id: string;
  status: string;
  leaseExpiresAt: Date | null;
};

export type CommandCallWebhookEventStore = {
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
    select: { id: true; status: true; leaseExpiresAt: true };
  }): Promise<CommandCallWebhookEventRow | null>;
  updateMany(input: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

export type CommandCallWebhookClaim =
  | { status: "claimed" }
  | { status: "duplicate" }
  | { status: "in_progress"; retryAfterSeconds: number }
  | { status: "untracked"; errorCode: string | null };

const DEFAULT_LEASE_SECONDS = 5 * 60;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Webhook processing failed";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function claimCommandCallWebhookEvent(
  store: CommandCallWebhookEventStore,
  eventId: string,
  options?: { now?: Date; leaseSeconds?: number },
): Promise<CommandCallWebhookClaim> {
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
    if (code !== "P2002") return { status: "untracked", errorCode: code };
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
          Math.ceil((existing.leaseExpiresAt.getTime() - now.getTime()) / 1_000),
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
        attemptCount: { increment: 1 },
        leaseExpiresAt,
        processedAt: null,
        lastError: null,
      },
    });
    return takeover.count === 1
      ? { status: "claimed" }
      : { status: "in_progress", retryAfterSeconds: 5 };
  } catch (error) {
    return { status: "untracked", errorCode: errorCode(error) };
  }
}

export async function completeCommandCallWebhookEvent(
  store: CommandCallWebhookEventStore,
  eventId: string,
): Promise<boolean> {
  try {
    const completed = await store.updateMany({
      where: { id: eventId, status: "processing" },
      data: {
        status: "processed",
        processedAt: new Date(),
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return completed.count === 1;
  } catch {
    return false;
  }
}

export async function releaseCommandCallWebhookEvent(
  store: CommandCallWebhookEventStore,
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
