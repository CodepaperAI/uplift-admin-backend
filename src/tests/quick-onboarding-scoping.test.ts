import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import {
  QUICK_SCRAPE,
  SAVE_BUSINESS_DETAILS,
  SAVE_SERVICES,
  SEARCH_QUICK_PLACES,
} from "../validators/quick-scrape.validation";
import { randomUUID } from "crypto";

describe("Quick onboarding multi-business scoping", () => {
  let userId: string;
  let quickBusinessAId: string;
  let quickBusinessBId: string;
  let otherQuickId: string | null = null;
  const testSuffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) {
      throw new Error("No user in DB for tests");
    }
    userId = user.id;

    const [a, b] = await Promise.all([
      prisma.quickScrapeBusiness.create({
        data: {
          userId,
          businessName: `Test Business A ${testSuffix}`,
          businessType: "TypeA",
          businessWebsiteUrl: `https://example-a-${testSuffix}.com`,
          detectedServices: ["Service A1"],
          selectedServices: [],
        },
        select: { id: true },
      }),
      prisma.quickScrapeBusiness.create({
        data: {
          userId,
          businessName: `Test Business B ${testSuffix}`,
          businessType: "TypeB",
          businessWebsiteUrl: `https://example-b-${testSuffix}.com`,
          detectedServices: ["Service B1"],
          selectedServices: [],
        },
        select: { id: true },
      }),
    ]);
    quickBusinessAId = a.id;
    quickBusinessBId = b.id;
  });

  afterAll(async () => {
    const idsToClean = [quickBusinessAId, quickBusinessBId, otherQuickId].filter(
      (id): id is string => id != null,
    );
    await Promise.allSettled(
      idsToClean.map((id) =>
        prisma.quickScrapeBusiness.delete({ where: { id } }),
      ),
    );
  });

  it("SAVE_SERVICES requires businessId and rejects request without it", () => {
    expect(() =>
      SAVE_SERVICES.parse({
        selectedServices: ["S1"],
      }),
    ).toThrow();
    const withBusinessId = SAVE_SERVICES.parse({
      businessId: quickBusinessAId,
      selectedServices: ["S1"],
    });
    expect(withBusinessId.businessId).toBe(quickBusinessAId);
  });

  it("quick onboarding payloads derive identity from backend auth", () => {
    expect(
      QUICK_SCRAPE.parse({ websiteUrl: "https://example.com" }),
    ).toEqual({ websiteUrl: "https://example.com" });

    expect(
      SAVE_SERVICES.parse({
        businessId: "quick-business-1",
        selectedServices: ["Service one"],
      }),
    ).toMatchObject({ businessId: "quick-business-1" });

    expect(
      SAVE_BUSINESS_DETAILS.parse({
        businessId: "quick-business-1",
        businessDetails: {},
      }),
    ).toMatchObject({ businessId: "quick-business-1" });

    expect(
      SEARCH_QUICK_PLACES.parse({
        businessId: "quick-business-1",
        query: "Toronto",
      }),
    ).toMatchObject({ businessId: "quick-business-1" });
  });

  it("updating one quick business does not mutate the other", async () => {
    await prisma.quickScrapeBusiness.update({
      where: { id: quickBusinessAId },
      data: {
        selectedServices: ["OnlyA1", "OnlyA2"],
        servicesPriority: { OnlyA1: 1, OnlyA2: 2 },
      },
    });

    const a = await prisma.quickScrapeBusiness.findUnique({
      where: { id: quickBusinessAId },
      select: { selectedServices: true, servicesPriority: true },
    });
    const b = await prisma.quickScrapeBusiness.findUnique({
      where: { id: quickBusinessBId },
      select: { selectedServices: true, servicesPriority: true },
    });

    expect(a?.selectedServices).toEqual(["OnlyA1", "OnlyA2"]);
    expect(b?.selectedServices).toEqual([]);
    expect((b?.servicesPriority as Record<string, number>) ?? {}).toEqual({});
  });

  it("wrong businessId (other user) is not found for current user", async () => {
    const otherUser = await prisma.user.findFirst({
      where: { id: { not: userId } },
      select: { id: true },
    });
    if (!otherUser) return;

    const otherQuick = await prisma.quickScrapeBusiness.create({
      data: {
        userId: otherUser.id,
        businessName: `Other User Business ${testSuffix}`,
        businessType: "Other",
        businessWebsiteUrl: `https://other-${testSuffix}.com`,
        detectedServices: [],
        selectedServices: ["OtherService"],
      },
      select: { id: true },
    });
    otherQuickId = otherQuick.id;

    const foundAsCurrentUser = await prisma.quickScrapeBusiness.findFirst({
      where: { id: otherQuick.id, userId },
    });
    expect(foundAsCurrentUser).toBeNull();
  });
});
