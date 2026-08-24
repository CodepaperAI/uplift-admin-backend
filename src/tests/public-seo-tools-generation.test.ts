import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { LLM_MODELS } from "../config/llm.config";
import {
  PublicToolGenerationError,
  generateStructuredArray,
} from "../controllers/public-seo-tools.controller";

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

const blogIdeaSchema = z.array(
  z.object({
    title: z.string().min(1),
    intent: z.enum(["informational", "commercial", "transactional", "how-to"]),
    difficulty: z.enum(["easy", "medium", "hard"]),
    description: z.string().min(1),
  }),
);

const repairHint =
  "Each idea needs a 50-70 character title, one allowed intent, one allowed difficulty, and a useful one-sentence description.";
const userFailureMessage =
  "We couldn't generate a strong enough set of blog ideas for this topic right now. Try broadening or slightly rephrasing the topic, correcting any wording, or try again in a moment.";

function createIdea(overrides?: Partial<z.infer<typeof blogIdeaSchema>[number]>) {
  return {
    title: `Idea-${"a".repeat(52)}`,
    intent: "commercial" as const,
    difficulty: "medium" as const,
    description:
      "This is a polished one-sentence description for a premium blog concept.",
    ...overrides,
  };
}

function isValidIdea(item: z.infer<typeof blogIdeaSchema>[number]) {
  return (
    item.title.length >= 50 &&
    item.title.length <= 70 &&
    item.description.length >= 45
  );
}

function createOpenAISuccessResponse(items: unknown[]) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(items) } }],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
});

describe("public SEO tool structured generation", () => {
  it("falls back to the stronger blog ideas model when the first validated set is too weak", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const requestedModels: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      requestedModels.push(payload.model ?? "");

      if (requestedModels.length === 1) {
        return createOpenAISuccessResponse([
          createIdea({
            title: "Too short",
            description: "Also too short.",
          }),
        ]);
      }

      return createOpenAISuccessResponse(
        Array.from({ length: 6 }, (_, index) =>
          createIdea({
            title: `Idea ${index + 1} ${"b".repeat(50)}`,
          }),
        ),
      );
    }) as typeof globalThis.fetch;

    const results = await generateStructuredArray({
      prompt: "Generate blog ideas",
      repairHint,
      schema: blogIdeaSchema,
      maxTokens: 1200,
      minimumCount: 6,
      desiredCount: 10,
      fallbackModel: LLM_MODELS.GPT5_MINI,
      userFailureMessage,
      validateItem: isValidIdea,
    });

    expect(results).toHaveLength(6);
    expect(requestedModels).toEqual([
      LLM_MODELS.GPT5_MINI,
      LLM_MODELS.GPT5_MINI,
    ]);
  });

  it("returns a user-safe validation error instead of leaking the repair hint", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    globalThis.fetch = (async () =>
      createOpenAISuccessResponse([
        createIdea({
          title: "Short title",
          description: "Short description.",
        }),
      ])) as unknown as typeof globalThis.fetch;

    await expect(
      generateStructuredArray({
        prompt: "Generate blog ideas",
        repairHint,
        schema: blogIdeaSchema,
        maxTokens: 1200,
        minimumCount: 6,
        fallbackModel: LLM_MODELS.GPT5_MINI,
        userFailureMessage,
        validateItem: isValidIdea,
      }),
    ).rejects.toMatchObject({
      name: "PublicToolGenerationError",
      code: "insufficient_valid_results",
      userMessage: userFailureMessage,
      statusCode: 422,
    } satisfies Partial<PublicToolGenerationError>);
  });

  it("maps provider transport failures to a descriptive provider error", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      generateStructuredArray({
        prompt: "Generate blog ideas",
        repairHint,
        schema: blogIdeaSchema,
        maxTokens: 1200,
        minimumCount: 6,
        fallbackModel: LLM_MODELS.GPT5_MINI,
        userFailureMessage,
        validateItem: isValidIdea,
      }),
    ).rejects.toMatchObject({
      name: "PublicToolGenerationError",
      code: "provider_failure",
      userMessage:
        "The AI writing service is temporarily unavailable. Please try again in a moment.",
      statusCode: 503,
    } satisfies Partial<PublicToolGenerationError>);
  });
});
