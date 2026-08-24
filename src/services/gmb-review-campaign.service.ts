// GMB review-request campaign sender. Drives review volume — the
// strongest movable lever for local pack ranking. Pipeline:
//
//   1. User uploads contacts (CSV / API) for a campaign.
//   2. User flips the campaign from DRAFT -> ACTIVE.
//   3. The Inngest cron (gmbReviewCampaignDispatchTask) walks ACTIVE
//      campaigns, picks PENDING contacts, sends one email each via
//      Resend, marks them SENT.
//   4. Each email contains a token-based unsubscribe link
//      (/api/google-my-business/review-campaigns/unsubscribe/:token).
//      Clicking flips the contact to OPTED_OUT immediately and the
//      cron skips it forever.
//
// One email per contact ever — no follow-ups, by design. CASL/CAN-SPAM
// safe. Per-business send cap to prevent runaway dispatch.

import { Resend } from "resend";
import { randomBytes } from "node:crypto";
import { prisma } from "../config/db.config";
import { BRAND } from "../config/brand.config";

const PER_BUSINESS_DAILY_CAP = 50;
const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.APP_URL ??
  "https://upliftai.co";

function generateUnsubscribeToken(): string {
  // 32 bytes -> 64 hex chars. Long enough to make guessing infeasible.
  return randomBytes(32).toString("hex");
}

export type ContactInput = {
  email: string;
  name?: string;
  source?: "manual" | "csv" | "api";
};

/**
 * Bulk-upsert contacts onto a campaign. Returns counts so the caller can
 * surface "X added, Y updated, Z skipped" feedback. Skips invalid emails
 * silently to keep CSV uploads forgiving.
 */
export async function importReviewContacts(params: {
  campaignId: string;
  contacts: ContactInput[];
}): Promise<{ added: number; updated: number; skipped: number }> {
  const campaign = await prisma.gMBReviewCampaign.findUnique({
    where: { id: params.campaignId },
    select: { id: true, businessId: true },
  });
  if (!campaign) {
    throw new Error("Campaign not found");
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const contact of params.contacts) {
    const email = contact.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.gMBReviewContact.findUnique({
      where: { campaignId_email: { campaignId: campaign.id, email } },
      select: { id: true, status: true },
    });

    if (existing) {
      // Don't touch OPTED_OUT or SENT — re-import shouldn't resurrect them.
      if (existing.status === "PENDING" && contact.name) {
        await prisma.gMBReviewContact.update({
          where: { id: existing.id },
          data: { name: contact.name.trim() },
        });
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    await prisma.gMBReviewContact.create({
      data: {
        businessId: campaign.businessId,
        campaignId: campaign.id,
        email,
        name: contact.name?.trim() ?? null,
        source: contact.source ?? "manual",
        unsubscribeToken: generateUnsubscribeToken(),
        status: "PENDING",
      },
    });
    added += 1;
  }

  return { added, updated, skipped };
}

export async function activateCampaign(campaignId: string): Promise<void> {
  await prisma.gMBReviewCampaign.update({
    where: { id: campaignId },
    data: { status: "ACTIVE" },
  });
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  await prisma.gMBReviewCampaign.update({
    where: { id: campaignId },
    data: { status: "PAUSED" },
  });
}

export async function optOutByToken(token: string): Promise<boolean> {
  const contact = await prisma.gMBReviewContact.findUnique({
    where: { unsubscribeToken: token },
    select: { id: true, status: true },
  });
  if (!contact) return false;
  if (contact.status === "OPTED_OUT") return true; // idempotent

  await prisma.gMBReviewContact.update({
    where: { id: contact.id },
    data: { status: "OPTED_OUT", optedOutAt: new Date() },
  });
  return true;
}

/**
 * Send one review-request email per pending contact across ACTIVE campaigns.
 * Capped at PER_BUSINESS_DAILY_CAP per business per run so a fresh CSV
 * upload doesn't blast 5000 emails on the next tick.
 */
export async function dispatchPendingReviewRequests(): Promise<{
  campaignsTouched: number;
  sent: number;
  failed: number;
  skippedNoApiKey: boolean;
}> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[review-campaign] RESEND_API_KEY not set, dispatch skipped",
    );
    return { campaignsTouched: 0, sent: 0, failed: 0, skippedNoApiKey: true };
  }

  const resend = new Resend(apiKey);

  const activeCampaigns = await prisma.gMBReviewCampaign.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      businessId: true,
      name: true,
      reviewLink: true,
      emailSubject: true,
      emailBody: true,
      business: { select: { businessName: true } },
    },
  });

  if (activeCampaigns.length === 0) {
    return { campaignsTouched: 0, sent: 0, failed: 0, skippedNoApiKey: false };
  }

  let sent = 0;
  let failed = 0;
  let campaignsTouched = 0;

  for (const campaign of activeCampaigns) {
    const pending = await prisma.gMBReviewContact.findMany({
      where: { campaignId: campaign.id, status: "PENDING" },
      orderBy: { addedAt: "asc" },
      take: PER_BUSINESS_DAILY_CAP,
    });
    if (pending.length === 0) continue;
    campaignsTouched += 1;

    for (const contact of pending) {
      const unsubscribeUrl = `${APP_BASE_URL}/api/google-my-business/review-campaigns/unsubscribe/${contact.unsubscribeToken}`;
      const businessName =
        campaign.business?.businessName ?? "our business";
      const subject =
        campaign.emailSubject?.trim() ||
        `How was your experience with ${businessName}?`;
      const greeting = contact.name?.trim()
        ? `Hi ${contact.name.trim()},`
        : "Hi there,";
      const body =
        campaign.emailBody?.trim() ||
        `Thank you for choosing ${businessName}. If you have a moment, we'd really appreciate an honest review on Google — it helps other local customers make informed decisions.`;

      const html = `
        <p>${greeting}</p>
        <p>${body}</p>
        <p><a href="${campaign.reviewLink}" style="display:inline-block;padding:10px 18px;background:#1a73e8;color:#fff;border-radius:6px;text-decoration:none">Leave a Google review</a></p>
        <p style="color:#666;font-size:12px;margin-top:32px">You're receiving this from ${businessName} because you're a recent customer. <a href="${unsubscribeUrl}" style="color:#666">Unsubscribe</a> — one click, no questions asked.</p>
      `;
      const text =
        `${greeting}\n\n${body}\n\nLeave a Google review: ${campaign.reviewLink}\n\n` +
        `Unsubscribe (one click): ${unsubscribeUrl}\n`;

      try {
        const result = await resend.emails.send({
          from: `${BRAND.fromName} <${BRAND.fromEmail}>`,
          to: [contact.email],
          subject,
          html,
          text,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          tags: [
            { name: "type", value: "gmb-review-request" },
            { name: "campaign_id", value: campaign.id },
          ],
        });

        if (result.error) {
          failed += 1;
          await prisma.gMBReviewContact.update({
            where: { id: contact.id },
            data: {
              status: "BOUNCED",
              bouncedAt: new Date(),
              emailError: result.error.message ?? "send failed",
            },
          });
          continue;
        }

        await prisma.gMBReviewContact.update({
          where: { id: contact.id },
          data: { status: "SENT", lastEmailedAt: new Date() },
        });
        await prisma.gMBReviewCampaign.update({
          where: { id: campaign.id },
          data: { sentCount: { increment: 1 } },
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error ? error.message : String(error);
        await prisma.gMBReviewContact.update({
          where: { id: contact.id },
          data: {
            status: "BOUNCED",
            bouncedAt: new Date(),
            emailError: message,
          },
        });
      }
    }
  }

  return { campaignsTouched, sent, failed, skippedNoApiKey: false };
}
