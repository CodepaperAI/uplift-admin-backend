import { describe, expect, test } from "bun:test";

import {
  publicSocialTopicInitialization,
  safeSocialTopicInitializationError,
} from "../services/social-topic-initialization.service";

describe("social topic initialization state", () => {
  test("reports a persisted planning state without exposing internals", () => {
    expect(
      publicSocialTopicInitialization({
        initialPlanStatus: "planning",
        initialPlanQueuedAt: new Date("2026-08-12T20:00:00.000Z"),
        initialPlanStartedAt: new Date("2026-08-12T20:00:03.000Z"),
      }),
    ).toEqual({
      status: "planning",
      queuedAt: "2026-08-12T20:00:00.000Z",
      startedAt: "2026-08-12T20:00:03.000Z",
      completedAt: null,
      error: null,
    });
  });

  test("treats generated legacy settings as ready", () => {
    expect(
      publicSocialTopicInitialization({
        initialPlanStatus: "not_started",
        initialPlanGeneratedAt: new Date("2026-08-12T20:05:00.000Z"),
      }).status,
    ).toBe("ready");
  });

  test("maps provider details to a safe actionable failure", () => {
    expect(
      safeSocialTopicInitializationError(
        new Error("OpenAI request rejected with private provider detail"),
      ),
    ).toEqual({
      code: "SOCIAL_INITIALIZATION_FAILED",
      message:
        "We couldn't prepare your first social plan. Please retry, or contact support if the problem continues.",
    });
  });
});
