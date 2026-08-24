import { describe, expect, it } from "bun:test";
import { getResendSubmissionId } from "../controllers/guest-posting.controller";

describe("Resend webhook tag extraction", () => {
  it("accepts the current Resend record shape", () => {
    expect(getResendSubmissionId({ submission_id: "submission-123" })).toBe(
      "submission-123",
    );
  });

  it("keeps compatibility with the legacy array shape", () => {
    expect(
      getResendSubmissionId([
        { name: "category", value: "outreach" },
        { name: "submission_id", value: "submission-456" },
      ]),
    ).toBe("submission-456");
  });

  it("rejects missing and non-string submission identifiers", () => {
    expect(getResendSubmissionId({ category: "outreach" })).toBeUndefined();
    expect(getResendSubmissionId({ submission_id: 123 })).toBeUndefined();
    expect(getResendSubmissionId(null)).toBeUndefined();
  });
});
