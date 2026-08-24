import { PublishStatus } from "@prisma/client";

const CMS_READY_STATUSES = new Set<PublishStatus>([
  PublishStatus.PUBLISHED,
  PublishStatus.PENDING,
  PublishStatus.PUBLISHING,
]);

const GMB_READY_STATUSES = new Set(["PUBLISHED", "SCHEDULED", "PENDING"]);

type PublishedBlogDispatchState = {
  integrationId: string | null;
  status: PublishStatus;
};

type BlogDispatchDecisionInput = {
  activeIntegrationIds: string[];
  publishedBlogs: PublishedBlogDispatchState[];
  hasGmbConnection: boolean;
  gmbPostStatuses: string[];
};

type BlogDispatchDecision = {
  needsAutoPublish: boolean;
  needsGmb: boolean;
  status: "queued" | "already_dispatched";
};

export function getBlogDispatchDecision({
  activeIntegrationIds,
  publishedBlogs,
  hasGmbConnection,
  gmbPostStatuses,
}: BlogDispatchDecisionInput): BlogDispatchDecision {
  const queuedOrPublishedIntegrations = new Set(
    publishedBlogs
      .filter(
        (
          entry,
        ): entry is PublishedBlogDispatchState & { integrationId: string } =>
          Boolean(entry.integrationId) && CMS_READY_STATUSES.has(entry.status),
      )
      .map((entry) => entry.integrationId),
  );

  const needsAutoPublish = activeIntegrationIds.some(
    (integrationId) => !queuedOrPublishedIntegrations.has(integrationId),
  );

  const hasQueuedOrPublishedGmb = gmbPostStatuses.some((status) =>
    GMB_READY_STATUSES.has(status),
  );
  const needsGmb = hasGmbConnection && !hasQueuedOrPublishedGmb;

  return {
    needsAutoPublish,
    needsGmb,
    status:
      !needsAutoPublish && !needsGmb ? "already_dispatched" : "queued",
  };
}
