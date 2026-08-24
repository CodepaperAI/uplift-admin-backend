import { afterEach, describe, expect, it } from "bun:test";
import {
  dashboardAuthIpHeaders,
  canonicalAuthEmailUrl,
  DASHBOARD_EMAIL_VERIFICATION_POLICY,
  dashboardFullNameError,
  dashboardPasswordError,
  dashboardPhoneError,
  dashboardTrustedOrigins,
} from "../auth/dashboard-auth-policy";

const originalOrigins = process.env.CORS_ALLOWED_ORIGINS;
const originalNodeEnv = process.env.NODE_ENV;
const originalDashboardUrl = process.env.DASHBOARD_URL;
const originalFrontendUrl = process.env.FRONTEND_URL;
const originalPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (originalOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = originalOrigins;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
  else process.env.DASHBOARD_URL = originalDashboardUrl;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
  if (originalPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalPublicAppUrl;
});

describe("dashboard auth policy", () => {
  it("uses the validated forwarded client address by default", () => {
    expect(dashboardAuthIpHeaders("")).toEqual(["x-forwarded-for"]);
    expect(dashboardAuthIpHeaders(" X-Real-IP, X-Forwarded-For ")).toEqual([
      "x-real-ip",
      "x-forwarded-for",
    ]);
  });
  it("keeps email verification optional for dashboard sign-in", () => {
    expect(DASHBOARD_EMAIL_VERIFICATION_POLICY).toEqual({
      requireEmailVerification: false,
      sendOnSignUp: true,
      sendOnSignIn: false,
    });
  });

  it("preserves the dashboard password, name, and phone constraints", () => {
    expect(dashboardPasswordError("short")).toContain("at least 15");
    expect(dashboardPasswordError("correct horse battery staple")).toBeNull();
    expect(dashboardFullNameError("\u0000invalid")).not.toBeNull();
    expect(dashboardFullNameError("Example Person")).toBeNull();
    expect(dashboardPhoneError("+14165550123")).toBeNull();
    expect(dashboardPhoneError("555")).not.toBeNull();
  });

  it("keeps localhost authentication links usable in local development", () => {
    process.env.NODE_ENV = "development";
    process.env.FRONTEND_URL = "http://localhost:3001";
    expect(
      canonicalAuthEmailUrl(
        "http://localhost:3001/api/auth/verify-email?token=test&callbackURL=%2Fsign-in",
      ),
    ).toBe(
      "http://localhost:3001/api/auth/verify-email?token=test&callbackURL=%2Fsign-in",
    );
  });

  it("never emits localhost authentication links from production", () => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "http://localhost:3001";
    expect(
      canonicalAuthEmailUrl(
        "http://localhost:3001/api/auth/verify-email?token=test&callbackURL=%2Fsign-in",
      ),
    ).toBe(
      "https://dashboard.upliftai.co/api/auth/verify-email?token=test&callbackURL=%2Fsign-in",
    );
  });

  it("preserves configured non-local deployment authentication links", () => {
    process.env.NODE_ENV = "development";
    process.env.FRONTEND_URL = "https://xmedia.upliftai.co";
    expect(
      canonicalAuthEmailUrl(
        "https://xmedia.upliftai.co/api/auth/verify-email?token=test",
      ),
    ).toBe("https://xmedia.upliftai.co/api/auth/verify-email?token=test");
  });

  it("accepts only normalized HTTP origins from configured deployment origins", () => {
    process.env.CORS_ALLOWED_ORIGINS =
      "https://xmedia.upliftai.co, javascript:alert(1), not-a-url";
    const origins = dashboardTrustedOrigins();
    expect(origins).toContain("https://xmedia.upliftai.co");
    expect(origins.some((origin) => origin.startsWith("javascript:"))).toBe(false);
  });
});
