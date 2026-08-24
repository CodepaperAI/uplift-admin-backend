import { describe, expect, test } from "bun:test";

import { ProductionPipelineUsageRecorder } from "../services/blog-pipeline-v2/usage-accounting";
import { BLOG_PIPELINE_V2_TEXT_MODEL } from "../services/blog-pipeline-v2/constants";

function fakePrisma() {
  const rows: any[] = [];
  return {
    rows,
    llmUsageEvent: {
      findFirst: async ({ where }: any) =>
        rows.find(
          (row) =>
            row.correlationId === where.correlationId &&
            (!where.provider || row.provider === where.provider) &&
            (!where.model || row.model === where.model),
        ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `usage-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows) {
          if (
            row.businessId === where.businessId &&
            row.correlationId.startsWith(where.correlationId.startsWith) &&
            row.blogId === null
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      findMany: async ({ where }: any) =>
        rows.filter(
          (row) =>
            row.businessId === where.businessId &&
            row.correlationId.startsWith(where.correlationId.startsWith),
        ),
    },
  };
}

describe("production provider usage accounting", () => {
  test("records each of the five editorial stages with stable idempotency keys", async () => {
    const prisma = fakePrisma();
    const observedKeys: string[] = [];
    const recorder = new ProductionPipelineUsageRecorder(
      {
        correlationId: "run-five-stage",
        planId: "plan-five-stage",
        userId: "user-1",
        businessId: "business-1",
      },
      prisma as any,
    );
    const client = recorder.trackingResponsesClient({
      responses: {
        create: async (request: any, options: any) => {
          observedKeys.push(options.idempotencyKey);
          const name = request.text.format.name;
          return {
            id: `response-${name}`,
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            output: [],
          };
        },
      },
    } as any);
    for (const name of [
      "agent_testing_recovery_research",
      "agent_testing_recovery_angle",
      "agent_testing_recovery_outline",
      "agent_testing_recovery_article",
      "agent_testing_recovery_seo_package",
    ]) {
      await client.responses.create({
        model: BLOG_PIPELINE_V2_TEXT_MODEL,
        tools: [],
        text: { format: { name } },
      });
    }
    expect(prisma.rows.map((row) => row.metadata.stage)).toEqual([
      "research",
      "angle",
      "outline",
      "article",
      "seo_package",
    ]);
    expect(new Set(observedKeys).size).toBe(5);
    expect(observedKeys.every((key) => key.startsWith("run-five-stage:"))).toBe(true);
  });

  test("records and deduplicates response receipts, web search, image and embedding costs", async () => {
    const prisma = fakePrisma();
    const recorder = new ProductionPipelineUsageRecorder(
      {
        correlationId: "run-1",
        planId: "plan-1",
        userId: "user-1",
        businessId: "business-1",
      },
      prisma as any,
    );
    const response = {
      id: "resp-search",
      usage: {
        input_tokens: 1_000,
        output_tokens: 500,
        total_tokens: 1_500,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens_details: { reasoning_tokens: 100 },
      },
      output: [{ type: "web_search_call" }],
    };
    await recorder.recordResponse({
      stage: "topic_research",
      model: BLOG_PIPELINE_V2_TEXT_MODEL,
      response,
      attempt: 1,
    });
    await recorder.recordResponse({
      stage: "topic_research",
      model: BLOG_PIPELINE_V2_TEXT_MODEL,
      response,
      attempt: 2,
    });
    await recorder.recordFixedCost({
      stage: "featured_image",
      provider: "openai",
      model: "gpt-image-2",
      responseId: "image-1",
      estimatedUsd: 0.0412,
      metadata: { kind: "image" },
    });
    await recorder.recordFixedCost({
      stage: "embedding",
      provider: "openai",
      model: "text-embedding-3-small",
      responseId: "embedding-1",
      estimatedUsd: 0.00002,
      metadata: { kind: "embedding" },
    });
    expect(prisma.rows).toHaveLength(3);
    const summary = await recorder.summary();
    expect(summary.inputTokens).toBe(1_000);
    expect(summary.outputTokens).toBe(500);
    expect(summary.webSearchUsd).toBeCloseTo(0.01, 6);
    expect(summary.textUsd).toBeCloseTo(0.000764, 9);
    expect(summary.imageUsd).toBeCloseTo(0.0412, 6);
    expect(summary.embeddingUsd).toBeCloseTo(0.00002, 6);
    expect(summary.totalUsd).toBeCloseTo(0.051984, 9);
    await recorder.attachBlog("blog-1");
    expect(prisma.rows.every((row) => row.blogId === "blog-1")).toBe(true);
  });

  test("classifies a legacy recovery length repair separately", async () => {
    const prisma = fakePrisma();
    const recorder = new ProductionPipelineUsageRecorder(
      {
        correlationId: "run-length-repair",
        planId: "plan-length-repair",
        userId: "user-1",
        businessId: "business-1",
      },
      prisma as any,
    );
    const client = recorder.trackingResponsesClient({
      responses: {
        create: async () => ({
          id: "response-length-repair",
          usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
          output: [],
        }),
      },
    } as any);
    await client.responses.create({
      model: BLOG_PIPELINE_V2_TEXT_MODEL,
      tools: [],
      text: { format: { name: "recovery_durable_length_repair" } },
    });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]?.metadata.stage).toBe("length_repair");
  });
});
