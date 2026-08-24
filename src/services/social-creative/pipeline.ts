import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  type SocialImageUploadReceipt,
  uploadSocialImageBufferWithMetadata,
} from "../../lib/social-image-storage";
import { checkSiteFeatureAccess } from "../website-plan-entitlement.service";
import { resolveSocialPromotionForInstant } from "../social-promotion.service";
import { resolveSocialTopicImagePlatforms } from "../../utils/social-platform-schedule.utils";
import { loadSocialCreativeBrandContext } from "./brand-context";
import {
  SOCIAL_CREATIVE_MAX_IMAGE_REFERENCES,
  SOCIAL_CREATIVE_COPY_VERSION,
  SOCIAL_CREATIVE_CAROUSEL_MAX_SLIDES,
  socialCreativeDailyBudgetUsd,
  socialCreativeImageCostUsd,
  socialCreativeRunBudgetUsd,
} from "./constants";
import {
  normalizeSocialPlatforms,
  resolveSocialCreativeFormat,
} from "./formats";
import {
  generateWebsiteCampaignImage,
  SocialCreativeProviderError,
} from "./openai-image-provider";
import {
  buildDeterministicSocialPlatformCopy,
  buildDeterministicSocialPlatformCopyVariants,
  formatSocialPlatformCopy,
  planSocialPlatformCopy,
  type SocialPlatformCopyPlan,
} from "./platform-copy";
import { socialCreativeErrorMessage } from "./error-message";
import { fetchPublicResource } from "./safe-fetch";
import {
  checkpointSocialCreativeProviderResult,
  claimSocialCreativeAsset,
  completeSocialCreativeAsset,
  failSocialCreativeAsset,
  failSocialCreativeRun,
  finalizeSocialCreativeRun as finalizeSocialCreativeRunRepository,
  heartbeatSocialCreativeAsset,
  loadSocialCreativeAsset,
  persistSocialCreativePlan,
  recordSocialCreativeImageUsage,
  recordSocialCreativeTextUsage,
  socialCreativeSpendSince,
} from "./repository";
import type {
  SocialCreativeBrandContext,
  SocialCreativeImageReference,
  SocialCreativeImageResult,
  SocialCreativePlan,
  SocialCreativePreferredImageSize,
  SocialCreativeProviderImageSize,
  SocialPlatform,
} from "./types";
import {
  prepareWebsiteCampaign,
  WEBSITE_CAMPAIGN_PLATFORM_FORMATS,
} from "./website-campaign";
import { clearOnboardingV2GenerationError } from "../../utils/onboarding-v2-generation-state";
import {
  markSocialArtworkLogoGenerated,
  resolveScheduledSocialArtworkLogo,
} from "../social-logo-usage-policy.service";
import { SOCIAL_CAROUSEL_PLATFORMS } from "../social-carousel-scheduling.service";
import {
  planSocialCarouselNarrative,
  SOCIAL_CAROUSEL_PLAN_VERSION,
  type SocialCarouselNarrative,
} from "./carousel-planner";

type SocialCreativeFailureStage =
  | "claim"
  | "onboarding"
  | "brand-context"
  | "openai"
  | "provider-checkpoint"
  | "storage"
  | "persistence";

export class SocialCreativePipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly stage: SocialCreativeFailureStage,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SocialCreativePipelineError";
  }
}

function isTransientOpenAiError(error: unknown): boolean {
  if (error instanceof SocialCreativeProviderError) return error.retryable;
  const candidate = error as { status?: unknown; name?: unknown } | null;
  const status = Number(candidate?.status ?? 0);
  if ([408, 409, 429].includes(status) || status >= 500) return true;
  return [
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "APITimeoutError",
  ].includes(String(candidate?.name ?? ""));
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Each requested platform receives one independent provider-native image. */
export function estimateSocialCreativeImageBudget(input: {
  kind: string;
  platforms?: string[];
}): number {
  return normalizeSocialPlatforms(input.platforms).reduce(
    (total, platform) =>
      total +
      socialCreativeImageCostUsd(
        resolveSocialCreativeFormat(platform).sourceSize,
      ) *
        (input.kind === "carousel" &&
        SOCIAL_CAROUSEL_PLATFORMS.includes(
          platform as (typeof SOCIAL_CAROUSEL_PLATFORMS)[number],
        )
          ? SOCIAL_CREATIVE_CAROUSEL_MAX_SLIDES
          : 1),
    0,
  );
}

type PreparedCampaign = Awaited<ReturnType<typeof prepareWebsiteCampaign>>;

type PlanDependencies = {
  prisma?: PrismaClient;
  checkAccess?: typeof checkSiteFeatureAccess;
  authorizeOnboarding?: typeof authorizeOnboardingSocialCreativeRun;
  loadBrand?: typeof loadSocialCreativeBrandContext;
  /** Legacy test seam retained while old queued jobs drain; never invoked. */
  planner?: (...args: any[]) => Promise<any>;
  prepareCampaign?: (input: {
    context: SocialCreativeBrandContext;
    socialTopic: string;
    platform?: SocialPlatform;
    includeLogo?: boolean;
  }) => Promise<PreparedCampaign>;
  planPlatformCopy?: typeof planSocialPlatformCopy;
  planCarousel?: typeof planSocialCarouselNarrative;
  resolveArtworkLogo?: typeof resolveScheduledSocialArtworkLogo;
  now?: () => Date;
};

const ONBOARDING_V2_SOCIAL_KEY = /^onboarding-v2:([^:]+):r(\d+):social$/;

export function parseOnboardingV2SocialIdempotencyKey(
  value: string,
): { quickBusinessId: string; revision: number } | null {
  const match = ONBOARDING_V2_SOCIAL_KEY.exec(value.trim());
  if (!match) return null;
  const revision = Number(match[2]);
  if (!match[1] || !Number.isSafeInteger(revision) || revision < 0) return null;
  return { quickBusinessId: match[1], revision };
}

function isFinishedOnboardingStatus(status: string): boolean {
  return ["complete", "completed"].includes(status.trim().toLowerCase());
}

export async function authorizeOnboardingSocialCreativeRun(
  run: {
    id?: string;
    idempotencyKey: string;
    userId: string;
    businessId: string;
    source: string;
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<{ quickBusinessId: string; revision: number }> {
  if (run.source !== "ONBOARDING") {
    throw new Error(
      "Onboarding social authorization requires ONBOARDING source",
    );
  }
  const parsed = parseOnboardingV2SocialIdempotencyKey(run.idempotencyKey);
  if (!parsed) {
    throw new Error("Invalid onboarding social idempotency key");
  }
  const quickBusiness = await prisma.quickScrapeBusiness.findUnique({
    where: { id: parsed.quickBusinessId },
    select: {
      userId: true,
      onboardingV2BusinessId: true,
      onboardingV2GenerationRevision: true,
      onboardingV2Status: true,
      onboardingV2CompletedAt: true,
    },
  });
  const matches =
    quickBusiness?.userId === run.userId &&
    quickBusiness.onboardingV2BusinessId === run.businessId &&
    quickBusiness.onboardingV2GenerationRevision === parsed.revision &&
    quickBusiness.onboardingV2CompletedAt === null &&
    !isFinishedOnboardingStatus(quickBusiness.onboardingV2Status);
  if (!matches) {
    throw new Error(
      "Onboarding social run does not match an unfinished owned onboarding state",
    );
  }
  return parsed;
}

async function markOnboardingSocialFailure(
  run: {
    id: string;
    idempotencyKey: string;
    userId: string;
    businessId: string;
    source: string;
  },
  error: unknown,
  code: string,
  prisma: PrismaClient,
): Promise<void> {
  if (run.source !== "ONBOARDING") return;
  const parsed = parseOnboardingV2SocialIdempotencyKey(run.idempotencyKey);
  if (!parsed) return;
  await prisma.quickScrapeBusiness.updateMany({
    where: {
      id: parsed.quickBusinessId,
      userId: run.userId,
      onboardingV2BusinessId: run.businessId,
      onboardingV2GenerationRevision: parsed.revision,
    },
    data: {
      onboardingV2SocialRunId: run.id,
      onboardingV2SocialStatus: "failed",
      onboardingV2GenerationError: {
        stage: "social",
        code,
        message: socialCreativeErrorMessage(error),
        revision: parsed.revision,
        recordedAt: new Date().toISOString(),
      },
    },
  });
}

/**
 * The function name is retained for queued-event compatibility. It no longer
 * asks a text model to create a layout/copy plan. It prepares and persists the
 * exact deterministic websiteCampaign prompt from verified backend facts.
 */
export async function planSocialCreativeRun(
  runId: string,
  dependencies: PlanDependencies = {},
): Promise<{ runId: string; assetIds: string[]; planned: boolean }> {
  const prisma = dependencies.prisma ?? defaultPrisma;
  const run = await prisma.socialCreativeRun.findUnique({
    where: { id: runId },
    include: {
      socialTopicPlan: {
        select: {
          hook: true,
          cta: true,
          objective: true,
          scheduledFor: true,
          timezone: true,
        },
      },
      posts: { include: { assets: true } },
    },
  });
  if (!run) throw new Error("Social creative run not found");
  const requested = normalizeSocialPlatforms(run.requestedPlatforms);
  const imagePlatforms = resolveSocialTopicImagePlatforms({
    platforms: requested,
    topicScheduledFor: run.socialTopicPlan?.scheduledFor,
    timeZone: run.socialTopicPlan?.timezone,
  });
  const existingAssetIds = run.posts.flatMap((post) =>
    post.assets.map((asset) => asset.id),
  );
  const existingPlatforms = new Set(
    run.posts.flatMap((post) => post.assets.map((asset) => asset.platform)),
  );
  let onboardingAuthorization: {
    quickBusinessId: string;
    revision: number;
  } | null = null;
  if (run.source === "ONBOARDING") {
    try {
      onboardingAuthorization = await (
        dependencies.authorizeOnboarding ?? authorizeOnboardingSocialCreativeRun
      )(run, prisma);
    } catch (error) {
      const code = "SOCIAL_CREATIVE_ONBOARDING_STATE_INVALID";
      await failSocialCreativeRun(
        { runId, error, code, stage: "onboarding" },
        prisma,
      );
      await markOnboardingSocialFailure(run, error, code, prisma);
      throw new SocialCreativePipelineError(
        socialCreativeErrorMessage(error),
        code,
        "onboarding",
        false,
        error,
      );
    }
  }
  if (
    run.contentPlan &&
    imagePlatforms.every((platform) => existingPlatforms.has(platform))
  ) {
    return { runId, assetIds: existingAssetIds, planned: false };
  }

  if (run.source !== "ONBOARDING") {
    const access = await (dependencies.checkAccess ?? checkSiteFeatureAccess)(
      run.businessId,
      "social_generation",
    );
    if (!access.hasAccess) {
      const error = new Error(
        access.message || "Business has no active entitlement",
      );
      await failSocialCreativeRun(
        {
          runId,
          error,
          code: "SOCIAL_CREATIVE_ENTITLEMENT_INACTIVE",
          stage: "entitlement",
        },
        prisma,
      );
      throw error;
    }
  }

  const estimatedBudget = estimateSocialCreativeImageBudget({
    kind: run.kind,
    platforms: imagePlatforms,
  });
  if (estimatedBudget > socialCreativeRunBudgetUsd()) {
    const error = new Error(
      `Website campaign estimate $${estimatedBudget.toFixed(4)} exceeds the configured per-run budget`,
    );
    const code = "SOCIAL_CREATIVE_RUN_BUDGET_EXCEEDED";
    await failSocialCreativeRun(
      {
        runId,
        error,
        code,
        stage: "budget",
      },
      prisma,
    );
    await markOnboardingSocialFailure(run, error, code, prisma);
    throw error;
  }
  const now = dependencies.now?.() ?? new Date();
  const dailySpend = await socialCreativeSpendSince(startOfUtcDay(now), prisma);
  if (dailySpend + estimatedBudget > socialCreativeDailyBudgetUsd()) {
    const error = new Error(
      "Website campaign daily provider budget would be exceeded",
    );
    const code = "SOCIAL_CREATIVE_DAILY_BUDGET_EXCEEDED";
    await failSocialCreativeRun(
      {
        runId,
        error,
        code,
        stage: "budget",
      },
      prisma,
    );
    await markOnboardingSocialFailure(run, error, code, prisma);
    throw error;
  }

  await prisma.socialCreativeRun.update({
    where: { id: runId },
    data: { status: "PLANNING", startedAt: run.startedAt ?? now },
  });
  if (run.source === "ONBOARDING") {
    const parsed = parseOnboardingV2SocialIdempotencyKey(run.idempotencyKey);
    if (parsed) {
      await prisma.quickScrapeBusiness.updateMany({
        where: {
          id: parsed.quickBusinessId,
          userId: run.userId,
          onboardingV2BusinessId: run.businessId,
          onboardingV2GenerationRevision: parsed.revision,
        },
        data: {
          onboardingV2SocialRunId: run.id,
          onboardingV2SocialStatus: "running",
        },
      });
      await clearOnboardingV2GenerationError(prisma, {
        quickBusinessId: parsed.quickBusinessId,
        userId: run.userId,
        businessId: run.businessId,
        revision: parsed.revision,
        stage: "social",
      });
    }
  }
  let brand: SocialCreativeBrandContext;
  let generationContext: SocialCreativeBrandContext;
  let effectiveTopic = run.topic;
  let campaigns: Array<PreparedCampaign & { slideIndex: number }>;
  let copyPlan: SocialPlatformCopyPlan;
  let carouselNarrative: SocialCarouselNarrative | null = null;
  let includeArtworkLogo = true;
  try {
    brand = await (dependencies.loadBrand ?? loadSocialCreativeBrandContext)(
      {
        businessId: run.businessId,
        userId: run.userId,
        ...(onboardingAuthorization
          ? { onboardingPreview: onboardingAuthorization }
          : {}),
      },
      prisma,
    );
    const activePromotion = resolveSocialPromotionForInstant({
      promotion: brand.promotion,
      scheduledFor: run.socialTopicPlan?.scheduledFor ?? now,
      timeZone: run.socialTopicPlan?.timezone ?? "UTC",
    });
    effectiveTopic = activePromotion?.title ?? run.topic;
    includeArtworkLogo = run.socialTopicPlan
      ? await (
          dependencies.resolveArtworkLogo ??
          resolveScheduledSocialArtworkLogo
        )(
          {
            runId: run.id,
            businessId: run.businessId,
            scheduledFor: run.socialTopicPlan.scheduledFor,
            timeZone: run.socialTopicPlan.timezone,
            platforms: imagePlatforms,
          },
          prisma,
          now,
        )
      : true;
    generationContext = {
      ...brand,
      promotion: activePromotion,
    };
    const prepare =
      dependencies.prepareCampaign ??
      ((input: {
        context: SocialCreativeBrandContext;
        socialTopic: string;
        platform?: SocialPlatform;
        includeLogo?: boolean;
      }) => prepareWebsiteCampaign(input));
    const socialTopicPrompt = [
      effectiveTopic,
      activePromotion?.information,
      activePromotion?.preferredContent,
      run.socialTopicPlan?.hook,
      run.socialTopicPlan?.cta,
    ]
      .filter(Boolean)
      .join("\n");
    if (run.kind === "carousel") {
      carouselNarrative = await (
        dependencies.planCarousel ?? planSocialCarouselNarrative
      )({
        context: generationContext,
        topic: effectiveTopic,
        hook: run.socialTopicPlan?.hook,
        cta: run.socialTopicPlan?.cta,
        objective: run.socialTopicPlan?.objective,
        idempotencyKey: `${run.correlationId}:carousel-plan:${SOCIAL_CAROUSEL_PLAN_VERSION}`,
      });
    }
    const campaignSlides = carouselNarrative?.slides ?? [
      {
        headline: effectiveTopic,
        supportingLine: run.socialTopicPlan?.hook ?? "",
        visualConcept: "Provider-composed website campaign",
        cta: run.socialTopicPlan?.cta ?? "",
      },
    ];
    campaigns = await Promise.all(
      campaignSlides.flatMap((slide, slideIndex) =>
        imagePlatforms.flatMap((platform) => {
          const supportsCarousel = SOCIAL_CAROUSEL_PLATFORMS.includes(
            platform as (typeof SOCIAL_CAROUSEL_PLATFORMS)[number],
          );
          if (run.kind === "carousel" && !supportsCarousel && slideIndex > 0) {
            return [];
          }
          const carouselBrief = carouselNarrative
            ? [
                `Carousel ${slideIndex + 1} of ${campaignSlides.length}.`,
                `Shared art direction: ${carouselNarrative.creativeDirection}`,
                `Slide headline: ${slide.headline}.`,
                `Slide support: ${slide.supportingLine}.`,
                `Visual purpose: ${slide.visualConcept}.`,
                slide.cta ? `Verified action: ${slide.cta}.` : "",
                `Grounded topic: ${socialTopicPrompt}`,
              ]
                .filter(Boolean)
                .join(" ")
            : socialTopicPrompt;
          return [
            prepare({
              context: generationContext,
              socialTopic: carouselBrief,
              platform,
              includeLogo:
                includeArtworkLogo &&
                (run.kind !== "carousel" || slideIndex === 0),
            }).then((campaign) => ({ ...campaign, slideIndex })),
          ];
        }),
      ),
    );
    const copyInput = {
      context: generationContext,
      platforms: requested,
      topic: effectiveTopic,
      hook: run.socialTopicPlan?.hook,
      cta: run.socialTopicPlan?.cta,
      objective: run.socialTopicPlan?.objective,
      idempotencyKey: `${run.correlationId}:platform-copy:${SOCIAL_CREATIVE_COPY_VERSION}`,
    };
    try {
      copyPlan = await (
        dependencies.planPlatformCopy ?? planSocialPlatformCopy
      )(copyInput);
    } catch (error) {
      const platformCopy = buildDeterministicSocialPlatformCopy(copyInput);
      copyPlan = {
        platformCopy,
        platformCopyVariants: buildDeterministicSocialPlatformCopyVariants(
          copyInput,
          platformCopy,
        ),
        source: "deterministic-fallback",
        version: SOCIAL_CREATIVE_COPY_VERSION,
        fallbackReason:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "unknown planner error",
      };
    }
  } catch (error) {
    const code = "WEBSITE_CAMPAIGN_CONTEXT_FAILED";
    await failSocialCreativeRun(
      {
        runId,
        error,
        code,
        stage: "brand-context",
      },
      prisma,
    );
    await markOnboardingSocialFailure(run, error, code, prisma);
    throw new SocialCreativePipelineError(
      socialCreativeErrorMessage(error),
      code,
      "brand-context",
      false,
      error,
    );
  }

  const legacyPlatform = requested[0]!;
  const legacyCopy =
    copyPlan.platformCopy[legacyPlatform] ??
    buildDeterministicSocialPlatformCopy({
      context: generationContext,
      platforms: [legacyPlatform],
      topic: effectiveTopic,
      hook: run.socialTopicPlan?.hook,
      cta: run.socialTopicPlan?.cta,
      objective: run.socialTopicPlan?.objective,
      idempotencyKey: `${run.correlationId}:platform-copy:legacy-fallback`,
    })[legacyPlatform]!;
  const plan: SocialCreativePlan = {
    language: generationContext.language,
    locale: generationContext.locale,
    topic: effectiveTopic,
    artworkLogoIncluded: includeArtworkLogo,
    ...(brand.logoUrl ? { brandLogoUrl: brand.logoUrl } : {}),
    brandReferences: campaigns[0]?.brandReferences ?? [],
    platformCopy: copyPlan.platformCopy,
    platformCopyVariants: copyPlan.platformCopyVariants,
    platformCopySource: copyPlan.source,
    platformCopyVersion: copyPlan.version,
    ...(carouselNarrative
      ? {
          carouselCreativeDirection: carouselNarrative.creativeDirection,
          carouselPlanVersion: SOCIAL_CAROUSEL_PLAN_VERSION,
        }
      : {}),
    slides: carouselNarrative
      ? carouselNarrative.slides.map((slide, slideIndex) => ({
          slideIndex,
          topic: effectiveTopic,
          headline: slide.headline,
          supportingLine: slide.supportingLine,
          cta: slide.cta,
          caption: formatSocialPlatformCopy(legacyCopy),
          visualConcept: slide.visualConcept,
          campaignObjective: run.socialTopicPlan?.objective ?? "education",
          archetype: "educational-carousel",
          layoutFamily: "provider-native-carousel",
        }))
      : [
          {
            slideIndex: 0,
            topic: effectiveTopic,
            // These neutral values keep the existing additive tables readable for
            // legacy runs; none of them are rendered or sent as a separate plan.
            headline: effectiveTopic,
            supportingLine: run.socialTopicPlan?.hook ?? "",
            cta: run.socialTopicPlan?.cta ?? "",
            caption: formatSocialPlatformCopy(legacyCopy),
            visualConcept: "Provider-composed website campaign",
            campaignObjective: run.socialTopicPlan?.objective ?? "conversion",
            archetype: "website-campaign",
            layoutFamily: "none",
          },
        ],
  };
  const assetIds = await persistSocialCreativePlan(
    {
      runId,
      businessId: run.businessId,
      plan,
      usage: copyPlan.usage,
      assets: campaigns.map((campaign) => ({
        slideIndex: campaign.slideIndex,
        platform: campaign.platform,
        width: campaign.format.width,
        height: campaign.format.height,
        aspectRatio: campaign.format.aspectRatio,
        sourceSize: campaign.format.sourceSize,
        prompt: campaign.prompt,
      })),
    },
    prisma,
  );
  if (carouselNarrative?.usage) {
    await recordSocialCreativeTextUsage(
      { runId, usage: carouselNarrative.usage },
      prisma,
      {
        correlationId: run.correlationId,
        userId: run.userId,
        businessId: run.businessId,
      },
    );
  }
  return { runId, assetIds, planned: true };
}

type RenderDependencies = {
  prisma?: PrismaClient;
  /** Legacy test seam retained for source compatibility; never invoked. */
  loadBrand?: typeof loadSocialCreativeBrandContext;
  /** Legacy test seam retained for source compatibility; never invoked. */
  approveBrandMark?: (...args: any[]) => Promise<any>;
  generateImage?: (input: {
    prompt: string;
    targetSize: SocialCreativePreferredImageSize;
    idempotencyKey: string;
    references?: SocialCreativeImageReference[];
  }) => Promise<SocialCreativeImageResult>;
  upload?: (
    buffer: Buffer,
    mimeType: string,
    folder: string,
    publicId: string,
  ) => Promise<string | SocialImageUploadReceipt>;
  fetchProviderArtifact?: (url: string) => Promise<Buffer>;
  now?: () => Date;
  renderLeaseMs?: number;
};

export const SOCIAL_CREATIVE_RENDER_LEASE_MS = 5 * 60 * 1000;

export type SocialCreativeAssetRenderResult =
  | {
      assetId: string;
      imageUrl: string;
      rendered: boolean;
      state: "complete";
      providerOutputUnchanged?: true;
      sha256?: string;
    }
  | {
      assetId: string;
      imageUrl: null;
      rendered: false;
      state: "in_progress";
    };

function mimeTypeForAsset(
  generated: SocialCreativeImageResult,
  fallback = "image/png",
): string {
  return generated.returned?.mimeType || fallback;
}

function imageReferencesFromPlan(
  value: unknown,
): SocialCreativeImageReference[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const references = (value as { brandReferences?: unknown }).brandReferences;
  if (!Array.isArray(references)) return [];
  return references
    .flatMap((reference) => {
      if (
        !reference ||
        typeof reference !== "object" ||
        Array.isArray(reference)
      ) {
        return [];
      }
      const candidate = reference as Record<string, unknown>;
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      const role =
        candidate.role === "logo" ||
        candidate.role === "subject" ||
        candidate.role === "style-layout"
          ? candidate.role
          : null;
      if (!url || !role) return [];
      return [
        {
          url,
          role,
          ...(typeof candidate.description === "string" &&
          candidate.description.trim()
            ? { description: candidate.description.trim().slice(0, 500) }
            : {}),
        } satisfies SocialCreativeImageReference,
      ];
    })
    .slice(0, SOCIAL_CREATIVE_MAX_IMAGE_REFERENCES);
}

export async function renderSocialCreativeAsset(
  assetId: string,
  dependencies: RenderDependencies = {},
): Promise<SocialCreativeAssetRenderResult> {
  const prisma = dependencies.prisma ?? defaultPrisma;
  const now = dependencies.now?.() ?? new Date();
  const configuredLeaseMs = dependencies.renderLeaseMs;
  const renderLeaseMs =
    typeof configuredLeaseMs === "number" &&
    Number.isFinite(configuredLeaseMs) &&
    configuredLeaseMs >= 1_000
      ? configuredLeaseMs
      : SOCIAL_CREATIVE_RENDER_LEASE_MS;
  const existing = await loadSocialCreativeAsset(assetId, prisma);
  if (!existing) throw new Error("Social creative asset not found");
  if (existing.status === "COMPLETE" && existing.imageUrl) {
    if (existing.providerRequestId) {
      await recordSocialCreativeImageUsage(
        {
          runId: existing.post.run.id,
          assetId,
          providerRequestId: existing.providerRequestId,
          estimatedUsd: Number(
            existing.actualUsd ?? existing.estimatedUsd ?? 0,
          ),
          metadata: {
            engine: "website-campaign",
            providerOutputUnchanged: true,
            receiptRepair: true,
          },
        },
        prisma,
      );
    }
    return {
      assetId,
      imageUrl: existing.imageUrl,
      rendered: false,
      state: "complete",
    };
  }

  const claimed = await claimSocialCreativeAsset(assetId, prisma, {
    staleBefore: new Date(now.getTime() - renderLeaseMs),
    claimedAt: now,
  });
  if (!claimed) {
    const current = await loadSocialCreativeAsset(assetId, prisma);
    if (current?.status === "COMPLETE" && current.imageUrl) {
      return {
        assetId,
        imageUrl: current.imageUrl,
        rendered: false,
        state: "complete",
      };
    }
    if (current?.status === "RENDERING") {
      return {
        assetId,
        imageUrl: null,
        rendered: false,
        state: "in_progress",
      };
    }
    throw new SocialCreativePipelineError(
      `Social creative asset cannot be rendered from status ${current?.status ?? "missing"}`,
      "SOCIAL_CREATIVE_ASSET_NOT_RENDERABLE",
      "claim",
      false,
    );
  }

  const asset = (await loadSocialCreativeAsset(assetId, prisma))!;
  const leaseStartedAt = asset.startedAt ?? now;
  const run = asset.post.run;
  const format =
    WEBSITE_CAMPAIGN_PLATFORM_FORMATS[
      asset.platform as keyof typeof WEBSITE_CAMPAIGN_PLATFORM_FORMATS
    ];
  if (!format)
    throw new Error(`Unsupported website campaign platform ${asset.platform}`);
  const heartbeatIntervalMs = Math.max(
    1_000,
    Math.min(60_000, Math.floor(renderLeaseMs / 3)),
  );
  const heartbeatTimer = setInterval(() => {
    void heartbeatSocialCreativeAsset(
      assetId,
      leaseStartedAt,
      prisma,
    ).catch((error) => {
      console.error("[social-creative] render lease heartbeat failed", error);
    });
  }, heartbeatIntervalMs);
  let failure: { code: string; stage: SocialCreativeFailureStage } = {
    code: "WEBSITE_CAMPAIGN_OPENAI_FAILED",
    stage: "openai",
  };

  try {
    let generated: SocialCreativeImageResult;
    let uploadReceipt: SocialImageUploadReceipt | null = null;
    if (asset.providerRequestId && asset.providerArtifactUrl) {
      failure = {
        code: "WEBSITE_CAMPAIGN_PROVIDER_RECOVERY_FAILED",
        stage: "provider-checkpoint",
      };
      const buffer = dependencies.fetchProviderArtifact
        ? await dependencies.fetchProviderArtifact(asset.providerArtifactUrl)
        : (
            await fetchPublicResource(asset.providerArtifactUrl, {
              maxBytes: 20 * 1024 * 1024,
              allowedContentTypes: ["image/"],
            })
          ).buffer;
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (
        asset.providerArtifactSha256 &&
        sha256 !== asset.providerArtifactSha256
      ) {
        throw new Error("Recovered provider artifact checksum mismatch");
      }
      generated = {
        buffer,
        model: asset.model,
        quality: asset.quality,
        sourceSize:
          `${asset.width}x${asset.height}` as SocialCreativeProviderImageSize,
        providerRequestId: asset.providerRequestId,
        sha256,
        estimatedUsd: Number(asset.estimatedUsd ?? 0),
        actualUsd: asset.actualUsd === null ? null : Number(asset.actualUsd),
        pricingVersion: "persisted-receipt",
        usage: null,
        returned: {
          outputFormat: String(
            (asset.uploadMetadata as { format?: unknown } | null)?.format ??
              "png",
          ),
          mimeType: "image/png",
          width: asset.width,
          height: asset.height,
          source: "url",
        },
      };
      const persistedUploadMetadata = asset.uploadMetadata as {
        provider?: unknown;
        objectKey?: unknown;
        storageZone?: unknown;
        checksumSha256?: unknown;
      } | null;
      const persistedProvider =
        persistedUploadMetadata?.provider === "bunny" ? "bunny" : "cloudinary";
      uploadReceipt = {
        url: asset.providerArtifactUrl,
        ...(persistedProvider === "cloudinary"
          ? {
              publicId: asset.cloudinaryPublicId ?? asset.id,
              account:
                asset.cloudinaryAccount === "fallback"
                  ? ("fallback" as const)
                  : ("primary" as const),
            }
          : {
              storageZone:
                typeof persistedUploadMetadata?.storageZone === "string"
                  ? persistedUploadMetadata.storageZone
                  : undefined,
              checksumSha256:
                typeof persistedUploadMetadata?.checksumSha256 === "string"
                  ? persistedUploadMetadata.checksumSha256
                  : undefined,
            }),
        bytes: buffer.length,
        format: generated.returned?.outputFormat ?? "png",
        objectKey:
          typeof persistedUploadMetadata?.objectKey === "string"
            ? persistedUploadMetadata.objectKey
            : (asset.cloudinaryPublicId ?? asset.id),
        provider: persistedProvider,
      };
    } else {
      generated = await (
        dependencies.generateImage ?? generateWebsiteCampaignImage
      )({
        prompt: asset.prompt,
        targetSize: format.sourceSize,
        idempotencyKey: `${run.correlationId}:${asset.id}`,
        references: imageReferencesFromPlan(run.contentPlan),
      });

      failure = {
        code: "WEBSITE_CAMPAIGN_STORAGE_FAILED",
        stage: "storage",
      };
      const folder = `social-creatives/${run.businessId}/${run.id}/website-campaign`;
      const uploaded = dependencies.upload
        ? await dependencies.upload(
            generated.buffer,
            mimeTypeForAsset(generated),
            folder,
            asset.id,
          )
        : await uploadSocialImageBufferWithMetadata(
            generated.buffer,
            mimeTypeForAsset(generated),
            { folder, publicId: asset.id },
          );
      uploadReceipt =
        typeof uploaded === "string"
          ? {
              url: uploaded,
              objectKey: asset.id,
              provider: "bunny",
              bytes: generated.buffer.length,
              format: generated.returned?.outputFormat ?? null,
            }
          : uploaded;

      failure = {
        code: "WEBSITE_CAMPAIGN_PROVIDER_CHECKPOINT_FAILED",
        stage: "provider-checkpoint",
      };
      await checkpointSocialCreativeProviderResult(
        {
          assetId,
          runId: run.id,
          providerRequestId: generated.providerRequestId,
          sha256: generated.sha256,
          providerArtifactUrl: uploadReceipt.url,
          estimatedUsd: generated.estimatedUsd,
          actualUsd: generated.actualUsd,
          quality: generated.quality,
          width: generated.returned?.width,
          height: generated.returned?.height,
          sourceSize: generated.sourceSize,
          uploadMetadata: {
            provider: uploadReceipt.provider,
            objectKey: uploadReceipt.objectKey,
            storageZone: uploadReceipt.storageZone,
            checksumSha256: uploadReceipt.checksumSha256,
            bytes: uploadReceipt.bytes,
            format: uploadReceipt.format,
          },
          metadata: {
            engine: "website-campaign",
            model: generated.model,
            requested: generated.requested,
            returned: generated.returned,
            usage: generated.usage,
            actualUsd: generated.actualUsd,
            pricingVersion: generated.pricingVersion,
            retryNumber: Math.max(0, asset.attemptCount - 1),
            providerOutputUnchanged: true,
          },
        },
        prisma,
      );
    }

    failure = {
      code: "WEBSITE_CAMPAIGN_PERSISTENCE_FAILED",
      stage: "persistence",
    };
    const completed = await completeSocialCreativeAsset(
      {
        assetId,
        imageUrl: uploadReceipt.url,
        finalArtifactSha256: generated.sha256,
        cloudinaryPublicId:
          uploadReceipt.provider === "cloudinary"
            ? uploadReceipt.publicId
            : undefined,
        cloudinaryAccount:
          uploadReceipt.provider === "cloudinary"
            ? uploadReceipt.account
            : undefined,
        uploadMetadata: {
          provider: uploadReceipt.provider,
          objectKey: uploadReceipt.objectKey,
          storageZone: uploadReceipt.storageZone,
          checksumSha256: uploadReceipt.checksumSha256,
          bytes: uploadReceipt.bytes,
          format: uploadReceipt.format,
          requestedSize: generated.requested?.sourceSize ?? "auto",
          targetSize: generated.requested?.targetSize ?? format.sourceSize,
          returnedSize: generated.sourceSize,
          providerOutputUnchanged: true,
        },
        qualityResult: {
          ok: true,
          bytes: generated.buffer.length,
          format: generated.returned?.outputFormat ?? uploadReceipt.format,
          width: generated.returned?.width ?? asset.width,
          height: generated.returned?.height ?? asset.height,
          sha256: generated.sha256,
          providerOutputUnchanged: true,
        },
        compositorDiagnostics: {
          mode: "provider-direct",
          compositorApplied: false,
          resized: false,
          reencoded: false,
        },
        leaseStartedAt,
      },
      prisma,
    );
    if (!completed) {
      const current = await loadSocialCreativeAsset(assetId, prisma);
      if (current?.status === "COMPLETE" && current.imageUrl) {
        return {
          assetId,
          imageUrl: current.imageUrl,
          rendered: false,
          state: "complete",
        };
      }
      if (current?.status === "RENDERING") {
        return {
          assetId,
          imageUrl: null,
          rendered: false,
          state: "in_progress",
        };
      }
      throw new SocialCreativePipelineError(
        "Social creative render lease was replaced before completion",
        "SOCIAL_CREATIVE_ASSET_LEASE_LOST",
        "claim",
        true,
      );
    }
    return {
      assetId,
      imageUrl: uploadReceipt.url,
      rendered: true,
      state: "complete",
      providerOutputUnchanged: true,
      sha256: generated.sha256,
    };
  } catch (error) {
    const failed = await failSocialCreativeAsset(
      {
        assetId,
        error,
        code: failure.code,
        stage: failure.stage,
        leaseStartedAt,
      },
      prisma,
    ).catch((markError) => {
      console.error(
        "[social-creative] failed to persist asset failure",
        markError,
      );
      return false;
    });
    if (!failed) {
      throw new SocialCreativePipelineError(
        "Social creative render lease was replaced by another worker",
        "SOCIAL_CREATIVE_ASSET_STILL_RENDERING",
        "claim",
        true,
        error,
      );
    }
    throw new SocialCreativePipelineError(
      socialCreativeErrorMessage(error),
      failure.code,
      failure.stage,
      failure.stage === "openai" && isTransientOpenAiError(error),
      error,
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function finalizeSocialCreativeRun(
  runId: string,
  prisma: PrismaClient = defaultPrisma,
) {
  const result = await finalizeSocialCreativeRunRepository(runId, prisma);
  if (result.status !== "COMPLETE" && result.status !== "FAILED") {
    return result;
  }
  const run = await prisma.socialCreativeRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      idempotencyKey: true,
      source: true,
      socialTopicPlanId: true,
      userId: true,
      businessId: true,
    },
  });
  if (!run) return result;
  if (run.socialTopicPlanId) {
    await prisma.socialTopicPlan.updateMany({
      where: { id: run.socialTopicPlanId, businessId: run.businessId },
      data:
        result.status === "COMPLETE"
          ? {
              status: "READY",
              generatedAt: new Date(),
              failureCode: null,
              failureMessage: null,
            }
          : {
              status: "FAILED",
              failureCode: "SOCIAL_CREATIVE_ASSETS_FAILED",
              failureMessage: `${result.failed} of ${result.total} assets failed`,
            },
    });
  }
  if (result.status === "COMPLETE") {
    await markSocialArtworkLogoGenerated(run.id, prisma);
  }
  if (run.source !== "ONBOARDING") return result;
  const parsed = parseOnboardingV2SocialIdempotencyKey(run.idempotencyKey);
  if (!parsed) return result;
  await prisma.quickScrapeBusiness.updateMany({
    where: {
      id: parsed.quickBusinessId,
      userId: run.userId,
      onboardingV2BusinessId: run.businessId,
      onboardingV2GenerationRevision: parsed.revision,
    },
    data:
      result.status === "COMPLETE"
        ? {
            onboardingV2SocialRunId: run.id,
            onboardingV2SocialStatus: "complete",
          }
        : {
            onboardingV2SocialRunId: run.id,
            onboardingV2SocialStatus: "failed",
            onboardingV2GenerationError: {
              stage: "social",
              code: "SOCIAL_CREATIVE_ASSETS_FAILED",
              message: `${result.failed} of ${result.total} assets failed`,
              revision: parsed.revision,
              recordedAt: new Date().toISOString(),
            },
          },
  });
  if (result.status === "COMPLETE") {
    await clearOnboardingV2GenerationError(prisma, {
      quickBusinessId: parsed.quickBusinessId,
      userId: run.userId,
      businessId: run.businessId,
      revision: parsed.revision,
      stage: "social",
    });
  }
  return result;
}
