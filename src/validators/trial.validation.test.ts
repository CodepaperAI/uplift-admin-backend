import { describe, expect, it } from "bun:test";
import { ENROLL_TRIAL } from "./trial.validation";

describe("ENROLL_TRIAL phone validation", () => {
  it("accepts E.164 phone numbers", () => {
    const result = ENROLL_TRIAL.safeParse({
      businessId: "business-1",
      phone: "+14165550123",
      businessDetails: { businessPhone: "+14165550123" },
    });

    expect(result.success).toBe(true);
  });

  it("trims the required signup phone and accepts an empty optional business phone", () => {
    const result = ENROLL_TRIAL.parse({
      businessId: "business-1",
      phone: "  +14165550123  ",
      businessDetails: { businessPhone: "   " },
    });

    expect(result.phone).toBe("+14165550123");
    expect(result.businessDetails?.businessPhone).toBeNull();
  });

  it("rejects text and national-only phone numbers", () => {
    expect(
      ENROLL_TRIAL.safeParse({
        businessId: "business-1",
        phone: "call-me-4165550123",
      }).success,
    ).toBe(false);
    expect(
      ENROLL_TRIAL.safeParse({
        businessId: "business-1",
        phone: "4165550123",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed nested business phone", () => {
    const result = ENROLL_TRIAL.safeParse({
      businessId: "business-1",
      phone: "+14165550123",
      businessDetails: { businessPhone: "416-555-0123" },
    });

    expect(result.success).toBe(false);
  });
});
