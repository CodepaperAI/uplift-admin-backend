import { Router } from "express";
import {
  getDROverview,
  getDRActions,
  getDRContentOptimizations,
  getDRLinkRecoveries,
  getDROutreachCampaigns,
  handleInboundWebhook,
  handleUnsubscribe,
} from "../controllers/dr-dashboard.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireResendWebhook } from "../middleware/require-resend-webhook";

const router = Router();

router.get("/overview", requireBackendAuth, getDROverview);
router.get("/actions", requireBackendAuth, getDRActions);
router.get("/outreach-campaigns", requireBackendAuth, getDROutreachCampaigns);
router.get("/content-optimizations", requireBackendAuth, getDRContentOptimizations);
router.get("/link-recoveries", requireBackendAuth, getDRLinkRecoveries);
router.get("/:userId/overview", requireBackendAuth, getDROverview);
router.get("/:userId/actions", requireBackendAuth, getDRActions);
router.post("/inbound-webhook", requireResendWebhook, handleInboundWebhook);
router.get("/unsubscribe", handleUnsubscribe);

export default router;
