import type { PrismaClient } from "@prisma/client";
import { NonRetriableError, type Inngest } from "inngest";

import { prisma } from "../config/db.config";
import {
  isSocialCreativeAutoPublishEnabled,
  isSocialCreativeGenerationEnabled,
} from "../services/social-creative/constants";
import { normalizeSocialPlatforms } from "../services/social-creative/formats";
import {
  estimateSocialCreativeImageBudget,
  finalizeSocialCreativeRun,
  planSocialCreativeRun,
  renderSocialCreativeAsset,
  SOCIAL_CREATIVE_RENDER_LEASE_MS,
  SocialCreativePipelineError,
} from "../services/social-creative/pipeline";
import { createOrGetSocialCreativeRun } from "../services/social-creative/repository";
import { generateAndPersistSocialTopicPlan } from "../services/social-topic-planner.service";
import {
  markInitialSocialTopicPlanFailed,
  markInitialSocialTopicPlanQueued,
  markInitialSocialTopicPlanStarted,
} from "../services/social-topic-initialization.service";
import { checkSiteFeatureAccess } from "../services/website-plan-entitlement.service";
import {
  resolveSocialTopicImagePlatforms,
  resolveSocialTopicPublishPlatforms,
} from "../utils/social-platform-schedule.utils";
import {
  failIncompleteSocialCreativeAsset,
  failSocialCreativeRun,
} from "../services/social-creative/repository";
import { prepareAutomaticSocialPublishing } from "../services/zernio/social-publishing.service";
import {
  assignWeeklySocialCarousels,
  claimSocialCarouselRun,
  socialCreativeKindForTopic,
} from "../services/social-carousel-scheduling.service";

function globalImageConcurrency(): number {
  const parsed = Number(process.env.SOCIAL_CREATIVE_IMAGE_CONCURRENCY ?? 4);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : 4;
}

function perBusinessImageConcurrency(): number {
  const globalLimit = globalImageConcurrency();
  const parsed = Number(
    process.env.SOCIAL_CREATIVE_IMAGE_PER_BUSINESS_CONCURRENCY ?? globalLimit,
  );
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, globalLimit, 20)
    : globalLimit;
}

function retryTransientProviderErrorOrStop(error: unknown): never {
  if (error instanceof NonRetriableError) throw error;
  if (error instanceof SocialCreativePipelineError && error.retryable) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new NonRetriableError(message, { cause: error });
}

function isTransientProviderError(error: unknown): boolean {
  return error instanceof SocialCreativePipelineError && error.retryable;
}

export function shouldRetryScheduledSocialTopic(
  attempt: number,
  maxRetries = 1,
): boolean {
  return attempt < maxRetries;
}

type SocialCreativeInngestDependencies = {
  prisma?: PrismaClient;
  generationEnabled?: typeof isSocialCreativeGenerationEnabled;
  autoPublishEnabled?: typeof isSocialCreativeAutoPublishEnabled;
  plan?: typeof planSocialCreativeRun;
  render?: typeof renderSocialCreativeAsset;
  finalize?: typeof finalizeSocialCreativeRun;
  prepareAutoPublish?: typeof prepareAutomaticSocialPublishing;
  failRun?: typeof failSocialCreativeRun;
  failAsset?: typeof failIncompleteSocialCreativeAsset;
};

export function createSocialCreativeInngestFunctions(
  inngest: Inngest,
  dependencies: SocialCreativeInngestDependencies = {},
) {
  const db = dependencies.prisma ?? prisma;
  const generationEnabled =
    dependencies.generationEnabled ?? isSocialCreativeGenerationEnabled;
  const autoPublishEnabled =
    dependencies.autoPublishEnabled ?? isSocialCreativeAutoPublishEnabled;
  const plan = dependencies.plan ?? planSocialCreativeRun;
  const render = dependencies.render ?? renderSocialCreativeAsset;
  const finalize = dependencies.finalize ?? finalizeSocialCreativeRun;
  const prepareAutoPublish =
    dependencies.prepareAutoPublish ?? prepareAutomaticSocialPublishing;
  const failRun = dependencies.failRun ?? failSocialCreativeRun;
  const failAsset = dependencies.failAsset ?? failIncompleteSocialCreativeAsset;
  const requestTask = inngest.createFunction(
    {
      id: "social-creative-plan-and-dispatch",
      name: "Social Creative Plan and Dispatch",
      retries: 2,
      triggers: { event: "social/creative.requested" },
      singleton: { key: "event.data.runId", mode: "skip" },
      concurrency: { limit: 1, key: "event.data.businessId" },
    },
    async ({ event, step }) => {
      const runId = String(event.data.runId);
      if (!generationEnabled()) {
        try {
          await step.run("mark-social-creative-disabled", () =>
            failRun(
              {
                runId,
                code: "SOCIAL_CREATIVE_GENERATION_DISABLED",
                stage: "kill-switch",
                error: new Error("Social creative generation is disabled"),
              },
              db,
            ),
          );
        } catch (error) {
          retryTransientProviderErrorOrStop(error);
        }
        return { runId, skipped: true, reason: "generation_disabled" };
      }
      let planned: Awaited<ReturnType<typeof planSocialCreativeRun>>;
      try {
        planned = await step.run("plan-social-creative", () =>
          plan(runId, { prisma: db }),
        );
      } catch (error) {
        retryTransientProviderErrorOrStop(error);
      }
      const requestEventId = String(event.id);
      await step.sendEvent(
        "dispatch-social-creative-assets",
        planned.assetIds.map((assetId) => ({
          // Keep step replays idempotent for the same request while allowing
          // a later retry request to redispatch an existing failed asset.
          id: `social-creative-asset:${assetId}:${requestEventId}`,
          name: "social/creative.asset.requested",
          data: { assetId, runId, businessId: String(event.data.businessId) },
        })),
      );
      // Finalization is also requested immediately. Runs with assets remain in
      // RENDERING until their completion events arrive; text-only runs can
      // complete without waiting for an image event that will never exist.
      await step.sendEvent("request-social-creative-finalization", {
        name: "social/creative.finalize",
        data: { runId },
      });
      return { runId, dispatched: planned.assetIds.length, planned: planned.planned };
    },
  );

  const assetTask = inngest.createFunction(
    {
      id: "social-creative-render-asset",
      name: "Social Creative Render Asset",
      retries: 2,
      triggers: { event: "social/creative.asset.requested" },
      singleton: { key: "event.data.assetId", mode: "skip" },
      concurrency: [
        { limit: globalImageConcurrency() },
        {
          limit: perBusinessImageConcurrency(),
          key: "event.data.businessId",
        },
      ],
      timeouts: { finish: "12m" },
    },
    async ({ event, step, attempt = 0 }) => {
      const assetId = String(event.data.assetId);
      const runId = String(event.data.runId);
      if (!generationEnabled()) {
        const disabledError = new Error("Social creative generation is disabled");
        try {
          await step.run("mark-social-creative-asset-disabled", () =>
            failAsset(
              {
                assetId,
                code: "SOCIAL_CREATIVE_GENERATION_DISABLED",
                stage: "kill-switch",
                error: disabledError,
              },
              db,
            ),
          );
          await step.sendEvent("signal-social-creative-asset-disabled", {
            name: "social/creative.asset.completed",
            data: { assetId, runId, success: false },
          });
        } catch (error) {
          retryTransientProviderErrorOrStop(error);
        }
        return { assetId, runId, skipped: true, reason: "generation_disabled" };
      }
      try {
        const rendered = await step.run("render-social-creative-asset", () =>
          render(assetId, { prisma: db }),
        );
        if (rendered.state === "in_progress") {
          // A valid render lease is already owned by another invocation. Do
          // not hold this HTTP request open while polling: nginx or the app
          // process can disappear before the SDK returns a step result. The
          // winning worker emits completion; if it dies, the lease recovery
          // cron redispatches the asset with a lease-specific event id.
          return {
            assetId,
            runId,
            state: "in_progress" as const,
            deferred: true,
          };
        }
        await step.sendEvent("signal-social-creative-asset-complete", {
          name: "social/creative.asset.completed",
          data: { assetId, runId, success: true },
        });
        return rendered;
      } catch (error) {
        if (!isTransientProviderError(error) || attempt >= 2) {
          await step.sendEvent("signal-social-creative-asset-failed", {
            name: "social/creative.asset.completed",
            data: { assetId, runId, success: false },
          });
        }
        retryTransientProviderErrorOrStop(error);
      }
    },
  );

  const completionTask = inngest.createFunction(
    {
      id: "social-creative-asset-completion",
      name: "Social Creative Asset Completion",
      retries: 1,
      triggers: { event: "social/creative.asset.completed" },
    },
    async ({ event, step }) => {
      const runId = String(event.data.runId);
      await step.sendEvent("request-social-creative-finalization", {
        name: "social/creative.finalize",
        data: { runId },
      });
      return { runId, assetId: event.data.assetId, success: event.data.success };
    },
  );

  const finalizeTask = inngest.createFunction(
    {
      id: "social-creative-finalize",
      name: "Social Creative Finalize",
      retries: 2,
      triggers: { event: "social/creative.finalize" },
      concurrency: { limit: 1, key: "event.data.runId" },
    },
    async ({ event, step }) => {
      const runId = String(event.data.runId);
      const result = await step.run("finalize-social-creative-run", () =>
        finalize(runId, db),
      );
      if (result.status !== "COMPLETE") return result;

      const automaticPublishing = autoPublishEnabled()
        ? await step.run("prepare-automatic-social-publishing", () =>
            prepareAutoPublish(runId, db),
          )
        : {
            runId,
            businessId: null,
            status: "auto_publish_disabled" as const,
            mode: null,
            platforms: [],
            attemptIds: [],
          };
      if (automaticPublishing.attemptIds.length > 0) {
        await step.sendEvent(
          "dispatch-automatic-social-publishing",
          automaticPublishing.attemptIds.map((attemptId) => ({
            id: `social-auto-publish:${attemptId}`,
            name: "social/publish.requested" as const,
            data: {
              attemptId,
              businessId: automaticPublishing.businessId!,
              runId,
            },
          })),
        );
      }
      if (automaticPublishing.status === "approval_required") {
        await step.sendEvent("notify-social-content-ready-for-approval", {
          id: `approval-ready-social:${runId}`,
          name: "content/approval-ready" as const,
          data: { kind: "social" as const, contentId: runId },
        });
      }
      return {
        ...result,
        automaticPublishing: {
          status: automaticPublishing.status,
          mode: automaticPublishing.mode,
          platforms: automaticPublishing.platforms,
          queued: automaticPublishing.attemptIds.length,
        },
      };
    },
  );

  const topicPlannerTask = inngest.createFunction(
    {
      id: "social-topic-plan-generate",
      name: "Generate Social Topic Plan",
      retries: 2,
      triggers: { event: "social/topics.plan.requested" },
      singleton: { key: "event.data.businessId", mode: "skip" },
      concurrency: { limit: 1, key: "event.data.businessId" },
    },
    async ({ event, step, attempt = 0 }) => {
      const businessId = String(event.data.businessId);
      const userId = String(event.data.userId);
      const source = event.data.source === "ROLLING" ? "ROLLING" : "INITIAL";
      if (!generationEnabled()) {
        if (source === "INITIAL") {
          await step.run("mark-disabled-initial-social-plan", () =>
            markInitialSocialTopicPlanFailed(
              db,
              businessId,
              new Error("Social generation is disabled"),
            ),
          );
        }
        return { skipped: true, reason: "social_generation_disabled" };
      }
      const access = await step.run("check-social-topic-entitlement", () =>
        checkSiteFeatureAccess(businessId, "social_generation"),
      );
      if (!access.hasAccess) {
        if (source === "INITIAL") {
          await step.run("mark-inactive-initial-social-plan", () =>
            markInitialSocialTopicPlanFailed(
              db,
              businessId,
              new Error(access.message || "Social entitlement inactive"),
            ),
          );
        }
        return { skipped: true, reason: "social_entitlement_inactive" };
      }
      if (source === "INITIAL") {
        await step.run(`mark-initial-social-plan-started-${attempt}`, () =>
          markInitialSocialTopicPlanStarted(db, businessId),
        );
      }
      try {
        const result = await step.run("generate-social-topic-plan", () =>
          generateAndPersistSocialTopicPlan({
            businessId,
            userId,
            source,
            prisma: db,
          }),
        );
        const carousels = await step.run("assign-weekly-social-carousels", () =>
          assignWeeklySocialCarousels({
            businessId,
            userId,
            prisma: db,
          }),
        );
        await step.sendEvent("scan-new-social-topic-plan", {
          name: "social/topics.scan.requested",
          data: { businessId },
        });
        return { ...result, carousels };
      } catch (error) {
        if (source === "INITIAL") {
          await step.run(`record-initial-social-plan-error-${attempt}`, () =>
            attempt >= 2
              ? markInitialSocialTopicPlanFailed(db, businessId, error)
              : markInitialSocialTopicPlanQueued(db, businessId),
          );
        }
        throw error;
      }
    },
  );

  const rollingTopicPlannerTask = inngest.createFunction(
    {
      id: "social-topic-plan-rolling-scheduler",
      name: "Refresh Social Topic Plans",
      retries: 1,
      triggers: { cron: "30 3 * * *" },
      concurrency: { limit: 1 },
    },
    async ({ step }) => {
      if (!generationEnabled()) {
        return { skipped: true, reason: "social_generation_disabled" };
      }
      const now = new Date();
      const staleInitializationBefore = new Date(
        now.getTime() - 30 * 60 * 1_000,
      );
      const dueSettings = await step.run("load-due-social-planners", () =>
          db.socialAutomationSettings.findMany({
            where: {
              enabled: true,
              nextPlanningAt: { lte: now },
              business: {
                isActive: true,
                websiteSubscription: { is: { planTier: "SEO_SOCIAL" } },
              },
            },
            select: {
              businessId: true,
              business: { select: { userId: true } },
            },
            take: 100,
          }),
        );
      const uninitializedBusinesses = await step.run(
        "load-uninitialized-social-planners",
        () =>
          db.business.findMany({
            where: {
              isActive: true,
              websiteSubscription: { is: { planTier: "SEO_SOCIAL" } },
              OR: [
                { socialAutomationSettings: null },
                {
                  socialAutomationSettings: {
                    is: {
                      initialPlanGeneratedAt: null,
                      initialPlanStatus: { in: ["not_started", "failed"] },
                    },
                  },
                },
                {
                  socialAutomationSettings: {
                    is: {
                      initialPlanGeneratedAt: null,
                      initialPlanStatus: { in: ["queued", "planning"] },
                      updatedAt: { lte: staleInitializationBefore },
                    },
                  },
                },
              ],
            },
            select: { id: true, userId: true },
            take: 100,
          }),
      );

      if (dueSettings.length > 0 || uninitializedBusinesses.length > 0) {
        await step.sendEvent(
          "request-rolling-social-topic-plans",
          [
            ...dueSettings.map((settings) => ({
              name: "social/topics.plan.requested",
              data: {
                userId: settings.business.userId,
                businessId: settings.businessId,
                source: "ROLLING",
              },
            })),
            ...uninitializedBusinesses.map((business) => ({
              name: "social/topics.plan.requested",
              data: {
                userId: business.userId,
                businessId: business.id,
                source: "INITIAL",
              },
            })),
          ],
        );
      }

      return {
        requested: dueSettings.length + uninitializedBusinesses.length,
        initial: uninitializedBusinesses.length,
        rolling: dueSettings.length,
      };
    },
  );

  const scheduledTopicScannerTask = inngest.createFunction(
    {
      id: "social-daily-generation-scheduler",
      name: "Schedule Due Social Content",
      retries: 1,
      triggers: [
        { cron: "15 * * * *" },
        { event: "social/topics.scan.requested" },
      ],
      concurrency: { limit: 1 },
    },
    async ({ event, step, attempt = 0 }) => {
      if (!generationEnabled()) {
        return { skipped: true, reason: "social_generation_disabled" };
      }
      const now = new Date();
      const eventData = event.data as { businessId?: unknown };
      const requestedBusinessId =
        typeof eventData.businessId === "string" && eventData.businessId
          ? eventData.businessId
          : null;
      // A freshly unlocked plan begins in the next business-local morning.
      // Give the event-driven scan a 48-hour window so every global timezone
      // can enqueue its first creative; hourly scans stay at 24h.
      const horizon = new Date(
        now.getTime() + (requestedBusinessId ? 48 : 24) * 60 * 60 * 1_000,
      );
      const parsedLimit = Number(process.env.SOCIAL_SCHEDULER_MAX_PER_RUN ?? 50);
      const limit = Number.isInteger(parsedLimit)
        ? Math.min(250, Math.max(1, parsedLimit))
        : 50;
      const candidates = await step.run("load-due-social-topics", () =>
        db.socialTopicPlan.findMany({
          where: {
            ...(requestedBusinessId
              ? { businessId: requestedBusinessId }
              : {}),
            status: "PLANNED",
            scheduledFor: { lte: horizon },
            business: {
              isActive: true,
              socialAutomationSettings: { is: { enabled: true } },
              websiteSubscription: { is: { planTier: "SEO_SOCIAL" } },
            },
          },
          orderBy: { scheduledFor: "asc" },
          take: limit,
          include: {
            carouselWeekAssignment: { select: { status: true } },
            business: {
              select: {
                socialAutomationSettings: {
                  select: { carouselEnabled: true },
                },
              },
            },
          },
        }),
      );
      const results: Array<{
        topicPlanId: string;
        status:
          | "queued"
          | "already_ready"
          | "no_access"
          | "not_claimed"
          | "skipped_schedule"
          | "failed";
        runId?: string;
      }> = [];

      for (const topicPlan of candidates) {
        const configuredPlatforms = normalizeSocialPlatforms(topicPlan.platforms);
        const platforms = resolveSocialTopicPublishPlatforms({
          platforms: configuredPlatforms,
          topicScheduledFor: new Date(topicPlan.scheduledFor),
          timeZone: topicPlan.timezone,
        });
        if (platforms.length === 0) {
          const skipped = await step.run(`skip-off-day-${topicPlan.id}`, () =>
            db.socialTopicPlan.updateMany({
              where: { id: topicPlan.id, status: "PLANNED" },
              data: { status: "SKIPPED" },
            }),
          );
          results.push({
            topicPlanId: topicPlan.id,
            status: skipped.count === 1 ? "skipped_schedule" : "not_claimed",
          });
          continue;
        }
        const access = await step.run(`check-access-${topicPlan.id}`, () =>
          checkSiteFeatureAccess(topicPlan.businessId, "social_generation"),
        );
        if (!access.hasAccess) {
          results.push({ topicPlanId: topicPlan.id, status: "no_access" });
          continue;
        }
        const claimed = await step.run(`claim-topic-${topicPlan.id}`, () =>
          db.socialTopicPlan.updateMany({
            where: { id: topicPlan.id, status: "PLANNED" },
            data: { status: "CLAIMED", claimedAt: now },
          }),
        );
        if (claimed.count !== 1) {
          results.push({ topicPlanId: topicPlan.id, status: "not_claimed" });
          continue;
        }

        try {
          const kind = socialCreativeKindForTopic({
            carouselEnabled:
              topicPlan.business.socialAutomationSettings?.carouselEnabled,
            carouselAssignmentStatus:
              topicPlan.carouselWeekAssignment?.status,
          });
          const imagePlatforms = resolveSocialTopicImagePlatforms({
            platforms,
            topicScheduledFor: new Date(topicPlan.scheduledFor),
            timeZone: topicPlan.timezone,
          });
          const run = await step.run(`create-run-${topicPlan.id}`, () =>
            createOrGetSocialCreativeRun(
              {
                userId: topicPlan.userId,
                businessId: topicPlan.businessId,
                topic: topicPlan.topic,
                kind,
                source: "SCHEDULE",
                sourceBlogId: null,
                sourcePlanId: topicPlan.sourceSeoPlanId,
                socialTopicPlanId: topicPlan.id,
                platforms,
                idempotencyKey:
                  kind === "carousel"
                    ? `social-topic-run:${topicPlan.id}:carousel-v1`
                    : `social-topic-run:${topicPlan.id}:v1`,
                estimatedBudgetUsd: estimateSocialCreativeImageBudget({
                  kind,
                  platforms: imagePlatforms,
                }),
              },
              db,
            ),
          );
          if (kind === "carousel") {
            await step.run(`claim-carousel-run-${topicPlan.id}`, () =>
              claimSocialCarouselRun({
                topicPlanId: topicPlan.id,
                runId: run.id,
                prisma: db,
              }),
            );
          }
          if (run.status === "COMPLETE") {
            await step.run(`mark-ready-${topicPlan.id}`, () =>
              db.socialTopicPlan.update({
                where: { id: topicPlan.id },
                data: { status: "READY", generatedAt: run.completedAt ?? now },
              }),
            );
            results.push({
              topicPlanId: topicPlan.id,
              status: "already_ready",
              runId: run.id,
            });
            continue;
          }
          await step.run(`mark-generating-${topicPlan.id}`, () =>
            db.socialTopicPlan.update({
              where: { id: topicPlan.id },
              data: {
                status: "GENERATING",
                failureCode: null,
                failureMessage: null,
              },
            }),
          );
          await step.sendEvent(`dispatch-run-${topicPlan.id}`, {
            name: "social/creative.requested",
            data: { runId: run.id, businessId: run.businessId },
          });
          results.push({
            topicPlanId: topicPlan.id,
            status: "queued",
            runId: run.id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retry = shouldRetryScheduledSocialTopic(attempt);
          await step.run(
            `${retry ? "retry" : "fail"}-topic-${topicPlan.id}`,
            () =>
              db.socialTopicPlan.update({
                where: { id: topicPlan.id },
                data: {
                  status: retry ? "PLANNED" : "FAILED",
                  claimedAt: retry ? null : topicPlan.claimedAt,
                  failureCode: "SOCIAL_TOPIC_DISPATCH_FAILED",
                  failureMessage: message.slice(0, 2_000),
                },
              }),
          );
          if (retry) throw error;
          results.push({ topicPlanId: topicPlan.id, status: "failed" });
        }
      }

      return {
        scanned: candidates.length,
        queued: results.filter((result) => result.status === "queued").length,
        results,
      };
    },
  );

  const weeklyCarouselAssignmentTask = inngest.createFunction(
    {
      id: "social-weekly-carousel-assignment",
      name: "Assign Weekly Social Carousels",
      retries: 2,
      triggers: [
        { cron: "45 3 * * *" },
        { event: "social/carousels.assign.requested" },
      ],
      concurrency: { limit: 1, key: "event.data.businessId || 'daily'" },
    },
    async ({ event, step }) => {
      if (!generationEnabled()) {
        return { skipped: true, reason: "social_generation_disabled" };
      }
      const requestedBusinessId =
        "businessId" in event.data &&
        typeof event.data.businessId === "string" &&
        event.data.businessId
          ? event.data.businessId
          : null;
      const now = new Date();
      const businesses = await step.run("load-carousel-assignment-businesses", () =>
        db.business.findMany({
          where: {
            ...(requestedBusinessId ? { id: requestedBusinessId } : {}),
            isActive: true,
            websiteSubscription: { is: { planTier: "SEO_SOCIAL" } },
            socialAutomationSettings: {
              is: { enabled: true, carouselEnabled: true },
            },
            socialTopicPlans: {
              some: { status: "PLANNED", scheduledFor: { gte: now } },
            },
          },
          select: { id: true, userId: true },
          take: requestedBusinessId ? 1 : 100,
        }),
      );
      const results = [];
      for (const business of businesses) {
        const result = await step.run(`assign-carousels-${business.id}`, () =>
          assignWeeklySocialCarousels({
            businessId: business.id,
            userId: business.userId,
            now,
            prisma: db,
          }),
        );
        results.push({ businessId: business.id, ...result });
      }
      return { scanned: businesses.length, results };
    },
  );

  const staleAssetRecoveryTask = inngest.createFunction(
    {
      id: "social-creative-stale-render-recovery",
      name: "Recover Stale Social Creative Renders",
      retries: 1,
      triggers: { cron: "*/5 * * * *" },
      concurrency: { limit: 1 },
    },
    async ({ step }) => {
      if (!generationEnabled()) {
        return { skipped: true, reason: "social_generation_disabled" };
      }
      const staleBefore = new Date(
        Date.now() - SOCIAL_CREATIVE_RENDER_LEASE_MS,
      );
      const staleAssets = await step.run("load-stale-social-creative-assets", () =>
        db.socialCreativeAsset.findMany({
          where: {
            status: "RENDERING",
            updatedAt: { lte: staleBefore },
            // Older collision handling could leave a RENDERING asset under a
            // run that finalization had already marked FAILED. Recover both
            // shapes; the asset lease still decides whether work is claimable.
            post: { run: { status: { in: ["RENDERING", "FAILED"] } } },
          },
          select: {
            id: true,
            startedAt: true,
            updatedAt: true,
            post: { select: { run: { select: { id: true, businessId: true } } } },
          },
          orderBy: { startedAt: "asc" },
          take: 100,
        }),
      );
      if (staleAssets.length > 0) {
        await step.sendEvent(
          "redispatch-stale-social-creative-assets",
          staleAssets.map((asset) => ({
            id: `social-creative-stale:${asset.id}:${new Date(
              asset.updatedAt,
            ).getTime()}`,
            name: "social/creative.asset.requested" as const,
            data: {
              assetId: asset.id,
              runId: asset.post.run.id,
              businessId: asset.post.run.businessId,
            },
          })),
        );
      }
      return { scanned: staleAssets.length, redispatched: staleAssets.length };
    },
  );

  const terminalRunRecoveryTask = inngest.createFunction(
    {
      id: "social-creative-terminal-run-recovery",
      name: "Finalize Terminal Social Creative Runs",
      retries: 1,
      triggers: { cron: "*/5 * * * *" },
      concurrency: { limit: 1 },
    },
    async ({ step }) => {
      const terminalRuns = await step.run(
        "load-terminal-social-creative-runs",
        () =>
          db.socialCreativeRun.findMany({
            where: {
              status: "RENDERING",
              posts: {
                some: { assets: { some: {} } },
                none: {
                  assets: {
                    some: { status: { in: ["PENDING", "RENDERING"] } },
                  },
                },
              },
            },
            select: {
              id: true,
              posts: {
                select: {
                  assets: { select: { updatedAt: true } },
                },
              },
            },
            orderBy: { updatedAt: "asc" },
            take: 100,
          }),
      );
      if (terminalRuns.length > 0) {
        await step.sendEvent(
          "redispatch-terminal-social-creative-finalization",
          terminalRuns.map((run) => {
            const terminalRevision = Math.max(
              0,
              ...run.posts.flatMap((post) =>
                post.assets.map((asset) => new Date(asset.updatedAt).getTime()),
              ),
            );
            return {
              id: `social-creative-terminal-finalize:${run.id}:${terminalRevision}`,
              name: "social/creative.finalize" as const,
              data: { runId: run.id },
            };
          }),
        );
      }
      return { scanned: terminalRuns.length, redispatched: terminalRuns.length };
    },
  );

  return [
    requestTask,
    assetTask,
    completionTask,
    finalizeTask,
    topicPlannerTask,
    rollingTopicPlannerTask,
    scheduledTopicScannerTask,
    weeklyCarouselAssignmentTask,
    staleAssetRecoveryTask,
    terminalRunRecoveryTask,
  ] as const;
}
