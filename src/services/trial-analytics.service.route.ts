import { Router } from "express";
import {
  getTrialAnalytics,
  getAllTrialAnalytics,
  getConversionMetrics,
  getABTestResults,
  trackUpgradeCTA,
  trackPricingPage,
  trackCheckoutStarted,
} from "../controllers/trial-analytics.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireSuperAdmin } from "../middleware/require-superadmin";

const router = Router();

// GET endpoints
router.get(
  "/analytics/:userId",
  requireBackendAuth,
  bindAuthenticatedUser,
  getTrialAnalytics,
);
router.get("/analytics", requireBackendAuth, requireSuperAdmin, getAllTrialAnalytics);
router.get(
  "/metrics/conversion",
  requireBackendAuth,
  requireSuperAdmin,
  getConversionMetrics,
);
router.get(
  "/ab-test/:testGroup",
  requireBackendAuth,
  requireSuperAdmin,
  getABTestResults,
);

// POST endpoints for tracking
router.post(
  "/track/upgrade-cta",
  requireBackendAuth,
  bindAuthenticatedUser,
  trackUpgradeCTA,
);
router.post(
  "/track/pricing-page",
  requireBackendAuth,
  bindAuthenticatedUser,
  trackPricingPage,
);
router.post(
  "/track/checkout-started",
  requireBackendAuth,
  bindAuthenticatedUser,
  trackCheckoutStarted,
);

export default router;
