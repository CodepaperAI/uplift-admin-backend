import { createHmac, timingSafeEqual } from "node:crypto";
import { escapeLikePattern } from "../utils/like-pattern";
import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import {
  getRewardfulApiHealth,
  isRewardfulRemoteResource,
  listRewardfulRemoteResource,
} from "../services/rewardful-api.service";
import { sendError, sendSuccess } from "../utils/response.utils";

type RawBodyRequest = Request & { rawBody?: string };

type RewardfulWebhookPayload = {
  event?: {
    id?: string;
    type?: string;
    created_at?: string;
  };
  object?: Record<string, unknown>;
  request?: {
    id?: string;
  };
};

type NormalizedRewardfulWebhook = {
  amountCents: number | null;
  affiliateId: string | null;
  commissionId: string | null;
  currency: string | null;
  eventId: string;
  eventType: string;
  objectId: string | null;
  objectType: string | null;
  payoutId: string | null;
  referralId: string | null;
  saleId: string | null;
  status: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

const SUPPORTED_REWARDFUL_EVENT_TYPES = new Set([
  "affiliate.created",
  "affiliate.confirmed",
  "affiliate.updated",
  "affiliate.deleted",
  "referral.created",
  "referral.lead",
  "referral.converted",
  "referral.deleted",
  "sale.created",
  "sale.updated",
  "sale.refunded",
  "sale.deleted",
  "commission.created",
  "commission.updated",
  "commission.paid",
  "commission.voided",
  "commission.deleted",
  "payout.created",
  "payout.updated",
  "payout.due",
  "payout.paid",
  "payout.deleted",
  "payout.failed",
]);

const REWARDFUL_PROCESSING_STATUS = {
  FAILED: "failed",
  IGNORED: "ignored",
  PROCESSED: "processed",
  RECEIVED: "received",
} as const;

const RETRYABLE_PROCESSING_STATUSES: ReadonlySet<string> = new Set([
  REWARDFUL_PROCESSING_STATUS.FAILED,
  REWARDFUL_PROCESSING_STATUS.RECEIVED,
]);

type PaginationParams = {
  limit: number;
  page: number;
  skip: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nestedRecord(
  object: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = object?.[key];
  return isRecord(value) ? value : null;
}

function nestedString(
  object: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return cleanString(object?.[key]);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function getObjectType(eventType: string): string | null {
  const [objectType] = eventType.split(".");
  return objectType || null;
}

function getRawBody(req: RawBodyRequest): string {
  return req.rawBody ?? JSON.stringify(req.body ?? {});
}

function getRewardfulWebhookSecret(): string {
  return process.env.REWARDFUL_WEBHOOK_SECRET?.trim() ?? "";
}

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === "P2002";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "Rewardful processing failed";
}

function firstQueryValue(value: unknown): string | null {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return cleanString(value);
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(firstQueryValue(value) ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function getPagination(req: Request): PaginationParams {
  const limit = parsePositiveInt(req.query.limit, 25, 200);
  const page = parsePositiveInt(req.query.page, 1, 5000);
  return {
    limit,
    page,
    skip: (page - 1) * limit,
  };
}

function dateRangeFilter(
  fromValue: unknown,
  toValue: unknown,
): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  const from = firstQueryValue(fromValue);
  const to = firstQueryValue(toValue);
  if (from) {
    const parsed = new Date(from);
    if (Number.isFinite(parsed.getTime())) range.gte = parsed;
  }
  if (to) {
    const parsed = new Date(to);
    if (Number.isFinite(parsed.getTime())) range.lte = parsed;
  }
  return Object.keys(range).length > 0 ? range : undefined;
}

function appendQueryValue(
  params: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => appendQueryValue(params, key, item));
    return;
  }

  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) {
    params.append(key, trimmed);
  }
}

function buildRewardfulApiQuery(req: Request): URLSearchParams {
  const params = new URLSearchParams();
  const allowedKeys = [
    "affiliate_id",
    "conversion_state",
    "conversion_state[]",
    "email",
    "expand",
    "expand[]",
    "limit",
    "page",
    "state",
    "state[]",
    "stripe_customer_id",
    "updated_since",
    "updated_until",
  ];

  for (const key of allowedKeys) {
    appendQueryValue(params, key, req.query[key]);
  }

  return params;
}

function buildAttributionWhere(req: Request): Prisma.RewardfulAttributionWhereInput {
  const where: Prisma.RewardfulAttributionWhereInput = {};
  const affiliateToken = firstQueryValue(req.query.affiliateToken);
  const affiliateId = firstQueryValue(req.query.affiliateId);
  const referralId = firstQueryValue(req.query.referralId);
  const stripeCustomerId = firstQueryValue(req.query.stripeCustomerId);
  const stripeSubscriptionId = firstQueryValue(req.query.stripeSubscriptionId);
  const status = firstQueryValue(req.query.status);
  const search = firstQueryValue(req.query.search);
  const capturedAt = dateRangeFilter(req.query.from, req.query.to);

  if (affiliateToken) where.affiliateToken = { contains: affiliateToken, mode: "insensitive" };
  if (affiliateId) where.affiliateId = { contains: affiliateId, mode: "insensitive" };
  if (referralId) where.referralId = { contains: referralId, mode: "insensitive" };
  if (stripeCustomerId) {
    where.stripeCustomerId = { contains: stripeCustomerId, mode: "insensitive" };
  }
  if (stripeSubscriptionId) {
    where.stripeSubscriptionId = {
      contains: stripeSubscriptionId,
      mode: "insensitive",
    };
  }
  if (capturedAt) where.capturedAt = capturedAt;

  if (status === "converted") {
    where.OR = [
      { conversionTrackedAt: { not: null } },
      { stripeSubscriptionId: { not: null } },
    ];
  } else if (status === "pending") {
    where.conversionTrackedAt = null;
    where.stripeSubscriptionId = null;
  }

  if (search) {
    // Escaped: `contains` compiles to ILIKE and Prisma passes the value through,
    // so `_` and `%` typed into a search box were acting as wildcards.
    const searchTerm = escapeLikePattern(search);
    const userSearch: Prisma.RewardfulAttributionWhereInput = {
      user: {
        OR: [
          { email: { contains: searchTerm, mode: "insensitive" } },
          { name: { contains: searchTerm, mode: "insensitive" } },
        ],
      },
    };
    where.AND = where.AND
      ? Array.isArray(where.AND)
        ? [...where.AND, userSearch]
        : [where.AND, userSearch]
      : [userSearch];
  }

  return where;
}

function buildWebhookEventWhere(req: Request): Prisma.RewardfulWebhookEventWhereInput {
  const where: Prisma.RewardfulWebhookEventWhereInput = {};
  const affiliateId = firstQueryValue(req.query.affiliateId);
  const commissionId = firstQueryValue(req.query.commissionId);
  const eventType = firstQueryValue(req.query.eventType);
  const objectType = firstQueryValue(req.query.objectType);
  const payoutId = firstQueryValue(req.query.payoutId);
  const processingStatus = firstQueryValue(req.query.processingStatus);
  const referralId = firstQueryValue(req.query.referralId);
  const saleId = firstQueryValue(req.query.saleId);
  const status = firstQueryValue(req.query.status);
  const stripeCustomerId = firstQueryValue(req.query.stripeCustomerId);
  const stripeSubscriptionId = firstQueryValue(req.query.stripeSubscriptionId);
  const receivedAt = dateRangeFilter(req.query.from, req.query.to);

  if (affiliateId) where.affiliateId = { contains: affiliateId, mode: "insensitive" };
  if (commissionId) {
    where.commissionId = { contains: commissionId, mode: "insensitive" };
  }
  if (eventType) where.eventType = { contains: eventType, mode: "insensitive" };
  if (objectType) where.objectType = objectType;
  if (payoutId) where.payoutId = { contains: payoutId, mode: "insensitive" };
  if (processingStatus) where.processingStatus = processingStatus;
  if (referralId) where.referralId = { contains: referralId, mode: "insensitive" };
  if (saleId) where.saleId = { contains: saleId, mode: "insensitive" };
  if (status) where.status = { contains: status, mode: "insensitive" };
  if (stripeCustomerId) {
    where.stripeCustomerId = { contains: stripeCustomerId, mode: "insensitive" };
  }
  if (stripeSubscriptionId) {
    where.stripeSubscriptionId = {
      contains: stripeSubscriptionId,
      mode: "insensitive",
    };
  }
  if (receivedAt) where.receivedAt = receivedAt;

  return where;
}

export function verifyRewardfulWebhookSignature(input: {
  payload: string;
  secret: string;
  signature?: string | null;
}): boolean {
  if (!input.payload || !input.secret || !input.signature) return false;

  const expected = createHmac("sha256", input.secret)
    .update(input.payload)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(input.signature, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function normalizeRewardfulWebhookPayload(
  payload: RewardfulWebhookPayload,
): NormalizedRewardfulWebhook | null {
  const eventType = cleanString(payload.event?.type);
  const object = isRecord(payload.object) ? payload.object : null;
  const objectId = nestedString(object, "id");
  const objectType = eventType ? getObjectType(eventType) : null;
  const eventId =
    cleanString(payload.event?.id) ||
    cleanString(payload.request?.id) ||
    (eventType && objectId ? `${eventType}:${objectId}` : null);

  if (!eventType || !eventId) {
    return null;
  }

  const referralRecord = nestedRecord(object, "referral");
  const affiliateRecord = nestedRecord(object, "affiliate");
  const saleRecord = nestedRecord(object, "sale");
  const commissionRecord = nestedRecord(object, "commission");
  const payoutRecord = nestedRecord(object, "payout");
  const customerRecord =
    nestedRecord(object, "customer") || nestedRecord(object, "stripe_customer");
  const subscriptionRecord =
    nestedRecord(object, "subscription") ||
    nestedRecord(object, "stripe_subscription");

  return {
    amountCents:
      numberOrNull(object?.amount_cents) ||
      numberOrNull(object?.amount) ||
      numberOrNull(object?.commission_amount_cents),
    affiliateId:
      (objectType === "affiliate" ? objectId : null) ||
      nestedString(affiliateRecord, "id") ||
      nestedString(object, "affiliate_id"),
    commissionId:
      objectType === "commission"
        ? objectId
        : nestedString(commissionRecord, "id") ||
          nestedString(object, "commission_id"),
    currency: nestedString(object, "currency"),
    eventId,
    eventType,
    objectId,
    objectType,
    payoutId:
      objectType === "payout"
        ? objectId
        : nestedString(payoutRecord, "id") || nestedString(object, "payout_id"),
    referralId:
      objectType === "referral"
        ? objectId
        : nestedString(referralRecord, "id") ||
          nestedString(object, "referral_id"),
    saleId:
      objectType === "sale"
        ? objectId
        : nestedString(saleRecord, "id") || nestedString(object, "sale_id"),
    status: nestedString(object, "status") || nestedString(object, "state"),
    stripeCustomerId:
      nestedString(customerRecord, "id") ||
      nestedString(object, "stripe_customer_id") ||
      nestedString(object, "stripe_customer"),
    stripeSubscriptionId:
      nestedString(subscriptionRecord, "id") ||
      nestedString(object, "stripe_subscription_id") ||
      nestedString(object, "stripe_subscription"),
  };
}

async function updateAttributionFromWebhook(event: NormalizedRewardfulWebhook) {
  const data = {
    ...(event.stripeCustomerId ? { stripeCustomerId: event.stripeCustomerId } : {}),
    ...(event.stripeSubscriptionId
      ? { stripeSubscriptionId: event.stripeSubscriptionId }
      : {}),
    ...(event.eventType === "referral.converted"
      ? { conversionTrackedAt: new Date() }
      : {}),
    lastSeenAt: new Date(),
  };

  if (Object.keys(data).length <= 1) return;

  if (event.referralId) {
    await prisma.rewardfulAttribution.updateMany({
      where: { referralId: event.referralId },
      data,
    });
    return;
  }

  if (event.stripeCustomerId) {
    await prisma.rewardfulAttribution.updateMany({
      where: { stripeCustomerId: event.stripeCustomerId },
      data,
    });
  }
}

async function processNormalizedRewardfulEvent(
  normalized: NormalizedRewardfulWebhook,
): Promise<{ processedAt: Date | null; processingStatus: string; processingError: string | null }> {
  if (!SUPPORTED_REWARDFUL_EVENT_TYPES.has(normalized.eventType)) {
    return {
      processedAt: null,
      processingError: null,
      processingStatus: REWARDFUL_PROCESSING_STATUS.IGNORED,
    };
  }

  await updateAttributionFromWebhook(normalized);
  return {
    processedAt: new Date(),
    processingError: null,
    processingStatus: REWARDFUL_PROCESSING_STATUS.PROCESSED,
  };
}

async function recordDuplicateRewardfulDelivery(
  eventId: string,
  payload: RewardfulWebhookPayload,
) {
  return prisma.rewardfulWebhookEvent.update({
    where: { eventId },
    data: {
      deliveryCount: { increment: 1 },
      receivedAt: new Date(),
      payload: toJsonValue(payload),
    },
  });
}

async function processDuplicateRewardfulDelivery(input: {
  existingStatus: string;
  normalized: NormalizedRewardfulWebhook;
  payload: RewardfulWebhookPayload;
}) {
  let updated = await recordDuplicateRewardfulDelivery(
    input.normalized.eventId,
    input.payload,
  );

  if (!RETRYABLE_PROCESSING_STATUSES.has(input.existingStatus)) {
    return { event: updated, retried: false };
  }

  try {
    const processing = await processNormalizedRewardfulEvent(input.normalized);
    updated = await prisma.rewardfulWebhookEvent.update({
      where: { eventId: input.normalized.eventId },
      data: {
        ...processing,
        lastRetriedAt: new Date(),
        retryCount: { increment: 1 },
      },
    });
    return { event: updated, retried: true };
  } catch (processingError: unknown) {
    await prisma.rewardfulWebhookEvent.update({
      where: { eventId: input.normalized.eventId },
      data: {
        lastRetriedAt: new Date(),
        processedAt: null,
        processingError: getErrorMessage(processingError),
        processingStatus: REWARDFUL_PROCESSING_STATUS.FAILED,
        retryCount: { increment: 1 },
      },
    });
    throw processingError;
  }
}

export async function handleRewardfulWebhook(
  req: RawBodyRequest,
  res: Response,
): Promise<void> {
  try {
    const secret = getRewardfulWebhookSecret();
    if (!secret) {
      sendError(res, "Rewardful webhook secret not configured", 503);
      return;
    }

    const rawBody = getRawBody(req);
    const signatureHeader = req.headers["x-rewardful-signature"];
    const signature =
      typeof signatureHeader === "string"
        ? signatureHeader
        : Array.isArray(signatureHeader)
          ? signatureHeader[0]
          : null;

    if (
      !verifyRewardfulWebhookSignature({
        payload: rawBody,
        secret,
        signature,
      })
    ) {
      sendError(res, "Invalid Rewardful webhook signature", 401);
      return;
    }

    const payload = req.body as RewardfulWebhookPayload;
    const normalized = normalizeRewardfulWebhookPayload(payload);
    if (!normalized) {
      sendError(res, "Invalid Rewardful webhook payload", 400);
      return;
    }

    const existing = await prisma.rewardfulWebhookEvent.findUnique({
      where: { eventId: normalized.eventId },
    });

    if (existing) {
      const result = await processDuplicateRewardfulDelivery({
        existingStatus: existing.processingStatus,
        normalized,
        payload,
      });
      sendSuccess(
        res,
        { duplicate: true, event: result.event, retried: result.retried },
        result.retried
          ? "Rewardful event reprocessed"
          : "Rewardful event already processed",
      );
      return;
    }

    let created;
    try {
      created = await prisma.rewardfulWebhookEvent.create({
        data: {
          amountCents: normalized.amountCents,
          affiliateId: normalized.affiliateId,
          commissionId: normalized.commissionId,
          currency: normalized.currency,
          eventId: normalized.eventId,
          eventType: normalized.eventType,
          objectId: normalized.objectId,
          objectType: normalized.objectType,
          payoutId: normalized.payoutId,
          referralId: normalized.referralId,
          saleId: normalized.saleId,
          status: normalized.status,
          stripeCustomerId: normalized.stripeCustomerId,
          stripeSubscriptionId: normalized.stripeSubscriptionId,
          payload: toJsonValue(payload),
          processingStatus: REWARDFUL_PROCESSING_STATUS.RECEIVED,
        },
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const concurrent = await prisma.rewardfulWebhookEvent.findUnique({
          where: { eventId: normalized.eventId },
        });
        const result = await processDuplicateRewardfulDelivery({
          existingStatus:
            concurrent?.processingStatus ?? REWARDFUL_PROCESSING_STATUS.RECEIVED,
          normalized,
          payload,
        });
        sendSuccess(
          res,
          { duplicate: true, event: result.event, retried: result.retried },
          result.retried
            ? "Rewardful event reprocessed"
            : "Rewardful event already processed",
        );
        return;
      }

      throw error;
    }

    try {
      const processing = await processNormalizedRewardfulEvent(normalized);
      created = await prisma.rewardfulWebhookEvent.update({
        where: { eventId: normalized.eventId },
        data: processing,
      });
    } catch (processingError: unknown) {
      created = await prisma.rewardfulWebhookEvent.update({
        where: { eventId: normalized.eventId },
        data: {
          processedAt: null,
          processingError: getErrorMessage(processingError),
          processingStatus: REWARDFUL_PROCESSING_STATUS.FAILED,
        },
      });
      sendError(res, "Failed to process Rewardful webhook", 500, processingError);
      return;
    }

    sendSuccess(res, { duplicate: false, event: created }, "Rewardful event processed");
  } catch (error: unknown) {
    sendError(res, "Failed to process Rewardful webhook", 500, error);
  }
}

export async function listRewardfulWebhookEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const pagination = getPagination(req);
  const where = buildWebhookEventWhere(req);
  const [events, total] = await Promise.all([
    prisma.rewardfulWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.rewardfulWebhookEvent.count({ where }),
  ]);
  sendSuccess(
    res,
    {
      items: events,
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
    "Rewardful webhook events",
  );
}

export async function listRewardfulAttributions(
  req: Request,
  res: Response,
): Promise<void> {
  const pagination = getPagination(req);
  const where = buildAttributionWhere(req);
  const [attributions, total] = await Promise.all([
    prisma.rewardfulAttribution.findMany({
      where,
      include: {
        user: {
          select: {
            email: true,
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.rewardfulAttribution.count({ where }),
  ]);
  sendSuccess(
    res,
    {
      items: attributions,
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
    "Rewardful attributions",
  );
}

export async function getRewardfulAdminSummary(
  _req: Request,
  res: Response,
): Promise<void> {
  const [
    totalReferredUsers,
    convertedReferrals,
    pendingReferrals,
    sales,
    commissions,
    paidCommissions,
    voidedCommissions,
    refundedSales,
    payouts,
    failedWebhooks,
    retryableWebhooks,
    latestWebhook,
    health,
  ] = await Promise.all([
    prisma.rewardfulAttribution.count(),
    prisma.rewardfulAttribution.count({
      where: {
        OR: [
          { conversionTrackedAt: { not: null } },
          { stripeSubscriptionId: { not: null } },
        ],
      },
    }),
    prisma.rewardfulAttribution.count({
      where: {
        conversionTrackedAt: null,
        stripeSubscriptionId: null,
      },
    }),
    prisma.rewardfulWebhookEvent.count({ where: { objectType: "sale" } }),
    prisma.rewardfulWebhookEvent.count({ where: { objectType: "commission" } }),
    prisma.rewardfulWebhookEvent.count({
      where: { eventType: "commission.paid" },
    }),
    prisma.rewardfulWebhookEvent.count({
      where: { eventType: "commission.voided" },
    }),
    prisma.rewardfulWebhookEvent.count({ where: { eventType: "sale.refunded" } }),
    prisma.rewardfulWebhookEvent.count({
      where: {
        OR: [{ objectType: "payout" }, { payoutId: { not: null } }],
      },
    }),
    prisma.rewardfulWebhookEvent.count({
      where: { processingStatus: REWARDFUL_PROCESSING_STATUS.FAILED },
    }),
    prisma.rewardfulWebhookEvent.count({
      where: {
        processingStatus: {
          in: Array.from(RETRYABLE_PROCESSING_STATUSES),
        },
      },
    }),
    prisma.rewardfulWebhookEvent.findFirst({
      orderBy: { receivedAt: "desc" },
      select: {
        eventId: true,
        eventType: true,
        processingStatus: true,
        receivedAt: true,
      },
    }),
    getRewardfulApiHealth(),
  ]);

  sendSuccess(
    res,
    {
      health,
      latestWebhook,
      metrics: {
        commissionCount: commissions,
        convertedReferralCount: convertedReferrals,
        failedWebhookCount: failedWebhooks,
        paidCommissionCount: paidCommissions,
        payoutCount: payouts,
        pendingReferralCount: pendingReferrals,
        refundedSaleCount: refundedSales,
        retryableWebhookCount: retryableWebhooks,
        saleCount: sales,
        totalReferredUsers,
        voidedCommissionCount: voidedCommissions,
      },
    },
    "Rewardful admin summary",
  );
}

export async function retryRewardfulWebhookEvent(
  req: Request,
  res: Response,
): Promise<void> {
  const eventId = cleanString(req.params.eventId);
  if (!eventId) {
    sendError(res, "Rewardful event id is required", 400);
    return;
  }

  const stored = await prisma.rewardfulWebhookEvent.findUnique({
    where: { eventId },
  });
  if (!stored) {
    sendError(res, "Rewardful event not found", 404);
    return;
  }

  if (stored.processingStatus === REWARDFUL_PROCESSING_STATUS.IGNORED) {
    sendError(res, "Ignored Rewardful events are not retryable", 409);
    return;
  }

  const payload = isRecord(stored.payload)
    ? (stored.payload as RewardfulWebhookPayload)
    : null;
  const normalized = payload ? normalizeRewardfulWebhookPayload(payload) : null;
  if (!payload || !normalized) {
    const updated = await prisma.rewardfulWebhookEvent.update({
      where: { eventId },
      data: {
        lastRetriedAt: new Date(),
        processingError: "Stored Rewardful payload is invalid",
        processingStatus: REWARDFUL_PROCESSING_STATUS.FAILED,
        retryCount: { increment: 1 },
      },
    });
    sendError(res, "Stored Rewardful payload is invalid", 400, {
      code: "INVALID_REWARDFUL_PAYLOAD",
      message: "Stored Rewardful payload is invalid",
      details: { event: updated },
    });
    return;
  }

  try {
    const processing = await processNormalizedRewardfulEvent(normalized);
    const updated = await prisma.rewardfulWebhookEvent.update({
      where: { eventId },
      data: {
        ...processing,
        lastRetriedAt: new Date(),
        retryCount: { increment: 1 },
      },
    });
    sendSuccess(res, { event: updated }, "Rewardful event retried");
  } catch (error: unknown) {
    const updated = await prisma.rewardfulWebhookEvent.update({
      where: { eventId },
      data: {
        lastRetriedAt: new Date(),
        processedAt: null,
        processingError: getErrorMessage(error),
        processingStatus: REWARDFUL_PROCESSING_STATUS.FAILED,
        retryCount: { increment: 1 },
      },
    });
    sendError(res, "Failed to retry Rewardful event", 500, {
      code: "REWARDFUL_RETRY_FAILED",
      message: getErrorMessage(error),
      details: { event: updated },
    });
  }
}

export async function listRewardfulSalesAndConversions(
  req: Request,
  res: Response,
): Promise<void> {
  const pagination = getPagination(req);
  const where: Prisma.RewardfulWebhookEventWhereInput = {
    ...buildWebhookEventWhere(req),
    OR: [
      { objectType: "sale" },
      { eventType: "referral.converted" },
      { eventType: "referral.lead" },
    ],
  };
  const [events, total] = await Promise.all([
    prisma.rewardfulWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.rewardfulWebhookEvent.count({ where }),
  ]);
  sendSuccess(
    res,
    {
      items: events,
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
    "Rewardful sales and conversions",
  );
}

export async function listRewardfulCommissionsAndPayouts(
  req: Request,
  res: Response,
): Promise<void> {
  const pagination = getPagination(req);
  const where: Prisma.RewardfulWebhookEventWhereInput = {
    ...buildWebhookEventWhere(req),
    OR: [
      { objectType: "commission" },
      { objectType: "payout" },
      { commissionId: { not: null } },
      { payoutId: { not: null } },
    ],
  };
  const [events, total] = await Promise.all([
    prisma.rewardfulWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.rewardfulWebhookEvent.count({ where }),
  ]);
  sendSuccess(
    res,
    {
      items: events,
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
    "Rewardful commissions and payouts",
  );
}

export async function listRewardfulWebhookEventsLegacy(
  req: Request,
  res: Response,
): Promise<void> {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const where = buildWebhookEventWhere(req);
  const events = await prisma.rewardfulWebhookEvent.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
  sendSuccess(res, events, "Rewardful webhook events");
}

export async function getRewardfulIntegrationHealth(
  _req: Request,
  res: Response,
): Promise<void> {
  const health = await getRewardfulApiHealth();
  res.status(health.ok ? 200 : health.configured ? 502 : 503).json({
    success: health.ok,
    message: health.ok
      ? "Rewardful API connection is healthy"
      : "Rewardful API connection needs attention",
    data: health,
    timestamp: new Date().toISOString(),
  });
}

export async function listRewardfulRemoteData(
  req: Request,
  res: Response,
): Promise<void> {
  const resource = req.params.resource;
  if (!isRewardfulRemoteResource(resource)) {
    sendError(res, "Unsupported Rewardful resource", 400);
    return;
  }

  const result = await listRewardfulRemoteResource(
    resource,
    buildRewardfulApiQuery(req),
  );

  if (!result.ok) {
    sendError(
      res,
      result.error ?? "Rewardful API request failed",
      result.status || 502,
    );
    return;
  }

  sendSuccess(
    res,
    {
      resource,
      remote: result.data,
    },
    "Rewardful remote data",
  );
}
