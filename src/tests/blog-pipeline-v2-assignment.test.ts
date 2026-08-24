import { describe, expect, test } from "bun:test";

import {
  BLOG_PIPELINE_V2_VERSION,
  LEGACY_BLOG_PIPELINE_VERSION,
} from "../services/blog-pipeline-v2/constants";
import {
  buildPinnedBlogGenerateEventData,
  resolvePinnedBlogPipelineVersion,
  selectBlogPipelineVersion,
} from "../services/blog-pipeline-v2/pipeline-assignment";

describe("production blog pipeline assignment", () => {
  test("uses the optimized pipeline without rollout environment flags", () => {
    expect(selectBlogPipelineVersion("plan-1")).toBe(
      BLOG_PIPELINE_V2_VERSION,
    );
    expect(
      buildPinnedBlogGenerateEventData("plan-1", { keywordId: "plan-1" })
        .pipelineVersion,
    ).toBe(BLOG_PIPELINE_V2_VERSION);
  });

  test("exposes no environment-based assignment input", () => {
    expect(selectBlogPipelineVersion.length).toBe(1);
    expect(buildPinnedBlogGenerateEventData.length).toBe(2);
  });

  test("upgrades unversioned and legacy-pinned retries to v2", () => {
    expect(
      resolvePinnedBlogPipelineVersion({ planId: "plan-5" }),
    ).toBe(BLOG_PIPELINE_V2_VERSION);
    expect(
      resolvePinnedBlogPipelineVersion({
        planId: "plan-5",
        pinnedVersion: LEGACY_BLOG_PIPELINE_VERSION,
      }),
    ).toBe(BLOG_PIPELINE_V2_VERSION);
    expect(
      resolvePinnedBlogPipelineVersion({
        planId: "plan-5",
        pinnedVersion: BLOG_PIPELINE_V2_VERSION,
      }),
    ).toBe(BLOG_PIPELINE_V2_VERSION);
    expect(() =>
      resolvePinnedBlogPipelineVersion({
        planId: "plan-5",
        pinnedVersion: "future-unapproved-version",
      }),
    ).toThrow("Unsupported pinned blog pipeline version");
  });
});
