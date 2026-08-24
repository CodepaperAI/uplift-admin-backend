import type { PrismaClient } from "@prisma/client";

import { normalizeSocialPlatforms } from "./social-creative/formats";
import { resolveSocialTopicPublishPlatforms } from "../utils/social-platform-schedule.utils";

export type SocialPlatformCalendarReconciliationResult = {
  scanned: number;
  unchanged: number;
  wouldUpdate: number;
  wouldSkip: number;
  updated: number;
  skipped: number;
  raced: number;
};

function samePlatforms(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((platform, index) => platform === right[index])
  );
}

/**
 * Reconcile only untouched future topics. A status/platform guard makes the
 * apply path safe if a scheduler claims the topic after the read.
 */
export async function reconcileFutureSocialPlatformCalendars(
  input: {
    now?: Date;
    apply?: boolean;
    businessId?: string;
  },
  prisma: PrismaClient,
): Promise<SocialPlatformCalendarReconciliationResult> {
  const topics = await prisma.socialTopicPlan.findMany({
    where: {
      status: "PLANNED",
      scheduledFor: { gt: input.now ?? new Date() },
      ...(input.businessId ? { businessId: input.businessId } : {}),
    },
    select: {
      id: true,
      platforms: true,
      scheduledFor: true,
      timezone: true,
    },
    orderBy: { scheduledFor: "asc" },
  });
  const result: SocialPlatformCalendarReconciliationResult = {
    scanned: topics.length,
    unchanged: 0,
    wouldUpdate: 0,
    wouldSkip: 0,
    updated: 0,
    skipped: 0,
    raced: 0,
  };

  for (const topic of topics) {
    const platforms = normalizeSocialPlatforms(topic.platforms);
    const desiredPlatforms = resolveSocialTopicPublishPlatforms({
      platforms,
      topicScheduledFor: topic.scheduledFor,
      timeZone: topic.timezone,
    });
    if (samePlatforms(platforms, desiredPlatforms)) {
      result.unchanged += 1;
      continue;
    }
    if (desiredPlatforms.length === 0) result.wouldSkip += 1;
    else result.wouldUpdate += 1;
    if (!input.apply) continue;

    const updated = await prisma.socialTopicPlan.updateMany({
      where: {
        id: topic.id,
        status: "PLANNED",
        platforms: { equals: topic.platforms },
      },
      data:
        desiredPlatforms.length === 0
          ? { status: "SKIPPED", platforms: [] }
          : { platforms: desiredPlatforms },
    });
    if (updated.count !== 1) {
      result.raced += 1;
      continue;
    }
    if (desiredPlatforms.length === 0) result.skipped += 1;
    else result.updated += 1;
  }

  return result;
}
