import { Router } from "express";
import {
  authorizeShopify,
  authorizeShopifyWithCredentials,
  handleShopifyCallback,
  refreshShopifyToken,
  handleShopifyWebhook,
  listShopifyStoreBlogs,
  disconnectShopify,
} from "../controllers/shopify-oauth.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const router = Router();

router.get(
  "/auth/shopify/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeShopify,
);
router.post(
  "/auth/shopify/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeShopifyWithCredentials,
);
router.get("/auth/shopify/callback", handleShopifyCallback);
router.post(
  "/auth/shopify/refresh",
  requireBackendAuth,
  bindAuthenticatedUser,
  refreshShopifyToken,
);
router.post("/auth/shopify/webhook", handleShopifyWebhook);
router.post("/webhooks/shopify", handleShopifyWebhook);
router.post("/webhooks/shopify/compliance", handleShopifyWebhook);
router.get(
  "/auth/shopify/blogs",
  requireBackendAuth,
  bindAuthenticatedUser,
  listShopifyStoreBlogs,
);
router.post(
  "/auth/shopify/disconnect",
  requireBackendAuth,
  bindAuthenticatedUser,
  disconnectShopify,
);

export default router;
