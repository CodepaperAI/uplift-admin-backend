import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import {
  resolveAutomaticSocialPublishSlots,
  resolveSocialTopicPublishPlatforms,
  type SocialMediaMode,
} from "../../utils/social-platform-schedule.utils";
import {
  sanitizePublicSocialCaption,
  SOCIAL_PLATFORM_COPY_LIMITS,
  socialCaptionInternalContextLabels,
} from "../social-creative/platform-copy";
import type { SocialPlatform } from "../social-creative/types";
import {
  UPLIFT_TO_ZERNIO_PLATFORM,
  ZERNIO_TO_UPLIFT_PLATFORM,
  ZernioApiError,
  ZernioClient,
  type ZernioAccount,
  type UpliftSocialPlatform,
  type ZernioPost,
} from "./zernio.client";

const SUPPORTED_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "x",
] as const satisfies readonly SocialPlatform[];

export type PublishMode = "NOW" | "SCHEDULE";

export class SocialPublishingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SocialPublishingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function frontendOrigin(): string {
  const configured =
    process.env.FRONTEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://upliftai.co";
  try {
    return new URL(configured).origin;
  } catch {
    return "http://upliftai.co";
  }
}

function cleanOptionalString(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

export type ZernioPostFailureDetails = {
  category: string | null;
  code: string;
  message: string;
  reconnectRequired: boolean;
};

/**
 * Zernio reports platform-level failures inside the post's `platforms` array.
 * Keep provider diagnostics server-side, but normalize authentication failures
 * to one stable account-reconnection state for the dashboard and retry guards.
 */
export function zernioPostFailureDetails(
  value: unknown,
): ZernioPostFailureDetails | null {
  if (!isRecord(value)) return null;
  const platforms = Array.isArray(value.platforms)
    ? value.platforms.filter(isRecord)
    : [];
  const platformFailure =
    platforms.find((candidate) => {
      const status = cleanOptionalString(candidate.status, 80)?.toLowerCase();
      return Boolean(
        status === "failed" ||
          candidate.errorCategory ||
          candidate.errorMessage ||
          candidate.error,
      );
    }) ?? null;
  const category = cleanOptionalString(
    platformFailure?.errorCategory ?? value.errorCategory,
    120,
  )?.toLowerCase() ?? null;
  const providerMessage = cleanOptionalString(
    platformFailure?.errorMessage ??
      platformFailure?.error ??
      value.errorMessage ??
      value.error ??
      value.message,
    500,
  );
  if (!category && !providerMessage) return null;

  const authEvidence = `${category ?? ""}\n${providerMessage ?? ""}`.toLowerCase();
  const reconnectRequired =
    [
      "auth_expired",
      "auth_error",
      "authentication_error",
      "invalid_token",
      "reconnect_required",
      "token_expired",
      "token_revoked",
    ].includes(category ?? "") ||
    /token refresh failed|invalid refresh token|invalid_grant|token was invalid|authorization (?:has )?expired|reauthori[sz]/i.test(
      authEvidence,
    );
  const normalizedCategory = category
    ?.toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return {
    category,
    code: reconnectRequired
      ? "SOCIAL_ACCOUNT_RECONNECT_REQUIRED"
      : normalizedCategory
        ? `ZERNIO_${normalizedCategory}`
        : "ZERNIO_POST_FAILED",
    message: reconnectRequired
      ? "The social account authorization has expired. Reconnect the account before retrying this post."
      : providerMessage ?? "Zernio could not publish this post",
    reconnectRequired,
  };
}

export async function deactivateZernioAccountForReconnect(
  accountId: string,
  prisma: PrismaClient = defaultPrisma,
  now = new Date(),
) {
  return prisma.socialPublisherAccount.updateMany({
    where: { id: accountId },
    data: {
      isActive: false,
      isDefault: false,
      disconnectedAt: now,
      lastSyncedAt: now,
    },
  });
}

function cleanPublicHttpsUrl(value: unknown): string | null {
  const candidate = cleanOptionalString(value, 1_000);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function assertPublicMediaUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SocialPublishingError(
      "The generated image URL is invalid",
      409,
      "SOCIAL_MEDIA_URL_INVALID",
    );
  }
  if (url.protocol !== "https:") {
    throw new SocialPublishingError(
      "The generated image must be available over HTTPS",
      409,
      "SOCIAL_MEDIA_URL_NOT_PUBLIC",
    );
  }
  return url.toString();
}

function mapProviderPlatform(value: string): UpliftSocialPlatform | null {
  return ZERNIO_TO_UPLIFT_PLATFORM[
    value.toLowerCase() as keyof typeof ZERNIO_TO_UPLIFT_PLATFORM
  ] ?? null;
}

export function publicSocialProfileError(
  code: string | null | undefined,
): { code: string; message: string } | null {
  if (!code) return null;

  if (code === "PAYMENT_REQUIRED") {
    return {
      code,
      message:
        "A payment method is required in Zernio before another social account can be connected.",
    };
  }
  if (code === "ZERNIO_NOT_CONFIGURED") {
    return {
      code,
      message: "Social publishing is not configured yet. Please contact support.",
    };
  }
  if (code === "ZERNIO_TIMEOUT" || code === "ZERNIO_NETWORK_ERROR") {
    return {
      code,
      message:
        "The social publishing provider is temporarily unavailable. Please try again in a moment.",
    };
  }

  return {
    code,
    message:
      "The social publishing profile could not be prepared. Try connecting again, or contact support if the problem continues.",
  };
}

export async function ensureZernioProfile(
  input: { businessId: string; businessName: string; websiteUrl: string | null },
  prisma: PrismaClient = defaultPrisma,
  client = new ZernioClient(),
) {
  let profile = await prisma.socialPublisherProfile.findUnique({
    where: { businessId: input.businessId },
  });
  if (profile?.externalProfileId && profile.status === "READY") return profile;

  if (!profile) {
    try {
      profile = await prisma.socialPublisherProfile.create({
        data: { businessId: input.businessId, status: "PROVISIONING" },
      });
    } catch {
      profile = await prisma.socialPublisherProfile.findUnique({
        where: { businessId: input.businessId },
      });
    }
  }
  if (!profile) {
    throw new SocialPublishingError(
      "Social publishing profile could not be created",
      500,
      "SOCIAL_PROFILE_CREATE_FAILED",
    );
  }
  if (profile.externalProfileId) {
    return prisma.socialPublisherProfile.update({
      where: { id: profile.id },
      data: { status: "READY", lastErrorCode: null, lastErrorMessage: null },
    });
  }

  try {
    const remote = await client.createProfile({
      // Zernio requires profile names to be unique within the team. The short
      // Business ID keeps identical customer names collision-free while the
      // visible prefix remains recognizable in the provider dashboard.
      name: `${input.businessName.slice(0, 140)} · ${input.businessId.slice(0, 8)}`,
      description: input.websiteUrl
        ? `Uplift AI social publishing for ${input.websiteUrl}`.slice(0, 500)
        : "Uplift AI social publishing",
      idempotencyKey: `uplift-social-profile:${input.businessId}`,
    });
    return await prisma.socialPublisherProfile.update({
      where: { id: profile.id },
      data: {
        externalProfileId: remote.id,
        status: "READY",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSyncedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.socialPublisherProfile.updateMany({
      where: { id: profile.id, externalProfileId: null },
      data: {
        status: "ERROR",
        lastErrorCode:
          error instanceof ZernioApiError ? error.code : "ZERNIO_PROFILE_ERROR",
        lastErrorMessage:
          error instanceof Error ? error.message.slice(0, 500) : "Profile setup failed",
      },
    });
    throw error;
  }
}

export async function getZernioConnectUrl(
  input: {
    businessId: string;
    businessName: string;
    websiteUrl: string | null;
    platform: UpliftSocialPlatform;
  },
  prisma: PrismaClient = defaultPrisma,
  client = new ZernioClient(),
) {
  const existingAccount = await prisma.socialPublisherAccount.findFirst({
    where: {
      businessId: input.businessId,
      platform: input.platform,
      isActive: true,
    },
    select: { id: true },
  });
  if (existingAccount) {
    assertSocialPlatformConnectionAvailable(input.platform, true);
  }

  const profile = await ensureZernioProfile(input, prisma, client);
  if (!profile.externalProfileId) {
    throw new SocialPublishingError(
      "Social publishing profile is still being prepared",
      409,
      "SOCIAL_PROFILE_NOT_READY",
    );
  }
  const redirectUrl = new URL("/dashboard/social/connections", frontendOrigin());
  redirectUrl.searchParams.set("businessId", input.businessId);
  redirectUrl.searchParams.set("platform", input.platform);
  redirectUrl.searchParams.set("provider", "zernio");
  return client.getConnectUrl({
    platform: UPLIFT_TO_ZERNIO_PLATFORM[input.platform],
    profileId: profile.externalProfileId,
    redirectUrl: redirectUrl.toString(),
  });
}

export function assertSocialPlatformConnectionAvailable(
  platform: UpliftSocialPlatform,
  hasExistingAccount: boolean,
): void {
  if (!hasExistingAccount) return;
  const platformLabel =
    platform === "x"
      ? "X"
      : `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
  throw new SocialPublishingError(
    `This business already has a connected ${platformLabel} account. Disconnect it before connecting a replacement.`,
    409,
    "SOCIAL_PLATFORM_ACCOUNT_ALREADY_CONNECTED",
  );
}

type MappedRemoteAccount = {
  account: ZernioAccount;
  platform: UpliftSocialPlatform;
};

export function selectSingleRemoteAccountPerPlatform(
  remoteAccounts: readonly MappedRemoteAccount[],
  input: {
    preferredExternalAccountId?: string | null;
    previousDefaults?: Partial<Record<UpliftSocialPlatform, string>>;
    blockedExternalAccountIds?: ReadonlySet<string>;
  } = {},
): Partial<Record<UpliftSocialPlatform, string>> {
  const selected: Partial<Record<UpliftSocialPlatform, string>> = {};
  for (const platform of SUPPORTED_PLATFORMS) {
    const candidates = remoteAccounts.filter(
      ({ account, platform: candidatePlatform }) =>
        candidatePlatform === platform &&
        account.isActive !== false &&
        !input.blockedExternalAccountIds?.has(account._id),
    );
    const account =
      candidates.find(
        ({ account: candidate }) =>
          candidate._id === input.preferredExternalAccountId,
      )?.account ??
      candidates.find(
        ({ account: candidate }) =>
          candidate._id === input.previousDefaults?.[platform],
      )?.account ??
      candidates[0]?.account;
    if (account) selected[platform] = account._id;
  }
  return selected;
}

export async function syncZernioAccounts(
  input: { businessId: string; preferredExternalAccountId?: string | null },
  prisma: PrismaClient = defaultPrisma,
  client = new ZernioClient(),
) {
  const profile = await prisma.socialPublisherProfile.findUnique({
    where: { businessId: input.businessId },
    include: {
      accounts: {
        include: {
          publishAttempts: {
            where: { lastErrorCode: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED" },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!profile?.externalProfileId) {
    const profileError = publicSocialProfileError(profile?.lastErrorCode);
    throw new SocialPublishingError(
      profileError?.message ?? "Connect a social platform first",
      409,
      profileError?.code ?? "SOCIAL_PROFILE_NOT_READY",
    );
  }
  const remoteAccounts = (await client.listAccounts(profile.externalProfileId))
    .map((account) => ({ account, platform: mapProviderPlatform(account.platform) }))
    .filter(
      (value): value is {
        account: ZernioAccount;
        platform: UpliftSocialPlatform;
      } => value.platform !== null,
    );

  const previousDefaults: Partial<Record<UpliftSocialPlatform, string>> = {};
  for (const account of profile.accounts) {
    if (
      account.isDefault &&
      SUPPORTED_PLATFORMS.includes(account.platform as SocialPlatform)
    ) {
      previousDefaults[account.platform as UpliftSocialPlatform] =
        account.externalAccountId;
    }
  }
  const selectedAccountIds = selectSingleRemoteAccountPerPlatform(
    remoteAccounts,
    {
      preferredExternalAccountId: input.preferredExternalAccountId,
      previousDefaults,
      // An auth-expired account is locally inactive even if the provider's
      // account listing remains stale. A plain sync must not silently make it
      // publishable again. Only the exact account returned by a completed
      // OAuth callback may be reactivated.
      blockedExternalAccountIds: new Set(
        profile.accounts
          .filter(
            (account) =>
              !account.isActive &&
              account.publishAttempts.length > 0 &&
              account.externalAccountId !== input.preferredExternalAccountId,
          )
          .map((account) => account.externalAccountId),
      ),
    },
  );

  const remoteAccountIds = remoteAccounts.map(({ account }) => account._id);
  const accountConflict = remoteAccountIds.length
    ? await prisma.socialPublisherAccount.findFirst({
        where: {
          externalAccountId: { in: remoteAccountIds },
          businessId: { not: input.businessId },
        },
        select: { id: true },
      })
    : null;
  if (accountConflict) {
    throw new SocialPublishingError(
      "A connected social account is already assigned to another website",
      409,
      "SOCIAL_ACCOUNT_TENANT_CONFLICT",
    );
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.socialPublisherAccount.updateMany({
      where: { profileId: profile.id },
      data: { isActive: false, isDefault: false, disconnectedAt: now, lastSyncedAt: now },
    });
    for (const { account, platform } of remoteAccounts) {
      const active =
        account.isActive !== false && selectedAccountIds[platform] === account._id;
      await tx.socialPublisherAccount.upsert({
        where: { externalAccountId: account._id },
        create: {
          profileId: profile.id,
          businessId: input.businessId,
          externalAccountId: account._id,
          platform,
          providerPlatform: account.platform.toLowerCase(),
          username: cleanOptionalString(account.username, 160),
          displayName: cleanOptionalString(account.displayName, 160),
          profileUrl: cleanPublicHttpsUrl(account.profileUrl),
          avatarUrl: cleanPublicHttpsUrl(
            account.avatarUrl ?? account.profilePicture,
          ),
          isActive: active,
          isDefault: active,
          connectedAt: now,
          disconnectedAt: active ? null : now,
          lastSyncedAt: now,
        },
        update: {
          profileId: profile.id,
          businessId: input.businessId,
          platform,
          providerPlatform: account.platform.toLowerCase(),
          username: cleanOptionalString(account.username, 160),
          displayName: cleanOptionalString(account.displayName, 160),
          profileUrl: cleanPublicHttpsUrl(account.profileUrl),
          avatarUrl: cleanPublicHttpsUrl(
            account.avatarUrl ?? account.profilePicture,
          ),
          isActive: active,
          isDefault: active,
          disconnectedAt: active ? null : now,
          lastSyncedAt: now,
        },
      });
    }
    await tx.socialPublisherProfile.update({
      where: { id: profile.id },
      data: {
        status: "READY",
        lastSyncedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });

  return prisma.socialPublisherAccount.findMany({
    where: { businessId: input.businessId },
    orderBy: [{ platform: "asc" }, { isDefault: "desc" }, { displayName: "asc" }],
  });
}

export async function disconnectZernioAccount(
  input: { businessId: string; accountId: string },
  prisma: PrismaClient = defaultPrisma,
  client = new ZernioClient(),
) {
  const account = await prisma.socialPublisherAccount.findFirst({
    where: { id: input.accountId, businessId: input.businessId },
  });
  if (!account) {
    throw new SocialPublishingError(
      "Connected social account not found",
      404,
      "SOCIAL_ACCOUNT_NOT_FOUND",
    );
  }
  if (account.isActive) await client.disconnectAccount(account.externalAccountId);
  return prisma.socialPublisherAccount.update({
    where: { id: account.id },
    data: {
      isActive: false,
      isDefault: false,
      disconnectedAt: new Date(),
      lastSyncedAt: new Date(),
    },
  });
}

export async function setDefaultZernioAccount(
  input: { businessId: string; accountId: string },
  prisma: PrismaClient = defaultPrisma,
) {
  const account = await prisma.socialPublisherAccount.findFirst({
    where: { id: input.accountId, businessId: input.businessId, isActive: true },
  });
  if (!account) {
    throw new SocialPublishingError(
      "Connected social account not found",
      404,
      "SOCIAL_ACCOUNT_NOT_FOUND",
    );
  }
  await prisma.$transaction([
    prisma.socialPublisherAccount.updateMany({
      where: { businessId: input.businessId, platform: account.platform },
      data: { isDefault: false },
    }),
    prisma.socialPublisherAccount.update({
      where: { id: account.id },
      data: { isDefault: true },
    }),
  ]);
  return account;
}

export async function getSocialConnectionSummary(
  businessId: string,
  prisma: PrismaClient = defaultPrisma,
) {
  const [profile, automationSettings] = await Promise.all([
    prisma.socialPublisherProfile.findUnique({
      where: { businessId },
      include: {
        accounts: {
          orderBy: [{ platform: "asc" }, { isDefault: "desc" }, { displayName: "asc" }],
        },
      },
    }),
    prisma.socialAutomationSettings.findUnique({
      where: { businessId },
      select: { approvalRequired: true },
    }),
  ]);
  return {
    configured: Boolean(process.env.ZERNIO_API_KEY?.trim()),
    approvalRequired: automationSettings?.approvalRequired ?? false,
    profileStatus: profile?.status ?? "NOT_CREATED",
    profileError: publicSocialProfileError(profile?.lastErrorCode),
    lastSyncedAt: profile?.lastSyncedAt ?? null,
    accounts: profile?.accounts ?? [],
  };
}

function captionWithoutHashtags(value: string): string {
  return sanitizePublicSocialCaption(value);
}

function assertSafePublishedCaption(value: string): string {
  const caption = captionWithoutHashtags(value);
  if (caption.length < 3 || socialCaptionInternalContextLabels(caption).length > 0) {
    throw new SocialPublishingError(
      "The social caption contains no safe public-facing copy",
      409,
      "SOCIAL_CAPTION_UNSAFE",
    );
  }
  return caption;
}

function normalizedPlatformCopy(
  contentPlan: unknown,
  platform: SocialPlatform,
): { caption: string; hashtags: string[] } | null {
  if (!isRecord(contentPlan) || !isRecord(contentPlan.platformCopy)) return null;
  const copy = contentPlan.platformCopy[platform];
  if (!isRecord(copy) || typeof copy.caption !== "string") return null;
  const caption = captionWithoutHashtags(copy.caption);
  const limits = SOCIAL_PLATFORM_COPY_LIMITS[platform];
  if (caption.length < 3 || caption.length > limits.maxCharacters) return null;
  return { caption, hashtags: [] };
}

function normalizedPlatformVariantCopy(
  contentPlan: unknown,
  platform: SocialPlatform,
  slot: string,
): { caption: string; hashtags: string[] } | null {
  if (!isRecord(contentPlan) || !isRecord(contentPlan.platformCopyVariants)) {
    return null;
  }
  const variants = contentPlan.platformCopyVariants[platform];
  if (!Array.isArray(variants)) return null;
  const selected = variants.find(
    (variant) => isRecord(variant) && variant.slot === slot,
  );
  if (!isRecord(selected)) return null;
  return normalizedPlatformCopy(
    { platformCopy: { [platform]: selected } },
    platform,
  );
}

function formatPublishedCaption(copy: {
  caption: string;
  hashtags: string[];
}): string {
  return captionWithoutHashtags(copy.caption);
}

export async function createSocialPublishAttempts(
  input: {
    userId: string;
    businessId: string;
    runId: string;
    mode: PublishMode;
    scheduledFor?: Date | null;
    timezone: string;
    platforms?: SocialPlatform[];
    automatic?: {
      topicScheduledFor: Date;
      now: Date;
    };
  },
  prisma: PrismaClient = defaultPrisma,
) {
  const run = await prisma.socialCreativeRun.findFirst({
    where: {
      id: input.runId,
      userId: input.userId,
      businessId: input.businessId,
    },
    include: {
      posts: {
        orderBy: { slideIndex: "asc" },
        include: { assets: true },
      },
    },
  });
  if (!run) {
    throw new SocialPublishingError(
      "Social content set not found",
      404,
      "SOCIAL_RUN_NOT_FOUND",
    );
  }
  if (run.status !== "COMPLETE") {
    throw new SocialPublishingError(
      "Wait for every requested social image to finish generating",
      409,
      "SOCIAL_RUN_NOT_READY",
    );
  }
  const post = run.posts[0];
  if (!post) {
    throw new SocialPublishingError(
      "Social content set has no publishable post",
      409,
      "SOCIAL_POST_NOT_READY",
    );
  }
  const requestedPlatforms = new Set(
    input.platforms?.length
      ? input.platforms
      : (run.requestedPlatforms.filter((value): value is SocialPlatform =>
          SUPPORTED_PLATFORMS.includes(value as SocialPlatform),
        )),
  );
  const accounts = await prisma.socialPublisherAccount.findMany({
    where: {
      businessId: input.businessId,
      platform: { in: [...requestedPlatforms] },
      isActive: true,
      isDefault: true,
    },
  });
  const accountByPlatform = new Map(accounts.map((account) => [account.platform, account]));
  const missing = [...requestedPlatforms].filter(
    (platform) => !accountByPlatform.has(platform),
  );
  if (missing.length > 0) {
    throw new SocialPublishingError(
      `Connect a default ${missing.join(", ")} account before publishing`,
      409,
      "SOCIAL_ACCOUNTS_REQUIRED",
    );
  }

  const attempts = [];
  for (const platform of requestedPlatforms) {
    const account = accountByPlatform.get(platform)!;
    const platformAssets = run.posts
      .flatMap((candidatePost) => candidatePost.assets)
      .filter(
        (candidate) =>
          candidate.platform === platform && candidate.status === "COMPLETE",
      )
      .sort((left, right) => left.slideIndex - right.slideIndex);
    const carouselMedia =
      run.kind === "carousel" && ["instagram", "facebook", "linkedin"].includes(platform)
        ? platformAssets
        : platformAssets.slice(0, 1);
    const slots = input.automatic
      ? resolveAutomaticSocialPublishSlots({
          platform,
          topicScheduledFor: input.automatic.topicScheduledFor,
          timeZone: input.timezone,
        })
      : [
          {
            id: "primary" as const,
            scheduledFor: input.scheduledFor ?? new Date(0),
            mediaMode: "image" as const,
          },
        ];
    for (const slot of slots) {
      const attemptMode: PublishMode = input.automatic
        ? slot.scheduledFor.getTime() > input.automatic.now.getTime() + 60_000
          ? "SCHEDULE"
          : "NOW"
        : input.mode;
      const copy =
        normalizedPlatformVariantCopy(run.contentPlan, platform, slot.id) ??
        normalizedPlatformCopy(run.contentPlan, platform) ?? {
          caption: captionWithoutHashtags(post.caption),
          hashtags: [],
        };
      const caption = assertSafePublishedCaption(formatPublishedCaption(copy));
      const mediaResolvers: Record<
        SocialMediaMode,
        () => {
          assetId: string | null;
          mediaUrl: string | null;
          items: Array<{ assetId: string; mediaUrl: string }>;
        }
      > = {
        none: () => ({ assetId: null, mediaUrl: null, items: [] }),
        image: () => {
          const items = carouselMedia.flatMap((asset) =>
            asset.imageUrl
              ? [
                  {
                    assetId: asset.id,
                    mediaUrl: assertPublicMediaUrl(asset.imageUrl),
                  },
                ]
              : [],
          );
          if (items.length !== carouselMedia.length || items.length === 0) {
            throw new SocialPublishingError(
              `${platform} image is not ready to publish`,
              409,
              "SOCIAL_ASSET_NOT_READY",
            );
          }
          return {
            assetId: items[0]!.assetId,
            mediaUrl: items[0]!.mediaUrl,
            items,
          };
        },
      };
      const media = mediaResolvers[slot.mediaMode]();
      const scheduledFor = attemptMode === "SCHEDULE" ? slot.scheduledFor : null;
      const scheduleKey = scheduledFor?.toISOString() ?? "now";
      const contentHash = createHash("sha256")
        .update(
          [
            platform,
            slot.id,
            account.externalAccountId,
            caption,
            ...media.items.map((item) => item.mediaUrl),
            scheduleKey,
          ].join("\n"),
        )
        .digest("hex");
      const idempotencyKey =
        run.kind === "carousel" && media.items.length > 1
          ? `zernio:${run.id}:${platform}:${slot.id}:${account.id}:carousel-v1`
          : input.automatic && platform === "x"
          ? `zernio:${run.id}:x:${slot.id}:${account.id}:v1`
          : input.automatic
          ? `zernio:${run.id}:${platform}:${slot.id}:${account.id}:auto-v1`
          : `zernio:${media.assetId}:${account.id}:${attemptMode}:${scheduleKey}`;
      // A ready-content scan revisits the same run when its scheduled time
      // becomes due. Older releases encoded SCHEDULE/NOW in the key, which
      // created a second provider post at that boundary. Adopt any existing
      // attempt by its exact legacy keys before creating the new stable
      // automatic key so already-scheduled posts remain singletons during
      // rollout as well as after it.
      const existingDueAttempt =
        input.automatic && attemptMode === "NOW"
          ? await prisma.socialPublishAttempt.findFirst({
              where: {
                idempotencyKey: {
                  in: [
                    `zernio:${media.assetId}:${account.id}:SCHEDULE:${slot.scheduledFor.toISOString()}`,
                    `zernio:${media.assetId}:${account.id}:NOW:now`,
                  ],
                },
              },
              orderBy: { createdAt: "asc" },
            })
          : null;
      const attempt = existingDueAttempt
        ? existingDueAttempt
        : await prisma.socialPublishAttempt.upsert({
            where: { idempotencyKey },
            update: {},
            create: {
              idempotencyKey,
              requestId: randomUUID(),
              businessId: input.businessId,
              runId: run.id,
              assetId: media.assetId,
              publisherAccountId: account.id,
              platform,
              mode: attemptMode,
              scheduledFor,
              timezone: input.timezone,
              caption,
              hashtags: [],
              mediaUrl: media.mediaUrl,
              contentHash,
            },
          });
      if (media.items.length > 0) {
        await prisma.socialPublishAttemptMedia.createMany({
          data: media.items.map((item, position) => ({
            attemptId: attempt.id,
            assetId: item.assetId,
            position,
            mediaUrl: item.mediaUrl,
          })),
          skipDuplicates: true,
        });
      }
      attempts.push(attempt);
    }
  }
  return attempts;
}

export type AutomaticSocialPublishingResult = {
  runId: string;
  businessId: string | null;
  status:
    | "prepared"
    | "run_not_found"
    | "run_not_complete"
    | "not_calendar_content"
    | "approval_required"
    | "no_scheduled_platforms"
    | "no_connected_accounts";
  mode: PublishMode | "MIXED" | null;
  platforms: SocialPlatform[];
  attemptIds: string[];
};

/**
 * Prepare idempotent provider submissions for a completed calendar content set.
 * Only platforms with an active default account are included. Other platform
 * creatives remain generated in Uplift and can be published after connection.
 */
export async function prepareAutomaticSocialPublishing(
  runId: string,
  prisma: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<AutomaticSocialPublishingResult> {
  const run = await prisma.socialCreativeRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      userId: true,
      businessId: true,
      status: true,
      requestedPlatforms: true,
      socialTopicPlan: {
        select: { scheduledFor: true, timezone: true },
      },
      business: {
        select: {
          socialAutomationSettings: {
            select: { approvalRequired: true },
          },
        },
      },
    },
  });
  const base = {
    runId,
    businessId: run?.businessId ?? null,
    mode: null,
    platforms: [] as SocialPlatform[],
    attemptIds: [] as string[],
  };
  if (!run) return { ...base, status: "run_not_found" };
  if (run.status !== "COMPLETE") {
    return { ...base, status: "run_not_complete" };
  }
  if (!run.socialTopicPlan) {
    return { ...base, status: "not_calendar_content" };
  }
  if (run.business.socialAutomationSettings?.approvalRequired === true) {
    return { ...base, status: "approval_required" };
  }

  const requestedPlatforms = run.requestedPlatforms.filter(
    (platform): platform is SocialPlatform =>
      SUPPORTED_PLATFORMS.includes(platform as SocialPlatform),
  );
  const connectedAccounts = await prisma.socialPublisherAccount.findMany({
    where: {
      businessId: run.businessId,
      platform: { in: requestedPlatforms },
      isActive: true,
      isDefault: true,
    },
    select: { platform: true },
  });
  const connectedPlatforms = new Set(
    connectedAccounts.map((account) => account.platform),
  );
  const connectedRequestedPlatforms = requestedPlatforms.filter((platform) =>
    connectedPlatforms.has(platform),
  );
  if (connectedRequestedPlatforms.length === 0) {
    return { ...base, status: "no_connected_accounts" };
  }

  const platforms = resolveSocialTopicPublishPlatforms({
    platforms: connectedRequestedPlatforms,
    topicScheduledFor: run.socialTopicPlan.scheduledFor,
    timeZone: run.socialTopicPlan.timezone,
  });
  if (platforms.length === 0) {
    return { ...base, status: "no_scheduled_platforms" };
  }

  // Providers reject schedules that are already due or only seconds away.
  // Those posts should publish immediately instead of failing validation.
  const scheduledFor = run.socialTopicPlan.scheduledFor;
  const mode: PublishMode =
    scheduledFor.getTime() > now.getTime() + 60_000 ? "SCHEDULE" : "NOW";
  const attempts = await createSocialPublishAttempts(
    {
      userId: run.userId,
      businessId: run.businessId,
      runId: run.id,
      mode,
      scheduledFor: mode === "SCHEDULE" ? scheduledFor : null,
      timezone: run.socialTopicPlan.timezone,
      platforms,
      automatic: { topicScheduledFor: scheduledFor, now },
    },
    prisma,
  );
  return {
    runId,
    businessId: run.businessId,
    status: "prepared",
    mode:
      new Set(attempts.map((attempt) => attempt.mode)).size > 1
        ? "MIXED"
        : ((attempts[0]?.mode as PublishMode | undefined) ?? mode),
    platforms,
    attemptIds: attempts
      .filter((attempt) => attempt.status === "PENDING")
      .map((attempt) => attempt.id),
  };
}

function externalPostUrl(post: ZernioPost): string | null {
  const platformUrl = post.platforms?.find((platform) => platform.platformPostUrl)
    ?.platformPostUrl;
  return cleanOptionalString(platformUrl ?? post.platformPostUrl, 1_000);
}

function mappedPostStatus(post: ZernioPost, mode: PublishMode): string {
  const providerStatus = post.status?.toLowerCase();
  if (providerStatus === "published") return "PUBLISHED";
  if (providerStatus === "failed") return "FAILED";
  if (providerStatus === "cancelled" || providerStatus === "canceled") return "CANCELLED";
  return mode === "SCHEDULE" ? "SCHEDULED" : "SUBMITTING";
}

export async function submitSocialPublishAttempt(
  attemptId: string,
  prisma: PrismaClient = defaultPrisma,
  client = new ZernioClient(),
) {
  const claimed = await prisma.socialPublishAttempt.updateMany({
    where: { id: attemptId, status: { in: ["PENDING", "FAILED"] } },
    data: {
      status: "SUBMITTING",
      attemptCount: { increment: 1 },
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  const attempt = await prisma.socialPublishAttempt.findUnique({
    where: { id: attemptId },
    include: {
      publisherAccount: true,
      run: { select: { topic: true } },
      mediaItems: { orderBy: { position: "asc" } },
    },
  });
  if (!attempt) throw new Error("Social publish attempt not found");
  if (claimed.count === 0 && !["SUBMITTING"].includes(attempt.status)) return attempt;

  try {
    if (!attempt.publisherAccount.isActive) {
      throw new SocialPublishingError(
        "The connected social account is no longer active",
        409,
        "SOCIAL_ACCOUNT_DISCONNECTED",
      );
    }
    const publicCaption = assertSafePublishedCaption(attempt.caption);
    const post = await client.createPost(
      {
        title: attempt.run.topic.slice(0, 160),
        content: publicCaption,
        mediaUrl: attempt.mediaUrl,
        mediaUrls: attempt.mediaItems.map((item) => item.mediaUrl),
        platform:
          UPLIFT_TO_ZERNIO_PLATFORM[attempt.platform as UpliftSocialPlatform],
        accountId: attempt.publisherAccount.externalAccountId,
        publishNow: attempt.mode === "NOW",
        scheduledFor: attempt.scheduledFor?.toISOString(),
        timezone: attempt.timezone,
        metadata: Object.fromEntries(
          [
            ["upliftBusinessId", attempt.businessId],
            ["upliftRunId", attempt.runId],
            ["upliftAssetId", attempt.assetId],
            ["upliftAttemptId", attempt.id],
          ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      },
      attempt.requestId,
    );
    const status = mappedPostStatus(post, attempt.mode as PublishMode);
    return await prisma.socialPublishAttempt.update({
      where: { id: attempt.id },
      data: {
        caption: publicCaption,
        status,
        externalPostId: post._id,
        externalStatus: cleanOptionalString(post.status, 120),
        externalPostUrl: externalPostUrl(post),
        submittedAt: new Date(),
        publishedAt: status === "PUBLISHED" ? new Date() : null,
      },
    });
  } catch (error) {
    await prisma.socialPublishAttempt.updateMany({
      where: { id: attempt.id, status: "SUBMITTING" },
      data: {
        status: "FAILED",
        lastErrorCode:
          error instanceof ZernioApiError || error instanceof SocialPublishingError
            ? error.code
            : "SOCIAL_PUBLISH_FAILED",
        lastErrorMessage:
          error instanceof Error ? error.message.slice(0, 500) : "Publishing failed",
      },
    });
    throw error;
  }
}

export async function listRunPublishAttempts(
  input: { userId: string; runId: string },
  prisma: PrismaClient = defaultPrisma,
) {
  const run = await prisma.socialCreativeRun.findFirst({
    where: { id: input.runId, userId: input.userId },
    select: { id: true },
  });
  if (!run) {
    throw new SocialPublishingError(
      "Social content set not found",
      404,
      "SOCIAL_RUN_NOT_FOUND",
    );
  }
  return prisma.socialPublishAttempt.findMany({
    where: { runId: input.runId },
    include: {
      publisherAccount: {
        select: { platform: true, displayName: true, username: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function reconcileActiveSocialPublishAttempts(
  input: { userId: string; runId: string },
  prisma: PrismaClient = defaultPrisma,
  client?: Pick<ZernioClient, "getPost">,
) {
  const attempts = await prisma.socialPublishAttempt.findMany({
    where: {
      runId: input.runId,
      status: "SUBMITTING",
      externalPostId: { not: null },
      run: { userId: input.userId },
    },
    select: {
      id: true,
      externalPostId: true,
      mode: true,
      publisherAccountId: true,
    },
    take: 10,
  });

  // Reading publishing status must remain available when the provider is not
  // configured (for example, during local onboarding). Constructing the
  // client eagerly would throw before we knew whether any remote status needed
  // reconciliation, turning an otherwise valid empty status into a 503.
  if (attempts.length === 0) return;

  let providerClient: Pick<ZernioClient, "getPost">;
  try {
    providerClient = client ?? new ZernioClient();
  } catch (error) {
    console.warn(
      "[social-publishing] Skipping provider reconciliation",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  for (const attempt of attempts) {
    if (!attempt.externalPostId) continue;
    try {
      const post = await providerClient.getPost(attempt.externalPostId);
      const status = mappedPostStatus(post, attempt.mode as PublishMode);
      const failure =
        status === "FAILED" ? zernioPostFailureDetails(post) : null;
      await prisma.socialPublishAttempt.updateMany({
        where: { id: attempt.id, status: "SUBMITTING" },
        data: {
          status,
          externalStatus: cleanOptionalString(post.status, 120),
          externalPostUrl: externalPostUrl(post),
          publishedAt: status === "PUBLISHED" ? new Date() : undefined,
          lastErrorCode:
            status === "PUBLISHED"
              ? null
              : status === "FAILED"
                ? failure?.code ?? "ZERNIO_POST_FAILED"
                : undefined,
          lastErrorMessage:
            status === "PUBLISHED"
              ? null
              : status === "FAILED"
                ? failure?.message ?? "Zernio could not publish this post"
                : undefined,
        },
      });
      if (failure?.reconnectRequired) {
        await deactivateZernioAccountForReconnect(
          attempt.publisherAccountId,
          prisma,
        );
      }
    } catch (error) {
      console.warn(
        `[social-publishing] Could not reconcile active attempt ${attempt.id}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
