import type { SocialPlatform } from "../services/social-creative/types";
import {
  socialLocalDateTimeToUtc,
  socialScheduleLocalParts,
} from "./social-schedule.utils";

export type SocialMediaMode = "image" | "none";

export type AutomaticSocialPublishSlot = {
  id: "primary" | "lunch" | "evening";
  scheduledFor: Date;
  mediaMode: SocialMediaMode;
};

type DailySlotPolicy = {
  id: AutomaticSocialPublishSlot["id"];
  hour: number;
  minute: number;
};

type PlatformAutomationPolicy = {
  slots: readonly DailySlotPolicy[];
  weekdayPolicy: readonly [
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
    WeekdayPublishPolicy,
  ];
};

type WeekdayPublishPolicy = {
  enabled: boolean;
  mediaMode: SocialMediaMode;
};

const IMAGE_DAY = Object.freeze({ enabled: true, mediaMode: "image" as const });
const TEXT_DAY = Object.freeze({ enabled: true, mediaMode: "none" as const });
const OFF_DAY = Object.freeze({ enabled: false, mediaMode: "none" as const });

export const X_AUTOMATIC_PUBLISH_POLICY = Object.freeze({
  slots: Object.freeze([
    Object.freeze({ id: "lunch" as const, hour: 12, minute: 0 }),
    Object.freeze({ id: "evening" as const, hour: 18, minute: 0 }),
  ]),
  // Index is local Sunday (0) through Saturday (6). The table keeps media
  // eligibility data-driven: weekday X posts are text-only and weekend posts
  // can use the generated X image.
  weekdayPolicy: Object.freeze([
    IMAGE_DAY,
    TEXT_DAY,
    TEXT_DAY,
    TEXT_DAY,
    TEXT_DAY,
    TEXT_DAY,
    IMAGE_DAY,
  ]),
} satisfies PlatformAutomationPolicy);

export const INSTAGRAM_FACEBOOK_AUTOMATIC_PUBLISH_POLICY = Object.freeze({
  slots: Object.freeze([
    Object.freeze({ id: "primary" as const, hour: 9, minute: 0 }),
  ]),
  // Local Sunday through Saturday: post Tuesday, Thursday, Saturday, Sunday.
  weekdayPolicy: Object.freeze([
    IMAGE_DAY,
    OFF_DAY,
    IMAGE_DAY,
    OFF_DAY,
    IMAGE_DAY,
    OFF_DAY,
    IMAGE_DAY,
  ]),
} satisfies PlatformAutomationPolicy);

const PLATFORM_AUTOMATION_POLICIES: Partial<
  Record<SocialPlatform, PlatformAutomationPolicy>
> = Object.freeze({
  instagram: INSTAGRAM_FACEBOOK_AUTOMATIC_PUBLISH_POLICY,
  facebook: INSTAGRAM_FACEBOOK_AUTOMATIC_PUBLISH_POLICY,
  x: X_AUTOMATIC_PUBLISH_POLICY,
});

export function hasAutomaticSocialPlatformPolicy(
  platform: SocialPlatform,
): boolean {
  return Boolean(PLATFORM_AUTOMATION_POLICIES[platform]);
}

function localWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Resolve automatic provider slots from the topic's business-local date.
 * Platforms without a dedicated policy retain the topic's own schedule and
 * image behavior. Missing calendar context preserves manual/onboarding image
 * generation rather than guessing a date.
 */
export function resolveAutomaticSocialPublishSlots(input: {
  platform: SocialPlatform;
  topicScheduledFor?: Date | null;
  timeZone?: string | null;
}): AutomaticSocialPublishSlot[] {
  const policy = PLATFORM_AUTOMATION_POLICIES[input.platform];
  if (!policy || !input.topicScheduledFor || !input.timeZone) {
    return [
      {
        id: "primary",
        scheduledFor: input.topicScheduledFor ?? new Date(0),
        mediaMode: "image",
      },
    ];
  }

  const local = socialScheduleLocalParts(
    input.topicScheduledFor,
    input.timeZone,
  );
  const weekdayPolicy = policy.weekdayPolicy[
    localWeekday(local.year, local.month, local.day)
  ];
  return policy.slots
    .filter(() => weekdayPolicy?.enabled === true)
    .map((slot) => ({
      id: slot.id,
      scheduledFor: socialLocalDateTimeToUtc(
        {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: slot.hour,
          minute: slot.minute,
        },
        input.timeZone!,
      ),
      mediaMode: weekdayPolicy!.mediaMode,
    }));
}

export function resolveSocialTopicPublishPlatforms(input: {
  platforms: readonly SocialPlatform[];
  topicScheduledFor?: Date | null;
  timeZone?: string | null;
}): SocialPlatform[] {
  return input.platforms.filter(
    (platform) =>
      resolveAutomaticSocialPublishSlots({
        platform,
        topicScheduledFor: input.topicScheduledFor,
        timeZone: input.timeZone,
      }).length > 0,
  );
}

export function resolveSocialTopicImagePlatforms(input: {
  platforms: readonly SocialPlatform[];
  topicScheduledFor?: Date | null;
  timeZone?: string | null;
}): SocialPlatform[] {
  return input.platforms.filter((platform) =>
    resolveAutomaticSocialPublishSlots({
      platform,
      topicScheduledFor: input.topicScheduledFor,
      timeZone: input.timeZone,
    }).some((slot) => slot.mediaMode === "image"),
  );
}
