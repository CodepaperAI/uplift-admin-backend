import { describe, expect, it } from "bun:test";
import {
  estimateUsdFromTokens,
  GEMINI_25_FLASH_IMAGE_MODEL,
  GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE,
  sumUsageFromLcMessages,
} from "../services/llm-usage.service";

describe("LLM usage cost estimation", () => {
  it("uses the current GPT-5 mini and GPT-5.4 mini token rates", () => {
    expect(
      estimateUsdFromTokens("gpt-5-mini", 1_000_000, 1_000_000),
    ).toBe(2.25);
    expect(
      estimateUsdFromTokens("gpt-5.4-mini", 1_000_000, 1_000_000),
    ).toBe(5.25);
  });

  it("uses the current GPT-5.6 Luna token rates", () => {
    expect(
      estimateUsdFromTokens("gpt-5.6-luna", 1_000_000, 1_000_000),
    ).toBe(1.4);
  });

  it("estimates Gemini 2.5 Flash Image output cost per generated image", () => {
    expect(
      estimateUsdFromTokens(
        GEMINI_25_FLASH_IMAGE_MODEL,
        0,
        GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE,
      ),
    ).toBe(0.0387);
  });

  it("estimates the current three-image blog generation cost", () => {
    expect(
      estimateUsdFromTokens(
        GEMINI_25_FLASH_IMAGE_MODEL,
        0,
        GEMINI_25_FLASH_IMAGE_OUTPUT_TOKENS_PER_IMAGE * 3,
      ),
    ).toBe(0.1161);
  });

  it("estimates Qwen 3.7 Plus Together text generation cost", () => {
    expect(estimateUsdFromTokens("Qwen/Qwen3.7-Plus", 1_000_000, 1_000_000)).toBe(
      1.6,
    );
  });

  it("estimates current Together replacement candidate costs", () => {
    expect(
      estimateUsdFromTokens(
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        1_000_000,
        1_000_000,
      ),
    ).toBe(2.08);
    expect(
      estimateUsdFromTokens(
        "openai/gpt-oss-120b",
        1_000_000,
        1_000_000,
      ),
    ).toBe(0.75);
    expect(
      estimateUsdFromTokens(
        "MiniMaxAI/MiniMax-M3",
        1_000_000,
        1_000_000,
      ),
    ).toBe(1.5);
    expect(
      estimateUsdFromTokens(
        "deepseek-ai/DeepSeek-V4-Pro",
        1_000_000,
        1_000_000,
      ),
    ).toBe(5.22);
    expect(
      estimateUsdFromTokens(
        "nvidia/nemotron-3-ultra-550b-a55b",
        1_000_000,
        1_000_000,
      ),
    ).toBe(4.2);
  });
});

describe("LangChain usage extraction", () => {
  it("extracts Together/OpenAI-compatible usage metadata", () => {
    const usage = sumUsageFromLcMessages([
      {
        response_metadata: {
          model: "Qwen/Qwen3.7-Plus",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
          },
        },
      },
    ]);

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      model: "Qwen/Qwen3.7-Plus",
    });
  });

  it("falls back to response metadata when LangChain usage metadata is partial", () => {
    const usage = sumUsageFromLcMessages([
      {
        usage_metadata: {
          input_tokens: 50,
        },
        response_metadata: {
          model_name: "Qwen/Qwen3.7-Plus",
          usage: {
            completion_tokens: 20,
            total_tokens: 70,
          },
        },
      },
    ]);

    expect(usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      model: "Qwen/Qwen3.7-Plus",
    });
  });
});
