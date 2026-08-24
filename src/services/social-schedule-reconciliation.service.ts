import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../config/db.config";
import {
  resolveSocialScheduleTimeZone,
  socialLocalDateTimeToUtc,
  socialScheduleLocalParts,
} from "../utils/social-schedule.utils";

export type SocialScheduleReconciliationSummary = {
  applied: boolean;
  businessesScanned: number;
  settingsNeedingUpdate: number;
  settingsUpdated: number;
  topicsScanned: number;
  topicsNeedingUpdate: number;
  topicsUpdated: number;
  timezones: Record<string, number>;
};

/**
 * Safely realign only future PLANNED topics. Claimed, generated, ready, and
 * provider-scheduled content is left untouched so a rollout cannot race or
 * duplicate background publishing work already in progress.
 */
export async function reconcileFutureSocialMorningSchedules(
  input: {
    apply?: boolean;
    businessId?: string;
    now?: Date;
  } = {},
  prisma: PrismaClient = defaultPrisma,
): Promise<SocialScheduleReconciliationSummary> {
  const apply = input.apply === true;
  const now = input.now ?? new Date();
  const settingsRows = await prisma.socialAutomationSettings.findMany({
    where: {
      enabled: true,
      ...(input.businessId ? { businessId: input.businessId } : {}),
      business: { isActive: true },
    },
    select: {
      businessId: true,
      timezone: true,
      business: {
        select: {
          businessCountry: true,
          businessState: true,
          businessCity: true,
          defaultLocale: true,
          serviceAreaLocations: true,
          GoogleMyBusiness: {
            select: { timezone: true, isActive: true },
          },
          GeoProfile: {
            select: { countryCode: true, adminArea1: true, locality: true },
          },
        },
      },
    },
    orderBy: { businessId: "asc" },
  });
  const summary: SocialScheduleReconciliationSummary = {
    applied: apply,
    businessesScanned: settingsRows.length,
    settingsNeedingUpdate: 0,
    settingsUpdated: 0,
    topicsScanned: 0,
    topicsNeedingUpdate: 0,
    topicsUpdated: 0,
    timezones: {},
  };

  for (const settings of settingsRows) {
    const timezone = resolveSocialScheduleTimeZone({
      configuredTimeZone: settings.timezone,
      providerTimeZone: settings.business.GoogleMyBusiness?.isActive
        ? settings.business.GoogleMyBusiness.timezone
        : null,
      defaultLocale: settings.business.defaultLocale,
      businessCountry: settings.business.businessCountry,
      businessState: settings.business.businessState,
      businessCity: settings.business.businessCity,
      geoCountry: settings.business.GeoProfile?.countryCode,
      geoState: settings.business.GeoProfile?.adminArea1,
      geoCity: settings.business.GeoProfile?.locality,
      serviceAreaLocations: settings.business.serviceAreaLocations,
    });
    summary.timezones[timezone] = (summary.timezones[timezone] ?? 0) + 1;
    const topics = await prisma.socialTopicPlan.findMany({
      where: {
        businessId: settings.businessId,
        status: "PLANNED",
        scheduledFor: { gt: now },
      },
      select: { id: true, scheduledFor: true, timezone: true },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    });
    summary.topicsScanned += topics.length;
    const topicsByLocalDate = new Map<string, typeof topics>();
    for (const topic of topics) {
      const local = socialScheduleLocalParts(topic.scheduledFor, timezone);
      const dateKey = [
        local.year,
        String(local.month).padStart(2, "0"),
        String(local.day).padStart(2, "0"),
      ].join("-");
      const dateTopics = topicsByLocalDate.get(dateKey) ?? [];
      dateTopics.push(topic);
      topicsByLocalDate.set(dateKey, dateTopics);
    }
    const scheduleByTopicId = new Map<string, Date>();
    for (const dateTopics of topicsByLocalDate.values()) {
      dateTopics.sort(
        (left, right) =>
          left.scheduledFor.getTime() - right.scheduledFor.getTime() ||
          left.id.localeCompare(right.id),
      );
      const local = socialScheduleLocalParts(
        dateTopics[0]!.scheduledFor,
        timezone,
      );
      for (const [index, topic] of dateTopics.entries()) {
        const minute = Math.floor(
          (60 * (index + 1)) / (dateTopics.length + 1),
        );
        const morning = socialLocalDateTimeToUtc(
          {
            year: local.year,
            month: local.month,
            day: local.day,
            hour: 8,
            minute,
          },
          timezone,
        );
        // Never move an otherwise-future topic into the past. Updating only
        // its timezone still lets the platform calendar derive today's local
        // Instagram/Facebook and X publishing slots correctly.
        scheduleByTopicId.set(
          topic.id,
          morning.getTime() > now.getTime() ? morning : topic.scheduledFor,
        );
      }
    }
    const changes = topics
      .map((topic) => ({
        topic,
        scheduledFor: scheduleByTopicId.get(topic.id) ?? topic.scheduledFor,
      }))
      .filter(
        ({ topic, scheduledFor }) =>
          topic.timezone !== timezone ||
          topic.scheduledFor.getTime() !== scheduledFor.getTime(),
      );
    const settingsNeedUpdate = settings.timezone !== timezone;
    if (settingsNeedUpdate) summary.settingsNeedingUpdate += 1;
    summary.topicsNeedingUpdate += changes.length;

    if (!apply || (!settingsNeedUpdate && changes.length === 0)) continue;

    const plannedThrough = topics.reduce<Date | undefined>(
      (latest, topic) => {
        const scheduledFor =
          scheduleByTopicId.get(topic.id) ?? topic.scheduledFor;
        return !latest || scheduledFor > latest ? scheduledFor : latest;
      },
      undefined,
    );
    const result = await prisma.$transaction(async (tx) => {
      await tx.socialAutomationSettings.update({
        where: { businessId: settings.businessId },
        data: {
          timezone,
          ...(plannedThrough
            ? {
                plannedThrough,
                nextPlanningAt: new Date(
                  plannedThrough.getTime() - 7 * 86_400_000,
                ),
              }
            : {}),
        },
      });
      let updated = 0;
      for (const change of changes) {
        const update = await tx.socialTopicPlan.updateMany({
          where: {
            id: change.topic.id,
            status: "PLANNED",
            scheduledFor: change.topic.scheduledFor,
          },
          data: {
            scheduledFor: change.scheduledFor,
            timezone,
          },
        });
        updated += update.count;
      }
      return updated;
    });
    summary.settingsUpdated += 1;
    summary.topicsUpdated += result;
  }

  return summary;
}
