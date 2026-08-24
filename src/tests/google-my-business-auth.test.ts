import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import GoogleMyBusinessRouter from "../routes/google-my-business.routes";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const ORIGINAL_ENV = process.env.BACKEND_AUTH_SECRET;

describe("Google My Business routes require backend auth", () => {
  beforeEach(() => {
    process.env.BACKEND_AUTH_SECRET = "test-secret-gmb-routes-at-least-32-bytes";
  });

  afterEach(() => {
    process.env.BACKEND_AUTH_SECRET = ORIGINAL_ENV;
  });

  it("keeps only the signed unsubscribe route before the backend auth wall", () => {
    const stack = (GoogleMyBusinessRouter as unknown as {
      stack?: Array<{
        handle?: unknown;
        route?: { path?: string };
      }>;
    }).stack;

    expect(Array.isArray(stack)).toBe(true);
    expect(stack?.[0]?.route?.path).toBe(
      "/review-campaigns/unsubscribe/:token",
    );
    const authIndex = stack?.findIndex(
      (layer) => layer.handle === requireBackendAuth,
    ) ?? -1;
    expect(authIndex).toBe(1);
    const protectedPaths = stack
      ?.slice(authIndex + 1)
      .map((layer) => layer.route?.path)
      .filter(Boolean);
    expect(protectedPaths?.includes("/profile-editor/attributes")).toBe(true);
    expect(protectedPaths?.includes("/connect")).toBe(true);
    expect(protectedPaths?.includes("/reviews/respond")).toBe(true);
    expect(protectedPaths?.includes("/edit-impacts")).toBe(true);
  });

  it("rejects unauthenticated requests through the mounted auth middleware", async () => {
    let statusCode = 0;
    const req = {
      headers: {},
    } as Parameters<typeof requireBackendAuth>[0];
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Parameters<typeof requireBackendAuth>[1];
    const next = () => {
      throw new Error("next should not be called");
    };

    await requireBackendAuth(req, res, next);
    expect(statusCode).toBe(401);
  });
});
