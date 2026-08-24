import { describe, expect, it } from "bun:test";
import {
  SALES_AUTH_COOKIE_PREFIX,
  SALES_AUTH_SURFACE,
  resolveSalesAuthSecret,
  salesPasswordError,
  salesTrustedOrigins,
} from "../auth/sales-auth-policy";

describe("backend-owned sales authentication policy", () => {
  it("uses an isolated sales cookie and session audience", () => {
    expect(SALES_AUTH_COOKIE_PREFIX).toBe("uplift-sales");
    expect(SALES_AUTH_SURFACE).toBe("sales");
  });

  it("preserves the existing strong sales password policy", () => {
    expect(salesPasswordError("short")).not.toBeNull();
    expect(salesPasswordError("LongEnoughWithoutNumber!")).not.toBeNull();
    expect(salesPasswordError("LongEnoughPassword1!")).toBeNull();
  });

  it("requires a strong production secret and normalizes trusted origins", () => {
    expect(() => resolveSalesAuthSecret("short", "production")).toThrow();
    expect(resolveSalesAuthSecret("x".repeat(32), "production")).toBe(
      "x".repeat(32),
    );
    expect(salesTrustedOrigins()).toContain("http://localhost:3003");
    expect(salesTrustedOrigins()).toContain("https://sales.upliftai.co");
  });
});
