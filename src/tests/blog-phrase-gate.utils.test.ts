import { describe, expect, it } from "bun:test";
import {
  BANNED_PHRASES,
  buildBannedPhraseRevisionMessage,
  buildBannedPhrasesPromptBlock,
  findBannedPhrases,
} from "../utils/blog-phrase-gate.utils";

describe("findBannedPhrases", () => {
  it("returns empty for malformed / missing input (total, never throws)", () => {
    expect(findBannedPhrases(undefined)).toEqual([]);
    expect(findBannedPhrases(null)).toEqual([]);
    expect(findBannedPhrases(123)).toEqual([]);
    expect(findBannedPhrases("")).toEqual([]);
    expect(findBannedPhrases({})).toEqual([]);
  });

  it("returns empty for clean, specific copy", () => {
    const clean =
      "We cater shawarma platters for groups of 10 to 200 from our College Street kitchen. " +
      "A chicken shawarma platter feeds eight and includes garlic sauce, pickled turnip, and rice.";
    expect(findBannedPhrases(clean)).toEqual([]);
  });

  it("flags the exact AI-slop crutches from the live post", () => {
    const slop =
      "Here's the thing: catering is hard. Let's be honest, it's stressful. " +
      "The bottom line is you need help. In today's competitive market, you might be wondering how.";
    const hits = findBannedPhrases(slop);
    const labels = hits.map((h) => h.label);
    expect(labels).toContain("here's the thing");
    expect(labels).toContain("let's be honest");
    expect(labels).toContain("the bottom line");
    expect(labels).toContain("you might be wondering");
    expect(labels.some((l) => l.startsWith("in today's"))).toBe(true);
  });

  it("counts repeated occurrences of the same phrase", () => {
    const text = "When it comes to catering. When it comes to pricing. When it comes to delivery.";
    const hit = findBannedPhrases(text).find((h) => h.label === "when it comes to");
    expect(hit?.count).toBe(3);
  });

  it("catches the 'think of X as your Y' metaphor pattern", () => {
    const text = "Think of your caterer as your secret weapon for stress-free hosting.";
    const labels = findBannedPhrases(text).map((h) => h.label);
    expect(labels).toContain('"think of X as your Y" metaphor');
  });

  it("strips HTML and matches phrases inside tags", () => {
    const html = "<h2>Catering</h2><p>At the end of the day, you need <strong>help</strong>.</p>";
    const labels = findBannedPhrases(html).map((h) => h.label);
    expect(labels).toContain("at the end of the day");
  });

  it("is case-insensitive", () => {
    const labels = findBannedPhrases("LOOK NO FURTHER than our kitchen.").map((h) => h.label);
    expect(labels).toContain("look no further");
  });

  it("is reentrant — repeated calls give stable results (no shared regex lastIndex)", () => {
    const text = "Here's the thing about catering.";
    const first = findBannedPhrases(text);
    const second = findBannedPhrases(text);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("prompt + revision helpers", () => {
  it("the prompt block lists every banned phrase", () => {
    const block = buildBannedPhrasesPromptBlock();
    for (const { label } of BANNED_PHRASES) {
      expect(block).toContain(label);
    }
  });

  it("the revision message names the offending phrases and counts", () => {
    const msg = buildBannedPhraseRevisionMessage([
      { label: "here's the thing", count: 2 },
      { label: "the bottom line", count: 1 },
    ]);
    expect(msg).toContain("here's the thing");
    expect(msg).toContain("2×");
    expect(msg).toContain("the bottom line");
    expect(msg.toLowerCase()).toContain("not saved");
  });
});
