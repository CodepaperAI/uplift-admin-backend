import { describe, expect, it } from "bun:test";

import {
  GET_ONBOARDING_V2_PREVIEW,
  GET_ONBOARDING_V2_STATE,
  mergeOnboardingV2Author,
  mergeOnboardingV2Answers,
  PATCH_ONBOARDING_V2_STATE,
  START_ONBOARDING_V2_GENERATION,
  UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE,
} from "./quick-scrape.validation";

const businessId = "26338194-2831-4525-b616-99bf6402d9da";

describe("onboarding-v2 state validation", () => {
  it("allows an empty state query for resume and validates explicit IDs", () => {
    expect(GET_ONBOARDING_V2_STATE.safeParse({}).success).toBe(true);
    expect(GET_ONBOARDING_V2_STATE.safeParse({ businessId }).success).toBe(true);
    expect(GET_ONBOARDING_V2_STATE.safeParse({ businessId: "not-an-id" }).success).toBe(
      false,
    );
  });

  it("accepts a bounded partial autosave payload", () => {
    const parsed = PATCH_ONBOARDING_V2_STATE.parse({
      businessId,
      step: "questions",
      questionIndex: 2,
      answers: {
        a3_voice: ["professional"],
        a5_content: ["guides", "guides", "how-to"],
      },
      status: "in_progress",
    });

    expect(parsed.answers?.a5_content).toEqual(["guides", "how-to"]);
  });

  it("does not let the browser mark onboarding completed", () => {
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        status: "completed",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown answer keys and empty patches", () => {
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        answers: { unexpected: ["value"] },
      }).success,
    ).toBe(false);
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        answers: { a3_voice: ["made-up-tone"] },
      }).success,
    ).toBe(false);
    expect(PATCH_ONBOARDING_V2_STATE.safeParse({ businessId }).success).toBe(false);
  });

  it("requires a business ID for generation and preview polling", () => {
    expect(
      START_ONBOARDING_V2_GENERATION.safeParse({ businessId }).success,
    ).toBe(true);
    expect(START_ONBOARDING_V2_GENERATION.safeParse({}).success).toBe(false);
    expect(GET_ONBOARDING_V2_PREVIEW.safeParse({ businessId }).success).toBe(true);
    expect(GET_ONBOARDING_V2_PREVIEW.safeParse({}).success).toBe(false);
    expect(
      UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE.safeParse({ businessId }).success,
    ).toBe(true);
    expect(UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE.safeParse({}).success).toBe(false);
  });

  it("merges partial answers and reports revisions only for real changes", () => {
    const first = mergeOnboardingV2Answers(
      { a3_voice: ["professional"] },
      { a2_audience: ["local"] },
    );
    expect(first.changed).toBe(true);
    expect(first.answers).toEqual({
      a3_voice: ["professional"],
      a2_audience: ["local"],
    });
    expect(
      mergeOnboardingV2Answers(first.answers, { a2_audience: ["local"] }).changed,
    ).toBe(false);
  });

  it("requires E.164 phone numbers on the v2 contact autosave", () => {
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        businessDetails: { businessPhone: "+16478679760" },
      }).success,
    ).toBe(true);
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        businessDetails: { businessPhone: "(647) 867-9760" },
      }).success,
    ).toBe(false);
    expect(
      PATCH_ONBOARDING_V2_STATE.parse({
        businessId,
        businessDetails: { businessPhone: "   " },
      }).businessDetails?.businessPhone,
    ).toBeNull();
  });

  it("does not allow PATCH to persist an unverified author image URL", () => {
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        author: {
          imageUrl: "https://untrusted.example/author.png",
        },
      }).success,
    ).toBe(false);
    expect(
      PATCH_ONBOARDING_V2_STATE.safeParse({
        businessId,
        author: { imageName: "filename-only.png" },
      }).success,
    ).toBe(false);
  });

  it("preserves endpoint-owned image fields when author metadata is patched", () => {
    expect(
      mergeOnboardingV2Author(
        {
          name: "Original author",
          imageName: "verified.png",
          imageUrl: "https://uplift-ai-images.b-cdn.net/verified.png",
        },
        {
          name: "Updated author",
          title: "Founder",
        },
      ),
    ).toEqual({
      name: "Updated author",
      title: "Founder",
      imageName: "verified.png",
      imageUrl: "https://uplift-ai-images.b-cdn.net/verified.png",
    });
  });
});
