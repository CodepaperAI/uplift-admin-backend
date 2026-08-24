import { Router } from "express";
import {
  getCommandAccessMatrix,
  getCommandSession,
  updateCommandRoleCapabilities,
} from "../controllers/command-access.controller";
import { requireAdminSession } from "../middleware/require-admin-session";
import {
  requireCommandCapability,
  requireCommandPanel,
} from "../middleware/require-command-capability";
import {
  getCommandStripeOverview,
  getCommandStripeHealth,
  getCommandStripeSyncRuns,
  requestCommandStripeReconciliation,
} from "../controllers/command-stripe.controller";
import {
  getCommandGhlOverview,
  getCommandPipeline,
  updateCommandPipelineStage,
} from "../controllers/command-ghl.controller";
import {
  createCommandCost,
  deleteCommandCost,
  getCommandCosts,
  requestCommandMetaAdsSync,
  updateCommandCost,
} from "../controllers/command-cost.controller";
import {
  createCommandRep,
  createCommandSalesAccount,
  getCommandReps,
  updateCommandRep,
} from "../controllers/command-reps.controller";
import {
  createCommandService,
  createCommandServiceRate,
  getCommandServices,
  updateCommandService,
} from "../controllers/command-services.controller";
import {
  getCommandDeals,
  updateCommandDealService,
} from "../controllers/command-deals.controller";
import {
  getCommandActivity,
  upsertCommandActivity,
} from "../controllers/command-activity.controller";
import {
  getCommandGhlRevenue,
  requestCommandGhlPaymentSync,
} from "../controllers/command-ghl-revenue.controller";
import { getCommandSettings } from "../controllers/command-settings.controller";
import {
  approveRecommendedCommandDecisions,
  createCommandDecision,
  getCommandDecisions,
} from "../controllers/command-decisions.controller";
import {
  getCommandCalls,
  getCommandCoachingBriefs,
  requestCommandCoachingBrief,
  retryCommandCallReview,
} from "../controllers/command-calls.controller";
import {
  calculateCommandCommissions,
  getCommandCommissions,
  lockCommandCommissionRun,
} from "../controllers/command-commissions.controller";
import {
  createCommandOverride,
  getCommandOverrides,
} from "../controllers/command-overrides.controller";
import {
  createCommandDealCredits,
  getCommandDealCredits,
} from "../controllers/command-credits.controller";

const CommandRouter = Router();

CommandRouter.use(requireAdminSession);
CommandRouter.get("/session", requireCommandPanel, getCommandSession);
CommandRouter.get(
  "/stripe/overview",
  requireCommandCapability("view.financials"),
  getCommandStripeOverview,
);
CommandRouter.get(
  "/stripe/sync-runs",
  requireCommandCapability("view.financials"),
  getCommandStripeSyncRuns,
);
CommandRouter.get(
  "/stripe/health",
  requireCommandCapability("view.financials"),
  getCommandStripeHealth,
);
CommandRouter.post(
  "/stripe/reconcile",
  requireCommandCapability("stripe.sync"),
  requestCommandStripeReconciliation,
);
CommandRouter.get(
  "/ghl/overview",
  requireCommandCapability("view.ghl"),
  getCommandGhlOverview,
);
CommandRouter.get(
  "/ghl/revenue",
  requireCommandCapability("view.financials"),
  getCommandGhlRevenue,
);
CommandRouter.post(
  "/ghl/revenue/sync",
  requireCommandCapability("edit.settings"),
  requestCommandGhlPaymentSync,
);
CommandRouter.get("/pipeline", requireCommandPanel, getCommandPipeline);
CommandRouter.patch(
  "/pipeline/:id/stage",
  requireCommandCapability("edit.leads"),
  updateCommandPipelineStage,
);
CommandRouter.get(
  "/costs",
  requireCommandCapability("view.costs"),
  getCommandCosts,
);
CommandRouter.post(
  "/costs/meta-ads/sync",
  requireCommandCapability("edit.costs"),
  requestCommandMetaAdsSync,
);
CommandRouter.post(
  "/costs",
  requireCommandCapability("edit.costs"),
  createCommandCost,
);
CommandRouter.patch(
  "/costs/:id",
  requireCommandCapability("edit.costs"),
  updateCommandCost,
);
CommandRouter.delete(
  "/costs/:id",
  requireCommandCapability("edit.costs"),
  deleteCommandCost,
);
CommandRouter.get(
  "/reps",
  requireCommandCapability("view.team.all"),
  getCommandReps,
);
CommandRouter.post(
  "/reps",
  requireCommandCapability("manage.reps"),
  createCommandRep,
);
CommandRouter.post(
  "/sales-accounts",
  requireCommandCapability("manage.reps"),
  createCommandSalesAccount,
);
CommandRouter.patch(
  "/reps/:id",
  requireCommandCapability("manage.reps"),
  updateCommandRep,
);
CommandRouter.get(
  "/services",
  requireCommandCapability("view.financials"),
  getCommandServices,
);
CommandRouter.post(
  "/services",
  requireCommandCapability("edit.services"),
  createCommandService,
);
CommandRouter.post(
  "/services/:id/rates",
  requireCommandCapability("edit.services"),
  createCommandServiceRate,
);
CommandRouter.patch(
  "/services/:id",
  requireCommandCapability("edit.services"),
  updateCommandService,
);
CommandRouter.get("/deals", requireCommandPanel, getCommandDeals);
CommandRouter.patch(
  "/deals/:sourceType/:sourceId/service",
  requireCommandCapability("edit.deals"),
  updateCommandDealService,
);
CommandRouter.get("/activity", requireCommandPanel, getCommandActivity);
CommandRouter.post(
  "/activity",
  requireCommandCapability("edit.activity"),
  upsertCommandActivity,
);
CommandRouter.get(
  "/access",
  requireCommandCapability("manage.roles"),
  getCommandAccessMatrix,
);
CommandRouter.get(
  "/settings",
  requireCommandCapability("edit.settings"),
  getCommandSettings,
);
CommandRouter.get(
  "/settings/decisions",
  requireCommandCapability("edit.settings"),
  getCommandDecisions,
);
CommandRouter.post(
  "/settings/decisions",
  requireCommandCapability("edit.settings"),
  createCommandDecision,
);
CommandRouter.post(
  "/settings/decisions/approve-recommended",
  requireCommandCapability("edit.settings"),
  approveRecommendedCommandDecisions,
);
CommandRouter.get("/calls", requireCommandPanel, getCommandCalls);
CommandRouter.post(
  "/calls/:id/review",
  requireCommandCapability("edit.calls"),
  retryCommandCallReview,
);
CommandRouter.get("/coaching/briefs", requireCommandPanel, getCommandCoachingBriefs);
CommandRouter.post(
  "/coaching/briefs",
  requireCommandCapability("edit.calls"),
  requestCommandCoachingBrief,
);
CommandRouter.get("/commissions", requireCommandPanel, getCommandCommissions);
CommandRouter.post(
  "/commissions/calculate",
  requireCommandCapability("edit.settings"),
  calculateCommandCommissions,
);
CommandRouter.post(
  "/commissions/:id/lock",
  requireCommandCapability("edit.settings"),
  lockCommandCommissionRun,
);
CommandRouter.get(
  "/overrides",
  requireCommandCapability("edit.settings"),
  getCommandOverrides,
);
CommandRouter.post(
  "/overrides",
  requireCommandCapability("edit.settings"),
  createCommandOverride,
);
CommandRouter.get(
  "/deal-credits",
  requireCommandCapability("edit.settings"),
  getCommandDealCredits,
);
CommandRouter.post(
  "/deal-credits",
  requireCommandCapability("edit.settings"),
  createCommandDealCredits,
);
CommandRouter.patch(
  "/access/:role",
  requireCommandCapability("manage.roles"),
  updateCommandRoleCapabilities,
);

export default CommandRouter;
