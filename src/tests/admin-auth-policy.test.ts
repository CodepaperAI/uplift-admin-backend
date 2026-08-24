import { describe, expect, test } from "bun:test";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  ADMIN_AUTH_SURFACE,
  adminTrustedOrigins,
  commandMfaAssuranceMaxAgeSeconds,
  internalPasswordError,
  isCurrentMfaAssurance,
  isMfaVerificationPath,
  requireSuperadminMfa,
  resolveInternalAuthSecret,
} from "../auth/admin-auth-policy";

describe("backend-owned admin authentication policy", () => {
  test("uses a separate admin session surface", () => {
    expect(ADMIN_AUTH_SURFACE).toBe("admin");
  });

  test("accepts both canonical and production Vercel admin origins", () => {
    const origins = adminTrustedOrigins({
      ADMIN_FRONTEND_URL: "https://admin.upliftai.co/some/path",
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://admin-partner.example,not-a-valid-url",
    });

    expect(origins).toContain("https://admin.upliftai.co");
    expect(origins).toContain("https://uplift-ai-admin.vercel.app");
    expect(origins).toContain("https://admin-partner.example");
    expect(origins).not.toContain("not-a-valid-url");
  });

  test("keeps admin sessions persistent and bounds MFA assurance configuration", () => {
    expect(ADMIN_SESSION_MAX_AGE_SECONDS).toBe(34_560_000);
    expect(commandMfaAssuranceMaxAgeSeconds(undefined)).toBe(43_200);
    expect(commandMfaAssuranceMaxAgeSeconds("1")).toBe(300);
  });

  test("keeps superadmin MFA off unless it is explicitly enabled", () => {
    expect(requireSuperadminMfa(undefined, "production")).toBe(false);
    expect(requireSuperadminMfa(undefined, "development")).toBe(false);
    expect(requireSuperadminMfa("false", "production")).toBe(false);
    expect(requireSuperadminMfa("true", "production")).toBe(true);
  });

  test("accepts MFA assurance only from verification sessions within age", () => {
    const now = Date.now();
    expect(isMfaVerificationPath("/two-factor/verify-totp")).toBe(true);
    expect(isMfaVerificationPath("/sign-in/email")).toBe(false);
    expect(isCurrentMfaAssurance(new Date(now - 1_000), now, 60)).toBe(true);
    expect(isCurrentMfaAssurance(new Date(now - 61_000), now, 60)).toBe(false);
    expect(isCurrentMfaAssurance(new Date(now + 31_000), now, 60)).toBe(false);
  });

  test("enforces strong production secrets and passwords", () => {
    expect(() => resolveInternalAuthSecret("short", "production")).toThrow();
    expect(
      resolveInternalAuthSecret("a-strong-admin-auth-secret-with-32-bytes", "production"),
    ).toContain("strong-admin");
    expect(internalPasswordError("Valid-Password9")).toBeNull();
    expect(internalPasswordError("weakpassword")).not.toBeNull();
  });
});
