import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isAllowedGoogleOAuthRedirect,
  signGoogleOAuthState,
  verifyGoogleOAuthState,
} from "../utils/google-oauth-state";

const originalStateSecret = process.env.GOOGLE_OAUTH_STATE_SECRET;
const originalBackendSecret = process.env.BACKEND_AUTH_SECRET;

describe("backend-owned Google OAuth state", () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_STATE_SECRET =
      "test-google-oauth-state-secret-at-least-32-bytes";
    delete process.env.BACKEND_AUTH_SECRET;
  });

  afterEach(() => {
    process.env.GOOGLE_OAUTH_STATE_SECRET = originalStateSecret;
    process.env.BACKEND_AUTH_SECRET = originalBackendSecret;
  });

  it("round-trips a purpose-bound GMB state", () => {
    const token = signGoogleOAuthState({
      provider: "gmb",
      userId: "user-1",
      businessId: "business-1",
      redirectUri:
        "http://localhost:3001/api/auth/google-my-business/callback",
    });
    const payload = verifyGoogleOAuthState(token, "gmb");
    expect(payload?.userId).toBe("user-1");
    expect(payload?.businessId).toBe("business-1");
    expect(payload?.provider).toBe("gmb");
  });

  it("rejects cross-provider replay and signature tampering", () => {
    const token = signGoogleOAuthState({
      provider: "gmb",
      userId: "user-1",
      businessId: "business-1",
      redirectUri:
        "http://localhost:3001/api/auth/google-my-business/callback",
    });
    expect(verifyGoogleOAuthState(token, "gsc")).toBeNull();
    expect(verifyGoogleOAuthState(`${token}x`, "gmb")).toBeNull();
  });

  it("rejects untrusted origins and incorrect callback paths", () => {
    expect(
      isAllowedGoogleOAuthRedirect(
        "gmb",
        "https://evil.example/api/auth/google-my-business/callback",
      ),
    ).toBeFalse();
    expect(
      isAllowedGoogleOAuthRedirect(
        "gmb",
        "http://localhost:3001/api/auth/search-console/callback",
      ),
    ).toBeFalse();
    expect(
      signGoogleOAuthState({
        provider: "gmb",
        userId: "user-1",
        businessId: "business-1",
        redirectUri: "https://evil.example/callback",
      }),
    ).toBe("");
  });

  it("fails closed without a strong backend secret", () => {
    delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    process.env.BACKEND_AUTH_SECRET = "weak";
    expect(
      signGoogleOAuthState({
        provider: "gsc",
        userId: "user-1",
        businessId: "business-1",
        redirectUri: "http://localhost:3001/api/auth/search-console/callback",
      }),
    ).toBe("");
  });
});
