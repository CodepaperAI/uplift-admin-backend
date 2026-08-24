import type { PrismaClient } from "@prisma/client";
import type { Inngest } from "inngest";

import { prisma } from "../config/db.config";
import {
  prepareAutomaticSocialPublishing,
  SocialPublishingError,
  submitSocialPublishAttempt,
} from "../services/zernio/social-publishing.service";
import { ZernioApiError } from "../services/zernio/zernio.client";
import { checkSiteFeatureAccess } from "../services/website-plan-entitlement.service";
import { isSocialCreativeAutoPublishEnabled } from "../services/social-creative/constants";

const SOCIAL_PUBLISH_RETRIES = 5;

export function shouldKeepSocialPublishAttemptPending(
  error: unknown,
  attempt: number,
): boolean {
  return (
    error instanceof ZernioApiError &&
    error.retryable &&
    attempt < SOCIAL_PUBLISH_RETRIES
  );
}

export function createZernioSocialPublishingFunctions(
  inngest: Inngest,
  dependencies: {
    prisma?: PrismaClient;
    submit?: typeof submitSocialPublishAttempt;
    prepareAutoPublish?: typeof prepareAutomaticSocialPublishing;
    autoPublishEnabled?: typeof isSocialCreativeAutoPublishEnabled;
  } = {},
) {
  const db = dependencies.prisma ?? prisma;
  const submit = dependencies.submit ?? submitSocialPublishAttempt;
  const prepareAutoPublish =
    dependencies.prepareAutoPublish ?? prepareAutomaticSocialPublishing;
  const autoPublishEnabled =
    dependencies.autoPublishEnabled ?? isSocialCreativeAutoPublishEnabled;

  const publishTask = inngest.createFunction(
    {
      id: "zernio-social-publish",
      name: "Publish Social Creative with Zernio",
      retries: SOCIAL_PUBLISH_RETRIES,
      triggers: { event: "social/publish.requested" },
      singleton: { key: "event.data.attemptId", mode: "skip" },
      concurrency: [
        { limit: 4 },
        { limit: 1, key: "event.data.businessId" },
      ],
      timeouts: { finish: "2m" },
    },
    async ({ event, step, attempt = 0 }) => {
      const attemptId = String(event.data.attemptId);
      const businessId = String(event.data.businessId);
      const access = await step.run("check-social-publishing-entitlement", () =>
        checkSiteFeatureAccess(businessId, "social_publishing"),
      );
      if (!access.hasAccess) {
        await step.run("deny-social-publishing", () =>
          db.socialPublishAttempt.updateMany({
            where: { id: attemptId, status: { in: ["PENDING", "FAILED"] } },
            data: {
              status: "FAILED",
              lastErrorCode: "SOCIAL_PUBLISHING_NOT_INCLUDED",
              lastErrorMessage:
                access.message || "Social publishing is not included for this website",
            },
          }),
        );
        return { attemptId, published: false, reason: "no_entitlement" };
      }

      try {
        const result = await step.run("submit-zernio-social-post", () =>
          submit(attemptId, db),
        );
        return { attemptId, status: result.status, externalPostId: result.externalPostId };
      } catch (error) {
        if (shouldKeepSocialPublishAttemptPending(error, attempt)) {
          await step.run(`mark-social-publishing-retrying-${attempt}`, () =>
            db.socialPublishAttempt.updateMany({
              where: { id: attemptId, status: "FAILED" },
              data: { status: "PENDING" },
            }),
          );
          throw error;
        }
        if (error instanceof ZernioApiError && error.retryable) {
          return {
            attemptId,
            published: false,
            reason: error.message,
          };
        }
        // Database/network failures after Zernio accepted a post must retry.
        // The same x-request-id plus Zernio's duplicate response lets the
        // service safely adopt the already-created provider post.
        if (!(error instanceof ZernioApiError || error instanceof SocialPublishingError)) {
          throw error;
        }
        return {
          attemptId,
          published: false,
          reason: error instanceof Error ? error.message : "publishing_failed",
        };
      }
    },
  );

  const readyContentScanTask = inngest.createFunction(
    {
      id: "zernio-social-auto-publish-ready-scan",
      name: "Schedule Ready Social Content for Connected Accounts",
      retries: 2,
      triggers: [
        { event: "social/publish.ready.scan" },
        { cron: "*/15 * * * *" },
      ],
      concurrency: { limit: 1 },
    },
    async ({ event, step }) => {
      if (!autoPublishEnabled()) {
        return {
          scanned: 0,
          prepared: 0,
          dispatched: 0,
          skipped: true,
          reason: "auto_publish_disabled",
        };
      }
      const eventData = event.data as { businessId?: unknown };
      const requestedBusinessId =
        typeof eventData.businessId === "string" && eventData.businessId
          ? eventData.businessId
          : null;
      const now = new Date();
      const oldestDue = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
      const parsedLimit = Number(process.env.SOCIAL_AUTO_PUBLISH_SCAN_LIMIT ?? 100);
      const limit = Number.isInteger(parsedLimit)
        ? Math.min(250, Math.max(1, parsedLimit))
        : 100;
      const runs = await step.run("load-ready-social-content-for-auto-publish", () =>
        db.socialCreativeRun.findMany({
          where: {
            status: "COMPLETE",
            ...(requestedBusinessId ? { businessId: requestedBusinessId } : {}),
            socialTopicPlan: {
              is: { scheduledFor: { gte: oldestDue } },
            },
            business: {
              isActive: true,
              socialAutomationSettings: {
                is: { enabled: true, approvalRequired: false },
              },
              websiteSubscription: { is: { planTier: "SEO_SOCIAL" } },
            },
          },
          select: { id: true },
          orderBy: { completedAt: "asc" },
          take: limit,
        }),
      );
      const prepared = [];
      for (const run of runs) {
        prepared.push(
          await step.run(`prepare-ready-social-run-${run.id}`, () =>
            prepareAutoPublish(run.id, db, now),
          ),
        );
      }
      const events = prepared.flatMap((result) =>
        result.attemptIds.map((attemptId) => ({
          id: `social-auto-publish:${attemptId}`,
          name: "social/publish.requested" as const,
          data: {
            attemptId,
            businessId: result.businessId!,
            runId: result.runId,
          },
        })),
      );
      if (events.length > 0) {
        await step.sendEvent("dispatch-ready-social-content", events);
      }
      return {
        scanned: runs.length,
        prepared: prepared.filter((result) => result.status === "prepared").length,
        dispatched: events.length,
      };
    },
  );

  return [publishTask, readyContentScanTask];
}
