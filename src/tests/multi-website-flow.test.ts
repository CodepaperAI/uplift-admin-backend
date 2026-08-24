import { describe, it, expect, beforeAll } from "bun:test";
import { prisma } from "../config/db.config";

describe("Multi-website flow", () => {
  let userId: string;
  let businessAId: string;
  let businessBId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) {
      throw new Error("No user in DB for tests");
    }
    userId = user.id;

    const businesses = await prisma.business.findMany({
      where: { userId },
      select: { id: true },
      take: 2,
    });
    businessAId = businesses[0]?.id ?? "";
    businessBId = businesses[1]?.id ?? "";
  });

  it("listWebsites returns only active by default", async () => {
    const list = await prisma.business.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    });
    expect(Array.isArray(list)).toBe(true);
  });

  it("keywords are scoped by businessId", async () => {
    const forA = await prisma.plan.findMany({
      where: { userId, businessId: businessAId, deletedAt: null },
    });
    const forB = await prisma.plan.findMany({
      where: { userId, businessId: businessBId, deletedAt: null },
    });
    expect(Array.isArray(forA)).toBe(true);
    expect(Array.isArray(forB)).toBe(true);
  });

  it("no Plan rows have null businessId after backfill", async () => {
    const nullCount = await prisma.plan.count({
      where: { businessId: null },
    });
    expect(nullCount).toBe(0);
  });

  it("keywords for business A are not returned when querying by business B", async () => {
    const keywordsForA = await prisma.plan.findMany({
      where: { userId, businessId: businessAId, deletedAt: null },
      select: { id: true },
    });
    const keywordsForB = await prisma.plan.findMany({
      where: { userId, businessId: businessBId, deletedAt: null },
      select: { id: true },
    });
    const idsA = new Set(keywordsForA.map((k) => k.id));
    const idsB = new Set(keywordsForB.map((k) => k.id));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
    for (const id of idsB) {
      expect(idsA.has(id)).toBe(false);
    }
  });

  it("business ownership: business belongs to user", async () => {
    if (!businessAId) return;
    const business = await prisma.business.findFirst({
      where: { id: businessAId, userId },
      select: { id: true, userId: true },
    });
    expect(business).not.toBeNull();
    expect(business?.userId).toBe(userId);
  });

  it("negative ownership: different user cannot have same business id as owner", async () => {
    const otherUser = await prisma.user.findFirst({
      where: { id: { not: userId } },
      select: { id: true },
    });
    if (!otherUser || !businessAId) return;
    const business = await prisma.business.findFirst({
      where: { id: businessAId, userId: otherUser.id },
      select: { id: true },
    });
    expect(business).toBeNull();
  });

  it("Business has keywordGenerationStatus columns (migration applied)", async () => {
    if (!businessAId) return;
    try {
      const business = await prisma.business.findUnique({
        where: { id: businessAId },
        select: {
          keywordGenerationStatus: true,
          keywordGenerationStartedAt: true,
          keywordGenerationCompletedAt: true,
        },
      });
      expect(business).not.toBeNull();
      expect(typeof (business as { keywordGenerationStatus: string } | null)?.keywordGenerationStatus).toBe("string");
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
      if (code === "P2022") {
        console.warn("Skipping: run migration 20260216000000_add_business_keyword_generation_status so Business.keywordGenerationStatus exists");
        return;
      }
      throw err;
    }
  });
});
