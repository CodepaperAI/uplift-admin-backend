import type {
  SocialCreativePreferredImageSize,
  SocialPackKind,
} from "./types";

export const SOCIAL_CREATIVE_PIPELINE_VERSION =
  "website-campaign-brand-reference-v4-style-references" as const;
export const SOCIAL_CREATIVE_PROMPT_VERSION =
  "website-campaign-v5-creative-style-references" as const;
export const SOCIAL_CREATIVE_COPY_MODEL = "gpt-5.6-luna" as const;
export const SOCIAL_CREATIVE_COPY_VERSION =
  "social-platform-copy-v7-agent-testing-editorial" as const;
export const SOCIAL_CREATIVE_TEXT_MODEL = SOCIAL_CREATIVE_COPY_MODEL;
export const SOCIAL_CREATIVE_IMAGE_MODEL =
  "gpt-image-2-2026-04-21" as const;
export const SOCIAL_CREATIVE_IMAGE_QUALITY = "provider-default" as const;
export const SOCIAL_CREATIVE_IMAGE_PRICING_VERSION = "openai-2026-08-08" as const;
export const SOCIAL_CREATIVE_SINGLE_SLIDES = 1 as const;
export const SOCIAL_CREATIVE_CAROUSEL_MIN_SLIDES = 4 as const;
export const SOCIAL_CREATIVE_CAROUSEL_MAX_SLIDES = 6 as const;
export const SOCIAL_CREATIVE_MAX_IMAGE_REFERENCES = 7 as const;

function positiveNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function socialCreativeSlideCount(kind: SocialPackKind): number {
  return kind === "carousel"
    ? SOCIAL_CREATIVE_CAROUSEL_MAX_SLIDES
    : SOCIAL_CREATIVE_SINGLE_SLIDES;
}

export function socialCreativeImageCostUsd(
  sourceSize: SocialCreativePreferredImageSize,
): number {
  const sizeSpecificName = `SOCIAL_CREATIVE_IMAGE_${sourceSize.toUpperCase()}_DEFAULT_USD`;
  return positiveNumber(
    sizeSpecificName,
    positiveNumber("SOCIAL_CREATIVE_IMAGE_DEFAULT_USD", 0.041),
  );
}

export function socialCreativeImageUsageCostUsd(input: {
  inputTextTokens: number;
  inputImageTokens: number;
  outputImageTokens: number;
}): number {
  const textInputPerMillion = positiveNumber(
    "SOCIAL_CREATIVE_IMAGE_TEXT_INPUT_PER_MILLION_USD",
    5,
  );
  const imageInputPerMillion = positiveNumber(
    "SOCIAL_CREATIVE_IMAGE_INPUT_PER_MILLION_USD",
    8,
  );
  const imageOutputPerMillion = positiveNumber(
    "SOCIAL_CREATIVE_IMAGE_OUTPUT_PER_MILLION_USD",
    30,
  );
  return (
    (Math.max(0, input.inputTextTokens) * textInputPerMillion +
      Math.max(0, input.inputImageTokens) * imageInputPerMillion +
      Math.max(0, input.outputImageTokens) * imageOutputPerMillion) /
    1_000_000
  );
}

export function socialCreativeRunBudgetUsd(): number {
  return positiveNumber("SOCIAL_CREATIVE_MAX_RUN_USD", 1.25);
}

export function socialCreativeDailyBudgetUsd(): number {
  return positiveNumber("SOCIAL_CREATIVE_MAX_DAILY_USD", 50);
}

export function socialCreativeImageTimeoutMs(): number {
  return positiveNumber("SOCIAL_CREATIVE_IMAGE_TIMEOUT_MS", 180_000);
}

export function isSocialCreativeGenerationEnabled(): boolean {
  return process.env.SOCIAL_CREATIVE_GENERATION_ENABLED !== "false";
}

export function isSocialCreativeAutoPublishEnabled(): boolean {
  return process.env.SOCIAL_CREATIVE_AUTO_PUBLISH_ENABLED === "true";
}
