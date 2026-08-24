import OpenAI from "openai";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma as defaultPrisma } from "../config/db.config";
import {
  socialScheduleLocalParts,
} from "../utils/social-schedule.utils";
import { estimateUsdFromTokens, recordLlmUsageEvent } from "./llm-usage.service";
import { normalizeSocialPlatforms } from "./social-creative/formats";
import type {
  SocialPackKind,
  SocialPlatform,
} from "./social-creative/types";

export const SOCIAL_CAROUSEL_SELECTOR_MODEL = "gpt-5.6-luna" as const;
export const SOCIAL_CAROUSEL_SELECTOR_PROMPT_VERSION =
  "social-carousel-week-selector-v1" as const;
export const SOCIAL_CAROUSEL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
] as const satisfies readonly SocialPlatform[];

const selectionSchema = z.object({
  topicPlanId: z.string().uuid(),
  educationalAngle: z.string().trim().min(10).max(500),
  audienceTakeaway: z.string().trim().min(10).max(500),
  reason: z.string().trim().min(10).max(500),
});

type ResponsesClient = {
  responses: {
    create: (
      request: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ) => Promise<any>;
  };
};

type LocalDate = { year: number; month: number; day: number };

function getOpenAiClient(): ResponsesClient {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for weekly carousel selection");
  }
  return new OpenAI({ apiKey });
}

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

export function socialCarouselLocalWeek(input: {
  instant: Date;
  timeZone: string;
}) {
  const local = socialScheduleLocalParts(input.instant, input.timeZone);
  const weekday = new Date(
    Date.UTC(local.year, local.month - 1, local.day),
  ).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const weekStart = addLocalDays(local, -mondayOffset);
  return {
    localDate: localDateKey(local),
    weekStart: localDateKey(weekStart),
    weekday,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "P2002",
  );
}

function outputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "topicPlanId",
      "educationalAngle",
      "audienceTakeaway",
      "reason",
    ],
    properties: {
      topicPlanId: { type: "string", format: "uuid" },
      educationalAngle: { type: "string", minLength: 10, maxLength: 500 },
      audienceTakeaway: { type: "string", minLength: 10, maxLength: 500 },
      reason: { type: "string", minLength: 10, maxLength: 500 },
    },
  };
}

async function selectWeeklyCarouselTopic(input: {
  assignmentId: string;
  business: { id: string; businessName: string; businessType: string };
  weekStart: string;
  timezone: string;
  candidates: Array<{
    id: string;
    topic: string;
    contentPillar: string | null;
    objective: string;
    hook: string | null;
    contentType: string | null;
    localDate: string;
    supportedPlatforms: SocialPlatform[];
  }>;
  recentSelections: Array<{
    weekStart: string;
    selectedLocalDate: string | null;
    selection: unknown;
  }>;
  client: ResponsesClient;
}) {
  const response = await input.client.responses.create(
    {
      model: SOCIAL_CAROUSEL_SELECTOR_MODEL,
      store: false,
      tools: [],
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      max_output_tokens: 1_200,
      instructions: [
        "Select exactly one already-planned topic for this business's weekly educational carousel.",
        "Return only the requested structured JSON and do not call tools.",
        "Choose from the supplied topicPlanId values only. Never invent or rewrite an ID.",
        "Prefer the topic with the strongest useful teaching sequence for the real business audience, not the most promotional topic.",
        "Favor a topic that can sustain four to six distinct, connected slides without padding or repetition.",
        "Use recentSelections to vary the local weekday and subject naturally across weeks when quality is otherwise comparable. Do not follow a fixed weekday formula.",
        "The selected topic should work across its listed supported platforms. Do not select X as a carousel destination.",
        "Explain the educational angle and audience takeaway using supplied facts only. Do not add statistics, claims, offers, or business details.",
      ].join("\n"),
      input: JSON.stringify({
        business: input.business,
        weekStart: input.weekStart,
        timezone: input.timezone,
        candidates: input.candidates,
        recentSelections: input.recentSelections,
      }),
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "weekly_social_carousel_selection",
          description: "One durable weekly educational carousel topic selection",
          strict: true,
          schema: outputSchema(),
        },
      },
    },
    {
      idempotencyKey: [
        "social-carousel-selection",
        input.assignmentId,
        SOCIAL_CAROUSEL_SELECTOR_PROMPT_VERSION,
      ].join(":"),
    },
  );
  if (
    response.error ||
    response.status !== "completed" ||
    response.incomplete_details
  ) {
    throw new Error(
      `Weekly carousel selector did not complete (${String(response.status ?? "unknown")})`,
    );
  }
  const outputText =
    typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (!outputText) {
    throw new Error("Weekly carousel selector returned no structured output");
  }
  const selection = selectionSchema.parse(JSON.parse(outputText));
  if (!input.candidates.some((candidate) => candidate.id === selection.topicPlanId)) {
    throw new Error("Weekly carousel selector returned an unknown topic plan");
  }
  const inputTokens = Math.max(
    0,
    Math.floor(Number(response.usage?.input_tokens ?? 0)),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(Number(response.usage?.output_tokens ?? 0)),
  );
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    Math.floor(Number(response.usage?.total_tokens ?? 0)),
  );
  return {
    selection,
    responseId: String(response.id ?? ""),
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedUsd: estimateUsdFromTokens(
      SOCIAL_CAROUSEL_SELECTOR_MODEL,
      inputTokens,
      outputTokens,
    ),
  };
}

export async function assignWeeklySocialCarousels(input: {
  businessId: string;
  userId: string;
  now?: Date;
  prisma?: PrismaClient;
  client?: ResponsesClient;
  recordUsage?: typeof recordLlmUsageEvent;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const now = input.now ?? new Date();
  const business = await prisma.business.findFirst({
    where: { id: input.businessId, userId: input.userId, isActive: true },
    select: {
      id: true,
      businessName: true,
      businessType: true,
      socialAutomationSettings: {
        select: { carouselEnabled: true },
      },
    },
  });
  if (!business || business.socialAutomationSettings?.carouselEnabled === false) {
    return { assigned: 0, assignments: [] as string[] };
  }

  const topics = await prisma.socialTopicPlan.findMany({
    where: {
      businessId: input.businessId,
      userId: input.userId,
      status: "PLANNED",
      scheduledFor: {
        gte: now,
        lte: new Date(now.getTime() + 42 * 86_400_000),
      },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: {
      id: true,
      topic: true,
      contentPillar: true,
      objective: true,
      hook: true,
      contentType: true,
      platforms: true,
      scheduledFor: true,
      timezone: true,
    },
  });

  const weeks = new Map<
    string,
    {
      timezone: string;
      candidates: Array<{
        id: string;
        topic: string;
        contentPillar: string | null;
        objective: string;
        hook: string | null;
        contentType: string | null;
        localDate: string;
        supportedPlatforms: SocialPlatform[];
      }>;
    }
  >();
  for (const topic of topics) {
    const supportedPlatforms = normalizeSocialPlatforms(topic.platforms).filter(
      (platform): platform is (typeof SOCIAL_CAROUSEL_PLATFORMS)[number] =>
        SOCIAL_CAROUSEL_PLATFORMS.includes(
          platform as (typeof SOCIAL_CAROUSEL_PLATFORMS)[number],
        ),
    );
    if (supportedPlatforms.length === 0) continue;
    const week = socialCarouselLocalWeek({
      instant: topic.scheduledFor,
      timeZone: topic.timezone,
    });
    const entry = weeks.get(week.weekStart) ?? {
      timezone: topic.timezone,
      candidates: [],
    };
    entry.candidates.push({
      id: topic.id,
      topic: topic.topic,
      contentPillar: topic.contentPillar,
      objective: topic.objective,
      hook: topic.hook,
      contentType: topic.contentType,
      localDate: week.localDate,
      supportedPlatforms,
    });
    weeks.set(week.weekStart, entry);
  }

  const recentSelections = await prisma.socialCarouselWeekAssignment.findMany({
    where: { businessId: input.businessId, status: "SELECTED" },
    orderBy: { weekStart: "desc" },
    take: 8,
    select: { weekStart: true, selectedLocalDate: true, selection: true },
  });
  const client = input.client ?? getOpenAiClient();
  const recordUsage = input.recordUsage ?? recordLlmUsageEvent;
  const selectedAssignments: string[] = [];

  for (const [weekStart, week] of weeks) {
    const widestPlatformCoverage = Math.max(
      ...week.candidates.map((candidate) => candidate.supportedPlatforms.length),
    );
    const selectionCandidates = week.candidates.filter(
      (candidate) =>
        candidate.supportedPlatforms.length === widestPlatformCoverage,
    );
    let assignment = await prisma.socialCarouselWeekAssignment.findUnique({
      where: {
        businessId_weekStart: { businessId: input.businessId, weekStart },
      },
    });
    if (assignment?.status === "SELECTED") {
      selectedAssignments.push(assignment.id);
      continue;
    }
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    if (assignment?.status === "PLANNING" && assignment.updatedAt > staleBefore) {
      continue;
    }
    if (assignment) {
      const claimed = await prisma.socialCarouselWeekAssignment.updateMany({
        where: {
          id: assignment.id,
          OR: [
            { status: "FAILED" },
            { status: "PLANNING", updatedAt: { lte: staleBefore } },
          ],
        },
        data: {
          status: "PLANNING",
          failureCode: null,
          failureMessage: null,
          startedAt: now,
          completedAt: null,
        },
      });
      if (claimed.count !== 1) continue;
    } else {
      try {
        assignment = await prisma.socialCarouselWeekAssignment.create({
          data: {
            businessId: input.businessId,
            weekStart,
            timezone: week.timezone,
            status: "PLANNING",
            model: SOCIAL_CAROUSEL_SELECTOR_MODEL,
            promptVersion: SOCIAL_CAROUSEL_SELECTOR_PROMPT_VERSION,
            startedAt: now,
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        continue;
      }
    }

    try {
      const generated = await selectWeeklyCarouselTopic({
        assignmentId: assignment.id,
        business: {
          id: business.id,
          businessName: business.businessName,
          businessType: business.businessType,
        },
        weekStart,
        timezone: week.timezone,
        candidates: selectionCandidates,
        recentSelections,
        client,
      });
      const selected = selectionCandidates.find(
        (candidate) => candidate.id === generated.selection.topicPlanId,
      )!;
      await prisma.socialCarouselWeekAssignment.update({
        where: { id: assignment.id },
        data: {
          status: "SELECTED",
          selectedTopicPlanId: generated.selection.topicPlanId,
          selectedLocalDate: selected.localDate,
          selection: generated.selection as Prisma.InputJsonValue,
          responseId: generated.responseId || null,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
          totalTokens: generated.totalTokens,
          estimatedUsd: generated.estimatedUsd,
          failureCode: null,
          failureMessage: null,
          completedAt: new Date(),
        },
      });
      selectedAssignments.push(assignment.id);
      await recordUsage({
        purpose: "social_creative",
        provider: "openai",
        model: SOCIAL_CAROUSEL_SELECTOR_MODEL,
        userId: input.userId,
        businessId: input.businessId,
        correlationId: `social-carousel-selector:${assignment.id}:${generated.responseId || "unknown"}`,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        totalTokens: generated.totalTokens,
        metadata: {
          stage: "social_carousel_week_selector",
          assignmentId: assignment.id,
          weekStart,
          promptVersion: SOCIAL_CAROUSEL_SELECTOR_PROMPT_VERSION,
        },
      });
    } catch (error) {
      await prisma.socialCarouselWeekAssignment.updateMany({
        where: { id: assignment.id, status: "PLANNING" },
        data: {
          status: "FAILED",
          failureCode: "SOCIAL_CAROUSEL_SELECTION_FAILED",
          failureMessage:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Carousel selection failed",
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  return {
    assigned: selectedAssignments.length,
    assignments: selectedAssignments,
  };
}

export function socialCreativeKindForTopic(input: {
  carouselEnabled: boolean | null | undefined;
  carouselAssignmentStatus?: string | null;
}): SocialPackKind {
  return input.carouselEnabled !== false &&
    input.carouselAssignmentStatus === "SELECTED"
    ? "carousel"
    : "single";
}

export async function claimSocialCarouselRun(input: {
  topicPlanId: string;
  runId: string;
  prisma?: PrismaClient;
}) {
  const prisma = input.prisma ?? defaultPrisma;
  const claimed = await prisma.socialCarouselWeekAssignment.updateMany({
    where: {
      selectedTopicPlanId: input.topicPlanId,
      status: "SELECTED",
      OR: [{ claimedRunId: null }, { claimedRunId: input.runId }],
    },
    data: { claimedRunId: input.runId },
  });
  return claimed.count === 1;
}
