import { describe, expect, test } from "bun:test";

import { socialCreativeErrorMessage } from "../services/social-creative/error-message";

describe("social creative error messages", () => {
  test("extracts messages from provider error objects", () => {
    expect(
      socialCreativeErrorMessage({
        error: { message: "Cloud storage rejected the upload" },
      }),
    ).toBe("Cloud storage rejected the upload");
  });

  test("never persists object coercion as the failure reason", () => {
    expect(socialCreativeErrorMessage({ http_code: 400 })).toBe(
      '{"http_code":400}',
    );
    expect(socialCreativeErrorMessage({})).toBe(
      "Unknown social creative provider error",
    );
  });
});
