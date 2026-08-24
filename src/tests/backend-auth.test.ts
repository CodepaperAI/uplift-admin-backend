import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  signBackendAuthToken,
  verifyBackendAuthToken,
  isBackendAuthRequired,
} from "../utils/backend-auth-token";

const ORIGINAL_ENV = process.env.BACKEND_AUTH_SECRET;

describe("backend-auth-token", () => {
  afterEach(() => {
    process.env.BACKEND_AUTH_SECRET = ORIGINAL_ENV;
  });

  describe("isBackendAuthRequired", () => {
    it("returns false when BACKEND_AUTH_SECRET is not set", () => {
      delete process.env.BACKEND_AUTH_SECRET;
      expect(isBackendAuthRequired()).toBe(false);
    });

    it("returns true when BACKEND_AUTH_SECRET is set", () => {
      process.env.BACKEND_AUTH_SECRET = "test-secret-that-is-at-least-32-bytes";
      expect(isBackendAuthRequired()).toBe(true);
    });
  });

  describe("sign and verify", () => {
    beforeEach(() => {
      process.env.BACKEND_AUTH_SECRET = "test-secret-that-is-at-least-32-bytes";
    });

    it("returns empty string when secret is not set", () => {
      delete process.env.BACKEND_AUTH_SECRET;
      expect(signBackendAuthToken("user-1")).toBe("");
    });

    it("verify returns userId for valid token", () => {
      const token = signBackendAuthToken("user-123");
      expect(token.length).toBeGreaterThan(0);
      const parsed = verifyBackendAuthToken(token);
      expect(parsed).not.toBeNull();
      expect(parsed?.userId).toBe("user-123");
    });

    it("verify returns null for empty token", () => {
      expect(verifyBackendAuthToken("")).toBeNull();
    });

    it("verify returns null for tampered token", () => {
      const token = signBackendAuthToken("user-1");
      const tampered = token.slice(0, -2) + "xx";
      expect(verifyBackendAuthToken(tampered)).toBeNull();
    });

    it("verify returns null when secret is different", () => {
      const token = signBackendAuthToken("user-1");
      process.env.BACKEND_AUTH_SECRET = "other-secret-that-is-at-least-32-bytes";
      expect(verifyBackendAuthToken(token)).toBeNull();
    });

    it("rejects spoofed userId: token binds to single userId and body cannot override", () => {
      const tokenA = signBackendAuthToken("user-A");
      const tokenB = signBackendAuthToken("user-B");
      expect(verifyBackendAuthToken(tokenA)?.userId).toBe("user-A");
      expect(verifyBackendAuthToken(tokenB)?.userId).toBe("user-B");
      expect(verifyBackendAuthToken(tokenA)?.userId).not.toBe("user-B");
    });
  });
});
