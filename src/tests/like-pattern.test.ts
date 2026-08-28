import { describe, expect, it } from "bun:test";
import { escapeLikePattern } from "../utils/like-pattern";

describe("escapeLikePattern", () => {
  it("leaves an ordinary term untouched", () => {
    expect(escapeLikePattern("sameer")).toBe("sameer");
    expect(escapeLikePattern("a.b-c@example.com")).toBe("a.b-c@example.com");
  });

  it("makes the single-character wildcard literal", () => {
    // `sa_a` matched 51 unrelated people on production before this.
    expect(escapeLikePattern("sa_a")).toBe("sa\\_a");
  });

  it("makes the multi-character wildcard literal", () => {
    // A bare `%` matched every row.
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
  });

  it("escapes backslash before the metacharacters, not after", () => {
    // Getting this order wrong turns a user's literal backslash into an escape
    // for whatever follows it.
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("a\\_b")).toBe("a\\\\\\_b");
  });

  it("handles a term that is only metacharacters", () => {
    expect(escapeLikePattern("%_%")).toBe("\\%\\_\\%");
  });

  it("is idempotent in effect, not in text — escaping twice is wrong", () => {
    // Documented so nobody applies it in two layers by accident.
    expect(escapeLikePattern(escapeLikePattern("a_b"))).toBe("a\\\\\\_b");
  });

  it("preserves an empty term", () => {
    expect(escapeLikePattern("")).toBe("");
  });
});
