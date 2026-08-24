import { describe, expect, test } from "bun:test";
import { requestAnthropicStructuredOutput } from "../command/anthropic-structured-output";

describe("Command Anthropic structured output", () => {
  test("uses the Messages API JSON-schema contract without retaining transcript data", async () => {
    const captured: Request[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      captured.push(new Request(input, init));
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: '{"ok":true}' }],
      });
    };

    const result = await requestAnthropicStructuredOutput({
      apiKey: "test-key",
      model: "claude-sonnet-4-5",
      system: "Return the schema.",
      input: "untrusted transcript",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
      fetchImpl,
    });

    expect(result.value).toEqual({ ok: true });
    const request = captured[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("x-api-key")).toBe("test-key");
    const body = (await request?.json()) as Record<string, unknown>;
    expect(body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
    });
  });

  test("fails safely when Anthropic returns malformed JSON", async () => {
    const fetchImpl = async () =>
      Response.json({
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "not-json" }],
      });
    await expect(
      requestAnthropicStructuredOutput({
        apiKey: "test-key",
        model: "claude-sonnet-4-5",
        system: "Return JSON.",
        input: "input",
        schema: { type: "object" },
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
