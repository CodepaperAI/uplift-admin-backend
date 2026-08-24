import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { createSocialCreativeInngestFunctions } from "../inngest/social-creative";
import { finalizeSocialCreativeRun } from "../services/social-creative/repository";

describe("text-only social creative finalization", () => {
  it("completes a planned run with no image assets", async () => {
    const updates: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUniqueOrThrow: async () => ({
          id: "run-text-only",
          contentPlan: { platformCopy: { x: { caption: "Text", hashtags: [] } } },
          posts: [{ assets: [] }],
        }),
        update: async (input: any) => {
          updates.push(input);
          return input;
        },
      },
    } as unknown as PrismaClient;

    const result = await finalizeSocialCreativeRun("run-text-only", prisma);

    expect(result).toMatchObject({
      runId: "run-text-only",
      total: 0,
      complete: 0,
      failed: 0,
      active: 0,
      status: "COMPLETE",
      actualCostUsd: 0,
    });
    expect(updates[0]).toMatchObject({
      where: { id: "run-text-only" },
      data: { status: "COMPLETE", actualCostUsd: 0 },
    });
  });

  it("always dispatches finalization after planning an asset-free run", async () => {
    const registered: Array<{
      config: any;
      handler: (context: any) => Promise<any>;
    }> = [];
    const inngest = {
      createFunction: (config: any, handler: (context: any) => Promise<any>) => {
        const fn = { config, handler };
        registered.push(fn);
        return fn;
      },
    } as any;
    createSocialCreativeInngestFunctions(inngest, {
      generationEnabled: () => true,
      plan: async () => ({
        runId: "run-text-only",
        assetIds: [],
        planned: true,
      }),
    });
    const task = registered.find(
      (candidate) => candidate.config.id === "social-creative-plan-and-dispatch",
    )!;
    const events: Array<{ id: string; payload: unknown }> = [];

    const result = await task.handler({
      event: { data: { runId: "run-text-only", businessId: "business-1" } },
      step: {
        run: async (_id: string, fn: () => unknown) => fn(),
        sendEvent: async (id: string, payload: unknown) => {
          events.push({ id, payload });
        },
      },
    });

    expect(result).toEqual({
      runId: "run-text-only",
      dispatched: 0,
      planned: true,
    });
    expect(events).toContainEqual({
      id: "request-social-creative-finalization",
      payload: {
        name: "social/creative.finalize",
        data: { runId: "run-text-only" },
      },
    });
  });
});
