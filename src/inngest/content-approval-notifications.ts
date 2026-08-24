import type { PrismaClient } from "@prisma/client";
import { NonRetriableError, type Inngest } from "inngest";

import { prisma } from "../config/db.config";
import {
  sendApprovalReadyNotification,
  type ApprovalReadyContentKind,
} from "../services/content-approval-notification.service";

export function createContentApprovalNotificationFunctions(
  inngest: Inngest,
  dependencies: {
    prisma?: PrismaClient;
    notify?: typeof sendApprovalReadyNotification;
  } = {},
) {
  const db = dependencies.prisma ?? prisma;
  const notify = dependencies.notify ?? sendApprovalReadyNotification;

  const notificationTask = inngest.createFunction(
    {
      id: "content-approval-ready-notification",
      name: "Send Content Approval Ready Email",
      retries: 3,
      triggers: { event: "content/approval-ready" },
      concurrency: { limit: 1, key: "event.data.contentId" },
    },
    async ({ event, step }) => {
      const data = event.data as { kind?: unknown; contentId?: unknown };
      const kind = data.kind;
      const contentId = data.contentId;
      if (
        (kind !== "social" && kind !== "gmb_post") ||
        typeof contentId !== "string" ||
        !contentId
      ) {
        throw new NonRetriableError("Invalid content approval notification event");
      }
      return step.run("send-content-approval-ready-email", () =>
        notify({ kind, contentId }, db),
      );
    },
  );

  const recoveryTask = inngest.createFunction(
    {
      id: "content-approval-ready-notification-recovery",
      name: "Recover Content Approval Ready Emails",
      retries: 1,
      triggers: { cron: "*/15 * * * *" },
      concurrency: { limit: 1 },
    },
    async ({ step }) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1_000);
      const [socialRuns, gmbSuggestions] = await step.run(
        "load-unnotified-approval-content",
        () =>
          Promise.all([
            db.socialCreativeRun.findMany({
              where: {
                status: "COMPLETE",
                completedAt: { gte: since },
                approvalEmailSentAt: null,
                OR: [
                  { approvalEmailClaimedAt: null },
                  { approvalEmailClaimedAt: { lt: staleClaimBefore } },
                ],
                socialTopicPlanId: { not: null },
                business: {
                  socialAutomationSettings: {
                    is: { enabled: true, approvalRequired: true },
                  },
                },
              },
              select: { id: true },
              take: 100,
            }),
            db.gMBPostSuggestion.findMany({
              where: {
                status: "PENDING",
                generatedAt: { gte: since },
                approvalEmailSentAt: null,
                OR: [
                  { approvalEmailClaimedAt: null },
                  { approvalEmailClaimedAt: { lt: staleClaimBefore } },
                ],
                business: {
                  GoogleMyBusiness: {
                    is: { postAutomationMode: "approval_required" },
                  },
                },
              },
              select: { id: true },
              take: 100,
            }),
          ]),
      );
      const events: Array<{
        id: string;
        name: "content/approval-ready";
        data: { kind: ApprovalReadyContentKind; contentId: string };
      }> = [
        ...socialRuns.map((run) => ({
          id: `approval-ready-social:${run.id}`,
          name: "content/approval-ready" as const,
          data: { kind: "social" as const, contentId: run.id },
        })),
        ...gmbSuggestions.map((suggestion) => ({
          id: `approval-ready-gmb:${suggestion.id}`,
          name: "content/approval-ready" as const,
          data: { kind: "gmb_post" as const, contentId: suggestion.id },
        })),
      ];
      if (events.length > 0) {
        await step.sendEvent("dispatch-approval-ready-emails", events);
      }
      return {
        social: socialRuns.length,
        gmb: gmbSuggestions.length,
        dispatched: events.length,
      };
    },
  );

  return [notificationTask, recoveryTask] as const;
}
