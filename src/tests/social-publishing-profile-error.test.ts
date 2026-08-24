import { describe, expect, test } from "bun:test";

import { publicSocialProfileError } from "../services/zernio/social-publishing.service";

describe("social publishing profile errors", () => {
  test("turns Zernio payment failures into an actionable customer message", () => {
    expect(publicSocialProfileError("PAYMENT_REQUIRED")).toEqual({
      code: "PAYMENT_REQUIRED",
      message:
        "A payment method is required in Zernio before another social account can be connected.",
    });
  });

  test("does not invent a profile error when no provider failure was recorded", () => {
    expect(publicSocialProfileError(null)).toBeNull();
  });

  test("does not expose an unknown stored provider message", () => {
    expect(publicSocialProfileError("UNEXPECTED_PROVIDER_DETAIL")).toEqual({
      code: "UNEXPECTED_PROVIDER_DETAIL",
      message:
        "The social publishing profile could not be prepared. Try connecting again, or contact support if the problem continues.",
    });
  });
});
