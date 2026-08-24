import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  verifyFathomWebhookSignature,
  verifyFirefliesWebhookSignature,
} from "../command/call-webhook-signature";
import {
  claimCommandCallWebhookEvent,
  completeCommandCallWebhookEvent,
  releaseCommandCallWebhookEvent,
} from "../command/call-webhook-safety";
import { resolveApprovedCommandDecisions } from "../command/decision.service";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import { invalidateCommandCache } from "../utils/command-cache";
import { sendError, sendSuccess } from "../utils/response.utils";

const firefliesPayload = z
  .object({
    event: z.string(),
    timestamp: z.number(),
    meeting_id: z.string().min(1).max(255),
  })
  .passthrough();

const fathomPayload = z
  .object({
    recording_id: z.union([z.string(), z.number()]).transform(String),
    title: z.string().nullable().optional(),
    meeting_title: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
    share_url: z.string().url().nullable().optional(),
    created_at: z.string().datetime().nullable().optional(),
    recording_start_time: z.string().datetime(),
    recording_end_time: z.string().datetime().nullable().optional(),
    recorded_by: z.object({ email: z.string().email(), name: z.string().optional() }),
    calendar_invitees: z
      .array(z.object({ email: z.string().email(), name: z.string().optional() }).passthrough())
      .default([]),
    default_summary: z
      .object({ markdown_formatted: z.string().nullable().optional() })
      .nullable()
      .optional(),
    action_items: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

function rawBody(req: Request): string | null {
  return typeof req.rawBody === "string" && req.rawBody ? req.rawBody : null;
}

function providerTimestamp(value: number): Date {
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
}

function selectedMeetingPolicy(
  decisions: Awaited<ReturnType<typeof resolveApprovedCommandDecisions>>,
) {
  const value = decisions.meeting_provider?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = "provider" in value ? value.provider : null;
  const retentionDays = "retentionDays" in value ? value.retentionDays : null;
  const consentPolicy = "consentPolicy" in value ? value.consentPolicy : null;
  if (
    (provider !== "fireflies" && provider !== "fathom") ||
    typeof retentionDays !== "number" ||
    (consentPolicy !== "provider_managed" && consentPolicy !== "explicit_consent")
  ) {
    return null;
  }
  return { provider, retentionDays, consentPolicy };
}

async function matchRelations(organizerEmail: string | null, participants: string[]) {
  const normalizedOrganizer = organizerEmail?.trim().toLowerCase() ?? null;
  const rep = normalizedOrganizer
    ? await prisma.commandRepProfile.findFirst({
        where: {
          user: { email: { equals: normalizedOrganizer, mode: "insensitive" } },
        },
        select: { id: true },
      })
    : null;
  const externalEmails = participants
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email && email !== normalizedOrganizer);
  const account = externalEmails.length
    ? await prisma.commandAccount.findFirst({
        where: { normalizedEmail: { in: externalEmails } },
        select: { id: true },
      })
    : null;
  return { repId: rep?.id ?? null, accountId: account?.id ?? null };
}

async function queueReview(callId: string, provider: string, providerEventId: string) {
  await inngest.send({
    id: `command-call-review:${createHash("sha256").update(providerEventId).digest("hex")}`,
    name: "command/call.review.requested",
    data: { callId, provider },
  });
}

async function claimWebhookEvent(res: Response, eventId: string): Promise<boolean> {
  const claim = await claimCommandCallWebhookEvent(
    prisma.commandCallWebhookEvent,
    eventId,
  );
  if (claim.status === "claimed") return true;
  if (claim.status === "duplicate") {
    sendSuccess(res, { accepted: true, duplicate: true }, "Webhook already processed", 202);
    return false;
  }
  if (claim.status === "in_progress") {
    res.setHeader("Retry-After", String(claim.retryAfterSeconds));
    sendError(res, "Webhook processing is already in progress", 503);
    return false;
  }
  sendError(res, "Webhook delivery could not be durably tracked", 503);
  return false;
}

export async function receiveFirefliesCommandWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const body = rawBody(req);
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET?.trim() ?? "";
  if (
    !body ||
    !verifyFirefliesWebhookSignature({
      rawBody: body,
      signature: req.get("X-Hub-Signature"),
      secret,
    })
  ) {
    sendError(res, "Unauthorized", 401);
    return;
  }
  const parsed = firefliesPayload.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid webhook", 400);
    return;
  }
  let claimedEventId: string | null = null;
  try {
    const policy = selectedMeetingPolicy(await resolveApprovedCommandDecisions());
    if (policy?.provider !== "fireflies") {
      sendError(res, "Webhook is not enabled", 409);
      return;
    }
    const providerEventId = `${parsed.data.event}:${parsed.data.timestamp}`;
    claimedEventId = `fireflies:${parsed.data.meeting_id}:${providerEventId}`;
    if (!(await claimWebhookEvent(res, claimedEventId))) return;
    const providerCreatedAt = providerTimestamp(parsed.data.timestamp);
    const retentionExpiresAt = new Date(
      providerCreatedAt.getTime() + policy.retentionDays * 86_400_000,
    );
    const call = await prisma.commandCall.upsert({
      where: {
        provider_providerCallId: {
          provider: "fireflies",
          providerCallId: parsed.data.meeting_id,
        },
      },
      create: {
        provider: "fireflies",
        providerCallId: parsed.data.meeting_id,
        lastProviderEventId: providerEventId,
        startedAt: providerCreatedAt,
        participantEmails: [],
        consentState: policy.consentPolicy,
        retentionExpiresAt,
        providerPayloadHash: createHash("sha256").update(body).digest("hex"),
        providerCreatedAt,
      },
      update: {
        lastProviderEventId: providerEventId,
        retentionExpiresAt,
        providerPayloadHash: createHash("sha256").update(body).digest("hex"),
      },
    });
    await queueReview(call.id, "fireflies", claimedEventId);
    await invalidateCommandCache();
    if (
      !(await completeCommandCallWebhookEvent(
        prisma.commandCallWebhookEvent,
        claimedEventId,
      ))
    ) {
      throw new Error("Webhook delivery could not be marked processed");
    }
    sendSuccess(res, { accepted: true }, "Webhook accepted", 202);
  } catch (error) {
    if (claimedEventId) {
      await releaseCommandCallWebhookEvent(
        prisma.commandCallWebhookEvent,
        claimedEventId,
        error,
      );
    }
    sendError(res, "Webhook could not be processed", 500, error);
  }
}

export async function receiveFathomCommandWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const body = rawBody(req);
  const secret = process.env.FATHOM_WEBHOOK_SECRET?.trim() ?? "";
  if (
    !body ||
    !verifyFathomWebhookSignature({
      rawBody: body,
      webhookId: req.get("webhook-id"),
      timestamp: req.get("webhook-timestamp"),
      signature: req.get("webhook-signature"),
      secret,
    })
  ) {
    sendError(res, "Unauthorized", 401);
    return;
  }
  const parsed = fathomPayload.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid webhook", 400);
    return;
  }
  let claimedEventId: string | null = null;
  try {
    const policy = selectedMeetingPolicy(await resolveApprovedCommandDecisions());
    if (policy?.provider !== "fathom") {
      sendError(res, "Webhook is not enabled", 409);
      return;
    }
    const webhookId = req.get("webhook-id");
    if (!webhookId) {
      sendError(res, "Invalid webhook", 400);
      return;
    }
    claimedEventId = `fathom:${webhookId}`;
    if (!(await claimWebhookEvent(res, claimedEventId))) return;
    const organizerEmail = parsed.data.recorded_by.email.toLowerCase();
    const participantEmails = parsed.data.calendar_invitees.map((item) =>
      item.email.toLowerCase(),
    );
    const startedAt = new Date(parsed.data.recording_start_time);
    const endedAt = parsed.data.recording_end_time
      ? new Date(parsed.data.recording_end_time)
      : null;
    const relations = await matchRelations(organizerEmail, participantEmails);
    const retentionExpiresAt = new Date(
      startedAt.getTime() + policy.retentionDays * 86_400_000,
    );
    const call = await prisma.commandCall.upsert({
      where: {
        provider_providerCallId: {
          provider: "fathom",
          providerCallId: parsed.data.recording_id,
        },
      },
      create: {
        provider: "fathom",
        providerCallId: parsed.data.recording_id,
        lastProviderEventId: webhookId,
        repId: relations.repId,
        accountId: relations.accountId,
        title: parsed.data.meeting_title ?? parsed.data.title ?? null,
        startedAt,
        durationSeconds: endedAt
          ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
          : null,
        participantEmails,
        organizerEmail,
        summary: parsed.data.default_summary?.markdown_formatted?.slice(0, 20_000) ?? null,
        actionItems: (parsed.data.action_items ?? []) as Prisma.InputJsonValue,
        transcriptUrl: parsed.data.share_url ?? parsed.data.url ?? null,
        recordingUrl: parsed.data.url ?? null,
        consentState: policy.consentPolicy,
        retentionExpiresAt,
        providerPayloadHash: createHash("sha256").update(body).digest("hex"),
        providerCreatedAt: parsed.data.created_at
          ? new Date(parsed.data.created_at)
          : startedAt,
      },
      update: {
        lastProviderEventId: webhookId,
        repId: relations.repId,
        accountId: relations.accountId,
        title: parsed.data.meeting_title ?? parsed.data.title ?? null,
        durationSeconds: endedAt
          ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
          : null,
        participantEmails,
        organizerEmail,
        summary: parsed.data.default_summary?.markdown_formatted?.slice(0, 20_000) ?? null,
        actionItems: (parsed.data.action_items ?? []) as Prisma.InputJsonValue,
        transcriptUrl: parsed.data.share_url ?? parsed.data.url ?? null,
        recordingUrl: parsed.data.url ?? null,
        retentionExpiresAt,
        providerPayloadHash: createHash("sha256").update(body).digest("hex"),
      },
    });
    await queueReview(call.id, "fathom", claimedEventId);
    await invalidateCommandCache();
    if (
      !(await completeCommandCallWebhookEvent(
        prisma.commandCallWebhookEvent,
        claimedEventId,
      ))
    ) {
      throw new Error("Webhook delivery could not be marked processed");
    }
    sendSuccess(res, { accepted: true }, "Webhook accepted", 202);
  } catch (error) {
    if (claimedEventId) {
      await releaseCommandCallWebhookEvent(
        prisma.commandCallWebhookEvent,
        claimedEventId,
        error,
      );
    }
    sendError(res, "Webhook could not be processed", 500, error);
  }
}
