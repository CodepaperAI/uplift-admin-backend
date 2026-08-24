import { describe, expect, test } from "bun:test";

import {
  planSocialCarouselNarrative,
  SOCIAL_CAROUSEL_PLAN_VERSION,
} from "../services/social-creative/carousel-planner";

describe("prompt-led social carousel narrative", () => {
  test("returns one durable educational sequence with usage and no editorial rewriting", async () => {
    const requests: Array<{
      request: Record<string, any>;
      options?: { idempotencyKey?: string };
    }> = [];
    const slides = Array.from({ length: 5 }, (_, index) => ({
      headline: `Useful lesson ${index + 1}`,
      supportingLine: `A grounded explanation for lesson ${index + 1}`,
      visualConcept: `An informative and distinct business visual for lesson ${index + 1}`,
      cta: index === 4 ? "Explore the verified service" : "",
    }));
    const client = {
      responses: {
        create: async (request: Record<string, any>, options?: any) => {
          requests.push({ request, options });
          return {
            id: "resp-carousel-1",
            status: "completed",
            output_text: JSON.stringify({
              creativeDirection:
                "Use one coherent visual system with consistent hierarchy and connected motifs.",
              slides,
            }),
            usage: {
              input_tokens: 240,
              output_tokens: 160,
              total_tokens: 400,
            },
          };
        },
      },
    };

    const result = await planSocialCarouselNarrative(
      {
        context: {
          businessName: "Acme Advisory",
          businessType: "Consulting",
          businessDescription: "Practical advisory for growing teams.",
          targetAudience: "Operations leaders",
          city: "Toronto",
          state: "Ontario",
          country: "Canada",
          language: "English",
          locale: "en-CA",
          services: ["Operational planning"],
          keyMessages: ["Clear plans support better decisions"],
          differentiators: ["Practical guidance"],
          customerPainPoints: ["Unclear priorities"],
          verifiedActions: ["Explore the verified service"],
        } as any,
        topic: "How to turn unclear priorities into an operating plan",
        hook: "Five connected lessons for operations leaders",
        cta: "Explore the verified service",
        objective: "education",
        idempotencyKey: "carousel-plan:test",
      },
      { client },
    );

    expect(result.slides).toEqual(slides);
    expect(result.usage).toMatchObject({
      responseId: "resp-carousel-1",
      inputTokens: 240,
      outputTokens: 160,
      totalTokens: 400,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.options?.idempotencyKey).toBe("carousel-plan:test");
    expect(requests[0]?.request.model).toBe("gpt-5.6-luna");
    expect(requests[0]?.request.instructions).toContain(
      "not a set of repeated single-post advertisements",
    );
    expect(requests[0]?.request.instructions).toContain(
      "Choose between four and six slides",
    );
    expect(SOCIAL_CAROUSEL_PLAN_VERSION).toBe(
      "social-carousel-educational-v1",
    );
  });
});
