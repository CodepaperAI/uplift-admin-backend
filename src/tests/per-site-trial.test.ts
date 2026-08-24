import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Per-site trial entitlement", () => {
  let userId: string;
  const testSuffix: string = randomUUID().slice(0, 8);
  const trialSiteUrl = `https://trial-site-${testSuffix}.com`;
  const paidSiteUrl = `https://paid-site-${testSuffix}.com`;
  let trialSiteId: string;
  let paidSiteId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB for tests");
    userId = user.id;
  });

  afterAll(async () => {
    const ids: string[] = [trialSiteId, paidSiteId].filter(Boolean);
    if (ids.length > 0) {
      await prisma.websiteSubscription
        .deleteMany({ where: { businessId: { in: ids } } })
        .catch(() => {});
      await prisma.business
        .deleteMany({ where: { id: { in: ids } } })
        .catch(() => {});
    }
  });

  it("creates a trial site with WebsiteSubscription in trialing status", async () => {
    const trialStart: Date = new Date();
    const trialEnd: Date = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);

    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Trial Site ${testSuffix}`,
        businessType: "SaaS",
        businessWebsiteUrl: trialSiteUrl,
        businessDescription: "",
        websiteStatus: "trial",
        isPrimary: false,
        isActive: true,
      },
    });
    trialSiteId = business.id;

    const ws = await prisma.websiteSubscription.create({
      data: {
        businessId: trialSiteId,
        status: "trialing",
        trialStartDate: trialStart,
        trialEndDate: trialEnd,
        trialStatus: "trialing",
      },
    });

    expect(ws.status).toBe("trialing");
    expect(ws.trialStatus).toBe("trialing");
    expect(ws.trialEndDate).not.toBeNull();
    expect(ws.trialStartDate).not.toBeNull();
  });

  it("creates a paid site with WebsiteSubscription in active status", async () => {
    const business = await prisma.business.create({
      data: {
        userId,
        businessName: `Paid Site ${testSuffix}`,
        businessType: "SaaS",
        businessWebsiteUrl: paidSiteUrl,
        businessDescription: "",
        websiteStatus: "active",
        isPrimary: false,
        isActive: true,
      },
    });
    paidSiteId = business.id;

    const ws = await prisma.websiteSubscription.create({
      data: {
        businessId: paidSiteId,
        status: "active",
        trialStatus: "none",
      },
    });

    expect(ws.status).toBe("active");
    expect(ws.trialStatus).toBe("none");
  });

  it("trial expiry sets site to expired without affecting paid site", async () => {
    await prisma.websiteSubscription.update({
      where: { businessId: trialSiteId },
      data: {
        trialStatus: "expired",
        status: "expired",
      },
    });

    await prisma.business.update({
      where: { id: trialSiteId },
      data: { websiteStatus: "expired" },
    });

    const trialBiz = await prisma.business.findUnique({
      where: { id: trialSiteId },
      include: { websiteSubscription: true },
    });
    const paidBiz = await prisma.business.findUnique({
      where: { id: paidSiteId },
      include: { websiteSubscription: true },
    });

    expect(trialBiz?.websiteStatus).toBe("expired");
    expect(trialBiz?.websiteSubscription?.trialStatus).toBe("expired");
    expect(trialBiz?.websiteSubscription?.status).toBe("expired");

    expect(paidBiz?.websiteStatus).toBe("active");
    expect(paidBiz?.websiteSubscription?.status).toBe("active");
    expect(paidBiz?.websiteSubscription?.trialStatus).toBe("none");
  });

  it("converting trial to paid sets correct statuses", async () => {
    await prisma.websiteSubscription.update({
      where: { businessId: trialSiteId },
      data: {
        trialStatus: "converted",
        status: "active",
      },
    });

    await prisma.business.update({
      where: { id: trialSiteId },
      data: { websiteStatus: "active" },
    });

    const biz = await prisma.business.findUnique({
      where: { id: trialSiteId },
      include: { websiteSubscription: true },
    });

    expect(biz?.websiteStatus).toBe("active");
    expect(biz?.websiteSubscription?.trialStatus).toBe("converted");
    expect(biz?.websiteSubscription?.status).toBe("active");
  });

  it("checkSiteAccess returns correct access for each state", async () => {
    const { checkSiteAccess } = await import("../utils/access-control.utils");

    await prisma.websiteSubscription.update({
      where: { businessId: trialSiteId },
      data: {
        status: "trialing",
        trialStatus: "trialing",
        trialEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.business.update({
      where: { id: trialSiteId },
      data: { websiteStatus: "trial" },
    });

    const trialAccess = await checkSiteAccess(trialSiteId);
    expect(trialAccess.hasAccess).toBe(true);
    expect(trialAccess.accessType).toBe("trial");

    const paidAccess = await checkSiteAccess(paidSiteId);
    expect(paidAccess.hasAccess).toBe(true);

    await prisma.websiteSubscription.update({
      where: { businessId: trialSiteId },
      data: {
        status: "expired",
        trialStatus: "expired",
        trialEndDate: new Date(Date.now() - 1000),
      },
    });
    await prisma.business.update({
      where: { id: trialSiteId },
      data: { websiteStatus: "expired" },
    });

    const expiredAccess = await checkSiteAccess(trialSiteId);
    expect(expiredAccess.hasAccess).toBe(false);
    expect(expiredAccess.accessType).toBe("trial_expired");
  });

  it("checkDashboardAccess prioritizes an active paid site over stale trial state", async () => {
    const { checkDashboardAccess } = await import("../utils/access-control.utils");
    const dashboardSuffix = randomUUID().slice(0, 8);
    const dashboardUser = await prisma.user.create({
      data: {
        email: `entitlement-${dashboardSuffix}@example.com`,
        name: `Entitlement ${dashboardSuffix}`,
        trialStatus: "active",
        trialStartDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        trialEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });

    const dashboardBusinesses = await prisma.$transaction(async (tx) => {
      const paidBusiness = await tx.business.create({
        data: {
          userId: dashboardUser.id,
          businessName: `Dashboard Paid ${dashboardSuffix}`,
          businessType: "SaaS",
          businessWebsiteUrl: `https://dashboard-paid-${dashboardSuffix}.com`,
          businessDescription: "",
          websiteStatus: "active",
          isPrimary: true,
          isActive: true,
        },
      });

      const trialBusiness = await tx.business.create({
        data: {
          userId: dashboardUser.id,
          businessName: `Dashboard Trial ${dashboardSuffix}`,
          businessType: "SaaS",
          businessWebsiteUrl: `https://dashboard-trial-${dashboardSuffix}.com`,
          businessDescription: "",
          websiteStatus: "trial",
          isPrimary: false,
          isActive: true,
        },
      });

      await tx.subscription.create({
        data: {
          userId: dashboardUser.id,
          status: "trialing",
          stripeStatus: "trialing",
          planName: "Uplift Trial",
          websiteCount: 0,
          maxWebsites: 1,
          startDate: new Date(),
          currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        },
      });

      await tx.websiteSubscription.create({
        data: {
          businessId: paidBusiness.id,
          status: "active",
          trialStatus: "converted",
        },
      });

      await tx.websiteSubscription.create({
        data: {
          businessId: trialBusiness.id,
          status: "trialing",
          trialStatus: "trialing",
          trialStartDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          trialEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        },
      });

      return {
        paidBusinessId: paidBusiness.id,
        trialBusinessId: trialBusiness.id,
      };
    });

    try {
      const access = await checkDashboardAccess(dashboardUser.id);
      expect(access.hasAccess).toBe(true);
      expect(access.accessType).toBe("subscription");
      expect(access.subscription?.status).toBe("active");
    } finally {
      await prisma.websiteSubscription
        .deleteMany({
          where: {
            businessId: {
              in: [
                dashboardBusinesses.paidBusinessId,
                dashboardBusinesses.trialBusinessId,
              ],
            },
          },
        })
        .catch(() => {});
      await prisma.business
        .deleteMany({
          where: {
            id: {
              in: [
                dashboardBusinesses.paidBusinessId,
                dashboardBusinesses.trialBusinessId,
              ],
            },
          },
        })
        .catch(() => {});
      await prisma.subscription
        .deleteMany({ where: { userId: dashboardUser.id } })
        .catch(() => {});
      await prisma.user.delete({ where: { id: dashboardUser.id } }).catch(() => {});
    }
  });
});
