import { describe, expect, it } from "bun:test";

import { USER_INPUT_LIMITS } from "../config/user-input-limits";
import {
  UPDATE_BUSINESS_AUTHOR_PROFILE,
  UPDATE_BUSINESS_PREFERENCES,
} from "../validators/business-onboarding.validation";
import { CREATE_CAMPAIGN } from "../validators/guest-posting.validation";
import { UPDATE_BLOG } from "../validators/blog.validation";

describe("user input validation limits", () => {
  it("rejects oversized target-audience settings", () => {
    const result = UPDATE_BUSINESS_PREFERENCES.safeParse({
      userId: "user-1",
      targetAudience: "a".repeat(USER_INPUT_LIMITS.targetAudience + 1),
    });

    expect(result.success).toBe(false);
  });

  it("accepts an author bio at the limit and rejects one over it", () => {
    const base = { authorName: "Author" };
    expect(
      UPDATE_BUSINESS_AUTHOR_PROFILE.safeParse({
        ...base,
        authorBio: "a".repeat(USER_INPUT_LIMITS.authorBio),
      }).success,
    ).toBe(true);
    expect(
      UPDATE_BUSINESS_AUTHOR_PROFILE.safeParse({
        ...base,
        authorBio: "a".repeat(USER_INPUT_LIMITS.authorBio + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects oversized guest-posting descriptions", () => {
    const result = CREATE_CAMPAIGN.safeParse({
      userId: "user-1",
      businessId: "business-1",
      name: "Campaign",
      description: "a".repeat(USER_INPUT_LIMITS.description + 1),
    });

    expect(result.success).toBe(false);
  });

  it("rejects oversized blog metadata without limiting normal article content", () => {
    expect(
      UPDATE_BLOG.safeParse({
        meta: {
          seo_description: "a".repeat(USER_INPUT_LIMITS.description + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      UPDATE_BLOG.safeParse({
        content: "a".repeat(USER_INPUT_LIMITS.longFormContent + 1),
      }).success,
    ).toBe(true);
  });
});
