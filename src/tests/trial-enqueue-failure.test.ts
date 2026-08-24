import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Trial enqueue failure does not activate trial", () => {
  let userId: string;
  let quickScrapeBusinessId: string;
  let skipTest = false;
  const suffix = randomUUID().slice(0, 8);
  const testUrl = `https://trial-enqueue-fail-${suffix}.com`;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: { trialUsed: false },
      include: { Subscription: { select: { status: true } } },
    });
    if (!user || user.Subscription?.status === "active") {
      skipTest = true;
      return;
    }
    userId = user.id;

    const qb = await prisma.quickScrapeBusiness.create({
      data: {
        userId,
        businessName: `Trial Enqueue Fail Test ${suffix}`,
        businessType: "Test",
        businessWebsiteUrl: testUrl,
        detectedServices: ["A"],
        selectedServices: ["A"],
      },
    });
    quickScrapeBusinessId = qb.id;
  });

  afterAll(async () => {
    if (skipTest || !quickScrapeBusinessId) return;
    await prisma.quickScrapeBusiness
      .delete({ where: { id: quickScrapeBusinessId } })
      .catch(() => {});
  });

  it("when complete-onboarding queue returns no ids, user trial is not activated", async () => {
    if (skipTest) return;
    const userBefore = await prisma.user.findUnique({
      where: { id: userId },
      select: { trialStatus: true, trialUsed: true },
    });

    const inngestModule = await import("../inngest/client");
    const originalSend = inngestModule.inngest.send.bind(
      inngestModule.inngest,
    );
    (inngestModule.inngest as { send: (opts: unknown) => Promise<{ ids?: string[] }> }).send = async () => ({ ids: [] });

    const { enrollInTrial } = await import("../controllers/trial.controller");
    const req = {
      authUserId: userId,
      body: {
        businessId: quickScrapeBusinessId,
        phone: "+1555000000",
      },
    } as Parameters<typeof enrollInTrial>[0];
    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Parameters<typeof enrollInTrial>[1];

    await enrollInTrial(req, res);

    (inngestModule.inngest as { send: typeof originalSend }).send =
      originalSend;

    const userAfter = await prisma.user.findUnique({
      where: { id: userId },
      select: { trialStatus: true, trialUsed: true },
    });
    expect(statusCode).toBe(500);
    expect(userAfter?.trialStatus).toBe(userBefore?.trialStatus ?? null);
    expect(userAfter?.trialUsed).toBe(userBefore?.trialUsed ?? false);
  });
});
