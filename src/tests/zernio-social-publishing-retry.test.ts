import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  createZernioSocialPublishingFunctions,
  shouldKeepSocialPublishAttemptPending,
} from "../inngest/zernio-social-publishing";
import { ZernioApiError } from "../services/zernio/zernio.client";

describe("Zernio social publishing retry state", () => {
  test("keeps retryable provider timeouts active until the final Inngest attempt", () => {
    const timeout = new ZernioApiError(
      "Zernio request timed out",
      504,
      "ZERNIO_TIMEOUT",
      true,
    );

    expect(shouldKeepSocialPublishAttemptPending(timeout, 0)).toBe(true);
    expect(shouldKeepSocialPublishAttemptPending(timeout, 4)).toBe(true);
    expect(shouldKeepSocialPublishAttemptPending(timeout, 5)).toBe(false);
  });

  test("does not keep terminal provider errors active", () => {
    const rejected = new ZernioApiError(
      "Publishing rejected",
      400,
      "ZERNIO_REJECTED",
      false,
    );

    expect(shouldKeepSocialPublishAttemptPending(rejected, 0)).toBe(false);
  });
});

describe("ready social content auto-publish recovery", () => {
  test("dispatches pending attempts when a connected account becomes available", async () => {
    const registered: Array<{ config: any; handler: (context: any) => Promise<any> }> = [];
    const inngest = {
      createFunction: (config: any, handler: (context: any) => Promise<any>) => {
        const fn = { config, handler };
        registered.push(fn);
        return fn;
      },
    } as any;
    const prisma = {
      socialCreativeRun: {
        findMany: async () => [{ id: "run-1" }],
      },
    } as unknown as PrismaClient;
    createZernioSocialPublishingFunctions(inngest, {
      prisma,
      autoPublishEnabled: () => true,
      prepareAutoPublish: async () => ({
        runId: "run-1",
        businessId: "business-1",
        status: "prepared" as const,
        mode: "SCHEDULE" as const,
        platforms: ["instagram"],
        attemptIds: ["attempt-1"],
      }),
    });
    const task = registered.find(
      (candidate) => candidate.config.id === "zernio-social-auto-publish-ready-scan",
    )!;
    const sent: unknown[] = [];
    const result = await task.handler({
      event: { data: { businessId: "business-1" } },
      step: {
        run: async (_id: string, fn: () => unknown) => fn(),
        sendEvent: async (_id: string, payload: unknown) => {
          sent.push(payload);
        },
      },
    });

    expect(result).toEqual({ scanned: 1, prepared: 1, dispatched: 1 });
    expect(sent).toEqual([
      [
        {
          id: "social-auto-publish:attempt-1",
          name: "social/publish.requested",
          data: {
            attemptId: "attempt-1",
            businessId: "business-1",
            runId: "run-1",
          },
        },
      ],
    ]);
  });

  test("does not scan or dispatch provider posts when auto publish is disabled", async () => {
    const registered: Array<{ config: any; handler: (context: any) => Promise<any> }> = [];
    const inngest = {
      createFunction: (config: any, handler: (context: any) => Promise<any>) => {
        const fn = { config, handler };
        registered.push(fn);
        return fn;
      },
    } as any;
    let databaseReads = 0;
    let prepareCalls = 0;
    const prisma = {
      socialCreativeRun: {
        findMany: async () => {
          databaseReads += 1;
          return [{ id: "run-1" }];
        },
      },
    } as unknown as PrismaClient;
    createZernioSocialPublishingFunctions(inngest, {
      prisma,
      autoPublishEnabled: () => false,
      prepareAutoPublish: async () => {
        prepareCalls += 1;
        throw new Error("automatic publishing must remain disabled");
      },
    });
    const task = registered.find(
      (candidate) => candidate.config.id === "zernio-social-auto-publish-ready-scan",
    )!;
    const sent: unknown[] = [];
    const result = await task.handler({
      event: { data: {} },
      step: {
        run: async (_id: string, fn: () => unknown) => fn(),
        sendEvent: async (_id: string, payload: unknown) => sent.push(payload),
      },
    });

    expect(result).toEqual({
      scanned: 0,
      prepared: 0,
      dispatched: 0,
      skipped: true,
      reason: "auto_publish_disabled",
    });
    expect(databaseReads).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
