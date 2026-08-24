import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import express, { type Express } from "express";
import RouteHandler from "../routes";
import { signBackendAuthToken } from "../utils/backend-auth-token";
import { prisma } from "../config/db.config";

describe("Keyword API contracts", () => {
  let app: Express;
  let server: ReturnType<Express["listen"]> | null = null;
  let baseUrl: string = "";
  let testUserId: string;
  let planIdForId: string;
  let planIdForKeywordId: string;

  beforeAll(async () => {
    if (!process.env.BACKEND_AUTH_SECRET) {
      process.env.BACKEND_AUTH_SECRET = "test-secret-keyword-contracts-32-bytes";
    }
    app = express();
    app.use(express.json());
    app.use(RouteHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server?.address();
        const port = typeof a === "object" && a ? a.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB for keyword contract tests");
    testUserId = user.id;

    const planA = await prisma.plan.create({
      data: {
        keyword: "contract-test-id",
        publishDate: "2099-01-01",
        publishTime: "09:00",
        keywordDiffculty: "0",
        keywordSearchVolume: "0",
        userId: testUserId,
        businessId: null,
      },
      select: { id: true },
    });
    planIdForId = planA.id;

    const planB = await prisma.plan.create({
      data: {
        keyword: "contract-test-keywordId",
        publishDate: "2099-01-02",
        publishTime: "09:00",
        keywordDiffculty: "0",
        keywordSearchVolume: "0",
        userId: testUserId,
        businessId: null,
      },
      select: { id: true },
    });
    planIdForKeywordId = planB.id;
  });

  afterAll(async () => {
    await prisma.plan.deleteMany({
      where: { id: { in: [planIdForId, planIdForKeywordId] } },
    }).catch(() => {});
    const s = server;
    if (s) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("delete-keyword accepts id and soft-deletes", async () => {
    const token = signBackendAuthToken(testUserId);
    const res = await fetch(`${baseUrl}/api/v1/keyword/delete-keyword`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id: planIdForId, userId: testUserId }),
    });
    expect(res.status).toBe(200);
    const plan = await prisma.plan.findUnique({
      where: { id: planIdForId },
      select: { deletedAt: true },
    });
    expect(plan?.deletedAt).not.toBeNull();
  });

  it("delete-keyword accepts legacy keywordId and soft-deletes", async () => {
    const token = signBackendAuthToken(testUserId);
    const res = await fetch(`${baseUrl}/api/v1/keyword/delete-keyword`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ keywordId: planIdForKeywordId, userId: testUserId }),
    });
    expect(res.status).toBe(200);
    const plan = await prisma.plan.findUnique({
      where: { id: planIdForKeywordId },
      select: { deletedAt: true },
    });
    expect(plan?.deletedAt).not.toBeNull();
  });

  it(
    "search-keywords accepts seedKeyword and returns data.keywords array",
    async () => {
      const token = signBackendAuthToken(testUserId);
      const res = await fetch(`${baseUrl}/api/v1/keyword/search-keywords`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          seedKeyword: "seo tools",
          businessId: "any",
          userId: testUserId,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data?: { keywords?: unknown[] };
        keywords?: unknown[];
      };
      const keywords = body.data?.keywords ?? body.keywords;
      expect(Array.isArray(keywords)).toBe(true);
    },
    15000
  );

  it("search-keywords without seedKeyword returns 400", async () => {
    const token = signBackendAuthToken(testUserId);
    const res = await fetch(`${baseUrl}/api/v1/keyword/search-keywords`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ businessId: "any", userId: testUserId }),
    });
    expect(res.status).toBe(400);
  });
});
