import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../config/db.config";
import { resolveSocialTopicImagePlatforms } from "../utils/social-platform-schedule.utils";
import {
  socialLocalDateTimeToUtc,
  socialScheduleLocalParts,
} from "../utils/social-schedule.utils";
import { normalizeSocialPlatforms } from "./social-creative/formats";
import type { SocialPlatform } from "./social-creative/types";

type LocalDate = { year: number; month: number; day: number };

function localDateKey(date: LocalDate): string {
  return [
    date.year,
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localWeek(input: { instant: Date; timeZone: string }) {
  const local = socialScheduleLocalParts(input.instant, input.timeZone);
  const weekday = new Date(
    Date.UTC(local.year, local.month - 1, local.day),
  ).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const weekStart = addLocalDays(local, -mondayOffset);
  const weekEnd = addLocalDays(weekStart, 7);
  const currentDayStart = socialLocalDateTimeToUtc(
    { year: local.year, month: local.month, day: local.day, hour: 0, minute: 0 },
    input.timeZone,
  );
  return {
    currentLocalDate: localDateKey(local),
    currentDayStart,
    weekStart: localDateKey(weekStart),
    weekEndInstant: socialLocalDateTimeToUtc(
      { ...weekEnd, hour: 0, minute: 0 },
      input.timeZone,
    ),
  };
}

export function selectWeeklyLogoLocalDate(input: {
  businessId: string;
  weekStart: string;
  candidates: readonly string[];
}): string | null {
  const candidates = Array.from(new Set(input.candidates)).sort();
  if (candidates.length === 0) return null;
  const digest = createHash("sha256")
    .update(`${input.businessId}:${input.weekStart}:social-logo-v1`)
    .digest();
  return candidates[digest.readUInt32BE(0) % candidates.length]!;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "P2002",
  );
}

export async function resolveScheduledSocialArtworkLogo(
  input: {
    runId: string;
    businessId: string;
    scheduledFor: Date;
    timeZone: string;
    platforms: readonly SocialPlatform[];
  },
  prisma: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<boolean> {
  // A text-only schedule must never consume the week's single logo assignment.
  // The assignment is reserved for a run that can actually produce artwork.
  if (input.platforms.length === 0) return false;

  const settings = await prisma.socialAutomationSettings.findUnique({
    where: { businessId: input.businessId },
    select: { logoUsageMode: true },
  });
  if (settings?.logoUsageMode === "ALWAYS") return true;

  const week = localWeek({ instant: input.scheduledFor, timeZone: input.timeZone });
  let assignment = await prisma.socialLogoWeekAssignment.findUnique({
    where: {
      businessId_weekStart: {
        businessId: input.businessId,
        weekStart: week.weekStart,
      },
    },
  });

  if (!assignment) {
    const topics = await prisma.socialTopicPlan.findMany({
      where: {
        businessId: input.businessId,
        scheduledFor: { gte: week.currentDayStart, lt: week.weekEndInstant },
        status: { notIn: ["FAILED", "SKIPPED", "CANCELLED"] },
      },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
      select: {
        id: true,
        platforms: true,
        scheduledFor: true,
        timezone: true,
      },
    });
    const candidates = topics.flatMap((topic) => {
      const platforms = normalizeSocialPlatforms(topic.platforms);
      return resolveSocialTopicImagePlatforms({
        platforms,
        topicScheduledFor: topic.scheduledFor,
        timeZone: topic.timezone,
      }).length > 0
        ? [localDateKey(socialScheduleLocalParts(topic.scheduledFor, input.timeZone))]
        : [];
    });
    if (
      resolveSocialTopicImagePlatforms({
        platforms: input.platforms,
        topicScheduledFor: input.scheduledFor,
        timeZone: input.timeZone,
      }).length > 0
    ) {
      candidates.push(week.currentLocalDate);
    }
    const selectedLocalDate = selectWeeklyLogoLocalDate({
      businessId: input.businessId,
      weekStart: week.weekStart,
      candidates,
    });
    if (!selectedLocalDate) return false;

    try {
      assignment = await prisma.socialLogoWeekAssignment.create({
        data: {
          businessId: input.businessId,
          weekStart: week.weekStart,
          timezone: input.timeZone,
          selectedLocalDate,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      assignment = await prisma.socialLogoWeekAssignment.findUnique({
        where: {
          businessId_weekStart: {
            businessId: input.businessId,
            weekStart: week.weekStart,
          },
        },
      });
      if (!assignment) throw error;
    }
  }

  if (assignment.selectedLocalDate !== week.currentLocalDate) return false;
  if (assignment.claimedRunId === input.runId) return true;
  if (assignment.claimedRunId) return false;

  const claimed = await prisma.socialLogoWeekAssignment.updateMany({
    where: { id: assignment.id, claimedRunId: null },
    data: { claimedRunId: input.runId, claimedAt: now },
  });
  if (claimed.count === 1) return true;

  const raced = await prisma.socialLogoWeekAssignment.findUnique({
    where: { id: assignment.id },
    select: { claimedRunId: true },
  });
  return raced?.claimedRunId === input.runId;
}

export async function markSocialArtworkLogoGenerated(
  runId: string,
  prisma: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<void> {
  await prisma.socialLogoWeekAssignment.updateMany({
    where: { claimedRunId: runId, generatedAt: null },
    data: { generatedAt: now },
  });
}
