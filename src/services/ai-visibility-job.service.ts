import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";

export const AI_VISIBILITY_JOB_TYPES = [
  "citation_scan",
  "content_scoring",
  "query_discovery",
] as const;

export type AiVisibilityJobType = (typeof AI_VISIBILITY_JOB_TYPES)[number];
export type AiVisibilityJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type AiVisibilityJobSource =
  | "manual"
  | "monthly_paid"
  | "trial_once"
  | "manual_admin";

const ACTIVE_AI_VISIBILITY_JOB_STATUSES: AiVisibilityJobStatus[] = [
  "pending",
  "running",
];

const TERMINAL_PROGRESS = 100;

function asJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

export function isActiveAiVisibilityJobStatus(status: string): boolean {
  return ACTIVE_AI_VISIBILITY_JOB_STATUSES.includes(
    status as AiVisibilityJobStatus,
  );
}

export async function createOrReuseAiVisibilityJob(input: {
  businessId: string;
  type: AiVisibilityJobType;
  requestedByUserId?: string | null;
  source?: AiVisibilityJobSource;
  periodKey?: string | null;
}) {
  const source = input.source ?? "manual";
  const periodKey = input.periodKey ?? null;

  if (periodKey) {
    const existingJob = await prisma.aiVisibilityJob.findUnique({
      where: {
        businessId_type_periodKey: {
          businessId: input.businessId,
          type: input.type,
          periodKey,
        },
      },
    });

    if (existingJob) {
      return { job: existingJob, reused: true };
    }

    try {
      const job = await prisma.aiVisibilityJob.create({
        data: {
          businessId: input.businessId,
          type: input.type,
          source,
          periodKey,
          requestedByUserId: input.requestedByUserId ?? null,
          status: "pending",
          progress: 0,
        },
      });

      return { job, reused: false };
    } catch (error: any) {
      if (error?.code === "P2002") {
        const racedJob = await prisma.aiVisibilityJob.findUnique({
          where: {
            businessId_type_periodKey: {
              businessId: input.businessId,
              type: input.type,
              periodKey,
            },
          },
        });
        if (racedJob) {
          return { job: racedJob, reused: true };
        }
      }
      throw error;
    }
  }

  const activeJob = await prisma.aiVisibilityJob.findFirst({
    where: {
      businessId: input.businessId,
      type: input.type,
      status: { in: ACTIVE_AI_VISIBILITY_JOB_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeJob) {
    return { job: activeJob, reused: true };
  }

  const job = await prisma.aiVisibilityJob.create({
    data: {
      businessId: input.businessId,
      type: input.type,
      source,
      periodKey,
      requestedByUserId: input.requestedByUserId ?? null,
      status: "pending",
      progress: 0,
    },
  });

  return { job, reused: false };
}

export async function getLatestAiVisibilityJobs(businessId: string) {
  const entries = await Promise.all(
    AI_VISIBILITY_JOB_TYPES.map(async (type) => {
      const job = await prisma.aiVisibilityJob.findFirst({
        where: { businessId, type },
        orderBy: { createdAt: "desc" },
      });
      return [type, job] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<
    AiVisibilityJobType,
    Awaited<ReturnType<typeof prisma.aiVisibilityJob.findFirst>>
  >;
}

export async function markAiVisibilityJobRunning(jobId?: string | null) {
  if (!jobId) return null;

  return prisma.aiVisibilityJob.update({
    where: { id: jobId },
    data: {
      status: "running",
      progress: 10,
      startedAt: new Date(),
      completedAt: null,
      lastError: null,
    },
  });
}

export async function markAiVisibilityJobFinished(input: {
  jobId?: string | null;
  status: Exclude<AiVisibilityJobStatus, "pending" | "running">;
  result?: unknown;
  lastError?: string | null;
}) {
  if (!input.jobId) return null;

  return prisma.aiVisibilityJob.update({
    where: { id: input.jobId },
    data: {
      status: input.status,
      progress: TERMINAL_PROGRESS,
      completedAt: new Date(),
      lastError: input.lastError ?? null,
      result: asJsonInput(input.result),
    },
  });
}
