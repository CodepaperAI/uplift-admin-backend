import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

export type BusinessOnboardingFlow = "trial_primary" | "website_secondary";
export type BusinessOnboardingStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "failed"
  | "completed";

type OnboardingStateDbClient = typeof prisma | Prisma.TransactionClient;

export type SerializedOnboardingError = {
  code: string;
  stage: string;
  message: string;
  details?: unknown;
};

type QueueInput = {
  businessId: string;
  flow: BusinessOnboardingFlow;
  correlationId?: string | null;
};

type RunningInput = {
  businessId: string;
  correlationId?: string | null;
};

type CompletedInput = {
  businessId: string;
  correlationId?: string | null;
};

type AwaitingConfirmationInput = {
  businessId: string;
  correlationId?: string | null;
  error?: SerializedOnboardingError;
};

type FailedInput = {
  businessId: string;
  correlationId?: string | null;
  error: SerializedOnboardingError;
};

async function invalidateOnboardingReadModels(
  userId: string,
  businessId: string,
): Promise<void> {
  await Promise.all([
    invalidateTenantCache(userId),
    invalidateTenantCache(userId, businessId),
  ]);
}

export function serializeOnboardingError(
  error: unknown,
  fallbackStage = "unknown",
): SerializedOnboardingError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "stage" in error &&
    "message" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { stage?: unknown }).stage === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const typed = error as {
      code: string;
      stage: string;
      message: string;
      details?: unknown;
    };
    return {
      code: typed.code,
      stage: typed.stage,
      message: typed.message,
      details: typed.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: "unexpected_error",
      stage: fallbackStage,
      message: error.message,
    };
  }

  return {
    code: "unexpected_error",
    stage: fallbackStage,
    message: String(error),
  };
}

export async function markBusinessOnboardingQueued(
  db: OnboardingStateDbClient,
  input: QueueInput,
): Promise<void> {
  const business = await db.business.update({
    where: { id: input.businessId },
    data: {
      onboardingFlow: input.flow,
      onboardingStatus: "queued",
      onboardingAttemptCount: { increment: 1 },
      onboardingLastAttemptAt: new Date(),
      onboardingCompletedAt: null,
      onboardingCorrelationId: input.correlationId ?? null,
      onboardingLastError: Prisma.DbNull,
    },
    select: { userId: true },
  });
  await invalidateOnboardingReadModels(business.userId, input.businessId);
}

export async function markBusinessOnboardingRunning(
  db: OnboardingStateDbClient,
  input: RunningInput,
): Promise<void> {
  const business = await db.business.update({
    where: { id: input.businessId },
    data: {
      onboardingStatus: "running",
      onboardingLastAttemptAt: new Date(),
      onboardingCorrelationId: input.correlationId ?? null,
      onboardingLastError: Prisma.DbNull,
    },
    select: { userId: true },
  });
  await invalidateOnboardingReadModels(business.userId, input.businessId);
}

export async function markBusinessOnboardingCompleted(
  db: OnboardingStateDbClient,
  input: CompletedInput,
): Promise<void> {
  const business = await db.business.update({
    where: { id: input.businessId },
    data: {
      onboardingStatus: "completed",
      onboardingCompletedAt: new Date(),
      onboardingCorrelationId: input.correlationId ?? null,
      onboardingLastError: Prisma.DbNull,
    },
    select: { userId: true },
  });
  await invalidateOnboardingReadModels(business.userId, input.businessId);
}

export async function markBusinessOnboardingAwaitingConfirmation(
  db: OnboardingStateDbClient,
  input: AwaitingConfirmationInput,
): Promise<void> {
  const business = await db.business.update({
    where: { id: input.businessId },
    data: {
      onboardingStatus: "awaiting_confirmation",
      onboardingLastAttemptAt: new Date(),
      onboardingCorrelationId: input.correlationId ?? null,
      onboardingLastError: input.error
        ? (input.error as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
    select: { userId: true },
  });
  await invalidateOnboardingReadModels(business.userId, input.businessId);
}

export async function markBusinessOnboardingFailed(
  db: OnboardingStateDbClient,
  input: FailedInput,
): Promise<void> {
  const business = await db.business.update({
    where: { id: input.businessId },
    data: {
      onboardingStatus: "failed",
      onboardingCorrelationId: input.correlationId ?? null,
      onboardingLastError: input.error as Prisma.InputJsonValue,
    },
    select: { userId: true },
  });
  await invalidateOnboardingReadModels(business.userId, input.businessId);
}
