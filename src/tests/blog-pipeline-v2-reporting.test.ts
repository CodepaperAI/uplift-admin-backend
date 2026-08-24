import { describe, expect, test } from "bun:test";

import {
  BLOG_PIPELINE_V2_PROMPT_VERSION,
  BLOG_PIPELINE_V2_VERSION,
} from "../services/blog-pipeline-v2/constants";
import { getProductionBlogPipelineCostReport } from "../services/blog-pipeline-v2/reporting";

describe("production pipeline cost reporting", () => {
  test("reports attempted, generated, imported and externally published unit costs", async () => {
    const runs = [
      {
        correlationId: `${BLOG_PIPELINE_V2_VERSION}:plan-1`,
        promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
        createdAt: new Date(),
        businessId: "business-1",
        blogId: "blog-1",
        status: "ACCEPTED",
        finalSaveStatus: "PUBLISH_HANDOFF_QUEUED",
        estimatedUsd: 0.2,
        repairCount: 0,
        metadata: {
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          planId: "plan-1",
          checkpoint: { draft: { title: "One" } },
          cost: {
            textUsd: 0.06,
            webSearchUsd: 0.01,
            imageUsd: 0.1236,
            embeddingUsd: 0.00002,
            totalUsd: 0.2,
          },
        },
      },
      {
        correlationId: `${BLOG_PIPELINE_V2_VERSION}:plan-2`,
        promptVersion: BLOG_PIPELINE_V2_PROMPT_VERSION,
        createdAt: new Date(),
        businessId: "business-2",
        blogId: null,
        status: "FAILED",
        finalSaveStatus: "FAILED",
        estimatedUsd: 0.08,
        repairCount: 1,
        metadata: {
          pipelineVersion: BLOG_PIPELINE_V2_VERSION,
          planId: "plan-2",
          checkpoint: { draft: { title: "Two" } },
          cost: {
            textUsd: 0.07,
            webSearchUsd: 0.01,
            imageUsd: 0,
            embeddingUsd: 0.00002,
            totalUsd: 0.08,
            failures: 1,
          },
        },
      },
    ];
    const prisma = {
      blogGenerationRun: { findMany: async () => runs },
      publishedBlog: {
        findMany: async () => [
          {
            blogId: "blog-1",
            status: "PUBLISHED",
            externalPostUrl: "https://example.com/blog/one",
          },
        ],
      },
    };
    const report = await getProductionBlogPipelineCostReport({
      planIds: ["plan-1", "plan-2"],
      prisma: prisma as any,
    });
    expect(report.counts).toEqual({
      attempted: 2,
      generated: 2,
      imported: 1,
      externallyPublished: 1,
    });
    expect(report.rows[0]?.finalSaveStatus).toBe("PUBLISH_HANDOFF_QUEUED");
    expect(report.totals.estimatedUsd).toBeCloseTo(0.28, 6);
    expect(report.averageUsd.attempted).toBeCloseTo(0.14, 6);
    expect(report.averageUsd.imported).toBeCloseTo(0.2, 6);
    expect(report.averageUsd.externallyPublished).toBeCloseTo(0.2, 6);
  });
});
