import { Router } from "express";

import {
  cancelScheduledSubscriptionPlanChange,
  cancelUserSubscription,
  changeSubscriptionPlan,
  createBillingPortalSession,
  createPaymentMethodSession,
  getBillingHistory,
  getSubscriptionStatus,
  reactivateUserSubscription,
} from "../controllers/billing-portal.controller";
import {
  createAddWebsiteCheckoutSession,
  createPrimaryCheckoutSession,
} from "../controllers/billing-checkout.controller";
import { verifyCheckoutSession } from "../controllers/billing-verification.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const BillingPortalRouter = Router();
BillingPortalRouter.use(requireBackendAuth);
const sessionLimit = sensitiveRouteRateLimit({
  namespace: "billing-portal-session",
  limit: 10,
  windowSeconds: 60,
});
const readLimit = sensitiveRouteRateLimit({
  namespace: "billing-read",
  // Subscription status is a cached, authenticated read mounted in the
  // dashboard shell. Allow normal multi-tab/navigation bursts while keeping a
  // firm per-account ceiling.
  limit: 120,
  windowSeconds: 60,
});
const planChangeLimit = sensitiveRouteRateLimit({
  namespace: "billing-plan-change",
  limit: 5,
  windowSeconds: 60,
});
const checkoutLimit = sensitiveRouteRateLimit({
  namespace: "billing-primary-checkout",
  limit: 5,
  windowSeconds: 60,
});
const checkoutVerificationLimit = sensitiveRouteRateLimit({
  // Verification is authenticated and idempotent. Keep it isolated from
  // checkout creation so the Stripe return tab cannot consume the small
  // creation budget while the original dashboard tab is recovering payment.
  namespace: "billing-checkout-verification",
  limit: 20,
  windowSeconds: 60,
});
BillingPortalRouter.post("/checkout", checkoutLimit, createPrimaryCheckoutSession);
BillingPortalRouter.post(
  "/checkout/add-website",
  checkoutLimit,
  createAddWebsiteCheckoutSession,
);
BillingPortalRouter.post(
  "/checkout/verify-session",
  checkoutVerificationLimit,
  verifyCheckoutSession,
);
BillingPortalRouter.post("/portal-session", sessionLimit, createBillingPortalSession);
BillingPortalRouter.post("/payment-method-session", sessionLimit, createPaymentMethodSession);
BillingPortalRouter.get("/history", readLimit, getBillingHistory);
BillingPortalRouter.get("/subscription", readLimit, getSubscriptionStatus);
BillingPortalRouter.post(
  "/subscription/change-plan",
  planChangeLimit,
  changeSubscriptionPlan,
);
BillingPortalRouter.post(
  "/subscription/cancel-scheduled-change",
  planChangeLimit,
  cancelScheduledSubscriptionPlanChange,
);
BillingPortalRouter.post("/subscription/cancel", sessionLimit, cancelUserSubscription);
BillingPortalRouter.post(
  "/subscription/reactivate",
  sessionLimit,
  reactivateUserSubscription,
);

export default BillingPortalRouter;
