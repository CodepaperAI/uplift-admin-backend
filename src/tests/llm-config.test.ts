import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChatOpenAI } from "@langchain/openai";

import {
  createBlogJudgeModel,
  createStrategistModel,
  getLLMForBlogs,
  getLLMForKeywords,
  getLLMForSeoAudit,
  isGroundedBlogWriterContractEnabled,
  LLM_MODELS,
  SEO_AUDIT_MODEL_NAME,
} from "../config/llm.config";

const ENV_KEYS = [
  "BLOG_CRITIQUE_JUDGE_MODEL",
  "BLOG_STRATEGIST_MODEL",
  "BLOG_GROUNDED_WRITER_CONTRACT_ENABLED",
] as const;

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("LLM runtime config", () => {
  it("uses GPT-5.6 Luna for quick onboarding blog generation", () => {
    const model = getLLMForBlogs() as unknown as { model: string };
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model.model).toBe(LLM_MODELS.GPT56_LUNA);
  });

  it("uses GPT-5 mini for keyword generation", () => {
    const model = getLLMForKeywords() as unknown as { model: string };
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model.model).toBe(LLM_MODELS.GPT5_MINI);
  });

  it("uses GPT-5.6 Luna through OpenAI for SEO audits", () => {
    const model = getLLMForSeoAudit() as unknown as { model: string };
    expect(SEO_AUDIT_MODEL_NAME).toBe(LLM_MODELS.GPT56_LUNA);
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model.model).toBe(LLM_MODELS.GPT56_LUNA);
  });

  it("keeps the legacy grounded-contract setting isolated from production v2", () => {
    expect(isGroundedBlogWriterContractEnabled()).toBe(true);
    process.env.BLOG_GROUNDED_WRITER_CONTRACT_ENABLED = "false";
    expect(isGroundedBlogWriterContractEnabled()).toBe(false);
  });

  it("uses GPT-5.6 Luna through OpenAI for the expert-voice judge", () => {
    const judge = createBlogJudgeModel() as unknown as {
      model: string;
      temperature?: number;
    };
    expect(judge).toBeInstanceOf(ChatOpenAI);
    expect(judge.model).toBe(LLM_MODELS.GPT56_LUNA);
  });

  it("does not re-enable Anthropic through a legacy judge override", () => {
    process.env.BLOG_CRITIQUE_JUDGE_MODEL = "claude-sonnet-4-6";
    const judge = createBlogJudgeModel() as unknown as { model: string };
    expect(judge).toBeInstanceOf(ChatOpenAI);
    expect(judge.model).toBe(LLM_MODELS.GPT56_LUNA);
  });

  it("uses GPT-5.6 Luna through OpenAI for the strategist", () => {
    const strategist = createStrategistModel() as unknown as { model: string };
    expect(strategist).toBeInstanceOf(ChatOpenAI);
    expect(strategist.model).toBe(LLM_MODELS.GPT56_LUNA);
  });

  it("does not re-enable Anthropic through a legacy strategist override", () => {
    process.env.BLOG_STRATEGIST_MODEL = "claude-sonnet-4-6";
    const strategist = createStrategistModel() as unknown as { model: string };
    expect(strategist).toBeInstanceOf(ChatOpenAI);
    expect(strategist.model).toBe(LLM_MODELS.GPT56_LUNA);
  });
});
