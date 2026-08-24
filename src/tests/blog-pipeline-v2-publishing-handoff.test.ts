import { describe, expect, test } from "bun:test";

import {
  BLOG_PIPELINE_V2_VERSION,
  LEGACY_BLOG_PIPELINE_VERSION,
} from "../services/blog-pipeline-v2/constants";
import { getProductionPublishingHandoffDecision } from "../services/blog-pipeline-v2/publishing-handoff";

describe("production Inngest publishing handoff", () => {
  test("queues a due PUBLISH Blog through Inngest without invoking a CMS", () => {
    expect(
      getProductionPublishingHandoffDecision({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        blogId: "blog-1",
        blogStatus: "PUBLISH",
        isDue: true,
      }),
    ).toEqual({
      queued: true,
      event: { name: "publishing/auto-publish", data: { blogId: "blog-1" } },
    });
  });

  test("does not hand legacy or future-scheduled Blogs to the v2 path", () => {
    expect(
      getProductionPublishingHandoffDecision({
        pipelineVersion: LEGACY_BLOG_PIPELINE_VERSION,
        blogId: "blog-1",
        blogStatus: "PUBLISH",
        isDue: true,
      }),
    ).toMatchObject({ queued: false, reason: "legacy_pipeline" });
    expect(
      getProductionPublishingHandoffDecision({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        blogId: "blog-1",
        blogStatus: "PUBLISH",
        isDue: false,
      }),
    ).toMatchObject({ queued: false, reason: "not_due_yet" });
  });

  test("refuses to queue a DRAFT Blog", () => {
    expect(() =>
      getProductionPublishingHandoffDecision({
        pipelineVersion: BLOG_PIPELINE_V2_VERSION,
        blogId: "blog-1",
        blogStatus: "DRAFT",
        isDue: true,
      }),
    ).toThrow("not ready for publishing handoff");
  });
});
