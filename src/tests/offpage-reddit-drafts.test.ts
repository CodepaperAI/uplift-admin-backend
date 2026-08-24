import { describe, expect, it } from "bun:test";
import { sanitizeRedditDraft } from "../llm/offpage/reddit-draft-safety";

describe("sanitizeRedditDraft", () => {
  it("keeps helpful value-first replies", () => {
    expect(
      sanitizeRedditDraft(
        "For a first pass, compare recent reviews and ask how they handle edge cases before choosing. If reliability matters, I would also check whether their support team responds with specific answers instead of canned replies.",
      ),
    ).toContain("compare recent reviews");
  });

  it("drops link-drop replies", () => {
    expect(
      sanitizeRedditDraft(
        "We can help with this. Visit https://example.com and book a call today.",
      ),
    ).toBeNull();
  });

  it("drops hard-sell replies even without links", () => {
    expect(
      sanitizeRedditDraft(
        "We are the best provider for this. Contact us today and schedule a demo.",
      ),
    ).toBeNull();
  });

  it("normalizes whitespace and caps long replies", () => {
    const draft = sanitizeRedditDraft(
      `This is useful context. ${"Focus on clear criteria before picking a vendor. ".repeat(30)}`,
    );
    expect(draft).not.toBeNull();
    expect(draft?.includes("  ")).toBe(false);
    expect(draft!.length).toBeLessThanOrEqual(700);
  });
});
