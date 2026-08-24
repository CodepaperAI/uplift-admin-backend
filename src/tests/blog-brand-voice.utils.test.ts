import { describe, expect, it } from "bun:test";
import {
  buildBrandVoicePromptBlock,
  resolveBrandVoiceGuidance,
} from "../utils/blog-brand-voice.utils";

describe("blog brand voice", () => {
  it("returns empty output when no tone is configured", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(buildBrandVoicePromptBlock(v)).toBe("");
      expect(resolveBrandVoiceGuidance(v)).toBeNull();
    }
  });

  it("maps known tones to concrete, distinct guidance", () => {
    const professional = buildBrandVoicePromptBlock("professional");
    const playful = buildBrandVoicePromptBlock("playful");
    expect(professional).toContain("BRAND VOICE (MANDATORY");
    expect(professional.toLowerCase()).toContain("professional");
    expect(professional).toMatch(/authoritative|polished|precise/i);
    // Different tones must produce different directives.
    expect(playful).not.toBe(professional);
    expect(playful.toLowerCase()).toContain("playful");
    expect(playful).toMatch(/witty|humour|energetic/i);
  });

  it("is case-insensitive and trims", () => {
    expect(resolveBrandVoiceGuidance("  Professional  ")).toBe(
      resolveBrandVoiceGuidance("professional"),
    );
  });

  it("keeps inspirational writing concrete instead of licensing AI slogans", () => {
    const guidance = resolveBrandVoiceGuidance("inspirational") ?? "";
    expect(guidance).toMatch(/concrete|clear choices/i);
    expect(guidance).toMatch(/never slogans|journey language/i);
    expect(guidance).not.toContain("distinctly inspirational");
  });

  it("resolves compound/aliased tones via substring match", () => {
    // e.g. "professional / authoritative" still resolves to a real directive.
    expect(resolveBrandVoiceGuidance("professional-authoritative")).toContain(
      "Authoritative",
    );
  });

  it("falls back to a generic directive for unknown tones", () => {
    const block = buildBrandVoicePromptBlock("whimsical");
    expect(block).toContain("BRAND VOICE (MANDATORY");
    expect(block.toLowerCase()).toContain("whimsical");
  });

  it("always states it governs style only, never facts", () => {
    expect(buildBrandVoicePromptBlock("bold")).toMatch(
      /never permits inventing facts/i,
    );
  });
});
