import type { PrismaClient } from "@prisma/client";

export type SocialTopicInitializationStatus =
  | "not_started"
  | "queued"
  | "planning"
  | "ready"
  | "failed";

type SocialTopicInitializationRecord = {
  initialPlanStatus?: string | null;
  initialPlanQueuedAt?: Date | null;
  initialPlanStartedAt?: Date | null;
  initialPlanGeneratedAt?: Date | null;
  initialPlanErrorCode?: string | null;
  initialPlanErrorMessage?: string | null;
};

export function publicSocialTopicInitialization(
  settings: SocialTopicInitializationRecord | null | undefined,
) {
  const status: SocialTopicInitializationStatus = settings?.initialPlanGeneratedAt
    ? "ready"
    : settings?.initialPlanStatus === "queued" ||
        settings?.initialPlanStatus === "planning" ||
        settings?.initialPlanStatus === "failed"
      ? settings.initialPlanStatus
      : "not_started";

  return {
    status,
    queuedAt: settings?.initialPlanQueuedAt?.toISOString() ?? null,
    startedAt: settings?.initialPlanStartedAt?.toISOString() ?? null,
    completedAt: settings?.initialPlanGeneratedAt?.toISOString() ?? null,
    error:
      status === "failed"
        ? {
            code:
              settings?.initialPlanErrorCode ||
              "SOCIAL_INITIALIZATION_FAILED",
            message:
              settings?.initialPlanErrorMessage ||
              "We couldn't prepare your first social plan. Please retry, or contact support if the problem continues.",
          }
        : null,
  };
}

export function safeSocialTopicInitializationError(error: unknown): {
  code: string;
  message: string;
} {
  const raw = error instanceof Error ? error.message.toLowerCase() : "";
  if (raw.includes("openai_api_key")) {
    return {
      code: "SOCIAL_PLANNER_NOT_CONFIGURED",
      message:
        "Social planning is not configured correctly. Please contact support.",
    };
  }
  if (raw.includes("entitlement") || raw.includes("seo + social")) {
    return {
      code: "SOCIAL_ENTITLEMENT_INACTIVE",
      message:
        "SEO + Social access is not active for this website. Please refresh your billing status or contact support.",
    };
  }
  if (raw.includes("business not found") || raw.includes("inactive")) {
    return {
      code: "SOCIAL_BUSINESS_UNAVAILABLE",
      message:
        "This website is not ready for social planning yet. Complete its setup and retry.",
    };
  }
  return {
    code: "SOCIAL_INITIALIZATION_FAILED",
    message:
      "We couldn't prepare your first social plan. Please retry, or contact support if the problem continues.",
  };
}

export async function markInitialSocialTopicPlanQueued(
  prisma: PrismaClient,
  businessId: string,
) {
  const now = new Date();
  return prisma.socialAutomationSettings.upsert({
    where: { businessId },
    create: {
      businessId,
      enabled: true,
      initialPlanStatus: "queued",
      initialPlanQueuedAt: now,
    },
    update: {
      enabled: true,
      initialPlanStatus: "queued",
      initialPlanQueuedAt: now,
      initialPlanStartedAt: null,
      initialPlanErrorCode: null,
      initialPlanErrorMessage: null,
    },
  });
}

export async function markInitialSocialTopicPlanStarted(
  prisma: PrismaClient,
  businessId: string,
) {
  return prisma.socialAutomationSettings.updateMany({
    where: { businessId, initialPlanGeneratedAt: null },
    data: {
      enabled: true,
      initialPlanStatus: "planning",
      initialPlanStartedAt: new Date(),
      initialPlanErrorCode: null,
      initialPlanErrorMessage: null,
    },
  });
}

export async function markInitialSocialTopicPlanFailed(
  prisma: PrismaClient,
  businessId: string,
  error: unknown,
) {
  const safeError = safeSocialTopicInitializationError(error);
  return prisma.socialAutomationSettings.updateMany({
    where: { businessId, initialPlanGeneratedAt: null },
    data: {
      initialPlanStatus: "failed",
      initialPlanErrorCode: safeError.code,
      initialPlanErrorMessage: safeError.message,
    },
  });
}
