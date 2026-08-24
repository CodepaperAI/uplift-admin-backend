import {
  BLOG_PIPELINE_V2_VERSION,
  LEGACY_BLOG_PIPELINE_VERSION,
  type BlogPipelineVersion,
} from "./constants";

export function isBlogPipelineVersion(value: unknown): value is BlogPipelineVersion {
  return (
    value === BLOG_PIPELINE_V2_VERSION ||
    value === LEGACY_BLOG_PIPELINE_VERSION
  );
}

export function selectBlogPipelineVersion(
  _planId: string,
): typeof BLOG_PIPELINE_V2_VERSION {
  return BLOG_PIPELINE_V2_VERSION;
}

/**
 * Production has one supported writer. Unversioned events and events pinned to
 * the retired legacy writer are upgraded to v2 on retry. The v2 persistence
 * layer remains idempotent by Plan id and correlation id.
 */
export function resolvePinnedBlogPipelineVersion(input: {
  planId: string;
  pinnedVersion?: unknown;
}): BlogPipelineVersion {
  if (input.pinnedVersion === undefined || input.pinnedVersion === null) {
    return BLOG_PIPELINE_V2_VERSION;
  }
  if (!isBlogPipelineVersion(input.pinnedVersion)) {
    throw new Error(
      `Unsupported pinned blog pipeline version: ${String(input.pinnedVersion)}`,
    );
  }
  return input.pinnedVersion === LEGACY_BLOG_PIPELINE_VERSION
    ? BLOG_PIPELINE_V2_VERSION
    : input.pinnedVersion;
}

export function buildPinnedBlogGenerateEventData<T extends Record<string, unknown>>(
  _planId: string,
  data: T,
): T & { pipelineVersion: typeof BLOG_PIPELINE_V2_VERSION } {
  return {
    ...data,
    pipelineVersion: BLOG_PIPELINE_V2_VERSION,
  };
}
