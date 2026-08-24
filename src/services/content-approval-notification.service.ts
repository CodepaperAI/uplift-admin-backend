import type { PrismaClient } from "@prisma/client";

import { dashboardFrontendOrigin } from "../auth/dashboard-auth-policy";
import { prisma as defaultPrisma } from "../config/db.config";
import { EmailService } from "./email.service";

const PRODUCTION_DASHBOARD_ORIGIN = "https://dashboard.upliftai.co";
const APPROVAL_EMAIL_CLAIM_TTL_MS = 10 * 60 * 1_000;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function isMarketingHostname(hostname: string): boolean {
  return hostname === "upliftai.co" || hostname === "www.upliftai.co";
}

/**
 * Approval links are application routes, never marketing-site routes. Local
 * development keeps its configured localhost origin; production rejects both
 * loopback and the public marketing origin so emails cannot lead to a 404.
 */
export function contentApprovalReviewUrl(pathname: string): string {
  const configured = new URL(dashboardFrontendOrigin());
  const mustUseProductionDashboard =
    process.env.NODE_ENV === "production" &&
    (isLoopbackHostname(configured.hostname) ||
      isMarketingHostname(configured.hostname));
  const origin = mustUseProductionDashboard
    ? PRODUCTION_DASHBOARD_ORIGIN
    : configured.origin;

  return new URL(pathname, `${origin}/`).toString();
}

export type ApprovalReadyContentKind = "social" | "gmb_post";

type ApprovalEmailSender = Pick<EmailService, "sendContentApprovalReadyEmail">;

export type ApprovalReadyNotificationResult = {
  kind: ApprovalReadyContentKind;
  contentId: string;
  status:
    | "sent"
    | "already_sent"
    | "not_found"
    | "not_ready"
    | "auto_publish_enabled"
    | "no_recipient"
    | "in_progress";
};

export async function sendApprovalReadyNotification(
  input: { kind: ApprovalReadyContentKind; contentId: string },
  prisma: PrismaClient = defaultPrisma,
  sender: ApprovalEmailSender = new EmailService(),
): Promise<ApprovalReadyNotificationResult> {
  if (input.kind === "social") {
    const run = await prisma.socialCreativeRun.findUnique({
      where: { id: input.contentId },
      select: {
        id: true,
        status: true,
        socialTopicPlanId: true,
        approvalEmailSentAt: true,
        business: {
          select: {
            businessName: true,
            User: { select: { email: true, name: true } },
            socialAutomationSettings: {
              select: { approvalRequired: true },
            },
          },
        },
      },
    });
    if (!run) return { ...input, status: "not_found" };
    if (run.status !== "COMPLETE" || !run.socialTopicPlanId) {
      return { ...input, status: "not_ready" };
    }
    if (run.business.socialAutomationSettings?.approvalRequired !== true) {
      return { ...input, status: "auto_publish_enabled" };
    }
    if (run.approvalEmailSentAt) {
      return { ...input, status: "already_sent" };
    }
    const userEmail = run.business.User.email?.trim();
    if (!userEmail) return { ...input, status: "no_recipient" };

    const claimedAt = new Date();
    const staleClaimBefore = new Date(
      claimedAt.getTime() - APPROVAL_EMAIL_CLAIM_TTL_MS,
    );
    const claimed = await prisma.socialCreativeRun.updateMany({
      where: {
        id: run.id,
        approvalEmailSentAt: null,
        OR: [
          { approvalEmailClaimedAt: null },
          { approvalEmailClaimedAt: { lt: staleClaimBefore } },
        ],
      },
      data: { approvalEmailClaimedAt: claimedAt },
    });
    if (claimed.count !== 1) {
      return { ...input, status: "in_progress" };
    }
    const result = await sender.sendContentApprovalReadyEmail({
      userEmail,
      userName: run.business.User.name?.trim() || "there",
      businessName: run.business.businessName?.trim() || "your business",
      contentLabel: "social media",
      reviewUrl: contentApprovalReviewUrl(
        `/dashboard/social/posts/${encodeURIComponent(run.id)}`,
      ),
      idempotencyKey: `approval-ready-social-${run.id}`,
    });
    if (!result.success) {
      await prisma.socialCreativeRun.updateMany({
        where: {
          id: run.id,
          approvalEmailSentAt: null,
          approvalEmailClaimedAt: claimedAt,
        },
        data: { approvalEmailClaimedAt: null },
      });
      throw new Error(result.error || "Social approval email could not be sent");
    }
    await prisma.socialCreativeRun.updateMany({
      where: {
        id: run.id,
        approvalEmailSentAt: null,
        approvalEmailClaimedAt: claimedAt,
      },
      data: {
        approvalEmailClaimedAt: null,
        approvalEmailSentAt: new Date(),
      },
    });
    return { ...input, status: "sent" };
  }

  const suggestion = await prisma.gMBPostSuggestion.findUnique({
    where: { id: input.contentId },
    select: {
      id: true,
      status: true,
      approvalEmailSentAt: true,
      business: {
        select: {
          businessName: true,
          User: { select: { email: true, name: true } },
          GoogleMyBusiness: { select: { postAutomationMode: true } },
        },
      },
    },
  });
  if (!suggestion) return { ...input, status: "not_found" };
  if (suggestion.status !== "PENDING") {
    return { ...input, status: "not_ready" };
  }
  if (
    suggestion.business.GoogleMyBusiness?.postAutomationMode !==
    "approval_required"
  ) {
    return { ...input, status: "auto_publish_enabled" };
  }
  if (suggestion.approvalEmailSentAt) {
    return { ...input, status: "already_sent" };
  }
  const userEmail = suggestion.business.User.email?.trim();
  if (!userEmail) return { ...input, status: "no_recipient" };

  const claimedAt = new Date();
  const staleClaimBefore = new Date(
    claimedAt.getTime() - APPROVAL_EMAIL_CLAIM_TTL_MS,
  );
  const claimed = await prisma.gMBPostSuggestion.updateMany({
    where: {
      id: suggestion.id,
      approvalEmailSentAt: null,
      OR: [
        { approvalEmailClaimedAt: null },
        { approvalEmailClaimedAt: { lt: staleClaimBefore } },
      ],
    },
    data: { approvalEmailClaimedAt: claimedAt },
  });
  if (claimed.count !== 1) {
    return { ...input, status: "in_progress" };
  }
  const result = await sender.sendContentApprovalReadyEmail({
    userEmail,
    userName: suggestion.business.User.name?.trim() || "there",
    businessName:
      suggestion.business.businessName?.trim() || "your business",
    contentLabel: "Google Business Profile",
    reviewUrl: contentApprovalReviewUrl("/dashboard/gmb-posts"),
    idempotencyKey: `approval-ready-gmb-${suggestion.id}`,
  });
  if (!result.success) {
    await prisma.gMBPostSuggestion.updateMany({
      where: {
        id: suggestion.id,
        approvalEmailSentAt: null,
        approvalEmailClaimedAt: claimedAt,
      },
      data: { approvalEmailClaimedAt: null },
    });
    throw new Error(result.error || "GMB approval email could not be sent");
  }
  await prisma.gMBPostSuggestion.updateMany({
    where: {
      id: suggestion.id,
      approvalEmailSentAt: null,
      approvalEmailClaimedAt: claimedAt,
    },
    data: {
      approvalEmailClaimedAt: null,
      approvalEmailSentAt: new Date(),
    },
  });
  return { ...input, status: "sent" };
}
