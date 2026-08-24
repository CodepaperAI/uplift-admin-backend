import type { Request, Response } from "express";
import { z, ZodError } from "zod";

import { AGENCY_SETTLEMENTS_ENABLED } from "../config/feature-flags";
import { prisma } from "../config/db.config";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";

const BILLING_EVENT_SCHEMA = z
  .object({
    eventType: z.enum([
      "invoice.paid",
      "invoice.payment_succeeded",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.closed",
      "credit_note.created",
    ]),
    stripeEventId: z.string().min(3).max(255),
    stripeInvoiceId: z.string().max(255).nullable(),
    stripeSubscriptionId: z.string().max(255).nullable(),
    stripeChargeId: z.string().max(255).nullable(),
    amountPaidCents: z.number().int(),
    subtotalCents: z.number().int(),
    discountAmountCents: z.number().int(),
    taxAmountCents: z.number().int(),
    currency: z.string().regex(/^[a-zA-Z]{3}$/),
    metadata: z.record(z.string(), z.string()).default({}),
    periodStart: z.string().datetime().nullable(),
    periodEnd: z.string().datetime().nullable(),
  })
  .strict();

export type BillingEventPayload = z.infer<typeof BILLING_EVENT_SCHEMA>;
type LedgerEntryType = "collection" | "refund" | "dispute" | "credit";

const EVENT_TYPE_TO_ENTRY_TYPE: Record<
  BillingEventPayload["eventType"],
  LedgerEntryType | null
> = {
  "invoice.paid": "collection",
  "invoice.payment_succeeded": "collection",
  "charge.refunded": "refund",
  "charge.dispute.created": "dispute",
  "charge.dispute.closed": null,
  "credit_note.created": "credit",
};

const NEGATIVE_ENTRY_TYPES = new Set<LedgerEntryType>([
  "refund",
  "dispute",
  "credit",
]);
const DEFAULT_PLATFORM_SHARE_PERCENT = 60;
const DEFAULT_AGENCY_SHARE_PERCENT = 40;

export async function recordBillingLedgerEvent(raw: unknown) {
  const payload = BILLING_EVENT_SCHEMA.parse(raw);
  if (!AGENCY_SETTLEMENTS_ENABLED) {
    return { skipped: true, reason: "disabled" as const };
  }

  const existingEntry = await prisma.agencyRevenueLedger.findUnique({
    where: { stripeEventId: payload.stripeEventId },
  });
  if (existingEntry) {
    return { duplicate: true, entry: existingEntry };
  }

  const agencyId = payload.metadata.agencyId;
  const businessId = payload.metadata.businessId;
  if (!agencyId) {
    console.warn(
      "[agency-settlements] skipped event without agency binding: " +
        payload.stripeEventId,
    );
    return { skipped: true, reason: "no_agency" as const };
  }

  const entryType = EVENT_TYPE_TO_ENTRY_TYPE[payload.eventType];
  if (!entryType) {
    return { skipped: true, reason: "unmapped_event_type" as const };
  }

  const activeRule = await prisma.agencyRevenueShareRule.findFirst({
    where: { agencyId, isActive: true },
    orderBy: { effectiveFrom: "desc" },
  });
  const platformSharePercent =
    activeRule?.platformSharePercent ?? DEFAULT_PLATFORM_SHARE_PERCENT;
  const agencySharePercent =
    activeRule?.agencySharePercent ?? DEFAULT_AGENCY_SHARE_PERCENT;
  if (platformSharePercent + agencySharePercent !== 100) {
    throw new Error("Invalid agency revenue-share configuration");
  }

  const eligibleAmountCents =
    payload.subtotalCents -
    payload.discountAmountCents -
    payload.taxAmountCents;
  const platformShareAmountCents = Math.round(
    (eligibleAmountCents * platformSharePercent) / 100,
  );
  const agencyShareAmountCents =
    eligibleAmountCents - platformShareAmountCents;
  const sign = NEGATIVE_ENTRY_TYPES.has(entryType) ? -1 : 1;

  const entry = await prisma.agencyRevenueLedger.create({
    data: {
      agencyId,
      businessId: businessId ?? null,
      stripeInvoiceId: payload.stripeInvoiceId,
      stripeEventId: payload.stripeEventId,
      stripeSubscriptionId: payload.stripeSubscriptionId,
      stripeChargeId: payload.stripeChargeId,
      entryType,
      grossAmountCents: sign * payload.subtotalCents,
      discountAmountCents: sign * payload.discountAmountCents,
      taxAmountCents: sign * payload.taxAmountCents,
      eligibleAmountCents: sign * eligibleAmountCents,
      platformShareAmountCents: sign * platformShareAmountCents,
      agencyShareAmountCents: sign * agencyShareAmountCents,
      currency: payload.currency.toLowerCase(),
      periodStart: payload.periodStart
        ? new Date(payload.periodStart)
        : null,
      periodEnd: payload.periodEnd ? new Date(payload.periodEnd) : null,
    },
  });
  return { recorded: true, entry };
}

export async function handleBillingEvent(req: Request, res: Response) {
  try {
    const result = await recordBillingLedgerEvent(req.body);
    return sendSuccess(res, result, "Billing event processed");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("[agency-settlements] billing event failed", error);
    return sendError(res, "Failed to process billing event", 500);
  }
}
