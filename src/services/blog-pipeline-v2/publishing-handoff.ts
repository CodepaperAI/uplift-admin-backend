import {
  BLOG_PIPELINE_V2_VERSION,
  type BlogPipelineVersion,
} from "./constants";

export type ProductionPublishingHandoffDecision =
  | {
      queued: true;
      event: { name: "publishing/auto-publish"; data: { blogId: string } };
    }
  | {
      queued: false;
      reason: "legacy_pipeline" | "not_due_yet";
      event: null;
    };

/** Builds an Inngest event only; it never invokes an external publisher API. */
export function getProductionPublishingHandoffDecision(input: {
  pipelineVersion: BlogPipelineVersion;
  blogId: string;
  blogStatus: "DRAFT" | "PUBLISH";
  isDue: boolean;
}): ProductionPublishingHandoffDecision {
  if (input.pipelineVersion !== BLOG_PIPELINE_V2_VERSION) {
    return { queued: false, reason: "legacy_pipeline", event: null };
  }
  if (input.blogStatus !== "PUBLISH") {
    throw new Error("Production-v2 Blog is not ready for publishing handoff");
  }
  if (!input.isDue) {
    return { queued: false, reason: "not_due_yet", event: null };
  }
  return {
    queued: true,
    event: {
      name: "publishing/auto-publish",
      data: { blogId: input.blogId },
    },
  };
}
