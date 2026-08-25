import { Router } from "express";
import { requireAdminSession } from "../middleware/require-admin-session";
import { requireSuperAdmin } from "../middleware/require-superadmin";
import {
  listAgencies,
  createAgency,
  getAgencyDetail,
  updateAgency,
  addAgencyDomain,
  removeAgencyDomain,
  listAgencyBusinesses,
  reassignBusiness,
  getRevenueShareRules,
  createRevenueShareRule,
  listSettlementRuns,
  getSettlementRunDetail,
  approveSettlementRun,
  markSettlementPaid,
  markSettlementFailed,
  getAdminAuditLog,
  listSalesRecords,
  createSalesRecord,
} from "../controllers/superadmin.controller";
import {
  cancelSuperadminSubscription,
  createSuperadminInvoice,
  createSuperadminSubscription,
  getSuperadminBillingDashboard,
  markSuperadminInvoicePaid,
  markSuperadminInvoiceUncollectible,
  pauseSuperadminSubscription,
  reactivateSuperadminSubscription,
  sendSuperadminInvoice,
  updateSuperadminSubscriptionPrice,
} from "../controllers/superadmin-billing.controller";
import {
  exportMetricsUsers,
  exportMetricsLlmUsageCsv,
  getMetricsApiTokens,
  getMetricsAttribution,
  getMetricsBlogsDaily,
  getMetricsPaymentsDaily,
  getMetricsBlogGeneration,
  getMetricsInngest,
  getMetricsLlmUsage,
  getMetricsOverview,
  getMetricsRevenueSummary,
  getMetricsUsers,
  getMetricsUsersDaily,
  getMetricsMonthlyPerformance,
  getMetricsUserDetail,
} from "../controllers/superadmin-metrics.controller";
import {
  getRewardfulAdminSummary,
  listRewardfulAttributions,
  listRewardfulCommissionsAndPayouts,
  listRewardfulRemoteData,
  listRewardfulSalesAndConversions,
  listRewardfulWebhookEvents,
  retryRewardfulWebhookEvent,
} from "../controllers/rewardful.controller";

const SuperAdminRouter: Router = Router();

SuperAdminRouter.use(requireAdminSession);
SuperAdminRouter.use(requireSuperAdmin);

SuperAdminRouter.get("/", listAgencies);
SuperAdminRouter.post("/", createAgency);

SuperAdminRouter.get("/audit-log", getAdminAuditLog);

SuperAdminRouter.get("/metrics/overview", getMetricsOverview);
SuperAdminRouter.get("/metrics/revenue-summary", getMetricsRevenueSummary);
SuperAdminRouter.get("/metrics/attribution", getMetricsAttribution);
SuperAdminRouter.get("/metrics/inngest", getMetricsInngest);
SuperAdminRouter.get("/metrics/llm-usage/export", exportMetricsLlmUsageCsv);
SuperAdminRouter.get("/metrics/llm-usage", getMetricsLlmUsage);
SuperAdminRouter.get("/metrics/api-tokens", getMetricsApiTokens);
SuperAdminRouter.get("/metrics/blogs/daily", getMetricsBlogsDaily);
SuperAdminRouter.get("/metrics/payments/daily", getMetricsPaymentsDaily);
SuperAdminRouter.get("/metrics/blog-generation", getMetricsBlogGeneration);
SuperAdminRouter.get("/metrics/users", getMetricsUsers);
SuperAdminRouter.get("/metrics/monthly-performance", getMetricsMonthlyPerformance);
SuperAdminRouter.get("/metrics/users/daily", getMetricsUsersDaily);
SuperAdminRouter.get("/metrics/users/export", exportMetricsUsers);
SuperAdminRouter.get("/metrics/users/:userId", getMetricsUserDetail);

SuperAdminRouter.get("/rewardful/summary", getRewardfulAdminSummary);
SuperAdminRouter.get("/rewardful/attributions", listRewardfulAttributions);
SuperAdminRouter.get("/rewardful/events", listRewardfulWebhookEvents);
SuperAdminRouter.get("/rewardful/sales", listRewardfulSalesAndConversions);
SuperAdminRouter.get(
  "/rewardful/commissions",
  listRewardfulCommissionsAndPayouts,
);
SuperAdminRouter.get("/rewardful/remote/:resource", listRewardfulRemoteData);
SuperAdminRouter.post(
  "/rewardful/events/:eventId/retry",
  retryRewardfulWebhookEvent,
);

SuperAdminRouter.get("/settlements/:runId", getSettlementRunDetail);
SuperAdminRouter.patch("/settlements/:runId/approve", approveSettlementRun);
SuperAdminRouter.patch("/settlements/:runId/paid", markSettlementPaid);
SuperAdminRouter.patch("/settlements/:runId/failed", markSettlementFailed);

SuperAdminRouter.get("/sales-records", listSalesRecords);
SuperAdminRouter.post("/sales-records", createSalesRecord);

SuperAdminRouter.get("/billing", getSuperadminBillingDashboard);
SuperAdminRouter.post("/billing/subscriptions", createSuperadminSubscription);
SuperAdminRouter.patch(
  "/billing/subscriptions/:subscriptionId/cancel",
  cancelSuperadminSubscription,
);
SuperAdminRouter.patch(
  "/billing/subscriptions/:subscriptionId/reactivate",
  reactivateSuperadminSubscription,
);
SuperAdminRouter.patch(
  "/billing/subscriptions/:subscriptionId/pause",
  pauseSuperadminSubscription,
);
SuperAdminRouter.patch(
  "/billing/subscriptions/:subscriptionId/price",
  updateSuperadminSubscriptionPrice,
);
SuperAdminRouter.post("/billing/invoices", createSuperadminInvoice);
SuperAdminRouter.patch("/billing/invoices/:invoiceId/send", sendSuperadminInvoice);
SuperAdminRouter.patch(
  "/billing/invoices/:invoiceId/mark-paid",
  markSuperadminInvoicePaid,
);
SuperAdminRouter.patch(
  "/billing/invoices/:invoiceId/mark-uncollectible",
  markSuperadminInvoiceUncollectible,
);

SuperAdminRouter.patch("/businesses/:businessId/reassign", reassignBusiness);

SuperAdminRouter.get("/:agencyId", getAgencyDetail);
SuperAdminRouter.patch("/:agencyId", updateAgency);
SuperAdminRouter.post("/:agencyId/domains", addAgencyDomain);
SuperAdminRouter.delete("/:agencyId/domains/:domainId", removeAgencyDomain);
SuperAdminRouter.get("/:agencyId/businesses", listAgencyBusinesses);
SuperAdminRouter.get("/:agencyId/revenue-share", getRevenueShareRules);
SuperAdminRouter.post("/:agencyId/revenue-share", createRevenueShareRule);
SuperAdminRouter.get("/:agencyId/settlements", listSettlementRuns);

export default SuperAdminRouter;
