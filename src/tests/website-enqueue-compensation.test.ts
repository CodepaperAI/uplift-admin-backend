import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";
import { compensateWebsiteOnboardFailure } from "../utils/website-onboard-compensation";

describe("Website enqueue failure compensates billing immediately", () => {
  let userId: string;
  let businessId: string;
  let subscriptionId: string;
  let websiteSubId: string;
  const suffix = randomUUID().slice(0, 8);
  const testUrl = `https://enqueue-compensate-${suffix}.com`;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB");
    userId = user.id;

    let sub = await prisma.subscription.findFirst({
      where: { userId },
    });
    if (!sub) {
      sub = await prisma.subscription.create({
        data: {
          userId,
          status: "trialing",
          stripeStatus: "trialing",
          planName: "Test",
          websiteCount: 0,
          maxWebsites: 1,
          startDate: new Date(),
        },
      });
    }
    subscriptionId = sub.id;

    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Compensate Test ${suffix}`,
        businessType: "Test",
        businessDescription: "",
        businessWebsiteUrl: testUrl,
        websiteStatus: "pending",
        isActive: true,
        isPrimary: false,
      },
    });
    businessId = business.id;

    const wSub = await prisma.websiteSubscription.create({
      data: {
        businessId,
        stripeSubscriptionId: `sub_test_${suffix}`,
        stripeSubscriptionItemId: `si_test_${suffix}`,
        stripePriceId: `price_test_${suffix}`,
        status: "active",
        currentPeriodStart: new Date(),
      },
    });
    websiteSubId = wSub.id;

    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: { websiteCount: { increment: 1 } },
    });
  });

  afterAll(async () => {
    if (businessId) {
      await prisma.websiteSubscription.deleteMany({ where: { businessId } });
      await prisma.business.deleteMany({ where: { id: businessId } });
    }
    if (subscriptionId) {
      const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
      });
      if (sub && (sub.websiteCount ?? 0) > 0) {
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data: { websiteCount: { decrement: 1 } },
        });
      }
    }
  });

  it("compensateWebsiteOnboardFailure deletes websiteSubscription and decrements websiteCount and marks business failed", async () => {
    const subBefore = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { websiteCount: true },
    });
    const countBefore = subBefore?.websiteCount ?? 0;

    const stripe = {
      subscriptionItems: {
        del: async () => undefined,
      },
    } as unknown as import("stripe").default;

    await compensateWebsiteOnboardFailure({
      prisma,
      stripe,
      businessId,
      userId,
      stripeSubscriptionItemId: `si_test_${suffix}`,
      decrementWebsiteCount: true,
      markFailed: true,
    });

    const wSubAfter = await prisma.websiteSubscription.findUnique({
      where: { id: websiteSubId },
    });
    expect(wSubAfter).toBeNull();

    const subAfter = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    expect(subAfter?.websiteCount).toBe(countBefore - 1);

    const businessAfter = await prisma.business.findUnique({
      where: { id: businessId },
    });
    expect(businessAfter?.websiteStatus).toBe("failed");
  });
});
