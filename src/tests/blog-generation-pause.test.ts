import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Response } from "express";
import {
  AUTO_PUBLISH_BLOG_TASK_FLAG,
  BLOG_GENERATION_WORKER_FLAG,
  autoPublishBlogTask,
  dailyBlogScheduler,
  generateBlogTask,
  getAutoPublishBlogTaskState,
  getBlogGenerationWorkerState,
  manualDailyBlogTrigger,
} from "../inngest/client";
import {
  generateBlogFromPlannedKeywords,
  regenerateMissedBlogs,
  triggerDailyBlogGeneration,
} from "../controllers/blog.controller";

const ENV_KEYS = [
  AUTO_PUBLISH_BLOG_TASK_FLAG,
  BLOG_GENERATION_WORKER_FLAG,
  "APP_ENV",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "NODE_ENV",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createResponseRecorder() {
  let statusCode = 0;
  let body: any;

  const response = {
    status: mock((code: number) => {
      statusCode = code;
      return response;
    }),
    json: mock((value: unknown) => {
      body = value;
      return response;
    }),
  } as unknown as Response;

  return {
    response,
    read: () => ({ statusCode, body }),
  };
}

beforeEach(() => {
  delete process.env[AUTO_PUBLISH_BLOG_TASK_FLAG];
  delete process.env[BLOG_GENERATION_WORKER_FLAG];
  delete process.env.DEPLOY_ENV;
  delete process.env.ENVIRONMENT;
  process.env.APP_ENV = "production";
  process.env.NODE_ENV = "test";
});

describe("AUTO_PUBLISH_BLOG_TASK_ENABLED semantics", () => {
  test("explicit false pauses a queued event before any step or database work", async () => {
    process.env[AUTO_PUBLISH_BLOG_TASK_FLAG] = "false";
    const stepRun = mock(async () => {
      throw new Error("paused publishing worker must not enter a step");
    });

    const result = await (autoPublishBlogTask as any).fn({
      event: { data: { blogId: "blog-1" } },
      step: { run: stepRun },
    });

    expect(stepRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      skipped: true,
      paused: true,
      status: "paused",
      reason: "auto_publish_blog_task_disabled",
      blogId: "blog-1",
    });
    expect(result.automationState).toMatchObject({
      flagName: AUTO_PUBLISH_BLOG_TASK_FLAG,
      flagValue: false,
      enabled: false,
      enabledBy: "explicit_flag",
    });
  });

  test("explicit true enables the queued publishing worker gate", () => {
    process.env[AUTO_PUBLISH_BLOG_TASK_FLAG] = "true";
    expect(getAutoPublishBlogTaskState()).toMatchObject({
      flagName: AUTO_PUBLISH_BLOG_TASK_FLAG,
      flagValue: true,
      enabled: true,
      enabledBy: "explicit_flag",
    });
  });
});

afterEach(() => {
  restoreEnvironment();
});

describe("BLOG_GENERATION_WORKER_ENABLED semantics", () => {
  test("explicit true enables generation", () => {
    process.env[BLOG_GENERATION_WORKER_FLAG] = "true";

    const state = getBlogGenerationWorkerState();

    expect(state.enabled).toBe(true);
    expect(state.flagValue).toBe(true);
    expect(state.enabledBy).toBe("explicit_flag");
  });

  test("explicit false pauses generation", () => {
    process.env[BLOG_GENERATION_WORKER_FLAG] = "false";

    const state = getBlogGenerationWorkerState();

    expect(state.enabled).toBe(false);
    expect(state.flagValue).toBe(false);
    expect(state.enabledBy).toBe("explicit_flag");
  });

  test("unset defaults enabled in production", () => {
    delete process.env[BLOG_GENERATION_WORKER_FLAG];

    const state = getBlogGenerationWorkerState();

    expect(state.enabled).toBe(true);
    expect(state.flagValue).toBeNull();
    expect(state.enabledBy).toBe("default_enabled");
  });

  test("unset remains enabled outside production to preserve manual generation", () => {
    delete process.env[BLOG_GENERATION_WORKER_FLAG];
    process.env.APP_ENV = "development";

    const state = getBlogGenerationWorkerState();
    expect(state.enabled).toBe(true);
    expect(state.enabledBy).toBe("default_enabled");
  });
});

describe("blog generation pause behavior", () => {
  test("the worker returns a normal paused result before running any step", async () => {
    process.env[BLOG_GENERATION_WORKER_FLAG] = "false";
    const stepRun = mock(async () => {
      throw new Error("worker must not reach subscription, database, or LLM work");
    });

    const result = await (generateBlogTask as any).fn({
      event: {
        data: {
          userId: "user-1",
          keywordId: "keyword-1",
          businessId: "business-1",
        },
      },
      step: { run: stepRun },
    });

    expect(stepRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      skipped: true,
      paused: true,
      status: "paused",
      reason: "blog_generation_worker_disabled",
      keywordId: "keyword-1",
      businessId: "business-1",
    });
  });

  test("daily and manual schedulers stop before candidate database work", async () => {
    process.env[BLOG_GENERATION_WORKER_FLAG] = "false";

    for (const inngestFunction of [
      dailyBlogScheduler,
      manualDailyBlogTrigger,
    ]) {
      const stepRun = mock(async (_name: string, callback: () => unknown) =>
        callback(),
      );
      const result = await (inngestFunction as any).fn({
        event: { data: { userId: "user-1", businessId: "business-1" } },
        step: { run: stepRun },
      });

      expect(stepRun).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        success: true,
        skipped: true,
        paused: true,
        status: "paused",
        reason: "blog_generation_worker_disabled",
      });
    }
  });

  test("manual, daily, and missed-blog APIs report paused without processing", async () => {
    process.env[BLOG_GENERATION_WORKER_FLAG] = "false";

    const cases = [
      {
        handler: generateBlogFromPlannedKeywords,
        body: { keywordId: "keyword-1", businessId: "business-1" },
      },
      {
        handler: triggerDailyBlogGeneration,
        body: { userId: "user-1", businessId: "business-1" },
      },
      {
        handler: regenerateMissedBlogs,
        body: { businessId: "business-1" },
      },
    ];

    for (const { handler, body } of cases) {
      const recorder = createResponseRecorder();
      await handler(
        { authUserId: "user-1", body } as any,
        recorder.response,
      );

      const result = recorder.read();
      expect(result.statusCode).toBe(200);
      expect(result.body.message).toBe("Blog generation paused");
      const expected: Record<string, unknown> = {
        success: true,
        skipped: true,
        paused: true,
        status: "paused",
        reason: "blog_generation_worker_disabled",
      };
      expected.businessId = "business-1";
      expect(result.body.data).toMatchObject(expected);
      expect(JSON.stringify(result.body)).not.toContain("processing");
    }
  });
});
