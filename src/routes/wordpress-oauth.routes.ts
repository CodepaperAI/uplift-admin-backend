import { Router } from "express";
import {
    generateIntegrationKey,
    getSchemaContextForPlugin,
    handleWordPressWebhook,
    revokeIntegrationKey,
    validateIntegrationKey,
} from "../controllers/wordpress-oauth.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const router = Router();

// Integration key endpoints
router.post("/auth/wordpress/generate-key", requireBackendAuth, generateIntegrationKey);
router.post(
  "/auth/wordpress/validate-key",
  sensitiveRouteRateLimit({ namespace: "wordpress-validate", limit: 20, windowSeconds: 60 }),
  validateIntegrationKey,
);
router.delete("/auth/wordpress/revoke-key", requireBackendAuth, revokeIntegrationKey);

// Schema-context feed for plugin-side LocalBusiness/Person JSON-LD emission
// (cached in WP transients, refreshed at most daily per customer site).
router.post(
  "/auth/wordpress/schema-context",
  sensitiveRouteRateLimit({ namespace: "wordpress-context", limit: 60, windowSeconds: 60 }),
  getSchemaContextForPlugin,
);

// Webhook endpoint
router.post(
  "/auth/wordpress/webhook",
  sensitiveRouteRateLimit({ namespace: "wordpress-webhook", limit: 120, windowSeconds: 60 }),
  handleWordPressWebhook,
);

export default router;
