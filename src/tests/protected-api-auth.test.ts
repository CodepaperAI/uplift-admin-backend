import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const ORIGINAL_ENV = process.env.BACKEND_AUTH_SECRET;

describe("Protected keyword/blog API requires backend auth", () => {
  beforeEach(() => {
    process.env.BACKEND_AUTH_SECRET = "test-secret-for-protected-api-32-bytes";
  });

  afterEach(() => {
    process.env.BACKEND_AUTH_SECRET = ORIGINAL_ENV;
  });

  it("returns 401 when Authorization header is missing", async () => {
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

  it("returns 401 when Authorization header is not Bearer", async () => {
    let statusCode = 0;
    const req = {
      headers: { authorization: "Basic xyz" },
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

  it("returns 401 when Bearer token is invalid", async () => {
    let statusCode = 0;
    const req = {
      headers: { authorization: "Bearer invalid-token" },
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
