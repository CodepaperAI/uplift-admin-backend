import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import express, { type Express } from "express";
import RouteHandler from "../routes";
import { signBackendAuthToken } from "../utils/backend-auth-token";

describe("Auth user mismatch rejection", () => {
  let app: Express;
  let server: ReturnType<Express["listen"]> | null = null;
  let baseUrl: string = "";

  beforeAll(() => {
    if (!process.env.BACKEND_AUTH_SECRET) {
      process.env.BACKEND_AUTH_SECRET = "test-secret-for-auth-mismatch-32-bytes";
    }
    app = express();
    app.use(express.json());
    app.use(RouteHandler);
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server?.address();
        const port = typeof a === "object" && a ? a.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    const s = server;
    if (s) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("keyword getKeywords: rejects caller-supplied user identity", async () => {
    const tokenA = signBackendAuthToken("user-a-id");
    const res = await fetch(`${baseUrl}/api/v1/keyword/get-keywords`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        userId: "user-b-id",
        businessId: "22222222-2222-4222-8222-222222222222",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("keyword getKeywords: without auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/keyword/get-keywords`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "any",
        businessId: "any",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("blog getAllBlogs: rejects caller-supplied user identity", async () => {
    const tokenA = signBackendAuthToken("user-a-id");
    const res = await fetch(`${baseUrl}/api/v1/blog/all-blogs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify({
        userId: "user-b-id",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("publishing getIntegrations: rejects a mismatched path identity", async () => {
    const tokenA = signBackendAuthToken("user-a-id");
    const res = await fetch(`${baseUrl}/api/v1/publishing/user/user-b-id`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
    });
    expect(res.status).toBe(403);
  });
});
