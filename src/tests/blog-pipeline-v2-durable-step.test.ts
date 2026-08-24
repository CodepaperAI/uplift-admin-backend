import { describe, expect, test } from "bun:test";

import { runProductionDurableStep } from "../services/blog-pipeline-v2/durable-step";

describe("production-v2 durable step adapter", () => {
  test("keeps local canaries on the identical handler path", async () => {
    let calls = 0;
    const result = await runProductionDurableStep(
      undefined,
      "production-v2-topic-research",
      async () => {
        calls += 1;
        return { value: "same-pipeline" };
      },
    );

    expect(result).toEqual({ value: "same-pipeline" });
    expect(calls).toBe(1);
  });

  test("allows the durable runtime to replay a cached receipt without rebilling", async () => {
    const cache = new Map<string, unknown>();
    let providerCalls = 0;
    const runner = async <T>(id: string, handler: () => Promise<T>): Promise<T> => {
      if (cache.has(id)) return cache.get(id) as T;
      const value = await handler();
      cache.set(id, value);
      return value;
    };
    const provider = async () => {
      providerCalls += 1;
      return { responseId: "provider-receipt-1" };
    };

    const first = await runProductionDurableStep(
      runner,
      "production-v2-editorial-article",
      provider,
    );
    const replay = await runProductionDurableStep(
      runner,
      "production-v2-editorial-article",
      provider,
    );

    expect(first).toEqual(replay);
    expect(providerCalls).toBe(1);
  });
});
