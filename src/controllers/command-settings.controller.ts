import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { listCommandDecisionCenter } from "../command/decision.service";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import { resolvedPoolMax } from "../config/prisma-client.factory";

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function projectedConfigured(
  projectionName: string,
  legacyValue: boolean,
): boolean {
  const projected = process.env[projectionName]?.trim().toLowerCase();
  if (projected === "true") return true;
  if (projected === "false") return false;
  return legacyValue;
}

function backgroundEnabled(envName: string): boolean {
  const explicit = process.env[envName]?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return [
    process.env.APP_ENV,
    process.env.DEPLOY_ENV,
    process.env.ENVIRONMENT,
    process.env.NODE_ENV,
  ].some((value) => value?.trim().toLowerCase() === "production");
}

type CommandIntegrationState = {
  configured: boolean;
  syncEnabled?: boolean;
  requiredScopes?: string[];
  requiredConfiguration?: string[];
  blockedBy?: string;
  provider?: string | null;
};

export async function getCommandSettings(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const cached = await readCommandCache<Record<string, unknown>>("settings-v4");
    if (cached) {
      sendSuccess(res, cached, "Command settings");
      return;
    }
    const [services, activeReps, ghlMappedReps, providerRuns, latestRollup, decisionCenter] =
      await Promise.all([
        prisma.commandService.count({ where: { isActive: true } }),
        prisma.commandRepProfile.count({ where: { isActive: true } }),
        prisma.commandRepProfile.count({
          where: { isActive: true, ghlUserId: { not: null } },
        }),
        prisma.commandProviderSyncRun.findMany({
          where: { provider: { in: ["stripe", "ghl", "ghl_payments", "ghl_activity", "meta_ads"] } },
          distinct: ["provider"],
          orderBy: [
            { provider: "asc" },
            { startedAt: "desc" },
          ],
        }),
        prisma.commandStripeMonthlyRollup.findFirst({
          orderBy: { generatedAt: "desc" },
        }),
        listCommandDecisionCenter(),
      ]);
    const payload = {
        policies: {
          periodTimeZone: "America/Toronto",
          mrrStatuses: ["trialing", "active", "past_due"],
          pausedInMrr: false,
          paidToDateSource: "settled_stripe_invoice_amount_paid",
          grossMarginSource: "settled_revenue_minus_delivery_costs",
          deliveryCostsInCac: false,
          providerRecordsEditable: false,
          correctionStrategy: "audited_override_rows",
        },
        compensationReadiness: decisionCenter.readiness,
        decisions: decisionCenter.definitions,
        mappings: {
          activeServices: services,
          activeReps,
          ghlMappedReps,
        },
        /**
         * The database connection pool this process is actually running with.
         *
         * Reported because the value lives in Secrets Manager, is applied by a
         * script on the instance, and was until now unobservable from outside —
         * so "the pool has been raised" could only be asserted, never checked. A
         * single overview request issues twenty-five queries in one
         * `Promise.all`, so a pool below that serialises them, and the number
         * that matters is the one in the running container rather than the one in
         * the deploy script.
         *
         * Not a secret: it is a concurrency limit, and this endpoint already
         * requires `edit.settings`.
         */
        runtime: {
          databasePoolMax: resolvedPoolMax(),
          poolMaxSource: process.env.PRISMA_POOL_MAX?.trim()
            ? "PRISMA_POOL_MAX"
            : "application default",
        },
        integrations: {
          stripe: {
            configured: configured(process.env.STRIPE_SECRET_KEY),
            syncEnabled: backgroundEnabled(
              "COMMAND_STRIPE_RECONCILIATION_ENABLED",
            ),
          },
          ghlCrm: {
            configured: projectedConfigured(
              "COMMAND_GHL_CONFIGURED",
              configured(process.env.GHL_COMMAND_READ_TOKEN) &&
                configured(process.env.GHL_COMMAND_LOCATION_ID),
            ),
            syncEnabled: backgroundEnabled("COMMAND_GHL_SYNC_ENABLED"),
            requiredScopes: ["contacts.readonly", "opportunities.readonly"],
          },
          ghlPayments: {
            configured: projectedConfigured(
              "COMMAND_GHL_CONFIGURED",
              configured(process.env.GHL_COMMAND_READ_TOKEN) &&
                configured(process.env.GHL_COMMAND_LOCATION_ID),
            ),
            syncEnabled:
              process.env.COMMAND_GHL_PAYMENTS_SYNC_ENABLED === "true",
            requiredScopes: [
              "payments/subscriptions.readonly",
              "payments/transactions.readonly",
            ],
          },
          ghlActivity: {
            configured: projectedConfigured(
              "COMMAND_GHL_CONFIGURED",
              configured(process.env.GHL_COMMAND_READ_TOKEN) &&
                configured(process.env.GHL_COMMAND_LOCATION_ID),
            ),
            syncEnabled:
              process.env.COMMAND_GHL_ACTIVITY_SYNC_ENABLED === "true",
            requiredScopes: [
              "conversations/message.readonly",
              "calendars/events.readonly",
            ],
          },
          metaAds: {
            configured: projectedConfigured(
              "COMMAND_META_ADS_CONFIGURED",
              configured(process.env.META_ADS_ACCESS_TOKEN) &&
                configured(process.env.META_AD_ACCOUNT_ID) &&
                configured(process.env.META_GRAPH_API_VERSION),
            ),
            syncEnabled: process.env.COMMAND_META_ADS_SYNC_ENABLED === "true",
            requiredScopes: ["ads_read"],
          },
          metricRollup: {
            configured: true,
            syncEnabled: backgroundEnabled(
              "COMMAND_METRIC_ROLLUP_CRON_ENABLED",
            ),
          },
          googleAds: {
            configured: false,
            syncEnabled: false,
            blockedBy: "manual fallback active",
          },
          coachingAi: {
            configured: projectedConfigured(
              "COMMAND_COACHING_AI_CONFIGURED",
              configured(process.env.ANTHROPIC_API_KEY),
            ),
            syncEnabled: true,
            provider: "anthropic",
            requiredConfiguration: [
              "ANTHROPIC_API_KEY",
              "COMMAND_COACHING_MODEL (optional; defaults to claude-sonnet-4-5)",
            ],
          },
          meetingNotes: { configured: false, blockedBy: "D5" },
        } as Record<string, CommandIntegrationState>,
        providerRuns: {
          ...Object.fromEntries(
            providerRuns.map((run) => [run.provider, run]),
          ),
          ...(latestRollup
            ? {
                metricRollup: {
                  status: "completed",
                  error: null,
                  startedAt: latestRollup.generatedAt,
                  completedAt: latestRollup.generatedAt,
                },
              }
            : {}),
        },
      };
    const meetingDecision = decisionCenter.definitions.find(
      (decision) => decision.key === "meeting_provider",
    );
    const selectedMeetingProvider =
      meetingDecision?.current &&
      typeof meetingDecision.current.value === "object" &&
      meetingDecision.current.value !== null &&
      "provider" in meetingDecision.current.value
        ? String(meetingDecision.current.value.provider)
        : null;
    payload.integrations.meetingNotes = {
      configured:
        selectedMeetingProvider === "fireflies"
          ? projectedConfigured(
              "COMMAND_FIREFLIES_CONFIGURED",
              configured(process.env.FIREFLIES_API_KEY) &&
                configured(process.env.FIREFLIES_WEBHOOK_SECRET),
            )
          : selectedMeetingProvider === "fathom"
            ? projectedConfigured(
                "COMMAND_FATHOM_CONFIGURED",
                configured(process.env.FATHOM_API_KEY) &&
                  configured(process.env.FATHOM_WEBHOOK_SECRET),
              )
            : false,
      syncEnabled: selectedMeetingProvider !== null,
      blockedBy: selectedMeetingProvider ? undefined : "D5",
      provider: selectedMeetingProvider,
      requiredConfiguration:
        selectedMeetingProvider === "fathom"
          ? ["FATHOM_API_KEY", "FATHOM_WEBHOOK_SECRET"]
          : selectedMeetingProvider === "fireflies"
            ? ["FIREFLIES_API_KEY", "FIREFLIES_WEBHOOK_SECRET"]
            : ["Approve D5 meeting_provider"],
    };
    await writeCommandCache("settings-v4", payload, 120);
    sendSuccess(res, payload, "Command settings");
  } catch (error) {
    sendError(res, "Failed to load Command settings", 500, error);
  }
}
