import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Stripe webhook add_website guards", () => {
  let userId: string;
  let businessId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB");
    userId = user.id;

    const business = await prisma.business.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!business) throw new Error("No business in DB");
    businessId = business.id;
  });

  afterAll(async () => {
    await prisma.websiteSubscription
      .deleteMany({ where: { businessId } })
      .catch(() => {});
  });

  it("trial-secondary endpoint rejects paid (active) non-trial callers when at limit", async () => {
    const userWithActive = await prisma.user.findFirst({
      where: {},
      include: {
        Subscription: true,
        business: { where: { isActive: true } },
      },
    });
    const user = userWithActive?.Subscription?.status === "active"
      ? userWithActive
      : await prisma.user.findFirst({
          where: { Subscription: { status: "active" } },
          include: {
            Subscription: true,
            business: { where: { isActive: true } },
          },
        });
    if (!user?.Subscription || user.Subscription.status !== "active") {
      return;
    }

    const { createTrialSecondaryWebsite } = await import(
      "../controllers/website.controller"
    );
    const maxWebsites = user.Subscription.maxWebsites ?? 1;
    const activeCount = user.business.length;
    if (activeCount < maxWebsites) {
      return;
    }

    const req = {
      authUserId: user.id,
      body: { websiteUrl: "https://trial-secondary-reject-test.example.com" },
    } as Parameters<typeof createTrialSecondaryWebsite>[0];
    let statusCode = 0;
    let body: { error?: string } = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (b: { error?: string }) => {
        body = b;
        return res;
      },
    } as unknown as Parameters<typeof createTrialSecondaryWebsite>[1];

    await createTrialSecondaryWebsite(req, res);

    expect(statusCode).toBe(402);
    expect(body.error === "TRIAL_ONLY" || String(body).includes("Add to trial is only available")).toBe(true);
  });
});
