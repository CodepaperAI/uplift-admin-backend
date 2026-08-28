import { Router } from "express";
import { requireAdminSession } from "../middleware/require-admin-session";
import { requireSuperAdmin } from "../middleware/require-superadmin";
import { cacheJsonResponse } from "../middleware/cache-json-response";
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

/**
 * Ninety seconds, matching the Command panel's own analytics reads.
 */
const SUPERADMIN_ANALYTICS_TTL_SECONDS = 90;

const SuperAdminRouter: Router = Router();

SuperAdminRouter.use(requireAdminSession);
SuperAdminRouter.use(requireSuperAdmin);

SuperAdminRouter.get("/", listAgencies);
SuperAdminRouter.post("/", createAgency);

SuperAdminRouter.get("/audit-log", getAdminAuditLog);

/**
 * Response caching for the platform analytics reads.
 *
 * Every route below answers the same question for every superadmin — these are
 * platform-wide figures, and the caller appears nowhere in the response — so the
 * URL is a complete cache key. That is the precondition `cacheJsonResponse`
 * documents, and it is asserted here per route rather than mounted on the router
 * so that adding a caller-dependent endpoint cannot inherit caching by accident.
 *
 * Ninety seconds. These back trend charts, not operational alarms; the panel's
 * freshness indicators come from the sync-run tables, which are not cached here.
 *
 * Deliberately not cached:
 * - `/metrics/inngest`, which reports live infrastructure state.
 * - `/audit-log`, which someone reads precisely to see what just happened.
 * - the two `/export` routes, which are one-off CSV downloads, not JSON.
 * - `/metrics/users`, which is memoised inside the controller instead: the
 *   panel pages through it, so the win there is collapsing the concurrent pages
 *   of one walk onto a single computation, which needs the in-flight promise and
 *   not a finished payload.
 */
const cacheAnalytics = (name: string) =>
  cacheJsonResponse({ name, ttlSeconds: SUPERADMIN_ANALYTICS_TTL_SECONDS });

SuperAdminRouter.get(
  "/metrics/overview",
  cacheAnalytics("overview"),
  getMetricsOverview,
);
SuperAdminRouter.get("/metrics/revenue-summary", getMetricsRevenueSummary);
SuperAdminRouter.get(
  "/metrics/attribution",
  cacheAnalytics("attribution"),
  getMetricsAttribution,
);
SuperAdminRouter.get("/metrics/inngest", getMetricsInngest);
SuperAdminRouter.get("/metrics/llm-usage/export", exportMetricsLlmUsageCsv);
SuperAdminRouter.get(
  "/metrics/llm-usage",
  cacheAnalytics("llm-usage"),
  getMetricsLlmUsage,
);
SuperAdminRouter.get(
  "/metrics/api-tokens",
  cacheAnalytics("api-tokens"),
  getMetricsApiTokens,
);
SuperAdminRouter.get(
  "/metrics/blogs/daily",
  cacheAnalytics("blogs-daily"),
  getMetricsBlogsDaily,
);
SuperAdminRouter.get(
  "/metrics/payments/daily",
  cacheAnalytics("payments-daily"),
  getMetricsPaymentsDaily,
);
SuperAdminRouter.get(
  "/metrics/blog-generation",
  cacheAnalytics("blog-generation"),
  getMetricsBlogGeneration,
);
SuperAdminRouter.get("/metrics/users", getMetricsUsers);
SuperAdminRouter.get(
  "/metrics/monthly-performance",
  cacheAnalytics("monthly-performance"),
  getMetricsMonthlyPerformance,
);
SuperAdminRouter.get(
  "/metrics/users/daily",
  cacheAnalytics("users-daily"),
  getMetricsUsersDaily,
);
SuperAdminRouter.get("/metrics/users/export", exportMetricsUsers);
SuperAdminRouter.get("/metrics/users/:userId", getMetricsUserDetail);

SuperAdminRouter.get(
  "/rewardful/summary",
  cacheAnalytics("rewardful-summary"),
  getRewardfulAdminSummary,
);
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
