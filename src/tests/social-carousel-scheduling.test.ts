import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  assignWeeklySocialCarousels,
  socialCarouselLocalWeek,
  socialCreativeKindForTopic,
} from "../services/social-carousel-scheduling.service";

const linkedInOnlyId = "11111111-1111-4111-8111-111111111111";
const allPlatformsId = "22222222-2222-4222-8222-222222222222";

describe("durable weekly social carousel selection", () => {
  test("uses business-local Monday boundaries and only upgrades selected topics", () => {
    expect(
      socialCarouselLocalWeek({
        instant: new Date("2026-08-23T03:30:00.000Z"),
        timeZone: "America/Toronto",
      }),
    ).toMatchObject({ localDate: "2026-08-22", weekStart: "2026-08-17" });
    expect(
      socialCreativeKindForTopic({
        carouselEnabled: true,
        carouselAssignmentStatus: "SELECTED",
      }),
    ).toBe("carousel");
    expect(
      socialCreativeKindForTopic({
        carouselEnabled: false,
        carouselAssignmentStatus: "SELECTED",
      }),
    ).toBe("single");
  });

  test("persists one model selection per week and favors the broadest platform coverage", async () => {
    const requestInputs: any[] = [];
    const assignmentUpdates: any[] = [];
    const usageEvents: any[] = [];
    const prisma = {
      business: {
        findFirst: async () => ({
          id: "business-1",
          businessName: "Acme",
          businessType: "Consulting",
          socialAutomationSettings: { carouselEnabled: true },
        }),
      },
      socialTopicPlan: {
        findMany: async () => [
          {
            id: linkedInOnlyId,
            topic: "A Monday LinkedIn lesson",
            contentPillar: "Education",
            objective: "education",
            hook: "One useful idea",
            contentType: "educational",
            platforms: ["linkedin"],
            scheduledFor: new Date("2026-08-24T12:30:00.000Z"),
            timezone: "America/Toronto",
          },
          {
            id: allPlatformsId,
            topic: "A connected practical framework",
            contentPillar: "Education",
            objective: "education",
            hook: "A sequence worth saving",
            contentType: "educational",
            platforms: ["instagram", "facebook", "linkedin", "x"],
            scheduledFor: new Date("2026-08-25T13:00:00.000Z"),
            timezone: "America/Toronto",
          },
        ],
      },
      socialCarouselWeekAssignment: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async ({ data }: any) => ({
          id: "assignment-1",
          ...data,
          updatedAt: new Date("2026-08-21T12:00:00.000Z"),
        }),
        update: async (input: any) => {
          assignmentUpdates.push(input);
          return input.data;
        },
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const client = {
      responses: {
        create: async (request: any) => {
          requestInputs.push(JSON.parse(request.input));
          return {
            id: "resp-selector-1",
            status: "completed",
            output_text: JSON.stringify({
              topicPlanId: allPlatformsId,
              educationalAngle: "Teach a connected and practical framework.",
              audienceTakeaway: "Readers leave with steps they can apply.",
              reason: "The topic supports a useful multi-slide sequence.",
            }),
            usage: {
              input_tokens: 120,
              output_tokens: 80,
              total_tokens: 200,
            },
          };
        },
      },
    };

    const result = await assignWeeklySocialCarousels({
      businessId: "business-1",
      userId: "user-1",
      now: new Date("2026-08-21T12:00:00.000Z"),
      prisma,
      client,
      recordUsage: (async (event: any) => {
        usageEvents.push(event);
      }) as any,
    });

    expect(result).toEqual({ assigned: 1, assignments: ["assignment-1"] });
    expect(requestInputs[0].candidates).toHaveLength(1);
    expect(requestInputs[0].candidates[0]).toMatchObject({
      id: allPlatformsId,
      supportedPlatforms: ["instagram", "facebook", "linkedin"],
    });
    expect(assignmentUpdates[0]).toMatchObject({
      where: { id: "assignment-1" },
      data: {
        status: "SELECTED",
        selectedTopicPlanId: allPlatformsId,
        responseId: "resp-selector-1",
        totalTokens: 200,
      },
    });
    expect(usageEvents[0]).toMatchObject({
      purpose: "social_creative",
      model: "gpt-5.6-luna",
      metadata: {
        stage: "social_carousel_week_selector",
        assignmentId: "assignment-1",
      },
    });
  });
});
