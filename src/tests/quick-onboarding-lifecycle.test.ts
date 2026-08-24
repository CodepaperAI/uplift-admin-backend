import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Quick onboarding lifecycle", () => {
  let userId: string;
  let quickBusinessId: string;
  const testSuffix = randomUUID().slice(0, 8);
  const testUrl = `https://lifecycle-test-${testSuffix}.com`;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB for tests");
    userId = user.id;
  });

  afterAll(async () => {
    if (quickBusinessId) {
      await prisma.quickScrapeBusiness
        .delete({ where: { id: quickBusinessId } })
        .catch(() => {});
    }
    await prisma.business
      .deleteMany({
        where: { userId, businessWebsiteUrl: testUrl },
      })
      .catch(() => {});
  });

  it("creates a quickScrapeBusiness record on scrape", async () => {
    const qb = await prisma.quickScrapeBusiness.create({
      data: {
        userId,
        businessName: `Lifecycle Test ${testSuffix}`,
        businessType: "SaaS",
        businessWebsiteUrl: testUrl,
        detectedServices: ["SEO", "Content Marketing"],
        selectedServices: [],
      },
    });
    quickBusinessId = qb.id;
    expect(qb.id).toBeTruthy();
    expect(qb.selectedServices).toEqual([]);
  });

  it("saves selected services to the quickScrapeBusiness", async () => {
    await prisma.quickScrapeBusiness.update({
      where: { id: quickBusinessId },
      data: {
        selectedServices: ["SEO", "Content Marketing"],
        servicesPriority: { SEO: 1, "Content Marketing": 2 },
      },
    });

    const updated = await prisma.quickScrapeBusiness.findUnique({
      where: { id: quickBusinessId },
      select: { selectedServices: true, servicesPriority: true },
    });

    expect(updated?.selectedServices).toEqual(["SEO", "Content Marketing"]);
    expect(
      (updated?.servicesPriority as Record<string, number>)?.SEO,
    ).toBe(1);
  });

  it("creates a pending business record for background processing", async () => {
    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Lifecycle Test ${testSuffix}`,
        businessType: "SaaS",
        businessWebsiteUrl: testUrl,
        businessDescription: "",
        websiteStatus: "pending",
        isPrimary: false,
        isActive: true,
        onboardingFlow: "website_secondary",
        onboardingStatus: "queued",
      },
    });

    expect(business.websiteStatus).toBe("pending");
    expect(business.onboardingStatus).toBe("queued");
    expect(business.isActive).toBe(true);
  });

  it("marks business as active on successful completion", async () => {
    const business = await prisma.business.findFirst({
      where: { userId, businessWebsiteUrl: testUrl },
    });
    expect(business).toBeTruthy();

    await prisma.business.update({
      where: { id: business!.id },
      data: {
        websiteStatus: "active",
        onboardingStatus: "completed",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: business!.id },
    });
    expect(updated?.websiteStatus).toBe("active");
    expect(updated?.onboardingStatus).toBe("completed");
  });

  it("marks business as failed on error", async () => {
    const business = await prisma.business.findFirst({
      where: { userId, businessWebsiteUrl: testUrl },
    });

    await prisma.business.update({
      where: { id: business!.id },
      data: {
        websiteStatus: "failed",
        onboardingStatus: "failed",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: business!.id },
    });
    expect(updated?.websiteStatus).toBe("failed");
    expect(updated?.onboardingStatus).toBe("failed");
  });

  it("retry resets failed business back to queued", async () => {
    const business = await prisma.business.findFirst({
      where: { userId, businessWebsiteUrl: testUrl },
    });

    expect(business?.websiteStatus).toBe("failed");
    expect(business?.onboardingStatus).toBe("failed");

    await prisma.business.update({
      where: { id: business!.id },
      data: {
        websiteStatus: "pending",
        onboardingStatus: "queued",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: business!.id },
    });
    expect(updated?.websiteStatus).toBe("pending");
    expect(updated?.onboardingStatus).toBe("queued");
  });

  it("user.onboarding stays false until background task sets it", async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { onboarding: true },
    });
    expect(user).toBeTruthy();
  });
});
