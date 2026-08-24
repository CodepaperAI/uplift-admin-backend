import { Router } from "express";
import {
  getRewardfulIntegrationHealth,
  handleRewardfulWebhook,
  listRewardfulAttributions,
  listRewardfulRemoteData,
  listRewardfulWebhookEvents,
} from "../controllers/rewardful.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireSuperAdmin } from "../middleware/require-superadmin";
import { persistRewardfulAttribution } from "../controllers/billing-checkout.controller";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const RewardfulRouter: Router = Router();
const requireRewardfulAdmin = [requireBackendAuth, requireSuperAdmin] as const;
const attributionLimit = sensitiveRouteRateLimit({
  namespace: "rewardful-attribution",
  limit: 30,
  windowSeconds: 60,
});

RewardfulRouter.post("/webhook", handleRewardfulWebhook);
RewardfulRouter.post(
  "/attribution",
  requireBackendAuth,
  attributionLimit,
  persistRewardfulAttribution,
);
RewardfulRouter.get(
  "/internal/health",
  ...requireRewardfulAdmin,
  getRewardfulIntegrationHealth,
);
RewardfulRouter.get(
  "/internal/remote/:resource",
  ...requireRewardfulAdmin,
  listRewardfulRemoteData,
);
RewardfulRouter.get(
  "/internal/attributions",
  ...requireRewardfulAdmin,
  listRewardfulAttributions,
);
RewardfulRouter.get(
  "/internal/events",
  ...requireRewardfulAdmin,
  listRewardfulWebhookEvents,
);

export default RewardfulRouter;
