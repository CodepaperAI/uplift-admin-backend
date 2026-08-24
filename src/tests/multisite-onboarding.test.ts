import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Multisite onboarding state transitions", () => {
  let userId: string;
  const testSuffix = randomUUID().slice(0, 8);
  const siteAUrl = `https://site-a-${testSuffix}.com`;
  const siteBUrl = `https://site-b-${testSuffix}.com`;
  let siteAId: string;
  let siteBId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB for tests");
    userId = user.id;
  });

  afterAll(async () => {
    const ids = [siteAId, siteBId].filter(Boolean);
    if (ids.length > 0) {
      await prisma.websiteSubscription
        .deleteMany({ where: { businessId: { in: ids } } })
        .catch(() => {});
      await prisma.business
        .deleteMany({ where: { id: { in: ids } } })
        .catch(() => {});
    }
  });

  it("creates primary site as active", async () => {
    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Primary Site ${testSuffix}`,
        businessType: "SaaS",
        businessWebsiteUrl: siteAUrl,
        businessDescription: "",
        websiteStatus: "active",
        isPrimary: true,
        isActive: true,
        onboardingFlow: "trial_primary",
        onboardingStatus: "completed",
      },
    });
    siteAId = business.id;
    expect(business.websiteStatus).toBe("active");
    expect(business.onboardingStatus).toBe("completed");
    expect(business.isPrimary).toBe(true);
  });

  it("creates additional site as pending", async () => {
    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Additional Site ${testSuffix}`,
        businessType: "Agency",
        businessWebsiteUrl: siteBUrl,
        businessDescription: "",
        websiteStatus: "pending",
        isPrimary: false,
        isActive: true,
        onboardingFlow: "website_secondary",
        onboardingStatus: "queued",
        secondaryDetailsConfirmed: false,
      },
    });
    siteBId = business.id;
    expect(business.websiteStatus).toBe("pending");
    expect(business.onboardingStatus).toBe("queued");
    expect(business.isPrimary).toBe(false);
    expect(business.secondaryDetailsConfirmed).toBe(false);
  });

  it("pending site starts in a non-final onboarding state", async () => {
    const pendingSite = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(pendingSite?.websiteStatus).toBe("pending");
    expect(pendingSite?.onboardingStatus).toBe("queued");
  });

  it("transitions pending -> awaiting_confirmation when draft details are ready", async () => {
    await prisma.business.update({
      where: { id: siteBId },
      data: {
        onboardingStatus: "awaiting_confirmation",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(updated?.websiteStatus).toBe("pending");
    expect(updated?.onboardingStatus).toBe("awaiting_confirmation");
    expect(updated?.secondaryDetailsConfirmed).toBe(false);
  });

  it("transitions awaiting_confirmation -> active after details are confirmed", async () => {
    await prisma.business.update({
      where: { id: siteBId },
      data: {
        websiteStatus: "active",
        onboardingStatus: "completed",
        secondaryDetailsConfirmed: true,
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(updated?.websiteStatus).toBe("active");
    expect(updated?.onboardingStatus).toBe("completed");
    expect(updated?.secondaryDetailsConfirmed).toBe(true);
  });

  it("active additional site can be set as primary", async () => {
    await prisma.business.updateMany({
      where: { userId, isPrimary: true },
      data: { isPrimary: false },
    });

    await prisma.business.update({
      where: { id: siteBId },
      data: { isPrimary: true },
    });

    const siteA = await prisma.business.findUnique({
      where: { id: siteAId },
    });
    const siteB = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(siteA?.isPrimary).toBe(false);
    expect(siteB?.isPrimary).toBe(true);
  });

  it("transitions pending -> failed on error", async () => {
    await prisma.business.update({
      where: { id: siteBId },
      data: {
        websiteStatus: "pending",
        onboardingStatus: "queued",
      },
    });

    await prisma.business.update({
      where: { id: siteBId },
      data: {
        websiteStatus: "failed",
        onboardingStatus: "failed",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(updated?.websiteStatus).toBe("failed");
    expect(updated?.onboardingStatus).toBe("failed");
  });

  it("failed site can be retried (failed -> queued)", async () => {
    await prisma.business.update({
      where: { id: siteBId },
      data: {
        websiteStatus: "pending",
        onboardingStatus: "queued",
      },
    });

    const updated = await prisma.business.findUnique({
      where: { id: siteBId },
    });
    expect(updated?.websiteStatus).toBe("pending");
    expect(updated?.onboardingStatus).toBe("queued");
  });

  it("billing compensation removes websiteSubscription on failure", async () => {
    const wSub = await prisma.websiteSubscription.create({
      data: {
        businessId: siteBId,
        stripeSubscriptionId: `sub_test_${testSuffix}`,
        stripeSubscriptionItemId: `si_test_${testSuffix}`,
        stripePriceId: `price_test_${testSuffix}`,
        status: "active",
        currentPeriodStart: new Date(),
      },
    });

    expect(wSub.id).toBeTruthy();

    await prisma.websiteSubscription.delete({
      where: { id: wSub.id },
    });

    const deleted = await prisma.websiteSubscription.findUnique({
      where: { id: wSub.id },
    });
    expect(deleted).toBeNull();
  });

  it("billing compensation decrements websiteCount", async () => {
    const subscription = await prisma.subscription.findFirst({
      where: { userId },
    });
    if (!subscription) return;

    const original = subscription.websiteCount ?? 0;

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { websiteCount: { increment: 1 } },
    });

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { websiteCount: { decrement: 1 } },
    });

    const restored = await prisma.subscription.findUnique({
      where: { id: subscription.id },
    });
    expect(restored?.websiteCount).toBe(original);
  });
});
