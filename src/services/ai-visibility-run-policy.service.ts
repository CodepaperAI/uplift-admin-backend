import { prisma } from "../config/db.config";
import {
  aiVisibilityAccessSelect,
  hasPaidAiVisibilityAccess,
  hasTrialAiVisibilityAccess,
} from "../utils/ai-visibility-access.utils";
import type { AiVisibilityJobType } from "./ai-visibility-job.service";

export const AI_VISIBILITY_TRIAL_PERIOD_KEY = "trial";

export type AiVisibilityRunPolicyMode =
  | "paid"
  | "trial_unused"
  | "trial_used"
  | "ineligible";

export type AiVisibilityRunPolicyStatus = {
  mode: AiVisibilityRunPolicyMode;
  canRunMonthly: boolean;
  canTriggerTrialRun: boolean;
  nextMonthlyRunAt: Date | null;
  trialRun: {
    id: string;
    status: string;
    citationJobId: string | null;
    discoveryJobId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  reason?: string;
  message: string;
};

export class AiVisibilityTrialRunError extends Error {
  constructor(
    readonly reason:
      | "business_not_found"
      | "inactive_business"
      | "not_trial"
      | "already_used",
    message: string,
  ) {
    super(message);
    this.name = "AiVisibilityTrialRunError";
  }
}

export function getAiVisibilityPeriodKey(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function getNextMonthlyAiVisibilityRunAt(
  now: Date = new Date(),
): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6));
}

export function isAiVisibilityMonthlyCronEnabled(): boolean {
  return process.env.AI_VISIBILITY_MONTHLY_CRON_ENABLED === "true";
}

export async function getAiVisibilityRunPolicyStatus(
  businessId: string,
  now: Date = new Date(),
): Promise<AiVisibilityRunPolicyStatus> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      ...aiVisibilityAccessSelect,
      aiVisibilityTrialRun: {
        select: {
          id: true,
          status: true,
          citationJobId: true,
          discoveryJobId: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const nextMonthlyRunAt = getNextMonthlyAiVisibilityRunAt(now);

  if (!business) {
    return {
      mode: "ineligible",
      canRunMonthly: false,
      canTriggerTrialRun: false,
      nextMonthlyRunAt: null,
      trialRun: null,
      reason: "business_not_found",
      message: "Business not found.",
    };
  }

  if (business.isActive === false) {
    return {
      mode: "ineligible",
      canRunMonthly: false,
      canTriggerTrialRun: false,
      nextMonthlyRunAt: null,
      trialRun: business.aiVisibilityTrialRun,
      reason: "inactive_business",
      message: "This business is not active.",
    };
  }

  if (hasPaidAiVisibilityAccess(business)) {
    return {
      mode: "paid",
      canRunMonthly: true,
      canTriggerTrialRun: false,
      nextMonthlyRunAt,
      trialRun: business.aiVisibilityTrialRun,
      message: "AI Visibility runs automatically on the 1st of every month.",
    };
  }

  if (hasTrialAiVisibilityAccess(business, now)) {
    if (business.aiVisibilityTrialRun) {
      return {
        mode: "trial_used",
        canRunMonthly: false,
        canTriggerTrialRun: false,
        nextMonthlyRunAt: null,
        trialRun: business.aiVisibilityTrialRun,
        message: "The one-time trial AI Visibility run has already been used.",
      };
    }

    return {
      mode: "trial_unused",
      canRunMonthly: false,
      canTriggerTrialRun: true,
      nextMonthlyRunAt: null,
      trialRun: null,
      message: "Trial businesses can run AI Visibility once during the trial.",
    };
  }

  return {
    mode: "ineligible",
    canRunMonthly: false,
    canTriggerTrialRun: false,
    nextMonthlyRunAt: null,
    trialRun: business.aiVisibilityTrialRun,
    reason: "subscription_required",
    message: "AI Visibility requires an active paid subscription or unused active trial run.",
  };
}

export async function listMonthlyPaidAiVisibilityBusinesses() {
  return prisma.business.findMany({
    where: {
      isActive: true,
      websiteSubscription: {
        is: {
          status: "active",
          trialStatus: { notIn: ["trialing", "expired"] },
        },
      },
      User: {
        role: { notIn: ["ADMIN", "SUPERADMIN"] },
      },
    },
    select: {
      id: true,
      businessName: true,
    },
  });
}

export async function createTrialAiVisibilityRun(input: {
  businessId: string;
  requestedByUserId?: string | null;
}) {
  const status = await getAiVisibilityRunPolicyStatus(input.businessId);

  if (status.mode === "trial_used") {
    throw new AiVisibilityTrialRunError(
      "already_used",
      "The one-time trial AI Visibility run has already been used.",
    );
  }
  if (status.mode !== "trial_unused") {
    throw new AiVisibilityTrialRunError(
      status.reason === "business_not_found"
        ? "business_not_found"
        : status.reason === "inactive_business"
          ? "inactive_business"
          : "not_trial",
      "Trial AI Visibility can only be started by an active trial business that has not used its trial run.",
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const createJob = async (type: AiVisibilityJobType) =>
        tx.aiVisibilityJob.create({
          data: {
            businessId: input.businessId,
            type,
            source: "trial_once",
            periodKey: AI_VISIBILITY_TRIAL_PERIOD_KEY,
            requestedByUserId: input.requestedByUserId ?? null,
            status: "pending",
            progress: 0,
          },
        });

      const citationJob = await createJob("citation_scan");
      const discoveryJob = await createJob("query_discovery");

      const trialRun = await tx.aiVisibilityTrialRun.create({
        data: {
          businessId: input.businessId,
          requestedByUserId: input.requestedByUserId ?? null,
          status: "queued",
          citationJobId: citationJob.id,
          discoveryJobId: discoveryJob.id,
        },
      });

      return { trialRun, citationJob, discoveryJob };
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      throw new AiVisibilityTrialRunError(
        "already_used",
        "The one-time trial AI Visibility run has already been used.",
      );
    }
    throw error;
  }
}
