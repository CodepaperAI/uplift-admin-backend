import { z } from "zod";

const anthropicMessageResponse = z
  .object({
    model: z.string().min(1),
    stop_reason: z.string().nullable(),
    content: z.array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type AnthropicStructuredOutputInput = {
  apiKey: string;
  model: string;
  system: string;
  input: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
};

export async function requestAnthropicStructuredOutput(
  input: AnthropicStructuredOutputInput,
): Promise<{ value: unknown; model: string }> {
  if (!input.apiKey.trim()) throw new Error("Anthropic is not configured");
  if (!input.model.trim()) throw new Error("Anthropic model is not configured");

  const response = await (input.fetchImpl ?? fetch)(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": input.apiKey.trim(),
        "Anthropic-Version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.model.trim(),
        max_tokens: input.maxTokens ?? 2_500,
        system: input.system,
        messages: [{ role: "user", content: input.input }],
        output_config: {
          format: {
            type: "json_schema",
            schema: input.schema,
          },
        },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Anthropic request failed (${response.status})`);
  }

  const parsed = anthropicMessageResponse.parse(await response.json());
  if (parsed.stop_reason === "max_tokens") {
    throw new Error("Anthropic response exceeded the output limit");
  }
  const text = parsed.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned no structured output");

  return { value: JSON.parse(text), model: parsed.model };
}
