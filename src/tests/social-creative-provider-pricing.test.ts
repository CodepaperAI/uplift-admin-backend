import { afterEach, describe, expect, test } from "bun:test";

import { generateSocialCreativeBackground } from "../services/social-creative/openai-image-provider";

const previousOpenAiKey = process.env.OPENAI_API_KEY;

function providerPng(width = 1024, height = 1280): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
  );
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

afterEach(() => {
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
});

describe("social creative GPT Image 2 usage accounting", () => {
  test("prices actual response tokens and preserves the provider usage receipt", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const providerBuffer = providerPng();
    let providerRequest: any;
    let providerHeaders: HeadersInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body ?? "{}"));
      providerHeaders = init?.headers;
      return (
      new Response(
        JSON.stringify({
          data: [
            { b64_json: providerBuffer.toString("base64") },
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { text_tokens: 80, image_tokens: 20 },
            output_tokens: 1_400,
            output_tokens_details: { image_tokens: 1_400, text_tokens: 0 },
            total_tokens: 1_500,
          },
        }),
        { status: 200, headers: { "x-request-id": "image-request-priced" } },
      )
      );
    }) as unknown as typeof fetch;

    const result = await generateSocialCreativeBackground(
      {
        prompt: "A text-free professional scene",
        targetSize: "1024x1280",
        idempotencyKey: "run-priced:asset-1",
      },
      { fetchImpl },
    );

    expect(result.providerRequestId).toBe("image-request-priced");
    expect(result.requested).toEqual({
      quality: null,
      sourceSize: "1024x1280",
      targetSize: "1024x1280",
      outputFormat: null,
    });
    expect(result.returned).toEqual({
      outputFormat: "png",
      mimeType: "image/png",
      width: 1024,
      height: 1280,
      source: "base64",
    });
    expect(providerRequest).toEqual({
      model: "gpt-image-2-2026-04-21",
      prompt: "A text-free professional scene",
      size: "1024x1280",
    });
    expect(new Headers(providerHeaders).get("Idempotency-Key")).toBe(
      "run-priced:asset-1",
    );
    expect(result.usage).toEqual({
      inputTokens: 100,
      inputTextTokens: 80,
      inputImageTokens: 20,
      outputTokens: 1_400,
      outputImageTokens: 1_400,
      totalTokens: 1_500,
    });
    expect(result.actualUsd).not.toBeNull();
    expect(result.actualUsd!).toBeCloseTo(0.04256, 8);
    expect(result.estimatedUsd).toBe(result.actualUsd!);
    expect(result.pricingVersion).toBe("openai-2026-08-08");
  });
});
