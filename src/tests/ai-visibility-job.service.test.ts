import { beforeEach, describe, expect, it, mock } from "bun:test";

type TestJob = {
  id: string;
  businessId: string;
  requestedByUserId: string | null;
  type: string;
  source: string;
  periodKey: string | null;
  status: string;
  progress: number;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
};

let jobs: TestJob[] = [];
let nextId = 1;

function matchesWhere(job: TestJob, where: any) {
  if (where.businessId && job.businessId !== where.businessId) return false;
  if (where.type && job.type !== where.type) return false;
  if (where.periodKey !== undefined && job.periodKey !== where.periodKey) {
    return false;
  }
  if (where.status?.in && !where.status.in.includes(job.status)) return false;
  return true;
}

mock.module("../config/db.config", () => ({
  prisma: {
    aiVisibilityJob: {
      findUnique: async ({ where }: any) => {
        const composite = where.businessId_type_periodKey;
        if (!composite) return null;
        return (
          jobs.find(
            (job) =>
              job.businessId === composite.businessId &&
              job.type === composite.type &&
              job.periodKey === composite.periodKey,
          ) ?? null
        );
      },
      findFirst: async ({ where }: any) => {
        return (
          jobs
            .filter((job) => matchesWhere(job, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
          null
        );
      },
      create: async ({ data }: any) => {
        const now = new Date(Date.now() + nextId);
        const job: TestJob = {
          id: `job-${nextId++}`,
          businessId: data.businessId,
          requestedByUserId: data.requestedByUserId ?? null,
          type: data.type,
          source: data.source ?? "manual",
          periodKey: data.periodKey ?? null,
          status: data.status ?? "pending",
          progress: data.progress ?? 0,
          startedAt: data.startedAt ?? null,
          completedAt: data.completedAt ?? null,
          lastError: data.lastError ?? null,
          result: data.result ?? null,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        return job;
      },
      update: async ({ where, data }: any) => {
        const job = jobs.find((entry) => entry.id === where.id);
        if (!job) throw new Error(`Job ${where.id} not found`);
        Object.assign(job, data, { updatedAt: new Date() });
        return job;
      },
    },
  },
}));

const {
  createOrReuseAiVisibilityJob,
  getLatestAiVisibilityJobs,
  markAiVisibilityJobFinished,
  markAiVisibilityJobRunning,
} = await import("../services/ai-visibility-job.service");

describe("ai visibility job service", () => {
  beforeEach(() => {
    jobs = [];
    nextId = 1;
  });

  it("creates a pending job and reuses active jobs for the same business/type", async () => {
    const first = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "citation_scan",
      requestedByUserId: "user-1",
    });
    const second = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "citation_scan",
      requestedByUserId: "user-1",
    });

    expect(first.reused).toBe(false);
    expect(first.job.status).toBe("pending");
    expect(first.job.source).toBe("manual");
    expect(first.job.periodKey).toBeNull();
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(jobs.length).toBe(1);
  });

  it("reuses same-period monthly jobs even after they are terminal", async () => {
    const first = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "citation_scan",
      source: "monthly_paid",
      periodKey: "2026-05",
    });

    await markAiVisibilityJobFinished({
      jobId: first.job.id,
      status: "completed",
    });

    const second = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "citation_scan",
      source: "monthly_paid",
      periodKey: "2026-05",
    });

    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.status).toBe("completed");
    expect(jobs.length).toBe(1);
  });

  it("creates a new monthly job for a new period", async () => {
    await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "query_discovery",
      source: "monthly_paid",
      periodKey: "2026-05",
    });
    const nextMonth = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "query_discovery",
      source: "monthly_paid",
      periodKey: "2026-06",
    });

    expect(nextMonth.reused).toBe(false);
    expect(jobs.length).toBe(2);
  });

  it("returns latest job per type for a business", async () => {
    await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "citation_scan",
    });
    await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "content_scoring",
    });

    const latest = await getLatestAiVisibilityJobs("biz-1");

    expect(latest.citation_scan?.type).toBe("citation_scan");
    expect(latest.content_scoring?.type).toBe("content_scoring");
    expect(latest.query_discovery).toBeNull();
  });

  it("marks jobs running and then terminal with result/error metadata", async () => {
    const { job } = await createOrReuseAiVisibilityJob({
      businessId: "biz-1",
      type: "query_discovery",
    });

    const running = await markAiVisibilityJobRunning(job.id);
    expect(running?.status).toBe("running");
    expect(running?.progress).toBe(10);

    const failed = await markAiVisibilityJobFinished({
      jobId: job.id,
      status: "failed",
      lastError: "boom",
      result: { processed: 0 },
    });

    expect(failed?.status).toBe("failed");
    expect(failed?.progress).toBe(100);
    expect(failed?.lastError).toBe("boom");
    expect(failed?.result).toEqual({ processed: 0 });
    expect(failed?.completedAt).toBeInstanceOf(Date);
  });
});
