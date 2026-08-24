export const BLOG_PIPELINE_V2_VERSION = "staged-v3-production-v1" as const;
export const LEGACY_BLOG_PIPELINE_VERSION = "legacy" as const;

export type BlogPipelineVersion =
  | typeof BLOG_PIPELINE_V2_VERSION
  | typeof LEGACY_BLOG_PIPELINE_VERSION;

export const BLOG_PIPELINE_V2_TEXT_MODEL = "gpt-5.6-luna" as const;
export const BLOG_PIPELINE_V2_IMAGE_MODEL = "gpt-image-2" as const;
export const BLOG_PIPELINE_V2_IMAGE_QUALITY = "medium" as const;
export const BLOG_PIPELINE_V2_IMAGE_SIZE = "1536x1024" as const;
export const BLOG_PIPELINE_V2_IMAGE_COUNT = 3 as const;

export const BLOG_PIPELINE_V2_TITLE_MIN_CHARS = 50 as const;
export const BLOG_PIPELINE_V2_TITLE_MAX_CHARS = 60 as const;
export const BLOG_PIPELINE_V2_META_DESCRIPTION_MIN_CHARS = 140 as const;
export const BLOG_PIPELINE_V2_META_DESCRIPTION_MAX_CHARS = 155 as const;
export const BLOG_PIPELINE_V2_INTERNAL_LINK_TARGET_MIN = 3 as const;
export const BLOG_PIPELINE_V2_INTERNAL_LINK_TARGET_MAX = 5 as const;

// Long-form bounds proven by the focused research -> angle -> outline ->
// article -> packaging workflow. The target leaves room for practical depth
// without rewarding filler up to the hard publication ceiling.
export const BLOG_PIPELINE_V2_MIN_WORDS = 1_800 as const;
export const BLOG_PIPELINE_V2_TARGET_MIN_WORDS = 1_900 as const;
export const BLOG_PIPELINE_V2_TARGET_MAX_WORDS = 2_300 as const;
export const BLOG_PIPELINE_V2_MAX_WORDS = 2_500 as const;

export const BLOG_PIPELINE_V2_PROMPT_VERSION =
  "agent-testing-editorial-v6-natural-keyword-intent" as const;
export const BLOG_PIPELINE_V2_COMPATIBLE_PROMPT_VERSIONS = [
  BLOG_PIPELINE_V2_PROMPT_VERSION,
  "agent-testing-editorial-v5-natural-title-evidence-bounds",
  "agent-testing-editorial-v4-seo-checklist",
  "agent-testing-editorial-v3-search-quality",
  "agent-testing-editorial-v2",
] as const;
export const BLOG_PIPELINE_V2_COMPILER_VERSION = 2 as const;

export const BLOG_PIPELINE_V2_INTERNAL_TERMS = [
  /\bAGENT_TESTING_PROMPT_MODE\b/i,
  /\bagent[- ]testing(?: prompt mode)?\b/i,
  /\bstaged[- ]v3(?: production)?\b/i,
  /\brecovery (?:pipeline|mode|package|worker)\b/i,
  /\b(?:exact|supplied|target) recovery keyword\b/i,
  /\brecovery article\b/i,
  /\bfive[- ]stage (?:writer|pipeline)\b/i,
  /\b(?:system|developer) prompt\b/i,
] as const;
