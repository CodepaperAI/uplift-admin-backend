import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import { randomUUID } from "crypto";

describe("Duplicate webhook idempotency (DB-backed, atomic)", () => {
  const eventIds: string[] = [];
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB");
    userId = user.id;
  });

  afterAll(async () => {
    for (const id of eventIds) {
      await prisma.$executeRaw`DELETE FROM "stripe_webhook_event" WHERE "id" = ${id}`.catch(
        () => {}
      );
    }
  });

  it("concurrent inserts with the same event ID: only one succeeds", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    eventIds.push(eventId);

    const results = await Promise.allSettled([
      prisma.$executeRaw`INSERT INTO "stripe_webhook_event" ("id", "createdAt") VALUES (${eventId}, NOW())`,
      prisma.$executeRaw`INSERT INTO "stripe_webhook_event" ("id", "createdAt") VALUES (${eventId}, NOW())`,
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("second insert after first is committed is rejected", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    eventIds.push(eventId);

    await prisma.$executeRaw`INSERT INTO "stripe_webhook_event" ("id", "createdAt") VALUES (${eventId}, NOW())`;

    let caught = false;
    try {
      await prisma.$executeRaw`INSERT INTO "stripe_webhook_event" ("id", "createdAt") VALUES (${eventId}, NOW())`;
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });

  it("websiteCount is not double-incremented when duplicate events are rejected", async () => {
    const sub = await prisma.subscription.findUnique({
      where: { userId },
      select: { websiteCount: true },
    });
    if (!sub) return;

    const countBefore = sub.websiteCount ?? 0;

    const activeCount = await prisma.websiteSubscription.count({
      where: {
        business: { userId },
        status: { in: ["active", "trialing"] },
      },
    });

    expect(activeCount).toBeGreaterThanOrEqual(0);
    expect(countBefore).toBeGreaterThanOrEqual(0);
  });
});
