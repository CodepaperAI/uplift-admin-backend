import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, mock } from "bun:test";

let webhookEvents = new Map<string, Record<string, unknown>>();
let attributions = new Map<string, Record<string, unknown>>();
let attributionUpdates: Array<Record<string, unknown>> = [];
let createUniqueConflictEventId: string | null = null;

mock.module("../config/db.config", () => ({
  prisma: {
    rewardfulAttribution: {
      count: async (payload?: { where?: Record<string, unknown> }) => {
        const rows = Array.from(attributions.values());
        const where = payload?.where ?? {};
        if (where.conversionTrackedAt === null && where.stripeSubscriptionId === null) {
          return rows.filter(
            (row) => !row.conversionTrackedAt && !row.stripeSubscriptionId,
          ).length;
        }
        if (Array.isArray(where.OR)) {
          return rows.filter(
            (row) => row.conversionTrackedAt || row.stripeSubscriptionId,
          ).length;
        }
        if (where.affiliateToken && typeof where.affiliateToken === "object") {
          const token = String(
            (where.affiliateToken as { contains?: string }).contains ?? "",
          ).toLowerCase();
          return rows.filter((row) =>
            String(row.affiliateToken ?? "").toLowerCase().includes(token),
          ).length;
        }
        return rows.length;
      },
      findMany: async (payload?: { where?: Record<string, unknown> }) => {
        const rows = Array.from(attributions.values());
        const where = payload?.where ?? {};
        if (where.affiliateToken && typeof where.affiliateToken === "object") {
          const token = String(
            (where.affiliateToken as { contains?: string }).contains ?? "",
          ).toLowerCase();
          return rows.filter((row) =>
            String(row.affiliateToken ?? "").toLowerCase().includes(token),
          );
        }
        return rows;
      },
      updateMany: async (payload: Record<string, unknown>) => {
        attributionUpdates.push(payload);
        return { count: 1 };
      },
    },
    rewardfulWebhookEvent: {
      create: async (payload: { data: Record<string, unknown> }) => {
        if (createUniqueConflictEventId === payload.data.eventId) {
          webhookEvents.set(String(payload.data.eventId), {
            id: "event-row-race",
            deliveryCount: 1,
            ...payload.data,
          });
          throw { code: "P2002" };
        }

        const record = {
          id: "event-row-1",
          deliveryCount: 1,
          ...payload.data,
        };
        webhookEvents.set(String(payload.data.eventId), record);
        return record;
      },
      findUnique: async (payload: { where: { eventId: string } }) =>
        webhookEvents.get(payload.where.eventId) ?? null,
      findFirst: async () =>
        Array.from(webhookEvents.values()).sort(
          (a, b) =>
            new Date(String(b.receivedAt ?? 0)).getTime() -
            new Date(String(a.receivedAt ?? 0)).getTime(),
        )[0] ?? null,
      findMany: async (payload?: { where?: Record<string, unknown> }) => {
        const rows = Array.from(webhookEvents.values());
        const where = payload?.where ?? {};
        return rows.filter((row) => {
          if (
            where.processingStatus &&
            row.processingStatus !== where.processingStatus
          ) {
            return false;
          }
          if (where.objectType && row.objectType !== where.objectType) {
            return false;
          }
          if (where.eventType && typeof where.eventType === "object") {
            const eventType = String(
              (where.eventType as { contains?: string }).contains ?? "",
            ).toLowerCase();
            return String(row.eventType ?? "").toLowerCase().includes(eventType);
          }
          return true;
        });
      },
      count: async (payload?: { where?: Record<string, unknown> }) => {
        const rows = Array.from(webhookEvents.values());
        const where = payload?.where ?? {};
        if (where.processingStatus) {
          const value = typeof where.processingStatus === "string"
            ? where.processingStatus
            : Array.isArray((where.processingStatus as { in?: string[] }).in)
              ? (where.processingStatus as { in: string[] }).in
              : null;
          if (Array.isArray(value)) {
            return rows.filter((row) =>
              value.includes(String(row.processingStatus ?? "")),
            ).length;
          }
          return rows.filter((row) => row.processingStatus === value).length;
        }
        if (where.objectType) {
          return rows.filter((row) => row.objectType === where.objectType).length;
        }
        if (where.eventType) {
          return rows.filter((row) => row.eventType === where.eventType).length;
        }
        if (Array.isArray(where.OR)) {
          return rows.filter(
            (row) =>
              row.objectType === "payout" ||
              Boolean(row.payoutId) ||
              row.objectType === "commission" ||
              Boolean(row.commissionId),
          ).length;
        }
        return rows.length;
      },
      update: async (payload: {
        data: { deliveryCount?: { increment: number } } & Record<string, unknown>;
        where: { eventId: string };
      }) => {
        const existing = webhookEvents.get(payload.where.eventId) ?? {};
        const next = {
          ...existing,
          ...payload.data,
          deliveryCount:
            Number(existing.deliveryCount ?? 0) +
            Number(payload.data.deliveryCount?.increment ?? 0),
          retryCount:
            Number(existing.retryCount ?? 0) +
            Number((payload.data.retryCount as { increment?: number } | undefined)?.increment ?? 0),
        };
        webhookEvents.set(payload.where.eventId, next);
        return next;
      },
    },
  },
}));

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function createMockResponse() {
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };

  return {
    res,
    get body() {
      return body;
    },
    get statusCode() {
      return statusCode;
    },
  };
}

describe("Rewardful webhook handling", () => {
  let controller: typeof import("../controllers/rewardful.controller");

  beforeEach(async () => {
    process.env.REWARDFUL_WEBHOOK_SECRET = "rewardful-secret";
    process.env.REWARDFUL_API_SECRET = "";
    attributions = new Map();
    webhookEvents = new Map();
    attributionUpdates = [];
    createUniqueConflictEventId = null;
    controller = await import("../controllers/rewardful.controller");
  });

  it("verifies Rewardful HMAC signatures", () => {
    const payload = JSON.stringify({ event: { id: "evt_1" } });
    const signature = sign(payload, "rewardful-secret");

    expect(
      controller.verifyRewardfulWebhookSignature({
        payload,
        secret: "rewardful-secret",
        signature,
      }),
    ).toBe(true);
    expect(
      controller.verifyRewardfulWebhookSignature({
        payload,
        secret: "rewardful-secret",
        signature: "bad",
      }),
    ).toBe(false);
  });

  it("normalizes referral converted webhook payloads", () => {
    const normalized = controller.normalizeRewardfulWebhookPayload({
      event: { id: "evt_1", type: "referral.converted" },
      object: {
        id: "ref_123",
        affiliate: { id: "aff_123" },
        stripe_customer_id: "cus_123",
      },
      request: { id: "req_123" },
    });

    expect(normalized).toMatchObject({
      affiliateId: "aff_123",
      eventId: "evt_1",
      eventType: "referral.converted",
      objectType: "referral",
      referralId: "ref_123",
      stripeCustomerId: "cus_123",
    });
  });

  it("normalizes payout and affiliate lifecycle payloads", () => {
    expect(
      controller.normalizeRewardfulWebhookPayload({
        event: { id: "evt_payout", type: "payout.paid" },
        object: { id: "payout_123", state: "paid" },
      }),
    ).toMatchObject({
      eventType: "payout.paid",
      objectType: "payout",
      payoutId: "payout_123",
    });
    expect(
      controller.normalizeRewardfulWebhookPayload({
        event: { id: "evt_affiliate", type: "affiliate.updated" },
        object: { id: "aff_123" },
      }),
    ).toMatchObject({ affiliateId: "aff_123", objectType: "affiliate" });
  });

  it("persists Rewardful webhooks idempotently", async () => {
    const payload = {
      event: { id: "evt_1", type: "referral.converted" },
      object: {
        id: "ref_123",
        affiliate: { id: "aff_123" },
        stripe_customer_id: "cus_123",
      },
      request: { id: "req_123" },
    };
    const rawBody = JSON.stringify(payload);

    for (let attempt = 0; attempt < 2; attempt++) {
      const mockResponse = createMockResponse();
      await controller.handleRewardfulWebhook(
        {
          body: payload,
          headers: {
            "x-rewardful-signature": sign(rawBody, "rewardful-secret"),
          },
          rawBody,
        } as unknown as Parameters<typeof controller.handleRewardfulWebhook>[0],
        mockResponse.res as Parameters<typeof controller.handleRewardfulWebhook>[1],
      );

      expect(mockResponse.statusCode).toBe(200);
    }

    expect(webhookEvents.size).toBe(1);
    expect(webhookEvents.get("evt_1")?.deliveryCount).toBe(2);
    expect(attributionUpdates.length).toBe(1);
  });

  it("treats create unique conflicts as duplicate webhook deliveries", async () => {
    const payload = {
      event: { id: "evt_race", type: "sale.created" },
      object: {
        id: "sale_123",
        referral_id: "ref_123",
        stripe_customer_id: "cus_123",
      },
      request: { id: "req_race" },
    };
    const rawBody = JSON.stringify(payload);
    createUniqueConflictEventId = "evt_race";

    const mockResponse = createMockResponse();
    await controller.handleRewardfulWebhook(
      {
        body: payload,
        headers: {
          "x-rewardful-signature": sign(rawBody, "rewardful-secret"),
        },
        rawBody,
      } as unknown as Parameters<typeof controller.handleRewardfulWebhook>[0],
      mockResponse.res as Parameters<typeof controller.handleRewardfulWebhook>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect(webhookEvents.size).toBe(1);
    expect(webhookEvents.get("evt_race")?.deliveryCount).toBe(2);
    expect(attributionUpdates).toHaveLength(1);
  });

  it("automatically reprocesses a failed event when Rewardful redelivers it", async () => {
    const payload = {
      event: { id: "evt_failed_retry", type: "referral.converted" },
      object: {
        id: "ref_retry",
        stripe_customer_id: "cus_retry",
      },
    };
    webhookEvents.set("evt_failed_retry", {
      deliveryCount: 1,
      eventId: "evt_failed_retry",
      eventType: "referral.converted",
      processingStatus: "failed",
    });
    const rawBody = JSON.stringify(payload);
    const mockResponse = createMockResponse();

    await controller.handleRewardfulWebhook(
      {
        body: payload,
        headers: {
          "x-rewardful-signature": sign(rawBody, "rewardful-secret"),
        },
        rawBody,
      } as unknown as Parameters<typeof controller.handleRewardfulWebhook>[0],
      mockResponse.res as Parameters<typeof controller.handleRewardfulWebhook>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect(webhookEvents.get("evt_failed_retry")?.deliveryCount).toBe(2);
    expect(webhookEvents.get("evt_failed_retry")?.processingStatus).toBe(
      "processed",
    );
    expect(webhookEvents.get("evt_failed_retry")?.retryCount).toBe(1);
    expect(attributionUpdates).toHaveLength(1);
  });

  it("returns Rewardful admin summary metrics and health without an API secret", async () => {
    attributions.set("attr_1", {
      id: "attr_1",
      affiliateToken: "partner-a",
      conversionTrackedAt: new Date(),
    });
    attributions.set("attr_2", {
      id: "attr_2",
      affiliateToken: "partner-b",
      conversionTrackedAt: null,
      stripeSubscriptionId: null,
    });
    webhookEvents.set("evt_sale", {
      eventId: "evt_sale",
      eventType: "sale.created",
      objectType: "sale",
      processingStatus: "processed",
      receivedAt: "2026-07-09T12:00:00.000Z",
    });
    webhookEvents.set("evt_failed", {
      eventId: "evt_failed",
      eventType: "commission.created",
      objectType: "commission",
      processingStatus: "failed",
      receivedAt: "2026-07-09T12:05:00.000Z",
    });

    const mockResponse = createMockResponse();
    await controller.getRewardfulAdminSummary(
      { query: {} } as unknown as Parameters<
        typeof controller.getRewardfulAdminSummary
      >[0],
      mockResponse.res as Parameters<typeof controller.getRewardfulAdminSummary>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect((mockResponse.body as any).data.metrics.totalReferredUsers).toBe(2);
    expect((mockResponse.body as any).data.metrics.convertedReferralCount).toBe(1);
    expect((mockResponse.body as any).data.metrics.failedWebhookCount).toBe(1);
    expect((mockResponse.body as any).data.health.configured).toBe(false);
  });

  it("filters Rewardful attributions for admin listing", async () => {
    attributions.set("attr_1", {
      id: "attr_1",
      affiliateToken: "partner-a",
      user: { email: "a@example.com", id: "user-1", name: "A" },
    });
    attributions.set("attr_2", {
      id: "attr_2",
      affiliateToken: "partner-b",
      user: { email: "b@example.com", id: "user-2", name: "B" },
    });

    const mockResponse = createMockResponse();
    await controller.listRewardfulAttributions(
      { query: { affiliateToken: "partner-a" } } as unknown as Parameters<
        typeof controller.listRewardfulAttributions
      >[0],
      mockResponse.res as Parameters<typeof controller.listRewardfulAttributions>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect((mockResponse.body as any).data.items).toHaveLength(1);
    expect((mockResponse.body as any).data.items[0].affiliateToken).toBe("partner-a");
  });

  it("retries a stored failed webhook idempotently without creating duplicate rows", async () => {
    webhookEvents.set("evt_retry", {
      eventId: "evt_retry",
      eventType: "referral.converted",
      objectType: "referral",
      processingStatus: "failed",
      retryCount: 0,
      payload: {
        event: { id: "evt_retry", type: "referral.converted" },
        object: {
          id: "ref_123",
          stripe_customer_id: "cus_123",
        },
      },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const mockResponse = createMockResponse();
      await controller.retryRewardfulWebhookEvent(
        { params: { eventId: "evt_retry" } } as unknown as Parameters<
          typeof controller.retryRewardfulWebhookEvent
        >[0],
        mockResponse.res as Parameters<
          typeof controller.retryRewardfulWebhookEvent
        >[1],
      );

      expect(mockResponse.statusCode).toBe(200);
    }

    expect(webhookEvents.size).toBe(1);
    expect(webhookEvents.get("evt_retry")?.processingStatus).toBe("processed");
    expect(webhookEvents.get("evt_retry")?.retryCount).toBe(2);
    expect(attributionUpdates).toHaveLength(2);
  });

  it("does not retry ignored Rewardful webhook events", async () => {
    webhookEvents.set("evt_ignored", {
      eventId: "evt_ignored",
      eventType: "unsupported.event",
      objectType: "unsupported",
      processingStatus: "ignored",
      retryCount: 0,
      payload: {
        event: { id: "evt_ignored", type: "unsupported.event" },
        object: { id: "unsupported_1" },
      },
    });

    const mockResponse = createMockResponse();
    await controller.retryRewardfulWebhookEvent(
      { params: { eventId: "evt_ignored" } } as unknown as Parameters<
        typeof controller.retryRewardfulWebhookEvent
      >[0],
      mockResponse.res as Parameters<
        typeof controller.retryRewardfulWebhookEvent
      >[1],
    );

    expect(mockResponse.statusCode).toBe(409);
    expect(webhookEvents.size).toBe(1);
    expect(webhookEvents.get("evt_ignored")?.processingStatus).toBe("ignored");
    expect(webhookEvents.get("evt_ignored")?.retryCount).toBe(0);
  });

  it("marks invalid stored webhook payloads as failed when retry is attempted", async () => {
    webhookEvents.set("evt_invalid", {
      eventId: "evt_invalid",
      eventType: "sale.created",
      objectType: "sale",
      processingStatus: "failed",
      retryCount: 0,
      payload: null,
    });

    const mockResponse = createMockResponse();
    await controller.retryRewardfulWebhookEvent(
      { params: { eventId: "evt_invalid" } } as unknown as Parameters<
        typeof controller.retryRewardfulWebhookEvent
      >[0],
      mockResponse.res as Parameters<
        typeof controller.retryRewardfulWebhookEvent
      >[1],
    );

    expect(mockResponse.statusCode).toBe(400);
    expect(webhookEvents.get("evt_invalid")?.processingStatus).toBe("failed");
    expect(webhookEvents.get("evt_invalid")?.retryCount).toBe(1);
  });
});
